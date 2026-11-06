import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { LocalBlobStore, runPendingExports } from '@hub/domain';
import { addDays, londonDate, londonDateTime } from '@hub/rules';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, SEED_USERS, makeApp, sign } from './harness.js';

// Workflow fix programme, tasks 16–27 (written 6 Nov 2026; not yet run).
// Task 23 (stale organisation selection) is web-only: see apps/web/test/app.test.tsx.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { sub?: string; body?: unknown; org?: string; ifMatch?: number } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': o.org ?? ORG,
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
const tag = () => Math.random().toString(36).slice(2, 8);
void addDays;
void tag;
void today;

describe('task 16: every seeded role can sign in', () => {
  it('the director and the premises lead have their system roles', async () => {
    const dir = await call('GET', '/api/v1/me', { sub: 'dev|director' });
    expect(dir.status).toBe(200);
    expect(dir.body.memberships[0].roleKey).toBe('DIRECTOR');
    expect(dir.body.permissions).toContain('dashboard.view');
    const prem = await call('GET', '/api/v1/me', { sub: 'dev|premises' });
    expect(prem.status).toBe(200);
    expect(prem.body.memberships[0].roleKey).toBe('PREMISES_LEAD');
    expect(prem.body.permissions).toContain('premises.item.manage');
    expect(prem.body.permissions).not.toContain('staff.profile.view_basic');
    expect((await call('GET', '/api/v1/staff', { sub: 'dev|premises' })).status).toBe(403);
  });
});

