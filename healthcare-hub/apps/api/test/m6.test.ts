import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { jobTimingAlerts, jobTimingAll } from '@hub/domain';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

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
  const token = await sign({ sub: o.sub ?? 'dev|dispatcher' });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-org-id': ORG,
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  db = made.db;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const H = 3_600_000;
const at = (h: number) => new Date(Date.now() + h * H).toISOString();
let seq = 9000;

/** A fresh, ACTIVE crew member with their own login (keeps tests independent of shared seed staff). */
async function crewMember(
  roles: string[] = ['DRIVER', 'CARE_ASSISTANT'],
): Promise<{ sub: string; staffId: string }> {
  const tag = `${Date.now().toString(36)}${seq}`;
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  const u = await su.query(
    `INSERT INTO app_user (idp_subject, email, display_name, status) VALUES ($1, $2, 'Synthetic Crew', 'ACTIVE') RETURNING id`,
    [`dev|c-${tag}`, `c-${tag}@example.test`],
  );
  await su.query(
    `INSERT INTO membership (organisation_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
    [ORG, u.rows[0].id],
  );
  await su.end();
  const s = await call('POST', '/api/v1/staff', {
    sub: 'dev|manager',
    body: {
      staffNo: `ST-${seq++}`,
      displayName: 'Synthetic Crew',
      primaryLocationId: SEED_IDS.locWatford,
      userId: u.rows[0].id,
    },
  });
  const move = (to: string) =>
    call('POST', `/api/v1/staff/${s.body.id}/transition`, {
      sub: 'dev|hr',
      body: { to, reason: `To ${to}` },
    });
  await move('CHECKS_IN_PROGRESS');
  await move('READY_FOR_REVIEW');
  for (const r of roles)
    await call('POST', `/api/v1/staff/${s.body.id}/role-approvals`, {
      sub: 'dev|hr',
      body: { role: r, reason: 'Checks complete' },
    });
  await move('APPROVED_FOR_ROLE');
  await move('ACTIVE');
  if (roles.includes('DRIVER'))
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
  return { sub: `dev|c-${tag}`, staffId: s.body.id as string };
}
let vn = 70;
const idOf = async (sub: string) =>
  (await call('GET', '/api/v1/me', { sub })).body.user.id as string;

async function vehicle(extra: Record<string, unknown> = {}): Promise<string> {
  vn += 1;
  const r = await call('POST', '/api/v1/vehicles', {
    sub: 'dev|fleet',
    body: {
      registration: `JB${vn}XYZ`,
      callsign: `PTS-${vn}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
      ...extra,
    },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function shift(
  vehicleId: string,
  crew: { staffId: string; role: string }[],
  fromH = 1,
  toH = 9,
) {
  const r = await call('POST', '/api/v1/shifts', {
    body: {
      locationId: SEED_IDS.locWatford,
      vehicleId,
      startsAt: at(fromH),
      endsAt: at(toH),
      crew,
    },
  });
  expect(r.status).toBe(201);
  return r.body as J;
}
async function book(startH: number, extra: Record<string, unknown> = {}, recurrence?: unknown) {
  const r = await call('POST', '/api/v1/bookings', {
    body: {
      customer: 'Synthetic NHS Trust',
      reference: `REF-${seq++}`,
      patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
      ...(recurrence ? { recurrence } : {}),
      job: {
        locationId: SEED_IDS.locWatford,
        pickupFrom: at(startH),
        pickupTo: at(startH + 0.5),
        plannedStart: at(startH),
        plannedEnd: at(startH + 1),
        pickupAddress: '1 Synthetic Road, Watford',
        destinationAddress: 'Synthetic General Hospital',
        patientRef: `PX${seq}`,
        mobility: 'WALKING',
        ...extra,
      },
    },
  });
  expect(r.status).toBe(201);
  return r.body.jobs as J[];
}

describe('allocation validation [UAT-02, JOB-02, JOB-03]', () => {
  it('allocates a valid job, then refuses an overlapping one on the same shift (TIME_CONFLICT)', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const s = await shift(v, [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ]);
    const [j1] = await book(2);
    const check = await call('POST', `/api/v1/jobs/${j1!.id}/validate`, {
      body: { shiftId: s.id },
    });
    expect(check.body.allowed).toBe(true);
    expect(check.body.checks.map((c: J) => c.code)).toEqual([
      'STAFF_CLEARANCE',
      'LICENCE',
      'COMPETENCE',
      'VEHICLE_ROADWORTHY',
      'VEHICLE_SUITABILITY',
      'EQUIPMENT',
      'TIME_CONFLICT',
      'SHIFT_GATE',
    ]);
    expect(check.body.checks.find((c: J) => c.code === 'SHIFT_GATE')).toMatchObject({
      result: 'PENDING',
    }); // before shift start is allowed
    const ok = await call('POST', `/api/v1/jobs/${j1!.id}/allocate`, { body: { shiftId: s.id } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ state: 'ALLOCATED', shiftId: s.id });

    const [j2] = await book(2.5);
    const clash = await call('POST', `/api/v1/jobs/${j2!.id}/allocate`, {
      body: { shiftId: s.id },
    });
    expect([clash.status, clash.body.code]).toEqual([409, 'ALLOCATION_BLOCKED']);
    expect(clash.body.checks.find((c: J) => c.code === 'TIME_CONFLICT')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });
    expect((await call('GET', `/api/v1/jobs/${j2!.id}`)).body.state).toBe('BOOKED'); // nothing written
  });

  it('two dispatchers racing for overlapping slots: exactly one wins', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const s = await shift(await vehicle(), [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ]);
    const [x] = await book(3);
    const [y] = await book(3.2);
    const results = await Promise.all([
      call('POST', `/api/v1/jobs/${x!.id}/allocate`, { body: { shiftId: s.id } }),
      call('POST', `/api/v1/jobs/${y!.id}/allocate`, { body: { shiftId: s.id } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('a critical defect (AMB-03) and an expired MOT block with no override; missing competence can be excepted by a named approver', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const blocked = await shift(
      SEED_IDS.vehicleAmb3,
      [
        { staffId: d.staffId, role: 'DRIVER' },
        { staffId: a.staffId, role: 'CARE_ASSISTANT' },
      ],
      10,
      18,
    );
    const [j] = await book(11);
    const r = await call('POST', `/api/v1/jobs/${j!.id}/allocate`, {
      body: { shiftId: blocked.id },
    });
    expect(r.body.checks.find((c: J) => c.code === 'VEHICLE_ROADWORTHY')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });
    const ex = await call('POST', '/api/v1/allocation-exceptions', {
      sub: 'dev|manager',
      body: {
        jobId: j!.id,
        shiftId: blocked.id,
        checkCode: 'VEHICLE_ROADWORTHY',
        reason: 'We really need this vehicle',
        expiresAt: at(20),
        approverId: await idOf('dev|dispatcher'),
      },
    });
    expect([ex.status, ex.body.code]).toEqual([422, 'OVERRIDE_NOT_PERMITTED']);

    // Expired MOT on another vehicle
    const v = await vehicle();
    const t = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `MOT-X${seq++}`,
        title: 'MOT',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'VEHICLE',
          recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
          blocking: 'STATUTORY',
          deadlineKind: 'EXPIRY',
        },
      },
    });
    await call(
      'POST',
      `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
      { sub: 'dev|manager' },
    );
    await call('POST', '/api/v1/requirements/instances', {
      sub: 'dev|manager',
      body: {
        templateId: t.body.id,
        subjectType: 'VEHICLE',
        subjectId: v,
        expiryDate: addDays(londonDate(new Date()), -1),
      },
    });
    const d2 = await crewMember();
    const a2 = await crewMember(['CARE_ASSISTANT']);
    const s2 = await shift(
      v,
      [
        { staffId: d2.staffId, role: 'DRIVER' },
        { staffId: a2.staffId, role: 'CARE_ASSISTANT' },
      ],
      10,
      18,
    );
    const [k] = await book(12, { requiredSkills: ['BARIATRIC'] });
    const res = await call('POST', `/api/v1/jobs/${k!.id}/validate`, { body: { shiftId: s2.id } });
    expect(res.body.checks.find((c: J) => c.code === 'VEHICLE_ROADWORTHY')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });
    expect(res.body.checks.find((c: J) => c.code === 'COMPETENCE')).toMatchObject({
      result: 'FAIL',
      overridable: true,
    });
    expect(res.body.exceptable).toEqual(['COMPETENCE']);

    // Competence on a clean vehicle: a policy exception (named approver, reason, expiry) lets it through.
    const v3 = await vehicle();
    const d3 = await crewMember();
    const a3 = await crewMember(['CARE_ASSISTANT']);
    const s3 = await shift(
      v3,
      [
        { staffId: d3.staffId, role: 'DRIVER' },
        { staffId: a3.staffId, role: 'CARE_ASSISTANT' },
      ],
      10,
      18,
    );
    const [m] = await book(13, { requiredSkills: ['BARIATRIC'] });
    expect(
      (await call('POST', `/api/v1/jobs/${m!.id}/allocate`, { body: { shiftId: s3.id } })).status,
    ).toBe(409);
    // The dispatcher asks a named approver; nothing changes until that person decides (E3).
    const manager = await idOf('dev|manager');
    const ask = {
      jobId: m!.id,
      shiftId: s3.id,
      checkCode: 'COMPETENCE',
      reason: 'Bariatric-trained supervisor attending',
      expiresAt: at(20),
    };
    // Nobody approves their own request.
    expect(
      (
        await call('POST', '/api/v1/allocation-exceptions', {
          sub: 'dev|manager',
          body: { ...ask, approverId: manager },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/v1/allocation-exceptions', {
          body: { ...ask, expiresAt: at(24 * 9), approverId: manager },
        })
      ).status,
    ).toBe(400);
    const req = await call('POST', '/api/v1/allocation-exceptions', {
      body: { ...ask, approverId: manager },
    });
    expect([req.status, req.body.state]).toEqual([201, 'REQUESTED']);
    expect(
      (await call('POST', `/api/v1/jobs/${m!.id}/allocate`, { body: { shiftId: s3.id } })).status,
    ).toBe(409);
    const okEx = await call('POST', `/api/v1/allocation-exceptions/${req.body.id}/decide`, {
      sub: 'dev|manager',
      body: { decision: 'APPROVED', reason: 'Supervisor confirmed for the journey' },
    });
    expect(okEx.status).toBe(201);
    const allowed = await call('POST', `/api/v1/jobs/${m!.id}/allocate`, {
      body: { shiftId: s3.id },
    });
    expect(allowed.status).toBe(201);
  });

  it('suitability, crew size and an expired licence for the driver fail', async () => {
    const d = await crewMember();
    const s = await shift(await vehicle({ wheelchairCapacity: 0 }), [
      { staffId: d.staffId, role: 'DRIVER' },
    ]);
    const [j] = await book(4, { mobility: 'WHEELCHAIR' });
    const r = (await call('POST', `/api/v1/jobs/${j!.id}/validate`, { body: { shiftId: s.id } }))
      .body;
    expect(r.checks.find((c: J) => c.code === 'VEHICLE_SUITABILITY')).toMatchObject({
      result: 'FAIL',
    });
    expect(r.checks.find((c: J) => c.code === 'STAFF_CLEARANCE').details.join(' ')).toMatch(
      /needs 2 crew/,
    );

    const t = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `DRIVING-LICENCE-X${seq++}`,
        title: 'Driving licence',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'STAFF',
          recurrence: { type: 'EVENT_TRIGGERED' },
          blocking: 'STATUTORY',
          deadlineKind: 'EXPIRY',
        },
      },
    });
    await call(
      'POST',
      `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
      { sub: 'dev|manager' },
    );
    await call('POST', '/api/v1/requirements/instances', {
      sub: 'dev|manager',
      body: {
        templateId: t.body.id,
        subjectType: 'STAFF',
        subjectId: d.staffId,
        expiryDate: addDays(londonDate(new Date()), -3),
      },
    });
    const r2 = (await call('POST', `/api/v1/jobs/${j!.id}/validate`, { body: { shiftId: s.id } }))
      .body;
    expect(r2.checks.find((c: J) => c.code === 'LICENCE')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });
  });
});

