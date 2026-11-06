import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { LocalBlobStore, runPendingExports } from '@hub/domain';
import { addDays, addWorkingDays, londonDate } from '@hub/rules';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
const today = () => londonDate(new Date());
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  o: { sub?: string; org?: string; body?: unknown; ifMatch?: number } = {},
) {
  const token = await sign({ sub: o.sub ?? 'dev|manager' });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-org-id': o.org ?? ORG,
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
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
  return { status: res.statusCode, body, text: res.body, raw: res };
}
async function userId(email: string): Promise<string> {
  const { body } = await call('GET', '/api/v1/admin/users');
  return (body.data as J[]).find((u) => u.email === email)!.id as string;
}
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);
/** Uploads a clean file (no requirement link) and returns its evidence item id. */
async function evidenceItem(sub = 'dev|manager'): Promise<string> {
  const req = await call('POST', '/api/v1/evidence/uploads', {
    sub,
    body: { title: 'Cleaning log', mime: 'application/pdf', sizeBytes: PDF.length },
  });
  await app.inject({
    method: 'PUT',
    url: new URL(req.body.uploadUrl).pathname,
    headers: { 'content-type': 'application/pdf' },
    payload: PDF,
  });
  await call('POST', `/api/v1/evidence/${req.body.evidenceVersionId}/complete`, { sub });
  return req.body.evidenceItemId as string;
}

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  db = made.db;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('AUD-102 and corrective actions [UAT-04]', () => {
  it('shows AC-07 4 pass / 1 fail; evidence alone does not close ACT-218; verification by someone else does', async () => {
    const run = (await call('GET', `/api/v1/audit-runs/${SEED_IDS.auditRun102}`)).body;
    expect(run).toMatchObject({
      code: 'AUD-102',
      outcome: 'RED',
      outcomeReason: 'Action outstanding',
      status: 'ACTIONS_OPEN',
    });
    expect(run.findings[0]).toMatchObject({
      controlCode: 'AC-07',
      summary: '4 pass / 1 fail',
      result: 'NON_COMPLIANT',
    });
    expect(run.actions.map((a: J) => a.code)).toEqual(['ACT-218', 'ACT-219']);

    const item = await evidenceItem();
    const ev = await call('POST', `/api/v1/actions/${SEED_IDS.action218}/evidence`, {
      body: { evidenceItemIds: [item], note: 'Retraining record and corrected log' },
    });
    expect(ev.body.status).toBe('EVIDENCE_SUBMITTED');
    expect((await call('GET', `/api/v1/audit-runs/${SEED_IDS.auditRun102}`)).body).toMatchObject({
      outcome: 'RED',
      status: 'ACTIONS_OPEN',
    });

    const self = await call('POST', `/api/v1/actions/${SEED_IDS.action218}/verify`, {
      body: { decision: 'ACCEPTED', reason: 'Looks done' },
    });
    expect([self.status, self.body.code]).toEqual([422, 'SELF_APPROVAL']);
    expect(
      (
        await call('POST', `/api/v1/actions/${SEED_IDS.action218}/verify`, {
          sub: 'dev|hr',
          body: { decision: 'ACCEPTED', reason: 'Checked' },
        })
      ).status,
    ).toBe(403);
    const ok = await call('POST', `/api/v1/actions/${SEED_IDS.action218}/verify`, {
      sub: 'dev|governance',
      body: { decision: 'ACCEPTED', reason: 'Retraining evidence and log checked' },
    });
    expect(ok.body).toMatchObject({ status: 'VERIFIED', verifierUserId: expect.any(String) });
    expect(ok.body.history.map((h: J) => h.toStatus)).toEqual([
      'OPEN',
      'EVIDENCE_SUBMITTED',
      'VERIFIED',
    ]);

    const after = (await call('GET', `/api/v1/audit-runs/${SEED_IDS.auditRun102}`)).body;
    expect(after.findings[0].summary).toBe('4 pass / 1 fail'); // original audit unchanged
    expect(after.responses).toHaveLength(5);
    // The re-audit (ACT-219) is closed only by completing AUD-103.
    const re = await call('POST', `/api/v1/actions/${SEED_IDS.action219}/verify`, {
      sub: 'dev|governance',
      body: { decision: 'ACCEPTED', reason: 'Re-audit done?' },
    });
    expect(re.status).toBe(409);
    expect(
      (
        await call('POST', `/api/v1/actions/${SEED_IDS.action219}/evidence`, {
          body: { evidenceItemIds: [item] },
        })
      ).status,
    ).toBe(409);
  });
});

describe('actions list', () => {
  it('names the audit run behind each action raised from a finding', async () => {
    const rows = (await call('GET', '/api/v1/actions')).body.data as J[];
    const fromFindings = rows.filter((a) => a.sourceType === 'FINDING');
    expect(fromFindings.length).toBeGreaterThan(0);
    for (const a of fromFindings) {
      const audit = await call('GET', `/api/v1/audit-runs/${a.auditRunId}`);
      expect(audit.status).toBe(200);
      expect((audit.body.findings as J[]).map((f) => f.id)).toContain(a.sourceId);
    }
  });
});