describe('task 18: Schedule 3 checks and driver eligibility', () => {
  it('lists all eight Schedule 3 items with words and colour, for HR only', async () => {
    const r = await call('GET', `/api/v1/staff/${SEED_IDS.staffCandidate}/schedule-3`, {
      sub: 'dev|hr',
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(8);
    for (const item of r.body.items as J[]) {
      expect(['GREEN', 'AMBER', 'RED']).toContain(item.status);
      expect(item.reasonText.length).toBeGreaterThan(0);
    }
    expect(r.body.complete).toBe(r.body.items.every((i: J) => i.state === 'COMPLETE'));
    const crew = await call('GET', `/api/v1/staff/${SEED_IDS.staffCandidate}/schedule-3`, {
      sub: 'dev|crew',
    });
    expect(crew.status).toBe(403);
    const dispatch = await call('GET', `/api/v1/staff/${SEED_IDS.staffCandidate}/schedule-3`, {
      sub: 'dev|dispatcher',
    });
    expect(dispatch.status).toBe(403);
  });

  it('records a care role with its reason for leaving', async () => {
    const r = await call('POST', `/api/v1/staff/${SEED_IDS.staffCandidate}/employment-history`, {
      sub: 'dev|hr',
      body: {
        data: {
          employer: `Care Home ${tag()}`,
          role: 'Care assistant',
          from: '2019-01-01',
          to: '2019-12-31',
          careRole: true,
          reasonForLeaving: 'Contract ended',
        },
      },
    });
    expect(r.status).toBe(201);
    const s3 = await call('GET', `/api/v1/staff/${SEED_IDS.staffCandidate}/schedule-3`, {
      sub: 'dev|hr',
    });
    const leaving = (s3.body.items as J[]).find((i) => i.item === 'REASON_FOR_LEAVING')!;
    expect(leaving.state).not.toBe('MISSING');
  });

  it('driver eligibility gives reasons and is visible to dispatch', async () => {
    const r = await call(
      'GET',
      `/api/v1/staff/${SEED_IDS.staffCandidate}/driver-eligibility?category=C1`,
      { sub: 'dev|dispatcher' },
    );
    expect(r.status).toBe(200);
    expect(r.body.category).toBe('C1');
    expect(typeof r.body.eligible).toBe('boolean');
    const codes = (r.body.checks as J[]).map((c) => c.code);
    expect(codes).toContain('ROLE_APPROVED');
    expect(codes).toContain('LICENCE_RECORD');
    if (!r.body.eligible)
      expect((r.body.checks as J[]).some((c) => c.result === 'FAIL')).toBe(true);
    const bad = await call(
      'GET',
      `/api/v1/staff/${SEED_IDS.staffCandidate}/driver-eligibility?category=ZZ`,
      { sub: 'dev|manager' },
    );
    expect(bad.status).toBe(400);
    const prem = await call('GET', `/api/v1/staff/${SEED_IDS.staffCandidate}/driver-eligibility`, {
      sub: 'dev|premises',
    });
    expect(prem.status).toBe(403);
  });
});

describe('task 19: training matrix', () => {
  it('returns column totals and cell states, and filters by requirement and gaps', async () => {
    const m = await call('GET', '/api/v1/staff/training-matrix', { sub: 'dev|hr' });
    expect(m.status).toBe(200);
    expect(typeof m.body.truncated).toBe('boolean');
    for (const [n, col] of (m.body.columns as J[]).entries()) {
      const states = (m.body.rows as J[]).map((r) => r.cells[n].state);
      expect(col.summary.required).toBe(states.filter((s) => s !== 'NOT_REQUIRED').length);
      expect(col.summary.met).toBe(states.filter((s) => s === 'MET').length);
    }
    for (const row of m.body.rows as J[]) {
      for (const c of row.cells as J[]) {
        if (!c.required) expect(c.state).toBe('NOT_REQUIRED');
        if (c.state === 'MET') expect(c.status).toBe('GREEN');
      }
    }
    const gaps = await call('GET', '/api/v1/staff/training-matrix?gapsOnly=true', {
      sub: 'dev|hr',
    });
    expect(gaps.status).toBe(200);
    expect((gaps.body.rows as J[]).every((r) => r.hasGap)).toBe(true);
    const first = (m.body.columns as J[])[0];
    if (first) {
      const one = await call(
        'GET',
        `/api/v1/staff/training-matrix?templateId=${first.templateId}`,
        { sub: 'dev|hr' },
      );
      expect((one.body.columns as J[]).map((c) => c.templateId)).toEqual([first.templateId]);
    }
    const bad = await call('GET', '/api/v1/staff/training-matrix?gapsOnly=maybe', {
      sub: 'dev|hr',
    });
    expect(bad.status).toBe(400);
    const crew = await call('GET', '/api/v1/staff/training-matrix', { sub: 'dev|crew' });
    expect(crew.status).toBe(403);
  });
});

describe('task 20: speaking up and harassment prevention', () => {
  const summary = 'Synthetic test: repeated comments about appearance on the night rota';

  it('a named concern goes from raised to closed, with feedback and a detriment check', async () => {
    const raised = await call('POST', '/api/v1/speak-up', {
      sub: 'dev|crew',
      body: { category: 'SEXUAL_HARASSMENT', summary, anonymous: false },
    });
    expect(raised.status).toBe(201);
    expect(raised.body.code).toMatch(/^SPK-\d+$/);
    expect(raised.body.acknowledgeDue).toBe(addDays(today(), 7));
    const code = raised.body.code as string;

    expect((await call('GET', '/api/v1/speak-up', { sub: 'dev|crew' })).status).toBe(403);
    const mine = await call('GET', '/api/v1/speak-up/mine', { sub: 'dev|crew' });
    expect((mine.body.data as J[]).map((c) => c.code)).toContain(code);
    expect(Object.keys((mine.body.data as J[])[0]!)).not.toContain('summary');

    const all = await call('GET', '/api/v1/speak-up', { sub: 'dev|hr' });
    const c = (all.body.data as J[]).find((x) => x.code === code)!;
    expect(c).toMatchObject({ anonymous: false, status: 'RECEIVED', channel: 'IN_APP' });
    expect(c.raisedByName).toBeTruthy();
    const url = `/api/v1/speak-up/${c.id}`;

    expect((await call('GET', url, { sub: 'dev|dispatcher' })).status).toBe(403);
    const early = await call('POST', `${url}/close`, {
      sub: 'dev|hr',
      body: { outcome: 'UPHELD', outcomeText: 'Spoken to', closedOn: today() },
    });
    expect(early.status).toBe(422);
    const selfHandler = await call('POST', `${url}/acknowledge`, {
      sub: 'dev|hr',
      body: { acknowledgedOn: today(), handlerUserId: SEED_USERS.crew!.id },
    });
    expect(selfHandler.status).toBe(400);
    const ack = await call('POST', `${url}/acknowledge`, {
      sub: 'dev|hr',
      body: { acknowledgedOn: today(), handlerUserId: SEED_USERS.hr!.id },
    });
    expect(ack.status).toBe(201);
    expect(ack.body).toMatchObject({ status: 'ACKNOWLEDGED', acknowledgeOverdue: false });

    const noFeedback = await call('POST', `${url}/close`, {
      sub: 'dev|hr',
      body: { outcome: 'UPHELD', outcomeText: 'Spoken to', closedOn: today() },
    });
    expect(noFeedback.status).toBe(422);
    const feedback = await call('POST', `${url}/notes`, {
      sub: 'dev|hr',
      body: { kind: 'FEEDBACK', note: 'Met and explained next steps', on: today() },
    });
    expect(feedback.body.feedbackGivenOn).toBe(today());
    const early2 = await call('POST', `${url}/notes`, {
      sub: 'dev|hr',
      body: { kind: 'DETRIMENT_CHECK', note: 'Asked', on: today(), detrimentReported: false },
    });
    expect(early2.status).toBe(422);

    const closed = await call('POST', `${url}/close`, {
      sub: 'dev|hr',
      body: {
        outcome: 'UPHELD',
        outcomeText: 'Colleague spoken to and rota changed',
        closedOn: today(),
      },
    });
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      outcome: 'UPHELD',
      detrimentCheckDue: addDays(today(), 90),
    });
    const check = await call('POST', `${url}/notes`, {
      sub: 'dev|hr',
      body: {
        kind: 'DETRIMENT_CHECK',
        note: 'Asked at supervision',
        on: today(),
        detrimentReported: false,
      },
    });
    expect(check.body.detrimentCheckedOn).toBe(today());
    const detail = await call('GET', url, { sub: 'dev|hr' });
    expect((detail.body.notes as J[]).map((n) => n.kind)).toEqual([
      'STATUS',
      'FEEDBACK',
      'STATUS',
      'DETRIMENT_CHECK',
    ]);
  });

  it('an anonymous concern stores no raiser and cannot be read back by its raiser', async () => {
    const raised = await call('POST', '/api/v1/speak-up', {
      sub: 'dev|crew',
      body: { category: 'BULLYING', summary, anonymous: true },
    });
    expect(raised.status).toBe(201);
    const code = raised.body.code as string;
    const mine = await call('GET', '/api/v1/speak-up/mine', { sub: 'dev|crew' });
    expect((mine.body.data as J[]).map((c) => c.code)).not.toContain(code);
    const all = await call('GET', '/api/v1/speak-up', { sub: 'dev|hr' });
    const c = (all.body.data as J[]).find((x) => x.code === code)!;
    expect(c).toMatchObject({ anonymous: true, raisedByName: null });
    const fb = await call('POST', `/api/v1/speak-up/${c.id}/notes`, {
      sub: 'dev|hr',
      body: { kind: 'FEEDBACK', note: 'Cannot be given', on: today() },
    });
    expect(fb.status).toBe(400);
    const row = await db.withTenant(
      { orgId: ORG, userId: SEED_USERS.hr!.id, permissions: ['speakup.manage'], locationIds: null },
      (tx) => tx.speakUpConcern.findUnique({ where: { id: c.id } }),
    );
    expect(row).toMatchObject({ raisedBy: null, recordedBy: null });
  });

  it('a risk assessment is approved by someone other than its preparer, then frozen', async () => {
    const list = await call('GET', '/api/v1/harassment/assessments', { sub: 'dev|manager' });
    expect(list.status).toBe(200);
    const risks = [
      {
        area: 'Lone crew on night discharges',
        risk: 'Harassment by a patient or relative',
        controls: 'Two-person crews after 22:00; incident reporting in the hub',
        thirdParty: true,
      },
    ];
    let draft = (list.body.data as J[]).find((a) => a.status === 'DRAFT');
    if (!draft) {
      const created = await call('POST', '/api/v1/harassment/assessments', {
        sub: 'dev|manager',
        body: {
          title: 'Synthetic harassment RA',
          assessedOn: today(),
          reviewDue: addDays(today(), 365),
          risks,
        },
      });
      expect(created.status).toBe(201);
      draft = created.body;
    }
    const edited = await call('PATCH', `/api/v1/harassment/assessments/${draft!.id}`, {
      sub: 'dev|hr',
      ifMatch: draft!.version,
      body: {
        title: 'Synthetic harassment RA (edited)',
        assessedOn: today(),
        reviewDue: addDays(today(), 365),
        risks,
      },
    });
    expect(edited.status).toBe(200);
    const self = await call('POST', `/api/v1/harassment/assessments/${draft!.id}/approve`, {
      sub: 'dev|hr',
    });
    expect(self.status).toBe(422);
    const ok = await call('POST', `/api/v1/harassment/assessments/${draft!.id}/approve`, {
      sub: 'dev|manager',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('APPROVED');
    const frozen = await call('PATCH', `/api/v1/harassment/assessments/${draft!.id}`, {
      sub: 'dev|manager',
      ifMatch: ok.body.version,
      body: { title: 'Changed', assessedOn: today(), reviewDue: addDays(today(), 30), risks },
    });
    expect(frozen.status).toBe(422);

    const duty = await call('GET', '/api/v1/harassment/duty', { sub: 'dev|hr' });
    expect(duty.status).toBe(200);
    expect((duty.body.steps as J[]).map((s) => s.step)).toEqual([
      'RISK_ASSESSMENT',
      'POLICY',
      'TRAINING',
      'CONCERNS_ACKNOWLEDGED',
      'DETRIMENT_CHECKS',
    ]);
    expect((duty.body.steps as J[])[0]).toMatchObject({ status: 'GREEN' });
    expect(duty.body.note).toMatch(/judgement for the organisation/);
    expect((await call('GET', '/api/v1/harassment/duty', { sub: 'dev|crew' })).status).toBe(403);
  });
});

describe('task 21: registration, rating display, fit and proper, meetings, notifications', () => {
  it('every registration save keeps a history row with what changed and why', async () => {
    const ref = `1-${Date.now().toString().slice(-9)}`;
    const saved = await call('POST', '/api/v1/registration', {
      sub: 'dev|governance',
      body: { providerRef: ref, reason: 'Synthetic: new provider reference' },
    });
    expect(saved.status).toBe(201);
    expect(saved.body.providerRef).toBe(ref);
    const hist = await call('GET', '/api/v1/registration/history', { sub: 'dev|auditor' });
    expect(hist.status).toBe(200);
    const top = (hist.body.data as J[])[0]!;
    expect(top.changedFields).toContain('providerRef');
    expect(top.reason).toBe('Synthetic: new provider reference');
    expect(top.snapshot.providerRef).toBe(ref);
    expect((await call('GET', '/api/v1/registration/history', { sub: 'dev|crew' })).status).toBe(
      403,
    );
  });

  it('records a published rating, tracks display, and refuses to change the rating', async () => {
    const published = addDays(today(), -30);
    const r = await call('POST', '/api/v1/cqc-ratings', {
      sub: 'dev|governance',
      body: { overall: 'GOOD', keyQuestions: { SAFE: 'GOOD' }, publishedOn: published },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ current: true, displayDue: addDays(published, 21) });
    expect(r.body.display.status).toBe('RED');
    const future = await call('POST', '/api/v1/cqc-ratings', {
      sub: 'dev|governance',
      body: { overall: 'GOOD', publishedOn: addDays(today(), 1) },
    });
    expect(future.status).toBe(400);
    const http = await call('POST', '/api/v1/cqc-ratings', {
      sub: 'dev|governance',
      body: { overall: 'GOOD', publishedOn: published, reportUrl: 'http://example.org/r' },
    });
    expect(http.status).toBe(400);
    const early = await call('PATCH', `/api/v1/cqc-ratings/${r.body.id}`, {
      sub: 'dev|governance',
      ifMatch: r.body.version,
      body: { displayedPremisesOn: addDays(published, -1) },
    });
    expect(early.status).toBe(400);
    const shown = await call('PATCH', `/api/v1/cqc-ratings/${r.body.id}`, {
      sub: 'dev|governance',
      ifMatch: r.body.version,
      body: { displayedPremisesOn: addDays(published, 2), noWebsite: true },
    });
    expect(shown.status).toBe(200);
    expect(shown.body.display.status).toBe('GREEN');
    const stale = await call('PATCH', `/api/v1/cqc-ratings/${r.body.id}`, {
      sub: 'dev|governance',
      ifMatch: r.body.version,
      body: { noWebsite: false },
    });
    expect(stale.status).toBe(409);
    const extra = await call('PATCH', `/api/v1/cqc-ratings/${r.body.id}`, {
      sub: 'dev|governance',
      ifMatch: shown.body.version,
      body: { overall: 'OUTSTANDING' },
    });
    expect(extra.status).toBe(400);
    const list = await call('GET', '/api/v1/cqc-ratings', { sub: 'dev|auditor' });
    expect(list.status).toBe(200);
    expect(
      (
        await call('POST', '/api/v1/cqc-ratings', {
          sub: 'dev|auditor',
          body: { overall: 'GOOD', publishedOn: published },
        })
      ).status,
    ).toBe(403);
  });

  it("directors' fit and proper checks are restricted and cannot be self-recorded", async () => {
    const items = ['IDENTITY', 'DBS', 'BANKRUPTCY_INSOLVENCY'].map((item) => ({
      item,
      done: true,
    }));
    const name = `Synthetic Director ${tag()}`;
    const rec = await call('POST', '/api/v1/fit-and-proper', {
      sub: 'dev|governance',
      body: {
        directorName: name,
        directorRole: 'Chair',
        checkedOn: today(),
        items,
        declarationOn: today(),
        outcome: 'FIT',
      },
    });
    expect(rec.status).toBe(201);
    expect(rec.body.nextReviewDue.slice(0, 4)).toBe(String(Number(today().slice(0, 4)) + 1));
    const self = await call('POST', '/api/v1/fit-and-proper', {
      sub: 'dev|governance',
      body: {
        directorName: 'Myself',
        directorRole: 'Director',
        userId: SEED_USERS.governance!.id,
        checkedOn: today(),
        items,
        outcome: 'FIT',
      },
    });
    expect(self.status).toBe(422);
    const dup = await call('POST', '/api/v1/fit-and-proper', {
      sub: 'dev|governance',
      body: {
        directorName: name,
        directorRole: 'Chair',
        checkedOn: today(),
        items: [...items, items[0]],
        outcome: 'FIT',
      },
    });
    expect(dup.status).toBe(400);
    const list = await call('GET', '/api/v1/fit-and-proper', { sub: 'dev|manager' });
    expect(list.status).toBe(200);
    const dir = (list.body.directors as J[]).find((x) => x.directorName === name)!;
    expect(dir.state.status).toBe('AMBER');
    expect(dir.state.reasonText).toMatch(/not done/);
    for (const sub of ['dev|auditor', 'dev|dispatcher', 'dev|crew', 'dev|hr'])
      expect((await call('GET', '/api/v1/fit-and-proper', { sub })).status).toBe(403);
  });

  it('meeting minutes are approved by someone else, then frozen; actions link back', async () => {
    const created = await call('POST', '/api/v1/governance-meetings', {
      sub: 'dev|governance',
      body: {
        kind: 'CLINICAL_GOVERNANCE',
        title: 'Synthetic clinical governance meeting',
        heldOn: today(),
        chair: 'Synthetic Chair',
        attendees: ['Synthetic A', 'Synthetic B'],
        quorate: true,
        minutes: 'Reviewed incidents and audits.',
        decisions: 'Re-audit hand hygiene next month.',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', code: expect.stringMatching(/^MTG-/) });
    const url = `/api/v1/governance-meetings/${created.body.id}`;
    const self = await call('POST', `${url}/approve`, {
      sub: 'dev|governance',
      ifMatch: created.body.version,
    });
    expect(self.status).toBe(422);
    const action = await call('POST', `${url}/actions`, {
      sub: 'dev|governance',
      body: {
        title: 'Book the hand hygiene re-audit',
        ownerUserId: SEED_USERS.governance!.id,
        deadline: addDays(today(), 30),
      },
    });
    expect(action.status).toBe(201);
    expect(action.body.sourceType).toBe('MEETING');
    const ok = await call('POST', `${url}/approve`, {
      sub: 'dev|manager',
      ifMatch: created.body.version,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('APPROVED');
    expect((ok.body.actions as J[]).map((a) => a.id)).toContain(action.body.id);
    const frozen = await call('PATCH', url, {
      sub: 'dev|manager',
      ifMatch: ok.body.version,
      body: { minutes: 'Changed afterwards' },
    });
    expect(frozen.status).toBe(422);
    expect((await call('GET', url, { sub: 'dev|auditor' })).status).toBe(200);
    expect((await call('GET', url, { sub: 'dev|crew' })).status).toBe(403);
    expect(
      (await call('POST', '/api/v1/governance-meetings', { sub: 'dev|auditor', body: {} })).status,
    ).toBe(403);
  });

  it('a notification draft is reviewed by a second person, then its submission recorded', async () => {
    const summary = 'Synthetic: crew member injured lifting; see the event in the hub.';
    const bad = await call('POST', '/api/v1/cqc-notifications', {
      sub: 'dev|governance',
      body: {
        kind: 'SERIOUS_INJURY',
        occurredOn: today(),
        summary: 'Patient 943 476 5919 was injured during transfer',
      },
    });
    expect(bad.status).toBe(400);
    const draft = await call('POST', '/api/v1/cqc-notifications', {
      sub: 'dev|governance',
      body: { kind: 'SERIOUS_INJURY', occurredOn: today(), summary },
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', dueOn: addDays(today(), 1) });
    expect(draft.body.state.status).toBe('AMBER');
    const url = `/api/v1/cqc-notifications/${draft.body.id}`;
    const selfReview = await call('POST', `${url}/transition`, {
      sub: 'dev|governance',
      ifMatch: draft.body.version,
      body: { to: 'READY' },
    });
    expect(selfReview.status).toBe(422);
    const skip = await call('POST', `${url}/transition`, {
      sub: 'dev|manager',
      ifMatch: draft.body.version,
      body: { to: 'SUBMITTED', submittedOn: today(), cqcReference: 'CQC-SYN-1' },
    });
    expect(skip.status).toBe(422);
    const ready = await call('POST', `${url}/transition`, {
      sub: 'dev|manager',
      ifMatch: draft.body.version,
      body: { to: 'READY' },
    });
    expect(ready.status).toBe(201);
    expect(ready.body.reviewedByName).toBeTruthy();
    const edit = await call('PATCH', url, {
      sub: 'dev|governance',
      ifMatch: ready.body.version,
      body: { summary: `${summary} Edited.` },
    });
    expect(edit.status).toBe(422);
    const sent = await call('POST', `${url}/transition`, {
      sub: 'dev|governance',
      ifMatch: ready.body.version,
      body: { to: 'SUBMITTED', submittedOn: today(), cqcReference: 'CQC-SYN-1' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body.state.status).toBe('GREEN');
    const planned = await call('POST', '/api/v1/cqc-notifications', {
      sub: 'dev|governance',
      body: {
        kind: 'MANAGER_ABSENCE',
        occurredOn: addDays(today(), 60),
        planned: true,
        summary: 'Synthetic: registered manager on planned leave for six weeks.',
      },
    });
    expect(planned.status).toBe(201);
    expect(planned.body.dueOn).toBe(addDays(today(), 32));
    const sugg = await call('GET', '/api/v1/cqc-notifications/suggestions', {
      sub: 'dev|governance',
    });
    expect(sugg.status).toBe(200);
    expect(Array.isArray(sugg.body.data)).toBe(true);
    expect((await call('GET', '/api/v1/cqc-notifications', { sub: 'dev|crew' })).status).toBe(403);
    expect((await call('GET', '/api/v1/cqc-notifications', { sub: 'dev|auditor' })).status).toBe(
      403,
    );
  });
});

describe('task 22: NHS contract items and evidence pack options', () => {
  it('the library has an NHS contract items pack', async () => {
    const r = await call('GET', '/api/v1/requirements/templates', { sub: 'dev|manager' });
    const nhs = (r.body.data as J[]).filter((t) => t.isLibrary && t.pack === 'NHS_CONTRACT_V1');
    expect(nhs).toHaveLength(15);
    expect(nhs.every((t) => t.versions[0].subjectType === 'ORGANISATION')).toBe(true);
  });

  it('records a contract, shows its notice state and refuses bad dates', async () => {
    const reference = `NHS-SYN-${tag()}`;
    const start = addDays(today(), -100);
    const end = addDays(today(), 60);
    const made = await call('POST', '/api/v1/nhs-contracts', {
      sub: 'dev|governance',
      body: {
        commissioner: 'Synthetic ICB',
        reference,
        service: 'Non-emergency patient transport',
        contractType: 'NHS_STANDARD_SHORTFORM',
        startOn: start,
        endOn: end,
        managerUserId: SEED_USERS.governance!.id,
      },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ noticeMonths: 6, reporting: 'MONTHLY' });
    expect(made.body.state.status).toBe('AMBER');
    const dup = await call('POST', '/api/v1/nhs-contracts', {
      sub: 'dev|governance',
      body: { ...made.body, id: undefined },
    });
    expect(dup.status).toBe(400);
    const again = await call('POST', '/api/v1/nhs-contracts', {
      sub: 'dev|governance',
      body: {
        commissioner: 'Synthetic ICB',
        reference,
        service: 'Non-emergency patient transport',
        contractType: 'NHS_STANDARD_SHORTFORM',
        startOn: start,
        endOn: end,
        managerUserId: SEED_USERS.governance!.id,
      },
    });
    expect(again.status).toBe(409);
    const backwards = await call('PATCH', `/api/v1/nhs-contracts/${made.body.id}`, {
      sub: 'dev|governance',
      ifMatch: made.body.version,
      body: { endOn: addDays(start, -1) },
    });
    expect(backwards.status).toBe(400);
    const extended = await call('PATCH', `/api/v1/nhs-contracts/${made.body.id}`, {
      sub: 'dev|governance',
      ifMatch: made.body.version,
      body: { endOn: addDays(today(), 400) },
    });
    expect(extended.status).toBe(200);
    expect(extended.body.state.status).toBe('GREEN');
    const list = await call('GET', '/api/v1/nhs-contracts', { sub: 'dev|auditor' });
    expect(list.status).toBe(200);
    expect((list.body.contracts as J[]).map((c) => c.reference)).toContain(reference);
    expect(list.body.summary.total).toBe((list.body.items as J[]).length);
    expect(typeof list.body.notAdopted).toBe('number');
    expect((await call('GET', '/api/v1/nhs-contracts', { sub: 'dev|crew' })).status).toBe(403);
    expect(
      (
        await call('POST', '/api/v1/nhs-contracts', {
          sub: 'dev|auditor',
          body: { reference: 'X' },
        })
      ).status,
    ).toBe(403);
  });

  it('an NHS contract pack, index only, has no evidence files and only NHS items', async () => {
    const bad = await call('POST', '/api/v1/evidence-packs', {
      body: { from: addDays(today(), -30), to: today(), sections: ['AUDITS', 'AUDITS'] },
    });
    expect(bad.status).toBe(400);
    const req = await call('POST', '/api/v1/evidence-packs', {
      body: {
        from: addDays(today(), -30),
        to: today(),
        purpose: 'NHS_CONTRACT',
        sections: ['REQUIREMENTS', 'GOVERNANCE', 'CONTRACTS'],
        includeFiles: false,
      },
    });
    expect(req.status).toBe(201);
    await runPendingExports(db, new LocalBlobStore('./.data/evidence'));
    const done = await call('GET', `/api/v1/exports/${req.body.id}`);
    expect(done.body.status).toBe('DONE');
    const zip = await app.inject({ method: 'GET', url: new URL(done.body.download.url).pathname });
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['index.csv', 'index.pdf']);
    const rows = strFromU8(files['index.csv']!).trim().split('\r\n').slice(1);
    for (const ambulanceOnly of ['Driving licence entitlement', 'MOT test certificate'])
      expect(rows.some((r) => r.startsWith(ambulanceOnly))).toBe(false);
  });
});

describe('task 24: alerts centre and notification rules', () => {
  const SYSTEM = { orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' };

  it('shows an overdue action to its owner, and to a role only once a rule names it', async () => {
    const code = `ACT-T24-${tag()}`;
    const action = await db.withTenant(SYSTEM, (tx) =>
      tx.action.create({
        data: {
          organisationId: ORG,
          code,
          sourceType: 'RISK',
          sourceId: '01900000-0000-7000-8000-00000000f024',
          title: 'Synthetic overdue action',
          severity: 'HIGH',
          ownerUserId: SEED_USERS.governance!.id,
          deadline: new Date(`${addDays(today(), -3)}T00:00:00.000Z`),
        },
      }),
    );
    const key = `ACTION:${action.id}`;
    const owner = await call('GET', '/api/v1/alerts/centre', { sub: 'dev|governance' });
    expect(owner.status).toBe(200);
    expect((owner.body.items as J[]).find((i) => i.key === key)).toMatchObject({
      event: 'ACTION_OVERDUE',
      why: 'OWNER',
      alertId: null,
      title: `${code} – Synthetic overdue action`,
      link: '/compliance?tab=actions',
    });
    const filtered = await call('GET', '/api/v1/alerts/centre?event=AUDIT_OVERDUE', {
      sub: 'dev|governance',
    });
    expect((filtered.body.items as J[]).some((i) => i.key === key)).toBe(false);

    const crewBefore = await call('GET', '/api/v1/alerts/centre', { sub: 'dev|crew' });
    expect(crewBefore.status).toBe(200);
    expect((crewBefore.body.items as J[]).some((i) => i.key === key)).toBe(false);

    const s = await call('GET', '/api/v1/admin/settings');
    const original = s.body.settings.notificationRules ?? [];
    const set = await call('PATCH', '/api/v1/admin/settings', {
      ifMatch: s.body.version,
      body: {
        notificationRules: [
          ...original,
          { event: 'ACTION_OVERDUE', roleKeys: ['CREW'], email: false },
        ],
      },
    });
    expect(set.status).toBe(200);
    try {
      const crew = await call('GET', '/api/v1/alerts/centre', { sub: 'dev|crew' });
      expect((crew.body.items as J[]).find((i) => i.key === key)).toMatchObject({ why: 'RULE' });
      expect(crew.body.rules).toContainEqual({
        event: 'ACTION_OVERDUE',
        email: false,
        roleNames: ['Crew member'],
      });
    } finally {
      await call('PATCH', '/api/v1/admin/settings', {
        ifMatch: set.body.version,
        body: { notificationRules: original },
      });
    }
  });

  it('never puts an event title in the centre, and refuses unknown filters [task 24]', async () => {
    const r = await call('GET', '/api/v1/alerts/centre?event=EVERYTHING');
    expect(r.status).toBe(400);
    const ok = await call('GET', '/api/v1/alerts/centre?includeAcknowledged=true');
    expect(ok.status).toBe(200);
    for (const i of (ok.body.items as J[]).filter((x) => x.sourceType === 'EVENT'))
      expect(i.title).toMatch(/ – New report$/);
  });
});

describe('task 25: staff self-service', () => {
  it('checks own readiness for a window of up to 31 days', async () => {
    const from = new Date();
    const to = new Date(from.getTime() + 12 * 3_600_000);
    const qs = (end: Date) =>
      `role=DRIVER&from=${encodeURIComponent(from.toISOString())}` +
      `&to=${encodeURIComponent(end.toISOString())}`;
    const r = await call('GET', `/api/v1/staff/me/readiness?${qs(to)}`, { sub: 'dev|crew' });
    expect(r.status).toBe(200);
    expect(r.body.staffId).toBe(SEED_IDS.staffCrew);
    expect(['READY', 'BLOCKED', 'RESTRICTED']).toContain(r.body.state);
    const long = new Date(from.getTime() + 40 * 86_400_000);
    expect(
      (await call('GET', `/api/v1/staff/me/readiness?${qs(long)}`, { sub: 'dev|crew' })).status,
    ).toBe(400);
    expect(
      (await call('GET', `/api/v1/staff/me/readiness?${qs(to)}`, { sub: 'dev|dispatcher' })).status,
    ).toBe(404);
  });

  it('books supervision: someone else accepts it with a time, and history is frozen', async () => {
    const ask = await call('POST', '/api/v1/staff/me/requests', {
      sub: 'dev|crew',
      body: {
        kind: 'SUPERVISION',
        proposedDate: addDays(today(), 7),
        supervisorUserId: SEED_USERS.governance!.id,
        reason: 'Synthetic: talk through my training plan',
      },
    });
    expect(ask.status).toBe(201);
    expect(ask.body).toMatchObject({ status: 'OPEN', kind: 'SUPERVISION', instanceId: null });
    const url = `/api/v1/staff/self-requests/${ask.body.id}/decide`;
    const crewDecides = await call('POST', url, {
      sub: 'dev|crew',
      ifMatch: ask.body.version,
      body: { decision: 'ACCEPTED', bookedFor: new Date().toISOString() },
    });
    expect(crewDecides.status).toBe(403);
    const noTime = await call('POST', url, {
      sub: 'dev|hr',
      ifMatch: ask.body.version,
      body: { decision: 'ACCEPTED' },
    });
    expect(noTime.status).toBe(400);
    const when = new Date(Date.now() + 7 * 86_400_000).toISOString();
    // The named supervisor may answer their own booking without staff.profile.manage.
    const ok = await call('POST', url, {
      sub: 'dev|governance',
      ifMatch: ask.body.version,
      body: { decision: 'ACCEPTED', bookedFor: when, note: 'See you then' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'ACCEPTED', bookedFor: when });
    expect(ok.body.decidedByName).toBeTruthy();
    const again = await call('POST', url, {
      sub: 'dev|hr',
      ifMatch: ok.body.version,
      body: { decision: 'DECLINED', note: 'Changed my mind' },
    });
    expect(again.status).toBe(409);
    const mine = await call('GET', '/api/v1/staff/me/requests', { sub: 'dev|crew' });
    expect((mine.body.data as J[]).find((r) => r.id === ask.body.id)).toMatchObject({
      status: 'ACCEPTED',
      supervisorName: expect.any(String),
    });
  });

  it('a date change or review is only for own items, never for an expiry, and can be withdrawn', async () => {
    const stranger = await call('POST', '/api/v1/staff/me/requests', {
      sub: 'dev|crew',
      body: {
        kind: 'REVIEW',
        instanceId: '01900000-0000-7000-8000-00000000f025',
        reason: 'Synthetic: not my item',
      },
    });
    expect(stranger.status).toBe(404);
    const me = await call('GET', '/api/v1/staff/me', { sub: 'dev|crew' });
    const reqs = me.body.requirements as J[];
    const expiry = reqs.find((r) => r.deadlineKind === 'EXPIRY');
    if (expiry) {
      const refused = await call('POST', '/api/v1/staff/me/requests', {
        sub: 'dev|crew',
        body: {
          kind: 'DUE_DATE_CHANGE',
          instanceId: expiry.id,
          proposedDate: addDays(today(), 60),
          reason: 'Synthetic: please move my expiry',
        },
      });
      expect(refused.status).toBe(422);
    }
    const item = reqs[0];
    if (!item) return; // the seed gives crew requirements; nothing more to check without one
    const review = await call('POST', '/api/v1/staff/me/requests', {
      sub: 'dev|crew',
      body: { kind: 'REVIEW', instanceId: item.id, reason: 'Synthetic: please check this again' },
    });
    expect(review.status).toBe(201);
    const dup = await call('POST', '/api/v1/staff/me/requests', {
      sub: 'dev|crew',
      body: { kind: 'REVIEW', instanceId: item.id, reason: 'Synthetic: asking twice' },
    });
    expect(dup.status).toBe(409);
    const queue = await call('GET', '/api/v1/staff/self-requests', { sub: 'dev|hr' });
    expect((queue.body.data as J[]).map((r) => r.id)).toContain(review.body.id);
    expect((await call('GET', '/api/v1/staff/self-requests', { sub: 'dev|crew' })).status).toBe(
      403,
    );
    const gone = await call('POST', `/api/v1/staff/me/requests/${review.body.id}/withdraw`, {
      sub: 'dev|crew',
      ifMatch: review.body.version,
    });
    expect(gone.status).toBe(201);
    expect(gone.body.status).toBe('WITHDRAWN');
    const before = await call('GET', '/api/v1/staff/me', { sub: 'dev|crew' });
    expect((before.body.requirements as J[]).find((r) => r.id === item.id)?.status).toBe(
      item.status,
    );
  });

  it('an accepted due-date change is applied through the due-date log by someone else', async () => {
    const me = await call('GET', '/api/v1/staff/me', { sub: 'dev|crew' });
    const item = (me.body.requirements as J[]).find((r) => r.deadlineKind === 'DUE');
    if (!item) return; // no due-date item for crew in this seed
    const target = addDays(item.dueDate ?? today(), 14);
    const ask = await call('POST', '/api/v1/staff/me/requests', {
      sub: 'dev|crew',
      body: {
        kind: 'DUE_DATE_CHANGE',
        instanceId: item.id,
        proposedDate: target,
        reason: 'Synthetic: on annual leave that week',
      },
    });
    expect(ask.status).toBe(201);
    const url = `/api/v1/staff/self-requests/${ask.body.id}/decide`;
    expect(
      (
        await call('POST', url, {
          sub: 'dev|crew',
          ifMatch: ask.body.version,
          body: { decision: 'ACCEPTED' },
        })
      ).status,
    ).toBe(403);
    const ok = await call('POST', url, {
      ifMatch: ask.body.version,
      body: { decision: 'ACCEPTED', note: 'Agreed' },
    });
    expect(ok.status).toBe(201);
    const after = await call('GET', '/api/v1/staff/me', { sub: 'dev|crew' });
    expect((after.body.requirements as J[]).find((r) => r.id === item.id)?.dueDate).toBe(target);
    const detail = await call('GET', `/api/v1/requirements/instances/${item.id}`);
    expect((detail.body.dueDateChanges as J[] | undefined)?.some((c) => c.newDate === target)).toBe(
      true,
    );
  });
});

describe('task 26: vehicle and planner operations', () => {
  async function vehicle() {
    const r = await call('POST', '/api/v1/vehicles', {
      sub: 'dev|fleet',
      body: {
        // D1: a current-format UK registration.
        registration: `OP${10 + Math.floor(Math.random() * 90)}${
          ['QXA', 'QXB', 'QXC', 'QXD'][Math.floor(Math.random() * 4)]!
        }`,
        callsign: `OPS-${tag()}`.toUpperCase(),
        type: 'PTS_VEHICLE',
        baseLocationId: SEED_IDS.locWatford,
        seats: 4,
        wheelchairCapacity: 1,
      },
    });
    expect(r.status).toBe(201);
    return r.body as J;
  }

  it('off-road and quarantine keep a reason; history is listed newest first', async () => {
    const v = await vehicle();
    const url = `/api/v1/vehicles/${v.id}`;
    expect(
      (await call('POST', `${url}/off-road`, { sub: 'dev|crew', body: { on: true, reason: 'x' } }))
        .status,
    ).toBe(403);
    const off = await call('POST', `${url}/off-road`, {
      sub: 'dev|fleet',
      body: { on: true, reason: 'Synthetic: brake warning light' },
    });
    expect(off.status).toBe(201);
    expect([off.body.status, off.body.offRoad]).toEqual(['OFF_ROAD', true]);
    const back = await call('POST', `${url}/off-road`, {
      sub: 'dev|fleet',
      body: { on: false, reason: 'Synthetic: brakes repaired and tested' },
    });
    expect(back.status).toBe(201);
    expect(back.body.offRoad).toBe(false);
    const h = await call('GET', `${url}/status-history`, { sub: 'dev|dispatcher' });
    expect(h.status).toBe(200);
    expect((h.body.data as J[]).map((r) => [r.flag, r.on, r.reason])).toEqual([
      ['OFF_ROAD', false, 'Synthetic: brakes repaired and tested'],
      ['OFF_ROAD', true, 'Synthetic: brake warning light'],
    ]);
    expect(h.body.data[0].changedByName).toBeTruthy();
    // The log is append-only.
    await expect(
      db.withTenant({ orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' }, (tx) =>
        tx.vehicleStatusChange.deleteMany({ where: { vehicleId: v.id } }),
      ),
    ).rejects.toThrow();
  });

  it('a planned shift can be cancelled once, by control only, with a reason', async () => {
    const v = await vehicle();
    const day = addDays(today(), 2);
    const s = await call('POST', '/api/v1/shifts', {
      sub: 'dev|dispatcher',
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: v.id,
        startsAt: londonDateTime(day, '10:00').toISOString(),
        endsAt: londonDateTime(day, '12:00').toISOString(),
      },
    });
    expect(s.status).toBe(201);
    const url = `/api/v1/shifts/${s.body.id}/cancel`;
    expect(
      (await call('POST', url, { sub: 'dev|crew', body: { reason: 'Not needed' } })).status,
    ).toBe(403);
    expect((await call('POST', url, { sub: 'dev|dispatcher', body: {} })).status).toBe(400);
    const c = await call('POST', url, {
      sub: 'dev|dispatcher',
      body: { reason: 'Synthetic: vehicle needed elsewhere' },
    });
    expect(c.status).toBe(201);
    expect(c.body.state).toBe('CANCELLED');
    expect((c.body.changes as J[]).some((x) => x.kind === 'CANCELLED')).toBe(true);
    expect(
      (await call('POST', url, { sub: 'dev|dispatcher', body: { reason: 'Again please' } })).status,
    ).toBe(409);
    // The vehicle is free again for that window.
    const again = await call('POST', '/api/v1/shifts', {
      sub: 'dev|dispatcher',
      body: {
        locationId: SEED_IDS.locWatford,
        vehicleId: v.id,
        startsAt: londonDateTime(day, '10:00').toISOString(),
        endsAt: londonDateTime(day, '12:00').toISOString(),
      },
    });
    expect(again.status).toBe(201);
  });
});

describe('task 27: data protection logs', () => {
  it('records disclosures with who recorded them, refuses future dates and filters by date', async () => {
    const who = `Synthetic Insurer ${tag()}`;
    const base = {
      disclosedTo: who,
      purpose: 'Synthetic: claim handling',
      lawfulBasis: 'Contract (Article 6(1)(b))',
      dataDescription: 'Synthetic: incident date and vehicle callsign',
    };
    expect(
      (
        await call('POST', '/api/v1/disclosures', {
          sub: 'dev|crew',
          body: { ...base, disclosedOn: today() },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', '/api/v1/disclosures', {
          body: { ...base, disclosedOn: addDays(today(), 1) },
        })
      ).status,
    ).toBe(400);
    const older = addDays(today(), -20);
    const r = await call('POST', '/api/v1/disclosures', { body: { ...base, disclosedOn: older } });
    expect(r.status).toBe(201);
    expect(r.body.recordedByName).toBeTruthy();
    expect(r.body.subjectRequestCode).toBeNull();
    const inRange = await call(
      'GET',
      `/api/v1/disclosures?from=${addDays(older, -1)}&to=${addDays(older, 1)}`,
    );
    expect(inRange.status).toBe(200);
    expect((inRange.body.data as J[]).some((x) => x.disclosedTo === who)).toBe(true);
    const outside = await call('GET', `/api/v1/disclosures?from=${addDays(today(), -5)}`);
    expect((outside.body.data as J[]).some((x) => x.disclosedTo === who)).toBe(false);
    expect(
      (await call('GET', `/api/v1/disclosures?from=${today()}&to=${addDays(today(), -1)}`)).status,
    ).toBe(400);
    expect((await call('GET', '/api/v1/disclosures', { sub: 'dev|dispatcher' })).status).toBe(403);
  });

  it('the retention log filters by category and checks its query', async () => {
    const all = await call('GET', '/api/v1/retention-log');
    expect(all.status).toBe(200);
    const one = await call('GET', '/api/v1/retention-log?category=PATIENT_CONTACT');
    expect(one.status).toBe(200);
    expect((one.body.data as J[]).every((x) => x.category === 'PATIENT_CONTACT')).toBe(true);
    expect((await call('GET', '/api/v1/retention-log?category=NOPE')).status).toBe(400);
    expect((await call('GET', '/api/v1/retention-log?extra=1')).status).toBe(400);
    expect((await call('GET', '/api/v1/retention-log', { sub: 'dev|crew' })).status).toBe(403);
  });
});
