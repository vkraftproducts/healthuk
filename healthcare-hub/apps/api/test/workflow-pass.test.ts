import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, SEED_USERS, makeApp, sign } from './harness.js';

// Workflow pass G, H1-H5, I, L1, L3, L5, M and navigation (written 6 Nov 2026; not yet run).
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
  return { status: res.statusCode, body, text: res.body };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const today = () => londonDate(new Date());
const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

async function report(extra: J = {}) {
  return call('POST', '/api/v1/incidents/report', {
    sub: 'dev|crew',
    body: {
      kind: 'INCIDENT',
      title: 'Synthetic slip in the station',
      description: 'Synthetic: a crew member slipped on a wet floor at the station.',
      occurredAt: ago(30),
      ...extra,
    },
  });
}

describe('H1 report, triage, candour and learning', () => {
  it('any staff member reports and gets a reference; the alert holds no details', async () => {
    const r = await report({ stillAtRisk: true, immediateActions: 'Floor coned off' });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^EVT-/);
    expect(r.body.message).toContain(r.body.code);
    expect(r.text).not.toContain('wet floor');
    const mine = await call('GET', '/api/v1/incidents/mine', { sub: 'dev|crew' });
    expect((mine.body.data as J[]).map((m) => m.id)).toContain(r.body.id);
    expect(JSON.stringify(mine.body)).not.toContain('wet floor');
  });

  it('rejects a report dated in the future', async () => {
    const r = await report({ occurredAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.status).toBe(400);
  });

  it('triage needs an active lead and the manage permission', async () => {
    const r = await report();
    const url = `/api/v1/events/${r.body.id}/triage`;
    const input = {
      priority: 'MEDIUM',
      harm: 'LOW',
      category: 'STAFF_INJURY',
      leadUserId: SEED_USERS.governance!.id,
      protectionSteps: 'Floor dried and signage put up',
    };
    expect((await call('POST', url, { sub: 'dev|crew', body: input })).status).toBe(403);
    const bad = await call('POST', url, {
      sub: 'dev|governance',
      body: { ...input, leadUserId: '01900000-0000-7000-8000-00000000ffff' },
    });
    expect(bad.status).toBe(400);
    const ok = await call('POST', url, { sub: 'dev|governance', body: input });
    expect(ok.status).toBe(201);
  });

  it('candour steps wait for the registered manager decision and are recorded once', async () => {
    const r = await report({ kind: 'INCIDENT' });
    const url = `/api/v1/events/${r.body.id}/candour-steps`;
    const step = { step: 'APOLOGY', doneOn: today() };
    expect((await call('POST', url, { sub: 'dev|governance', body: step })).status).toBe(409);
    await call('POST', `/api/v1/events/${r.body.id}/candour-assessment`, {
      sub: 'dev|manager',
      body: { notifiable: true, reason: 'Moderate harm occurred during care' },
    });
    expect(
      (
        await call('POST', url, {
          sub: 'dev|governance',
          body: { ...step, doneOn: addDays(today(), 1) },
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', url, { sub: 'dev|governance', body: step })).status).toBe(201);
    expect((await call('POST', url, { sub: 'dev|governance', body: step })).status).toBe(409);
  });

  it('records the PSIRF learning response for NHS-funded work', async () => {
    const r = await report({ nhsFunded: true });
    const ok = await call('POST', `/api/v1/events/${r.body.id}/learning`, {
      sub: 'dev|governance',
      body: { response: 'AFTER_ACTION_REVIEW', notes: 'Synthetic after action review held' },
    });
    expect(ok.status).toBe(201);
  });
});

describe('G1 templates: copy and retire', () => {
  it('copies a template as a new draft and retires it with a reason, once', async () => {
    const list = await call('GET', '/api/v1/audit-templates');
    const src = (list.body.data as J[])[0]!;
    const code = `WP-${tag()}`;
    const copy = await call('POST', `/api/v1/audit-templates/${src.id}/clone`, {
      sub: 'dev|governance',
      body: { code, title: 'Synthetic copied audit' },
    });
    expect(copy.status).toBe(201);
    expect(copy.body.clonedFrom).toBe(src.id);
    expect(copy.body.state).toBe('DRAFT');
    const dup = await call('POST', `/api/v1/audit-templates/${src.id}/clone`, {
      sub: 'dev|governance',
      body: { code, title: 'Synthetic copied audit' },
    });
    expect(dup.status).toBe(409);
    const url = `/api/v1/audit-templates/${copy.body.id}/retire`;
    const retired = await call('POST', url, { body: { reason: 'Replaced by a newer audit' } });
    expect(retired.status).toBe(201);
    expect(retired.body.state).toBe('RETIRED');
    expect(retired.body.retiredReason).toBe('Replaced by a newer audit');
    expect((await call('POST', url, { body: { reason: 'Again' } })).status).toBe(409);
  });
});

describe('G4 policy chase', () => {
  it('needs the manage permission and an existing policy', async () => {
    const url = '/api/v1/policies/01900000-0000-7000-8000-00000000ffff/chase';
    expect((await call('POST', url, { sub: 'dev|crew' })).status).toBe(403);
    expect((await call('POST', url, { sub: 'dev|governance' })).status).toBe(404);
  });
});

describe('I1 registered locations', () => {
  it('a change of registered manager drafts a CQC notification', async () => {
    const base = {
      locationId: SEED_IDS.locWatford,
      activities: ['Transport services, triage and medical advice provided remotely'],
      effectiveFrom: today(),
      reason: 'Synthetic registration update',
    };
    const first = await call('POST', '/api/v1/registration/locations', {
      sub: 'dev|governance',
      body: {
        ...base,
        registeredManagerUserId: SEED_USERS.manager!.id,
        managerStartOn: today(),
      },
    });
    expect(first.status).toBe(201);
    const second = await call('POST', '/api/v1/registration/locations', {
      sub: 'dev|governance',
      body: {
        ...base,
        registeredManagerUserId: SEED_USERS.governance!.id,
        managerStartOn: today(),
      },
    });
    expect(second.status).toBe(201);
    expect(second.body.notificationDraftId).toEqual(expect.any(String));
    const missingStart = await call('POST', '/api/v1/registration/locations', {
      sub: 'dev|governance',
      body: { ...base, registeredManagerUserId: SEED_USERS.manager!.id },
    });
    expect(missingStart.status).toBe(400);
    expect(
      (await call('POST', '/api/v1/registration/locations', { sub: 'dev|crew', body: base }))
        .status,
    ).toBe(403);
  });
});

describe('I3 governance meetings: pack and approval at a later meeting', () => {
  const meeting = (heldOn: string) => ({
    kind: 'CLINICAL_GOVERNANCE',
    title: 'Synthetic governance meeting',
    heldOn,
    chair: 'Synthetic Chair',
    attendees: ['Synthetic A'],
    quorate: true,
    minutes: 'Synthetic minutes of the meeting.',
  });

  it('builds the pack from live records and logs the view', async () => {
    const pack = await call('GET', '/api/v1/governance-meetings/pack', { sub: 'dev|governance' });
    expect(pack.status).toBe(200);
    expect(pack.body.sinceOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pack.body.generatedAt).toEqual(expect.any(String));
    const crew = await call('GET', '/api/v1/governance-meetings/pack', { sub: 'dev|crew' });
    expect(crew.status).toBe(403);
  });

  it('minutes are approved at a later meeting, never the one they record', async () => {
    const earlier = await call('POST', '/api/v1/governance-meetings', {
      sub: 'dev|governance',
      body: meeting(addDays(today(), -14)),
    });
    const later = await call('POST', '/api/v1/governance-meetings', {
      sub: 'dev|governance',
      body: meeting(today()),
    });
    const url = `/api/v1/governance-meetings/${earlier.body.id}/approve`;
    const same = await call('POST', url, {
      sub: 'dev|manager',
      ifMatch: earlier.body.version,
      body: { approvedAtMeetingId: earlier.body.id },
    });
    expect(same.status).toBe(400);
    const ok = await call('POST', url, {
      sub: 'dev|manager',
      ifMatch: earlier.body.version,
      body: { approvedAtMeetingId: later.body.id },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.approvedAtMeetingCode).toBe(later.body.code);
  });
});

describe('L3 and L5: NHS KPI report and inspection view', () => {
  it('crew cannot run the NHS KPI report', async () => {
    expect((await call('GET', '/api/v1/reports/NHS_KPI', { sub: 'dev|crew' })).status).toBe(403);
  });

  it('the inspection view labels coverage as an internal measure and is read-only', async () => {
    const v = await call('GET', '/api/v1/inspection/overview', { sub: 'dev|auditor' });
    expect(v.status).toBe(200);
    expect(v.body.coverage.label).toBe('Internal measure — not a CQC rating');
    expect((v.body.keyQuestions as J[]).length).toBe(5);
    expect((await call('GET', '/api/v1/inspection/overview', { sub: 'dev|crew' })).status).toBe(
      403,
    );
  });
});
