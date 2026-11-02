import { SYSTEM_USER_ID, type Db, type Prisma } from '@hub/db';
import { londonDate } from '@hub/rules';
import { dispatchNotifications, planNotifications, type Mailer } from './notifications.js';
import { jobTimingAlerts } from './dispatch.js';
import { recomputeOrganisation } from './recompute.js';

/**
 * Worker job bodies, kept free of the queue library so they are unit-testable and idempotent.
 * Each runs in its own system-user tenant transaction per organisation, so one failing
 * organisation never blocks the rest.
 */
const sys = (orgId: string) => ({ orgId, userId: SYSTEM_USER_ID });

export interface ReconcileSummary {
  organisations: number;
  total: number;
  changed: number;
  failed: number;
}

/** Recomputes every requirement from its evidence and the clock (status changes with time alone). */
export async function reconcileAll(
  db: Db,
  now: Date,
  log?: (msg: string, ctx: object) => void,
): Promise<ReconcileSummary> {
  const orgs = await db.listOrganisations();
  const out: ReconcileSummary = { organisations: orgs.length, total: 0, changed: 0, failed: 0 };
  for (const orgId of orgs) {
    try {
      const r = await db.withTenant(sys(orgId), (tx) => recomputeOrganisation(tx, now));
      out.total += r.total;
      out.changed += r.changed;
    } catch (e) {
      out.failed += 1;
      log?.('reconcile failed', { orgId, error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return out;
}

/** Plans then dispatches notifications for every organisation. */
export async function notifyAll(
  db: Db,
  now: Date,
  mailer: Mailer,
  appUrl: string,
  log?: (msg: string, ctx: object) => void,
): Promise<{ created: number; sent: number; failed: number; dead: number }> {
  const out = { created: 0, sent: 0, failed: 0, dead: 0 };
  for (const orgId of await db.listOrganisations()) {
    try {
      const p = await db.withTenant(sys(orgId), (tx) => planNotifications(tx, orgId, now));
      const d = await db.withTenant(sys(orgId), (tx) =>
        dispatchNotifications(tx, orgId, now, mailer, appUrl),
      );
      out.created += p.created;
      out.sent += d.sent;
      out.failed += d.failed;
      out.dead += d.dead;
    } catch (e) {
      log?.('notify failed', { orgId, error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return out;
}

/** Writes today's status counts per subject type (trend data; the dashboard reads live values). */
export async function snapshotAll(db: Db, now: Date): Promise<number> {
  let rows = 0;
  const date = new Date(`${londonDate(now)}T00:00:00.000Z`);
  for (const orgId of await db.listOrganisations()) {
    await db.withTenant(sys(orgId), async (tx) => {
      const grouped = await tx.requirementInstance.groupBy({
        by: ['subjectType', 'status'],
        _count: { _all: true },
      });
      const bySubject = new Map<string, Record<string, number>>();
      for (const g of grouped) {
        const c = bySubject.get(g.subjectType) ?? {};
        c[g.status] = g._count._all;
        bySubject.set(g.subjectType, c);
      }
      for (const [subjectType, counts] of bySubject) {
        await tx.statusSnapshot.upsert({
          where: {
            organisationId_snapshotDate_subjectType: {
              organisationId: orgId,
              snapshotDate: date,
              subjectType: subjectType as never,
            },
          },
          create: {
            organisationId: orgId,
            snapshotDate: date,
            subjectType: subjectType as never,
            counts: counts as Prisma.InputJsonObject,
          },
          update: { counts: counts as Prisma.InputJsonObject },
        });
        rows += 1;
      }
    });
  }
  return rows;
}

/** Verifies every organisation's audit hash chain; a break is itself recorded and returned. */
export async function verifyAuditChains(
  db: Db,
): Promise<{ checked: number; broken: { orgId: string; seq: string }[] }> {
  const orgs = await db.listOrganisations();
  const broken: { orgId: string; seq: string }[] = [];
  for (const orgId of orgs) {
    const brk = await db.withTenant(sys(orgId), (tx) => db.verifyAuditChain(tx, orgId));
    if (brk) {
      broken.push({ orgId, seq: brk.brokenSeq.toString() });
      await db.withTenant(sys(orgId), (tx) =>
        db.appendAudit(tx, {
          orgId,
          actorUserId: null,
          actorType: 'SYSTEM',
          action: 'admin.audit.chain_broken',
          entity: 'audit_log',
          entityId: orgId,
          afterSummary: { brokenSeq: brk.brokenSeq.toString() },
        }),
      );
    }
  }
  return { checked: orgs.length, broken };
}

/** Raises, escalates and resolves job timing alerts for every organisation (JOB-04). */
export async function jobTimingAll(
  db: Db,
  now: Date,
  log?: (msg: string, ctx: object) => void,
): Promise<{ organisations: number; raised: number; failed: number }> {
  const orgs = await db.listOrganisations();
  const out = { organisations: orgs.length, raised: 0, failed: 0 };
  for (const orgId of orgs) {
    try {
      out.raised += await db.withTenant(sys(orgId), (tx) => jobTimingAlerts(tx, orgId, now));
    } catch (e) {
      out.failed += 1;
      log?.('job timing failed', { orgId, error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return out;
}
