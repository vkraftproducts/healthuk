import { SYSTEM_USER_ID, type TenantTx } from '@hub/db';
import {
  evaluateShiftGate,
  summariseReadiness,
  validateAllocation,
  type AllocationResult,
  type Check,
  type PolicyException,
  type Readiness,
} from '@hub/rules';
import { staffReadinessFor } from './staff.js';
import { OPEN_DEFECT, vehicleCapability, vehicleReadinessFor } from './fleet.js';
import { queuePush, shiftCrewUserIds } from './push.js';

const DEFAULT_TRAVEL_BUFFER_MIN = 15;

export async function travelBufferMinutes(tx: TenantTx, orgId: string): Promise<number> {
  const s = ((await tx.organisation.findUniqueOrThrow({ where: { id: orgId } })).settings ??
    {}) as { travelBufferMinutes?: number };
  return typeof s.travelBufferMinutes === 'number'
    ? s.travelBufferMinutes
    : DEFAULT_TRAVEL_BUFFER_MIN;
}

/** The period an allocation occupies on its shift: the planned job window plus travel buffer. */
export function allocationWindow(job: { plannedStart: Date; plannedEnd: Date }, bufferMin: number) {
  return {
    start: new Date(job.plannedStart.getTime() - bufferMin * 60_000),
    end: new Date(job.plannedEnd.getTime() + bufferMin * 60_000),
  };
}

export interface Validation extends AllocationResult {
  crew: { staffId: string; role: string; state: string }[];
  window: { start: string; end: string };
}

/**
 * RULES_ENGINE §4 for one job on one shift, across the WHOLE planned job window, evaluated live
 * (no reliance on stored statuses). No side effects.
 */
