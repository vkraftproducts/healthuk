import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 batch 3 (17 Nov 2026): open shifts, swaps, hours and patterns. Shifts and crew are written
// directly (as the planner would) so these tests do not depend on the allocation fixtures.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
let su: pg.Client;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, o: { sub?: string; body?: unknown } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|dispatcher' })}`,
      'x-org-id': ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
  su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
});
afterAll(async () => {
  await su.end();
  await app.close();
  await db.close();
});

const H = 3_600_000;
const letters = (k: number) =>
  Array.from({ length: k }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function staffOf(sub: string): Promise<string> {
  const r = await su.query(
    `SELECT s.id FROM staff s JOIN app_user u ON u.id = s.user_id
      WHERE u.idp_subject = $1 AND s.organisation_id = $2`,
    [sub, ORG],
  );
  return r.rows[0].id as string;
}

async function vehicle() {
  const r = await call('POST', '/api/v1/vehicles', {
    sub: 'dev|fleet',
    body: {
      registration: `RT${10 + Math.floor(Math.random() * 90)}${letters(3)}`,
      callsign: `ROT-${tag()}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
    },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** A planned shift (and optionally crew) at `startH` hours from now, `len` hours long. */
async function shift(startH: number, len = 10, crew: { staffId: string; role: string }[] = []) {
  const v = await vehicle();
  const s = new Date(Date.now() + startH * H);
  const e = new Date(s.getTime() + len * H);
  const r = await su.query(
    `INSERT INTO shift (organisation_id, location_id, vehicle_id, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ORG, SEED_IDS.locWatford, v, s, e],
  );
  const shiftId = r.rows[0].id as string;
  const assignments: string[] = [];
  for (const c of crew) {
    const a = await su.query(
      `INSERT INTO crew_assignment (organisation_id, shift_id, staff_id, role, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ORG, shiftId, c.staffId, c.role, s, e],
    );
    await su.query(
      `INSERT INTO resource_booking (organisation_id, resource_type, resource_id, starts_at, ends_at, source_type, source_id)
       VALUES ($1, 'STAFF', $2, $3, $4, 'CREW', $5)`,
      [ORG, c.staffId, s, e, a.rows[0].id],
    );
    assignments.push(a.rows[0].id as string);
  }
  return { shiftId, assignments, startsAt: s, endsAt: e };
}

describe('open shifts (v36 screen 34)', () => {
  it('control posts, crew offer, control fills with the planner checks', async () => {
    const crew = await staffOf('dev|crew');
    const s = await shift(24 * 41, 8);
    const crewPost = await call('POST', '/api/v1/open-shifts', {
      sub: 'dev|crew',
      body: { shiftId: s.shiftId, role: 'CARE_ASSISTANT' },
    });
    expect(crewPost.status).toBe(403);
    const o = await call('POST', '/api/v1/open-shifts', {
      body: { shiftId: s.shiftId, role: 'CARE_ASSISTANT', note: 'Cover for sickness' },
    });
    expect(o.status).toBe(201);
    expect(o.body.code).toMatch(/^OS-\d+$/);

    const crewList = await call('GET', '/api/v1/open-shifts', { sub: 'dev|crew' });
    expect((crewList.body.data as J[]).some((x) => x.id === o.body.id)).toBe(true);

    const offer = await call('POST', `/api/v1/open-shifts/${o.body.id}/offer`, { sub: 'dev|crew' });
    expect(offer.status).toBe(201);
    expect(offer.body.offeredByMe).toBe(true);
    const twice = await call('POST', `/api/v1/open-shifts/${o.body.id}/offer`, { sub: 'dev|crew' });
    expect(twice.status).toBe(409);

    const ctrl = await call('GET', '/api/v1/open-shifts');
    const mine = (ctrl.body.data as J[]).find((x) => x.id === o.body.id)!;
    expect(mine.offers).toHaveLength(1);

    const fill = await call('POST', `/api/v1/open-shifts/${o.body.id}/fill`, {
      body: { staffId: crew },
    });
    expect(fill.status).toBe(201);
    expect(fill.body.status).toBe('FILLED');
    const on = await su.query(
      `SELECT count(*)::int AS n FROM crew_assignment WHERE shift_id = $1 AND staff_id = $2 AND active`,
      [s.shiftId, crew],
    );
    expect(on.rows[0].n).toBe(1);
  });

  it('refuses to fill with someone already booked at that time', async () => {
    const crew2 = await staffOf('dev|crew2');
    const busy = await shift(24 * 43, 8, [{ staffId: crew2, role: 'DRIVER' }]);
    const s = await shift(24 * 43 + 2, 6);
    const o = await call('POST', '/api/v1/open-shifts', {
      body: { shiftId: s.shiftId, role: 'DRIVER' },
    });
    const fill = await call('POST', `/api/v1/open-shifts/${o.body.id}/fill`, {
      body: { staffId: crew2 },
    });
    expect(fill.status).toBe(409);
    expect(busy.assignments).toHaveLength(1);
  });
});

describe('shift swaps (v36 screen 34)', () => {
  it('needs the colleague to agree and someone outside the swap to approve; then both move', async () => {
    const crew = await staffOf('dev|crew');
    const crew2 = await staffOf('dev|crew2');
    const a = await shift(24 * 45, 8, [{ staffId: crew, role: 'CARE_ASSISTANT' }]);
    const b = await shift(24 * 47, 8, [{ staffId: crew2, role: 'CARE_ASSISTANT' }]);

    const notMine = await call('POST', '/api/v1/shift-swaps', {
      sub: 'dev|crew',
      body: {
        fromAssignmentId: b.assignments[0],
        toAssignmentId: a.assignments[0],
        reason: 'Family event',
      },
    });
    expect(notMine.status).toBe(403);

    const r = await call('POST', '/api/v1/shift-swaps', {
      sub: 'dev|crew',
      body: {
        fromAssignmentId: a.assignments[0],
        toAssignmentId: b.assignments[0],
        reason: 'Family event',
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^SWP-\d+$/);

    const early = await call('POST', `/api/v1/shift-swaps/${r.body.id}/decide`, {
      body: { approve: true },
    });
    expect(early.status).toBe(422);
    const wrongAgree = await call('POST', `/api/v1/shift-swaps/${r.body.id}/agree`, {
      sub: 'dev|crew',
    });
    expect(wrongAgree.status).toBe(403);
    const agreed = await call('POST', `/api/v1/shift-swaps/${r.body.id}/agree`, {
      sub: 'dev|crew2',
    });
    expect(agreed.status).toBe(201);
    expect(agreed.body.status).toBe('AGREED');

    const ok = await call('POST', `/api/v1/shift-swaps/${r.body.id}/decide`, {
      body: { approve: true },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('APPROVED');
    expect(Array.isArray(ok.body.warnings)).toBe(true);

    const onA = await su.query(
      `SELECT staff_id FROM crew_assignment WHERE shift_id = $1 AND active`,
      [a.shiftId],
    );
    const onB = await su.query(
      `SELECT staff_id FROM crew_assignment WHERE shift_id = $1 AND active`,
      [b.shiftId],
    );
    expect(onA.rows.map((x) => x.staff_id)).toEqual([crew2]);
    expect(onB.rows.map((x) => x.staff_id)).toEqual([crew]);

    const again = await call('POST', `/api/v1/shift-swaps/${r.body.id}/decide`, {
      body: { approve: true },
    });
    expect(again.status).toBe(409);
  });

  it('a refusal needs a reason; crew see only swaps they are in', async () => {
    const crew = await staffOf('dev|crew');
    const crew2 = await staffOf('dev|crew2');
    const a = await shift(24 * 50, 8, [{ staffId: crew, role: 'DRIVER' }]);
    const b = await shift(24 * 52, 8, [{ staffId: crew2, role: 'DRIVER' }]);
    const r = await call('POST', '/api/v1/shift-swaps', {
      sub: 'dev|crew',
      body: {
        fromAssignmentId: a.assignments[0],
        toAssignmentId: b.assignments[0],
        reason: 'Course',
      },
    });
    const noReason = await call('POST', `/api/v1/shift-swaps/${r.body.id}/decide`, {
      body: { approve: false },
    });
    expect(noReason.status).toBe(400);
    const refused = await call('POST', `/api/v1/shift-swaps/${r.body.id}/decide`, {
      body: { approve: false, note: 'Not enough drivers that day' },
    });
    expect(refused.body.status).toBe('REFUSED');
    const list = await call('GET', '/api/v1/shift-swaps', { sub: 'dev|crew2' });
    expect(
      (list.body.data as J[]).every((x) => x.from.staffId === crew2 || x.to.staffId === crew2),
    ).toBe(true);
  });
});

describe('hours worked (v36 screen 34)', () => {
  it('crew clock in and out on their own assignment; a manager corrects with a reason; hours are reported', async () => {
    const crew = await staffOf('dev|crew');
    const s = await shift(-0.5, 8, [{ staffId: crew, role: 'CARE_ASSISTANT' }]);
    const mine = await call('GET', '/api/v1/shift-time/mine', { sub: 'dev|crew' });
    expect((mine.body.data as J[]).some((x) => x.assignmentId === s.assignments[0])).toBe(true);

    const other = await call('POST', '/api/v1/shift-time/clock-in', {
      sub: 'dev|crew2',
      body: { assignmentId: s.assignments[0] },
    });
    expect(other.status).toBe(404);
    const inn = await call('POST', '/api/v1/shift-time/clock-in', {
      sub: 'dev|crew',
      body: { assignmentId: s.assignments[0] },
    });
    expect(inn.status).toBe(201);
    const twice = await call('POST', '/api/v1/shift-time/clock-in', {
      sub: 'dev|crew',
      body: { assignmentId: s.assignments[0] },
    });
    expect(twice.status).toBe(409);

    const fix = await call('POST', '/api/v1/shift-time/correct', {
      body: {
        assignmentId: s.assignments[0],
        clockIn: new Date(s.startsAt.getTime()).toISOString(),
        clockOut: new Date(Date.now() - 60_000).toISOString(),
        breakMinutes: 0,
        reason: 'Forgot to clock in on time',
      },
    });
    expect(fix.status).toBe(201);
    expect(fix.body.corrected).toBe(true);

    const day = londonDate(s.startsAt);
    const hours = await call('GET', `/api/v1/shift-time/hours?from=${day}&to=${addDays(day, 1)}`);
    expect(hours.status).toBe(200);
    const p = (hours.body.people as J[]).find((x) => x.staffId === crew)!;
    expect(p.actualMinutes).toBeGreaterThan(20);
    expect(hours.body.note).toMatch(/not a pay calculation/);

    const crewHours = await call('GET', `/api/v1/shift-time/hours?from=${day}&to=${day}`, {
      sub: 'dev|crew',
    });
    expect(crewHours.status).toBe(403);
  });
});

describe('shift patterns (v36 screen 34)', () => {
  it('adds a pattern, flags short rest, and lists its working days without creating shifts', async () => {
    const code = `N${Math.floor(Math.random() * 9000 + 1000)}`;
    const p = await call('POST', '/api/v1/shift-patterns', {
      body: {
        code,
        name: 'Long nights',
        startTime: '19:00',
        endTime: '09:00',
        onDays: 4,
        offDays: 4,
      },
    });
    expect(p.status).toBe(201);
    expect(p.body.overnight).toBe(true);
    expect(p.body.lengthHours).toBe(14);
    expect(p.body.restWarning).toMatch(/rest/);
    const dup = await call('POST', '/api/v1/shift-patterns', {
      body: { code, name: 'Copy', startTime: '07:00', endTime: '19:00', onDays: 4, offDays: 4 },
    });
    expect(dup.status).toBe(409);
    const from = londonDate(new Date());
    const d = await call('GET', `/api/v1/shift-patterns/${p.body.id}/dates?from=${from}&weeks=2`);
    expect(d.body.dates).toHaveLength(8);
    expect(d.body.dates[4].date).toBe(addDays(from, 8));
    const crew = await call('POST', '/api/v1/shift-patterns', {
      sub: 'dev|crew',
      body: {
        code: 'X1',
        name: 'Nope',
        startTime: '07:00',
        endTime: '15:00',
        onDays: 5,
        offDays: 2,
      },
    });
    expect(crew.status).toBe(403);
  });
});
