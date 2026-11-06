import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
const today = () => londonDate(new Date());

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Opts {
  sub?: string;
  org?: string;
  body?: unknown;
  ifMatch?: number;
}
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, o: Opts = {}) {
  const token = await sign({ sub: o.sub ?? 'dev|fleet' });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-org-id': o.org ?? ORG,
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  let parsed: J;
  try {
    parsed = res.body ? (JSON.parse(res.body) as J) : {};
  } catch {
    parsed = { raw: res.body };
  }
  return { status: res.statusCode, body: parsed, headers: res.headers, text: res.body };
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

let n = 10;
async function vehicle(extra: Record<string, unknown> = {}): Promise<J> {
  n += 1;
  const r = await call('POST', '/api/v1/vehicles', {
    body: {
      registration: `AB${n}CDE`,
      callsign: `AMB-${n}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
      stretcher: true,
      ...extra,
    },
  });
  expect(r.status).toBe(201);
  return r.body;
}
let template: J;
async function vdiTemplate(): Promise<J> {
  if (template) return template;
  const r = await call('POST', '/api/v1/vdi-templates', {
    body: {
      name: `Daily inspection ${randomUUID().slice(0, 6)}`,
      items: [
        { code: 'TYRES', label: 'Tyres', critical: true },
        { code: 'RAMP', label: 'Ramp / lift', critical: true },
        { code: 'WIPERS', label: 'Wipers', critical: false },
      ],
    },
  });
  expect(r.status).toBe(201);
  // D6: a draft is published by someone other than the person who drafted it.
  const p = await call('POST', `/api/v1/vdi-templates/${r.body.id}/publish`, {
    sub: 'dev|manager',
  });
  expect(p.status).toBe(201);
  template = p.body;
  return template;
}
async function submitVdi(
  vehicleId: string,
  results: Record<string, [string, string?]>,
  extra: Record<string, unknown> = {},
) {
  const t = await vdiTemplate();
  return call('POST', '/api/v1/vdis', {
    sub: 'dev|crew',
    body: {
      clientSubmissionId: randomUUID(),
      vehicleId,
      templateId: t.id,
      odometer: 10_000,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      results: Object.entries(results).map(([code, [result, reason]]) => ({
        code,
        result,
        ...(reason ? { reason } : {}),
      })),
      ...extra,
    },
  });
}
const ALL_PASS: Record<string, [string]> = { TYRES: ['PASS'], RAMP: ['PASS'], WIPERS: ['PASS'] };
const window = () => {
  const from = new Date(Date.now() + 3_600_000);
  return `from=${from.toISOString()}&to=${new Date(from.getTime() + 4 * 3_600_000).toISOString()}`;
};

describe('vehicle register [FLT-01]', () => {
  it('creates vehicles with normalised registration, unique callsigns and a location history', async () => {
    const v = await vehicle({ registration: 'ab 99 xyz' });
    expect(v).toMatchObject({ registration: 'AB99XYZ', status: 'AVAILABLE', openDefects: 0 });
    expect(
      (
        await call('POST', '/api/v1/vehicles', {
          body: {
            registration: 'ZZ1',
            callsign: v.callsign,
            type: 'CAR',
            baseLocationId: SEED_IDS.locWatford,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/vehicles', {
          sub: 'dev|crew',
          body: {
            registration: 'ZZ1',
            callsign: 'X-1',
            type: 'CAR',
            baseLocationId: SEED_IDS.locWatford,
          },
        })
      ).status,
    ).toBe(403);
    const loc = await call('POST', `/api/v1/organisations/${ORG}/locations`, {
      sub: 'dev|admin',
      body: { name: `Hemel ${n}` },
    });
    const moved = await call('POST', `/api/v1/vehicles/${v.id}/move`, {
      body: { locationId: loc.body.id, reason: 'Covering Hemel' },
    });
    expect(moved.body.baseLocationId).toBe(loc.body.id);
    const detail = (await call('GET', `/api/v1/vehicles/${v.id}`)).body;
    expect(detail.locations.map((l: J) => l.reason)).toEqual(['Covering Hemel', 'Vehicle added']);
    expect(
      (
        await call('GET', `/api/v1/vehicles/${v.id}`, {
          sub: 'dev|other-manager',
          org: SEED_IDS.orgOther,
        })
      ).status,
    ).toBe(404);
    expect((await call('GET', '/api/v1/vehicles', { sub: 'dev|dispatcher' })).status).toBe(200);
  });

  it('auto-applies published vehicle requirements (MOT, insurance) and an expired MOT blocks readiness [UAT-02d]', async () => {
    const c = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `MOT-${randomUUID().slice(0, 6).toUpperCase()}`,
        title: 'MOT',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'VEHICLE',
          recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
          blocking: 'STATUTORY',
          deadlineKind: 'EXPIRY',
          applicabilityRule: { autoApply: true, types: ['AMBULANCE'] },
        },
      },
    });
    await call(
      'POST',
      `/api/v1/requirements/templates/${c.body.id}/versions/${c.body.versions[0].id}/publish`,
      { sub: 'dev|manager' },
    );
    const v = await vehicle({ type: 'AMBULANCE' });
    const car = await vehicle({ type: 'CAR' });
    const items = (await call('GET', `/api/v1/requirements/instances?subjectId=${v.id}`)).body
      .data as J[];
    expect(items.map((i) => i.templateId)).toContain(c.body.id);
    expect(
      (
        (await call('GET', `/api/v1/requirements/instances?subjectId=${car.id}`)).body.data as J[]
      ).map((i) => i.templateId),
    ).not.toContain(c.body.id);
    const r = (
      await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}`, { sub: 'dev|dispatcher' })
    ).body;
    expect(r.state).toBe('BLOCKED');
    const mot = r.checks.find((x: J) => x.requirementInstanceId);
    expect(mot).toMatchObject({ result: 'FAIL', overridable: false });
  });
});

