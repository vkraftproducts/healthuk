import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, activateStaff, addVerifiedLicence, makeApp, sign } from './harness.js';

// Task 15 (registers and forms) and task 26 fleet follow-ups. Written 6 Nov 2026; not yet run.
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
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const letters = (k: number) =>
  Array.from({ length: k }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
/** A current-format UK registration (D1), e.g. RF42KQZ. */
const ukReg = (prefix = 'RF') => `${prefix}${10 + Math.floor(Math.random() * 90)}${letters(3)}`;
const userIdOf = async (sub: string) =>
  (await call('GET', '/api/v1/me', { sub })).body.user.id as string;

async function crewMember(roles: string[] = ['DRIVER', 'CARE_ASSISTANT']) {
  const t = `${Date.now().toString(36)}${tag()}`.toLowerCase();
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  const u = await su.query(
    `INSERT INTO app_user (idp_subject, email, display_name, status)
     VALUES ($1, $2, 'Synthetic Crew', 'ACTIVE') RETURNING id`,
    [`dev|r-${t}`, `r-${t}@example.test`],
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
      displayName: 'Synthetic Crew',
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
          lastCheckedOn: londonDate(new Date()),
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
      callsign: `REG-${tag()}`,
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

async function book(startH: number, extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/bookings', {
    body: {
      customer: 'Synthetic NHS Trust',
      job: {
        locationId: SEED_IDS.locWatford,
        pickupFrom: at(startH),
        pickupTo: at(startH + 0.5),
        plannedStart: at(startH),
        plannedEnd: at(startH + 1),
        pickupAddress: '1 Synthetic Road, Watford',
        destinationAddress: 'Synthetic General Hospital',
        patientRef: `PX${tag()}`,
        mobility: 'WALKING',
        ...extra,
      },
    },
  });
  expect(r.status).toBe(201);
  return (r.body.jobs as J[])[0]!;
}

describe('vehicle register (findings 39, 41, 43)', () => {
  it('a new vehicle has no odometer figure until a reading is recorded', async () => {
    const v = await vehicle({
      licenceCategory: 'C1',
      grossWeightKg: 4250,
      ownership: 'LEASED',
      ownershipEndsOn: addDays(londonDate(new Date()), 400),
    });
    expect(v).toMatchObject({
      grossWeightKg: 4250,
      licenceCategory: 'C1',
      latestReading: null,
      currentOdometer: null,
    });
    const day = addDays(londonDate(new Date()), -1);
    const r = await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      sub: 'dev|fleet',
      body: { reading: 12345, readOn: day },
    });
    expect(r.status).toBe(201);
    const got = await call('GET', `/api/v1/vehicles/${v.id}`, { sub: 'dev|fleet' });
    expect(got.body.latestReading).toEqual({ reading: 12345, readOn: day });
    expect(got.body.currentOdometer).toBe(12345);
    const list = await call('GET', '/api/v1/vehicles', { sub: 'dev|fleet' });
    expect((list.body.data as J[]).find((x) => x.id === v.id)?.latestReading).toEqual({
      reading: 12345,
      readOn: day,
    });
  });

  it('a clash names the field that clashes', async () => {
    const v = await vehicle();
    const dupe = await call('POST', '/api/v1/vehicles', {
      sub: 'dev|fleet',
      body: {
        registration: v.registration,
        callsign: `REG-${tag()}`,
        type: 'PTS_VEHICLE',
        baseLocationId: SEED_IDS.locWatford,
        seats: 4,
        wheelchairCapacity: 0,
      },
    });
    expect(dupe.status).toBe(409);
    expect(JSON.stringify(dupe.body)).toContain('Another vehicle already has that registration');
  });

  it('a gross weight outside the plated range is refused in plain words', async () => {
    const r = await call('POST', '/api/v1/vehicles', {
      sub: 'dev|fleet',
      body: {
        registration: ukReg(),
        callsign: `REG-${tag()}`,
        type: 'PTS_VEHICLE',
        baseLocationId: SEED_IDS.locWatford,
        seats: 4,
        wheelchairCapacity: 0,
        grossWeightKg: 10,
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('shift planning guards (findings 67, 68)', () => {
  it('refuses the same person twice, a blocked vehicle, and overlapping crew time', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const twice = await call('POST', '/api/v1/shifts', {
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: v.id,
        startsAt: at(30),
        endsAt: at(38),
        crew: [
          { staffId: d, role: 'DRIVER' },
          { staffId: d, role: 'CARE_ASSISTANT' },
        ],
      },
    });
    expect(twice.status).toBe(400);
    const blocked = await call('POST', '/api/v1/shifts', {
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: SEED_IDS.vehicleAmb3,
        startsAt: at(30),
        endsAt: at(38),
        crew: [{ staffId: d, role: 'DRIVER' }],
      },
    });
    expect([blocked.status, blocked.body.code]).toEqual([422, 'OVERRIDE_NOT_PERMITTED']);
    const s = await call('POST', '/api/v1/shifts', {
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: v.id,
        startsAt: at(30),
        endsAt: at(38),
        crew: [
          { staffId: d, role: 'DRIVER' },
          { staffId: a, role: 'CARE_ASSISTANT' },
        ],
      },
    });
    expect(s.status).toBe(201);
    const again = await call('POST', `/api/v1/shifts/${s.body.id}/crew`, {
      body: { staffId: a, role: 'CARE_ASSISTANT' },
    });
    expect(again.status).toBe(400);
    expect(again.body.detail).toMatch(/already on this shift at that time/);
  });
});

describe('allocation exception requests (finding 69)', () => {
  async function setUp() {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle({ wheelchairCapacity: 0 });
    const s = await call('POST', '/api/v1/shifts', {
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: v.id,
        startsAt: at(50),
        endsAt: at(58),
        crew: [
          { staffId: d, role: 'DRIVER' },
          { staffId: a, role: 'CARE_ASSISTANT' },
        ],
      },
    });
    expect(s.status).toBe(201);
    return { shiftId: s.body.id as string };
  }
  const ask = (jobId: string, shiftId: string, checkCode: string, sub = 'dev|dispatcher') =>
    call('POST', '/api/v1/allocation-exception-requests', {
      sub,
      body: {
        jobId,
        shiftId,
        checkCode,
        reason: 'Bariatric-trained supervisor attending',
        expiresAt: at(60),
      },
    });

  it('a dispatcher asks; a different approver decides; then allocation goes through', async () => {
    const { shiftId } = await setUp();
    const job = await book(52, { requiredSkills: ['BARIATRIC'] });
    const plain = await call('POST', `/api/v1/jobs/${job.id}/validate`, { body: { shiftId } });
    const competence = (plain.body.checks as J[]).find((c) => c.code === 'COMPETENCE');
    expect(competence).toMatchObject({ result: 'FAIL', overridable: true });

    expect((await ask(job.id, shiftId, 'COMPETENCE', 'dev|crew')).status).toBe(403);
    const r = await ask(job.id, shiftId, 'COMPETENCE');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'REQUESTED', checkCode: 'COMPETENCE' });
    expect(r.body.requestedByName).toBeTruthy();
    expect((await ask(job.id, shiftId, 'COMPETENCE')).status).toBe(409);

    const listed = await call('GET', `/api/v1/allocation-exception-requests?jobId=${job.id}`);
    expect((listed.body.data as J[]).map((x) => x.id)).toContain(r.body.id);
    expect(
      (await call('GET', '/api/v1/allocation-exception-requests', { sub: 'dev|crew' })).status,
    ).toBe(403);

    const decide = (sub: string, body: unknown) =>
      call('POST', `/api/v1/allocation-exception-requests/${r.body.id}/decide`, { sub, body });
    expect((await decide('dev|dispatcher', { decision: 'APPROVED' })).status).toBe(403);
    expect((await decide('dev|manager', { decision: 'REJECTED' })).status).toBe(400);
    const ok = await decide('dev|manager', { decision: 'APPROVED', note: 'Supervisor confirmed' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'APPROVED', decisionNote: 'Supervisor confirmed' });
    expect(ok.body.decidedByName).toBeTruthy();
    expect((await decide('dev|director', { decision: 'APPROVED' })).status).toBe(409);

    const allocated = await call('POST', `/api/v1/jobs/${job.id}/allocate`, { body: { shiftId } });
    expect(allocated.status).toBe(201);
  });

  it('the person who asked cannot decide their own request', async () => {
    const { shiftId } = await setUp();
    const job = await book(54, { requiredSkills: ['BARIATRIC'] });
    const r = await ask(job.id, shiftId, 'COMPETENCE', 'dev|manager');
    expect(r.status).toBe(201);
    const self = await call('POST', `/api/v1/allocation-exception-requests/${r.body.id}/decide`, {
      sub: 'dev|manager',
      body: { decision: 'APPROVED' },
    });
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL']);
    const refused = await call(
      'POST',
      `/api/v1/allocation-exception-requests/${r.body.id}/decide`,
      { sub: 'dev|director', body: { decision: 'REJECTED', note: 'Supervisor not available' } },
    );
    expect(refused.status).toBe(201);
    expect(refused.body).toMatchObject({ status: 'REJECTED', exceptionId: null });
    // History is immutable: a decided request cannot be rewritten.
    await expect(
      db.withTenant({ orgId: ORG, userId: await userIdOf('dev|director') }, (tx) =>
        tx.allocationExceptionRequest.update({
          where: { id: r.body.id },
          data: { status: 'APPROVED' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('safety and statutory failures cannot be asked about; passing checks neither', async () => {
    const { shiftId } = await setUp();
    const job = await book(56, { mobility: 'WHEELCHAIR' });
    const unsafe = await ask(job.id, shiftId, 'VEHICLE_SUITABILITY');
    expect([unsafe.status, unsafe.body.code]).toEqual([422, 'OVERRIDE_NOT_PERMITTED']);
    const passing = await ask(job.id, shiftId, 'TIME_CONFLICT');
    expect(passing.status).toBe(400);
  });
});

describe('premises register (findings 64, 65)', () => {
  async function schedule() {
    const t = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `PREM-${tag()}`,
        title: 'Synthetic emergency lighting test',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'PREMISES',
          recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 1 } },
          blocking: 'STATUTORY',
          deadlineKind: 'DUE',
        },
      },
    });
    expect(t.status).toBe(201);
    await call(
      'POST',
      `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
      { sub: 'dev|manager' },
    );
    return t.body.id as string;
  }

  it('names people, edits with the version, and links a schedule later', async () => {
    const mgr = await userIdOf('dev|manager');
    const prem = await userIdOf('dev|premises');
    const item = await call('POST', '/api/v1/premises-items', {
      sub: 'dev|premises',
      body: {
        locationId: SEED_IDS.locWatford,
        controlArea: 'FIRE',
        title: `Emergency lighting – ${tag()}`,
        responsibleUserId: mgr,
        frequencySource: 'BS 5266 (synthetic)',
      },
    });
    expect(item.status).toBe(201);
    // "Same as responsible person" is stored and named as that person.
    expect(item.body).toMatchObject({
      actionOwnerUserId: mgr,
      requirementInstanceId: null,
      scheduleTitle: null,
    });
    expect(item.body.responsibleName).toBeTruthy();
    expect(item.body.actionOwnerName).toBe(item.body.responsibleName);

    const url = `/api/v1/premises-items/${item.body.id}`;
    expect(
      (await call('PATCH', url, { sub: 'dev|premises', body: { contractorName: 'Synthetic' } }))
        .status,
    ).toBe(400);
    const edited = await call('PATCH', url, {
      sub: 'dev|premises',
      ifMatch: item.body.version,
      body: { contractorName: 'Synthetic Lighting Ltd', actionOwnerUserId: prem },
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      contractorName: 'Synthetic Lighting Ltd',
      actionOwnerUserId: prem,
      version: item.body.version + 1,
    });
    const stale = await call('PATCH', url, {
      sub: 'dev|premises',
      ifMatch: item.body.version,
      body: { contractorName: 'Someone else' },
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect(
      (await call('PATCH', url, { sub: 'dev|crew', ifMatch: 1, body: { title: 'Nope' } })).status,
    ).toBe(403);

    const templateId = await schedule();
    const past = await call('POST', `${url}/schedule`, {
      sub: 'dev|premises',
      body: { templateId, dueDate: addDays(londonDate(new Date()), -1) },
    });
    expect(past.status).toBe(400);
    const due = addDays(londonDate(new Date()), 30);
    const linked = await call('POST', `${url}/schedule`, {
      sub: 'dev|premises',
      body: { templateId, dueDate: due },
    });
    expect(linked.status).toBe(201);
    expect(linked.body.requirementInstanceId).toEqual(expect.any(String));
    expect(linked.body.scheduleTitle).toBe('Synthetic emergency lighting test');
    expect(linked.body.nextDue).toBe(due);
    expect(
      (await call('POST', `${url}/schedule`, { sub: 'dev|premises', body: { templateId } })).status,
    ).toBe(409);
  });
});
