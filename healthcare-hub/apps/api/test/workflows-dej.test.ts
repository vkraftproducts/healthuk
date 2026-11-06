import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, activateStaff, addVerifiedLicence, makeApp, sign } from './harness.js';

// Workflow pass D (vehicles and equipment), E (planning and dispatch) and J1 (premises).
// Written 6 Nov 2026; not yet run.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  o: { sub?: string; body?: unknown; ifMatch?: number } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|dispatcher' })}`,
      'x-org-id': ORG,
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
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

const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
const today = () => londonDate(new Date());
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const letters = (k: number) =>
  Array.from({ length: k }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const ukReg = (prefix = 'WF') => `${prefix}${10 + Math.floor(Math.random() * 90)}${letters(3)}`;

async function crewMember(roles: string[] = ['DRIVER', 'CARE_ASSISTANT'], name = 'Synthetic Crew') {
  const t = `${Date.now().toString(36)}${tag()}`.toLowerCase();
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  const u = await su.query(
    `INSERT INTO app_user (idp_subject, email, display_name, status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [`dev|w-${t}`, `w-${t}@example.test`, name],
  );
  await su.query(
    `INSERT INTO membership (organisation_id, user_id, role_id)
     SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
    [ORG, u.rows[0].id],
  );
  await su.end();
  const s = await call('POST', '/api/v1/staff', {
    sub: 'dev|manager',
    body: {
      staffNo: `ST-${100000 + Math.floor(Math.random() * 900000)}`,
      displayName: name,
      primaryLocationId: SEED_IDS.locWatford,
      userId: u.rows[0].id,
    },
  });
  expect(s.status).toBe(201);
  await call('POST', `/api/v1/staff/${s.body.id}/transition`, {
    sub: 'dev|hr',
    body: { to: 'CHECKS_IN_PROGRESS', reason: 'To CHECKS_IN_PROGRESS' },
  });
  await activateStaff(app, ORG, s.body.id, roles);
  if (roles.includes('DRIVER')) {
    await addVerifiedLicence(app, ORG, s.body.id);
    await call('POST', `/api/v1/staff/${s.body.id}/licences`, {
      sub: 'dev|manager',
      body: {
        data: {
          categories: ['B', 'C1'],
          photocardExpiry: '2032-01-01',
          lastCheckedOn: today(),
          checkMethod: 'DVLA_SHARE_CODE',
        },
      },
    });
  }
  return s.body.id as string;
}

async function vehicle(extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/vehicles', {
    sub: 'dev|fleet',
    body: {
      registration: ukReg(),
      callsign: `WF-${tag()}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
      ...extra,
    },
  });
  expect(r.status).toBe(201);
  return r.body as J;
}

const jobFields = (startH: number, extra: Record<string, unknown> = {}) => ({
  locationId: SEED_IDS.locWatford,
  pickupFrom: at(startH),
  pickupTo: at(startH + 0.5),
  plannedStart: at(startH),
  plannedEnd: at(startH + 1),
  pickupAddress: '1 Synthetic Road, Watford',
  destinationAddress: 'Synthetic General Hospital',
  patientRef: `BK${tag()}`,
  mobility: 'WALKING',
  ...extra,
});

async function shift(vehicleId: string, startH: number, endH: number, crew: J[]) {
  return call('POST', '/api/v1/shifts', {
    body: {
      locationId: SEED_IDS.locWatford,
      vehicleId,
      startsAt: at(startH),
      endsAt: at(endH),
      crew,
    },
  });
}

describe('D1 vehicle register', () => {
  it('refuses a non-UK registration in plain words', async () => {
    const r = await call('POST', '/api/v1/vehicles', {
      sub: 'dev|fleet',
      body: {
        registration: 'NOT A REG',
        callsign: `WF-${tag()}`,
        type: 'PTS_VEHICLE',
        baseLocationId: SEED_IDS.locWatford,
      },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('SY21 ABC');
  });

  it('works out the licence from the weight and says whether it can be used now', async () => {
    const v = await vehicle({ grossWeightKg: 4200, make: 'Synthetic', model: 'Van', year: 2024 });
    expect(v.licenceCategory).toBe('C1');
    expect(v.licenceNeeded).toMatch(/C1/);
    const got = await call('GET', `/api/v1/vehicles/${v.id}`, { sub: 'dev|fleet' });
    expect(got.status).toBe(200);
    expect(['AVAILABLE', 'BLOCKED']).toContain(got.body.headline.status);
    if (got.body.headline.status === 'BLOCKED') expect(got.body.headline.reason).toBeTruthy();
  });

  it('a leased vehicle needs its lease end date', async () => {
    const r = await call('POST', '/api/v1/vehicles', {
      sub: 'dev|fleet',
      body: {
        registration: ukReg(),
        callsign: `WF-${tag()}`,
        type: 'PTS_VEHICLE',
        baseLocationId: SEED_IDS.locWatford,
        ownership: 'LEASED',
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('D2 odometer review', () => {
  it('the fleet lead corrects a flagged reading; a clean reading needs no review', async () => {
    const v = await vehicle();
    const first = await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      sub: 'dev|fleet',
      body: { reading: 50_000, readOn: addDays(today(), -2) },
    });
    expect(first.status).toBe(201);
    const low = await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      sub: 'dev|fleet',
      body: { reading: 5_000, readOn: addDays(today(), -1) },
    });
    expect(low.body.flags).toContain('ODOMETER_DECREASED');
    const url = (id: string) => `/api/v1/vehicles/${v.id}/odometer/${id}/review`;
    const clean = await call('POST', url(first.body.id), {
      sub: 'dev|fleet',
      body: { decision: 'CONFIRMED', reason: 'Checked the dashboard photo' },
    });
    expect(clean.status).toBe(409);
    expect(
      (
        await call('POST', url(low.body.id), {
          sub: 'dev|crew',
          body: { decision: 'CONFIRMED', reason: 'Looks right' },
        })
      ).status,
    ).toBe(403);
    const noFigure = await call('POST', url(low.body.id), {
      sub: 'dev|fleet',
      body: { decision: 'CORRECTED', reason: 'Missed a digit' },
    });
    expect(noFigure.status).toBe(400);
    const ok = await call('POST', url(low.body.id), {
      sub: 'dev|fleet',
      body: { decision: 'CORRECTED', correctedReading: 50_500, reason: 'Missed a digit' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ decision: 'CORRECTED', reading: 50_500 });
    const again = await call('POST', url(low.body.id), {
      sub: 'dev|fleet',
      body: { decision: 'CONFIRMED', reason: 'Second go' },
    });
    expect(again.status).toBe(409);
    const got = await call('GET', `/api/v1/vehicles/${v.id}`, { sub: 'dev|fleet' });
    expect(got.body.currentOdometer).toBe(50_500);
    const row = (got.body.readings as J[]).find((r) => r.id === low.body.id);
    expect(row?.review).toMatchObject({ decision: 'CORRECTED', correctedReading: 50_500 });
    expect(row?.review.reviewedByName).toBeTruthy();
  });

  it('a service cannot be signed off against a job sheet that does not exist', async () => {
    const v = await vehicle();
    const plan = await call('POST', `/api/v1/vehicles/${v.id}/maintenance`, {
      sub: 'dev|fleet',
      body: { title: 'Annual service', intervalDays: 365 },
    });
    expect(plan.status).toBe(201);
    const r = await call('POST', `/api/v1/vehicles/${v.id}/maintenance/${plan.body.id}/done`, {
      sub: 'dev|fleet',
      body: { doneOn: today(), garage: 'Synthetic Garage', jobSheetEvidenceItemId: randomUUID() },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('Upload the job sheet first');
  });
});

describe('D5 off road and base moves', () => {
  it('records the reason code and expected return; a move cannot be future-dated', async () => {
    const v = await vehicle();
    const past = await call('POST', `/api/v1/vehicles/${v.id}/off-road`, {
      sub: 'dev|fleet',
      body: {
        on: true,
        reason: 'Waiting for a mirror',
        reasonCode: 'AWAITING_PARTS',
        expectedReturnOn: addDays(today(), -1),
      },
    });
    expect(past.status).toBe(400);
    const off = await call('POST', `/api/v1/vehicles/${v.id}/off-road`, {
      sub: 'dev|fleet',
      body: {
        on: true,
        reason: 'Waiting for a mirror',
        reasonCode: 'AWAITING_PARTS',
        expectedReturnOn: addDays(today(), 5),
      },
    });
    expect(off.status).toBe(201);
    const history = await call('GET', `/api/v1/vehicles/${v.id}/status-history`, {
      sub: 'dev|fleet',
    });
    expect((history.body.data as J[])[0]).toMatchObject({
      reasonCode: 'AWAITING_PARTS',
      expectedReturnOn: addDays(today(), 5),
    });

    const future = await call('POST', `/api/v1/vehicles/${v.id}/move`, {
      sub: 'dev|fleet',
      body: {
        locationId: SEED_IDS.locWatford,
        reason: 'Covering the rota',
        effectiveOn: addDays(today(), 3),
      },
    });
    expect(future.status).toBe(400);
  });
});

describe('E1 booking', () => {
  it('a return journey becomes its own job with the addresses swapped', async () => {
    const r = await call('POST', '/api/v1/bookings', {
      body: {
        customer: 'Synthetic NHS Trust',
        contractType: 'NHS',
        nhsEligibility: { met: true, criteria: 'Medical need', assessedBy: 'Synthetic Assessor' },
        job: jobFields(70),
        returnJourney: {
          pickupFrom: at(74),
          pickupTo: at(74.5),
          plannedStart: at(74),
          plannedEnd: at(75),
        },
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.contractType).toBe('NHS');
    const jobs = r.body.jobs as J[];
    expect(jobs).toHaveLength(2);
    const [out, back] = jobs;
    expect(back!.returnOfJobId).toBe(out!.id);
    expect(back!.pickupAddress).toBe(out!.destinationAddress);
    expect(back!.destinationAddress).toBe(out!.pickupAddress);
  });

  it('NHS work needs the eligibility decision', async () => {
    const r = await call('POST', '/api/v1/bookings', {
      body: { customer: 'Synthetic NHS Trust', contractType: 'NHS', job: jobFields(71) },
    });
    expect(r.status).toBe(400);
  });

  it('warns when the weight is above every permitted load', async () => {
    const r = await call('POST', '/api/v1/bookings', {
      body: {
        customer: 'Synthetic Private Client',
        job: jobFields(72, { mobility: 'STRETCHER', weightKg: 499 }),
      },
    });
    expect(r.status).toBe(201);
    expect((r.body.warnings as string[]).join(' ')).toMatch(/above the permitted load/);
  });

  it('a job is assessed only once the access plan is reviewed', async () => {
    const book = (reviewed: boolean) =>
      call('POST', '/api/v1/bookings', {
        body: {
          customer: 'Synthetic NHS Trust',
          job: jobFields(73, { accessPlanReviewed: reviewed }),
        },
      });
    const status = (id: string) =>
      call('POST', `/api/v1/jobs/${id}/status`, {
        body: {
          state: 'ASSESSED',
          capturedAt: new Date().toISOString(),
          clientSubmissionId: randomUUID(),
        },
      });
    const no = (await book(false)).body.jobs[0];
    const refused = await status(no.id);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('access plan reviewed');
    const yes = (await book(true)).body.jobs[0];
    expect((await status(yes.id)).status).toBeLessThan(300);
  });
});

describe('E2 shifts and crew', () => {
  it('names the clash when a person is already on another shift', async () => {
    const d = await crewMember(['DRIVER', 'CARE_ASSISTANT'], 'Sam Taylor');
    const v1 = await vehicle();
    const v2 = await vehicle();
    expect((await shift(v1.id, 80, 88, [{ staffId: d, role: 'DRIVER' }])).status).toBe(201);
    const clash = await shift(v2.id, 82, 90, [{ staffId: d, role: 'DRIVER' }]);
    expect(clash.status).toBe(409);
    expect(JSON.stringify(clash.body)).toContain(`Sam Taylor is already on ${v1.callsign}`);
  });

  it('shows readiness as a person is picked and flags a time clash', async () => {
    const d = await crewMember();
    const v = await vehicle();
    expect((await shift(v.id, 92, 100, [{ staffId: d, role: 'DRIVER' }])).status).toBe(201);
    const q = (from: number, to: number) =>
      new URLSearchParams({ staffId: d, role: 'DRIVER', from: at(from), to: at(to) });
    const free = await call('GET', `/api/v1/shifts/crew-readiness?${q(110, 118)}`);
    expect(free.status).toBe(200);
    expect(free.body.staffId).toBe(d);
    expect(
      (free.body.checks as J[]).find((c) => c.code === 'TIME_CONFLICT')?.result ?? 'PASS',
    ).toBe('PASS');
    const busy = await call('GET', `/api/v1/shifts/crew-readiness?${q(94, 98)}`);
    expect(busy.body.state).toBe('BLOCKED');
    expect((busy.body.checks as J[]).some((c) => c.code === 'TIME_CONFLICT')).toBe(true);
    const asCrew = await call('GET', `/api/v1/shifts/crew-readiness?${q(94, 98)}`, {
      sub: 'dev|crew',
    });
    expect(asCrew.status).toBe(403);
  });

  it('swaps a crew member with a reason, keeping the role', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const b = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const s = await shift(v.id, 120, 128, [
      { staffId: d, role: 'DRIVER' },
      { staffId: a, role: 'CARE_ASSISTANT' },
    ]);
    expect(s.status).toBe(201);
    const old = (s.body.crew as J[]).find((c) => c.staffId === a)!;
    const noReason = await call('POST', `/api/v1/shifts/${s.body.id}/crew/${old.id}/swap`, {
      body: { staffId: b, reason: '' },
    });
    expect(noReason.status).toBe(400);
    const swapped = await call('POST', `/api/v1/shifts/${s.body.id}/crew/${old.id}/swap`, {
      body: { staffId: b, reason: 'Off sick' },
    });
    expect(swapped.status).toBe(201);
    const active = (swapped.body.crew as J[]).filter((c) => c.active);
    expect(active.map((c) => c.staffId)).toContain(b);
    expect(active.map((c) => c.staffId)).not.toContain(a);
    expect(active.find((c) => c.staffId === b)?.role).toBe('CARE_ASSISTANT');
  });
});

describe('E3 shift gate before the start (finding 71)', () => {
  it('is pending before the shift starts', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const s = await shift(v.id, 140, 148, [
      { staffId: d, role: 'DRIVER' },
      { staffId: a, role: 'CARE_ASSISTANT' },
    ]);
    const job = (
      await call('POST', '/api/v1/bookings', {
        body: { customer: 'Synthetic NHS Trust', job: jobFields(142) },
      })
    ).body.jobs[0];
    const r = await call('POST', `/api/v1/jobs/${job.id}/validate`, {
      body: { shiftId: s.body.id },
    });
    const gate = (r.body.checks as J[]).find((c) => c.code === 'SHIFT_GATE');
    expect(gate).toMatchObject({ result: 'PENDING' });
  });
});

describe('E5 reassign', () => {
  it('moves a job to another valid shift and ends the old allocation with the reason', async () => {
    const crewOf = async () => [
      { staffId: await crewMember(), role: 'DRIVER' },
      { staffId: await crewMember(['CARE_ASSISTANT']), role: 'CARE_ASSISTANT' },
    ];
    const s1 = await shift((await vehicle()).id, 160, 168, await crewOf());
    const s2 = await shift((await vehicle()).id, 160, 168, await crewOf());
    expect([s1.status, s2.status]).toEqual([201, 201]);
    const job = (
      await call('POST', '/api/v1/bookings', {
        body: { customer: 'Synthetic NHS Trust', job: jobFields(162) },
      })
    ).body.jobs[0];
    const alloc = await call('POST', `/api/v1/jobs/${job.id}/allocate`, {
      body: { shiftId: s1.body.id },
    });
    expect(alloc.status).toBe(201);
    const noReason = await call('POST', `/api/v1/jobs/${job.id}/reassign`, {
      body: { shiftId: s2.body.id, reason: '' },
    });
    expect(noReason.status).toBe(400);
    const moved = await call('POST', `/api/v1/jobs/${job.id}/reassign`, {
      body: { shiftId: s2.body.id, reason: 'Vehicle needed elsewhere' },
    });
    expect(moved.status).toBe(201);
    const detail = await call('GET', `/api/v1/jobs/${job.id}`);
    const events = detail.body.events as J[];
    expect(events.find((e) => e.toState === 'REASSIGNED')?.reason).toBe('Vehicle needed elsewhere');
    const byCrew = await call('POST', `/api/v1/jobs/${job.id}/reassign`, {
      sub: 'dev|crew',
      body: { shiftId: s1.body.id, reason: 'Crew wants it' },
    });
    expect(byCrew.status).toBe(403);
  });
});

describe('J1 premises register', () => {
  it('works out the next due date from the interval, keeps history and raises findings', async () => {
    const mgr = (await call('GET', '/api/v1/me', { sub: 'dev|manager' })).body.user.id as string;
    const item = await call('POST', '/api/v1/premises-items', {
      sub: 'dev|premises',
      body: {
        locationId: SEED_IDS.locWatford,
        controlArea: 'WATER',
        areaName: 'Ground floor plant room',
        title: `Legionella temperature checks – ${tag()}`,
        responsibleUserId: mgr,
        frequencySource: 'Competent person written scheme (synthetic)',
        intervalMonths: 1,
        assessedOn: addDays(today(), -10),
      },
    });
    expect(item.status).toBe(201);
    expect(item.body).toMatchObject({ areaName: 'Ground floor plant room', intervalMonths: 1 });
    expect(item.body.nextDue).toBeTruthy();
    const url = `/api/v1/premises-items/${item.body.id}`;

    const pastReview = await call('POST', `${url}/applicability`, {
      sub: 'dev|premises',
      body: {
        applicable: false,
        reason: 'No water outlets in use at this base',
        reviewOn: addDays(today(), -1),
      },
    });
    expect(pastReview.status).toBe(400);

    const finding = await call('POST', `${url}/findings`, {
      sub: 'dev|premises',
      body: { title: 'Dead leg found on the second floor', deadline: addDays(today(), 14) },
    });
    expect(finding.status).toBe(201);
    expect(finding.body.sourceType).toBe('PREMISES');
    expect(
      (
        await call('POST', `${url}/findings`, {
          sub: 'dev|crew',
          body: { title: 'Not allowed', deadline: addDays(today(), 14) },
        })
      ).status,
    ).toBe(403);

    const history = await call('GET', `${url}/history`, { sub: 'dev|premises' });
    expect(history.status).toBe(200);
    const changes = (history.body.data as J[]).map((h) => h.change);
    expect(changes).toEqual(expect.arrayContaining(['CREATED', 'FINDING']));
    expect((history.body.data as J[])[0]?.changedByName).toBeTruthy();
  });
});
