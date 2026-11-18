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

describe('planned training sessions', () => {
  it('plans a session, invites who is due, and cancels', async () => {
    const list = await call('GET', '/api/v1/training-plans');
    expect(list.status).toBe(200);

    const created = await call('POST', '/api/v1/training-plans', {
      body: {
        courseCode: 'TR-BLS',
        plannedOn: '2026-12-15',
        places: 4,
        inviteDue: true,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^TP-/);
    expect(created.body.status).toBe('PLANNED');
    const id = created.body.id as string;

    const invited = await call('POST', `/api/v1/training-plans/${id}/invite-due`);
    expect(invited.status).toBe(201);
    expect(invited.body.invitedStaffIds.length).toBeLessThanOrEqual(4);

    const cancelled = await call('POST', `/api/v1/training-plans/${id}/cancel`);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await call('POST', `/api/v1/training-plans/${id}/cancel`)).status).toBe(409);
  });
});