describe('audit builder, runs and sampling [AUD-01, AUD-02]', () => {
  it('drafts need a second person to publish and management to activate before they can run', async () => {
    const code = `AUD-T${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const t = await call('POST', '/api/v1/audit-templates', {
      sub: 'dev|governance',
      body: {
        code,
        title: 'Hand hygiene',
        domain: 'SAFE',
        version: {
          controls: [
            {
              code: 'HH-1',
              question: 'Hand hygiene observed before patient contact',
              critical: true,
            },
            { code: 'HH-2', question: 'Gel available on vehicle' },
          ],
          methods: ['OBSERVATION', 'RECORDS'],
        },
      },
    });
    expect(t.status).toBe(201);
    const v = t.body.versions[0];
    expect(
      (
        await call('POST', `/api/v1/audit-templates/${t.body.id}/versions/${v.id}/publish`, {
          sub: 'dev|governance',
        })
      ).body.code,
    ).toBe('FOUR_EYES_REQUIRED');
    expect(
      (await call('POST', `/api/v1/audit-templates/${t.body.id}/versions/${v.id}/publish`)).status,
    ).toBe(201);
    const gov = await userId('governance@example.test');
    const mgr = await userId('manager@example.test');
    const runBody = {
      templateVersionId: v.id,
      title: 'Hand hygiene October',
      auditorUserId: gov,
      ownerUserId: mgr,
      dueDate: addDays(today(), 14),
    };
    expect(
      (await call('POST', '/api/v1/audit-runs', { sub: 'dev|governance', body: runBody })).status,
    ).toBe(422); // inactive
    const published = (await call('GET', '/api/v1/audit-templates')).body.data.find(
      (x: J) => x.id === t.body.id,
    );
    expect(published.versions[0]).toMatchObject({
      status: 'PUBLISHED',
      createdByName: expect.any(String),
      approvedByName: expect.any(String),
    });
    // The author cannot also give the management approval (task 9).
    expect(
      (
        await call('POST', `/api/v1/audit-templates/${t.body.id}/activate`, {
          sub: 'dev|governance',
        })
      ).body.code,
    ).toBe('FOUR_EYES_REQUIRED');
    expect((await call('POST', `/api/v1/audit-templates/${t.body.id}/activate`)).status).toBe(201);
    expect((await call('POST', `/api/v1/audit-templates/${t.body.id}/activate`)).status).toBe(409);
    const run = await call('POST', '/api/v1/audit-runs', { sub: 'dev|governance', body: runBody });
    expect(run.status).toBe(201);
    expect(run.body.code).toMatch(/^AUD-\d+$/);
    expect(run.body).toMatchObject({
      auditorName: expect.any(String),
      ownerName: expect.any(String),
      overdue: false,
    });

    const staff = [SEED_IDS.staffCrew, SEED_IDS.staffCrew2];
    const sample = {
      populationDesc: 'All active crew',
      selectionMethod: 'Random two',
      dateFrom: addDays(today(), -30),
      dateTo: today(),
      subjectType: 'STAFF',
      subjectIds: staff,
    };
    expect(
      (
        await call('POST', `/api/v1/audit-runs/${run.body.id}/samples`, {
          sub: 'dev|governance',
          body: sample,
        })
      ).status,
    ).toBe(201);
    const resp = (code2: string, subjectId: string, result: string, note?: string) => ({
      controlCode: code2,
      subjectId,
      result,
      method: 'OBSERVATION',
      ...(note ? { note } : {}),
    });
    expect(
      (
        await call('POST', `/api/v1/audit-runs/${run.body.id}/responses`, {
          sub: 'dev|governance',
          body: { responses: [resp('HH-1', staff[0]!, 'NON_COMPLIANT')] },
        })
      ).status,
    ).toBe(400); // note needed
    expect(
      (
        await call('POST', `/api/v1/audit-runs/${run.body.id}/responses`, {
          sub: 'dev|governance',
          body: { responses: [{ controlCode: 'HH-1', result: 'COMPLIANT', method: 'INTERVIEW' }] },
        })
      ).status,
    ).toBe(400); // method not used
    await call('POST', `/api/v1/audit-runs/${run.body.id}/responses`, {
      sub: 'dev|governance',
      body: {
        responses: [
          resp('HH-1', staff[0]!, 'COMPLIANT'),
          resp('HH-1', staff[1]!, 'NON_COMPLIANT', 'No hand hygiene before transfer'),
        ],
      },
    });
    const during = await call('GET', `/api/v1/audit-runs/${run.body.id}`, {
      sub: 'dev|governance',
    });
    expect(during.body.methods).toEqual(['OBSERVATION', 'RECORDS']);
    expect(during.body.status).toBe('IN_PROGRESS');
    expect((during.body.responses as J[]).every((r) => typeof r.recordedByName === 'string')).toBe(
      true,
    );
    // Every control must be answered before submitting (WORKFLOWS G2).
    const early = await call('POST', `/api/v1/audit-runs/${run.body.id}/submit`, {
      sub: 'dev|governance',
    });
    expect([early.status, early.body.detail]).toEqual([400, expect.stringMatching(/HH-2/)]);
    await call('POST', `/api/v1/audit-runs/${run.body.id}/responses`, {
      sub: 'dev|governance',
      body: { responses: [resp('HH-2', staff[0]!, 'NOT_ASSESSED', 'Vehicle off site')] },
    });
    const submitted = await call('POST', `/api/v1/audit-runs/${run.body.id}/submit`, {
      sub: 'dev|governance',
    });
    // The failed critical control raised a draft action straight away, owned by the audit owner.
    expect(submitted.body).toMatchObject({
      status: 'ACTIONS_OPEN',
      outcome: 'RED',
      outcomeReason: 'Action outstanding',
      overall: { result: 'NON_COMPLIANT', text: 'Non-compliant: a critical control failed' },
    });
    expect(submitted.body.actions).toHaveLength(1);
    expect(submitted.body.actions[0]).toMatchObject({ ownerUserId: mgr, severity: 'CRITICAL' });
    const f = submitted.body.findings as J[];
    expect(f.find((x) => x.controlCode === 'HH-1')).toMatchObject({
      summary: '1 pass / 1 fail',
      severity: 'CRITICAL',
    });
    expect(f.find((x) => x.controlCode === 'HH-2')).toMatchObject({ result: 'NOT_ASSESSED' });
    expect(
      (
        await call('POST', `/api/v1/audit-runs/${run.body.id}/responses`, {
          sub: 'dev|governance',
          body: { responses: [resp('HH-2', staff[0]!, 'COMPLIANT')] },
        })
      ).status,
    ).toBe(409);

    const hh1 = f.find((x) => x.controlCode === 'HH-1')!;
    const act = await call('POST', `/api/v1/findings/${hh1.id}/actions`, {
      sub: 'dev|governance',
      body: { title: 'Refresher on hand hygiene', ownerUserId: mgr, deadline: addDays(today(), 7) },
    });
    expect(act.body).toMatchObject({
      status: 'OPEN',
      severity: 'CRITICAL',
      code: expect.stringMatching(/^ACT-/),
    });
    expect((await call('GET', `/api/v1/audit-runs/${run.body.id}`)).body).toMatchObject({
      outcome: 'RED',
      outcomeReason: 'Action outstanding',
    });

    // AUD-02: sampling the same people again needs a reason
    const run2 = await call('POST', '/api/v1/audit-runs', {
      sub: 'dev|governance',
      body: { ...runBody, title: 'Hand hygiene November' },
    });
    const again = await call('POST', `/api/v1/audit-runs/${run2.body.id}/samples`, {
      sub: 'dev|governance',
      body: sample,
    });
    expect(again.status).toBe(400);
    const withReason = await call('POST', `/api/v1/audit-runs/${run2.body.id}/samples`, {
      sub: 'dev|governance',
      body: { ...sample, repeatReason: 'Follow-up on last month’s failure' },
    });
    expect(withReason.body.samples[0].repeatWarning).toHaveLength(2);
  });
});

describe('policies and acknowledgement [COMP-04]', () => {
  it('needs a second approver, tracks acknowledgement by version, and forces re-acknowledgement on material change', async () => {
    const mgr = await userId('manager@example.test');
    const code = `POL-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const p = await call('POST', '/api/v1/policies', {
      sub: 'dev|governance',
      body: {
        code,
        title: 'Infection prevention',
        ownerUserId: mgr,
        readerRoles: ['CREW'],
        summary: 'Initial issue',
      },
    });
    expect(p.status).toBe(201);
    const v1 = p.body.versions[0].id;
    const move = (to: string, sub = 'dev|manager', vid = v1) =>
      call('POST', `/api/v1/policies/${p.body.id}/versions/${vid}/transition`, {
        sub,
        body: { to },
      });
    expect((await move('APPROVED')).status).toBe(422);
    await move('IN_REVIEW', 'dev|governance');
    expect((await move('APPROVED', 'dev|governance')).body.code).toBe('FOUR_EYES_REQUIRED');
    await move('APPROVED');
    const pub = await move('PUBLISHED');
    expect(pub.body.currentVersion).toMatchObject({
      version: 1,
      effectiveFrom: today(),
      reviewOverdue: false,
      documentEvidenceVersionId: null,
    });
    expect(pub.body.acknowledgement.required).toBeGreaterThanOrEqual(1);
    // Names for the people involved [task 10].
    expect(pub.body.ownerName).toEqual(expect.any(String));
    expect(pub.body.versions[0]).toMatchObject({
      createdByName: expect.any(String),
      approvedByName: expect.any(String),
      approvedAt: expect.any(String),
    });
    const crewId = await userId('crew@example.test');
    const readers = async () =>
      (await call('GET', `/api/v1/policies/${p.body.id}/readers`)).body.data as J[];
    expect((await readers()).find((r) => r.userId === crewId)).toMatchObject({
      state: 'REQUIRED',
      acknowledgedAt: null,
    });
    expect(
      (await call('GET', `/api/v1/policies/${p.body.id}/readers`, { sub: 'dev|crew' })).status,
    ).toBe(403);

    const mine = (await call('GET', `/api/v1/policies/${p.body.id}`, { sub: 'dev|crew' })).body;
    expect(mine.myAcknowledgement).toBe('REQUIRED');
    expect(
      (
        await call('POST', `/api/v1/policies/${p.body.id}/acknowledge`, {
          sub: 'dev|crew',
          body: { device: 'Synthetic phone' },
        })
      ).body.myAcknowledgement,
    ).toBe('CURRENT');
    expect((await readers()).find((r) => r.userId === crewId)).toMatchObject({
      state: 'CURRENT',
      acknowledgedAt: expect.any(String),
    });
    expect(
      (await call('GET', `/api/v1/policies/${p.body.id}`, { sub: 'dev|dispatcher' })).status,
    ).toBe(404); // not a reader

    // Minor change: acknowledgement carries forward
    const v2 = await call('POST', `/api/v1/policies/${p.body.id}/versions`, {
      sub: 'dev|governance',
      body: { summary: 'Typo fixes', material: false },
    });
    const v2id = v2.body.versions[0].id;
    await move('IN_REVIEW', 'dev|governance', v2id);
    await move('APPROVED', 'dev|manager', v2id);
    await move('PUBLISHED', 'dev|manager', v2id);
    expect(
      (await call('GET', `/api/v1/policies/${p.body.id}`, { sub: 'dev|crew' })).body
        .myAcknowledgement,
    ).toBe('CARRIED_FORWARD');
    // Material change: everyone must re-acknowledge
    const v3 = await call('POST', `/api/v1/policies/${p.body.id}/versions`, {
      sub: 'dev|governance',
      body: { summary: 'New PPE requirement', material: true },
    });
    const v3id = v3.body.versions[0].id;
    await move('IN_REVIEW', 'dev|governance', v3id);
    await move('APPROVED', 'dev|manager', v3id);
    const final = await move('PUBLISHED', 'dev|manager', v3id);
    expect(final.body.versions.map((v: J) => v.status)).toEqual([
      'PUBLISHED',
      'SUPERSEDED',
      'SUPERSEDED',
    ]);
    expect(
      (await call('GET', `/api/v1/policies/${p.body.id}`, { sub: 'dev|crew' })).body
        .myAcknowledgement,
    ).toBe('REQUIRED');
  });

  it('a critical instruction needs explicit confirmation on the web route too [task 10]', async () => {
    const mgr = await userId('manager@example.test');
    const code = `CRI-${Date.now().toString(36).toUpperCase().slice(-5)}`;
    const p = await call('POST', '/api/v1/policies', {
      sub: 'dev|governance',
      body: {
        code,
        title: 'Oxygen cylinder handling',
        category: 'CRITICAL_INSTRUCTION',
        ownerUserId: mgr,
        readerRoles: ['CREW'],
        summary: 'Secure cylinders before moving',
      },
    });
    const vid = p.body.versions[0].id;
    for (const to of ['IN_REVIEW', 'APPROVED', 'PUBLISHED'])
      await call('POST', `/api/v1/policies/${p.body.id}/versions/${vid}/transition`, {
        sub: to === 'IN_REVIEW' ? 'dev|governance' : 'dev|manager',
        body: { to },
      });
    const ack = (body: J) =>
      call('POST', `/api/v1/policies/${p.body.id}/acknowledge`, { sub: 'dev|crew', body });
    expect((await ack({})).status).toBe(400);
    expect((await ack({ confirmCritical: true })).body.myAcknowledgement).toBe('CURRENT');
  });
});