describe('shifts: double booking, swaps and the start gate [UAT-03, UAT-07]', () => {
  it('a vehicle or person cannot be on two overlapping shifts', async () => {
    const d = await crewMember();
    const v = await vehicle();
    await shift(v, [{ staffId: d.staffId, role: 'DRIVER' }], 20, 28);
    expect(
      (
        await call('POST', '/api/v1/shifts', {
          body: { locationId: SEED_IDS.locWatford, vehicleId: v, startsAt: at(27), endsAt: at(30) },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/shifts', {
          body: {
            locationId: SEED_IDS.locWatford,
            vehicleId: await vehicle(),
            startsAt: at(21),
            endsAt: at(23),
            crew: [{ staffId: d.staffId, role: 'DRIVER' }],
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/shifts', {
          body: { locationId: SEED_IDS.locWatford, vehicleId: v, startsAt: at(28), endsAt: at(36) },
        })
      ).status,
    ).toBe(201); // back to back is fine
  });

  it('crew cannot start without VDI and cleaning; a vehicle swap needs new checks; history is kept', async () => {
    const d = await crewMember();
    const v = await vehicle();
    const s = await shift(v, [{ staffId: d.staffId, role: 'DRIVER' }], -0.2, 8);
    const blocked = await call('POST', `/api/v1/shifts/${s.id}/start`, { sub: d.sub });
    expect([blocked.status, blocked.body.code]).toEqual([422, 'SHIFT_GATE_BLOCKED']);
    expect(blocked.body.checks.map((c: J) => [c.code, c.result])).toEqual([
      ['VDI', 'PENDING'],
      ['CLEANING', 'PENDING'],
      ['STAFF_READY', 'PASS'],
    ]);
    const tpl = SEED_IDS.vdiTemplate;
    const items = (await call('GET', '/api/v1/vdi-templates', { sub: d.sub })).body.data.find(
      (t: J) => t.id === tpl,
    ).items as J[];
    const vdi = (vehicleId: string) =>
      call('POST', '/api/v1/vdis', {
        sub: d.sub,
        body: {
          clientSubmissionId: randomUUID(),
          vehicleId,
          templateId: tpl,
          shiftId: s.id,
          odometer: 1000,
          capturedAt: new Date().toISOString(),
          results: items.map((i) => ({ code: i.code, result: 'PASS' })),
        },
      });
    const clean = (vehicleId: string) =>
      call('POST', '/api/v1/cleaning-records', {
        sub: d.sub,
        body: {
          clientSubmissionId: randomUUID(),
          vehicleId,
          shiftId: s.id,
          type: 'PRE_SHIFT',
          capturedAt: new Date().toISOString(),
        },
      });
    expect((await vdi(v)).status).toBe(201);
    expect(
      (await call('GET', `/api/v1/shifts/${s.id}/gate`, { sub: d.sub })).body.checks[1],
    ).toMatchObject({ code: 'CLEANING', result: 'PENDING' });
    await clean(v);

    const v2 = await vehicle();
    const swapped = await call('POST', `/api/v1/shifts/${s.id}/vehicle`, {
      body: { vehicleId: v2, reason: 'Original vehicle needs a tyre' },
    });
    expect(swapped.body.vehicleId).toBe(v2);
    expect(swapped.body.changes.map((c: J) => c.kind)).toEqual([
      'CREATED',
      'CREW_ADD',
      'VEHICLE_SWAP',
    ]);
    expect((await call('GET', `/api/v1/shifts/${s.id}/gate`, { sub: d.sub })).body.canStart).toBe(
      false,
    ); // replacement needs its own checks
    await vdi(v2);
    await clean(v2);
    const ok = await call('POST', `/api/v1/shifts/${s.id}/start`, { sub: d.sub });
    expect(ok.body).toMatchObject({ canStart: true, state: 'STARTED' });
    const other = await crewMember();
    expect((await call('POST', `/api/v1/shifts/${s.id}/start`, { sub: other.sub })).status).toBe(
      404,
    ); // not on this shift
  });

  it('a failed critical VDI item blocks the vehicle and sends its allocated jobs back for reassignment with an alert', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const s = await shift(
      v,
      [
        { staffId: d.staffId, role: 'DRIVER' },
        { staffId: a.staffId, role: 'CARE_ASSISTANT' },
      ],
      -0.2,
      8,
    );
    const [j] = await book(3);
    expect(
      (await call('POST', `/api/v1/jobs/${j!.id}/allocate`, { body: { shiftId: s.id } })).status,
    ).toBe(409); // shift running without VDI: SHIFT_GATE fails
    const items = (await call('GET', '/api/v1/vdi-templates', { sub: d.sub })).body.data.find(
      (t: J) => t.id === SEED_IDS.vdiTemplate,
    ).items as J[];
    await call('POST', '/api/v1/vdis', {
      sub: d.sub,
      body: {
        clientSubmissionId: randomUUID(),
        vehicleId: v,
        templateId: SEED_IDS.vdiTemplate,
        shiftId: s.id,
        odometer: 1000,
        capturedAt: new Date().toISOString(),
        results: items.map((i) => ({ code: i.code, result: 'PASS' })),
      },
    });
    await call('POST', '/api/v1/cleaning-records', {
      sub: d.sub,
      body: {
        clientSubmissionId: randomUUID(),
        vehicleId: v,
        shiftId: s.id,
        type: 'PRE_SHIFT',
        capturedAt: new Date().toISOString(),
      },
    });
    expect(
      (await call('POST', `/api/v1/jobs/${j!.id}/allocate`, { body: { shiftId: s.id } })).status,
    ).toBe(201);

    const fail = await call('POST', '/api/v1/vdis', {
      sub: d.sub,
      body: {
        clientSubmissionId: randomUUID(),
        vehicleId: v,
        templateId: SEED_IDS.vdiTemplate,
        shiftId: s.id,
        odometer: 1010,
        capturedAt: new Date().toISOString(),
        results: items.map((i) => ({
          code: i.code,
          result: i.code === 'BRAKES' ? 'FAIL' : 'PASS',
          ...(i.code === 'BRAKES' ? { reason: 'Brake pedal spongy' } : {}),
        })),
      },
    });
    expect(fail.body.outcome).toBe('FAIL');
    const job = (await call('GET', `/api/v1/jobs/${j!.id}`)).body;
    expect(job).toMatchObject({ state: 'REASSIGNED', shiftId: null });
    const alerts = (await call('GET', '/api/v1/alerts', { sub: 'dev|manager' })).body.data as J[];
    const al = alerts.find((x) => x.sourceId === j!.id)!;
    expect(al).toMatchObject({ reasonCode: 'JOB_NEEDS_REASSIGNMENT', severity: 'CRITICAL' });
    expect(al.reasonText).not.toMatch(/Synthetic Patient/);
    expect(
      (await call('GET', '/api/v1/planner?date=' + londonDate(new Date()))).body.unallocated.some(
        (x: J) => x.id === j!.id,
      ),
    ).toBe(true);
    // Timing checks never downgrade the reassignment alert; cancelling closes it.
    const sweep = await jobTimingAll(db, new Date(Date.now() + 3 * H));
    expect(sweep.failed).toBe(0);
    const again = (
      (await call('GET', '/api/v1/alerts', { sub: 'dev|manager' })).body.data as J[]
    ).filter((x) => x.sourceId === j!.id);
    expect(again.map((x) => x.reasonCode)).toEqual(['JOB_NEEDS_REASSIGNMENT']);
    const cancel = await call('POST', `/api/v1/jobs/${j!.id}/status`, {
      body: {
        state: 'CANCELLED',
        reason: 'Journey no longer needed',
        clientSubmissionId: randomUUID(),
        capturedAt: new Date().toISOString(),
      },
    });
    expect(cancel.status).toBe(201);
    const after = (
      (await call('GET', '/api/v1/alerts', { sub: 'dev|manager' })).body.data as J[]
    ).filter((x) => x.sourceId === j!.id && x.state !== 'RESOLVED');
    expect(after).toHaveLength(0);
  });
});