describe('odometer and maintenance [FLT-02, T12, T13]', () => {
  it('flags decreasing readings without moving the current odometer', async () => {
    const v = await vehicle();
    expect(
      (
        await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
          body: { reading: 50_000, readOn: addDays(today(), -2) },
        })
      ).body.flags,
    ).toEqual([]);
    const down = await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      body: { reading: 49_000, readOn: today() },
    });
    expect(down.body.flags).toContain('ODOMETER_DECREASED');
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.currentOdometer).toBe(50_000);
    expect(
      (
        await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
          body: { reading: 1, readOn: addDays(today(), 1) },
        })
      ).status,
    ).toBe(400);
  });

  it('maintenance is due by date OR mileage, whichever first, and blocks readiness when overdue', async () => {
    const v = await vehicle();
    await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      body: { reading: 20_000, readOn: addDays(today(), -20) },
    });
    const plan = await call('POST', `/api/v1/vehicles/${v.id}/maintenance`, {
      body: {
        title: 'Service',
        intervalDays: 365,
        intervalMiles: 10_000,
        lastDoneOn: addDays(today(), -30),
        lastDoneOdometer: 15_000,
      },
    });
    expect(plan.body).toMatchObject({ state: 'OK', dueOdometer: 25_000 });
    await call('POST', `/api/v1/vehicles/${v.id}/odometer`, {
      body: { reading: 25_200, readOn: today() },
    });
    const over = (await call('GET', `/api/v1/vehicles/${v.id}/maintenance`)).body.data[0];
    expect(over).toMatchObject({ state: 'OVERDUE', by: 'MILEAGE' });
    expect((await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}`)).body.state).toBe(
      'BLOCKED',
    );
    const done = await call('POST', `/api/v1/vehicles/${v.id}/maintenance/${plan.body.id}/done`, {
      body: { doneOn: today(), odometer: 25_300 },
    });
    expect(done.body).toMatchObject({ state: 'OK', dueOdometer: 35_300 });
    expect((await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}`)).body.state).toBe(
      'READY',
    );
    expect(
      (
        await call('POST', `/api/v1/vehicles/${v.id}/maintenance`, {
          body: { title: 'No interval' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('VDI and cleaning [FLT-04, FLT-05, UAT-03, UAT-06]', () => {
  it('the same submission three times creates exactly one record, storing captured and received times', async () => {
    const v = await vehicle();
    const t = await vdiTemplate();
    const payload = {
      clientSubmissionId: randomUUID(),
      vehicleId: v.id,
      templateId: t.id,
      odometer: 12_000,
      capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
      results: [
        { code: 'TYRES', result: 'PASS' },
        { code: 'RAMP', result: 'PASS' },
        { code: 'WIPERS', result: 'NA', reason: 'Not fitted' },
      ],
    };
    const a = await call('POST', '/api/v1/vdis', { sub: 'dev|crew', body: payload });
    const b = await call('POST', '/api/v1/vdis', { sub: 'dev|crew', body: payload });
    const c = await call('POST', '/api/v1/vdis', { sub: 'dev|crew', body: payload });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect([a.body.duplicate, b.body.duplicate, c.body.duplicate]).toEqual([false, true, true]);
    expect(a.body.capturedAt).toBe(payload.capturedAt);
    expect(new Date(a.body.receivedAt).getTime()).toBeGreaterThan(
      new Date(a.body.capturedAt).getTime(),
    );
    const list = (await call('GET', `/api/v1/vdis?vehicleId=${v.id}`)).body.data as J[];
    expect(list).toHaveLength(1);
    // Someone else reusing the id is refused
    expect((await call('POST', '/api/v1/vdis', { sub: 'dev|crew2', body: payload })).status).toBe(
      409,
    );
  });

  it('validates completeness and reasons, and refuses future or stale captures', async () => {
    const v = await vehicle();
    expect((await submitVdi(v.id, { TYRES: ['PASS'], RAMP: ['PASS'] })).status).toBe(400);
    expect((await submitVdi(v.id, { ...ALL_PASS, BRAKES: ['PASS'] })).status).toBe(400);
    expect((await submitVdi(v.id, { ...ALL_PASS, WIPERS: ['FAIL'] })).status).toBe(400);
    expect(
      (
        await submitVdi(v.id, ALL_PASS, {
          capturedAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await submitVdi(v.id, ALL_PASS, {
          capturedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect((await submitVdi(randomUUID(), ALL_PASS)).status).toBe(404);
  });

  it('a failed critical item blocks the vehicle at once with a stop-use defect and a control alert; amending it does not release', async () => {
    const v = await vehicle();
    const r = await submitVdi(v.id, {
      TYRES: ['PASS'],
      RAMP: ['FAIL', 'Ramp will not deploy'],
      WIPERS: ['PASS'],
    });
    expect(r.body).toMatchObject({ outcome: 'FAIL' });
    expect(r.body.defectIds).toHaveLength(1);
    const vv = (await call('GET', `/api/v1/vehicles/${v.id}`, { sub: 'dev|dispatcher' })).body;
    expect(vv).toMatchObject({ status: 'BLOCKED', openDefects: 1 });
    const d = (await call('GET', `/api/v1/defects/${r.body.defectIds[0]}`)).body;
    expect(d).toMatchObject({
      severity: 'CRITICAL',
      stopUse: true,
      sourceVdiId: r.body.id,
      status: 'OPEN',
    });
    const alerts = (await call('GET', '/api/v1/alerts', { sub: 'dev|manager' })).body.data as J[];
    expect(alerts.find((a) => a.sourceId === d.id)).toMatchObject({
      severity: 'CRITICAL',
      reasonCode: 'VEHICLE_BLOCKED',
    });
    expect(
      (await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}`)).body.checks.find(
        (c: J) => c.code === 'CRITICAL_DEFECT',
      ),
    ).toMatchObject({ result: 'FAIL', overridable: false });

    const amend = await call('POST', `/api/v1/vdis/${r.body.id}/amendments`, {
      sub: 'dev|crew',
      body: { code: 'RAMP', newResult: 'PASS', reason: 'Re-tested after reset' },
    });
    expect(amend.body.results.find((x: J) => x.code === 'RAMP')).toMatchObject({
      result: 'PASS',
      amended: true,
    });
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('BLOCKED');
    // crew cannot read or amend someone else's VDI
    expect((await call('GET', `/api/v1/vdis/${r.body.id}`, { sub: 'dev|crew2' })).status).toBe(404);
  });

  it('a failed non-critical item creates a minor defect that does not block', async () => {
    const v = await vehicle();
    const r = await submitVdi(v.id, {
      TYRES: ['PASS'],
      RAMP: ['PASS'],
      WIPERS: ['FAIL', 'Blade split'],
    });
    expect(r.body.defectIds).toHaveLength(1);
    expect((await call('GET', `/api/v1/defects/${r.body.defectIds[0]}`)).body).toMatchObject({
      severity: 'MINOR',
      stopUse: false,
    });
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('AVAILABLE');
  });

  it('cleaning records are idempotent and immutable', async () => {
    const v = await vehicle();
    const body = {
      clientSubmissionId: randomUUID(),
      vehicleId: v.id,
      type: 'PRE_SHIFT',
      capturedAt: new Date().toISOString(),
    };
    const a = await call('POST', '/api/v1/cleaning-records', { sub: 'dev|crew', body });
    const b = await call('POST', '/api/v1/cleaning-records', { sub: 'dev|crew', body });
    expect(a.body.id).toBe(b.body.id);
    expect(b.body.duplicate).toBe(true);
    expect(
      ((await call('GET', `/api/v1/cleaning-records?vehicleId=${v.id}`)).body.data as J[]).length,
    ).toBe(1);
  });

  it('publishing a new checklist version retires the old one', async () => {
    const name = `Checklist ${randomUUID().slice(0, 6)}`;
    const v1 = await call('POST', '/api/v1/vdi-templates', {
      body: { name, items: [{ code: 'A1', label: 'Lights' }] },
    });
    expect(v1.body).toMatchObject({ status: 'DRAFT', active: false });
    // D6: the drafter cannot publish their own checklist.
    const self = await call('POST', `/api/v1/vdi-templates/${v1.body.id}/publish`);
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL']);
    const publish = (id: string) =>
      call('POST', `/api/v1/vdi-templates/${id}/publish`, { sub: 'dev|manager' });
    expect((await publish(v1.body.id)).body).toMatchObject({ status: 'PUBLISHED', active: true });
    const v2 = await call('POST', '/api/v1/vdi-templates', {
      body: {
        name,
        items: [
          { code: 'A1', label: 'Lights' },
          { code: 'A2', label: 'Horn' },
        ],
      },
    });
    expect([v1.body.version, v2.body.version]).toEqual([1, 2]);
    // Crews see only published versions: the draft v2 is not offered yet.
    const before = (await call('GET', '/api/v1/vdi-templates', { sub: 'dev|crew' })).body
      .data as J[];
    expect(before.filter((t) => t.name === name).map((t) => t.version)).toEqual([1]);
    const published = await publish(v2.body.id);
    expect(published.body.publishedByName).toBeTruthy();
    const active = (await call('GET', '/api/v1/vdi-templates', { sub: 'dev|crew' })).body
      .data as J[];
    expect(active.filter((t) => t.name === name).map((t) => t.version)).toEqual([2]);
    const all = (await call('GET', '/api/v1/vdi-templates?all=true')).body.data as J[];
    expect(all.filter((t) => t.name === name).map((t) => [t.version, t.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'RETIRED'],
    ]);
    const v = await vehicle();
    const stale = await call('POST', '/api/v1/vdis', {
      sub: 'dev|crew',
      body: {
        clientSubmissionId: randomUUID(),
        vehicleId: v.id,
        templateId: v1.body.id,
        odometer: 1,
        capturedAt: new Date().toISOString(),
        results: [{ code: 'A1', result: 'PASS' }],
      },
    });
    expect(stale.status).toBe(409);
  });
});

describe('defects and return to service [FLT-06, UAT-02c]', () => {
  it('repair is not release; release needs the permission, a different person, and is final', async () => {
    const v = await vehicle();
    const d = await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, severity: 'CRITICAL', description: 'Ramp hinge cracked' },
    });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ stopUse: true, status: 'OPEN', affectedAllocationIds: [] });
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('BLOCKED');

    expect(
      (
        await call('POST', `/api/v1/defects/${d.body.id}/release`, {
          sub: 'dev|crew',
          body: { reason: 'Looks fine' },
        })
      ).status,
    ).toBe(403);
    const notRepaired = await call('POST', `/api/v1/defects/${d.body.id}/release`, {
      body: { reason: 'Looks fine' },
    });
    expect([notRepaired.status, notRepaired.body.code]).toEqual([422, 'OVERRIDE_NOT_PERMITTED']);
    const down = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { severity: 'MINOR' },
      ifMatch: d.body.version,
    });
    expect(down.body.code).toBe('OVERRIDE_NOT_PERMITTED');
    const repaired = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { status: 'REPAIRED', repairNotes: 'Hinge replaced' },
      ifMatch: d.body.version,
    });
    expect(repaired.body.status).toBe('REPAIRED');
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('BLOCKED'); // repaired != released
    const self = await call('POST', `/api/v1/defects/${d.body.id}/release`, {
      body: { reason: 'Signed off' },
    });
    expect([self.status, self.body.code]).toEqual([422, 'SELF_APPROVAL']);

    const rel = await call('POST', `/api/v1/defects/${d.body.id}/release`, {
      sub: 'dev|manager',
      body: { reason: 'Inspected after repair, safe to use' },
    });
    expect(rel.status).toBe(201);
    expect(rel.body.release).toMatchObject({ reason: 'Inspected after repair, safe to use' });
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('AVAILABLE');
    expect(
      (
        await call('POST', `/api/v1/defects/${d.body.id}/release`, {
          sub: 'dev|manager',
          body: { reason: 'Again please' },
        })
      ).status,
    ).toBe(409);
    const alerts = (await call('GET', '/api/v1/alerts?state=RESOLVED', { sub: 'dev|manager' })).body
      .data as J[];
    expect(alerts.some((a) => a.sourceId === d.body.id)).toBe(true);
  });

  it('a vehicle stays blocked until every stop-use defect is released', async () => {
    const v = await vehicle();
    const one = await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: {
        vehicleId: v.id,
        severity: 'MAJOR',
        stopUse: true,
        description: 'Brake warning light',
      },
    });
    await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, severity: 'CRITICAL', description: 'Seat belt anchor loose' },
    });
    await call('PATCH', `/api/v1/defects/${one.body.id}`, {
      body: { status: 'REPAIRED', repairNotes: 'Brake sensor replaced' },
      ifMatch: one.body.version,
    });
    await call('POST', `/api/v1/defects/${one.body.id}/release`, {
      sub: 'dev|manager',
      body: { reason: 'Sensor replaced' },
    });
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body).toMatchObject({
      status: 'BLOCKED',
      statusReason: '1 open stop-use defect',
    });
  });

  it('sign-off needs repair notes, locks the record, and a checker can send it back [task 7]', async () => {
    const v = await vehicle();
    const d = await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, severity: 'CRITICAL', description: 'Rear step loose' },
    });
    expect(d.body).toMatchObject({
      subjectLabel: v.callsign,
      reportedByName: expect.any(String),
      repairDue: 'NONE',
      repairedBy: null,
    });

    const noNotes = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { status: 'REPAIRED' },
      ifMatch: d.body.version,
    });
    expect([noNotes.status, noNotes.body.code]).toEqual([400, 'VALIDATION_FAILED']);

    const started = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { status: 'REPAIRING', repairNotes: 'Booked in with workshop' },
      ifMatch: d.body.version,
    });
    expect(started.body.status).toBe('REPAIRING');
    const signed = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { status: 'REPAIRED', repairNotes: 'Step bolts replaced and torqued' },
      ifMatch: started.body.version,
    });
    expect(signed.body).toMatchObject({
      status: 'REPAIRED',
      repairedBy: expect.any(String),
      repairedByName: expect.any(String),
      repairDue: 'DONE',
    });
    expect(signed.body.repairNotes).toContain('Booked in with workshop');
    expect(signed.body.repairNotes).toContain('Step bolts replaced and torqued');

    const edit = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { repairNotes: 'Changed my mind' },
      ifMatch: signed.body.version,
    });
    expect(edit.status).toBe(409);

    expect(
      (
        await call('POST', `/api/v1/defects/${d.body.id}/reopen`, {
          sub: 'dev|crew',
          body: { reason: 'Not fixed' },
        })
      ).status,
    ).toBe(403);
    const back = await call('POST', `/api/v1/defects/${d.body.id}/reopen`, {
      sub: 'dev|manager',
      body: { reason: 'Step still moves under load' },
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ status: 'REPAIRING', repairedBy: null, repairedAt: null });
    expect(back.body.repairNotes).toContain('Step bolts replaced and torqued');
    expect(back.body.repairNotes).toContain('Sent back for repair');
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.status).toBe('BLOCKED');
    expect(
      (
        await call('POST', `/api/v1/defects/${d.body.id}/reopen`, {
          sub: 'dev|manager',
          body: { reason: 'Again' },
        })
      ).status,
    ).toBe(409);

    const again = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { status: 'REPAIRED', repairNotes: 'Bracket welded' },
      ifMatch: back.body.version,
    });
    const rel = await call('POST', `/api/v1/defects/${d.body.id}/release`, {
      sub: 'dev|manager',
      body: { reason: 'Load-tested the step' },
    });
    expect(again.body.status).toBe('REPAIRED');
    expect(rel.body.release).toMatchObject({
      releasedByName: expect.any(String),
      evidenceItemId: null,
    });
    const released = (await call('GET', `/api/v1/defects?status=RELEASED&vehicleId=${v.id}`)).body
      .data as J[];
    expect(released.map((x) => x.id)).toEqual([d.body.id]);
    const active = (await call('GET', `/api/v1/defects?vehicleId=${v.id}`)).body.data as J[];
    expect(active).toEqual([]);
  });

  it('a minor defect shows where it stands against its repair deadline', async () => {
    const v = await vehicle();
    const d = await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, severity: 'MINOR', description: 'Glove box catch broken' },
    });
    const late = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { severity: 'MINOR', repairDeadline: addDays(today(), -1) },
      ifMatch: d.body.version,
    });
    expect(late.body).toMatchObject({ repairDue: 'OVERDUE', classifiedByName: expect.any(String) });
    const soon = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { repairDeadline: addDays(today(), 3) },
      ifMatch: late.body.version,
    });
    expect(soon.body.repairDue).toBe('DUE_SOON');
  });

  it('crew can report but only see their own reports; minor defects need a repair deadline when classified', async () => {
    const v = await vehicle();
    const d = await call('POST', '/api/v1/defects', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, severity: 'MINOR', description: 'Interior light flickers' },
    });
    expect((await call('GET', `/api/v1/defects/${d.body.id}`, { sub: 'dev|crew' })).status).toBe(
      200,
    );
    expect((await call('GET', `/api/v1/defects/${d.body.id}`, { sub: 'dev|crew2' })).status).toBe(
      404,
    );
    expect((await call('GET', '/api/v1/defects', { sub: 'dev|crew' })).status).toBe(403);
    expect(
      (
        await call('PATCH', `/api/v1/defects/${d.body.id}`, {
          body: { severity: 'MINOR' },
          ifMatch: d.body.version,
        })
      ).status,
    ).toBe(400);
    const ok = await call('PATCH', `/api/v1/defects/${d.body.id}`, {
      body: { severity: 'MINOR', repairDeadline: addDays(today(), 14) },
      ifMatch: d.body.version,
    });
    expect(ok.body).toMatchObject({
      classifiedBy: expect.any(String),
      repairDeadline: addDays(today(), 14),
    });
    expect(
      (
        await call('POST', '/api/v1/defects', {
          sub: 'dev|crew',
          body: { severity: 'MINOR', description: 'No subject' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('equipment, regimes and capability [FLT-03, FLT-08]', () => {
  it('quarantining a fitted stretcher removes the vehicle stretcher capability', async () => {
    const v = await vehicle();
    const a = await call('POST', '/api/v1/equipment', {
      body: {
        assetTag: `STR-${n}`,
        category: 'stretcher',
        swlKg: 227,
        vehicleId: v.id,
        capability: 'STRETCHER',
      },
    });
    expect(a.status).toBe(201);
    expect(a.body.category).toBe('STRETCHER');
    expect(
      (await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}&stretcher=true`)).body
        .state,
    ).toBe('READY');
    const q = await call('POST', `/api/v1/equipment/${a.body.id}/quarantine`, {
      body: { reason: 'Failed pre-use check' },
    });
    expect(q.body.status).toBe('QUARANTINED');
    const r = (await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}&stretcher=true`))
      .body;
    expect(r.state).toBe('BLOCKED');
    expect(r.checks.find((c: J) => c.code === 'STRETCHER')).toMatchObject({
      result: 'FAIL',
      reasonText: expect.stringContaining('quarantined'),
    });
    expect((await call('GET', `/api/v1/vehicles/${v.id}/readiness?${window()}`)).body.state).toBe(
      'READY',
    ); // job not needing a stretcher
    // D3: release needs evidence and someone other than the person who quarantined it.
    const upload = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|manager',
      body: {
        title: 'Stretcher re-test record',
        mime: 'application/pdf',
        sizeBytes: 1000,
        requirementInstanceIds: [],
      },
    });
    const evidenceItemId = upload.body.evidenceItemId as string;
    expect(
      (
        await call('POST', `/api/v1/equipment/${a.body.id}/release`, {
          sub: 'dev|hr',
          body: { reason: 'Fixed', evidenceItemId },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/equipment/${a.body.id}/release`, {
          sub: 'dev|manager',
          body: { reason: 'Re-tested and passed' },
        })
      ).status,
    ).toBe(400);
    const self = await call('POST', `/api/v1/equipment/${a.body.id}/release`, {
      body: { reason: 'Re-tested and passed', evidenceItemId },
    });
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL']);
    const released = await call('POST', `/api/v1/equipment/${a.body.id}/release`, {
      sub: 'dev|manager',
      body: { reason: 'Re-tested and passed', evidenceItemId },
    });
    expect(released.body.status).toBe('AVAILABLE');
    expect(released.body.quarantinedBy).toBeNull();
  });

  it('LOLER and servicing are separate schedules on one asset', async () => {
    const mk = async (code: string) => {
      const c = await call('POST', '/api/v1/requirements/templates', {
        sub: 'dev|admin',
        body: {
          code: `${code}-${randomUUID().slice(0, 6).toUpperCase()}`,
          title: code,
          version: {
            basisType: 'STATUTORY',
            subjectType: 'EQUIPMENT',
            recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 6 } },
            blocking: 'SAFETY_CRITICAL',
            deadlineKind: 'DUE',
          },
        },
      });
      await call(
        'POST',
        `/api/v1/requirements/templates/${c.body.id}/versions/${c.body.versions[0].id}/publish`,
        { sub: 'dev|manager' },
      );
      return c.body.id as string;
    };
    const loler = await mk('LOLER');
    const service = await mk('SERVICE');
    const a = await call('POST', '/api/v1/equipment', {
      body: { assetTag: `HOIST-${n}`, category: 'HOIST', swlKg: 180 },
    });
    const one = await call('POST', `/api/v1/equipment/${a.body.id}/regimes`, {
      body: { regime: 'LOLER_THOROUGH', templateId: loler, source: 'LOLER 1998 reg 9' },
    });
    const two = await call('POST', `/api/v1/equipment/${a.body.id}/regimes`, {
      body: { regime: 'SERVICE', templateId: service },
    });
    expect(two.body.regimes.map((r: J) => r.regime).sort()).toEqual(['LOLER_THOROUGH', 'SERVICE']);
    expect(new Set(two.body.regimes.map((r: J) => r.requirementInstanceId)).size).toBe(2);
    expect(one.body.regimes[0].status).toBe('GREY');
    expect(
      (
        await call('POST', `/api/v1/equipment/${a.body.id}/regimes`, {
          body: { regime: 'CALIBRATION', templateId: loler },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('GET', `/api/v1/equipment/${a.body.id}/readiness?${window()}`)).body.state,
    ).toBe('BLOCKED');
  });
});

describe('fuel and expenses [FLT-07]', () => {
  it('flags duplicates, needs a different approver, and exports injection-safe CSV', async () => {
    const v = await vehicle();
    const e = {
      vehicleId: v.id,
      spentOn: today(),
      category: 'FUEL',
      quantity: 40.5,
      unit: 'LITRES',
      amountPence: 6210,
      supplier: '=HYPERLINK("x")',
      odometer: 30_000,
    };
    const a = await call('POST', '/api/v1/fuel-expenses', { sub: 'dev|crew', body: e });
    const b = await call('POST', '/api/v1/fuel-expenses', { sub: 'dev|crew', body: e });
    expect(a.body.duplicateOf).toBeNull();
    expect(b.body.duplicateOf).toBe(a.body.id);
    expect(
      (await call('GET', '/api/v1/fuel-expenses', { sub: 'dev|crew2' })).body.data.some(
        (x: J) => x.id === a.body.id,
      ),
    ).toBe(false);
    expect(
      (
        await call('POST', `/api/v1/fuel-expenses/${a.body.id}/approve`, {
          sub: 'dev|crew',
          body: { decision: 'APPROVED' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/fuel-expenses/${a.body.id}/approve`, {
          body: { decision: 'APPROVED' },
        })
      ).body.status,
    ).toBe('APPROVED');
    expect(
      (
        await call('POST', `/api/v1/fuel-expenses/${a.body.id}/approve`, {
          body: { decision: 'REJECTED', note: 'Duplicate claim' },
        })
      ).status,
    ).toBe(409);
    // A rejection needs a reason; the register carries names [task 15]
    expect(
      (
        await call('POST', `/api/v1/fuel-expenses/${b.body.id}/approve`, {
          body: { decision: 'REJECTED' },
        })
      ).status,
    ).toBe(400);
    const listed = (await call('GET', '/api/v1/fuel-expenses')).body.data.find(
      (x: J) => x.id === a.body.id,
    );
    expect(listed.submittedByName).toBe('Alex Morgan');
    expect(listed.decidedByName).toBe('Finn Lee'); // approved as dev|fleet (the default caller)
    expect(listed.vehicleLabel).toContain(v.callsign);
    expect((await call('GET', `/api/v1/vehicles/${v.id}`)).body.currentOdometer).toBe(30_000);
    const csv = await call('GET', `/api/v1/fuel-expenses/export?vehicleId=${v.id}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(`'=HYPERLINK`);
    expect(csv.text.split('\r\n')[0]).toContain('Amount (GBP)');
    expect(csv.text).toContain('62.10');
    expect((await call('GET', '/api/v1/fuel-expenses/export', { sub: 'dev|crew' })).status).toBe(
      403,
    );
    expect(
      (
        await call('POST', '/api/v1/fuel-expenses', {
          sub: 'dev|crew',
          body: { ...e, quantity: undefined },
        })
      ).status,
    ).toBe(400);
  });
});
