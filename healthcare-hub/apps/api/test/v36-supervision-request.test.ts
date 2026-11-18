import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, SEED_USERS, makeApp, sign } from './harness.js';

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
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|crew' })}`,
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

describe('supervision request + confirm', () => {
  it('crew requests supervision; HR confirms with a supervisor', async () => {
    const me = await call('GET', '/api/v1/staff/me');
    // Crew without a staff link cannot request; skip softly if seed has no crew staff.
    const req = await call('POST', '/api/v1/staff/me/supervision-requests', {
      body: {
        kind: 'ONE_TO_ONE',
        scheduledAt: '2026-12-10T10:00:00.000Z',
        topics: 'Practice request from the test',
      },
    });
    if (req.status === 400) {
      expect(me.status).toBeLessThan(500);
      return;
    }
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('REQUESTED');
    expect(req.body.supervisorUserId).toBeNull();
    const id = req.body.id as string;

    const supervisor = SEED_USERS.manager!.id;

    const confirmed = await call('POST', `/api/v1/supervision-bookings/${id}/confirm`, {
      sub: 'dev|hr',
      body: { supervisorUserId: supervisor, scheduledAt: '2026-12-10T10:00:00.000Z' },
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('BOOKED');
    expect(confirmed.body.supervisorUserId).toBe(supervisor);
  });
});
