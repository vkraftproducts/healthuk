import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from '../src/index.js';
import { seedTwoOrgs, type Ids } from './helpers.js';

const urls = inject('urls');
let db: Db;
let ids: Ids;

const ctxA = () => ({ orgId: ids.orgA, userId: ids.userA });
const ctxB = () => ({ orgId: ids.orgB, userId: ids.userB });
const event = (orgId: string, n: number) => ({
  orgId,
  actorUserId: null,
  actorType: 'SYSTEM' as const,
  action: 'test.event.created',
  entity: 'test',
  entityId: `E-${n}`,
  afterSummary: { n },
});

beforeAll(async () => {
  ids = await seedTwoOrgs(urls.admin);
  db = createDb(urls.app);
});
afterAll(async () => {
  await db.close();
});

describe('audit log hash chain', () => {
  it('assigns gap-free sequence numbers per organisation and verifies', async () => {
    for (let n = 1; n <= 3; n++) {
      await db.withTenant(ctxA(), (tx) => db.appendAudit(tx, event(ids.orgA, n)));
    }
    await db.withTenant(ctxB(), (tx) => db.appendAudit(tx, event(ids.orgB, 1)));
    const a = await db.withTenant(ctxA(), (tx) =>
      tx.auditLog.findMany({ orderBy: { seq: 'asc' } }),
    );
    const b = await db.withTenant(ctxB(), (tx) =>
      tx.auditLog.findMany({ orderBy: { seq: 'asc' } }),
    );
    expect(a.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
    expect(b.map((r) => Number(r.seq))).toEqual([1]);
    expect(a[0]?.prevHash).toBe('0'.repeat(64));
    expect(a[1]?.prevHash).toBe(a[0]?.hash);
    expect(a[2]?.prevHash).toBe(a[1]?.hash);
    expect(await db.withTenant(ctxA(), (tx) => db.verifyAuditChain(tx, ids.orgA))).toBeNull();
  });

  it('ignores caller-supplied seq/hash values (the database owns the chain)', async () => {
    await db.withTenant(ctxA(), (tx) =>
      tx.auditLog.create({
        data: {
          organisationId: ids.orgA,
          actorType: 'SYSTEM',
          action: 'test.event.forged',
          entity: 'test',
          entityId: 'forged',
          seq: 999n,
          prevHash: 'f'.repeat(64),
          hash: 'e'.repeat(64),
        },
      }),
    );
    expect(await db.withTenant(ctxA(), (tx) => db.verifyAuditChain(tx, ids.orgA))).toBeNull();
  });

  it('stays linear under concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.withTenant(ctxB(), (tx) => db.appendAudit(tx, event(ids.orgB, 100 + i))),
      ),
    );
    const rows = await db.withTenant(ctxB(), (tx) =>
      tx.auditLog.findMany({ orderBy: { seq: 'asc' } }),
    );
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(await db.withTenant(ctxB(), (tx) => db.verifyAuditChain(tx, ids.orgB))).toBeNull();
  });

  it('cannot be updated or deleted by the application role', async () => {
    const c = new pg.Client({ connectionString: urls.app });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    await expect(c.query(`UPDATE audit_log SET action = 'x.y.z'`)).rejects.toThrow(
      /permission denied/,
    );
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    await expect(c.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
    await c.query('ROLLBACK');
    await c.end();
  });

  it('cannot be updated, deleted or truncated even by the table owner', async () => {
    const c = new pg.Client({ connectionString: urls.admin });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ids.orgA]);
    await expect(c.query(`UPDATE audit_log SET action = 'x.y.z'`)).rejects.toThrow(/append-only/);
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await expect(c.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
    await c.query('ROLLBACK');
    await c.end();
  });

  it('detects tampering made by a superuser who bypasses the triggers', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    await su.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    await su.query(
      `UPDATE audit_log SET after_summary = '{"n":42}'::jsonb
                    WHERE organisation_id = $1 AND seq = 2`,
      [ids.orgA],
    );
    await su.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable');
    await su.end();
    const broken = await db.withTenant(ctxA(), (tx) => db.verifyAuditChain(tx, ids.orgA));
    expect(broken).toEqual({ brokenSeq: 2n, reason: 'hash mismatch' });
  });

  it('cannot write audit events for another organisation', async () => {
    await expect(
      db.withTenant(ctxA(), (tx) => db.appendAudit(tx, event(ids.orgB, 7))),
    ).rejects.toThrow();
  });
});
