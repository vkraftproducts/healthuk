import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, ensureRoleRequirement, makeApp, sign } from './harness.js';

/** Tasks 16, 18 and 25: what each role is given is limited by the server, not only the screen. */
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Opts {
  sub?: string;
  body?: unknown;
  ifMatch?: number;
}
async function call(method: 'GET' | 'POST', url: string, o: Opts = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
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

let seq = 9400;
async function newStaff(): Promise<J> {
  const r = await call('POST', '/api/v1/staff', {
    body: {
      staffNo: `ST-${seq++}`,
      displayName: 'Synthetic Scope Person',
      primaryLocationId: SEED_IDS.locWatford,
      workEmail: `Scope.${seq}@Example.test`,
      startDate: '2025-04-01',
      contractType: 'PERMANENT',
    },
  });
  expect(r.status).toBe(201);
  return r.body;
}

describe('account [finding 92]', () => {
  it('tells a sign-in with no Hub account that the account does not exist', async () => {
    const r = await call('GET', '/api/v1/me', { sub: 'dev|nobody-at-all' });
    expect([r.status, r.body.code]).toEqual([401, 'UNAUTHENTICATED']);
    expect(r.body.detail).toBe(
      'No account found for this sign-in. Ask your administrator to invite you.',
    );
  });
});

describe('dashboard by role [findings 23, 88]', () => {
  it('leaves out modules and tiles the role cannot open', async () => {
    const hr = (await call('GET', '/api/v1/dashboard/summary', { sub: 'dev|hr' })).body;
    expect(hr.visibleModules).toEqual(expect.arrayContaining(['STAFF', 'COMPLIANCE']));
    expect(hr.visibleModules).not.toContain('FLEET');
    expect(hr.visibleModules).not.toContain('JOBS');
    expect(hr.visibleTiles).toEqual(['overdue', 'dueSoon']);
    expect((hr.modules as J[]).some((m) => m.module === 'FLEET')).toBe(false);
    const fleet = (await call('GET', '/api/v1/dashboard/summary', { sub: 'dev|fleet' })).body;
    expect(fleet.visibleModules).toContain('FLEET');
    expect(fleet.visibleTiles).toContain('blockedVehicles');
    expect(fleet.visibleModules).not.toContain('STAFF');
  });

  it('gives an organisation administrator no compliance figures', async () => {
    const r = await call('GET', '/api/v1/dashboard/summary', { sub: 'dev|orgadmin' });
    expect(r.status).toBe(200);
    expect(r.body.visibleModules).toEqual([]);
    expect(r.body.visibleTiles).toEqual([]);
    expect(r.body.modules).toEqual([]);
  });
});

describe('reports by role [finding 84]', () => {
  it('lists only reports the role covers, and refuses the others on the server', async () => {
    const hr = (await call('GET', '/api/v1/reports', { sub: 'dev|hr' })).body.data as J[];
    expect(hr.map((r) => r.id)).toContain('WORKFORCE_READINESS');
    expect(hr.map((r) => r.id)).not.toContain('FLEET');
    const refused = await call('GET', '/api/v1/reports/FLEET', { sub: 'dev|hr' });
    expect([refused.status, refused.body.code]).toEqual([403, 'FORBIDDEN']);
    const dispatcher = (await call('GET', '/api/v1/reports', { sub: 'dev|dispatcher' })).body
      .data as J[];
    expect(dispatcher.map((r) => r.id)).toEqual(expect.arrayContaining(['FLEET', 'JOURNEYS']));
    expect(dispatcher.map((r) => r.id)).not.toContain('WORKFORCE_READINESS');
    expect(
      (await call('GET', '/api/v1/reports/WORKFORCE_READINESS', { sub: 'dev|dispatcher' })).status,
    ).toBe(403);
  });
});

describe('auditor [findings 25, 91]', () => {
  it('can read the audit log', async () => {
    expect((await call('GET', '/api/v1/audit-log', { sub: 'dev|auditor' })).status).toBe(200);
  });

  it('does not see penalty points or the full driver number', async () => {
    const s = await newStaff();
    const add = await call('POST', `/api/v1/staff/${s.id}/licences`, {
      sub: 'dev|hr',
      body: {
        data: {
          categories: ['B', 'C1'],
          photocardExpiry: '2030-01-31',
          lastCheckedOn: '2026-10-01',
          checkMethod: 'DVLA_SHARE_CODE',
          penaltyPoints: 3,
          licenceNumber: 'morga753116sm9ij',
        },
      },
    });
    expect(add.status).toBe(201);
    const licences = (sub: string) => call('GET', `/api/v1/staff/${s.id}/licences`, { sub });
    const hr = (await licences('dev|hr')).body;
    expect(hr.data[0].data).toMatchObject({
      penaltyPoints: 3,
      licenceNumber: 'MORGA753116SM9IJ',
    });
    const aud = (await licences('dev|auditor')).body;
    expect(aud.data[0].data.penaltyPoints).toBeUndefined();
    expect(aud.data[0].data.licenceNumber).toBe('••••M9IJ');
    const elig = await call('GET', `/api/v1/staff/${s.id}/driver-eligibility?category=B`, {
      sub: 'dev|auditor',
    });
    expect(elig.status).toBe(200);
    expect((elig.body.checks as J[]).some((c) => c.code === 'PENALTY_POINTS')).toBe(false);
  });
});

describe('add staff [finding 53]', () => {
  it('keeps work email, start date and contract type', async () => {
    const s = await newStaff();
    expect(s).toMatchObject({ startDate: '2025-04-01', contractType: 'PERMANENT' });
    expect(s.workEmail).toMatch(/^scope\.\d+@example\.test$/);
    const bad = await call('POST', '/api/v1/staff', {
      body: {
        staffNo: `ST-${seq++}`,
        displayName: 'Bad contract',
        primaryLocationId: SEED_IDS.locWatford,
        contractType: 'ZERO_HOURS_UNKNOWN',
      },
    });
    expect(bad.status).toBe(400);
  });
});

describe('manager requests for someone [finding 15]', () => {
  it('raises a review and a supervision; the requester cannot decide them', async () => {
    const s = await newStaff();
    await ensureRoleRequirement(app, ORG, 'CARE_ASSISTANT');
    await call('POST', `/api/v1/staff/${s.id}/transition`, {
      sub: 'dev|hr',
      body: { to: 'CHECKS_IN_PROGRESS', reason: 'Start checks' },
    });
    const started = await call('POST', `/api/v1/staff/${s.id}/role-checks`, {
      sub: 'dev|hr',
      body: { role: 'CARE_ASSISTANT' },
    });
    expect(started.status).toBe(201);
    const instanceId = started.body.blockers[0].instanceId as string;

    const review = await call('POST', `/api/v1/staff/${s.id}/requests`, {
      sub: 'dev|hr',
      body: { kind: 'REVIEW', instanceId, reason: 'Please look at this item again' },
    });
    expect(review.status).toBe(201);
    expect(review.body).toMatchObject({ kind: 'REVIEW', status: 'OPEN', staffId: s.id });
    const dup = await call('POST', `/api/v1/staff/${s.id}/requests`, {
      sub: 'dev|hr',
      body: { kind: 'REVIEW', instanceId, reason: 'Asking a second time' },
    });
    expect(dup.status).toBe(409);

    const next = `${new Date().getUTCFullYear() + 1}-02-01`;
    const sup = await call('POST', `/api/v1/staff/${s.id}/requests`, {
      sub: 'dev|hr',
      body: { kind: 'SUPERVISION', proposedDate: next, reason: 'Quarterly supervision' },
    });
    expect(sup.status).toBe(201);

    const list = await call('GET', `/api/v1/staff/${s.id}/requests`, { sub: 'dev|hr' });
    expect((list.body.data as J[]).map((r) => r.kind).sort()).toEqual(['REVIEW', 'SUPERVISION']);
    const auditorList = await call('GET', `/api/v1/staff/${s.id}/requests`, {
      sub: 'dev|auditor',
    });
    expect(auditorList.status).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/requests`, {
          sub: 'dev|dispatcher',
          body: { kind: 'SUPERVISION', proposedDate: next, reason: 'Not my place' },
        })
      ).status,
    ).toBe(403);

    const self = await call('POST', `/api/v1/staff/self-requests/${sup.body.id}/decide`, {
      sub: 'dev|hr',
      ifMatch: sup.body.version,
      body: { decision: 'ACCEPTED', bookedFor: `${next}T10:00:00.000Z` },
    });
    expect([self.status, self.body.code]).toEqual([422, 'SELF_APPROVAL']);
  });
});