describe('risk actions and action changes [COMP-03, COMP-04]', () => {
  it('names owners, counts open actions and records reassignment in history', async () => {
    const mgr = await userId('manager@example.test');
    const gov = await userId('governance@example.test');
    const r = await call('POST', '/api/v1/risks', {
      body: {
        hazard: 'Vehicle reversing in depot',
        peopleAffected: 'Crew and visitors',
        inherentLikelihood: 3,
        inherentImpact: 5,
        controls: 'Banksman for reversing',
        residualLikelihood: 2,
        residualImpact: 5,
        ownerUserId: mgr,
        reviewDate: addDays(today(), 30),
      },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ ownerName: expect.any(String), openActions: 0 });
    const a = await call('POST', `/api/v1/risks/${r.body.id}/actions`, {
      body: { title: 'Fit reversing cameras', ownerUserId: mgr, deadline: addDays(today(), 14) },
    });
    expect(a.status).toBe(201);
    const list = await call('GET', '/api/v1/risks');
    expect((list.body.data as J[]).find((x) => x.id === r.body.id)?.openActions).toBe(1);

    const change = (body: J, ifMatch = a.body.version, sub = 'dev|manager') =>
      call('PATCH', `/api/v1/actions/${a.body.id}`, { sub, body, ifMatch });
    expect((await change({ ownerUserId: gov })).status).toBe(400); // reason required
    expect((await change({ reason: 'nothing to change' })).status).toBe(400);
    expect((await change({ deadline: addDays(today(), -1), reason: 'too late' })).status).toBe(400);
    const crew = await change(
      { ownerUserId: gov, reason: 'Fleet lead' },
      a.body.version,
      'dev|crew',
    );
    expect(crew.status).toBe(403);
    const moved = await change({
      ownerUserId: gov,
      deadline: addDays(today(), 21),
      reason: 'Fleet lead owns cameras',
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ ownerUserId: gov, ownerName: expect.any(String) });
    const last = (moved.body.history as J[]).at(-1)!;
    expect(last.note).toMatch(/owner changed; deadline moved .*Fleet lead owns cameras/);
    expect(last.byName).toEqual(expect.any(String));
    expect((await change({ deadline: addDays(today(), 28), reason: 'stale' })).status).toBe(409);
  });
});

