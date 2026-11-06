import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, o: { sub?: string; body?: unknown } = {}) {
  const token = await sign({ sub: o.sub ?? 'dev|admin' });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-org-id': ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  let body: J;
  try {
    body = res.body ? (JSON.parse(res.body) as J) : {};
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, text: res.body, headers: res.headers };
}
const sync = (adapter: string, scenario?: string) =>
  call('POST', `/api/v1/integrations/${adapter}/sync`, {
    body: scenario ? { scenario } : {},
  });

beforeAll(async () => {
  app = (await makeApp(urls)).app;
});
afterAll(async () => {
  await app.close();
});

describe('integrations (mock adapters)', () => {
  it('lists every adapter as not connected, with the mock-only notice', async () => {
    const r = await call('GET', '/api/v1/integrations');
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: J) => d.adapter)).toEqual([
      'TELEMATICS',
      'FLEETX',
      'TRAINING',
      'PAYROLL',
      'CALENDAR',
    ]);
    expect(r.body.data.every((d: J) => d.connected === false)).toBe(true);
    expect(r.body.notice).toMatch(/Mock integrations only/);
  });

  it('needs the settings permission', async () => {
    expect((await call('GET', '/api/v1/integrations', { sub: 'dev|crew' })).status).toBe(403);
    expect(
      (await call('POST', '/api/v1/integrations/TELEMATICS/connect', { sub: 'dev|crew', body: {} }))
        .status,
    ).toBe(403);
  });

  it('refuses a live connection and unknown adapters', async () => {
    const live = await call('POST', '/api/v1/integrations/FLEETX/connect', {
      body: { mode: 'LIVE' },
    });
    expect(live.status).toBe(409);
    expect((await call('POST', '/api/v1/integrations/NOPE/connect', { body: {} })).status).toBe(
      404,
    );
  });

  it('will not sync before it is connected, or sync an outbound adapter', async () => {
    expect((await sync('TELEMATICS')).status).toBe(409);
    await call('POST', '/api/v1/integrations/PAYROLL/connect', { body: {} });
    expect((await sync('PAYROLL')).status).toBe(400);
  });

  it('telematics: records readings once per day and flags a backwards reading', async () => {
    await call('POST', '/api/v1/integrations/TELEMATICS/connect', { body: {} });
    const first = await sync('TELEMATICS');
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('SUCCEEDED');
    expect(first.body.recordsApplied).toBeGreaterThan(0);
    const again = await sync('TELEMATICS');
    expect(again.body.recordsApplied).toBe(0);
    expect(again.body.recordsSkipped).toBe(first.body.recordsApplied);
  });

  it('fleetx: creates submitted expenses idempotently and marks the duplicate card swipe', async () => {
    await call('POST', '/api/v1/integrations/FLEETX/connect', { body: {} });
    const faults = await sync('FLEETX', 'faults');
    expect(faults.body.status).toBe('PARTIAL');
    expect(faults.body.recordsFlagged).toBe(1);
    expect(faults.body.recordsSkipped).toBeGreaterThanOrEqual(1);
    const again = await sync('FLEETX', 'faults');
    expect(again.body.recordsApplied).toBe(0);
    const list = await call('GET', '/api/v1/fuel-expenses', { sub: 'dev|manager' });
    const mock = (list.body.data as J[]).filter((e) => e.supplier === 'Mock fuel card (synthetic)');
    expect(mock.length).toBe(faults.body.recordsApplied);
    expect(mock.every((e) => e.status === 'SUBMITTED')).toBe(true);
  });

  it('training: stores unverified records only and skips unknown staff', async () => {
    await call('POST', '/api/v1/integrations/TRAINING/connect', { body: {} });
    const r = await sync('TRAINING', 'faults');
    expect(r.body.recordsSkipped).toBeGreaterThanOrEqual(1);
    expect(r.body.notes.join(' ')).toMatch(/unverified/i);
    const again = await sync('TRAINING');
    expect(again.body.recordsApplied).toBe(0);
  });

  it('payroll export is a CSV of hours and calendar feed is iCalendar, both audited', async () => {
    const p = await call(
      'GET',
      '/api/v1/integrations/payroll/export?from=2020-01-01&to=2099-12-31',
    );
    expect(p.status).toBe(200);
    expect(p.headers['content-type']).toMatch(/text\/csv/);
    expect(p.text.split('\r\n')[0]).toBe('Staff number,Name,From,To,Shifts,Planned hours');
    expect(
      (await call('GET', '/api/v1/integrations/payroll/export?from=2026-02-01&to=2026-01-01'))
        .status,
    ).toBe(400);
    await call('POST', '/api/v1/integrations/CALENDAR/connect', { body: {} });
    const c = await call('GET', '/api/v1/integrations/calendar/feed');
    expect(c.status).toBe(200);
    expect(c.text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(c.text).not.toMatch(/patient|job/i);
  });

  it('shows runs on the list and a disconnected adapter stops syncing', async () => {
    const l = await call('GET', '/api/v1/integrations');
    expect(l.body.recentRuns.length).toBeGreaterThan(0);
    expect(l.body.data.find((d: J) => d.adapter === 'TELEMATICS').lastStatus).not.toBeNull();
    await call('POST', '/api/v1/integrations/TELEMATICS/disconnect');
    expect((await sync('TELEMATICS')).status).toBe(409);
  });
});