describe('job lifecycle and crew access [JOB-04, UAT-05, UAT-06]', () => {
  it('offer, acknowledge and progress; retries are idempotent; other crew and patient contact are protected', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const s = await shift(await vehicle(), [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ]);
    const [j] = await book(2);
    await call('POST', `/api/v1/jobs/${j!.id}/allocate`, { body: { shiftId: s.id } });
    const offered = await call('POST', `/api/v1/jobs/${j!.id}/offer`);
    expect(offered.body.state).toBe('OFFERED');

    // Crew on the shift can read it, but never the patient contact; other crew get 404.
    const seen = await call('GET', `/api/v1/jobs/${j!.id}`, { sub: d.sub });
    expect(seen.status).toBe(200);
    expect(seen.body.patientContact).toBeNull();
    const outsider = await crewMember();
    expect((await call('GET', `/api/v1/jobs/${j!.id}`, { sub: outsider.sub })).status).toBe(404);
    expect(
      (await call('GET', '/api/v1/jobs?date=' + londonDate(new Date()), { sub: d.sub })).status,
    ).toBe(403);
    // Dispatch sees the contact, and that view is audited.
    expect((await call('GET', `/api/v1/jobs/${j!.id}`)).body.patientContact).toMatchObject({
      name: 'Synthetic Patient',
    });
    const log = (await call('GET', '/api/v1/audit-log?limit=100', { sub: 'dev|manager' })).body
      .data as J[];
    expect(log.some((x) => x.action === 'jobs.patient.view' && x.entityId === j!.id)).toBe(true);
    expect(JSON.stringify(log)).not.toContain('Synthetic Patient');

    const step = (state: string, id = randomUUID(), sub = d.sub, reason?: string) =>
      call('POST', `/api/v1/jobs/${j!.id}/status`, {
        sub,
        body: {
          state,
          capturedAt: new Date().toISOString(),
          clientSubmissionId: id,
          ...(reason ? { reason } : {}),
        },
      });
    const ackId = randomUUID();
    const [r1, r2, r3] = [
      await step('ACKNOWLEDGED', ackId),
      await step('ACKNOWLEDGED', ackId),
      await step('ACKNOWLEDGED', ackId),
    ];
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
    expect(r3.body.events.filter((e: J) => e.toState === 'ACKNOWLEDGED')).toHaveLength(1);
    expect((await step('COMPLETED')).body.code).toBe('TRANSITION_NOT_ALLOWED');
    expect((await step('CANCELLED', randomUUID(), d.sub, 'Not wanted')).body.code).toBe(
      'TRANSITION_NOT_ALLOWED',
    ); // crew cannot cancel
    for (const st of [
      'EN_ROUTE',
      'ARRIVED',
      'PATIENT_ON_BOARD',
      'AT_DESTINATION',
      'HANDOVER_COMPLETE',
      'COMPLETED',
    ])
      expect((await step(st)).status).toBe(201);
    const done = (await call('GET', `/api/v1/jobs/${j!.id}`)).body;
    expect(done.state).toBe('COMPLETED');
    expect(done.events.map((e: J) => e.toState)).toEqual([
      'BOOKED',
      'ALLOCATED',
      'OFFERED',
      'ACKNOWLEDGED',
      'EN_ROUTE',
      'ARRIVED',
      'PATIENT_ON_BOARD',
      'AT_DESTINATION',
      'HANDOVER_COMPLETE',
      'COMPLETED',
    ]);
    expect(done.events.every((e: J) => e.capturedAt && e.receivedAt)).toBe(true);
  });

  it('control is alerted to unacknowledged offers and late jobs (job code only)', async () => {
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const s = await shift(await vehicle(), [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ]);
    const [j] = await book(1.5);
    await call('POST', `/api/v1/jobs/${j!.id}/allocate`, { body: { shiftId: s.id } });
    await call('POST', `/api/v1/jobs/${j!.id}/offer`);
    const later = new Date(Date.now() + 2 * H);
    const n = await db.withTenant(
      { orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' },
      (tx) => jobTimingAlerts(tx, ORG, later),
    );
    expect(n).toBeGreaterThanOrEqual(1);
    const alerts = (
      (await call('GET', '/api/v1/alerts', { sub: 'dev|manager' })).body.data as J[]
    ).filter((x) => x.sourceId === j!.id);
    // One live alert per job, carrying the most serious reason (late beats unacknowledged).
    expect(alerts.map((x) => x.reasonCode)).toEqual(['JOB_LATE']);
    expect(alerts.every((x) => x.reasonText.startsWith(j!.code))).toBe(true);
  });
});

