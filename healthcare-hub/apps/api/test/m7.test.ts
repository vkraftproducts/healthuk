import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { SYSTEM_USER_ID, type Db } from '@hub/db';
import { ExpoPushSender, MemoryPushSender, sendPendingPush } from '@hub/domain';
import { londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { sub?: string; body?: unknown; device?: string } = {},
) {
  const token = await sign({ sub: o.sub ?? 'dev|dispatcher' });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-org-id': ORG,
      ...(o.device ? { 'x-device-id': o.device } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}
async function sql<T = J>(text: string, params: unknown[] = []): Promise<T[]> {
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  try {
    return (await su.query(text, params)).rows as T[];
  } finally {
    await su.end();
  }
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
const now = () => new Date().toISOString();
let seq = 9500;

async function crewMember(roles: string[] = ['DRIVER', 'CARE_ASSISTANT']) {
  const tag = `${Date.now().toString(36)}${seq}`;
  const [u] = await sql(
    `INSERT INTO app_user (idp_subject, email, display_name, status) VALUES ($1, $2, 'Synthetic Crew', 'ACTIVE') RETURNING id`,
    [`dev|m7-${tag}`, `m7-${tag}@example.test`],
  );
  await sql(
    `INSERT INTO membership (organisation_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
    [ORG, u!.id],
  );
  const s = await call('POST', '/api/v1/staff', {
    sub: 'dev|manager',
    body: {
      staffNo: `ST-${seq++}`,
      displayName: `Synthetic Crew ${tag}`,
      primaryLocationId: SEED_IDS.locWatford,
      userId: u!.id,
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
  return { sub: `dev|m7-${tag}`, staffId: s.body.id as string, userId: u!.id as string };
}
let vn = 40;
async function vehicle(): Promise<string> {
  vn += 1;
  const r = await call('POST', '/api/v1/vehicles', {
    sub: 'dev|fleet',
    body: {
      registration: `MS${vn}XYZ`,
      callsign: `CRW-${vn}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
    },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function shift(
  vehicleId: string,
  crew: { staffId: string; role: string }[],
  fromH = 0.5,
  toH = 8,
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
async function job(startH: number) {
  const r = await call('POST', '/api/v1/bookings', {
    body: {
      customer: 'Synthetic NHS Trust',
      patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
      job: {
        locationId: SEED_IDS.locWatford,
        pickupFrom: at(startH),
        pickupTo: at(startH + 0.5),
        plannedStart: at(startH),
        plannedEnd: at(startH + 1),
        pickupAddress: '1 Synthetic Road, Watford',
        destinationAddress: 'Synthetic General Hospital',
        accessNotes: 'Key safe at side door',
        patientRef: `PX${seq++}`,
        mobility: 'WALKING',
      },
    },
  });
  expect(r.status).toBe(201);
  return r.body.jobs[0] as J;
}
/** A crewed shift with one job offered to the crew. */
async function crewedJob(fromH = 0.5) {
  const d = await crewMember();
  const a = await crewMember(['CARE_ASSISTANT']);
  const v = await vehicle();
  const s = await shift(
    v,
    [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ],
    fromH,
    fromH + 8,
  );
  const j = await job(fromH + 1);
  expect(
    (await call('POST', `/api/v1/jobs/${j.id}/allocate`, { body: { shiftId: s.id } })).status,
  ).toBe(201);
  expect((await call('POST', `/api/v1/jobs/${j.id}/offer`)).status).toBe(201);
  return { d, a, v, s, j };
}

describe('My shift [APP-01, wireframe 05]', () => {
  it('shows vehicle, crew, the three gate cards, the checklist and assigned jobs', async () => {
    const { d, s, j } = await crewedJob();
    const t = await call('GET', '/api/v1/crew/today', { sub: d.sub });
    expect(t.status).toBe(200);
    expect(t.body.shift).toMatchObject({ id: s.id, myRole: 'DRIVER', state: 'PLANNED' });
    expect(t.body.shift.vehicle.callsign).toMatch(/^CRW-/);
    expect(t.body.shift.crew.filter((c: J) => c.me)).toHaveLength(1);
    expect(t.body.shift.gate.canStart).toBe(false);
    expect(t.body.shift.gate.cards.map((c: J) => [c.label, c.state])).toEqual([
      ['Driving clearance', 'APPROVED'],
      ['Vehicle daily inspection', 'REQUIRED'],
      ['Pre-shift cleaning', 'REQUIRED'],
    ]);
    expect(t.body.shift.vdiTemplate.items.length).toBeGreaterThan(0);
    expect(t.body.shift.jobs).toEqual([
      expect.objectContaining({
        id: j.id,
        state: 'OFFERED',
        nextStates: ['ACKNOWLEDGED', 'REFUSED'],
      }),
    ]);
    // Cache must be discarded 12 hours after the shift ends.
    expect(new Date(t.body.cacheUntil).getTime()).toBe(new Date(s.endsAt).getTime() + 12 * H);
    expect(JSON.stringify(t.body)).not.toContain('Synthetic Patient'); // no patient detail in the list
  });

  it('crew without a shift get an empty day; people without crew access are refused', async () => {
    const c = await crewMember(['CARE_ASSISTANT']);
    const t = await call('GET', '/api/v1/crew/today', { sub: c.sub });
    expect(t.body).toMatchObject({ shift: null, upcoming: [] });
    expect(t.body.staff.displayName).toMatch(/^Synthetic Crew/);
    expect((await call('GET', '/api/v1/crew/today', { sub: 'dev|hr' })).status).toBe(403);
  });
});

describe('assigned job detail [APP-01, UAT-05, MOBILE_APP "only assigned patient details"]', () => {
  it('shows the patient contact to the crew during the shift window only, and audits it', async () => {
    const { d, j } = await crewedJob();
    const r = await call('GET', `/api/v1/crew/jobs/${j.id}`, { sub: d.sub });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      code: j.code,
      accessNotes: 'Key safe at side door',
      patientContact: { name: 'Synthetic Patient' },
    });
    const logged = await sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'jobs.patient.view' AND entity_id = $1`,
      [j.id],
    );
    expect(logged[0]!.n).toBeGreaterThanOrEqual(1);
    const other = await crewMember(['CARE_ASSISTANT']);
    expect((await call('GET', `/api/v1/crew/jobs/${j.id}`, { sub: other.sub })).status).toBe(404);
  });

  it('a shift starting tomorrow does not reveal the patient yet', async () => {
    const { d, j } = await crewedJob(30);
    const r = await call('GET', `/api/v1/crew/jobs/${j.id}`, { sub: d.sub });
    expect(r.status).toBe(200);
    expect(r.body.patientContact).toBeNull();
  });
});

describe('offline sync [APP-01, UAT-06]', () => {
  it('replaying the same batch creates exactly one record per submission', async () => {
    const { d, v, s, j } = await crewedJob();
    const tpl = (await call('GET', '/api/v1/crew/today', { sub: d.sub })).body.shift.vdiTemplate;
    const items = [
      {
        clientSubmissionId: randomUUID(),
        type: 'CLEANING',
        payload: { vehicleId: v, shiftId: s.id, type: 'PRE_SHIFT', capturedAt: now() },
      },
      {
        clientSubmissionId: randomUUID(),
        type: 'VDI',
        payload: {
          vehicleId: v,
          templateId: tpl.id,
          shiftId: s.id,
          odometer: 1200,
          capturedAt: now(),
          results: tpl.items.map((i: J) => ({ code: i.code, result: 'PASS' })),
        },
      },
      {
        clientSubmissionId: randomUUID(),
        type: 'JOB_STATUS',
        ref: j.id,
        payload: { state: 'ACKNOWLEDGED', capturedAt: now() },
      },
      {
        clientSubmissionId: randomUUID(),
        type: 'DEFECT',
        payload: { vehicleId: v, severity: 'MINOR', description: 'Interior light flickers' },
      },
      {
        clientSubmissionId: randomUUID(),
        type: 'EXPENSE',
        payload: {
          vehicleId: v,
          spentOn: londonDate(new Date()),
          category: 'FUEL',
          quantity: 40,
          unit: 'LITRES',
          amountPence: 6123,
        },
      },
      { clientSubmissionId: randomUUID(), type: 'JOB_STATUS', payload: { state: 'EN_ROUTE' } },
    ];
    const first = await call('POST', '/api/v1/crew/sync', { sub: d.sub, body: { items } });
    expect(first.status).toBe(201);
    expect(first.body.results.map((r: J) => r.outcome)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'ACCEPTED',
      'REJECTED', // no job reference
    ]);
    const again = await call('POST', '/api/v1/crew/sync', {
      sub: d.sub,
      body: { items: items.slice(0, 5) },
    });
    expect(again.body.results.map((r: J) => r.outcome)).toEqual(Array(5).fill('DUPLICATE'));
    const ids = items.slice(0, 5).map((i) => i.clientSubmissionId);
    const [counts] = await sql(
      `SELECT
         (SELECT count(*)::int FROM cleaning_record WHERE client_submission_id = $1) AS cleaning,
         (SELECT count(*)::int FROM vdi WHERE client_submission_id = $2) AS vdi,
         (SELECT count(*)::int FROM job_status_event WHERE client_submission_id = $3) AS status,
         (SELECT count(*)::int FROM defect WHERE client_submission_id = $4) AS defect,
         (SELECT count(*)::int FROM fuel_expense WHERE client_submission_id = $5) AS expense`,
      ids,
    );
    expect(counts).toEqual({ cleaning: 1, vdi: 1, status: 1, defect: 1, expense: 1 });
    // With the gate passed, the shift can start.
    expect((await call('POST', `/api/v1/shifts/${s.id}/start`, { sub: d.sub })).status).toBe(201);
  });

  it('a shift started offline is replayed through the server gate: refused until the gate passes', async () => {
    const { d, v, s } = await crewedJob();
    const tpl = (await call('GET', '/api/v1/crew/today', { sub: d.sub })).body.shift.vdiTemplate;
    const start = { clientSubmissionId: randomUUID(), type: 'SHIFT_START', ref: s.id, payload: {} };
    const blocked = await call('POST', '/api/v1/crew/sync', {
      sub: d.sub,
      body: { items: [start] },
    });
    expect(blocked.body.results[0]).toMatchObject({
      outcome: 'CONFLICT',
      code: 'SHIFT_GATE_BLOCKED',
    });
    const ok = await call('POST', '/api/v1/crew/sync', {
      sub: d.sub,
      body: {
        items: [
          {
            clientSubmissionId: randomUUID(),
            type: 'VDI',
            payload: {
              vehicleId: v,
              templateId: tpl.id,
              shiftId: s.id,
              odometer: 1300,
              capturedAt: now(),
              results: tpl.items.map((i: J) => ({ code: i.code, result: 'PASS' })),
            },
          },
          {
            clientSubmissionId: randomUUID(),
            type: 'CLEANING',
            payload: { vehicleId: v, shiftId: s.id, type: 'PRE_SHIFT', capturedAt: now() },
          },
          { ...start, clientSubmissionId: randomUUID() },
        ],
      },
    });
    expect(ok.body.results.map((r: J) => r.outcome)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);
    const [row] = await sql(`SELECT state FROM shift WHERE id = $1`, [s.id]);
    expect(row!.state).toBe('STARTED');
    // Replaying the start is harmless.
    const again = await call('POST', '/api/v1/crew/sync', { sub: d.sub, body: { items: [start] } });
    expect(again.body.results[0].outcome).toBe('ACCEPTED');
  });

  it('a job reassigned while the crew was offline comes back as a conflict with the server state', async () => {
    const { d, j } = await crewedJob();
    const control = await call('POST', `/api/v1/jobs/${j.id}/status`, {
      body: {
        state: 'REASSIGNED',
        reason: 'Vehicle needed elsewhere',
        clientSubmissionId: randomUUID(),
        capturedAt: now(),
      },
    });
    expect(control.status).toBe(201);
    const r = await call('POST', '/api/v1/crew/sync', {
      sub: d.sub,
      body: {
        items: [
          {
            clientSubmissionId: randomUUID(),
            type: 'JOB_STATUS',
            ref: j.id,
            payload: { state: 'ACKNOWLEDGED', capturedAt: now() },
          },
        ],
      },
    });
    expect(r.body.results[0]).toMatchObject({
      outcome: 'CONFLICT',
      serverState: { jobState: 'REASSIGNED', assignedToYou: false },
    });
    // The crew was told (generically) that the job changed.
    const pushes = await sql(
      `SELECT kind FROM push_message WHERE ref_id = $1 AND user_id = $2 ORDER BY created_at`,
      [j.id, d.userId],
    );
    expect(pushes.map((p) => p.kind)).toEqual(['JOB_OFFERED', 'JOB_CHANGED']);
  });

  it('defect photos must be the reporter’s own uploads', async () => {
    const { d, a, v } = await crewedJob();
    const req = await call('POST', '/api/v1/evidence/uploads', {
      sub: a.sub,
      body: { title: 'Defect photo', mime: 'image/jpeg', sizeBytes: 10 },
    });
    expect(req.status).toBe(201);
    const bad = await call('POST', '/api/v1/defects', {
      sub: d.sub,
      body: {
        vehicleId: v,
        severity: 'MINOR',
        description: 'Scuffed step',
        photoEvidenceItemIds: [req.body.evidenceItemId],
      },
    });
    expect(bad.status).toBe(404);
    const good = await call('POST', '/api/v1/defects', {
      sub: a.sub,
      body: {
        vehicleId: v,
        severity: 'MINOR',
        description: 'Scuffed step',
        photoEvidenceItemIds: [req.body.evidenceItemId],
      },
    });
    expect(good.body.photoEvidenceItemIds).toEqual([req.body.evidenceItemId]);
  });
});

describe('policies on the crew app [COMP-04, MOBILE_APP 8]', () => {
  it('critical instructions need explicit confirmation; a superseded version is a conflict', async () => {
    const c = await crewMember(['CARE_ASSISTANT']);
    const owner = (await call('GET', '/api/v1/admin/users', { sub: 'dev|manager' })).body.data.find(
      (u: J) => u.email === 'manager@example.test',
    ).id;
    const p = await call('POST', '/api/v1/policies', {
      sub: 'dev|governance',
      body: {
        code: `CI-${Date.now().toString(36).toUpperCase().slice(-5)}`,
        title: 'Hoist safety alert',
        category: 'CRITICAL_INSTRUCTION',
        ownerUserId: owner,
        readerRoles: ['CREW'],
        summary: 'Do not use model X hoist slings',
      },
    });
    expect(p.status).toBe(201);
    const move = (vid: string, to: string, sub: string) =>
      call('POST', `/api/v1/policies/${p.body.id}/versions/${vid}/transition`, {
        sub,
        body: { to },
      });
    const v1 = p.body.versions[0].id;
    await move(v1, 'IN_REVIEW', 'dev|governance');
    await move(v1, 'APPROVED', 'dev|manager');
    expect((await move(v1, 'PUBLISHED', 'dev|manager')).status).toBe(201);

    const pending = (await call('GET', '/api/v1/crew/policies/pending', { sub: c.sub })).body
      .data as J[];
    expect(pending.find((x) => x.versionId === v1)).toMatchObject({ critical: true, version: 1 });
    const push = await sql(`SELECT kind FROM push_message WHERE ref_id = $1 AND user_id = $2`, [
      v1,
      c.userId,
    ]);
    expect(push.map((x) => x.kind)).toEqual(['POLICY_ACK']);

    const noConfirm = await call('POST', `/api/v1/crew/policies/${v1}/acknowledge`, {
      sub: c.sub,
      body: {},
    });
    expect(noConfirm.status).toBe(400);

    // A new material version is published before the offline acknowledgement reaches the server.
    const v2 = await call('POST', `/api/v1/policies/${p.body.id}/versions`, {
      sub: 'dev|governance',
      body: { summary: 'Model X and Y slings withdrawn', material: true },
    });
    const v2id = v2.body.versions.find((v: J) => v.version === 2).id;
    await move(v2id, 'IN_REVIEW', 'dev|governance');
    await move(v2id, 'APPROVED', 'dev|manager');
    await move(v2id, 'PUBLISHED', 'dev|manager');
    const stale = await call('POST', '/api/v1/crew/sync', {
      sub: c.sub,
      body: {
        items: [
          {
            clientSubmissionId: randomUUID(),
            type: 'POLICY_ACK',
            ref: v1,
            payload: { confirmCritical: true },
          },
        ],
      },
    });
    expect(stale.body.results[0]).toMatchObject({ outcome: 'CONFLICT', code: 'CONFLICT' });
    const ok = await call('POST', `/api/v1/crew/policies/${v2id}/acknowledge`, {
      sub: c.sub,
      body: { confirmCritical: true },
    });
    expect(ok.status).toBe(201);
    const after = (await call('GET', '/api/v1/crew/policies/pending', { sub: c.sub })).body
      .data as J[];
    expect(after.some((x) => x.documentId === p.body.id)).toBe(false);
  });
});

describe('devices, push and revocation [APP-02, MOBILE_APP device security]', () => {
  it('registers for push; payloads are generic; a signed-out device is refused and cannot re-register', async () => {
    const d = await crewMember();
    const device = `dev-${randomUUID()}`;
    const reg = await call('POST', '/api/v1/devices/register-push', {
      sub: d.sub,
      device,
      body: {
        deviceId: device,
        platform: 'ANDROID',
        pushToken: 'ExponentPushToken[synthetic-1]',
        appVersion: '1.0.0',
      },
    });
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({ pushEnabled: true, platform: 'ANDROID' });

    // A job offered to this person is pushed with fixed text and opaque ids only.
    const a = await crewMember(['CARE_ASSISTANT']);
    const v = await vehicle();
    const s = await shift(v, [
      { staffId: d.staffId, role: 'DRIVER' },
      { staffId: a.staffId, role: 'CARE_ASSISTANT' },
    ]);
    const j = await job(2);
    await call('POST', `/api/v1/jobs/${j.id}/allocate`, { body: { shiftId: s.id } });
    await call('POST', `/api/v1/jobs/${j.id}/offer`);
    const sender = new MemoryPushSender();
    const r = await db.withTenant({ orgId: ORG, userId: SYSTEM_USER_ID }, (tx) =>
      // A worker clock behind the database must not hold back a message that is already due.
      sendPendingPush(tx, new Date(Date.now() - 5000), sender),
    );
    expect(r.sent).toBeGreaterThanOrEqual(1);
    const mine = sender.sent.filter((x) => x.target.token === 'ExponentPushToken[synthetic-1]');
    expect(mine.map((x) => x.payload)).toContainEqual({
      title: 'New job assigned',
      body: 'Open the app to view and acknowledge it.',
      data: { type: 'JOB_OFFERED', id: j.id },
    });
    const text = JSON.stringify(sender.sent);
    expect(text).not.toContain(j.code);
    expect(text).not.toContain('Synthetic Patient');
    expect(text).not.toContain('Synthetic Road');

    const list = await call('GET', '/api/v1/devices', { sub: d.sub });
    expect(list.body.data).toHaveLength(1);
    const out = await call('DELETE', `/api/v1/devices/${reg.body.id}`, { sub: d.sub });
    expect(out.body).toMatchObject({ pushEnabled: false });
    expect(out.body.revokedAt).not.toBeNull();
    const blocked = await call('GET', '/api/v1/crew/today', { sub: d.sub, device });
    expect([blocked.status, blocked.body.code]).toEqual([401, 'DEVICE_REVOKED']);
    // The same login on another device still works; the revoked one cannot re-register.
    expect((await call('GET', '/api/v1/crew/today', { sub: d.sub })).status).toBe(200);
    const again = await call('POST', '/api/v1/devices/register-push', {
      sub: d.sub,
      body: { deviceId: device, platform: 'ANDROID', pushToken: null },
    });
    expect(again.status).toBe(401);
    // Other people cannot sign out my device.
    expect((await call('DELETE', `/api/v1/devices/${reg.body.id}`, { sub: a.sub })).status).toBe(
      404,
    );
  });

  it('the Expo adapter drops tokens the push service reports as unregistered', async () => {
    const calls: J[] = [];
    const sender = new ExpoPushSender((async (_url: string, init: J) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch);
    const out = await sender.send(
      [
        { token: 'ExponentPushToken[a]', platform: 'IOS' },
        { token: 'ExponentPushToken[b]', platform: 'ANDROID' },
      ],
      { title: 'New job assigned', body: 'Open the app.', data: { type: 'JOB_OFFERED', id: 'x' } },
    );
    expect(out).toEqual([
      { ok: true },
      { ok: false, invalidToken: true, error: 'DeviceNotRegistered' },
    ]);
    expect(Object.keys(calls[0]![0])).toEqual(['to', 'title', 'body', 'data', 'sound', 'priority']);
    const down = new ExpoPushSender(
      (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
    );
    expect(
      await down.send([{ token: 'ExponentPushToken[a]', platform: 'IOS' }], out as never),
    ).toEqual([{ ok: false, error: 'HTTP 503' }]);
    expect(await down.send([], out as never)).toEqual([]);
  });
});

describe('crew profile [MOBILE_APP 9]', () => {
  it('shows my own requirements and documents; people without a staff record get 404', async () => {
    const c = await crewMember();
    const p = await call('GET', '/api/v1/crew/profile', { sub: c.sub });
    expect(p.status).toBe(200);
    expect(p.body.roles).toEqual(expect.arrayContaining(['DRIVER', 'CARE_ASSISTANT']));
    expect(Array.isArray(p.body.requirements)).toBe(true);
    await call('POST', '/api/v1/evidence/uploads', {
      sub: c.sub,
      body: { title: 'First aid certificate', mime: 'application/pdf', sizeBytes: 10 },
    });
    const docs = (await call('GET', '/api/v1/crew/profile', { sub: c.sub })).body.documents as J[];
    expect(docs).toEqual([
      expect.objectContaining({ title: 'First aid certificate', state: 'UPLOAD_INCOMPLETE' }),
    ]);
    expect(p.body.requirements.every((r: J) => typeof r.reasonText === 'string')).toBe(true);
    expect((await call('GET', '/api/v1/crew/profile', { sub: 'dev|dispatcher' })).status).toBe(404);
  });
});
