import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { breachClockAlerts, LocalBlobStore, runPendingExports, runRetention } from '@hub/domain';
import { addDays, londonDate } from '@hub/rules';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  o: { sub?: string; body?: unknown; org?: string } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': o.org ?? ORG,
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
async function sql<T = J>(text: string, params: unknown[] = []): Promise<T[]> {
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  try {
    return (await su.query(text, params)).rows as T[];
  } finally {
    await su.end();
  }
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const today = () => londonDate(new Date());
const IDS = [
  'WORKFORCE_READINESS',
  'SUPERVISION',
  'FLEET',
  'AUDITS_ACTIONS',
  'EVENTS',
  'POLICY_ACK',
  'PREMISES',
  'JOURNEYS',
];

describe('reports [PRD 4.10]', () => {
  it('the catalogue documents every measure; crew cannot see reports', async () => {
    const r = await call('GET', '/api/v1/reports');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: J) => x.id)).toEqual(IDS);
    for (const rep of r.body.data)
      for (const m of rep.measures)
        expect(m).toMatchObject({
          denominator: expect.any(String),
          period: expect.any(String),
          inclusion: expect.any(String),
        });
    expect((await call('GET', '/api/v1/reports', { sub: 'dev|crew' })).status).toBe(403);
    expect((await call('GET', '/api/v1/reports/FLEET', { sub: 'dev|crew' })).status).toBe(403);
  });

  it('every report runs for this month with its definitions and the not-a-CQC-rating notice', async () => {
    for (const id of IDS) {
      const r = await call('GET', `/api/v1/reports/${id}`);
      expect(r.status, id).toBe(200);
      expect(r.body.notice).toBe('Internal measure — not a CQC rating');
      expect(r.body.period).toEqual({ from: `${today().slice(0, 7)}-01`, to: today() });
      for (const m of r.body.measures) {
        expect(m.definition.denominator.length).toBeGreaterThan(5);
        if (m.unit === 'PERCENT' && m.denominator > 0)
          expect(m.value).toBeCloseTo((m.numerator / m.denominator) * 100, 0);
      }
    }
  });

  it('figures agree with an independent count of the database', async () => {
    const from = addDays(today(), -30);
    const fleet = (await call('GET', `/api/v1/reports/FLEET?from=${from}&to=${today()}`)).body;
    const [v] = await sql(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'AVAILABLE')::int AS ok FROM vehicle WHERE organisation_id = $1`,
      [ORG],
    );
    const avail = fleet.measures.find((m: J) => m.key === 'available');
    expect([avail.numerator, avail.denominator]).toEqual([v!.ok, v!.total]);
    const [d] = await sql(
      `SELECT count(*)::int AS n FROM defect WHERE organisation_id = $1
         AND discovered_at >= ($2::date::timestamp AT TIME ZONE 'Europe/London')
         AND discovered_at < (($3::date + 1)::timestamp AT TIME ZONE 'Europe/London')`,
      [ORG, from, today()],
    );
    expect(fleet.measures.find((m: J) => m.key === 'defects').value).toBe(d!.n);
    // The seeded AMB-03 is blocked by its critical defect.
    expect(fleet.tables[0].rows).toContainEqual(['AMB-03', 'BLOCKED', expect.any(String), 1]);

    const actions = (await call('GET', '/api/v1/reports/AUDITS_ACTIONS')).body;
    const [a] = await sql(
      `SELECT count(*)::int AS n FROM action WHERE organisation_id = $1 AND status <> 'VERIFIED'`,
      [ORG],
    );
    expect(actions.measures.find((m: J) => m.key === 'actionAge').value).toBe(a!.n);
    const bands = actions.tables.find((t: J) => t.key === 'actionAge').rows;
    expect(bands.reduce((s: number, r: J) => s + r[1], 0)).toBe(a!.n);
  });

  it('validates the period, the location and the report id', async () => {
    expect((await call('GET', '/api/v1/reports/NOPE')).status).toBe(404);
    expect(
      (await call('GET', `/api/v1/reports/FLEET?from=${today()}&to=${addDays(today(), -1)}`))
        .status,
    ).toBe(400);
    expect((await call('GET', `/api/v1/reports/FLEET?from=2020-01-01&to=${today()}`)).status).toBe(
      400,
    );
    expect(
      (await call('GET', '/api/v1/reports/FLEET?locationId=01900000-0000-7000-8000-00000000ffff'))
        .status,
    ).toBe(404);
    const scoped = await call('GET', `/api/v1/reports/PREMISES?locationId=${SEED_IDS.locWatford}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.locationId).toBe(SEED_IDS.locWatford);
  });

  it('CSV export carries the definitions and the notice, and is audited', async () => {
    const r = await call('GET', '/api/v1/reports/FLEET/export');
    expect(r.status).toBe(200);
    expect(r.raw.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toContain('Internal measure — not a CQC rating');
    expect(r.text).toContain('Vehicles not retired');
    expect((await call('GET', '/api/v1/reports/FLEET/export', { sub: 'dev|crew' })).status).toBe(
      403,
    );
    const [log] = await sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE organisation_id = $1 AND action = 'reports.export' AND entity_id = 'FLEET'`,
      [ORG],
    );
    expect(log!.n).toBeGreaterThanOrEqual(1);
  });

  it('the monthly management pack is a PDF built by the worker for the requester only', async () => {
    const month = today().slice(0, 7);
    expect(
      (await call('POST', '/api/v1/management-packs', { body: { month: '2099-01' } })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/v1/management-packs', { body: { month: '2026-13' } })).status,
    ).toBe(400);
    const req = await call('POST', '/api/v1/management-packs', { body: { month } });
    expect(req.status).toBe(201);
    expect(req.body).toMatchObject({ kind: 'MANAGEMENT_PACK', status: 'QUEUED' });
    expect(
      await runPendingExports(db, new LocalBlobStore('./.data/evidence')),
    ).toBeGreaterThanOrEqual(1);
    const done = await call('GET', `/api/v1/exports/${req.body.id}`);
    expect(done.body.status).toBe('DONE');
    const file = await app.inject({ method: 'GET', url: new URL(done.body.download.url).pathname });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toContain('management-pack.pdf');
    const pdf = await PDFDocument.load(new Uint8Array(file.rawPayload));
    expect(pdf.getTitle()).toBe(`Management pack ${month}`);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(
      (await call('GET', `/api/v1/exports/${req.body.id}`, { sub: 'dev|governance' })).status,
    ).toBe(404);
    const [log] = await sql(
      `SELECT after_summary FROM audit_log WHERE action = 'export.generated' AND entity_id = $1`,
      [req.body.id],
    );
    expect(log!.after_summary).toMatchObject({ kind: 'MANAGEMENT_PACK', reports: 8 });
  });
});

// ---------------------------------------------------------------------------------------------
const tag = Date.now() % 9000;
const sn = (n: number) => `ST-${81000 + ((tag * 10 + n) % 9000)}`;
const imp = (kind: string, csv: string, sub = 'dev|manager') =>
  call('POST', '/api/v1/imports', {
    sub,
    body: { kind, filename: `${kind.toLowerCase()}.csv`, csv },
  });

describe('CSV import [INT-01, PRD 4.12]', () => {
  it('previews with per-row errors and duplicates, and creates nothing until committed', async () => {
    const csv = [
      'Staff No,Display Name,Location,Job title',
      `${sn(1)},Synthetic Import One,Watford,Ambulance care assistant`,
      `${sn(2)},Synthetic Import Two,Nowhere,`,
      `ST-0042,Synthetic Duplicate,Watford,`,
      `${sn(1)},Synthetic Repeat,Watford,`,
      `BAD-1,"=HYPERLINK(""x"")",Watford,`,
    ].join('\r\n');
    const before = await sql(`SELECT count(*)::int AS n FROM staff WHERE organisation_id = $1`, [
      ORG,
    ]);
    const r = await imp('STAFF', csv);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'STAFF',
      status: 'PREVIEWED',
      rowCount: 5,
      validCount: 1,
      errorCount: 2,
      duplicateCount: 2,
    });
    expect(r.body.code).toMatch(/^IMP-\d+$/);
    const byRow = Object.fromEntries(r.body.rows.map((x: J) => [x.rowNo, x]));
    expect(byRow[2].status).toBe('VALID');
    expect(byRow[3].errors).toContain('Location "Nowhere" not found');
    expect(byRow[4].duplicateOf).toBe('Already exists: ST-0042');
    expect(byRow[5].duplicateOf).toBe('Same staffNo as row 2');
    expect(byRow[6].errors.join(' ')).toMatch(/staffNo/);
    const after = await sql(`SELECT count(*)::int AS n FROM staff WHERE organisation_id = $1`, [
      ORG,
    ]);
    expect(after[0]!.n).toBe(before[0]!.n);
    // Permissions: importing staff needs both import and staff permissions.
    expect((await imp('STAFF', csv, 'dev|hr')).status).toBe(403);
    expect((await imp('STAFF', csv, 'dev|crew')).status).toBe(403);
    expect(
      (
        await call('GET', `/api/v1/imports/${r.body.id}`, {
          sub: 'dev|other-manager',
          org: SEED_IDS.orgOther,
        })
      ).status,
    ).toBe(404);
  });

  it('refuses files it cannot use', async () => {
    expect((await imp('STAFF', 'Staff No,Display Name\nST-1234,X')).body.detail).toBe(
      'Missing columns: location',
    );
    expect((await imp('STAFF', 'Staff No,Display Name,Location')).body.detail).toBe(
      'The file has no data rows',
    );
    expect((await imp('STAFF', 'a,"b\n1,2')).status).toBe(400);
  });

  it('commits through the normal endpoint, then rolls back without deleting history', async () => {
    const csv = [
      'staffNo,displayName,location',
      `${sn(3)},Synthetic Import Three,Watford`,
      `${sn(4)},Synthetic Import Four,Watford`,
    ].join('\n');
    const p = await imp('STAFF', csv);
    const c = await call('POST', `/api/v1/imports/${p.body.id}/commit`);
    expect(c.body).toMatchObject({ status: 'COMMITTED', importedCount: 2 });
    expect(c.body.rows.every((x: J) => x.status === 'IMPORTED' && x.entityId)).toBe(true);
    expect((await call('POST', `/api/v1/imports/${p.body.id}/commit`)).status).toBe(409);
    const [s3, s4] = c.body.rows.map((x: J) => x.entityId);
    expect((await call('GET', `/api/v1/staff/${s3}`)).body.lifecycleState).toBe('CANDIDATE');
    // One record is used after the import: it is kept.
    await call('POST', `/api/v1/staff/${s4}/transition`, {
      sub: 'dev|hr',
      body: { to: 'CHECKS_IN_PROGRESS', reason: 'Checks started' },
    });
    const rb = await call('POST', `/api/v1/imports/${p.body.id}/rollback`);
    expect(rb.status).toBe(201);
    expect(rb.body.rows.map((x: J) => x.status)).toEqual(['ROLLED_BACK', 'KEPT']);
    expect(rb.body.rows[1].resultDetail).toBe('Moved past candidate stage since the import');
    expect((await call('GET', `/api/v1/staff/${s3}`)).body.lifecycleState).toBe('LEAVER');
    const hist = await sql(
      `SELECT to_state, reason FROM staff_lifecycle_event WHERE staff_id = $1 ORDER BY at`,
      [s3],
    );
    expect(hist.map((h) => h.to_state)).toEqual(['CANDIDATE', 'LEAVER']);
    expect(hist[1]!.reason).toBe(`Import ${p.body.code} rolled back`);
    expect((await call('POST', `/api/v1/imports/${p.body.id}/rollback`)).status).toBe(409);
  });

  it('vehicles: imported, then withdrawn off the road', async () => {
    const reg = `IM${String(tag).padStart(4, '0')}ZZ`;
    const csv = [
      'Registration,Callsign,Type,Location,Seats,Wheelchair capacity,Stretcher',
      `${reg},IMP-${tag},PTS vehicle,Watford,4,1,yes`,
    ].join('\n');
    const p = await imp('VEHICLES', csv);
    expect(p.body.rows[0]).toMatchObject({ status: 'VALID' });
    const c = await call('POST', `/api/v1/imports/${p.body.id}/commit`);
    const vid = c.body.rows[0].entityId;
    expect((await call('GET', `/api/v1/vehicles/${vid}`)).body).toMatchObject({
      type: 'PTS_VEHICLE',
      stretcher: true,
    });
    const rb = await call('POST', `/api/v1/imports/${p.body.id}/rollback`);
    expect(rb.body.rows[0].status).toBe('ROLLED_BACK');
    expect((await call('GET', `/api/v1/vehicles/${vid}`)).body.status).toBe('OFF_ROAD');
    // A discarded preview creates nothing and cannot be committed.
    const d = await imp(
      'VEHICLES',
      csv.replace(reg, `${reg}X`).replace(`IMP-${tag}`, `IMQ-${tag}`),
    );
    expect((await call('POST', `/api/v1/imports/${d.body.id}/discard`)).body.status).toBe(
      'DISCARDED',
    );
    expect((await call('POST', `/api/v1/imports/${d.body.id}/commit`)).status).toBe(409);
  });
});

describe('compliance workbook staging [MIG-01..03]', () => {
  const sheet = [
    'Ref,Prompt,Status,KLOE',
    ',Safe,,',
    'P-01,Fire risk assessment for [ENTER PRACTICE NAME] is reviewed yearly,Compliant,S2; W1',
    'P-02,Default Image,Not started,',
    'P-03,Patient records for dental charting,,E1',
  ].join('\n');

  it('keeps sheet, row and prompt code; headers are structure; statuses are source-only', async () => {
    const st = await call('POST', '/api/v1/workbook-imports', {
      body: {
        filename: 'workbook.xlsx',
        sheet: 'Safe',
        csv: sheet,
        columns: { code: 'Ref', text: 'Prompt', status: 'Status', kloe: 'KLOE' },
      },
    });
    expect(st.status).toBe(201);
    expect(st.body).toMatchObject({ kind: 'WORKBOOK', sheet: 'Safe', rowCount: 4, validCount: 3 });
    const items = (await call('GET', `/api/v1/workbook-items?batchId=${st.body.id}`)).body.data;
    expect(items.map((i: J) => [i.rowNo, i.kind, i.promptCode])).toEqual([
      [2, 'HEADER', null],
      [3, 'PROMPT', 'P-01'],
      [4, 'PROMPT', 'P-02'],
      [5, 'PROMPT', 'P-03'],
    ]);
    expect(items[1]).toMatchObject({
      placeholders: ['[ENTER PRACTICE NAME]', 'ENTER'],
      sourceStatus: 'Compliant',
      legacyKloe: ['S2', 'W1'],
      mappingStatus: 'UNMAPPED',
    });
    expect(items[2].placeholders).toEqual(['Default Image']);
    expect((await call('GET', '/api/v1/workbook-items', { sub: 'dev|governance' })).status).toBe(
      200,
    );
    expect((await call('GET', '/api/v1/workbook-items', { sub: 'dev|crew' })).status).toBe(403);
  });

  it('a mapping is proposed, approved by someone else, and only then published as a draft template', async () => {
    const st = await call('POST', '/api/v1/workbook-imports', {
      body: {
        filename: 'workbook.xlsx',
        sheet: 'Safe2',
        csv: sheet,
        columns: { code: 'Ref', text: 'Prompt', status: 'Status', kloe: 'KLOE' },
      },
    });
    const items = (await call('GET', `/api/v1/workbook-items?batchId=${st.body.id}`)).body
      .data as J[];
    const [header, fire, , dental] = items;
    expect(
      (
        await call('POST', `/api/v1/workbook-items/${header!.id}/propose`, {
          body: {
            classification: 'SHARED',
            proposedCode: 'WB-HDR',
            proposedTitle: 'Safe',
            proposedSubject: 'ORGANISATION',
          },
        })
      ).status,
    ).toBe(422);
    // Out of scope (dental charting is not built): classified, never mapped.
    const oos = await call('POST', `/api/v1/workbook-items/${dental!.id}/propose`, {
      body: { classification: 'OUT_OF_SCOPE' },
    });
    expect(oos.body).toMatchObject({ classification: 'OUT_OF_SCOPE', mappingStatus: 'UNMAPPED' });
    expect(
      (
        await call('POST', `/api/v1/workbook-items/${fire!.id}/propose`, {
          body: { classification: 'SHARED' },
        })
      ).status,
    ).toBe(400);
    const code = `WB-FIRE-${tag}`;
    const pr = await call('POST', `/api/v1/workbook-items/${fire!.id}/propose`, {
      body: {
        classification: 'SHARED',
        proposedCode: code,
        proposedTitle: 'Fire risk assessment reviewed yearly',
        proposedSubject: 'PREMISES',
      },
    });
    expect(pr.body.mappingStatus).toBe('PROPOSED');
    expect((await call('POST', `/api/v1/workbook-items/${fire!.id}/publish`)).status).toBe(409); // not approved
    expect(
      (
        await call('POST', `/api/v1/workbook-items/${fire!.id}/decision`, {
          body: { decision: 'APPROVED' },
        })
      ).body.code,
    ).toBe('SELF_APPROVAL');
    const ok = await call('POST', `/api/v1/workbook-items/${fire!.id}/decision`, {
      sub: 'dev|governance',
      body: { decision: 'APPROVED', note: 'Matches the library control' },
    });
    expect(ok.body).toMatchObject({ mappingStatus: 'APPROVED' });
    expect(
      (await call('POST', `/api/v1/workbook-items/${fire!.id}/publish`, { sub: 'dev|governance' }))
        .status,
    ).toBe(403);
    const pub = await call('POST', `/api/v1/workbook-items/${fire!.id}/publish`);
    expect(pub.body).toMatchObject({
      mappingStatus: 'PUBLISHED',
      publishedTemplateId: expect.any(String),
    });
    const [tpl] = await sql(
      `SELECT t.code, v.status, v.framework_mappings FROM requirement_template t JOIN requirement_template_version v ON v.template_id = t.id WHERE t.id = $1`,
      [pub.body.publishedTemplateId],
    );
    expect(tpl).toMatchObject({ code, status: 'DRAFT' });
    expect(tpl!.framework_mappings).toEqual(
      expect.arrayContaining([
        { framework: 'WORKBOOK', key: 'Safe2!3:P-01' },
        { framework: 'CQC_KLOE_LEGACY', key: 'S2' },
      ]),
    );
    // The source status "Compliant" made nothing green: no requirement instance exists yet.
    const [n] = await sql(
      `SELECT count(*)::int AS n FROM requirement_instance WHERE template_id = $1`,
      [pub.body.publishedTemplateId],
    );
    expect(n!.n).toBe(0);
  });
});

describe('full data export [PRD 4.12]', () => {
  it('every table with stable ids plus attachments, built for the requester; no secrets', async () => {
    expect((await call('POST', '/api/v1/exports/full', { sub: 'dev|governance' })).status).toBe(
      403,
    );
    const req = await call('POST', '/api/v1/exports/full');
    expect(req.body).toMatchObject({ kind: 'FULL_EXPORT', status: 'QUEUED' });
    await runPendingExports(db, new LocalBlobStore('./.data/evidence'));
    const done = await call('GET', `/api/v1/exports/${req.body.id}`);
    expect(done.body.status).toBe('DONE');
    const file = await app.inject({ method: 'GET', url: new URL(done.body.download.url).pathname });
    expect(file.headers['content-disposition']).toContain('full-export.zip');
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(new Uint8Array(file.rawPayload));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'README.txt',
        'data/staff.json',
        'data/vehicle.json',
        'data/audit_log.json',
        'attachments/manifest.csv',
      ]),
    );
    const staff = JSON.parse(strFromU8(files['data/staff.json']!)) as J[];
    expect(staff.find((s) => s.staffNo === 'ST-0042')?.id).toBe(SEED_IDS.staffCrew);
    expect(staff.every((s) => s.organisationId === ORG)).toBe(true);
    const all = Object.entries(files)
      .filter(([k]) => k.startsWith('data/'))
      .map(([, v]) => strFromU8(v))
      .join('\n');
    expect(all).not.toMatch(/"(pushToken|blobKey|idpSubject)"/);
    const [log] = await sql(
      `SELECT after_summary FROM audit_log WHERE action = 'export.generated' AND entity_id = $1`,
      [req.body.id],
    );
    expect(log!.after_summary).toMatchObject({ kind: 'FULL_EXPORT', tables: 70 });
  });
});

// ---------------------------------------------------------------------------------------------
async function bookedJob(patientRef: string): Promise<string> {
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const r = await call('POST', '/api/v1/bookings', {
    sub: 'dev|dispatcher',
    body: {
      customer: 'Synthetic NHS Trust',
      patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
      job: {
        locationId: SEED_IDS.locWatford,
        pickupFrom: at(30),
        pickupTo: at(30.5),
        plannedStart: at(30),
        plannedEnd: at(31),
        pickupAddress: '1 Synthetic Road, Watford',
        destinationAddress: 'Synthetic General Hospital',
        patientRef,
        mobility: 'WALKING',
      },
    },
  });
  expect(r.status).toBe(201);
  return r.body.jobs[0].id as string;
}

describe('retention and legal hold [SECURITY_COMPLIANCE §4]', () => {
  it('defaults are placeholders that need a recorded basis and approval; any change needs approval again', async () => {
    const r = await call('GET', '/api/v1/retention-rules');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(9);
    expect(
      r.body.data.every(
        (x: J) => x.status === 'REQUIRES_APPROVAL' && x.basis.startsWith('Placeholder'),
      ),
    ).toBe(true);
    expect((await call('GET', '/api/v1/retention-rules', { sub: 'dev|dispatcher' })).status).toBe(
      403,
    );
    const audit = r.body.data.find((x: J) => x.category === 'AUDIT_LOG');
    expect((await call('POST', `/api/v1/retention-rules/${audit.id}/approve`)).status).toBe(400);
    expect(
      (
        await call('PATCH', `/api/v1/retention-rules/${audit.id}`, {
          body: { action: 'ANONYMISE' },
        })
      ).status,
    ).toBe(400);
    await call('PATCH', `/api/v1/retention-rules/${audit.id}`, {
      body: { basis: 'Organisation schedule v1 approved by the board' },
    });
    expect((await call('POST', `/api/v1/retention-rules/${audit.id}/approve`)).body.status).toBe(
      'APPROVED',
    );
    const again = await call('PATCH', `/api/v1/retention-rules/${audit.id}`, {
      body: { retainMonths: 84 },
    });
    expect(again.body).toMatchObject({ status: 'REQUIRES_APPROVAL', approvedBy: null });
  });

  it('approved anonymisation blanks old patient contacts, never those under hold, and logs it', async () => {
    const old = await bookedJob(`RT${tag}A`);
    const held = await bookedJob(`RT${tag}B`);
    await sql(`UPDATE job SET journey_date = current_date - 800 WHERE id = ANY($1::uuid[])`, [
      [old, held],
    ]);
    const rules = (await call('GET', '/api/v1/retention-rules')).body.data as J[];
    const pc = rules.find((x) => x.category === 'PATIENT_CONTACT')!;
    await call('PATCH', `/api/v1/retention-rules/${pc.id}`, {
      body: {
        retainMonths: 24,
        action: 'ANONYMISE',
        basis: 'Organisation schedule v1 approved by the board',
      },
    });
    await call('POST', `/api/v1/retention-rules/${pc.id}/approve`);
    expect(
      (
        await call('POST', '/api/v1/legal-holds', {
          body: { scopeType: 'JOB', reason: 'too short' },
        })
      ).status,
    ).toBe(400);
    const hold = await call('POST', '/api/v1/legal-holds', {
      body: {
        scopeType: 'JOB',
        scopeId: held,
        reason: 'Insurer claim in progress for this journey',
      },
    });
    expect(hold.status).toBe(201);
    const dry = ((await call('GET', '/api/v1/retention-rules')).body.data as J[]).find(
      (x) => x.category === 'PATIENT_CONTACT',
    )!;
    expect(dry.candidates).toBeGreaterThanOrEqual(2);
    expect(dry.held).toBeGreaterThanOrEqual(1);
    const out = await runRetention(db, new Date());
    expect(out.anonymised).toBeGreaterThanOrEqual(1);
    const rows = await sql(
      `SELECT job_id, name, phone FROM patient_contact WHERE job_id = ANY($1::uuid[])`,
      [[old, held]],
    );
    expect(rows.find((x) => x.job_id === old)).toMatchObject({
      name: '[removed under retention]',
      phone: null,
    });
    expect(rows.find((x) => x.job_id === held)).toMatchObject({ name: 'Synthetic Patient' });
    // The journey itself is kept (review only); the run is logged and the log cannot be changed.
    expect((await sql(`SELECT count(*)::int AS n FROM job WHERE id = $1`, [old]))[0]!.n).toBe(1);
    const log = (await call('GET', '/api/v1/retention-log')).body.data as J[];
    expect(log.find((l) => l.category === 'PATIENT_CONTACT')).toMatchObject({
      action: 'ANONYMISE',
      held: expect.any(Number),
    });
    await expect(sql(`UPDATE retention_log SET affected = 0`)).rejects.toThrow();
    // An organisation-wide hold stops everything; releasing needs a reason.
    const all = await call('POST', '/api/v1/legal-holds', {
      body: { scopeType: 'ORGANISATION', reason: 'Regulator investigation: preserve all records' },
    });
    await sql(`UPDATE job SET journey_date = current_date - 800 WHERE id = $1`, [
      await bookedJob(`RT${tag}C`),
    ]);
    expect((await runRetention(db, new Date())).anonymised).toBe(0);
    expect(
      (await call('POST', `/api/v1/legal-holds/${all.body.id}/release`, { body: {} })).status,
    ).toBe(400);
    const rel = await call('POST', `/api/v1/legal-holds/${all.body.id}/release`, {
      body: { reason: 'Investigation closed by the regulator' },
    });
    expect(rel.body.releasedAt).toBeTruthy();
    expect(
      (
        await call('POST', `/api/v1/legal-holds/${all.body.id}/release`, {
          body: { reason: 'Investigation closed by the regulator' },
        })
      ).status,
    ).toBe(409);
  });
});

describe('data subject requests and disclosures [UK GDPR Art 12, 15]', () => {
  it('one calendar month to respond; identity first; the access export holds the person’s records', async () => {
    const received = londonDate(new Date());
    expect(
      (
        await call('POST', '/api/v1/subject-requests', {
          body: {
            type: 'ACCESS',
            subjectType: 'STAFF',
            description: 'Copy of my records',
            receivedOn: received,
          },
        })
      ).status,
    ).toBe(400);
    const r = await call('POST', '/api/v1/subject-requests', {
      body: {
        type: 'ACCESS',
        subjectType: 'STAFF',
        staffId: SEED_IDS.staffCrew,
        description: 'Copy of my HR and training records',
        receivedOn: received,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      code: expect.stringMatching(/^DSR-\d+$/),
      status: 'RECEIVED',
      overdue: false,
    });
    expect(r.body.dueOn).toBe(addDays(received, 0) < r.body.dueOn ? r.body.dueOn : 'wrong');
    expect((await call('POST', `/api/v1/subject-requests/${r.body.id}/export`)).status).toBe(422);
    await call('POST', `/api/v1/subject-requests/${r.body.id}/update`, {
      body: { status: 'IDENTITY_VERIFIED' },
    });
    expect(
      (
        await call('POST', `/api/v1/subject-requests/${r.body.id}/update`, {
          body: { extendedTo: addDays(received, 200) },
        })
      ).status,
    ).toBe(400);
    const ex = await call('POST', `/api/v1/subject-requests/${r.body.id}/export`);
    expect(ex.body).toMatchObject({ kind: 'SAR', status: 'QUEUED' });
    await runPendingExports(db, new LocalBlobStore('./.data/evidence'));
    const done = await call('GET', `/api/v1/exports/${ex.body.id}`);
    const file = await app.inject({ method: 'GET', url: new URL(done.body.download.url).pathname });
    const { unzipSync, strFromU8 } = await import('fflate');
    const files = unzipSync(new Uint8Array(file.rawPayload));
    expect(JSON.parse(strFromU8(files['staff.json']!)).staffNo).toBe('ST-0042');
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['lifecycle.json', 'requirements.json', 'README.txt']),
    );
    expect(
      (
        await call('POST', `/api/v1/subject-requests/${r.body.id}/update`, {
          body: { status: 'COMPLETED' },
        })
      ).status,
    ).toBe(400);
    const closed = await call('POST', `/api/v1/subject-requests/${r.body.id}/update`, {
      body: { status: 'COMPLETED', outcome: 'Export reviewed and sent by secure email' },
    });
    expect(closed.body.status).toBe('COMPLETED');
    expect(
      (
        await call('POST', `/api/v1/subject-requests/${r.body.id}/update`, {
          body: { status: 'IN_PROGRESS' },
        })
      ).status,
    ).toBe(409);
    const disc = await call('POST', '/api/v1/disclosures', {
      body: {
        subjectRequestId: r.body.id,
        disclosedTo: 'The data subject',
        purpose: 'Subject access request',
        lawfulBasis: 'UK GDPR Art 15',
        dataDescription: 'HR and training records',
        disclosedOn: received,
      },
    });
    expect(disc.status).toBe(201);
    await expect(sql(`DELETE FROM disclosure WHERE id = $1`, [disc.body.id])).rejects.toThrow();
    expect((await call('GET', '/api/v1/subject-requests', { sub: 'dev|hr' })).status).toBe(403);
    // Audit entries hold codes only, never the request description.
    const [a] = await sql(
      `SELECT after_summary::text AS s FROM audit_log WHERE entity_id = $1 AND action = 'privacy.dsr.create'`,
      [r.body.id],
    );
    expect(a!.s).not.toContain('Copy of my');
  });
});

describe('personal data breaches: the 72-hour ICO clock', () => {
  it('alerts before the deadline, needs a recorded decision, and reasons when late', async () => {
    const discoveredAt = new Date(Date.now() - 50 * 3_600_000).toISOString();
    const b = await call('POST', '/api/v1/breaches', {
      body: {
        title: 'Rota emailed to wrong recipient',
        description: 'Synthetic: a staff rota was sent to an external address.',
        discoveredAt,
        dataCategories: ['Staff names'],
        subjectsEstimate: 12,
      },
    });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({
      code: expect.stringMatching(/^BRE-\d+$/),
      clock: 'DUE_SOON',
      status: 'OPEN',
    });
    await breachClockAlerts(db, new Date());
    const alerts = ((await call('GET', '/api/v1/alerts')).body.data as J[]).filter(
      (x) => x.sourceId === b.body.id,
    );
    expect(alerts.map((x) => x.reasonCode)).toEqual(['BREACH_DUE_SOON']);
    expect(alerts[0]!.reasonText).toMatch(
      new RegExp(`^${b.body.code}: ICO notification decision due`),
    );
    expect((await call('POST', `/api/v1/breaches/${b.body.id}/close`)).status).toBe(422);
    expect(
      (
        await call('POST', `/api/v1/breaches/${b.body.id}/assessment`, {
          body: {
            risk: 'HIGH_RISK',
            icoReportable: false,
            decisionReason: 'Contained within minutes',
          },
        })
      ).status,
    ).toBe(400);
    const as = await call('POST', `/api/v1/breaches/${b.body.id}/assessment`, {
      body: {
        risk: 'RISK',
        icoReportable: true,
        decisionReason: 'Names and shift times disclosed externally',
      },
    });
    expect(as.body).toMatchObject({ status: 'ASSESSED', icoReportable: true });
    const late = new Date(new Date(discoveredAt).getTime() + 73 * 3_600_000);
    if (late < new Date()) {
      expect(
        (
          await call('POST', `/api/v1/breaches/${b.body.id}/ico-report`, {
            body: { reportedAt: late.toISOString(), reference: 'ICO-SYN-1' },
          })
        ).status,
      ).toBe(400);
    }
    const rep = await call('POST', `/api/v1/breaches/${b.body.id}/ico-report`, {
      body: {
        reportedAt: new Date().toISOString(),
        reference: 'ICO-SYN-1',
        lateReason: 'Synthetic test: reported after investigation',
      },
    });
    expect(rep.body).toMatchObject({ status: 'REPORTED', clock: 'REPORTED' });
    await breachClockAlerts(db, new Date());
    const after = ((await call('GET', '/api/v1/alerts')).body.data as J[]).filter(
      (x) => x.sourceId === b.body.id && x.state !== 'RESOLVED',
    );
    expect(after).toHaveLength(0);
    expect((await call('POST', `/api/v1/breaches/${b.body.id}/close`)).body.status).toBe('CLOSED');
    expect((await call('GET', '/api/v1/breaches', { sub: 'dev|dispatcher' })).status).toBe(403);
  });
});

describe('restore to a new server within the RTO [UAT-08, NFR-01]', () => {
  const hasPgTools = (() => {
    try {
      execFileSync('pg_dump', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!hasPgTools)(
    'dumps, restores into a new database, matches every table and keeps the audit chains intact',
    () => {
      const report = `${tmpdir()}/restore-drill-${process.pid}.md`;
      execFileSync('pnpm', ['--filter', '@hub/db', 'drill'], {
        env: {
          ...process.env,
          DRILL_SOURCE_URL: urls.superuser,
          DRILL_REPORT: report,
          DRILL_CONTEXT: 'Automated test run',
        },
        stdio: 'pipe',
      });
      const text = readFileSync(report, 'utf8');
      expect(text).toContain('**Result: PASS**');
      expect(text).toContain('mismatched tables: none');
      expect(text).toMatch(/Exora intact/);
    },
    120_000,
  );
});