describe('risks, registration and correspondence [COMP-03]', () => {
  it('rates risks on the 5x5 matrix and keeps the registration record', async () => {
    const mgr = await userId('manager@example.test');
    const r = await call('POST', '/api/v1/risks', {
      body: {
        hazard: 'Manual handling on stairs',
        peopleAffected: 'Crew and patients',
        inherentLikelihood: 4,
        inherentImpact: 4,
        controls: 'Carry chairs, two-person lifts',
        residualLikelihood: 2,
        residualImpact: 4,
        ownerUserId: mgr,
        reviewDate: addDays(today(), -1),
      },
    });
    expect(r.body).toMatchObject({
      inherent: { score: 16, rating: 'HIGH' },
      residual: { score: 8, rating: 'MEDIUM' },
      reviewOverdue: true,
      code: expect.stringMatching(/^RSK-/),
    });
    const u = await call('PATCH', `/api/v1/risks/${r.body.id}`, {
      body: { reviewDate: addDays(today(), 90) },
      ifMatch: r.body.version,
    });
    expect(u.body.reviewOverdue).toBe(false);
    // The review date change is kept as a review; the band is shown in words with the score.
    expect(u.body).toMatchObject({ bandText: 'Medium 8' });
    expect(u.body.reviews).toHaveLength(1);
    // Closing needs a reason (WORKFLOWS H4).
    expect(
      (
        await call('PATCH', `/api/v1/risks/${r.body.id}`, {
          body: { status: 'CLOSED' },
          ifMatch: u.body.version,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('PATCH', `/api/v1/risks/${r.body.id}`, {
          body: { status: 'CLOSED', reason: 'Hazard removed' },
          ifMatch: r.body.version,
        })
      ).status,
    ).toBe(409);
    expect((await call('POST', '/api/v1/risks', { sub: 'dev|hr', body: {} })).status).toBe(403);

    const reg = await call('POST', '/api/v1/registration', {
      body: {
        providerRef: '1-000000001',
        registeredManagerUserId: mgr,
        conditions: 'Transport services only',
      },
    });
    expect(reg.body).toMatchObject({
      providerRef: '1-000000001',
      conditions: 'Transport services only',
    });
    const c = await call('POST', '/api/v1/regulatory-correspondence', {
      body: {
        regulator: 'CQC',
        subject: 'Request for information',
        receivedOn: addDays(today(), -10),
        deadline: addDays(today(), -1),
        ownerUserId: mgr,
      },
    });
    expect(c.body.overdue).toBe(true);
    const done = await call('PATCH', `/api/v1/regulatory-correspondence/${c.body.id}`, {
      body: { status: 'RESPONDED' },
      ifMatch: c.body.version,
    });
    expect(done.body).toMatchObject({ status: 'RESPONDED', overdue: false, respondedOn: today() });
  });
});

describe('events, reporting duties and candour [EVT-01..04]', () => {
  it('a harmful incident cannot leave assessment until every reporting duty and the candour question are decided', async () => {
    const gov = await userId('governance@example.test');
    const e = await call('POST', '/api/v1/events', {
      sub: 'dev|governance',
      body: {
        types: ['INCIDENT'],
        title: 'Patient fall during transfer',
        description: 'Synthetic description',
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        severity: 'MODERATE',
        leadUserId: gov,
        links: [{ type: 'VEHICLE', id: SEED_IDS.vehicleAmb1 }],
      },
    });
    expect(e.status).toBe(201);
    expect(e.body).toMatchObject({
      status: 'TRIAGE',
      candourFlag: true,
      code: expect.stringMatching(/^EVT-/),
    });
    const step = (to: string, sub = 'dev|governance') =>
      call('POST', `/api/v1/events/${e.body.id}/transition`, {
        sub,
        body: { to, note: `Moving to ${to}` },
      });
    expect((await step('ASSESS')).status).toBe(422); // one step at a time
    await step('PROTECT');
    await step('ASSESS');
    const ob = await call('POST', `/api/v1/events/${e.body.id}/obligations`, {
      sub: 'dev|governance',
      body: {
        body: 'CQC',
        trigger: 'Injury to a person using the service',
        basis: 'Registration Regulations 2009 reg 18',
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(ob.body.decision).toBe('PENDING');
    expect((await step('INVESTIGATE')).body.detail).toMatch(/reporting obligation/);
    expect(
      (
        await call('PATCH', `/api/v1/obligations/${ob.body.id}`, {
          sub: 'dev|governance',
          body: { decision: 'REQUIRED' },
          ifMatch: ob.body.version,
        })
      ).status,
    ).toBe(400);
    const decided = await call('PATCH', `/api/v1/obligations/${ob.body.id}`, {
      sub: 'dev|governance',
      body: { decision: 'REQUIRED', decisionReason: 'Moderate harm to a service user' },
      ifMatch: ob.body.version,
    });
    expect(decided.body.decision).toBe('REQUIRED');
    expect((await step('INVESTIGATE')).body.detail).toMatch(/candour/);
    expect(
      (
        await call('POST', `/api/v1/events/${e.body.id}/candour-assessment`, {
          sub: 'dev|hr',
          body: { notifiable: true, reason: 'Moderate harm occurred' },
        })
      ).status,
    ).toBe(403);
    // Duty of candour is decided by the registered manager (WORKFLOWS H1), not the governance lead.
    expect(
      (
        await call('POST', `/api/v1/events/${e.body.id}/candour-assessment`, {
          sub: 'dev|governance',
          body: { notifiable: true, reason: 'Moderate harm occurred during care' },
        })
      ).status,
    ).toBe(403);
    await call('POST', `/api/v1/events/${e.body.id}/candour-assessment`, {
      sub: 'dev|manager',
      body: { notifiable: true, reason: 'Moderate harm occurred during care' },
    });
    expect((await step('INVESTIGATE')).status).toBe(201);
    const sub = await call('PATCH', `/api/v1/obligations/${ob.body.id}`, {
      sub: 'dev|governance',
      body: { submittedAt: new Date().toISOString(), reference: 'SYN-0001' },
      ifMatch: decided.body.version,
    });
    expect(sub.body).toMatchObject({ reference: 'SYN-0001', overdue: false });

    await step('RESPOND');
    await step('ACTIONS');
    const mgr = await userId('manager@example.test');
    const a = await call('POST', `/api/v1/events/${e.body.id}/actions`, {
      sub: 'dev|governance',
      body: {
        title: 'Review transfer technique',
        ownerUserId: mgr,
        deadline: addDays(today(), 10),
      },
    });
    expect(a.body.severity).toBe('HIGH');
    expect((await step('LEARNING_VERIFIED')).body.detail).toMatch(/Actions must be verified/);
    const detail = (await call('GET', `/api/v1/events/${e.body.id}`, { sub: 'dev|governance' }))
      .body;
    expect(detail.transitions.map((t: J) => t.toStatus)).toEqual([
      'TRIAGE',
      'PROTECT',
      'ASSESS',
      'INVESTIGATE',
      'RESPOND',
      'ACTIONS',
    ]);
    expect(detail.candour[0]).toMatchObject({ notifiable: true });
    // Names and the candour state for the screens [task 11].
    expect(detail).toMatchObject({ leadName: expect.any(String), candourDecided: true });
    expect(detail.candour[0].decidedByName).toEqual(expect.any(String));
    expect(detail.transitions.every((t: J) => typeof t.byName === 'string')).toBe(true);
    expect(detail.obligations[0]).toMatchObject({
      decidedByName: expect.any(String),
      reference: 'SYN-0001',
    });
    const listed = (
      await call('GET', '/api/v1/events?open=true', { sub: 'dev|governance' })
    ).body.data.find((x: J) => x.id === e.body.id);
    expect(listed).toMatchObject({ candourFlag: true, candourDecided: true });
    const closed = (await call('GET', '/api/v1/events?open=false', { sub: 'dev|governance' })).body
      .data as J[];
    expect(closed.every((x) => x.status === 'CLOSED')).toBe(true);
  });

  it('complaints get acknowledgement and response targets; safeguarding is restricted', async () => {
    const gov = await userId('governance@example.test');
    const c = await call('POST', '/api/v1/events', {
      sub: 'dev|governance',
      body: {
        types: ['COMPLAINT'],
        title: 'Late collection',
        description: 'Synthetic complaint',
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
        severity: 'NO_HARM',
        leadUserId: gov,
        complaint: { receivedOn: today(), channel: 'EMAIL' },
      },
    });
    // Default targets: 3 and 20 working days (WORKFLOWS H2).
    expect(c.body.complaint).toMatchObject({
      acknowledgeBy: addWorkingDays(today(), 3),
      respondBy: addWorkingDays(today(), 20),
      acknowledgeOverdue: false,
      respondOverdue: false,
      preferences: null,
    });
    expect(
      (
        await call('POST', '/api/v1/events', {
          sub: 'dev|governance',
          body: {
            types: ['COMPLAINT'],
            title: 'x x',
            description: 'x x',
            occurredAt: new Date().toISOString(),
            severity: 'NO_HARM',
            leadUserId: gov,
          },
        })
      ).status,
    ).toBe(400);

    const s = await call('POST', '/api/v1/events', {
      sub: 'dev|governance',
      body: {
        types: ['SAFEGUARDING'],
        title: 'Safeguarding concern',
        description: 'See restricted case',
        occurredAt: new Date(Date.now() - 7_200_000).toISOString(),
        severity: 'LOW',
        leadUserId: gov,
        safeguarding: { details: 'Synthetic restricted details', referralRef: 'SG-SYN-1' },
      },
    });
    expect(s.body.safeguarding).toMatchObject({ referralRef: 'SG-SYN-1' });
    const auditorList = (await call('GET', '/api/v1/events', { sub: 'dev|auditor' })).body
      .data as J[];
    expect(auditorList.some((x) => x.id === s.body.id)).toBe(false);
    expect(auditorList.some((x) => x.id === c.body.id)).toBe(true);
    expect((await call('GET', `/api/v1/events/${s.body.id}`, { sub: 'dev|auditor' })).status).toBe(
      404,
    );
    const log = (await call('GET', '/api/v1/audit-log?limit=100')).body.data as J[];
    expect(JSON.stringify(log)).not.toContain('Synthetic restricted details');
  });
});

describe('premises register [HSE-01]', () => {
  it('links premises items to requirements, with reasoned not-applicable decisions', async () => {
    const mgr = await userId('manager@example.test');
    const t = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `FRA-${Date.now().toString(36).toUpperCase()}`,
        title: 'Fire risk assessment',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'PREMISES',
          recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
          blocking: 'STATUTORY',
          deadlineKind: 'DUE',
        },
      },
    });
    await call(
      'POST',
      `/api/v1/requirements/templates/${t.body.id}/versions/${t.body.versions[0].id}/publish`,
    );
    const item = await call('POST', '/api/v1/premises-items', {
      body: {
        locationId: SEED_IDS.locWatford,
        controlArea: 'FIRE',
        title: 'Fire risk assessment – Watford base',
        responsibleUserId: mgr,
        frequencySource: 'Competent person advice (Synthetic Fire Ltd)',
        templateId: t.body.id,
      },
    });
    expect(item.body).toMatchObject({ status: 'GREY', requirementInstanceId: expect.any(String) });
    expect(
      (
        await call('POST', `/api/v1/premises-items/${item.body.id}/applicability`, {
          body: { applicable: false, reason: 'short' },
        })
      ).status,
    ).toBe(400);
    const na = await call('POST', `/api/v1/premises-items/${item.body.id}/applicability`, {
      body: { applicable: false, reason: 'Base closed for refurbishment until spring' },
    });
    expect(na.body).toMatchObject({ status: 'NOT_APPLICABLE', applicable: false });
    expect((await call('GET', '/api/v1/premises-items', { sub: 'dev|crew' })).status).toBe(403);
  });

  it('records contractor, assessment and action owner, and shows them back', async () => {
    const mgr = await userId('manager@example.test');
    const item = await call('POST', '/api/v1/premises-items', {
      body: {
        locationId: SEED_IDS.locWatford,
        controlArea: 'WATER',
        title: 'Water system risk assessment – Watford base',
        responsibleUserId: mgr,
        actionOwnerUserId: mgr,
        contractorName: 'Synthetic Water Services Ltd',
        assessmentRef: 'WRA-2026-01',
        assessedOn: '2026-09-15',
        frequencySource: 'Competent person assessment (Synthetic Water Services Ltd)',
      },
    });
    expect(item.status).toBe(201);
    expect(item.body).toMatchObject({
      contractorName: 'Synthetic Water Services Ltd',
      assessmentRef: 'WRA-2026-01',
      assessedOn: '2026-09-15',
      actionOwnerUserId: mgr,
      evidenceCount: 0,
    });
    // The action owner must belong to the organisation.
    const bad = await call('POST', '/api/v1/premises-items', {
      body: {
        locationId: SEED_IDS.locWatford,
        controlArea: 'WATER',
        title: 'Water system risk assessment – other',
        responsibleUserId: mgr,
        actionOwnerUserId: '01900000-0000-7000-8000-0000000000ff',
        frequencySource: 'Competent person assessment',
      },
    });
    expect(bad.status).toBe(400);
  });
});

describe('feedback, surveys and themes [EVT-04]', () => {
  it('records feedback, analyses themes with complaints, and raises an action', async () => {
    const mgr = await userId('manager@example.test');
    const theme = `punctuality-${Date.now().toString(36)}`;
    const fb = await call('POST', '/api/v1/feedback', {
      body: {
        kind: 'PATIENT_SURVEY',
        receivedOn: '2026-10-30',
        source: 'Post-journey survey, October',
        summary: 'Collected on time but the return journey was late',
        rating: 3,
        themes: [theme.toUpperCase()],
      },
    });
    expect(fb.status).toBe(201);
    expect(fb.body).toMatchObject({ kind: 'PATIENT_SURVEY', themes: [theme], openActions: 0 });
    const future = await call('POST', '/api/v1/feedback', {
      body: { kind: 'COMPLIMENT', receivedOn: '2099-01-01', source: 'Card', summary: 'Thank you' },
    });
    expect(future.status).toBe(400);
    const th = await call('GET', '/api/v1/feedback/themes?from=2026-10-01&to=2026-11-04');
    const row = th.body.themes.find((x: { theme: string }) => x.theme === theme);
    expect(row).toMatchObject({ patientSurveys: 1, total: 1, averageRating: 3 });
    const act = await call('POST', `/api/v1/feedback/${fb.body.id}/actions`, {
      body: { title: 'Review return-journey scheduling', ownerUserId: mgr, deadline: '2026-12-01' },
    });
    expect(act.status).toBe(201);
    expect(act.body).toMatchObject({
      sourceType: 'FEEDBACK',
      sourceId: fb.body.id,
      status: 'OPEN',
    });
    const list = await call('GET', '/api/v1/feedback?kind=PATIENT_SURVEY');
    expect(list.body.data.find((x: { id: string }) => x.id === fb.body.id).openActions).toBe(1);
    // The dashboard names the owner instead of just "Assigned" (task 8).
    const dash = (await call('GET', '/api/v1/dashboard/actions?module=COMPLIANCE')).body
      .data as J[];
    expect(dash.find((r) => r.key === `ACT:${act.body.id}`)).toMatchObject({
      ownerUserId: mgr,
      ownerName: expect.any(String),
    });
    // Crew have no access to feedback.
    expect((await call('GET', '/api/v1/feedback', { sub: 'dev|crew' })).status).toBe(403);
  });
});

describe('dashboard [DASH-01, UAT-08]', () => {
  it('every tile equals the rows in its drill-down; colours come with words', async () => {
    const s = (await call('GET', '/api/v1/dashboard/summary')).body;
    for (const tile of [
      'overdue',
      'dueSoon',
      'blockedVehicles',
      'unverified',
      'jobsToday',
    ] as const) {
      const rows = (await call('GET', `/api/v1/dashboard/actions?tile=${tile}`)).body.data as J[];
      expect(rows.length, tile).toBe(s.tiles[tile]);
    }
    expect(s.tiles.blockedVehicles).toBeGreaterThanOrEqual(1); // AMB-03 seeded ramp defect
    for (const [tile, n] of [
      ['awaitingAllocation', s.operations.jobsAwaitingAllocation],
      ['acknowledgementsDue', s.operations.acknowledgementsDue],
    ] as const)
      expect(
        (await call('GET', `/api/v1/dashboard/actions?tile=${tile}`)).body.data,
        tile,
      ).toHaveLength(n);
    expect(s.sources).toContainEqual({ name: 'jobs', ok: true });
    expect(s.coverage.label).toBe('Internal measure — not a CQC rating');
    expect(s.modules.find((m: J) => m.module === 'FLEET')).toMatchObject({
      status: 'RED',
      label: 'blocked',
    });
    const all = (await call('GET', '/api/v1/dashboard/actions')).body.data as J[];
    const amb3 = all.find((r) => r.key === `VEH:${SEED_IDS.vehicleAmb3}`)!;
    expect(amb3).toMatchObject({ status: 'RED', reasonText: expect.stringContaining('Blocked') });
    // WORKFLOWS L1: its open critical defect is also listed, as a critical finding.
    expect(
      all.find((r) => r.key.startsWith('DEF:') && r.link.id === SEED_IDS.vehicleAmb3),
    ).toMatchObject({ status: 'RED', reasonText: expect.stringContaining('Critical defect') });
    expect(all.every((r) => typeof r.reasonText === 'string' && r.reasonText.length > 0)).toBe(
      true,
    );
    const csv = await call('GET', '/api/v1/dashboard/actions/export?tile=blockedVehicles');
    expect(csv.text.split('\r\n')[0]).toBe('Module,Item,Owner,Owner id,Deadline,State,Reason');
    expect(
      (await call('GET', '/api/v1/dashboard/actions/export', { sub: 'dev|dispatcher' })).status,
    ).toBe(403);
    expect((await call('GET', '/api/v1/dashboard/summary', { sub: 'dev|crew' })).status).toBe(403);
  });
});

describe('dashboard filters and group view [DASH-01]', () => {
  const TILES = ['overdue', 'dueSoon', 'blockedVehicles', 'unverified', 'jobsToday'] as const;
  const countsMatch = async (qs: string) => {
    const s = (await call('GET', `/api/v1/dashboard/summary${qs}`)).body;
    for (const tile of TILES) {
      const sep = qs ? '&' : '?';
      const rows = (await call('GET', `/api/v1/dashboard/actions${qs}${sep}tile=${tile}`)).body
        .data as J[];
      expect(rows.length, `${qs} ${tile}`).toBe(s.tiles[tile]);
    }
    return s;
  };

  it('tiles still equal their drill-down under every filter', async () => {
    const mgr = await userId('manager@example.test');
    await countsMatch('');
    await countsMatch(`?locationId=${SEED_IDS.locWatford}`);
    await countsMatch(`?ownerUserId=${mgr}`);
    await countsMatch('?dateFrom=2026-01-01&dateTo=2026-12-31');
    await countsMatch(
      `?locationId=${SEED_IDS.locWatford}&ownerUserId=${mgr}&dateFrom=2000-01-01&dateTo=2000-01-02`,
    );
  });

  it('an owner filter hides vehicles (no owner); a date range outside all deadlines leaves no overdue items', async () => {
    const mgr = await userId('manager@example.test');
    const owner = await call('GET', `/api/v1/dashboard/summary?ownerUserId=${mgr}`);
    expect(owner.body.tiles.blockedVehicles).toBe(0);
    const none = await call(
      'GET',
      '/api/v1/dashboard/summary?dateFrom=2000-01-01&dateTo=2000-01-02',
    );
    expect(none.body.tiles.overdue).toBe(0);
    expect(none.body.tiles.dueSoon).toBe(0);
    // The blocked vehicle has no deadline, so a date range never hides it.
    expect(none.body.tiles.blockedVehicles).toBeGreaterThanOrEqual(1);
  });

  it('refuses an end date before the start date and an unknown service', async () => {
    expect(
      (await call('GET', '/api/v1/dashboard/summary?dateFrom=2026-11-10&dateTo=2026-11-01')).status,
    ).toBe(400);
    expect(
      (await call('GET', '/api/v1/dashboard/actions?dateFrom=2026-11-10&dateTo=2026-11-01')).status,
    ).toBe(400);
    expect((await call('GET', '/api/v1/dashboard/summary?ownerUserId=not-a-uuid')).status).toBe(
      400,
    );
    const unknown = await call(
      'GET',
      '/api/v1/dashboard/summary?serviceId=01900000-0000-7000-8000-0000000000ff',
    );
    expect(unknown.status).toBe(200);
  });

  it('the group dashboard gives counts per authorised organisation and nothing else', async () => {
    const group = await call('GET', '/api/v1/dashboard/group');
    expect(group.status).toBe(200);
    const mine = (group.body.organisations as J[]).find((o) => o.organisationId === ORG)!;
    const own = (await call('GET', '/api/v1/dashboard/summary')).body;
    expect(mine).toMatchObject({ ok: true, unavailableReason: null, tiles: own.tiles });
    expect(Object.keys(mine).sort()).toEqual(
      [
        'criticalOpen',
        'ok',
        'organisationId',
        'organisationName',
        'tiles',
        'unavailableReason',
        'worstStatus',
      ].sort(),
    );
    expect(group.body.totals.overdue).toBe(
      (group.body.organisations as J[]).reduce((n, o) => n + (o.tiles?.overdue ?? 0), 0),
    );
    // Crew hold no dashboard permission anywhere: nothing is listed, and nothing leaks.
    const crew = await call('GET', '/api/v1/dashboard/group', { sub: 'dev|crew' });
    expect(crew.status).toBe(200);
    expect(crew.body.organisations).toEqual([]);
  });
});

describe('inspection evidence pack [COMP-02]', () => {
  it('is built by the worker within the requester’s permissions and fetched through a short-lived link', async () => {
    const req = await call('POST', '/api/v1/evidence-packs', {
      body: { from: addDays(today(), -60), to: today(), locationId: SEED_IDS.locWatford },
    });
    expect(req.body).toMatchObject({ status: 'QUEUED', download: null });
    expect(
      (
        await call('POST', '/api/v1/evidence-packs', {
          sub: 'dev|dispatcher',
          body: { from: today(), to: today() },
        })
      ).status,
    ).toBe(403);
    const n = await runPendingExports(db, new LocalBlobStore('./.data/evidence'));
    expect(n).toBeGreaterThanOrEqual(1);
    const done = await call('GET', `/api/v1/exports/${req.body.id}`);
    expect(done.body.status).toBe('DONE');
    expect(done.body.download.url).toContain('/api/v1/exports/blob/');
    expect(
      (await call('GET', `/api/v1/exports/${req.body.id}`, { sub: 'dev|governance' })).status,
    ).toBe(404); // someone else's export
    const zip = await app.inject({ method: 'GET', url: new URL(done.body.download.url).pathname });
    expect(zip.statusCode).toBe(200);
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['index.pdf', 'index.csv']));
    expect(strFromU8(files['index.pdf']!.slice(0, 5))).toBe('%PDF-');
    expect(strFromU8(files['index.csv']!)).toContain('Requirement,Template version');
    // An export link cannot be used against the evidence download route, or vice versa.
    const token = new URL(done.body.download.url).pathname.split('/').pop();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/evidence/blob/${token}` })).statusCode,
    ).toBe(403);
    const log = (await call('GET', '/api/v1/audit-log?limit=50')).body.data as J[];
    expect(
      log.some((a) => a.action === 'reports.export.download' && a.entityId === req.body.id),
    ).toBe(true);
  });
});