describe('recurring journeys [UAT-07]', () => {
  it('cancelling one instance or editing "this and following" changes only the intended instances', async () => {
    const start = new Date(Date.now() + 48 * H);
    const day = londonDate(start);
    const jobs = await book(48, {}, { freq: 'DAILY', interval: 1, until: addDays(day, 3) });
    expect(jobs).toHaveLength(4);
    expect(jobs.map((x) => x.seriesIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(jobs.map((x) => x.code)).size).toBe(4);
    const cancel = await call('POST', `/api/v1/jobs/${jobs[1]!.id}/status`, {
      body: {
        state: 'CANCELLED',
        capturedAt: new Date().toISOString(),
        clientSubmissionId: randomUUID(),
        reason: 'Appointment moved',
      },
    });
    expect(cancel.body.state).toBe('CANCELLED');
    const only = await call('PATCH', `/api/v1/jobs/${jobs[3]!.id}?scope=this`, {
      body: { accessNotes: 'Use side entrance' },
      ifMatch: jobs[3]!.version,
    });
    expect(only.body.data).toHaveLength(1);
    expect(only.body.data[0].detached).toBe(true);
    const following = await call('PATCH', `/api/v1/jobs/${jobs[0]!.id}?scope=following`, {
      body: { timeShiftMinutes: 30 },
      ifMatch: jobs[0]!.version,
    });
    // Instance 1 is cancelled and instance 3 was edited on its own: only 0 and 2 move.
    expect(following.body.data.map((x: J) => x.seriesIndex)).toEqual([0, 2]);
    const after = (await call('GET', '/api/v1/bookings')).body.data.find((b: J) =>
      b.jobs.some((x: J) => x.id === jobs[0]!.id),
    ).jobs as J[];
    const shiftOf = (i: number) =>
      new Date(after[i]!.plannedStart).getTime() - new Date(jobs[i]!.plannedStart).getTime();
    expect([shiftOf(0), shiftOf(1), shiftOf(2), shiftOf(3)]).toEqual([
      30 * 60_000,
      0,
      30 * 60_000,
      0,
    ]);
    expect(
      (
        await call('PATCH', `/api/v1/jobs/${jobs[0]!.id}?scope=following`, {
          body: { plannedStart: at(50) },
          ifMatch: following.body.data[0].version,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/api/v1/jobs/${jobs[0]!.id}`, {
          body: { accessNotes: 'stale' },
          ifMatch: jobs[0]!.version,
        })
      ).status,
    ).toBe(409);
  });

  it('bookings never take a patient name as the reference', async () => {
    const r = await call('POST', '/api/v1/bookings', {
      body: {
        customer: 'Synthetic Trust',
        job: {
          locationId: SEED_IDS.locWatford,
          pickupFrom: at(5),
          pickupTo: at(5.5),
          plannedStart: at(5),
          plannedEnd: at(6),
          pickupAddress: 'a b c',
          destinationAddress: 'd e f',
          patientRef: 'Jane Doe',
          mobility: 'WALKING',
        },
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('exception requests and decisions [E3]', () => {
  async function competenceGap(startH: number) {
    const v = await vehicle();
    const d = await crewMember();
    const a = await crewMember(['CARE_ASSISTANT']);
    const s = await shift(
      v,
      [
        { staffId: d.staffId, role: 'DRIVER' },
        { staffId: a.staffId, role: 'CARE_ASSISTANT' },
      ],
      startH,
      startH + 8,
    );
    const [job] = await book(startH + 1, { requiredSkills: ['BARIATRIC'] });
    return { jobId: job!.id as string, shiftId: s.id as string };
  }
  const ask = (g: { jobId: string; shiftId: string }, approverId: string) => ({
    ...g,
    checkCode: 'COMPETENCE',
    reason: 'Bariatric-trained supervisor attending',
    expiresAt: at(30 + 24),
    approverId,
  });

  it('only someone else who can approve exceptions may be named as the approver', async () => {
    const g = await competenceGap(30);
    const dispatcher = await idOf('dev|dispatcher');
    const crew = await idOf('dev|crew');
    expect(
      (await call('POST', '/api/v1/allocation-exceptions', { body: ask(g, dispatcher) })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/v1/allocation-exceptions', { body: ask(g, crew) })).status,
    ).toBe(400);
    const approvers = (await call('GET', '/api/v1/allocation-exceptions/approvers')).body
      .data as J[];
    expect(approvers.map((p) => p.name)).toContain('Manager');
    expect(approvers.map((p) => p.id)).not.toContain(dispatcher);
  });

  it('the approver is asked, declines with a reason, and it goes back to the dispatcher', async () => {
    const g = await competenceGap(40);
    const manager = await idOf('dev|manager');
    const req = await call('POST', '/api/v1/allocation-exceptions', { body: ask(g, manager) });
    expect(req.status).toBe(201);
    const asked = (await call('GET', '/api/v1/me/inbox', { sub: 'dev|manager' })).body.data as J[];
    expect(asked).toContainEqual(
      expect.objectContaining({
        kind: 'EXCEPTION_REQUEST',
        link: expect.objectContaining({ type: 'JOB', id: g.jobId }),
      }),
    );
    // Only the named approver decides.
    const decideUrl = `/api/v1/allocation-exceptions/${req.body.id}/decide`;
    expect(
      (await call('POST', decideUrl, { body: { decision: 'APPROVED', reason: 'Fine by me' } }))
        .status,
    ).toBe(403);
    const no = await call('POST', decideUrl, {
      sub: 'dev|manager',
      body: { decision: 'DECLINED', reason: 'No bariatric supervisor is free that day' },
    });
    expect([no.status, no.body.state]).toEqual([201, 'DECLINED']);
    const back = (await call('GET', '/api/v1/me/inbox')).body.data as J[];
    expect(back).toContainEqual(
      expect.objectContaining({
        kind: 'EXCEPTION_DECLINED',
        reasonText: expect.stringContaining('No bariatric supervisor is free that day'),
      }),
    );
    const stillAsked = (await call('GET', '/api/v1/me/inbox', { sub: 'dev|manager' })).body
      .data as J[];
    expect(
      stillAsked.filter((i) => i.kind === 'EXCEPTION_REQUEST' && i.link.id === g.jobId),
    ).toEqual([]);
    expect(
      (
        await call('POST', decideUrl, {
          sub: 'dev|manager',
          body: { decision: 'APPROVED', reason: 'Changed my mind' },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('POST', `/api/v1/jobs/${g.jobId}/allocate`, { body: { shiftId: g.shiftId } }))
        .status,
    ).toBe(409);
  });
});
