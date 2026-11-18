import { SYSTEM_USER_ID, type Db } from '@hub/db';
import { londonDate } from '@hub/rules';

/**
 * Persists overdue actions, audits, missed supervisions, stale defects,
 * overdue supervision cycles and started shifts without a daily check as alert
 * rows so the escalation worker can email/push the lead and registered manager.
 */
export async function syncOverdueAlerts(
  db: Db,
  now = new Date(),
  log?: (msg: string, ctx: object) => void,
): Promise<{
  organisations: number;
  actions: number;
  audits: number;
  supervisions: number;
  defects: number;
  checks: number;
  failed: number;
}> {
  const today = new Date(londonDate(now) + 'T00:00:00.000Z');
  const eightWeeksAgo = new Date(now.getTime() - 56 * 86_400_000);
  const orgs = await db.listOrganisations();
  const out = {
    organisations: orgs.length,
    actions: 0,
    audits: 0,
    supervisions: 0,
    defects: 0,
    checks: 0,
    failed: 0,
  };

  for (const orgId of orgs) {
    try {
      await db.withTenant({ orgId, userId: SYSTEM_USER_ID }, async (tx) => {
        const overdueActions = await tx.action.findMany({
          where: { status: { in: ['OPEN', 'REJECTED'] }, deadline: { lt: today } },
          take: 500,
        });
        for (const a of overdueActions) {
          const existing = await tx.alert.findFirst({
            where: { sourceType: 'ACTION', sourceId: a.id, state: { not: 'RESOLVED' } },
          });
          if (existing) continue;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'ACTION',
              sourceId: a.id,
              ownerUserId: a.ownerUserId,
              severity: a.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
              reasonCode: 'ACTION_OVERDUE',
              reasonText:
                a.status === 'REJECTED'
                  ? `${a.code} overdue – evidence was rejected`
                  : `${a.code} overdue`,
            },
          });
          out.actions += 1;
        }

        const overdueAudits = await tx.auditRun.findMany({
          where: {
            status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
            dueDate: { lt: today },
          },
          take: 500,
        });
        for (const r of overdueAudits) {
          const existing = await tx.alert.findFirst({
            where: { sourceType: 'AUDIT', sourceId: r.id, state: { not: 'RESOLVED' } },
          });
          if (existing) continue;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'AUDIT',
              sourceId: r.id,
              ownerUserId: r.ownerUserId,
              severity: 'HIGH',
              reasonCode: 'AUDIT_OVERDUE',
              reasonText:
                r.status === 'SCHEDULED'
                  ? `${r.code} overdue – not started`
                  : `${r.code} overdue – not finished`,
            },
          });
          out.audits += 1;
        }

        const missed = await tx.supervisionBooking.findMany({
          where: { status: 'MISSED' },
          take: 200,
        });
        for (const s of missed) {
          const existing = await tx.alert.findFirst({
            where: { sourceType: 'SUPERVISION', sourceId: s.id, state: { not: 'RESOLVED' } },
          });
          if (existing) continue;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'SUPERVISION',
              sourceId: s.id,
              ownerUserId: s.supervisorUserId,
              severity: 'HIGH',
              reasonCode: 'SUPERVISION_MISSED',
              reasonText: `Missed supervision (${s.kind.replace(/_/g, ' ').toLowerCase()})`,
            },
          });
          out.supervisions += 1;
        }

        // Recurring 8-week cycle: active staff with no held supervision in 56 days.
        const activeStaff = await tx.staff.findMany({
          where: { lifecycleState: 'ACTIVE' },
          select: { id: true, displayName: true, managerStaffId: true },
          take: 500,
        });
        const managerIds = activeStaff
          .map((p) => p.managerStaffId)
          .filter((id): id is string => !!id);
        const managers =
          managerIds.length > 0
            ? await tx.staff.findMany({
                where: { id: { in: managerIds } },
                select: { id: true, userId: true },
              })
            : [];
        const managerUser = new Map(managers.map((m) => [m.id, m.userId]));
        for (const person of activeStaff) {
          const recent = await tx.supervisionBooking.findFirst({
            where: {
              staffId: person.id,
              status: 'HELD',
              scheduledAt: { gte: eightWeeksAgo },
            },
            select: { id: true },
          });
          if (recent) continue;
          const openBooked = await tx.supervisionBooking.findFirst({
            where: { staffId: person.id, status: 'BOOKED', scheduledAt: { gte: now } },
            select: { id: true },
          });
          if (openBooked) continue;
          const existing = await tx.alert.findFirst({
            where: {
              sourceType: 'STAFF',
              sourceId: person.id,
              reasonCode: 'SUPERVISION_CYCLE_OVERDUE',
              state: { not: 'RESOLVED' },
            },
          });
          if (existing) continue;
          const owner =
            (person.managerStaffId ? managerUser.get(person.managerStaffId) : null) ?? null;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'STAFF',
              sourceId: person.id,
              ownerUserId: owner,
              severity: 'MEDIUM',
              reasonCode: 'SUPERVISION_CYCLE_OVERDUE',
              reasonText: `${person.displayName}: no held supervision in the last 8 weeks`,
            },
          });
          out.supervisions += 1;
        }

        // Probation reviews still booked in the past and not closed.
        const overdueProbation = await tx.supervisionBooking.findMany({
          where: {
            kind: 'PROBATION_REVIEW',
            status: 'BOOKED',
            scheduledAt: { lt: now },
          },
          take: 100,
        });
        for (const s of overdueProbation) {
          const existing = await tx.alert.findFirst({
            where: {
              sourceType: 'SUPERVISION',
              sourceId: s.id,
              reasonCode: 'PROBATION_REVIEW_OVERDUE',
              state: { not: 'RESOLVED' },
            },
          });
          if (existing) continue;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'SUPERVISION',
              sourceId: s.id,
              ownerUserId: s.supervisorUserId,
              severity: 'HIGH',
              reasonCode: 'PROBATION_REVIEW_OVERDUE',
              reasonText: 'Probation review date has passed without an outcome',
            },
          });
          out.supervisions += 1;
        }

        const stale = await tx.defect.findMany({
          where: {
            status: { in: ['OPEN', 'REPAIRING', 'REPAIRED'] },
            reviewBy: { lt: today },
          },
          take: 200,
        });
        for (const d of stale) {
          const existing = await tx.alert.findFirst({
            where: {
              sourceType: 'DEFECT',
              sourceId: d.id,
              reasonCode: 'DEFECT_REVIEW_OVERDUE',
              state: { not: 'RESOLVED' },
            },
          });
          if (existing) continue;
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'DEFECT',
              sourceId: d.id,
              ownerUserId: d.ownerUserId,
              severity: d.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
              reasonCode: 'DEFECT_REVIEW_OVERDUE',
              reasonText: `Defect past review-by date (${d.severity.toLowerCase()})`,
            },
          });
          out.defects += 1;
        }

        // Started shifts that already have a job but no daily vehicle check.
        const started = await tx.shift.findMany({
          where: { state: 'STARTED' },
          include: { allocations: { where: { active: true }, take: 1 } },
          take: 200,
        });
        for (const shift of started) {
          if (shift.allocations.length === 0) continue;
          const vdi = await tx.vdi.findFirst({
            where: { shiftId: shift.id },
            select: { id: true },
          });
          if (vdi) continue;
          const existing = await tx.alert.findFirst({
            where: {
              sourceType: 'SHIFT',
              sourceId: shift.id,
              reasonCode: 'NO_CHECK_BEFORE_FIRST_JOB',
              state: { not: 'RESOLVED' },
            },
          });
          if (existing) continue;
          const vehicle = await tx.vehicle.findUnique({
            where: { id: shift.vehicleId },
            select: { callsign: true },
          });
          const lead = await tx.membership.findFirst({
            where: {
              organisationId: orgId,
              validTo: null,
              role: { key: { in: ['FLEET_LEAD', 'CONTROL_LEAD'] } },
            },
            orderBy: { validFrom: 'asc' },
            select: { userId: true },
          });
          await tx.alert.create({
            data: {
              organisationId: orgId,
              sourceType: 'SHIFT',
              sourceId: shift.id,
              ownerUserId: lead?.userId ?? null,
              severity: 'HIGH',
              reasonCode: 'NO_CHECK_BEFORE_FIRST_JOB',
              reasonText: `${vehicle?.callsign ?? 'Vehicle'}: shift started with a job and no daily vehicle check`,
            },
          });
          out.checks += 1;
        }
      });
    } catch (e) {
      out.failed += 1;
      log?.('overdue alerts sync failed', {
        orgId,
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  }

  return out;
}
