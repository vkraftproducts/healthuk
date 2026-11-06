import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import {
  drivingCategoryFor,
  evaluateShiftGate,
  formatDate,
  londonTime,
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

/** Competence codes that count as the emergency (blue-light) driving qualification. */
const EMERGENCY_DRIVING = ['EMERGENCY_DRIVING', 'BLUE_LIGHT', 'BLUE_LIGHT_DRIVING'];
const hasEmergencyDriving = (held: Set<string> | undefined) =>
  EMERGENCY_DRIVING.some((c) => held?.has(c));

/**
 * E3: driving licence failures in the doc's words ("Driving licence not verified", "Licence
 * does not cover C1 vehicle", photocard dates in London format).
 */
export function plainLicenceWords(r: Readiness, needed: string): void {
  for (const c of r.checks) {
    if (c.group !== 'LICENCE' || c.result !== 'FAIL') continue;
    if (c.code === 'LICENCE_CATEGORY') c.reasonText = `Licence does not cover ${needed} vehicle`;
    else if (c.code === 'LICENCE_NOT_VERIFIED' || /No verified evidence/i.test(c.reasonText))
      c.reasonText = 'Driving licence not verified';
    else if (c.code === 'LICENCE_EXPIRY')
      c.reasonText = c.reasonText.replace(/\d{4}-\d{2}-\d{2}/, (d) => formatDate(d));
  }
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

  // Skills the job needs must be held by at least one crew member. Competence comes from the
  // staff COMPETENCY records (in date for the whole job); there is no shared competency-rules
  // export in @hub/rules yet.
  const staffResults: { id: string; role: string; readiness: Readiness }[] = [];
  const held = new Set<string>();
  const heldBy = new Map<string, Set<string>>();
  for (const c of crew) {
    const comps = await tx.staffRecord.findMany({
      where: { staffId: c.staffId, kind: 'COMPETENCY', supersededBy: null },
    });
    const mine = new Set<string>();
    for (const r of comps) {
      const d = r.data as { code: string; outcome: string; expiresOn?: string };
      if (
        d.outcome === 'COMPETENT' &&
        (!d.expiresOn || d.expiresOn >= window.end.toISOString().slice(0, 10))
      ) {
        held.add(d.code);
        mine.add(d.code);
      }
    }
    heldBy.set(c.staffId, mine);
  }
  const missingSkills = job.requiredSkills.filter((s) => !held.has(s));
  const needed = drivingCategoryFor(vehicle.licenceCategory, vehicle.grossWeightKg);
  const names = new Map(
    (
      await tx.staff.findMany({
        where: { id: { in: crew.map((c) => c.staffId) } },
        select: { id: true, displayName: true },
      })
    ).map((s) => [s.id, s.displayName]),
  );
  for (const [i, c] of crew.entries()) {
    const r = await staffReadinessFor(tx, {
      staffId: c.staffId,
      role: c.role,
      window,
      licenceCategory: c.role === 'DRIVER' ? vehicle.licenceCategory : undefined,
      vehicleGrossWeightKg: vehicle.grossWeightKg,
      competencies: i === 0 ? missingSkills : [],
      now: a.now,
    });
    if (c.role === 'DRIVER') {
      plainLicenceWords(r, needed);
      // E3: a blue-light job needs the emergency driving qualification.
      if (job.blueLights && !hasEmergencyDriving(heldBy.get(c.staffId))) {
        r.checks.push({
          code: 'EMERGENCY_DRIVING',
          group: 'LICENCE',
          result: 'FAIL',
          reasonText: 'No emergency driving qualification for a blue-light job',
          overridable: false,
        });
        r.state = 'BLOCKED';
      }
    }
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
  const conflicts: {
    resourceType: 'STAFF' | 'VEHICLE';
    resourceId: string;
    otherJobId: string;
    text: string;
  }[] = [];
  const overlapping = await tx.jobAllocation.findMany({
    where: {
      shiftId: shift.id,
      active: true,
      jobId: { not: job.id },
      startsAt: { lt: w.end },
      endsAt: { gt: w.start },
      ...(a.ignoreAllocationId ? { id: { not: a.ignoreAllocationId } } : {}),
    },
    include: { job: { select: { code: true, plannedStart: true, plannedEnd: true } } },
  });
  // E3: plain words naming the vehicle and the times; travel time is part of the window.
  for (const o of overlapping)
    conflicts.push({
      resourceType: 'VEHICLE',
      resourceId: vehicle.callsign,
      otherJobId: o.job.code,
      text:
        `${vehicle.callsign} is already on ${o.job.code} from ${londonTime(o.job.plannedStart)} ` +
        `to ${londonTime(o.job.plannedEnd)}, with ${buffer} minutes' travel either side`,
    });
  if (job.plannedStart < shift.startsAt || job.plannedEnd > shift.endsAt)
    conflicts.push({
      resourceType: 'VEHICLE',
      resourceId: vehicle.callsign,
      otherJobId: 'outside the shift hours',
      text:
        `The job runs outside the ${vehicle.callsign} shift ` +
        `(${londonTime(shift.startsAt)} to ${londonTime(shift.endsAt)})`,
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

  // Permitted load: the stretcher's safe working load for stretcher work, and the vehicle's
  // bariatric limit where one is recorded. A bariatric job needs a recorded bariatric limit.
  const onStretcher = job.mobility === 'STRETCHER' || job.mobility === 'BARIATRIC';
  const inWheelchair = job.mobility === 'WHEELCHAIR' || job.mobility === 'OWN_WHEELCHAIR';
  const limits = [
    ...(onStretcher ? stretcherSwl : []),
    ...(vehicle.bariatricLimitKg ? [vehicle.bariatricLimitKg] : []),
  ];
  const loadKg = onStretcher || limits.length ? (job.weightKg ?? 0) : 0;
  const result = validateAllocation({
    now: a.now,
    job: {
      start: job.plannedStart,
      seatsNeeded: 1 + job.escorts,
      wheelchairsNeeded: inWheelchair ? 1 : 0,
      stretchersNeeded: onStretcher ? 1 : 0,
      bariatric: job.mobility === 'BARIATRIC',
      loadKg,
      requiredEquipment: job.requiredEquipment,
      blueLights: job.blueLights,
    },
    staff: staffResults.map((s) => ({
      id: s.id,
      name: s.id === 'shift' ? undefined : names.get(s.id),
      readiness: s.readiness,
    })),
    vehicle: {
      id: vehicle.id,
      readiness: vr,
      capacity: {
        seats: vehicle.seats,
        wheelchairs: cap.wheelchairCapacity,
        stretchers: cap.stretcher ? 1 : 0,
        maxLoadKg: limits.length ? Math.min(...limits) : 1000,
        blueLightAuthorised: vehicle.blueLightAuthorised,
        bariatricLimitKg: vehicle.bariatricLimitKg,
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
      started: shift.state !== 'PLANNED',
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
  const driven =
    assignment?.role === 'DRIVER'
      ? await tx.vehicle.findUniqueOrThrow({ where: { id: shift.vehicleId } })
      : null;
  const readiness = await staffReadinessFor(tx, {
    staffId,
    role: assignment?.role ?? 'OTHER',
    window: { start: now > shift.startsAt ? now : shift.startsAt, end: shift.endsAt },
    licenceCategory: driven?.licenceCategory,
    vehicleGrossWeightKg: driven?.grossWeightKg ?? null,
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

/**
 * E3: allocations are checked again as things change (a defect, an expiry, a licence lapse).
 * A job that no longer passes is flagged red to control with the first failing reason; the
 * allocation stays so control decides. The shift gate is left to shift start.
 */
export async function recheckAllocations(
  tx: TenantTx,
  orgId: string,
  now: Date,
  opts: { shiftId?: string; horizonHours?: number } = {},
): Promise<{ jobId: string; code: string; reasonText: string }[]> {
  const horizon = new Date(now.getTime() + (opts.horizonHours ?? 24) * 3_600_000);
  const allocations = await tx.jobAllocation.findMany({
    where: {
      active: true,
      endsAt: { gt: now },
      ...(opts.shiftId ? { shiftId: opts.shiftId } : { startsAt: { lt: horizon } }),
      job: { state: { in: ['ALLOCATED', 'OFFERED', 'ACKNOWLEDGED'] } },
    },
    include: { job: { select: { code: true } } },
  });
  const flagged: { jobId: string; code: string; reasonText: string }[] = [];
  for (const al of allocations) {
    const v = await validateJobOnShift(tx, {
      jobId: al.jobId,
      shiftId: al.shiftId,
      now,
      ignoreAllocationId: al.id,
    });
    const failing = v.checks.find(
      (c) => c.result === 'FAIL' && !c.excepted && c.code !== 'SHIFT_GATE',
    );
    if (!failing) continue;
    flagged.push({ jobId: al.jobId, code: al.job.code, reasonText: failing.reasonText });
    // Job code and the check only: no patient details in alerts.
    await upsertJobAlert(tx, {
      orgId,
      jobId: al.jobId,
      reasonCode: 'JOB_NEEDS_REASSIGNMENT',
      severity: 'CRITICAL',
      text: `${al.job.code} no longer passes its checks: ${failing.reasonText}`,
    });
  }
  return flagged;
}

/** Worker body for `recheckAllocations`, one tenant transaction per organisation. */
export async function recheckAll(
  db: Db,
  now: Date,
  log?: (msg: string, ctx: object) => void,
): Promise<{ organisations: number; flagged: number; failed: number }> {
  const orgs = await db.listOrganisations();
  const out = { organisations: orgs.length, flagged: 0, failed: 0 };
  for (const orgId of orgs) {
    try {
      out.flagged += (
        await db.withTenant({ orgId, userId: SYSTEM_USER_ID }, (tx) =>
          recheckAllocations(tx, orgId, now),
        )
      ).length;
    } catch (e) {
      out.failed += 1;
      log?.('allocation recheck failed', {
        orgId,
        error: e instanceof Error ? e.message : 'unknown',
      });
    }
  }
  return out;
}

/**
 * E2: who or what is already booked over a time, in plain words, e.g. "Sam Taylor is already on
 * AMB-02 from 07:00 to 19:00". Null when nothing overlaps.
 */
export async function overlapText(
  tx: TenantTx,
  r: {
    resourceType: 'STAFF' | 'VEHICLE';
    resourceId: string;
    start: Date;
    end: Date;
    ignoreShiftId?: string;
  },
): Promise<string | null> {
  const clash = await tx.resourceBooking.findFirst({
    where: {
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      active: true,
      startsAt: { lt: r.end },
      endsAt: { gt: r.start },
    },
    orderBy: { startsAt: 'asc' },
  });
  if (!clash) return null;
  const shiftId =
    clash.sourceType === 'SHIFT'
      ? clash.sourceId
      : (await tx.crewAssignment.findUnique({ where: { id: clash.sourceId } }))?.shiftId;
  if (shiftId && shiftId === r.ignoreShiftId) return null;
  const shift = shiftId ? await tx.shift.findUnique({ where: { id: shiftId } }) : null;
  const callsign = shift
    ? (await tx.vehicle.findUnique({ where: { id: shift.vehicleId } }))?.callsign
    : null;
  const times = `from ${londonTime(clash.startsAt)} to ${londonTime(clash.endsAt)}`;
  if (r.resourceType === 'VEHICLE')
    return `${callsign ?? 'That vehicle'} is already on another shift ${times}`;
  const person = await tx.staff.findUnique({ where: { id: r.resourceId } });
  const who = person?.displayName ?? 'That person';
  return `${who} is already on ${callsign ?? 'another shift'} ${times}`;
}

/**
 * E1: the highest permitted load of any vehicle in service (bariatric limit or stretcher safe
 * working load). Null when no vehicle records one, so no warning can be given.
 */
export async function highestPermittedLoad(tx: TenantTx): Promise<number | null> {
  const vehicles = await tx.vehicle.findMany({
    where: { status: { not: 'OFF_ROAD' } },
    select: { bariatricLimitKg: true },
  });
  const stretchers = await tx.equipmentAsset.findMany({
    where: {
      capability: 'STRETCHER',
      status: 'AVAILABLE',
      vehicleId: { not: null },
      swlKg: { not: null },
    },
    select: { swlKg: true },
  });
  const all = [
    ...vehicles.flatMap((v) => (v.bariatricLimitKg ? [v.bariatricLimitKg] : [])),
    ...stretchers.map((s) => Number(s.swlKg)),
  ];
  return all.length ? Math.max(...all) : null;
}

/** Future work affected by a stop-use defect on a vehicle (released for reassignment). */
export function affectedAllocations(
  tx: TenantTx,
  vehicleId: string,
  from: Date,
): Promise<string[]> {
  return releaseAllocationsForVehicle(tx, vehicleId, from, 'Vehicle blocked by a stop-use defect');
}
