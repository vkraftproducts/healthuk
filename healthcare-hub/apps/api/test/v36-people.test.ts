import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { addDays, addMonths, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 batch 2 (17 Nov 2026): probation reviews and appraisals, sickness absence, leavers.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: { sub?: string; body?: unknown; org?: string } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|hr' })}`,
      'x-org-id': o.org ?? ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const today = () => londonDate(new Date());
const userIdOf = async (sub: string) =>
  (await call('GET', '/api/v1/me', { sub })).body.user.id as string;

async function person() {
  const s = await call('POST', '/api/v1/staff', {
    sub: 'dev|manager',
    body: {
      staffNo: `ST-${100000 + Math.floor(Math.random() * 900000)}`,
      displayName: 'Synthetic Starter',
      primaryLocationId: SEED_IDS.locWatford,
    },
  });
  expect(s.status).toBe(201);
  return s.body as J;
}

describe('probation reviews and appraisals (v36 screen 35)', () => {
  it('schedules, records by someone else, and schedules the next review from the outcome', async () => {
    const p = await person();
    const r = await call('POST', '/api/v1/staff-reviews', {
      body: { staffId: p.id, kind: 'PROBATION_3M', dueOn: addDays(today(), -2) },
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^REV-\d+$/);
    expect(r.body.overdue).toBe(true);
    expect(r.body.dueText).toMatch(/Overdue by 2 days/);

    const manager = await userIdOf('dev|manager');
    const wrongOutcome = await call('POST', `/api/v1/staff-reviews/${r.body.id}/record`, {
      body: { outcome: 'MEETS', reviewedOn: today(), reviewerUserId: manager },
    });
    expect(wrongOutcome.status).toBe(400);

    const done = await call('POST', `/api/v1/staff-reviews/${r.body.id}/record`, {
      body: {
        outcome: 'PASSED',
        reviewedOn: today(),
        reviewerUserId: manager,
        notes: 'Settled in well.',
      },
    });
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('DONE');
    expect(done.body.reviewerName).toBeTruthy();
    expect(done.body.nextReviewId).toBeTruthy();

    const list = await call('GET', `/api/v1/staff-reviews?staffId=${p.id}`);
    const next = (list.body.data as J[]).find((x) => x.id === done.body.nextReviewId)!;
    expect(next.kind).toBe('PROBATION_6M');
    expect(next.dueOn).toBe(addMonths(today(), 3));

    const twice = await call('POST', `/api/v1/staff-reviews/${r.body.id}/record`, {
      body: { outcome: 'PASSED', reviewedOn: today(), reviewerUserId: manager },
    });
    expect(twice.status).toBe(409);
  });

  it('an appraisal needs objectives; crew see only their own reviews and cannot schedule', async () => {
    const p = await person();
    const r = await call('POST', '/api/v1/staff-reviews', {
      body: { staffId: p.id, kind: 'APPRAISAL', dueOn: addDays(today(), 10) },
    });
    const manager = await userIdOf('dev|manager');
    const noObj = await call('POST', `/api/v1/staff-reviews/${r.body.id}/record`, {
      body: { outcome: 'MEETS', reviewedOn: today(), reviewerUserId: manager },
    });
    expect(noObj.status).toBe(400);
    const crew = await call('GET', '/api/v1/staff-reviews', { sub: 'dev|crew' });
    expect(crew.status).toBe(200);
    expect((crew.body.data as J[]).some((x) => x.staffId === p.id)).toBe(false);
    const crewAdd = await call('POST', '/api/v1/staff-reviews', {
      sub: 'dev|crew',
      body: { staffId: p.id, kind: 'APPRAISAL', dueOn: today() },
    });
    expect(crewAdd.status).toBe(403);
  });
});

describe('sickness absence and return to work (v36 screen 35)', () => {
  it('an open absence marks the person unavailable; the interview lifts it and can add a phased return', async () => {
    const p = await person();
    const a = await call('POST', '/api/v1/staff-absences', {
      body: { staffId: p.id, firstDay: addDays(today(), -5), category: 'MUSCULOSKELETAL' },
    });
    expect(a.status).toBe(201);
    expect(a.body.stillOff).toBe(true);
    expect(a.body.code).toMatch(/^ABS-\d+$/);

    const second = await call('POST', '/api/v1/staff-absences', {
      body: { staffId: p.id, firstDay: addDays(today(), -1), category: 'OTHER' },
    });
    expect(second.status).toBe(409);

    const staff = await call('GET', `/api/v1/staff/${p.id}`, { sub: 'dev|manager' });
    expect(JSON.stringify(staff.body)).toMatch(/Off sick/);

    const hr = await userIdOf('dev|hr');
    const back = await call('POST', `/api/v1/staff-absences/${a.body.id}/return`, {
      body: {
        lastDay: addDays(today(), -1),
        rtwOn: today(),
        rtwByUserId: hr,
        phased: true,
        phasedTerms: 'No lifting over 25 kg',
        phasedUntil: addDays(today(), 14),
      },
    });
    expect(back.status).toBe(201);
    expect(back.body.stillOff).toBe(false);
    expect(back.body.days).toBe(5);
    expect(back.body.phased).toBe(true);

    const after = await call('GET', `/api/v1/staff/${p.id}`, { sub: 'dev|manager' });
    const text = JSON.stringify(after.body);
    expect(text).toMatch(/Phased return: No lifting over 25 kg/);
  });

  it('flags the trigger after three episodes in six months, and is hidden from people without HR access', async () => {
    const p = await person();
    for (const [f, l] of [
      [-90, -89],
      [-60, -60],
      [-20, -18],
    ] as const) {
      const r = await call('POST', '/api/v1/staff-absences', {
        body: {
          staffId: p.id,
          firstDay: addDays(today(), f),
          lastDay: addDays(today(), l),
          category: 'GASTROINTESTINAL',
        },
      });
      expect(r.status).toBe(201);
    }
    const list = await call('GET', '/api/v1/staff-absences');
    const t = (list.body.triggers as J[]).find((x) => x.staffId === p.id)!;
    expect(t.episodes6m).toBe(3);
    expect(t.reached).toBe(true);
    expect(t.bradford12m).toBe(3 * 3 * 6);
    expect(
      (list.body.data as J[]).filter((x) => x.staffId === p.id).every((x) => x.rtwMissing),
    ).toBe(true);

    // People without HR access see only their own absences (RLS), never anyone else's.
    for (const sub of ['dev|dispatcher', 'dev|fleet']) {
      const r = await call('GET', '/api/v1/staff-absences', { sub });
      expect((r.body.data as J[] | undefined)?.some((x) => x.staffId === p.id) ?? false).toBe(
        false,
      );
    }
    expect((await call('GET', '/api/v1/staff-absences', { sub: 'dev|auditor' })).status).toBe(403);
    const crew = await call('GET', '/api/v1/staff-absences', { sub: 'dev|crew' });
    expect((crew.body.data as J[]).some((x) => x.staffId === p.id)).toBe(false);
    expect(crew.body.triggers).toEqual([]);
  });
});

describe('leavers (v36 screen 35)', () => {
  it('completes only after the move to leaver and every item, and keeps records for six years', async () => {
    const p = await person();
    const l = await call('POST', '/api/v1/leavers', {
      body: { staffId: p.id, lastDay: today(), reason: 'RESIGNED', reasonNote: 'Relocating' },
    });
    expect(l.status).toBe(201);
    expect(l.body.code).toMatch(/^LV-\d+$/);
    expect(l.body.doneCount).toBe(0);
    const dup = await call('POST', '/api/v1/leavers', {
      body: { staffId: p.id, lastDay: today(), reason: 'RESIGNED' },
    });
    expect(dup.status).toBe(409);

    for (const item of ['BADGE', 'KIT', 'PAYROLL']) {
      const t = await call('POST', `/api/v1/leavers/${l.body.id}/tick`, { body: { item } });
      expect(t.status).toBe(201);
    }
    const again = await call('POST', `/api/v1/leavers/${l.body.id}/tick`, {
      body: { item: 'KIT' },
    });
    expect(again.status).toBe(409);
    const exit = await call('POST', `/api/v1/leavers/${l.body.id}/tick`, {
      body: { item: 'EXIT_INTERVIEW', exitInterview: 'DECLINED' },
    });
    expect(exit.body.doneCount).toBe(4);

    const early = await call('POST', `/api/v1/leavers/${l.body.id}/complete`);
    expect(early.status).toBe(422);
    expect(early.body.detail).toMatch(/Move the person to leaver/);

    const moved = await call('POST', `/api/v1/staff/${p.id}/transition`, {
      body: { to: 'LEAVER', reason: 'Resigned – relocating', lastWorkingDay: today() },
    });
    expect(moved.status).toBe(201);

    const cancel = await call('POST', `/api/v1/leavers/${l.body.id}/cancel`, {
      body: { reason: 'Changed their mind' },
    });
    expect(cancel.status).toBe(422);

    const done = await call('POST', `/api/v1/leavers/${l.body.id}/complete`);
    expect(done.status).toBe(201);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.keepUntil).toBe(addMonths(today(), 72));
    expect(done.body.doneCount).toBe(5);
  });

  it('only people who can move staff through the lifecycle can run the checklist', async () => {
    const p = await person();
    const r = await call('POST', '/api/v1/leavers', {
      sub: 'dev|dispatcher',
      body: { staffId: p.id, lastDay: today(), reason: 'RESIGNED' },
    });
    expect(r.status).toBe(403);
  });
});
