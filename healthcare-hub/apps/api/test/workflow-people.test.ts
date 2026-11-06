import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { buildOpenApi } from '@hub/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, SEED_SUPPORT, SEED_USERS, makeApp, sign } from './harness.js';

/**
 * Workflow pass for A, B, C, K, H6, L2, L4 and F0 (docs/WORKFLOWS.md). Each test creates its own
 * records so it can run alongside the milestone suites.
 */
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { sub?: string; body?: unknown; ifMatch?: number } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  let body: J;
  try {
    body = res.body ? (JSON.parse(res.body) as J) : {};
  } catch {
    body = {};
  }
  return { status: res.statusCode, body, text: res.body, raw: res };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('route registry', () => {
  it('lists every endpoint added by the workflow pass in OpenAPI', () => {
    const paths = Object.keys(buildOpenApi().paths);
    for (const p of [
      '/api/v1/admin/support-access-grants/{id}/end',
      '/api/v1/alerts/count',
      '/api/v1/audit-log/export',
      '/api/v1/training-courses',
      '/api/v1/supervision-bookings',
      '/api/v1/subject-requests/{id}/sources',
      '/api/v1/retention-reviews',
      '/api/v1/speak-up/progress',
      '/api/v1/speak-up/themes',
    ])
      expect(paths).toContain(p);
  });
});

describe('A3 invite and A4 support access', () => {
  it('refuses to invite someone who already has access, and points to Change access', async () => {
    const roles = (await call('GET', '/api/v1/admin/roles')).body.data as J[];
    const crew = roles.find((r) => r.key === 'CREW')!;
    const r = await call('POST', '/api/v1/admin/users', {
      body: {
        email: SEED_USERS.hr!.email,
        displayName: 'Duplicate person',
        roleId: crew.id,
        locationId: null,
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/already has access/);
    expect(r.body.checks?.[0]?.code).toBe('EXISTING_USER');
  });

  it('ends support access early with a reason, once only', async () => {
    const grant = await call('POST', '/api/v1/admin/support-access-grants', {
      body: { supportUserEmail: SEED_SUPPORT.email, reason: 'Workflow test ticket 7', hours: 1 },
    });
    expect(grant.status).toBe(201);
    const url = `/api/v1/admin/support-access-grants/${grant.body.id}/end`;
    expect((await call('POST', url, { sub: 'dev|crew', body: { reason: 'Done' } })).status).toBe(
      403,
    );
    expect((await call('POST', url, { body: {} })).status).toBe(400);
    const ended = await call('POST', url, { body: { reason: 'Ticket resolved early' } });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ active: false, endedEarlyReason: 'Ticket resolved early' });
    expect(ended.body.endedEarlyAt).toBeTruthy();
    expect((await call('POST', url, { body: { reason: 'Again' } })).status).toBe(409);
    const list = (await call('GET', '/api/v1/admin/support-access-grants')).body.data as J[];
    expect(list.find((g) => g.id === grant.body.id)).toMatchObject({ active: false });
  });
});

describe('A7 alert bell', () => {
  it('counts open items for anyone in the organisation', async () => {
    const r = await call('GET', '/api/v1/alerts/count', { sub: 'dev|crew' });
    expect(r.status).toBe(200);
    expect(typeof r.body.open).toBe('number');
    expect(r.body.critical).toBeLessThanOrEqual(r.body.open);
  });
});

describe('L4 audit log', () => {
  it('filters by action prefix and exports a CSV that is itself audited', async () => {
    const exp = await call('GET', '/api/v1/audit-log/export?action=admin.');
    expect(exp.status).toBe(200);
    expect(String(exp.raw.headers['content-type'])).toMatch(/text\/csv/);
    expect(exp.text.split('\n')[0]).toMatch(/When/);
    expect((await call('GET', '/api/v1/audit-log/export', { sub: 'dev|crew' })).status).toBe(403);
    const log = await call('GET', '/api/v1/audit-log?action=admin.audit.export&limit=5');
    expect(log.status).toBe(200);
    expect((log.body.data as J[]).length).toBeGreaterThan(0);
    for (const e of log.body.data as J[]) expect(e.action).toBe('admin.audit.export');
  });
});

