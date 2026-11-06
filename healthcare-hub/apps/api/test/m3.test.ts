import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Opts {
  sub?: string;
  org?: string;
  body?: unknown;
  ifMatch?: number;
}
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, o: Opts = {}) {
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
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
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

let seq = 8000;
async function newStaff(extra: Record<string, unknown> = {}): Promise<J> {
  const r = await call('POST', '/api/v1/staff', {
    body: {
      staffNo: `ST-${seq++}`,
      displayName: 'Synthetic Staff',
      primaryLocationId: SEED_IDS.locWatford,
      ...extra,
    },
  });
  expect(r.status).toBe(201);
  return r.body;
}
const move = (id: string, to: string, sub = 'dev|hr') =>
  call('POST', `/api/v1/staff/${id}/transition`, { sub, body: { to, reason: `Moving to ${to}` } });
const approve = (id: string, role: string, sub = 'dev|hr') =>
  call('POST', `/api/v1/staff/${id}/role-approvals`, {
    sub,
    body: { role, reason: 'Checks complete' },
  });

async function activeStaff(roles: string[] = ['DRIVER']): Promise<J> {
  const s = await newStaff();
  for (const to of ['CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW'])
    expect((await move(s.id, to)).status).toBe(201);
  for (const r of roles) expect((await approve(s.id, r)).status).toBe(201);
  expect((await move(s.id, 'APPROVED_FOR_ROLE')).status).toBe(201);
  expect((await move(s.id, 'ACTIVE')).status).toBe(201);
  return s;
}
async function userId(email: string): Promise<string> {
  const { body } = await call('GET', '/api/v1/admin/users');
  return (body.data as J[]).find((u) => u.email === email)!.id as string;
}
let tseq = 0;
async function staffTemplate(code: string, o: Record<string, unknown> = {}) {
  const c = await call('POST', '/api/v1/requirements/templates', {
    sub: 'dev|admin',
    body: {
      code: `${code}-${Date.now().toString(36).toUpperCase()}${tseq++}`,
      title: code,
      version: {
        basisType: 'STATUTORY',
        subjectType: 'STAFF',
        recurrence: { type: 'COMPLETION_BASED', interval: { unit: 'YEARS', every: 1 } },
        blocking: 'STATUTORY',
        deadlineKind: 'EXPIRY',
        ...o,
      },
    },
  });
  expect(c.status).toBe(201);
  expect(
    (
      await call(
        'POST',
        `/api/v1/requirements/templates/${c.body.id}/versions/${c.body.versions[0].id}/publish`,
      )
    ).status,
  ).toBe(201);
  return c.body.id as string;
}
const window = () => {
  const from = new Date(Date.now() + 3_600_000);
  return `from=${from.toISOString()}&to=${new Date(from.getTime() + 4 * 3_600_000).toISOString()}`;
};

describe('staff register and views [HR-01]', () => {
  it('managers see the profile with status counts; dispatchers see approved roles and restrictions only', async () => {
    const full = await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}`);
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({ staffNo: 'ST-0042', lifecycleState: 'ACTIVE' });
    expect(full.body.roles.sort()).toEqual(['CARE_ASSISTANT', 'DRIVER']);
    expect(full.body).toHaveProperty('counts');
    expect(full.body.events.length).toBeGreaterThanOrEqual(1);

    const limited = await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}`, {
      sub: 'dev|dispatcher',
    });
    expect(limited.status).toBe(200);
    expect(Object.keys(limited.body).sort()).toEqual(
      ['activeRestrictions', 'displayName', 'id', 'lifecycleState', 'roles', 'staffNo'].sort(),
    );
    const list = await call('GET', '/api/v1/staff', { sub: 'dev|dispatcher' });
    expect(list.body.data.every((s: J) => !('userId' in s) && !('counts' in s))).toBe(true);
    // DBS / OH / personal data is never reachable for a dispatcher
    expect(
      (await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}/dbs`, { sub: 'dev|dispatcher' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}/oh-detail`, {
          sub: 'dev|dispatcher',
        })
      ).status,
    ).toBe(403);
  });

  it('crew cannot browse staff; other organisations get 404', async () => {
    expect((await call('GET', '/api/v1/staff', { sub: 'dev|crew' })).status).toBe(403);
    expect(
      (await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}`, { sub: 'dev|crew' })).status,
    ).toBe(403);
    expect(
      (
        await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}`, {
          sub: 'dev|other-manager',
          org: SEED_IDS.orgOther,
        })
      ).status,
    ).toBe(404);
  });

  it('creates candidates with validation, unique staff numbers and same-organisation locations', async () => {
    const s = await newStaff({ jobTitle: 'Driver' });
    expect(s).toMatchObject({
      lifecycleState: 'CANDIDATE',
      overallStatus: 'NOT_APPLICABLE',
      version: 1,
    });
    const dup = await call('POST', '/api/v1/staff', {
      body: { staffNo: s.staffNo, displayName: 'X', primaryLocationId: SEED_IDS.locWatford },
    });
    expect(dup.status).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/staff', {
          body: { staffNo: 'ST-12', displayName: 'X', primaryLocationId: SEED_IDS.locWatford },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/v1/staff', {
          body: { staffNo: `ST-${seq++}`, displayName: 'X', primaryLocationId: SEED_IDS.locOther },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/api/v1/staff', {
          sub: 'dev|dispatcher',
          body: {
            staffNo: `ST-${seq++}`,
            displayName: 'X',
            primaryLocationId: SEED_IDS.locWatford,
          },
        })
      ).status,
    ).toBe(403);
  });

  it('PATCH uses If-Match and refuses self-management loops', async () => {
    const s = await newStaff();
    const ok = await call('PATCH', `/api/v1/staff/${s.id}`, {
      body: { jobTitle: 'Care assistant' },
      ifMatch: s.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.jobTitle).toBe('Care assistant');
    expect(
      (
        await call('PATCH', `/api/v1/staff/${s.id}`, {
          body: { jobTitle: 'Stale' },
          ifMatch: s.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('PATCH', `/api/v1/staff/${s.id}`, {
          body: { managerStaffId: s.id },
          ifMatch: ok.body.version,
        })
      ).status,
    ).toBe(400);
  });

  it('filters and paginates the list', async () => {
    for (let i = 0; i < 3; i++) await newStaff({ displayName: `Pagination Person ${i}` });
    const p1 = await call('GET', '/api/v1/staff?q=Pagination&limit=2');
    expect(p1.body.data).toHaveLength(2);
    const p2 = await call('GET', `/api/v1/staff?q=Pagination&limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.data.length).toBeGreaterThanOrEqual(1);
    expect(p2.body.data[0].displayName >= p1.body.data[1].displayName).toBe(true);
    expect((await call('GET', '/api/v1/staff?cursor=garbage')).status).toBe(400);
    const drivers = await call('GET', '/api/v1/staff?role=DRIVER');
    expect(drivers.body.data.some((s: J) => s.id === SEED_IDS.staffCrew)).toBe(true);
    expect(drivers.body.data.some((s: J) => s.id === SEED_IDS.staffCrew2)).toBe(false);
  });
});

describe('lifecycle [HR-01]', () => {
  it('moves through the path in order, needs an approved role, and logs every step', async () => {
    const s = await newStaff();
    expect((await move(s.id, 'ACTIVE')).body.code).toBe('TRANSITION_NOT_ALLOWED');
    await move(s.id, 'CHECKS_IN_PROGRESS');
    await move(s.id, 'READY_FOR_REVIEW');
    const noRole = await move(s.id, 'APPROVED_FOR_ROLE');
    expect([noRole.status, noRole.body.code]).toEqual([422, 'TRANSITION_NOT_ALLOWED']);
    expect((await approve(s.id, 'CARE_ASSISTANT', 'dev|dispatcher')).status).toBe(403);
    expect((await approve(s.id, 'CARE_ASSISTANT')).status).toBe(201);
    expect((await approve(s.id, 'CARE_ASSISTANT')).status).toBe(409);
    expect((await move(s.id, 'APPROVED_FOR_ROLE')).status).toBe(201);
    const active = await move(s.id, 'ACTIVE');
    expect(active.body.lifecycleState).toBe('ACTIVE');
    const detail = (await call('GET', `/api/v1/staff/${s.id}`)).body;
    expect(detail.events.map((e: J) => e.toState)).toEqual([
      'ACTIVE',
      'APPROVED_FOR_ROLE',
      'READY_FOR_REVIEW',
      'CHECKS_IN_PROGRESS',
      'CANDIDATE',
    ]);
    expect(detail.allowedTransitions.sort()).toEqual(['LEAVER', 'SUSPENDED']);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/transition`, {
          sub: 'dev|dispatcher',
          body: { to: 'SUSPENDED', reason: 'Investigation' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/transition`, {
          sub: 'dev|hr',
          body: { to: 'SUSPENDED', reason: 'x' },
        })
      ).status,
    ).toBe(400);
  });

  it('suspension blocks readiness immediately; nobody changes their own record', async () => {
    const s = await activeStaff(['CARE_ASSISTANT']);
    const ready = await call(
      'GET',
      `/api/v1/staff/${s.id}/readiness?role=CARE_ASSISTANT&${window()}`,
      { sub: 'dev|dispatcher' },
    );
    expect(ready.body.state).toBe('READY');
    await move(s.id, 'SUSPENDED');
    const blocked = await call(
      'GET',
      `/api/v1/staff/${s.id}/readiness?role=CARE_ASSISTANT&${window()}`,
    );
    expect(blocked.body.state).toBe('BLOCKED');
    expect(blocked.body.checks.find((c: J) => c.code === 'LIFECYCLE')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });

    const hr = await userId('hr@example.test');
    const mine = await newStaff({ userId: hr });
    const self = await call('POST', `/api/v1/staff/${mine.id}/restrictions`, {
      sub: 'dev|hr',
      body: { type: 'OTHER', reason: 'Testing myself' },
    });
    expect([self.status, self.body.code]).toEqual([422, 'SELF_APPROVAL']);
    expect((await approve(mine.id, 'MANAGER')).body.code).toBe('SELF_APPROVAL');
    expect(
      (
        await call('POST', '/api/v1/staff', {
          body: {
            staffNo: `ST-${seq++}`,
            displayName: 'Dup link',
            primaryLocationId: SEED_IDS.locWatford,
            userId: hr,
          },
        })
      ).status,
    ).toBe(409);
  });

  it('a leaver loses access straight away and the record is closed', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const tag = Date.now().toString(36);
    const u = await su.query(
      `INSERT INTO app_user (idp_subject, email, display_name, status) VALUES ($1, $2, 'Leaving Person', 'ACTIVE') RETURNING id`,
      [`dev|leaver-${tag}`, `leaver-${tag}@example.test`],
    );
    await su.query(
      `INSERT INTO membership (organisation_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
      [ORG, u.rows[0].id],
    );
    await su.end();
    expect((await call('GET', '/api/v1/staff/me', { sub: `dev|leaver-${tag}` })).status).toBe(404); // no staff record yet
    const s = await newStaff({ userId: u.rows[0].id });
    expect((await call('GET', '/api/v1/staff/me', { sub: `dev|leaver-${tag}` })).status).toBe(200);
    expect((await move(s.id, 'LEAVER')).body.lifecycleState).toBe('LEAVER');
    const gone = await call('GET', '/api/v1/staff/me', { sub: `dev|leaver-${tag}` });
    expect([gone.status, gone.body.code]).toEqual([401, 'USER_INACTIVE']); // no current membership
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/restrictions`, {
          sub: 'dev|hr',
          body: { type: 'OTHER', reason: 'After leaving' },
        })
      ).status,
    ).toBe(409);
    expect((await call('GET', '/api/v1/staff')).body.data.some((x: J) => x.id === s.id)).toBe(
      false,
    );
    expect(
      (await call('GET', '/api/v1/staff?lifecycle=LEAVER')).body.data.some((x: J) => x.id === s.id),
    ).toBe(true);
  });
});

describe('role requirements and recalculation [HR-03]', () => {
  it('requiring a template for a role creates it for current holders and new approvals; the matrix shows it', async () => {
    const tid = await staffTemplate('DRIVING-LICENCE');
    const add = await call('POST', '/api/v1/staff/role-requirements', {
      body: { role: 'DRIVER', templateId: tid },
    });
    expect(add.status).toBe(201);
    expect(
      (
        await call('POST', '/api/v1/staff/role-requirements', {
          body: { role: 'DRIVER', templateId: tid },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', '/api/v1/staff/role-requirements', {
          sub: 'dev|dispatcher',
          body: { role: 'NURSE', templateId: tid },
        })
      ).status,
    ).toBe(403);

    // Seeded driver (ST-0042) got the item automatically; GREY until evidence is verified.
    const crew = (await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}`)).body;
    const item = crew.requirements.find((r: J) => r.templateId === tid);
    expect(item).toMatchObject({ status: 'GREY', required: true, subjectId: SEED_IDS.staffCrew });

    // A care assistant does not need it; approving them as a driver adds it (role change, HR-03).
    const s = await activeStaff(['CARE_ASSISTANT']);
    expect((await call('GET', `/api/v1/staff/${s.id}`)).body.requirements).toHaveLength(0);
    await approve(s.id, 'DRIVER');
    const after = (await call('GET', `/api/v1/staff/${s.id}`)).body;
    expect(after.requirements.map((r: J) => r.templateId)).toEqual([tid]);
    expect(after.overallStatus).toBe('GREY');

    const m = (await call('GET', '/api/v1/staff/training-matrix?role=DRIVER')).body;
    expect(m.columns.some((c: J) => c.templateId === tid)).toBe(true);
    const row = m.rows.find((r: J) => r.staffId === s.id);
    expect(row.cells.find((c: J) => c.templateId === tid)).toMatchObject({
      required: true,
      status: 'GREY',
    });

    // Revoking the role keeps the item on record but it stops counting.
    const approval = after.roleApprovals.find((a: J) => a.role === 'DRIVER');
    const rev = await call('POST', `/api/v1/staff/${s.id}/role-approvals/${approval.id}/revoke`, {
      sub: 'dev|hr',
      body: { reason: 'Stepped back from driving' },
    });
    expect(rev.body).toMatchObject({ active: false, revokeReason: 'Stepped back from driving' });
    const revoked = (await call('GET', `/api/v1/staff/${s.id}`)).body;
    expect(revoked.requirements[0]).toMatchObject({ templateId: tid, required: false });
    expect(revoked.overallStatus).toBe('NOT_APPLICABLE');

    const list = (await call('GET', '/api/v1/staff/role-requirements')).body.data as J[];
    const mapping = list.find((r) => r.templateId === tid)!;
    expect((await call('DELETE', `/api/v1/staff/role-requirements/${mapping.id}`)).body).toEqual({
      removed: true,
    });
    expect((await call('DELETE', `/api/v1/staff/role-requirements/${mapping.id}`)).status).toBe(
      404,
    );
  });

  it('rejects mapping a non-staff template', async () => {
    const c = await call('POST', '/api/v1/requirements/templates', {
      sub: 'dev|admin',
      body: {
        code: `VEH-${Date.now().toString(36).toUpperCase()}`,
        title: 'MOT',
        version: {
          basisType: 'STATUTORY',
          subjectType: 'VEHICLE',
          recurrence: { type: 'EVENT_TRIGGERED' },
          blocking: 'STATUTORY',
          deadlineKind: 'EXPIRY',
        },
      },
    });
    expect(
      (
        await call('POST', '/api/v1/staff/role-requirements', {
          body: { role: 'DRIVER', templateId: c.body.id },
        })
      ).status,
    ).toBe(400);
  });
});

describe('readiness for a job window [RULES_ENGINE §3]', () => {
  it('checks role, licence category, competencies, restrictions and blocking requirements', async () => {
    const s = await activeStaff(['DRIVER']);
    const base = `/api/v1/staff/${s.id}/readiness?${window()}`;
    expect((await call('GET', `${base}&role=DRIVER`)).body.state).toBe('READY');
    expect(
      (await call('GET', `${base}&role=PARAMEDIC`)).body.checks.find(
        (c: J) => c.code === 'ROLE_APPROVED',
      ).result,
    ).toBe('FAIL');

    await call('POST', `/api/v1/staff/${s.id}/licences`, {
      body: {
        data: {
          categories: ['B'],
          photocardExpiry: '2031-01-01',
          lastCheckedOn: '2026-10-01',
          checkMethod: 'DVLA_SHARE_CODE',
        },
      },
    });
    expect((await call('GET', `${base}&role=DRIVER&licenceCategory=B`)).body.state).toBe('READY');
    const c1 = (await call('GET', `${base}&role=DRIVER&licenceCategory=C1`)).body;
    expect(c1.state).toBe('BLOCKED');
    expect(c1.checks.find((c: J) => c.code === 'LICENCE_CATEGORY')).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });

    // Missing competence is a policy-level failure (exception possible, M6)
    const comp = (await call('GET', `${base}&role=DRIVER&competencies=BLUE-LIGHT`)).body;
    expect(comp.state).toBe('RESTRICTED');
    await call('POST', `/api/v1/staff/${s.id}/competencies`, {
      body: { data: { code: 'BLUE-LIGHT', assessedOn: '2026-09-01', outcome: 'COMPETENT' } },
    });
    expect((await call('GET', `${base}&role=DRIVER&competencies=BLUE-LIGHT`)).body.state).toBe(
      'READY',
    );

    // NO_DRIVING is a hard stop for a driver, merely "restricted" for other roles
    const r = await call('POST', `/api/v1/staff/${s.id}/restrictions`, {
      sub: 'dev|hr',
      body: { type: 'NO_DRIVING', reason: 'Awaiting medical review' },
    });
    expect(r.body.active).toBe(true);
    expect((await call('GET', `${base}&role=DRIVER`)).body.state).toBe('BLOCKED');
    await call('POST', `/api/v1/staff/${s.id}/restrictions/${r.body.id}/lift`, {
      sub: 'dev|hr',
      body: { reason: 'Cleared by OH' },
    });
    expect((await call('GET', `${base}&role=DRIVER`)).body.state).toBe('READY');

    // A statutory requirement without verified evidence blocks (upload never makes it green)
    const tid = await staffTemplate('RIGHT-TO-WORK');
    await call('POST', '/api/v1/requirements/instances', {
      body: { templateId: tid, subjectType: 'STAFF', subjectId: s.id },
    });
    const blocked = (await call('GET', `${base}&role=DRIVER`)).body;
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.checks.some((c: J) => c.result === 'FAIL' && c.requirementInstanceId)).toBe(
      true,
    );
    expect(
      (
        await call(
          'GET',
          `/api/v1/staff/${s.id}/readiness?role=DRIVER&from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z`,
        )
      ).status,
    ).toBe(400);
  });
});

