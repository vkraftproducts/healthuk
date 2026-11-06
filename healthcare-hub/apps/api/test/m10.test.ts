import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootstrap, migrate, seed, seedSectors, SECTOR_IDS } from '@hub/db/admin';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
/** A database of its own: the mock organisations and adopted templates must not leak into other files. */
const dbName = `hub_sectors_${process.pid}_${Date.now()}`;
const rename = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const server = rename(urls.superuser, 'postgres');
let app: NestFastifyApplication;
let close: () => Promise<void>;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: { sub: string; org: string; body?: unknown },
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub })}`,
      'x-org-id': o.org,
      ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(o.body === undefined ? {} : { payload: JSON.stringify(o.body) }),
  });
  let body: J;
  try {
    body = res.body ? (JSON.parse(res.body) as J) : {};
  } catch {
    body = {};
  }
  return { status: res.statusCode, body };
}
const dental = (m: 'GET' | 'POST', url: string, body?: unknown) =>
  call(m, url, { sub: 'dev|dental-manager', org: SECTOR_IDS.orgDental, body });
const care = (m: 'GET' | 'POST', url: string, body?: unknown) =>
  call(m, url, { sub: 'dev|carehome-manager', org: SECTOR_IDS.orgCareHome, body });

beforeAll(async () => {
  const app_ = rename(urls.app, dbName);
  const admin = rename(urls.admin, dbName);
  await bootstrap({ superuserUrl: server, adminUrl: admin, appUrl: app_ });
  await migrate(admin);
  await seed(admin);
  await seedSectors(admin);
  await seedSectors(admin); // idempotent
  const made = await makeApp({ app: app_ });
  app = made.app;
  close = () => made.db.close();
});
afterAll(async () => {
  await app.close();
  await close();
  const su = new pg.Client({ connectionString: server });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await su.end();
});

async function templateId(who: typeof dental, pack: string): Promise<{ id: string; code: string }> {
  const r = await who('GET', '/api/v1/requirements/templates');
  expect(r.status).toBe(200);
  const t = (r.body.data as J[]).find((x) => x.isLibrary && x.pack === pack);
  expect(t, `a library template for ${pack}`).toBeTruthy();
  return { id: t!.id as string, code: t!.code as string };
}

describe('draft dental and care-home packs with mock organisations', () => {
  it('seeds the mock organisations with staff and inactive draft audit templates', async () => {
    const staff = await dental('GET', '/api/v1/staff');
    expect(staff.status).toBe(200);
    expect((staff.body.data as J[]).length).toBe(3);
    const audits = await dental('GET', '/api/v1/audit-templates');
    expect(audits.status).toBe(200);
    const rows = audits.body.data as J[];
    expect(rows.length).toBe(6);
    expect(rows.every((t) => t.active === false)).toBe(true);
    expect(rows.every((t) => /specialist validation required/.test(t.sourceRef ?? ''))).toBe(true);
    expect(((await care('GET', '/api/v1/audit-templates')).body.data as J[]).length).toBe(8);
  });

  it('keeps the mock organisations apart from each other and from the main one', async () => {
    const own = await dental('GET', '/api/v1/staff');
    expect((own.body.data as J[]).every((s) => /^ST-100/.test(s.staffNo))).toBe(true);
    const cross = await call('GET', '/api/v1/staff', {
      sub: 'dev|dental-manager',
      org: SEED_IDS.orgExample,
    });
    expect([403, 404]).toContain(cross.status);
  });

  it('offers dental templates in the library, all marked as draft content', async () => {
    const r = await dental('GET', '/api/v1/requirements/templates');
    const lib = (r.body.data as J[]).filter((x) => x.isLibrary && x.pack === 'DENTAL_V1');
    expect(lib.length).toBe(20);
    expect(
      lib.every((t) =>
        /Draft pack - specialist validation required/.test(t.versions[0]?.regulationRef ?? ''),
      ),
    ).toBe(true);
    const ch = (await care('GET', '/api/v1/requirements/templates')).body.data as J[];
    expect(ch.filter((x) => x.isLibrary && x.pack === 'CARE_HOME_V1').length).toBe(28);
  });

  it('refuses adoption without a named specialist', async () => {
    const t = await templateId(dental, 'DENTAL_V1');
    const none = await dental('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {});
    expect(none.status).toBe(422);
    expect(none.body.detail ?? none.body.title).toMatch(/specialist/i);
    const blank = await dental('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {
      specialistValidatedBy: 'x',
    });
    expect(blank.status).toBe(400);
    // A5: the specialist's organisation is needed as well as their name.
    const noOrg = await dental('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {
      specialistValidatedBy: 'Mock Specialist',
    });
    expect(noOrg.status).toBe(422);
  });

  it('adopts a dental template as a draft once a specialist is named, and audits who', async () => {
    const t = await templateId(dental, 'DENTAL_V1');
    const ok = await dental('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {
      specialistValidatedBy: 'Mock Specialist, Mock Dental Advisory',
      specialistOrganisation: 'Mock Dental Advisory',
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ isLibrary: false, pack: 'DENTAL_V1' });
    expect(ok.body.versions[0].status).toBe('DRAFT');
    const log = await dental('GET', '/api/v1/audit/events?action=requirements.template.adopt');
    if (log.status === 200)
      expect(JSON.stringify(log.body)).toContain('Mock Specialist, Mock Dental Advisory');
  });

  it('refuses a pack the organisation has not enabled', async () => {
    const t = await templateId(dental, 'CARE_HOME_V1');
    const r = await dental('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {
      specialistValidatedBy: 'Mock Specialist, Mock Advisory',
      specialistOrganisation: 'Mock Advisory',
    });
    expect(r.status).toBe(409);
    const t2 = await templateId(dental, 'DENTAL_V1');
    const r2 = await care('POST', `/api/v1/requirements/templates/${t2.id}/adopt`, {
      specialistValidatedBy: 'Mock Specialist, Mock Advisory',
      specialistOrganisation: 'Mock Advisory',
    });
    expect(r2.status).toBe(409);
  });

  it('gives sector staff sector roles, and the care home services and activities [96, 98]', async () => {
    const dentists = await dental('GET', '/api/v1/staff?role=DENTIST');
    expect((dentists.body.data as J[]).map((s) => s.staffNo)).toEqual(['ST-1001']);
    const carers = await care('GET', '/api/v1/staff?role=SENIOR_CARER');
    expect((carers.body.data as J[]).map((s) => s.staffNo)).toEqual(['ST-2001']);
    const all = (await dental('GET', '/api/v1/staff')).body.data as J[];
    expect(all.every((s) => (s.roles as string[]).length > 0)).toBe(true);
    const su = new pg.Client({ connectionString: rename(urls.superuser, dbName) });
    await su.connect();
    const services = await su.query(`SELECT code FROM service_type WHERE organisation_id = $1`, [
      SECTOR_IDS.orgCareHome,
    ]);
    const activities = await su.query(
      `SELECT code FROM registered_activity WHERE organisation_id = $1`,
      [SECTOR_IDS.orgCareHome],
    );
    await su.end();
    expect(services.rows.map((r) => r.code).sort()).toEqual(['RESIDENTIAL', 'RESPITE']);
    expect(activities.rows.map((r) => r.code).sort()).toEqual(['ACCOMMODATION', 'TDDI']);
  });

  it('keeps ambulance modules and reports out of the dental dashboard and reports [95, 84]', async () => {
    const s = await dental('GET', '/api/v1/dashboard/summary');
    expect(s.status).toBe(200);
    expect(s.body.visibleModules).not.toContain('FLEET');
    expect(s.body.visibleModules).not.toContain('JOBS');
    expect(s.body.visibleTiles).not.toContain('blockedVehicles');
    expect((s.body.modules as J[]).some((m) => m.module === 'FLEET')).toBe(false);
    const list = (await dental('GET', '/api/v1/reports')).body.data as J[];
    expect(list.map((r) => r.id)).not.toContain('FLEET');
    expect(list.map((r) => r.id)).not.toContain('JOURNEYS');
    expect((await dental('GET', '/api/v1/reports/FLEET')).status).toBe(403);
  });

  it('does not ask for a specialist on the ambulance pack', async () => {
    const t = await templateId(
      (m, u, b) => call(m, u, { sub: 'dev|manager', org: SEED_IDS.orgExample, body: b }),
      'AMBULANCE_V1',
    );
    const r = await call('POST', `/api/v1/requirements/templates/${t.id}/adopt`, {
      sub: 'dev|manager',
      org: SEED_IDS.orgExample,
      body: {},
    });
    expect(r.status).toBe(201);
  });
});
