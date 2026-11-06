import { WorkbookDecisionInput } from '@hub/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { SEED_IDS, SEED_SUPPORT, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let close: () => Promise<void>;
const ORG = SEED_IDS.orgExample;
const OTHER_ORG = SEED_IDS.orgOther;

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Opts {
  sub?: string;
  org?: string;
  body?: unknown;
  ifMatch?: number | string;
  amr?: string[];
  email?: string;
  emailVerified?: boolean;
}
async function call(method: 'GET' | 'POST' | 'PATCH', url: string, o: Opts = {}) {
  const token = await sign({
    sub: o.sub ?? 'dev|manager',
    amr: o.amr,
    email: o.email,
    emailVerified: o.emailVerified,
  });
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(o.org === undefined ? { 'x-org-id': ORG } : o.org ? { 'x-org-id': o.org } : {}),
      ...(o.ifMatch !== undefined ? { 'if-match': `"${o.ifMatch}"` } : {}),
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return {
    status: res.statusCode,
    body: (res.body ? JSON.parse(res.body) : {}) as J,
    headers: res.headers,
  };
}

async function role(key: string): Promise<string> {
  const { body } = await call('GET', '/api/v1/admin/roles');
  return (body.data as J[]).find((r) => r.key === key)!.id as string;
}
async function auditActions(): Promise<string[]> {
  const { body } = await call('GET', '/api/v1/audit-log?limit=100');
  return (body.data as J[]).map((a) => a.action as string);
}

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  close = async () => {
    await app.close();
    await made.db.close();
  };
});
afterAll(async () => close());

