import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../src/index.js';
import { asOwner, seedTwoOrgs, type Ids } from './helpers.js';

const urls = inject('urls');
let db: Db;
let ids: Ids;

beforeAll(async () => {
  ids = await seedTwoOrgs(urls.admin);
  db = createDb(urls.app);
});
afterAll(async () => {
  await db.close();
});

describe('application role', () => {
  it('is not a superuser, not the owner and cannot bypass RLS', async () => {
    const c = new pg.Client({ connectionString: urls.app });
    await c.connect();
    const role = (
      await c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
    ).rows[0];
    const owned = (
      await c.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner = current_user`,
      )
    ).rows[0];
    await c.end();
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(owned.n).toBe(0);
  });

  it('has FORCE RLS enabled on every tenant table', async () => {
    const rows = await asOwner(
      urls.admin,
      null,
      async (c) =>
        (
          await c.query(`
          SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r'
            AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)
            AND c.relname <> 'app_user'   -- documented exception, see migration 0001
            AND EXISTS (SELECT 1 FROM information_schema.columns col
                        WHERE col.table_name = c.relname AND col.column_name = 'organisation_id')
        `)
        ).rows,
    );
    expect(rows).toEqual([]);
  });
});

describe('tenant isolation (RLS via withTenant)', () => {
  it('returns only the current organisation rows', async () => {
    const seenByA = await db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
      tx.location.findMany(),
    );
    expect(seenByA.map((l) => l.id)).toEqual([ids.locA]);
    const seenByB = await db.withTenant({ orgId: ids.orgB, userId: ids.userB }, (tx) =>
      tx.location.findMany(),
    );
    expect(seenByB.map((l) => l.id)).toEqual([ids.locB]);
  });

  it('cannot read another organisation record by id (looks like not found)', async () => {
    const row = await db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
      tx.location.findUnique({ where: { id: ids.locB } }),
    );
    expect(row).toBeNull();
  });

  it('cannot insert a row for another organisation', async () => {
    await expect(
      db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
        tx.location.create({ data: { organisationId: ids.orgB, name: 'Smuggled' } }),
      ),
    ).rejects.toThrow();
  });

  it('cannot update or move rows belonging to another organisation', async () => {
    const res = await db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
      tx.location.updateMany({ where: { id: ids.locB }, data: { name: 'Hijacked' } }),
    );
    expect(res.count).toBe(0);
    await expect(
      db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
        tx.location.updateMany({ where: { id: ids.locA }, data: { organisationId: ids.orgB } }),
      ),
    ).rejects.toThrow();
  });

  it('fails closed: no context means no rows', async () => {
    const c = new pg.Client({ connectionString: urls.app });
    await c.connect();
    const counts = (
      await c.query(`SELECT
        (SELECT count(*)::int FROM location) AS locations,
        (SELECT count(*)::int FROM organisation) AS organisations,
        (SELECT count(*)::int FROM membership) AS memberships,
        (SELECT count(*)::int FROM audit_log) AS audit`)
    ).rows[0];
    await c.end();
    expect(counts).toEqual({ locations: 0, organisations: 0, memberships: 0, audit: 0 });
  });

  it('context does not leak between transactions on a pooled connection', async () => {
    await db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) => tx.location.findMany());
    const after = await db.withTenant({ orgId: ids.orgB, userId: ids.userB }, (tx) =>
      tx.location.findMany(),
    );
    expect(after.map((l) => l.id)).toEqual([ids.locB]);
  });

  it('rejects malformed context values instead of passing them to SQL', async () => {
    await expect(
      db.withTenant({ orgId: "x'; DROP TABLE location;--", userId: ids.userA }, async () => 1),
    ).rejects.toThrow(/UUID/);
  });
});

describe('identity and memberships', () => {
  it('resolves a user from a verified IdP subject, null when unknown', async () => {
    expect((await db.resolveUser(ids.subjectA))?.id).toBe(ids.userA);
    expect(await db.resolveUser('nobody')).toBeNull();
  });

  it('lets a user list only their own memberships before choosing an organisation', async () => {
    const mine = await db.withIdentity(ids.userA, (tx) => tx.membership.findMany());
    expect(mine.map((m) => m.organisationId).sort()).toEqual([ids.orgA, ids.orgB].sort());
    const others = await db.withIdentity(ids.userB, (tx) => tx.membership.findMany());
    expect(others.map((m) => m.organisationId)).toEqual([ids.orgB]);
  });

  it("does not expose another organisation's users", async () => {
    const seenFromA = await db.withTenant({ orgId: ids.orgA, userId: ids.userA }, (tx) =>
      tx.appUser.findMany({ select: { id: true } }),
    );
    // userA is in A (and B); userB is only in B => invisible from org A.
    expect(seenFromA.map((u) => u.id)).toEqual([ids.userA]);
  });
});