describe('C1 training catalogue', () => {
  it('HR adds and retires a course; everyone can read the catalogue', async () => {
    const code = `WF${Date.now().toString(36).toUpperCase()}`;
    const add = await call('POST', '/api/v1/training-courses', {
      sub: 'dev|hr',
      body: { code, title: 'Workflow test course', intervalMonths: 12, basis: 'ORG_POLICY' },
    });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ code, retired: false });
    expect(
      (
        await call('POST', '/api/v1/training-courses', {
          sub: 'dev|crew',
          body: { code: `${code}X`, title: 'Nope', intervalMonths: 12, basis: 'ORG_POLICY' },
        })
      ).status,
    ).toBe(403);
    const retire = await call('POST', `/api/v1/training-courses/${add.body.id}/retire`, {
      sub: 'dev|hr',
      ifMatch: add.body.version,
      body: { reason: 'Replaced by the new course' },
    });
    expect(retire.status).toBe(200);
    expect(retire.body).toMatchObject({
      retired: true,
      retireReason: 'Replaced by the new course',
    });
    const list = await call('GET', '/api/v1/training-courses', { sub: 'dev|crew' });
    expect(list.status).toBe(200);
    expect((list.body.data as J[]).some((c) => c.code === code && c.retired)).toBe(true);
  });

  it('lets staff list supervision bookings without HR permissions', async () => {
    const r = await call('GET', '/api/v1/supervision-bookings?status=BOOKED', { sub: 'dev|crew' });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    for (const b of r.body.data as J[]) expect(b.status).toBe('BOOKED');
  });
});

describe('H6 speak up', () => {
  it('gives an anonymous raiser a progress code that shows status and feedback', async () => {
    const raised = await call('POST', '/api/v1/speak-up', {
      sub: 'dev|crew',
      body: { category: 'BULLYING', summary: 'Workflow test anonymous concern', anonymous: true },
    });
    expect(raised.status).toBe(201);
    const progressCode = raised.body.progressCode as string;
    expect(progressCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const look = (code: string) =>
      call('GET', `/api/v1/speak-up/progress?code=${encodeURIComponent(code)}`, {
        sub: 'dev|crew',
      });
    const first = await look(progressCode);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'RECEIVED', feedback: null });
    expect((await look('AAAA-BBBB-CCCC')).status).toBe(404);

    const all = (await call('GET', '/api/v1/speak-up', { sub: 'dev|hr' })).body.data as J[];
    const c = all.find((x) => x.code === raised.body.code)!;
    const fb = await call('POST', `/api/v1/speak-up/${c.id}/progress-feedback`, {
      sub: 'dev|hr',
      body: { feedback: 'We have started looking into this.' },
    });
    expect(fb.status).toBe(201);
    const after = await look(progressCode.toLowerCase());
    expect(after.body.feedback).toBe('We have started looking into this.');
  });

  it('names the guardian, and hides small theme counts', async () => {
    const g = await call('GET', '/api/v1/speak-up/guardian', { sub: 'dev|crew' });
    expect(g.status).toBe(200);
    expect('guardianName' in g.body).toBe(true);
    const year = new Date().getFullYear();
    const themes = await call('GET', `/api/v1/speak-up/themes?quarter=${year}-Q1`, {
      sub: 'dev|hr',
    });
    expect(themes.status).toBe(200);
    for (const t of themes.body.themes as J[]) expect(typeof t.count).toBe('string');
    expect(
      (await call('GET', `/api/v1/speak-up/themes?quarter=${year}-Q1`, { sub: 'dev|crew' })).status,
    ).toBe(403);
    expect(
      (await call('GET', '/api/v1/speak-up/themes?quarter=2026-Q5', { sub: 'dev|hr' })).status,
    ).toBe(400);
  });
});
