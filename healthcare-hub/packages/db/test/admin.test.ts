import pg from 'pg';
import {
  ALL_PERMISSION_KEYS,
  RESTRICTED_FOR_DISPATCH_AND_CREW,
  SYSTEM_ROLES,
} from '@hub/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../src/index.js';
import { seedTwoOrgs, type Ids } from './helpers.js';

const urls = inject('urls');
let db: Db;
let ids: Ids;
beforeAll(async () => {
  ids = await seedTwoOrgs(urls.admin);
  db = createDb(urls.app);
});
afterAll(async () => db.close());

const ctxA = () => ({ orgId: ids.orgA, userId: ids.userA });
const ctxB = () => ({ orgId: ids.orgB, userId: ids.userB });

async function systemRoleId(key: string) {
  const rows = await db.withTenant(ctxA(), (tx) =>
    tx.role.findMany({ where: { key, organisationId: null } }),
  );
  return rows[0]!.id;
}

describe('system roles and permissions', () => {
  it('syncs the catalogue and every system role from @hub/contracts', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const perms = (await su.query('SELECT key FROM permission')).rows.map((r) => r.key as string);
    expect(perms.sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
    for (const r of SYSTEM_ROLES) {
      const got = (
        await su.query(
          `SELECT rp.permission_key FROM role_permission rp JOIN role ro ON ro.id = rp.role_id
           WHERE ro.organisation_id IS NULL AND ro.key = $1`,
          [r.key],
        )
      ).rows.map((x) => x.permission_key as string);
      expect(got.sort(), r.key).toEqual([...r.permissions].sort());
    }
    await su.end();
  });

  it('keeps the SQL restricted list identical to the TypeScript list', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const sql = (await su.query('SELECT unnest(restricted_for_dispatch_and_crew()) AS k')).rows.map(
      (r) => r.k as string,
    );
    await su.end();
    expect(sql.sort()).toEqual([...RESTRICTED_FOR_DISPATCH_AND_CREW].sort());
  });

  it('is readable by every organisation but not writable via the application role', async () => {
    const id = await systemRoleId('REGISTERED_MANAGER');
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.role.updateMany({ where: { id }, data: { name: 'Hacked' } }),
      ),
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.rolePermission.create({ data: { roleId: id, permissionKey: 'support.access.read' } }),
      ),
    ).rejects.toThrow();
  });
});

describe('custom roles', () => {
  it('rejects restricted permissions on roles derived from dispatcher/crew', async () => {
    const role = await db.withTenant(ctxA(), (tx) =>
      tx.role.create({
        data: {
          organisationId: ids.orgA,
          key: 'NIGHT_CONTROL',
          name: 'Night control',
          derivedFrom: 'DISPATCHER',
        },
      }),
    );
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.rolePermission.create({
          data: { roleId: role.id, permissionKey: 'staff.sensitive.view' },
        }),
      ),
    ).rejects.toThrow(/cannot be granted/);
    await db.withTenant(ctxA(), (tx) =>
      tx.rolePermission.create({ data: { roleId: role.id, permissionKey: 'jobs.job.view' } }),
    );
  });

  it('allows the same permission on a custom role not derived from dispatch/crew', async () => {
    const role = await db.withTenant(ctxA(), (tx) =>
      tx.role.create({ data: { organisationId: ids.orgA, key: 'DEPUTY_HR', name: 'Deputy HR' } }),
    );
    await db.withTenant(ctxA(), (tx) =>
      tx.rolePermission.create({
        data: { roleId: role.id, permissionKey: 'staff.sensitive.view' },
      }),
    );
  });

  it('cannot create a role inside another organisation', async () => {
    await expect(
      db.withTenant(ctxA(), (tx) =>
        tx.role.create({ data: { organisationId: ids.orgB, key: 'X', name: 'X' } }),
      ),
    ).rejects.toThrow();
  });
});

