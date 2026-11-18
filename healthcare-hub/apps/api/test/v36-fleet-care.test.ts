import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

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
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|fleet' })}`,
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

describe('fleet care deep clean', () => {
  it('records a deep clean with four-eyes and flags infectious transfer', async () => {
    const vehs = await call('GET', '/api/v1/vehicles');
    expect(vehs.status).toBe(200);
    const v = (vehs.body.data as J[])[0];
    if (!v) throw new Error('expected a vehicle');

    const people = await call('GET', '/api/v1/admin/people', { sub: 'dev|manager' });
    const ids = ((people.body.data as J[]) ?? []).map((p) => p.id as string);
    const cleaner = ids[0];
    const checker = ids.find((id) => id !== cleaner) ?? ids[1];
    if (!cleaner || !checker || cleaner === checker) throw new Error('expected two people');

    const bad = await call('POST', '/api/v1/cleaning-records/deep', {
      body: {
        vehicleId: v.id,
        cleanedOn: '2026-11-10',
        cleanedBy: cleaner,
        checkedBy: cleaner,
      },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const ok = await call('POST', '/api/v1/cleaning-records/deep', {
      body: {
        vehicleId: v.id,
        cleanedOn: '2026-11-10',
        cleanedBy: cleaner,
        checkedBy: checker,
        note: 'Scheduled deep clean',
      },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.type).toBe('ENHANCED');
    expect(ok.body.checkedBy).toBe(checker);

    const flag = await call('POST', `/api/v1/vehicles/${v.id}/infectious-transfer`);
    expect(flag.status).toBe(201);
    expect(flag.body.quarantined).toBe(true);
    expect(String(flag.body.quarantineReason)).toMatch(/Deep clean needed/i);
  });
});