export async function validateJobOnShift(
  tx: TenantTx,
  a: { jobId: string; shiftId: string; now: Date; ignoreAllocationId?: string },
): Promise<Validation> {
  const job = await tx.job.findUniqueOrThrow({ where: { id: a.jobId } });
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: a.shiftId } });
  const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: shift.vehicleId } });
  const window = { start: job.plannedStart, end: job.plannedEnd };
  const crew = await tx.crewAssignment.findMany({
    where: {
      shiftId: shift.id,
      active: true,
      startsAt: { lte: window.start },
      endsAt: { gte: window.end },
    },
  });

  // Skills the job needs must be held by at least one crew member.
  const staffResults: { id: string; role: string; readiness: Readiness }[] = [];
  const held = new Set<string>();
  for (const c of crew) {
    const comps = await tx.staffRecord.findMany({
      where: { staffId: c.staffId, kind: 'COMPETENCY', supersededBy: null },
    });
    for (const r of comps) {
      const d = r.data as { code: string; outcome: string; expiresOn?: string };
      if (
        d.outcome === 'COMPETENT' &&
        (!d.expiresOn || d.expiresOn >= window.end.toISOString().slice(0, 10))
      )
        held.add(d.code);
    }
  }
  const missingSkills = job.requiredSkills.filter((s) => !held.has(s));
  for (const [i, c] of crew.entries()) {
    const r = await staffReadinessFor(tx, {
      staffId: c.staffId,
      role: c.role,
      window,
      licenceCategory: c.role === 'DRIVER' ? vehicle.licenceCategory : undefined,
      competencies: i === 0 ? missingSkills : [],
      now: a.now,
    });
    staffResults.push({ id: c.staffId, role: c.role, readiness: r });
  }
  const crewProblems: Check[] = [];
  if (!crew.some((c) => c.role === 'DRIVER'))
    crewProblems.push({
      code: 'NO_DRIVER',
      group: 'CLEARANCE',
      result: 'FAIL',
      reasonText: 'No approved driver on the shift for the whole job',
      overridable: false,
    });
  if (crew.length < job.crewSize)
    crewProblems.push({
      code: 'CREW_SIZE',
      group: 'CLEARANCE',
      result: 'FAIL',
      reasonText: `Job needs ${job.crewSize} crew; ${crew.length} assigned for the whole window`,
      overridable: false,
    });
  if (crewProblems.length)
    staffResults.push({ id: 'shift', role: 'SHIFT', readiness: summariseReadiness(crewProblems) });

  const vr = await vehicleReadinessFor(tx, { vehicleId: vehicle.id, window, now: a.now });
  const cap = await vehicleCapability(tx, vehicle.id);
  const assets = await tx.equipmentAsset.findMany({
    where: { vehicleId: vehicle.id, status: { not: 'RETIRED' } },
    include: { defects: { where: { stopUse: true, status: OPEN_DEFECT }, select: { id: true } } },
  });
  const assetIds = assets.map((x) => x.id);
  const redRegimes = await tx.requirementInstance.findMany({
    where: { subjectType: 'EQUIPMENT', subjectId: { in: assetIds }, status: 'RED' },
    select: { subjectId: true },
  });
  const stretcherSwl = assets
    .filter((x) => x.capability === 'STRETCHER' && x.swlKg !== null)
    .map((x) => Number(x.swlKg));

  // Other jobs on this shift (with travel buffer), and crew double-booked elsewhere.
  const buffer = await travelBufferMinutes(tx, job.organisationId);
  const w = allocationWindow(job, buffer);
  const conflicts: { resourceType: 'STAFF' | 'VEHICLE'; resourceId: string; otherJobId: string }[] =
    [];
  const overlapping = await tx.jobAllocation.findMany({
    where: {
      shiftId: shift.id,
      active: true,
      jobId: { not: job.id },
      startsAt: { lt: w.end },
      endsAt: { gt: w.start },
      ...(a.ignoreAllocationId ? { id: { not: a.ignoreAllocationId } } : {}),
    },
    include: { job: { select: { code: true } } },
  });
  for (const o of overlapping)
    conflicts.push({
      resourceType: 'VEHICLE',
      resourceId: vehicle.callsign,
      otherJobId: o.job.code,
    });
  if (job.plannedStart < shift.startsAt || job.plannedEnd > shift.endsAt)
    conflicts.push({
      resourceType: 'VEHICLE',
      resourceId: vehicle.callsign,
      otherJobId: 'outside the shift hours',
    });

  const vdi = await tx.vdi.findFirst({
    where: { shiftId: shift.id, vehicleId: vehicle.id },
    orderBy: { capturedAt: 'desc' },
    include: { items: true, amendments: true },
  });
  const failedCritical = vdi ? vdi.items.some((it) => it.critical && it.result === 'FAIL') : false;
  const cleaned = await tx.cleaningRecord.count({
    where: { shiftId: shift.id, vehicleId: vehicle.id, type: 'PRE_SHIFT' },
  });
  const exceptions: PolicyException[] = (
    await tx.allocationException.findMany({ where: { jobId: job.id, expiresAt: { gt: a.now } } })
  ).map((e) => ({
    code: e.checkCode as PolicyException['code'],
    approvedBy: e.approverId,
    reason: e.reason,
    expiresAt: e.expiresAt,
  }));

  const result = validateAllocation({
    now: a.now,
    job: {
      start: job.plannedStart,
      seatsNeeded: 1 + job.escorts,
      wheelchairsNeeded: job.mobility === 'WHEELCHAIR' ? 1 : 0,
      stretchersNeeded: job.mobility === 'STRETCHER' ? 1 : 0,
      loadKg: job.mobility === 'STRETCHER' ? (job.weightKg ?? 0) : 0,
      requiredEquipment: job.requiredEquipment,
    },
    staff: staffResults.map((s) => ({ id: s.id, readiness: s.readiness })),
    vehicle: {
      id: vehicle.id,
      readiness: vr,
      capacity: {
        seats: vehicle.seats,
        wheelchairs: cap.wheelchairCapacity,
        stretchers: cap.stretcher ? 1 : 0,
        maxLoadKg: stretcherSwl.length ? Math.min(...stretcherSwl) : 1000,
      },
      equipmentPresent: [...new Set(assets.map((x) => x.category))],
      quarantinedEquipment: [
        ...new Set(
          assets
            .filter((x) => x.status === 'QUARANTINED' || x.defects.length > 0)
            .map((x) => x.category),
        ),
      ],
      expiredEquipment: [
        ...new Set(
          assets.filter((x) => redRegimes.some((r) => r.subjectId === x.id)).map((x) => x.category),
        ),
      ],
    },
    conflicts,
    shiftGate: {
      vdi: vdi ? (failedCritical ? 'FAIL' : 'PASS') : 'PENDING',
      cleaning: cleaned > 0 ? 'CONFIRMED' : 'NOT_CONFIRMED',
      shiftStart: shift.startsAt,
    },
    exceptions,
  });
  return {
    ...result,
    crew: staffResults
      .filter((s) => s.id !== 'shift')
      .map((s) => ({ staffId: s.id, role: s.role, state: s.readiness.state })),
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
  };
}

