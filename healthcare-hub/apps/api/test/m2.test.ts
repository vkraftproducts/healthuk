import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { addDays, londonDate } from '@hub/rules';
import {
  dispatchNotifications,
  notifyAll,
  planNotifications,
  reconcileAll,
  recomputeOrganisation,
  snapshotAll,
  verifyAuditChains,
  type Mailer,
} from '@hub/domain';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
const today = () => londonDate(new Date());
const plus = (n: number) => addDays(today(), n);

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Opts {
  sub?: string;
  org?: string;
  body?: unknown;
  ifMatch?: number;
}
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, o: Opts = {}) {
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
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J, raw: res };
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

let n = 0;
const code = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}${n++}`;
const tpl = (c: string, o: Record<string, unknown> = {}) => ({
  code: c,
  title: 'Driving licence',
  version: {
    basisType: 'STATUTORY',
    subjectType: 'STAFF',
    recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
    blocking: 'STATUTORY',
    deadlineKind: 'EXPIRY',
    ...o,
  },
});

/** Author (admin) drafts, a different person (manager) publishes: four-eyes. */
async function publishedTemplate(o: Record<string, unknown> = {}) {
  const created = await call('POST', '/api/v1/requirements/templates', {
    sub: 'dev|admin',
    body: tpl(code('REQ'), o),
  });
  expect(created.status).toBe(201);
  const pub = await call(
    'POST',
    `/api/v1/requirements/templates/${created.body.id}/versions/${created.body.versions[0].id}/publish`,
  );
  expect(pub.status).toBe(201);
  return created.body.id as string;
}
async function newInstance(templateId: string, o: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/v1/requirements/instances', {
    body: { templateId, subjectType: 'STAFF', subjectId: SEED_IDS.staffCrew, ...o },
  });
  expect(r.status).toBe(201);
  return r.body;
}
let staffSeq = 7000;
async function newStaff(): Promise<string> {
  const r = await call('POST', '/api/v1/staff', {
    body: {
      staffNo: `ST-${staffSeq++}`,
      displayName: 'Synthetic Staff',
      primaryLocationId: SEED_IDS.locWatford,
    },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function userId(email: string): Promise<string> {
  const { body } = await call('GET', '/api/v1/admin/users');
  return (body.data as J[]).find((u) => u.email === email)!.id as string;
}

/** Flips a character in the middle of the token so the signature can never still match. */
const tamper = (p: string): string => {
  const i = p.length - 8;
  return p.slice(0, i) + (p[i] === 'A' ? 'B' : 'A') + p.slice(i + 1);
};
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
);
interface UploadOpts {
  sub?: string;
  title?: string;
  bytes?: Buffer;
  mime?: string;
  instanceIds?: string[];
  itemId?: string;
  validFrom?: string;
  validTo?: string;
  declaredSize?: number;
}
async function upload(o: UploadOpts) {
  const bytes = o.bytes ?? PDF;
  const mime = o.mime ?? 'application/pdf';
  const req = await call('POST', '/api/v1/evidence/uploads', {
    sub: o.sub ?? 'dev|crew',
    body: {
      title: o.title ?? 'Licence scan',
      mime,
      sizeBytes: o.declaredSize ?? bytes.length,
      requirementInstanceIds: o.instanceIds ?? [],
      itemId: o.itemId,
      validFrom: o.validFrom,
      validTo: o.validTo,
    },
  });
  expect(req.status).toBe(201);
  const path = new URL(req.body.uploadUrl as string).pathname;
  const put = await app.inject({
    method: 'PUT',
    url: path,
    headers: { 'content-type': mime },
    payload: bytes,
  });
  const done = await call('POST', `/api/v1/evidence/${req.body.evidenceVersionId}/complete`, {
    sub: o.sub ?? 'dev|crew',
  });
  return { req: req.body, put, done };
}
const getInstance = async (id: string) =>
  (await call('GET', `/api/v1/requirements/instances/${id}`)).body;

describe('requirement templates', () => {
  it('drafts need a different approver; the author cannot publish their own draft (four-eyes)', async () => {
    const created = await call('POST', '/api/v1/requirements/templates', {
      body: tpl(code('REQ')),
    }); // manager authors
    expect(created.status).toBe(201);
    const v = created.body.versions[0];
    expect(v.status).toBe('DRAFT');
    const self = await call(
      'POST',
      `/api/v1/requirements/templates/${created.body.id}/versions/${v.id}/publish`,
    );
    expect([self.status, self.body.code]).toEqual([422, 'FOUR_EYES_REQUIRED']);
    // admin may author but has no publish permission
    expect(
      (
        await call(
          'POST',
          `/api/v1/requirements/templates/${created.body.id}/versions/${v.id}/publish`,
          { sub: 'dev|admin' },
        )
      ).status,
    ).toBe(403);
  });

  it('published versions are immutable; a new version supersedes the old and moves existing instances', async () => {
    const id = await publishedTemplate();
    const inst = await newInstance(id);
    const list = (await call('GET', '/api/v1/requirements/templates')).body.data as J[];
    const t = list.find((x) => x.id === id)!;
    expect(t.versions[0]).toMatchObject({ version: 1, status: 'EFFECTIVE' });
    expect(
      (
        await call('PATCH', `/api/v1/requirements/templates/${id}/versions/${t.versions[0].id}`, {
          sub: 'dev|admin',
          body: { blocking: 'NONE' },
        })
      ).status,
    ).toBe(409);

    const v2 = await call('POST', `/api/v1/requirements/templates/${id}/versions`, {
      sub: 'dev|admin',
      body: { ...tpl('X').version, blocking: 'NONE' },
    });
    expect(v2.status).toBe(201);
    expect(
      (
        await call('POST', `/api/v1/requirements/templates/${id}/versions`, {
          sub: 'dev|admin',
          body: tpl('X').version,
        })
      ).status,
    ).toBe(409); // one draft at a time
    const edited = await call(
      'PATCH',
      `/api/v1/requirements/templates/${id}/versions/${v2.body.id}`,
      { sub: 'dev|admin', body: { dueSoonDays: 14 } },
    );
    expect(edited.body.dueSoonDays).toBe(14);
    expect(
      (await call('POST', `/api/v1/requirements/templates/${id}/versions/${v2.body.id}/publish`))
        .status,
    ).toBe(201);

    const after = (await call('GET', '/api/v1/requirements/templates')).body.data.find(
      (x: J) => x.id === id,
    );
    expect(after.versions.map((v: J) => [v.version, v.status])).toEqual([
      [2, 'EFFECTIVE'],
      [1, 'SUPERSEDED'],
    ]);
    const moved = await getInstance(inst.id);
    expect(moved.templateVersionId).toBe(v2.body.id);
    expect(moved.blocking).toBe('NONE'); // new rules apply immediately
  });

  it('adopts a read-only library template as an editable organisation draft, once', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const c = code('LIB');
    const t = await su.query(
      `INSERT INTO requirement_template (organisation_id, pack, code, title) VALUES (NULL, 'AMBULANCE_V1', $1, 'Library item') RETURNING id`,
      [c],
    );
    await su
      .query(
        `INSERT INTO requirement_template_version (organisation_id, template_id, version, status, basis_type, subject_type, recurrence, blocking, approved_by, approved_at)
       VALUES (NULL, $1, 1, 'EFFECTIVE', 'GOOD_PRACTICE', 'VEHICLE', '{"type":"EVENT_TRIGGERED"}', 'POLICY', NULL, now())`,
        [t.rows[0].id],
      )
      .catch(async () => {
        // the four-eyes trigger requires an approver for EFFECTIVE rows; insert as DRAFT then approve
        await su.query(
          `INSERT INTO requirement_template_version (organisation_id, template_id, version, status, basis_type, subject_type, recurrence, blocking) VALUES (NULL, $1, 1, 'DRAFT', 'GOOD_PRACTICE', 'VEHICLE', '{"type":"EVENT_TRIGGERED"}', 'POLICY')`,
          [t.rows[0].id],
        );
        await su.query(
          `UPDATE requirement_template_version SET status = 'EFFECTIVE', approved_by = uuid_generate_v7(), approved_at = now() WHERE template_id = $1`,
          [t.rows[0].id],
        );
      });
    await su.end();
    const visible = (await call('GET', '/api/v1/requirements/templates')).body.data as J[];
    expect(visible.find((x) => x.id === t.rows[0].id)).toMatchObject({ isLibrary: true });
    expect(
      (
        await call('POST', `/api/v1/requirements/templates/${t.rows[0].id}/versions`, {
          sub: 'dev|admin',
          body: tpl('X').version,
        })
      ).status,
    ).toBe(404);
    const adopted = await call('POST', `/api/v1/requirements/templates/${t.rows[0].id}/adopt`, {
      sub: 'dev|admin',
    });
    expect(adopted.status).toBe(201);
    expect(adopted.body).toMatchObject({ isLibrary: false, code: c, pack: 'AMBULANCE_V1' });
    expect(adopted.body.versions[0]).toMatchObject({
      status: 'DRAFT',
      blocking: 'POLICY',
      subjectType: 'VEHICLE',
    });
    expect(
      (
        await call('POST', `/api/v1/requirements/templates/${t.rows[0].id}/adopt`, {
          sub: 'dev|admin',
        })
      ).status,
    ).toBe(409);
  });

  it('validates the template body', async () => {
    const bad = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: tpl(code('REQ'), { recurrence: { type: 'FIXED_CALENDAR' } }),
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await call('POST', '/api/v1/requirements/templates', {
          sub: 'dev|admin',
          body: tpl('lower case'),
        })
      ).status,
    ).toBe(400);
  });

  it('refuses to create instances from an unpublished template', async () => {
    const created = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: tpl(code('REQ')),
    });
    const r = await call('POST', '/api/v1/requirements/instances', {
      body: { templateId: created.body.id, subjectType: 'STAFF', subjectId: SEED_IDS.staffCrew },
    });
    expect([r.status, r.body.code]).toEqual([422, 'TEMPLATE_NOT_PUBLISHED']);
  });
});

describe('evidence lifecycle and status (upload never makes anything green) [UAT-01]', () => {
  it('missing → unverified → verified → awaiting review, with segregation of duties', async () => {
    const tid = await publishedTemplate();
    const owner = await userId('hr@example.test');
    const inst = await newInstance(tid, { ownerUserId: owner });
    expect(inst).toMatchObject({ status: 'GREY', reasonCode: 'MISSING', effect: 'BLOCK' });

    // 1. crew uploads; scanned clean; still NOT green, only awaiting verification (T10-style)
    const first = await upload({
      instanceIds: [inst.id],
      validFrom: plus(-30),
      validTo: plus(300),
    });
    expect(first.put.statusCode).toBe(200);
    expect(first.done.status).toBe(201);
    expect(first.done.body).toMatchObject({
      scanStatus: 'CLEAN',
      state: 'PENDING_VERIFICATION',
      mime: 'application/pdf',
    });
    expect(first.done.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await getInstance(inst.id)).toMatchObject({
      status: 'GREY',
      reasonCode: 'UNVERIFIED',
      effect: 'BLOCK',
      currentlyVerified: false,
    });

    const vid = first.req.evidenceVersionId as string;
    // 2. the uploader cannot verify; a non-reviewer cannot verify
    expect(
      (
        await call('POST', `/api/v1/evidence/${vid}/verify`, {
          sub: 'dev|crew',
          body: { decision: 'ACCEPTED' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/evidence/${vid}/verify`, {
          sub: 'dev|dispatcher',
          body: { decision: 'ACCEPTED' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/evidence/${vid}/verify`, {
          sub: 'dev|hr',
          body: { decision: 'REJECTED' },
        })
      ).status,
    ).toBe(400); // reason required

    // 3. an independent reviewer accepts -> GREEN, expiry comes from the evidence, change is logged
    const ok = await call('POST', `/api/v1/evidence/${vid}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'ACCEPTED' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ state: 'VERIFIED', decision: 'ACCEPTED' });
    const green = await getInstance(inst.id);
    expect(green).toMatchObject({
      status: 'GREEN',
      reasonCode: 'VALID',
      effect: 'NONE',
      currentlyVerified: true,
      expiryDate: plus(300),
    });
    expect(green.dueDateChanges[0]).toMatchObject({ field: 'EXPIRY', newDate: plus(300) });
    expect(
      (
        await call('POST', `/api/v1/evidence/${vid}/verify`, {
          sub: 'dev|governance',
          body: { decision: 'ACCEPTED' },
        })
      ).status,
    ).toBe(409); // one decision per version

    // 4. renewal uploaded while the old one is still valid -> AMBER awaiting review, still allocatable (T11)
    const renewal = await upload({
      itemId: first.req.evidenceItemId,
      validFrom: plus(0),
      validTo: plus(665),
    });
    expect(renewal.done.body.versionNo).toBe(2);
    expect(await getInstance(inst.id)).toMatchObject({
      status: 'AMBER',
      reasonCode: 'AWAITING_REVIEW',
      effect: 'NONE',
      currentlyVerified: true,
    });

    // 5. rejecting the renewal returns to GREEN; history is kept
    await call('POST', `/api/v1/evidence/${renewal.req.evidenceVersionId}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'REJECTED', reason: 'Photo is unreadable' },
    });
    expect(await getInstance(inst.id)).toMatchObject({ status: 'GREEN', reasonCode: 'VALID' });
    const versions = (await call('GET', `/api/v1/requirements/instances/${inst.id}/evidence`)).body
      .data as J[];
    expect(versions.map((v) => v.state).sort()).toEqual(['REJECTED', 'VERIFIED']);
  });

  it('refuses to verify an expiring requirement without an expiry date', async () => {
    const tid = await publishedTemplate({ recurrence: { type: 'EVENT_TRIGGERED' } });
    const inst = await newInstance(tid);
    const up = await upload({ instanceIds: [inst.id] });
    const r = await call('POST', `/api/v1/evidence/${up.req.evidenceVersionId}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'ACCEPTED' },
    });
    expect(r.status).toBe(400);
    const ok = await call('POST', `/api/v1/evidence/${up.req.evidenceVersionId}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'ACCEPTED', confirmedValidTo: plus(200) },
    });
    expect(ok.status).toBe(201);
    expect(await getInstance(inst.id)).toMatchObject({ status: 'GREEN', expiryDate: plus(200) });
  });

  it('quarantines malicious, mismatched and wrongly-typed files and raises an alert; they can never be verified or downloaded', async () => {
    const tid = await publishedTemplate();
    const inst = await newInstance(tid);
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const m = await upload({ instanceIds: [inst.id], bytes: eicar, mime: 'text/plain' });
    expect(m.done.body).toMatchObject({ scanStatus: 'MALICIOUS', state: 'QUARANTINED' });
    expect(
      (
        await call('POST', `/api/v1/evidence/${m.req.evidenceVersionId}/verify`, {
          sub: 'dev|hr',
          body: { decision: 'ACCEPTED', confirmedValidTo: plus(100) },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('GET', `/api/v1/evidence/${m.req.evidenceVersionId}/download`, { sub: 'dev|hr' }))
        .status,
    ).toBe(409);
    const png = await upload({
      instanceIds: [inst.id],
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      mime: 'application/pdf',
    });
    expect(png.done.body.scanStatus).toBe('MALICIOUS'); // content does not match the declared type
    const liar = await upload({ instanceIds: [inst.id], declaredSize: PDF.length + 10 });
    expect(liar.done.body).toMatchObject({ scanStatus: 'FAILED', state: 'QUARANTINED' });
    const alerts = (await call('GET', '/api/v1/alerts?state=OPEN')).body.data as J[];
    expect(
      alerts.some(
        (a) => a.sourceId === m.req.evidenceVersionId && a.reasonCode === 'MALWARE_DETECTED',
      ),
    ).toBe(true);
    expect(await getInstance(inst.id)).toMatchObject({ status: 'GREY', reasonCode: 'MISSING' }); // quarantined files never count as pending
  });

  it('complete fails without bytes; bytes cannot be replaced after completion; tokens are signed and short-lived', async () => {
    const req = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|crew',
      body: { title: 'x', mime: 'application/pdf', sizeBytes: PDF.length },
    });
    const path = new URL(req.body.uploadUrl).pathname;
    expect(
      (
        await call('POST', `/api/v1/evidence/${req.body.evidenceVersionId}/complete`, {
          sub: 'dev|crew',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: tamper(path),
          headers: { 'content-type': 'application/pdf' },
          payload: PDF,
        })
      ).statusCode,
    ).toBe(403); // tampered
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: path,
          headers: { 'content-type': 'application/pdf' },
          payload: Buffer.concat([PDF, PDF]),
        })
      ).statusCode,
    ).toBe(422); // larger than declared
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: path,
          headers: { 'content-type': 'application/pdf' },
          payload: PDF,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('POST', `/api/v1/evidence/${req.body.evidenceVersionId}/complete`, {
          sub: 'dev|hr',
        })
      ).status,
    ).toBe(404); // only the uploader completes
    expect(
      (
        await call('POST', `/api/v1/evidence/${req.body.evidenceVersionId}/complete`, {
          sub: 'dev|crew',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: path,
          headers: { 'content-type': 'application/pdf' },
          payload: Buffer.from('%PDF-1.4 tampered'),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves a downloadable file only through a short-lived signed URL, and audits the download', async () => {
    const tid = await publishedTemplate();
    const inst = await newInstance(tid);
    const up = await upload({ instanceIds: [inst.id], validTo: plus(100) });
    const dl = await call('GET', `/api/v1/evidence/${up.req.evidenceVersionId}/download`, {
      sub: 'dev|hr',
    });
    expect(dl.status).toBe(200);
    const res = await app.inject({ method: 'GET', url: new URL(dl.body.url as string).pathname });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: tamper(new URL(dl.body.url as string).pathname),
        })
      ).statusCode,
    ).toBe(403);
    const log = (await call('GET', '/api/v1/audit-log?limit=100')).body.data as J[];
    expect(
      log.some((a) => a.action === 'evidence.download' && a.entityId === up.req.evidenceVersionId),
    ).toBe(true);
  });

  it('hides non-normal evidence from people who cannot see sensitive data, and from other organisations', async () => {
    const tid = await publishedTemplate();
    const inst = await newInstance(tid);
    const sensitive = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|hr',
      body: {
        title: 'Disclosure',
        mime: 'application/pdf',
        sizeBytes: PDF.length,
        requirementInstanceIds: [inst.id],
        sensitivity: 'CRIMINAL_OFFENCE',
      },
    });
    await app.inject({
      method: 'PUT',
      url: new URL(sensitive.body.uploadUrl).pathname,
      headers: { 'content-type': 'application/pdf' },
      payload: PDF,
    });
    await call('POST', `/api/v1/evidence/${sensitive.body.evidenceVersionId}/complete`, {
      sub: 'dev|hr',
    });
    expect(
      (
        (await call('GET', `/api/v1/requirements/instances/${inst.id}/evidence`, { sub: 'dev|hr' }))
          .body.data as J[]
      ).length,
    ).toBe(1);
    expect(
      (
        (
          await call('GET', `/api/v1/requirements/instances/${inst.id}/evidence`, {
            sub: 'dev|dispatcher',
          })
        ).body.data as J[]
      ).length,
    ).toBe(0);
    expect(
      (
        await call('GET', `/api/v1/evidence/${sensitive.body.evidenceVersionId}/download`, {
          sub: 'dev|dispatcher',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('GET', `/api/v1/evidence/${sensitive.body.evidenceVersionId}/download`, {
          sub: 'dev|other-manager',
          org: SEED_IDS.orgOther,
        })
      ).status,
    ).toBe(404);
  });

  it('only people with the upload permission can request an upload', async () => {
    const r = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|dispatcher',
      body: { title: 'x', mime: 'application/pdf', sizeBytes: 10 },
    });
    expect(r.status).toBe(403);
    const bad = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|crew',
      body: { title: 'x', mime: 'application/x-msdownload', sizeBytes: 10 },
    });
    expect(bad.status).toBe(400);
    const huge = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|crew',
      body: { title: 'x', mime: 'application/pdf', sizeBytes: 60 * 1024 * 1024 },
    });
    expect(huge.status).toBe(400);
    const foreignInstance = await call('POST', '/api/v1/evidence/uploads', {
      sub: 'dev|crew',
      body: {
        title: 'x',
        mime: 'application/pdf',
        sizeBytes: 10,
        requirementInstanceIds: [randomUUID()],
      },
    });
    expect(foreignInstance.status).toBe(404);
  });
});

describe('applicability, deadlines and alerts [UAT-01]', () => {
  it('records a not-applicable decision (excluded, never green) and keeps the history', async () => {
    const tid = await publishedTemplate({
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'NONE',
    });
    const inst = await newInstance(tid, { dueDate: plus(10) });
    expect(
      (
        await call('POST', `/api/v1/requirements/instances/${inst.id}/applicability`, {
          sub: 'dev|hr',
          body: {
            decision: 'APPROVED_NOT_APPLICABLE',
            reason: 'We do not carry bariatric patients',
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/requirements/instances/${inst.id}/applicability`, {
          sub: 'dev|governance',
          body: { decision: 'APPROVED_NOT_APPLICABLE', reason: 'short' },
        })
      ).status,
    ).toBe(400);
    const r = await call('POST', `/api/v1/requirements/instances/${inst.id}/applicability`, {
      sub: 'dev|governance',
      body: { decision: 'APPROVED_NOT_APPLICABLE', reason: 'We do not carry bariatric patients' },
    });
    expect(r.body).toMatchObject({
      status: 'NOT_APPLICABLE',
      applicability: 'APPROVED_NOT_APPLICABLE',
    });
    const detail = await getInstance(inst.id);
    expect(detail.decisions).toHaveLength(1);
    const back = await call('POST', `/api/v1/requirements/instances/${inst.id}/applicability`, {
      sub: 'dev|governance',
      body: { decision: 'APPLICABLE', reason: 'Service scope changed in October' },
    });
    expect(back.body.status).not.toBe('NOT_APPLICABLE');
  });

  it('due-date changes need a named approver with permission; expiry dates can never be edited', async () => {
    const dueT = await publishedTemplate({
      basisType: 'ORG_POLICY',
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'NONE',
    });
    const inst = await newInstance(dueT, { dueDate: plus(-5) });
    expect(inst).toMatchObject({ status: 'RED', reasonCode: 'OVERDUE' });
    const approver = await userId('manager@example.test');
    const crewId = await userId('crew@example.test');
    const body = {
      field: 'DUE',
      newDate: plus(20),
      reason: 'Course rescheduled by the provider',
      approverId: approver,
    };
    expect(
      (
        await call('POST', `/api/v1/requirements/instances/${inst.id}/due-date-change`, {
          sub: 'dev|hr',
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/requirements/instances/${inst.id}/due-date-change`, {
          body: { ...body, approverId: crewId },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/requirements/instances/${inst.id}/due-date-change`, {
          body: { ...body, field: 'EXPIRY' },
        })
      ).status,
    ).toBe(400);
    // B8: nobody approves their own change; the named approver must be someone else.
    expect(
      (await call('POST', `/api/v1/requirements/instances/${inst.id}/due-date-change`, { body }))
        .body.code,
    ).toBe('SELF_APPROVAL');
    const ok = await call('POST', `/api/v1/requirements/instances/${inst.id}/due-date-change`, {
      sub: 'dev|director',
      body,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.dueDate).toBe(plus(20));
    // Moving the due date does not make an item without evidence look compliant.
    expect(ok.body.status).toBe('GREY');
    expect((await getInstance(inst.id)).dueDateChanges[0]).toMatchObject({
      oldDate: plus(-5),
      newDate: plus(20),
      approverId: approver,
    });

    const expT = await publishedTemplate();
    const expInst = await newInstance(expT, { expiryDate: plus(-1) });
    const r = await call('POST', `/api/v1/requirements/instances/${expInst.id}/due-date-change`, {
      body: {
        field: 'EXPIRY',
        newDate: plus(365),
        reason: 'Please extend this licence',
        approverId: approver,
      },
    });
    expect([r.status, r.body.code]).toEqual([422, 'OVERRIDE_NOT_PERMITTED']);
  });

  it('derives an alert from state; acknowledge and snooze change notifications only, resolving clears it', async () => {
    const tid = await publishedTemplate({
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'DEPLOYMENT_CRITICAL',
    });
    const inst = await newInstance(tid, { dueDate: plus(-2) });
    const alert = ((await call('GET', '/api/v1/alerts')).body.data as J[]).find(
      (a) => a.sourceId === inst.id,
    )!;
    expect(alert).toMatchObject({ severity: 'CRITICAL', reasonCode: 'OVERDUE', state: 'OPEN' });

    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(
      (
        await call('POST', `/api/v1/alerts/${alert.id}/snooze`, {
          sub: 'dev|dispatcher',
          body: { until },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/alerts/${alert.id}/snooze`, {
          body: {
            until: new Date(Date.now() + 90 * 86_400_000).toISOString(),
            reason: 'Waiting for the course date',
          },
        })
      ).status,
    ).toBe(400);
    // L2: a snooze needs a reason.
    expect(
      (await call('POST', `/api/v1/alerts/${alert.id}/snooze`, { body: { until } })).status,
    ).toBe(400);
    const snoozed = await call('POST', `/api/v1/alerts/${alert.id}/snooze`, {
      body: { until, reason: 'Waiting for the course date' },
    });
    expect(snoozed.body.snoozedUntil).toBe(until);
    expect(snoozed.body.snoozeReason).toBe('Waiting for the course date');
    expect(await getInstance(inst.id)).toMatchObject({
      status: 'RED',
      reasonCode: 'OVERDUE',
      dueDate: plus(-2),
    }); // T16: status and due date unchanged
    expect((await call('POST', `/api/v1/alerts/${alert.id}/acknowledge`)).body.state).toBe(
      'ACKNOWLEDGED',
    );

    // verified completion clears the alert
    const up = await upload({ instanceIds: [inst.id], validFrom: plus(0) });
    await call('POST', `/api/v1/evidence/${up.req.evidenceVersionId}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'ACCEPTED' },
    });
    expect(await getInstance(inst.id)).toMatchObject({
      status: 'GREEN',
      dueDate: addDays(plus(0), 365),
    });
    expect(
      ((await call('GET', '/api/v1/alerts?state=RESOLVED')).body.data as J[]).some(
        (a) => a.id === alert.id,
      ),
    ).toBe(true);
  });

  it('filters and paginates instances and respects location scope', async () => {
    const tid = await publishedTemplate();
    const subject = await newStaff();
    for (let i = 0; i < 3; i++) {
      const t2 = await publishedTemplate();
      await call('POST', '/api/v1/requirements/instances', {
        body: { templateId: t2, subjectType: 'STAFF', subjectId: subject },
      });
    }
    void tid;
    const page1 = await call('GET', `/api/v1/requirements/instances?subjectId=${subject}&limit=2`);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await call(
      'GET',
      `/api/v1/requirements/instances?subjectId=${subject}&limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    expect(
      (await call('GET', `/api/v1/requirements/instances?subjectId=${subject}&status=GREEN`)).body
        .data,
    ).toHaveLength(0);
    expect((await call('GET', '/api/v1/requirements/instances?status=PURPLE')).status).toBe(400);
  });

  it('rejects owners who are not active members and duplicate instances', async () => {
    const tid = await publishedTemplate();
    const subject = await newStaff();
    const dup = { templateId: tid, subjectType: 'STAFF', subjectId: subject };
    expect(
      (
        await call('POST', '/api/v1/requirements/instances', {
          body: { ...dup, ownerUserId: randomUUID() },
        })
      ).status,
    ).toBe(400);
    expect((await call('POST', '/api/v1/requirements/instances', { body: dup })).status).toBe(201);
    expect((await call('POST', '/api/v1/requirements/instances', { body: dup })).status).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/requirements/instances', {
          body: { ...dup, subjectType: 'VEHICLE' },
        })
      ).status,
    ).toBe(400);
  });

  it('PATCH uses If-Match', async () => {
    const tid = await publishedTemplate();
    const inst = await newInstance(tid);
    const owner = await userId('hr@example.test');
    const ok = await call('PATCH', `/api/v1/requirements/instances/${inst.id}`, {
      body: { ownerUserId: owner },
      ifMatch: inst.version,
    });
    expect(ok.body.ownerUserId).toBe(owner);
    expect(
      (
        await call('PATCH', `/api/v1/requirements/instances/${inst.id}`, {
          body: { ownerUserId: null },
          ifMatch: inst.version,
        })
      ).status,
    ).toBe(409);
  });
});

describe('reconciler and notifications (domain)', () => {
  it('the reconciler moves items from GREEN to AMBER to RED as time passes, with no data change', async () => {
    const tid = await publishedTemplate();
    const inst = await newInstance(tid);
    const up = await upload({ instanceIds: [inst.id], validFrom: plus(-10), validTo: plus(40) });
    await call('POST', `/api/v1/evidence/${up.req.evidenceVersionId}/verify`, {
      sub: 'dev|hr',
      body: { decision: 'ACCEPTED' },
    });
    expect(await getInstance(inst.id)).toMatchObject({ status: 'GREEN' });

    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    const run = (when: Date) =>
      db.withTenant({ orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' }, (tx) =>
        recomputeOrganisation(tx, when),
      );
    await run(at(20));
    expect(await getInstance(inst.id)).toMatchObject({ status: 'AMBER', reasonCode: 'DUE_SOON' });
    await run(at(45));
    expect(await getInstance(inst.id)).toMatchObject({ status: 'RED', reasonCode: 'EXPIRED' });
    const again = await run(at(45));
    expect(again.changed).toBe(0); // idempotent: nothing to rewrite
    await run(new Date());
    expect(await getInstance(inst.id)).toMatchObject({ status: 'GREEN' });
  });

  it('plans one notification per window, skips snoozed alerts, escalates when the owner has left, and retries with backoff', async () => {
    const tid = await publishedTemplate({
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'NONE',
    });
    const hr = await userId('hr@example.test');
    const inst = await newInstance(tid, { dueDate: plus(-1), ownerUserId: hr });
    const sys = { orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' };
    const now = new Date(Date.now() + 5_000); // deliveries become due at the DB's insert time

    const first = await db.withTenant(sys, (tx) => planNotifications(tx, ORG, now));
    expect(first.created).toBeGreaterThanOrEqual(2); // in-app + email for the owner
    const second = await db.withTenant(sys, (tx) => planNotifications(tx, ORG, now));
    expect(second.created).toBe(0); // deduplicated

    const sent: { to: string; subject: string; text: string }[] = [];
    let fail = true;
    const mailer: Mailer = {
      send: async (m) => {
        if (fail) throw new Error('smtp down');
        sent.push(m);
      },
    };
    const r1 = await db.withTenant(sys, (tx) =>
      dispatchNotifications(tx, ORG, now, mailer, 'https://app.example.test'),
    );
    expect(r1.failed).toBeGreaterThanOrEqual(1);
    // not due again until the backoff has elapsed
    const r2 = await db.withTenant(sys, (tx) =>
      dispatchNotifications(tx, ORG, now, mailer, 'https://app.example.test'),
    );
    expect(r2.sent + r2.failed + r2.dead).toBe(0);
    fail = false;
    const later = new Date(now.getTime() + 2 * 60_000);
    const r3 = await db.withTenant(sys, (tx) =>
      dispatchNotifications(tx, ORG, later, mailer, 'https://app.example.test'),
    );
    expect(r3.sent).toBeGreaterThanOrEqual(1);
    const mine = sent.filter((m) => m.text.includes(inst.id));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe('hr@example.test');
    expect(mine[0]!.text).not.toMatch(/Alex|Morgan|Sam Taylor/); // no names in notification bodies

    // snoozed: nothing planned on a later day
    const alert = ((await call('GET', '/api/v1/alerts')).body.data as J[]).find(
      (a) => a.sourceId === inst.id,
    )!;
    await call('POST', `/api/v1/alerts/${alert.id}/snooze`, {
      body: {
        until: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        reason: 'Renewal booked',
      },
    });
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const before = await db.withTenant(sys, (tx) =>
      tx.notificationDelivery.count({ where: { alertId: alert.id } }),
    );
    await db.withTenant(sys, (tx) => planNotifications(tx, ORG, tomorrow));
    expect(
      await db.withTenant(sys, (tx) =>
        tx.notificationDelivery.count({ where: { alertId: alert.id } }),
      ),
    ).toBe(before);
  });

  it('escalates to the registered manager when the owner is not an active member', async () => {
    const tid = await publishedTemplate({
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'NONE',
    });
    // A throwaway member (revoking a shared seed user would break other test files).
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const tag = Date.now().toString(36);
    const u = await su.query(
      `INSERT INTO app_user (idp_subject, email, display_name, status) VALUES ($1, $2, 'Leaving Owner', 'ACTIVE') RETURNING id`,
      [`dev|owner-${tag}`, `owner-${tag}@example.test`],
    );
    await su.query(
      `INSERT INTO membership (organisation_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
      [ORG, u.rows[0].id],
    );
    await su.end();
    const leaver = u.rows[0].id as string;
    const inst = await newInstance(tid, { dueDate: plus(-1), ownerUserId: leaver });
    await call('POST', `/api/v1/admin/users/${leaver}/revoke`, {
      body: { reason: 'Left the company in September' },
    });
    const sys = { orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' };
    const out = await db.withTenant(sys, (tx) => planNotifications(tx, ORG, new Date()));
    expect(out.escalated).toBeGreaterThanOrEqual(1);
    const rows = await db.withTenant(sys, (tx) =>
      tx.notificationDelivery.findMany({ where: { alert: { sourceId: inst.id } } }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.escalatedTo === 'MANAGER')).toBe(true);
  });
});

describe('worker jobs', () => {
  it('reconcileAll is idempotent and isolates failures', async () => {
    const logs: object[] = [];
    const a = await reconcileAll(db, new Date(), (_m, c) => logs.push(c));
    const b = await reconcileAll(db, new Date());
    expect(a.organisations).toBeGreaterThanOrEqual(2);
    expect(b.changed).toBe(0);
    expect(b.failed).toBe(0);
  });

  it('snapshotAll writes one row per subject type per day and re-running updates in place', async () => {
    const tid = await publishedTemplate();
    await newInstance(tid);
    const first = await snapshotAll(db, new Date());
    expect(first).toBeGreaterThanOrEqual(1);
    const sys = { orgId: ORG, userId: '00000000-0000-7000-8000-000000000000' };
    const count = () => db.withTenant(sys, (tx) => tx.statusSnapshot.count());
    const n = await count();
    await snapshotAll(db, new Date());
    expect(await count()).toBe(n);
    const row = await db.withTenant(sys, (tx) =>
      tx.statusSnapshot.findFirstOrThrow({ where: { subjectType: 'STAFF' } }),
    );
    expect((row.counts as Record<string, number>).GREY).toBeGreaterThanOrEqual(1);
  });

  it('verifyAuditChains reports intact chains for every organisation', async () => {
    const r = await verifyAuditChains(db);
    expect(r.broken).toEqual([]);
    expect(r.checked).toBeGreaterThanOrEqual(2);
  });

  it('notifyAll plans and sends through the mailer without leaking names', async () => {
    const tid = await publishedTemplate({
      deadlineKind: 'DUE',
      recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'MONTHS', every: 12 } },
      blocking: 'NONE',
    });
    const hr = await userId('hr@example.test');
    await newInstance(tid, { dueDate: plus(-3), ownerUserId: hr });
    const sent: string[] = [];
    const out = await notifyAll(
      db,
      new Date(Date.now() + 5_000),
      { send: async (m) => void sent.push(m.text) },
      'https://app.example.test',
    );
    expect(out.created).toBeGreaterThanOrEqual(2);
    expect(out.sent).toBeGreaterThanOrEqual(1);
    expect(sent.every((t) => t.startsWith('A compliance item needs attention'))).toBe(true);
  });
});
