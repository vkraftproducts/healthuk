import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'PUT',
  url: string,
  o: { sub?: string; org?: string; body?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': o.org ?? SEED_IDS.orgExample,
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

describe('v36 front end: organisation working copy', () => {
  const url = '/api/v1/v36/workspace/docs/demo/s0';
  it('saves and reads back a chunk; auditors may read but not change', async () => {
    const put = await call('PUT', url, { body: { data: { c: '{"v":2}' } } });
    expect(put.status).toBe(200);
    const got = await call('GET', url, { sub: 'dev|auditor' });
    expect(got.body).toEqual({ exists: true, data: { c: '{"v":2}' } });
    const denied = await call('PUT', url, { sub: 'dev|auditor', body: { data: { c: 'x' } } });
    expect(denied.status).toBe(403);
  });
  it('rejects paths outside the v36 layout', async () => {
    expect((await call('GET', '/api/v1/v36/workspace/docs/demo/other')).status).toBe(404);
    expect((await call('GET', '/api/v1/v36/workspace/docs/x/meta')).status).toBe(404);
  });
});