/** Shift start gate (RULES_ENGINE §5, UAT-03) for the person starting the shift. */
export async function shiftGateFor(tx: TenantTx, shiftId: string, staffId: string, now: Date) {
  const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });
  const assignment = await tx.crewAssignment.findFirst({
    where: { shiftId, staffId, active: true },
  });
  const vdi = await tx.vdi.findFirst({
    where: { shiftId },
    orderBy: { capturedAt: 'desc' },
    include: { items: true },
  });
  const clean = await tx.cleaningRecord.findFirst({
    where: { shiftId, type: 'PRE_SHIFT' },
    orderBy: { capturedAt: 'desc' },
  });
  const readiness = await staffReadinessFor(tx, {
    staffId,
    role: assignment?.role ?? 'OTHER',
    window: { start: now > shift.startsAt ? now : shift.startsAt, end: shift.endsAt },
    licenceCategory:
      assignment?.role === 'DRIVER'
        ? (await tx.vehicle.findUniqueOrThrow({ where: { id: shift.vehicleId } })).licenceCategory
        : undefined,
    now,
  });
  return evaluateShiftGate({
    shiftVehicleId: shift.vehicleId,
    shiftId,
    vdi: vdi
      ? {
          vehicleId: vdi.vehicleId,
          shiftId,
          failedCritical: vdi.items.some((i) => i.critical && i.result === 'FAIL'),
        }
      : null,
    cleaningConfirmed: clean ? { vehicleId: clean.vehicleId, shiftId } : null,
    staffReadiness: readiness,
  });
}

const JOB_ALERT_RANK = { JOB_UNACKNOWLEDGED: 1, JOB_LATE: 2, JOB_NEEDS_REASSIGNMENT: 3 } as const;
type JobAlertCode = keyof typeof JOB_ALERT_RANK;

/**
 * One live alert per job (alert_open_source_idx). A more serious reason replaces a lesser one in
 * place; a lesser reason never downgrades it. Returns true when an alert was raised or escalated.
 */
export async function upsertJobAlert(
  tx: TenantTx,
  a: {
    orgId: string;
    jobId: string;
    reasonCode: JobAlertCode;
    severity: 'CRITICAL' | 'HIGH';
    text: string;
  },
): Promise<boolean> {
  const open = await tx.alert.findFirst({
    where: { sourceType: 'JOB', sourceId: a.jobId, state: { not: 'RESOLVED' } },
  });
  if (!open) {
    await tx.alert.create({
      data: {
        organisationId: a.orgId,
        sourceType: 'JOB',
        sourceId: a.jobId,
        severity: a.severity,
        reasonCode: a.reasonCode,
        reasonText: a.text,
      },
    });
    return true;
  }
  const current = JOB_ALERT_RANK[open.reasonCode as JobAlertCode] ?? 0;
  if (current >= JOB_ALERT_RANK[a.reasonCode]) return false;
  await tx.alert.update({
    where: { id: open.id },
    data: {
      reasonCode: a.reasonCode,
      reasonText: a.text,
      severity: a.severity,
      state: 'OPEN',
      snoozedUntil: null,
    },
  });
  return true;
}

/** Control has dealt with the job (re-allocated or cancelled): its live alert closes. */
export async function resolveJobAlerts(tx: TenantTx, jobId: string, now: Date): Promise<void> {
  await tx.alert.updateMany({
    where: { sourceType: 'JOB', sourceId: jobId, state: { not: 'RESOLVED' } },
    data: { state: 'RESOLVED', resolvedAt: now },
  });
}

/**
 * FLT-06 / T14: a stop-use defect releases future allocations on that vehicle (jobs go back for
 * reassignment and control is alerted); jobs already under way are flagged to control only.
 */