describe('organisation', () => {
  it('returns the organisation to any member and refuses a mismatched id with 404', async () => {
    const ok = await call('GET', `/api/v1/organisations/${ORG}`, { sub: 'dev|crew' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      id: ORG,
      name: 'Exora International Ltd',
      regulator: 'CQC',
    });
    expect((await call('GET', `/api/v1/organisations/${OTHER_ORG}`)).status).toBe(404);
  });

  it('updates with If-Match, rejects stale versions (409) and a missing If-Match (400), audits the change', async () => {
    const cur = (await call('GET', `/api/v1/organisations/${ORG}`)).body;
    const ok = await call('PATCH', `/api/v1/organisations/${ORG}`, {
      body: { name: 'Exora International Ltd' },
      ifMatch: cur.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(cur.version + 1);
    const stale = await call('PATCH', `/api/v1/organisations/${ORG}`, {
      body: { name: 'Again' },
      ifMatch: cur.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect(
      (await call('PATCH', `/api/v1/organisations/${ORG}`, { body: { name: 'x' } })).status,
    ).toBe(400);
    expect(await auditActions()).toContain('org.organisation.update');
  });

  it('forbids changes by members without admin.org.manage', async () => {
    const r = await call('PATCH', `/api/v1/organisations/${ORG}`, {
      sub: 'dev|dispatcher',
      body: { name: 'x' },
      ifMatch: 1,
    });
    expect(r.status).toBe(403);
  });

  it('rejects unknown fields (strict schemas)', async () => {
    const cur = (await call('GET', `/api/v1/organisations/${ORG}`)).body;
    const r = await call('PATCH', `/api/v1/organisations/${ORG}`, {
      body: { name: 'x', regulator: 'HACK' },
      ifMatch: cur.version,
    });
    expect(r.status).toBe(400);
  });
});

describe('locations, services, registered activities', () => {
  let locId: string;
  it('creates, lists, renames and archives a location', async () => {
    const c = await call('POST', `/api/v1/organisations/${ORG}/locations`, {
      body: { name: 'Luton base', registered: true, address: { town: 'Luton' } },
    });
    expect(c.status).toBe(201);
    locId = c.body.id;
    const list = await call('GET', `/api/v1/organisations/${ORG}/locations`, { sub: 'dev|crew' });
    expect((list.body.data as J[]).map((l) => l.name)).toContain('Luton base');
    const renamed = await call('PATCH', `/api/v1/organisations/${ORG}/locations/${locId}`, {
      body: { name: 'Luton depot' },
      ifMatch: c.body.version,
    });
    expect(renamed.body.name).toBe('Luton depot');
    // A2: archiving needs a reason.
    const noReason = await call('PATCH', `/api/v1/organisations/${ORG}/locations/${locId}`, {
      body: { archived: true },
      ifMatch: renamed.body.version,
    });
    expect(noReason.status).toBe(400);
    const archived = await call('PATCH', `/api/v1/organisations/${ORG}/locations/${locId}`, {
      body: { archived: true, archiveReason: 'Depot lease ended' },
      ifMatch: renamed.body.version,
    });
    expect(archived.body.archived).toBe(true);
    expect(archived.body.archiveReason).toBe('Depot lease ended');
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['org.location.create', 'org.location.update']),
    );
  });

  it("cannot see or change another organisation's locations", async () => {
    const other = await call('GET', `/api/v1/organisations/${OTHER_ORG}/locations`, {
      sub: 'dev|other-manager',
      org: OTHER_ORG,
    });
    const otherId = (other.body.data as J[])[0]!.id as string;
    const r = await call('PATCH', `/api/v1/organisations/${ORG}/locations/${otherId}`, {
      body: { name: 'Hijack' },
      ifMatch: 1,
    });
    expect(r.status).toBe(404);
  });

  it('creates services (unique code) and registered activities tied to a location in this organisation', async () => {
    const s = await call('POST', `/api/v1/organisations/${ORG}/services`, {
      body: { code: 'NEPTS', name: 'Non-emergency patient transport' },
    });
    expect(s.status).toBe(201);
    expect(
      (
        await call('POST', `/api/v1/organisations/${ORG}/services`, {
          body: { code: 'NEPTS', name: 'dup' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('POST', `/api/v1/organisations/${ORG}/services`, {
          body: { code: 'bad code', name: 'x' },
        })
      ).status,
    ).toBe(400);
    const a = await call('POST', `/api/v1/organisations/${ORG}/registered-activities`, {
      body: {
        locationId: locId,
        code: 'TRANSPORT',
        name: 'Transport services, triage and medical advice provided remotely',
      },
    });
    expect(a.status).toBe(201);
    const foreign = await call('GET', `/api/v1/organisations/${OTHER_ORG}/locations`, {
      sub: 'dev|other-manager',
      org: OTHER_ORG,
    });
    const foreignLoc = (foreign.body.data as J[])[0]!.id as string;
    expect(
      (
        await call('POST', `/api/v1/organisations/${ORG}/registered-activities`, {
          body: { locationId: foreignLoc, code: 'TRANSPORT', name: 'x' },
        })
      ).status,
    ).toBe(404);
    const archived = await call('PATCH', `/api/v1/organisations/${ORG}/services/${s.body.id}`, {
      body: { archived: true },
      ifMatch: s.body.version,
    });
    expect(archived.body.archived).toBe(true);
  });

  it('limits the locations a location-scoped member can see', async () => {
    const crewRole = await role('CREW');
    const watford = (
      (await call('GET', `/api/v1/organisations/${ORG}/locations`)).body.data as J[]
    ).find((l) => l.name === 'London')!.id as string;
    const inv = await call('POST', '/api/v1/admin/users', {
      body: {
        email: 'scoped.crew@example.test',
        displayName: 'Scoped Crew',
        roleId: crewRole,
        locationId: watford,
      },
    });
    expect(inv.status).toBe(201);
    const link = await call('GET', '/api/v1/me', {
      sub: 'idp|scoped',
      email: 'scoped.crew@example.test',
      org: '',
    });
    expect(link.status).toBe(200);
    const list = await call('GET', `/api/v1/organisations/${ORG}/locations`, { sub: 'idp|scoped' });
    expect((list.body.data as J[]).map((l) => l.name)).toEqual(['London']);
    expect(
      (await call('GET', `/api/v1/organisations/${ORG}/locations`, { sub: 'idp|scoped', org: ORG }))
        .status,
    ).toBe(200);
  });
});

describe('users, invites and revoke', () => {
  it('invites a user; the invitation links on first sign-in only with a VERIFIED email', async () => {
    const crew = await role('CREW');
    const inv = await call('POST', '/api/v1/admin/users', {
      body: { email: 'New.Person@Example.test', displayName: 'New Person', roleId: crew },
    });
    expect(inv.status).toBe(201);
    // IdP did not verify the email -> cannot claim the invitation.
    const unverified = await call('GET', '/api/v1/me', {
      sub: 'idp|new-person',
      email: 'new.person@example.test',
      emailVerified: false,
      org: '',
    });
    expect(unverified.status).toBe(401);
    const ok = await call('GET', '/api/v1/me', {
      sub: 'idp|new-person',
      email: 'new.person@example.test',
      org: ORG,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.memberships[0]).toMatchObject({ roleKey: 'CREW', organisationId: ORG });
    expect(ok.body.permissions).toContain('crew.today.view');
    // The subject is now bound: a different identity with the same email cannot take over.
    const attacker = await call('GET', '/api/v1/me', {
      sub: 'idp|attacker',
      email: 'new.person@example.test',
      org: '',
    });
    expect(attacker.status).toBe(401);
    const list = await call('GET', '/api/v1/admin/users');
    const u = (list.body.data as J[]).find((x) => x.email === 'new.person@example.test')!;
    expect(u.status).toBe('ACTIVE');
    expect(await auditActions()).toContain('admin.user.invite');
  });

  it('refuses to grant a role containing permissions the inviter does not hold (no escalation)', async () => {
    const manager = await role('REGISTERED_MANAGER');
    const r = await call('POST', '/api/v1/admin/users', {
      sub: 'dev|admin',
      body: { email: 'esc@example.test', displayName: 'Esc', roleId: manager },
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('OVERRIDE_NOT_PERMITTED');
  });

  it('a database clock ahead of the API neither delays a new member nor extends a revoked one', async () => {
    const crew = await role('CREW');
    const email = 'skew.person@example.test';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 5000 });
    try {
      const inv = await call('POST', '/api/v1/admin/users', {
        body: { email, displayName: 'Skew Person', roleId: crew },
      });
      expect(inv.status).toBe(201);
      const joined = await call('GET', '/api/v1/me', { sub: 'idp|skew', email, org: ORG });
      expect(joined.status).toBe(200);
      const rev = await call('POST', `/api/v1/admin/users/${inv.body.id}/revoke`, {
        body: { reason: 'Left the company' },
      });
      expect(rev.status).toBe(200);
      const after = await call('GET', '/api/v1/me', { sub: 'idp|skew', org: ORG });
      expect(after.status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies user management to non-admins', async () => {
    expect((await call('GET', '/api/v1/admin/users', { sub: 'dev|dispatcher' })).status).toBe(403);
  });

  it('rejects roles and locations from other organisations when inviting', async () => {
    const crew = await role('CREW');
    const foreign = (
      (
        await call('GET', `/api/v1/organisations/${OTHER_ORG}/locations`, {
          sub: 'dev|other-manager',
          org: OTHER_ORG,
        })
      ).body.data as J[]
    )[0]!.id as string;
    const r = await call('POST', '/api/v1/admin/users', {
      body: { email: 'x@example.test', displayName: 'X', roleId: crew, locationId: foreign },
    });
    expect(r.status).toBe(404);
  });

  it('revokes access immediately: next call is 401, devices revoked, history kept, self-revoke refused', async () => {
    const crew = await role('CREW');
    const inv = await call('POST', '/api/v1/admin/users', {
      body: { email: 'm1.leaver@example.test', displayName: 'Leaver', roleId: crew },
    });
    await call('GET', '/api/v1/me', {
      sub: 'idp|leaver',
      email: 'm1.leaver@example.test',
      org: '',
    });
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    await su.query(
      `INSERT INTO device_session (user_id, device_id, platform) VALUES ($1, 'dev-1', 'ANDROID')`,
      [inv.body.id],
    );
    await su.end();
    expect((await call('GET', '/api/v1/me', { sub: 'idp|leaver', org: ORG })).status).toBe(200);

    expect(
      (
        await call('POST', `/api/v1/admin/users/${inv.body.id}/revoke`, {
          sub: 'dev|dispatcher',
          body: { reason: 'Left the company' },
        })
      ).status,
    ).toBe(403);
    const rev = await call('POST', `/api/v1/admin/users/${inv.body.id}/revoke`, {
      body: { reason: 'Left the company' },
    });
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ revokedMemberships: 1, revokedDevices: 1 });

    const after = await call('GET', '/api/v1/me', { sub: 'idp|leaver', org: ORG });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('USER_INACTIVE');
    // The user row (authorship of historic records) is retained.
    const users = await call('GET', '/api/v1/admin/users');
    const u = (users.body.data as J[]).find((x) => x.email === 'm1.leaver@example.test')!;
    expect(u.memberships[0].validTo).not.toBeNull();
    expect(
      (
        await call(
          'POST',
          `/api/v1/admin/users/${(await call('GET', '/api/v1/me')).body.user.id}/revoke`,
          { body: { reason: 'Test self revoke' } },
        )
      ).status,
    ).toBe(403);
    expect(await auditActions()).toContain('admin.user.revoke');
  });

  it('changes a role or location by ending the old membership and starting a new one [task 14]', async () => {
    const crew = await role('CREW');
    const dispatcher = await role('DISPATCHER');
    const watford = (
      (await call('GET', `/api/v1/organisations/${ORG}/locations`)).body.data as J[]
    ).find((l) => l.name === 'London')!.id as string;
    const inv = await call('POST', '/api/v1/admin/users', {
      body: { email: 't14.mover@example.test', displayName: 'Task Mover', roleId: crew },
    });
    expect(inv.status).toBe(201);
    const find = async () =>
      ((await call('GET', '/api/v1/admin/users')).body.data as J[]).find(
        (u) => u.email === 't14.mover@example.test',
      )!;
    const before = (await find()).memberships[0] as J;
    const url = `/api/v1/admin/memberships/${before.membershipId}`;
    expect(
      (
        await call('PATCH', url, {
          sub: 'dev|dispatcher',
          body: { roleId: dispatcher, reason: 'Moved to control' },
        })
      ).status,
    ).toBe(403);
    const same = await call('PATCH', url, { body: { roleId: crew, reason: 'No real change' } });
    expect(same.status).toBe(400);
    const short = await call('PATCH', url, { body: { roleId: dispatcher, reason: 'x' } });
    expect(short.status).toBe(400);
    const ok = await call('PATCH', url, {
      body: { roleId: dispatcher, locationId: watford, reason: 'Moved to control room' },
    });
    expect(ok.status).toBe(200);
    const after = await find();
    const old = (after.memberships as J[]).find((m) => m.membershipId === before.membershipId)!;
    const cur = (after.memberships as J[]).find((m) => m.membershipId === ok.body.membershipId)!;
    expect(old.validTo).not.toBeNull();
    expect(cur).toMatchObject({ roleKey: 'DISPATCHER', locationId: watford, validTo: null });
    expect(
      (await call('PATCH', url, { body: { roleId: crew, reason: 'Change it back' } })).status,
    ).toBe(409);
    expect(await auditActions()).toContain('admin.membership.change');
  });

  it('refuses to change your own membership and never grants support access as a role [task 14]', async () => {
    const meId = (await call('GET', '/api/v1/me')).body.user.id as string;
    const mine = ((await call('GET', '/api/v1/admin/users')).body.data as J[]).find(
      (u) => u.id === meId,
    )!;
    const own = (mine.memberships as J[]).find((m) => m.validTo === null)!;
    const crew = await role('CREW');
    expect(
      (
        await call('PATCH', `/api/v1/admin/memberships/${own.membershipId}`, {
          body: { roleId: crew, reason: 'Demote myself' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/api/v1/admin/users/${meId}/memberships`, {
          body: { roleId: crew },
        })
      ).status,
    ).toBe(403);
    const roles = (await call('GET', '/api/v1/admin/roles')).body.data as J[];
    const support = roles.find((r) => r.key === 'PLATFORM_SUPPORT');
    if (support) {
      const r = await call('POST', '/api/v1/admin/users', {
        body: { email: 't14.support@example.test', displayName: 'Support', roleId: support.id },
      });
      expect(r.status).toBe(403);
    }
  });

  it('the audit log shows who did each action by name [task 14]', async () => {
    const { body } = await call('GET', '/api/v1/audit-log?limit=20');
    const named = (body.data as J[]).filter((a) => a.actorUserId);
    expect(named.length).toBeGreaterThan(0);
    for (const a of named) expect(typeof a.actorName).toBe('string');
  });

  it('a workbook mapping can only be rejected with a reason [task 14]', () => {
    expect(WorkbookDecisionInput.safeParse({ decision: 'REJECTED' }).success).toBe(false);
    expect(WorkbookDecisionInput.safeParse({ decision: 'REJECTED', note: 'no' }).success).toBe(
      false,
    );
    expect(
      WorkbookDecisionInput.safeParse({ decision: 'REJECTED', note: 'Wrong subject' }).success,
    ).toBe(true);
    expect(WorkbookDecisionInput.safeParse({ decision: 'APPROVED' }).success).toBe(true);
  });

  it('cannot revoke a user of another organisation (404)', async () => {
    const other = await call('GET', '/api/v1/admin/users', {
      sub: 'dev|other-manager',
      org: OTHER_ORG,
    });
    const id = (other.body.data as J[])[0]!.id as string;
    expect(
      (
        await call('POST', `/api/v1/admin/users/${id}/revoke`, {
          body: { reason: 'Cross tenant attempt' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('roles', () => {
  it('lists system roles with their permissions and never lets them be edited', async () => {
    const { body } = await call('GET', '/api/v1/admin/roles');
    const mgr = (body.data as J[]).find((r) => r.key === 'REGISTERED_MANAGER')!;
    expect(mgr.isSystem).toBe(true);
    expect(mgr.permissions).toContain('allocation.exception.approve');
    expect(
      (
        await call('PATCH', `/api/v1/admin/roles/${mgr.id}`, {
          body: { name: 'x' },
          ifMatch: mgr.version,
        })
      ).status,
    ).toBe(403);
  });

  it('creates a custom role and enforces the restricted-permission rule for dispatch/crew-derived roles', async () => {
    const ok = await call('POST', '/api/v1/admin/roles', {
      body: {
        key: 'NIGHT_CONTROL',
        name: 'Night control',
        derivedFrom: 'DISPATCHER',
        permissions: ['jobs.job.view', 'jobs.allocate'],
      },
    });
    expect(ok.status).toBe(201);
    const bad = await call('POST', '/api/v1/admin/roles', {
      body: {
        key: 'BAD_CONTROL',
        name: 'Bad',
        derivedFrom: 'DISPATCHER',
        permissions: ['staff.sensitive.view'],
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('OVERRIDE_NOT_PERMITTED');
    // The failed create must not leave a half-built role behind.
    const roles = ((await call('GET', '/api/v1/admin/roles')).body.data as J[]).map((r) => r.key);
    expect(roles).not.toContain('BAD_CONTROL');
    const patched = await call('PATCH', `/api/v1/admin/roles/${ok.body.id}`, {
      body: { permissions: ['jobs.job.view'] },
      ifMatch: ok.body.version,
    });
    expect(patched.body.permissions).toEqual(['jobs.job.view']);
    expect(
      (
        await call('PATCH', `/api/v1/admin/roles/${ok.body.id}`, {
          body: { name: 'x' },
          ifMatch: ok.body.version,
        })
      ).status,
    ).toBe(409);
  });

  it('rejects unknown permissions and permissions the actor does not hold', async () => {
    expect(
      (
        await call('POST', '/api/v1/admin/roles', {
          body: { key: 'WEIRD_ROLE', name: 'Weird', permissions: ['made.up.perm'] },
        })
      ).status,
    ).toBe(400);
    const r = await call('POST', '/api/v1/admin/roles', {
      sub: 'dev|admin',
      body: { key: 'ESCALATE', name: 'Escalate', permissions: ['staff.sensitive.view'] },
    });
    expect(r.status).toBe(422);
  });
});

describe('settings', () => {
  it('returns defaults to members and lets only authorised users change them', async () => {
    const cur = await call('GET', '/api/v1/admin/settings', { sub: 'dev|crew' });
    expect(cur.body.settings).toMatchObject({ warningDays: [90, 60, 30, 14, 7], dueSoonDays: 30 });
    expect(
      (
        await call('PATCH', '/api/v1/admin/settings', {
          sub: 'dev|crew',
          body: { dueSoonDays: 10 },
          ifMatch: cur.body.version,
        })
      ).status,
    ).toBe(403);
    const upd = await call('PATCH', '/api/v1/admin/settings', {
      body: { dueSoonDays: 45 },
      ifMatch: cur.body.version,
    });
    expect(upd.body.settings.dueSoonDays).toBe(45);
    expect(
      (
        await call('PATCH', '/api/v1/admin/settings', {
          body: { dueSoonDays: 45 },
          ifMatch: cur.body.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('PATCH', '/api/v1/admin/settings', {
          body: { dueSoonDays: 0 },
          ifMatch: upd.body.version,
        })
      ).status,
    ).toBe(400);
    expect(await auditActions()).toContain('admin.settings.update');
  });
});

describe('break-glass support access', () => {
  const support = SEED_SUPPORT.subject;
  it('gives support no access without a grant, and cannot be granted by non-approvers', async () => {
    expect((await call('GET', '/api/v1/audit-log', { sub: support, org: ORG })).status).toBe(401);
    const r = await call('POST', '/api/v1/admin/support-access-grants', {
      sub: 'dev|dispatcher',
      body: { supportUserEmail: SEED_SUPPORT.email, reason: 'Investigating ticket 42', hours: 2 },
    });
    expect(r.status).toBe(403);
  });

  it('is time-boxed, read-limited, MFA-protected and fully audited', async () => {
    const grant = await call('POST', '/api/v1/admin/support-access-grants', {
      body: { supportUserEmail: SEED_SUPPORT.email, reason: 'Investigating ticket 42', hours: 2 },
    });
    expect(grant.status).toBe(201);
    expect(grant.body.active).toBe(true);
    // Unknown / non-support emails look identical (404).
    expect(
      (
        await call('POST', '/api/v1/admin/support-access-grants', {
          body: {
            supportUserEmail: 'manager@example.test',
            reason: 'Investigating ticket 42',
            hours: 2,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/api/v1/admin/support-access-grants', {
          body: { supportUserEmail: SEED_SUPPORT.email, reason: 'short', hours: 2 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/v1/admin/support-access-grants', {
          body: {
            supportUserEmail: SEED_SUPPORT.email,
            reason: 'Investigating ticket 42',
            hours: 9,
          },
        })
      ).status,
    ).toBe(400);

    expect(
      (await call('GET', '/api/v1/audit-log', { sub: support, org: ORG, amr: ['pwd'] })).status,
    ).toBe(403); // MFA required
    const read = await call('GET', '/api/v1/audit-log', { sub: support, org: ORG });
    expect(read.status).toBe(200);
    expect((await call('GET', '/api/v1/admin/users', { sub: support, org: ORG })).status).toBe(403);
    expect(
      (
        await call('POST', '/api/v1/admin/support-access-grants', {
          sub: support,
          body: {
            supportUserEmail: SEED_SUPPORT.email,
            reason: 'Granting myself access',
            hours: 1,
          },
          org: ORG,
        })
      ).status,
    ).toBe(403);
    // Other organisations remain invisible.
    expect((await call('GET', '/api/v1/audit-log', { sub: support, org: OTHER_ORG })).status).toBe(
      404,
    );

    const log = (await call('GET', '/api/v1/audit-log?limit=100')).body.data as J[];
    const entries = log.filter((a) => a.actorType === 'SUPPORT');
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.every((a) => a.action === 'support.access.request')).toBe(true);
    const visible = (await call('GET', '/api/v1/admin/support-access-grants')).body.data as J[];
    expect(visible.some((g) => g.id === grant.body.id && g.active)).toBe(true);
  });

  it('stops working when the grant expires', async () => {
    const su = new pg.Client({ connectionString: urls.admin });
    await su.connect();
    await su.query('BEGIN');
    await su.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    // Make every existing grant for this org already expired (ends in the past).
    await su.query(
      'ALTER TABLE support_access_grant DISABLE TRIGGER support_access_grant_immutable',
    );
    await su.query(
      `UPDATE support_access_grant SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE organisation_id = $1`,
      [ORG],
    );
    await su.query(
      'ALTER TABLE support_access_grant ENABLE TRIGGER support_access_grant_immutable',
    );
    await su.query('COMMIT');
    await su.end();
    expect((await call('GET', '/api/v1/audit-log', { sub: support, org: ORG })).status).toBe(401);
  });
});