describe('typed records [HR-02]', () => {
  it('stores DBS encrypted with a policy review date and no expiry; viewing is audited; dispatchers never see it', async () => {
    const s = await newStaff();
    const dbs = {
      eligibility: 'ENHANCED_BARRED',
      barredListChecked: true,
      certificateNumber: '001234567890',
      issueDate: '2026-03-01',
      updateServiceConsent: true,
      riskDecision: 'CLEAR',
      policyReviewDate: '2029-03-01',
    };
    const r = await call('POST', `/api/v1/staff/${s.id}/dbs`, {
      sub: 'dev|hr',
      body: { data: dbs },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: 'DBS',
      validFrom: '2026-03-01',
      validTo: null,
      current: true,
    });
    expect(r.body.data.certificateNumber).toBe('001234567890');
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const raw = await su.query(
      `SELECT data->>'certificateNumber' AS c FROM staff_record WHERE id = $1`,
      [r.body.id],
    );
    await su.end();
    expect(raw.rows[0].c).toMatch(/^enc:v1:/);
    expect(raw.rows[0].c).not.toContain('001234567890');

    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/dbs`, {
          sub: 'dev|dispatcher',
          body: { data: dbs },
        })
      ).status,
    ).toBe(403);
    const list = await call('GET', `/api/v1/staff/${s.id}/dbs`, { sub: 'dev|hr' });
    expect(list.body.data).toHaveLength(1);
    const log = (await call('GET', '/api/v1/audit-log?limit=50')).body.data as J[];
    expect(log.some((a) => a.action === 'staff.sensitive.view' && a.entityId === s.id)).toBe(true);
    expect(JSON.stringify(log)).not.toContain('001234567890');
  });

  it('validates payloads strictly per kind and rejects unknown kinds', async () => {
    const s = await newStaff();
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/licences`, {
          body: {
            data: {
              categories: ['Z9'],
              photocardExpiry: '2030-01-01',
              lastCheckedOn: '2026-01-01',
              checkMethod: 'MANUAL',
            },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/training`, {
          body: {
            data: {
              courseCode: 'MH-01',
              title: 'Moving and handling',
              completedOn: '2026-01-01',
              extra: 'nope',
            },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/training`, {
          body: {
            data: {
              courseCode: 'MH-01',
              title: 'Moving and handling',
              completedOn: '2026-05-01',
              expiresOn: '2026-01-01',
            },
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/references`, {
          body: {
            data: {
              refereeName: 'A Referee',
              refereeOrganisation: 'Previous employer',
              relationship: 'Line manager',
              requestedOn: '2026-01-01',
              outcome: 'SATISFACTORY',
            },
          },
        })
      ).status,
    ).toBe(400);
    expect((await call('GET', `/api/v1/staff/${s.id}/payslips`)).status).toBe(404);
  });

  it('corrections supersede (never edit) and can only be made once per record', async () => {
    const s = await newStaff();
    const first = await call('POST', `/api/v1/staff/${s.id}/training`, {
      body: {
        data: {
          courseCode: 'MH-01',
          title: 'Moving and handling',
          completedOn: '2026-01-10',
          expiresOn: '2027-01-10',
        },
      },
    });
    expect(first.body).toMatchObject({ validFrom: '2026-01-10', validTo: '2027-01-10' });
    const fix = await call('POST', `/api/v1/staff/${s.id}/training`, {
      body: {
        supersedesId: first.body.id,
        data: {
          courseCode: 'MH-01',
          title: 'Moving and handling',
          completedOn: '2026-01-12',
          expiresOn: '2027-01-12',
        },
      },
    });
    expect(fix.status).toBe(201);
    expect(
      (
        await call('POST', `/api/v1/staff/${s.id}/training`, {
          body: {
            supersedesId: first.body.id,
            data: { courseCode: 'MH-01', title: 'Again', completedOn: '2026-01-12' },
          },
        })
      ).status,
    ).toBe(409);
    const rows = (await call('GET', `/api/v1/staff/${s.id}/training`)).body.data as J[];
    expect(rows.map((r) => [r.id === fix.body.id, r.current])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(rows[1]!.supersededById).toBe(fix.body.id);
  });
});

describe('self-service [PRD §4.3]', () => {
  it('crew see their own record, request corrections, and only upload evidence for their own items', async () => {
    const me = await call('GET', '/api/v1/staff/me', { sub: 'dev|crew' });
    expect(me.status).toBe(200);
    expect(me.body.profile).toMatchObject({ id: SEED_IDS.staffCrew, staffNo: 'ST-0042' });
    expect((await call('GET', '/api/v1/staff/me', { sub: 'dev|dispatcher' })).status).toBe(404); // has self-view, no staff record
    expect((await call('GET', '/api/v1/staff/me', { sub: 'dev|admin' })).status).toBe(403);

    const req = await call('POST', '/api/v1/staff/me/corrections', {
      sub: 'dev|crew',
      body: { field: 'phone', proposedValue: '07700 900000', reason: 'Changed my number' },
    });
    expect(req.status).toBe(201);
    expect((await call('GET', '/api/v1/staff/corrections', { sub: 'dev|crew' })).status).toBe(403);
    const open = (await call('GET', '/api/v1/staff/corrections')).body.data as J[];
    expect(open.some((c) => c.id === req.body.id)).toBe(true);
    const done = await call('POST', `/api/v1/staff/corrections/${req.body.id}/decide`, {
      body: { decision: 'APPLIED', note: 'Updated' },
    });
    expect(done.body).toMatchObject({ status: 'APPLIED' });
    expect(
      (
        await call('POST', `/api/v1/staff/corrections/${req.body.id}/decide`, {
          body: { decision: 'REJECTED' },
        })
      ).status,
    ).toBe(409);

    // evidence for someone else's item is refused (404, nothing revealed)
    const tid = await staffTemplate('FIRST-AID');
    const other = await activeStaff(['CARE_ASSISTANT']);
    const theirs = await call('POST', '/api/v1/requirements/instances', {
      body: { templateId: tid, subjectType: 'STAFF', subjectId: other.id },
    });
    const ours = await call('POST', '/api/v1/requirements/instances', {
      body: { templateId: tid, subjectType: 'STAFF', subjectId: SEED_IDS.staffCrew },
    });
    const up = (ids: string[]) =>
      call('POST', '/api/v1/evidence/uploads', {
        sub: 'dev|crew',
        body: {
          title: 'Certificate',
          mime: 'application/pdf',
          sizeBytes: 100,
          requirementInstanceIds: ids,
        },
      });
    expect((await up([theirs.body.id])).status).toBe(404);
    expect((await up([ours.body.id])).status).toBe(201);
    expect(
      (
        await call('POST', '/api/v1/requirements/instances', {
          body: {
            templateId: tid,
            subjectType: 'STAFF',
            subjectId: '01900000-0000-7000-8000-00000000ffff',
          },
        })
      ).status,
    ).toBe(404);
  });
});

describe('names in staff records', () => {
  it('returns the names of colleagues a record mentions, not just their ids', async () => {
    const hr = (await call('GET', '/api/v1/admin/users')).body.data.find(
      (u: J) => u.email === 'hr@example.test',
    ).id as string;
    const added = await call('POST', `/api/v1/staff/${SEED_IDS.staffCrew}/induction`, {
      body: { data: { completedOn: '2026-01-05', signedOffByUserId: hr } },
    });
    expect(added.status).toBe(201);
    expect(added.body.people).toEqual({ [hr]: 'Hana Rowe' });
    const list = await call('GET', `/api/v1/staff/${SEED_IDS.staffCrew}/induction`);
    const mine = (list.body.data as J[]).find((r) => r.id === added.body.id)!;
    expect(mine.people).toEqual({ [hr]: 'Hana Rowe' });
    expect(JSON.stringify(mine.people)).not.toContain('@'); // names only, never emails
  });
});