describe('invites', () => {
  it('creates an INVITED user plus membership and reports the same id for a repeat invite', async () => {
    const roleId = await systemRoleId('CREW');
    const call = () =>
      db.withTenant(ctxA(), async (tx) => {
        const r = await tx.$queryRaw<{ invite_user: string }[]>`
          SELECT invite_user('New.Starter@Example.test', 'New Starter', ${roleId}::uuid, NULL::uuid)`;
        return r[0]!.invite_user;
      });
    const first = await call();
    const second = await call();
    expect(second).toBe(first);
    const members = await db.withTenant(ctxA(), (tx) =>
      tx.membership.findMany({ where: { userId: first } }),
    );
    expect(members).toHaveLength(1);
    const user = await db.withTenant(ctxA(), (tx) =>
      tx.appUser.findUnique({ where: { id: first } }),
    );
    expect(user).toMatchObject({
      email: 'new.starter@example.test',
      status: 'INVITED',
      idpSubject: null,
    });
  });

  it('inviting an existing user of another organisation reveals nothing and adds only a membership here', async () => {
    const roleId = await systemRoleId('CREW');
    const id = await db.withTenant(ctxB(), async (tx) => {
      const r = await tx.$queryRaw<{ invite_user: string }[]>`
        SELECT invite_user('a-' || ${ids.subjectA.slice(6)} || '@example.test', 'Different Name', ${roleId}::uuid, NULL::uuid)`;
      return r[0]!.invite_user;
    });
    // userA's email already exists from org A's seed; the existing record is reused, name untouched.
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const row = (await su.query('SELECT display_name, status FROM app_user WHERE id = $1', [id]))
      .rows[0];
    await su.end();
    expect(row.display_name).toBe('User A');
    expect(row.status).toBe('ACTIVE');
  });

  it('rejects roles and locations from another organisation', async () => {
    const roleId = await systemRoleId('CREW');
    await expect(
      db.withTenant(
        ctxA(),
        (tx) =>
          tx.$queryRaw`SELECT invite_user('x@example.test', 'X', ${roleId}::uuid, ${ids.locB}::uuid)`,
      ),
    ).rejects.toThrow(/location not available/);
  });

  it('refuses to run without an organisation context', async () => {
    const roleId = await systemRoleId('CREW');
    await expect(
      db.withIdentity(
        ids.userA,
        (tx) =>
          tx.$queryRaw`SELECT invite_user('y@example.test', 'Y', ${roleId}::uuid, NULL::uuid)`,
      ),
    ).rejects.toThrow(/organisation context required/);
  });

  it('links an invitation to a verified IdP subject exactly once', async () => {
    const roleId = await systemRoleId('CREW');
    await db.withTenant(
      ctxA(),
      (tx) =>
        tx.$queryRaw`SELECT invite_user('link.me@example.test', 'Link Me', ${roleId}::uuid, NULL::uuid)`,
    );
    const linked = await db.linkInvitedUser('idp|link-me', 'Link.Me@example.test');
    expect(linked).toMatchObject({ email: 'link.me@example.test', status: 'ACTIVE' });
    expect((await db.resolveUser('idp|link-me'))?.id).toBe(linked?.id);
    expect(await db.linkInvitedUser('idp|attacker', 'link.me@example.test')).toBeNull();
    expect(await db.linkInvitedUser('idp|nobody', 'nobody@example.test')).toBeNull();
  });
});

describe('services and activities', () => {
  it('are isolated per organisation', async () => {
    await db.withTenant(ctxA(), (tx) =>
      tx.serviceType.create({
        data: { organisationId: ids.orgA, code: 'PTS', name: 'Patient transport' },
      }),
    );
    expect(await db.withTenant(ctxB(), (tx) => tx.serviceType.findMany())).toEqual([]);
    await expect(
      db.withTenant(ctxB(), (tx) =>
        tx.registeredActivity.create({
          data: {
            organisationId: ids.orgB,
            locationId: ids.locA,
            code: 'TRANSPORT',
            name: 'Transport services',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('optimistic concurrency', () => {
  it('bumps the version on every update', async () => {
    const before = await db.withTenant(ctxA(), (tx) =>
      tx.location.findUniqueOrThrow({ where: { id: ids.locA } }),
    );
    const after = await db.withTenant(ctxA(), (tx) =>
      tx.location.update({ where: { id: ids.locA }, data: { name: 'Renamed' } }),
    );
    expect(after.version).toBe(before.version + 1);
  });
});

describe('break-glass visibility', () => {
  it('lets a support user read only grants issued to them', async () => {
    const su = new pg.Client({ connectionString: urls.admin });
    await su.connect();
    await su.query('BEGIN');
    await su.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    await su.query(
      `INSERT INTO support_access_grant (organisation_id, support_user_id, approved_by, reason, starts_at, ends_at)
       VALUES ($1, $2, $3, 'Investigating ticket 1234', now(), now() + interval '2 hours')`,
      [ids.orgA, ids.userB, ids.userA],
    );
    await su.query('COMMIT');
    await su.end();
    const seen = await db.withIdentity(ids.userB, (tx) => tx.supportAccessGrant.findMany());
    expect(seen).toHaveLength(1);
    expect(await db.withIdentity(ids.userA, (tx) => tx.supportAccessGrant.findMany())).toEqual([]);
  });
  it('caps grants at 8 hours', async () => {
    const su = new pg.Client({ connectionString: urls.admin });
    await su.connect();
    await su.query('BEGIN');
    await su.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    await expect(
      su.query(
        `INSERT INTO support_access_grant (organisation_id, support_user_id, approved_by, reason, starts_at, ends_at)
         VALUES ($1, $2, $3, 'Investigating ticket 1234', now(), now() + interval '9 hours')`,
        [ids.orgA, ids.userB, ids.userA],
      ),
    ).rejects.toThrow(/check constraint/);
    await su.query('ROLLBACK');
    await su.end();
  });
});