export async function releaseAllocationsForVehicle(
  tx: TenantTx,
  vehicleId: string,
  from: Date,
  reason: string,
  actorUserId: string = SYSTEM_USER_ID,
): Promise<string[]> {
  const allocations = await tx.jobAllocation.findMany({
    where: { active: true, endsAt: { gt: from }, shift: { vehicleId } },
    include: { job: true },
  });
  const released: string[] = [];
  for (const al of allocations) {
    const notStarted = ['ALLOCATED', 'OFFERED', 'ACKNOWLEDGED'].includes(al.job.state);
    if (notStarted) {
      await tx.jobAllocation.update({
        where: { id: al.id },
        data: { active: false, releasedAt: from, releaseReason: reason },
      });
      await tx.jobStatusEvent.create({
        data: {
          organisationId: al.organisationId,
          jobId: al.jobId,
          fromState: al.job.state,
          toState: 'REASSIGNED',
          actorUserId,
          capturedAt: from,
          reason,
        },
      });
      await tx.job.update({ where: { id: al.jobId }, data: { state: 'REASSIGNED' } });
      released.push(al.jobId);
      // The crew losing the job is told (generically) to refresh.
      await queuePush(tx, {
        orgId: al.organisationId,
        userIds: await shiftCrewUserIds(tx, al.shiftId),
        kind: 'JOB_CHANGED',
        refId: al.jobId,
        event: `released:${al.id}`,
      });
    }
    await upsertJobAlert(tx, {
      orgId: al.organisationId,
      jobId: al.jobId,
      reasonCode: 'JOB_NEEDS_REASSIGNMENT',
      severity: 'CRITICAL',
      // Job code only: no patient details in alerts (non-negotiable 7).
      text: notStarted
        ? `${al.job.code} needs a new vehicle: ${reason}`
        : `${al.job.code} is under way on a blocked vehicle: ${reason}`,
    });
  }
  return released;
}

/** Worker: alerts control about unacknowledged offers and late jobs (JOB-04). Deduplicated. */
export async function jobTimingAlerts(
  tx: TenantTx,
  orgId: string,
  now: Date,
  ackMinutes = 15,
): Promise<number> {
  let raised = 0;
  const offered = await tx.jobStatusEvent.findMany({
    where: {
      toState: 'OFFERED',
      job: { state: 'OFFERED' },
      receivedAt: { lt: new Date(now.getTime() - ackMinutes * 60_000) },
    },
    include: { job: { select: { code: true } } },
  });
  const late = await tx.job.findMany({
    where: { state: { in: ['ALLOCATED', 'OFFERED', 'ACKNOWLEDGED'] }, plannedStart: { lt: now } },
  });
  const raise = async (
    jobId: string,
    code: string,
    reasonCode: 'JOB_UNACKNOWLEDGED' | 'JOB_LATE',
    text: string,
  ) => {
    if (
      await upsertJobAlert(tx, {
        orgId,
        jobId,
        reasonCode,
        severity: 'HIGH',
        text: `${code} ${text}`,
      })
    )
      raised += 1;
  };
  for (const e of offered)
    await raise(
      e.jobId,
      e.job.code,
      'JOB_UNACKNOWLEDGED',
      `not acknowledged within ${ackMinutes} minutes`,
    );
  for (const j of late)
    await raise(j.id, j.code, 'JOB_LATE', 'has passed its planned start and is not under way');
  // Jobs that have moved on resolve their timing alerts.
  await tx.alert.updateMany({
    where: {
      sourceType: 'JOB',
      reasonCode: { in: ['JOB_UNACKNOWLEDGED', 'JOB_LATE'] },
      state: { not: 'RESOLVED' },
      sourceId: { notIn: [...offered.map((o) => o.jobId), ...late.map((l) => l.id)] },
    },
    data: { state: 'RESOLVED', resolvedAt: now },
  });
  return raised;
}

/** Future work affected by a stop-use defect on a vehicle (released for reassignment). */
export function affectedAllocations(
  tx: TenantTx,
  vehicleId: string,
  from: Date,
): Promise<string[]> {
  return releaseAllocationsForVehicle(tx, vehicleId, from, 'Vehicle blocked by a stop-use defect');
}
