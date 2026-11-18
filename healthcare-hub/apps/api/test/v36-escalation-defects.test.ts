import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, SEED_USERS, makeApp, sign } from './harness.js';

// v36 C4/C5/C9: deep clean status and supervision next due (server-side days and escalation
// words), and the defect repair record (plan, start, job sheet) with owner / review date.
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
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|fleet' })}`,
      'x-org-id': ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
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

describe('deep clean status', () => {
  it('lists every vehicle with London-day counts; a new deep clean resets the clock', async () => {
    const before = await call('GET', '/api/v1/deep-cleans/status');
    expect(before.status).toBe(200);
    const rows = before.body.data as J[];
    expect(rows.length).toBeGreaterThan(0);
    const v = rows[0]!;
    const cleanedOn = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
    const rec = await call('POST', '/api/v1/cleaning-records/deep', {
      body: {
        vehicleId: v.vehicleId,
        cleanedOn,
        cleanedBy: SEED_USERS.fleet!.id,
        checkedBy: SEED_USERS.manager!.id,
      },
    });
    expect(rec.status).toBe(201);
    const after = (await call('GET', '/api/v1/deep-cleans/status')).body.data as J[];
    const row = after.find((r) => r.vehicleId === v.vehicleId)!;
    expect(row.lastOn).toBe(cleanedOn);
    // 28-day rule: cleaned 31 days ago → 3 days overdue, escalated (organisation default rule).
    expect(row.daysUntil).toBe(-3);
    expect(row.checkedByName).toBeTruthy();
    expect(row.escalation).not.toBeNull();
  });
});

describe('supervision next due', () => {
  it('returns everyone working with next due and escalation fields', async () => {
    const r = await call('GET', '/api/v1/supervision/next-due', { sub: 'dev|hr' });
    expect(r.status).toBe(200);
    for (const x of r.body.data as J[]) {
      expect(x).toHaveProperty('nextDueOn');
      expect(x).toHaveProperty('escalation');
      if (x.bookedAt || !(x.overdueDays > 0)) expect(x.escalation).toBeNull();
    }
    expect((await call('GET', '/api/v1/supervision/next-due', { sub: 'dev|crew' })).status).toBe(403);
  });
});

describe('defect repair record', () => {
  it('keeps the plan apart from the sign-off and lets the owner / review date change', async () => {
    const vehs = (await call('GET', '/api/v1/vehicles')).body.data as J[];
    const created = await call('POST', '/api/v1/defects', {
      body: { vehicleId: vehs[0]!.id, severity: 'MAJOR', description: 'Rear step light flickers' },
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^DEF-\d{3,}$/);
    const id = created.body.id as string;

    const started = await call('PATCH', `/api/v1/defects/${id}`, {
      body: { status: 'REPAIRING', repairNotes: 'Bulb holder ordered' },
      ifMatch: created.body.version,
    });
    expect(started.status).toBe(200);
    expect(started.body.repairPlan).toBe('Bulb holder ordered');
    expect(started.body.repairStartedAt).toBeTruthy();
    expect(started.body.repairStartedByName).toBeTruthy();

    const signed = await call('PATCH', `/api/v1/defects/${id}`, {
      body: { status: 'REPAIRED', repairNotes: 'Holder replaced, tested', jobSheetRef: 'JS-9001' },
      ifMatch: started.body.version,
    });
    expect(signed.status).toBe(200);
    expect(signed.body.jobSheetRef).toBe('JS-9001');
    expect(signed.body.repairPlan).toBe('Bulb holder ordered');

    // After sign-off only the owner / review date (or a more serious severity) may change.
    const owner = await call('PATCH', `/api/v1/defects/${id}`, {
      body: { ownerUserId: SEED_USERS.manager!.id, reviewBy: '2030-01-15' },
      ifMatch: signed.body.version,
    });
    expect(owner.status).toBe(200);
    expect(owner.body.ownerUserId).toBe(SEED_USERS.manager!.id);
    expect(owner.body.reviewBy).toBe('2030-01-15');
    const late = await call('PATCH', `/api/v1/defects/${id}`, {
      body: { jobSheetRef: 'JS-9002' },
      ifMatch: owner.body.version,
    });
    expect(late.status).toBe(409);
  });
});
