import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { CQC_SELF_AUDIT } from '@hub/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 CQC self-audit (18 Nov 2026) and the Records by date equipment inspections.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, o: { sub?: string; body?: unknown } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|governance' })}`,
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

const KEYS = CQC_SELF_AUDIT.flatMap((k) => k.questions.map((q) => q.key));

describe('CQC self-audit', () => {
  it('one open at a time; every statement answered before submit; a second person signs off', async () => {
    // Close out anything left open by an earlier run so this test starts from a known state.
    let cur = (await call('GET', '/api/v1/cqc-self-audit')).body.audit as J | null;
    if (cur?.status === 'OPEN') {
      for (const k of KEYS)
        await call('POST', `/api/v1/cqc-self-audit/${cur.id}/answers/${k}`, { body: { answer: 'PASS' } });
      await call('POST', `/api/v1/cqc-self-audit/${cur.id}/submit`);
      cur = (await call('GET', '/api/v1/cqc-self-audit')).body.audit;
    }
    if (cur?.status === 'SUBMITTED')
      await call('POST', `/api/v1/cqc-self-audit/${cur.id}/review`, {
        sub: 'dev|manager',
        body: { note: 'Closed by the test set-up' },
      });

    const start = await call('POST', '/api/v1/cqc-self-audit');
    expect(start.status).toBe(201);
    expect(start.body.code).toMatch(/^SA-\d+$/);
    expect((await call('POST', '/api/v1/cqc-self-audit')).status).toBe(409);
    const id = start.body.id as string;

    expect(
      (await call('POST', `/api/v1/cqc-self-audit/${id}/answers/NOPE-1`, { body: { answer: 'PASS' } }))
        .status,
    ).toBe(404);
    const one = await call('POST', `/api/v1/cqc-self-audit/${id}/answers/${KEYS[0]}`, {
      body: { answer: 'PARTIAL' },
    });
    expect(one.status).toBe(201);
    expect(one.body.answers).toHaveLength(1);
    expect((await call('POST', `/api/v1/cqc-self-audit/${id}/submit`)).status).toBe(400);

    for (const k of KEYS.slice(1))
      await call('POST', `/api/v1/cqc-self-audit/${id}/answers/${k}`, { body: { answer: 'PASS' } });
    const sub = await call('POST', `/api/v1/cqc-self-audit/${id}/submit`);
    expect(sub.status).toBe(201);
    expect(sub.body.status).toBe('SUBMITTED');
    // Answers are locked once submitted.
    expect(
      (await call('POST', `/api/v1/cqc-self-audit/${id}/answers/${KEYS[0]}`, { body: { answer: 'FAIL' } }))
        .status,
    ).toBe(409);
    // The person who submitted it cannot sign off the review.
    expect(
      (await call('POST', `/api/v1/cqc-self-audit/${id}/review`, { body: { note: 'Looks right' } })).status,
    ).toBe(403);
    const rev = await call('POST', `/api/v1/cqc-self-audit/${id}/review`, {
      sub: 'dev|manager',
      body: { note: 'Reviewed with the governance lead' },
    });
    expect(rev.status).toBe(201);
    expect(rev.body.status).toBe('REVIEWED');
  });

  it('needs the audit permission to change anything', async () => {
    expect((await call('POST', '/api/v1/cqc-self-audit', { sub: 'dev|fleet' })).status).toBe(403);
  });
});

describe('records by date', () => {
  it('lists equipment inspection decisions for people who can see the fleet', async () => {
    const r = await call('GET', '/api/v1/records/equipment-inspections?days=30', { sub: 'dev|fleet' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect((await call('GET', '/api/v1/records/equipment-inspections?days=999', { sub: 'dev|fleet' })).status).toBe(400);
  });
});
