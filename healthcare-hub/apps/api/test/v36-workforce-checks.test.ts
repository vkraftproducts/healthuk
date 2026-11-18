import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 Workforce checks (agency, DVLA, HCPC) – four-eyes verify refusal.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: { sub?: string; body?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|hr' })}`,
      'x-org-id': ORG,
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

describe('workforce checks', () => {
  it('lists agency workers and refuses self-verify (four-eyes)', async () => {
    const list = await call('GET', '/api/v1/agency-workers');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);

    const create = await call('POST', '/api/v1/agency-workers', {
      body: {
        name: 'Test Agency Worker',
        agency: 'Test Staffing Ltd',
        role: 'DRIVER',
        confirmationItems: 'DBS, right to work, licence check',
        confirmationReceivedOn: '2026-11-10',
        confirmationExpiresOn: '2027-05-10',
        localInductionDone: false,
        idCheckedOnArrival: false,
      },
    });
    expect(create.status).toBe(201);
    expect(create.body.code).toMatch(/^AG-/);
    expect(create.body.canWork).toBe(false);
    const id = create.body.id as string;

    // Recorder cannot verify their own confirmation.
    const self = await call('POST', `/api/v1/agency-workers/${id}/verify`);
    expect(self.status).toBe(409);
    expect(`${self.body.title ?? ''} ${self.body.detail ?? ''}`).toMatch(/other|verify|four|second/i);

    const ok = await call('POST', `/api/v1/agency-workers/${id}/verify`, { sub: 'dev|manager' });
    expect(ok.status).toBe(201);
    expect(ok.body.confirmationVerifiedBy).toBeTruthy();

    const arrival = await call('POST', `/api/v1/agency-workers/${id}/arrival`, {
      body: { localInductionDone: true, idCheckedOnArrival: true },
    });
    expect(arrival.status).toBe(201);
    expect(arrival.body.canWork).toBe(true);
  });

  it('records a DVLA check and lists the latest per driver', async () => {
    const staff = await call('GET', '/api/v1/staff?limit=50');
    expect(staff.status).toBe(200);
    const driver = (staff.body.data as J[]).find((s) => s.staffNo === 'ST-0042') ?? staff.body.data[0];
    expect(driver).toBeTruthy();

    const created = await call('POST', '/api/v1/dvla-checks', {
      body: {
        staffId: driver.id,
        checkCode: 'Aa 1b Cc 2d',
        categories: 'B, C1',
        points: 0,
        checkedOn: '2026-11-01',
        nextCheckOn: '2027-05-01',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.staffId).toBe(driver.id);

    const list = await call('GET', '/api/v1/dvla-checks');
    expect(list.status).toBe(200);
    expect(list.body.data.some((r: J) => r.staffId === driver.id)).toBe(true);
  });

  it('lists and upserts HCPC registrations', async () => {
    const list = await call('GET', '/api/v1/hcpc-registrations');
    expect(list.status).toBe(200);

    const staff = await call('GET', '/api/v1/staff?limit=50');
    const paramedic =
      (staff.body.data as J[]).find((s) => s.staffNo === 'ST-0042') ?? staff.body.data[0];
    const upsert = await call('POST', '/api/v1/hcpc-registrations', {
      body: {
        staffId: paramedic.id,
        registrationNo: 'PA999001',
        checkedOn: '2026-11-01',
        expiresOn: '2027-11-01',
      },
    });
    expect(upsert.status).toBe(201);
    expect(upsert.body.registrationNo).toBe('PA999001');
  });
});
