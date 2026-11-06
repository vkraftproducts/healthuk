import type { Check, CheckGroup, Readiness } from './readiness.js';

export type AllocationCode =
  | 'STAFF_CLEARANCE'
  | 'LICENCE'
  | 'COMPETENCE'
  | 'VEHICLE_ROADWORTHY'
  | 'VEHICLE_SUITABILITY'
  | 'EQUIPMENT'
  | 'TIME_CONFLICT'
  | 'SHIFT_GATE';

export interface AllocationCheck {
  code: AllocationCode;
  result: 'PASS' | 'FAIL' | 'PENDING';
  reasonText: string;
  /** True only where a named-approver policy exception is possible at all. */
  overridable: boolean;
  /** An approved, unexpired exception covers this failure. */
  excepted: boolean;
  details: string[];
  /** E3: how to put a failing check right, and which screen does it. */
  fix?: { text: string; action: FixAction } | null;
}

export type FixAction = 'SHIFT_ACTIONS' | 'STAFF' | 'VEHICLE' | 'EXCEPTION';

export interface PolicyException {
  code: AllocationCode;
  approvedBy: string;
  reason: string;
  expiresAt: Date;
}

export interface Capacity {
  seats: number;
  wheelchairs: number;
  stretchers: number;
  maxLoadKg: number;
  /** D1: false refuses blue-light jobs; undefined leaves them unchecked. */
  blueLightAuthorised?: boolean;
  /** E1: the vehicle's recorded bariatric limit; bariatric jobs need one. */
  bariatricLimitKg?: number | null;
}

export interface AllocationInput {
  now: Date;
  job: {
    start: Date;
    seatsNeeded: number;
    wheelchairsNeeded: number;
    stretchersNeeded: number;
    loadKg: number;
    requiredEquipment: string[];
    blueLights?: boolean;
    bariatric?: boolean;
  };
  /** `name` labels the person in check details; without it the details carry the reason only. */
  staff: { id: string; name?: string; readiness: Readiness }[];
  vehicle: {
    id: string;
    readiness: Readiness;
    capacity: Capacity;
    equipmentPresent: string[];
    quarantinedEquipment: string[];
    expiredEquipment: string[];
  };
  /**
   * Overlaps already computed by the data layer (incl. travel buffer and breaks). `text` is the
   * plain sentence naming the person or vehicle and the times, shown in place of the ids.
   */
  conflicts: {
    resourceType: 'STAFF' | 'VEHICLE';
    resourceId: string;
    otherJobId: string;
    text?: string;
  }[];
  shiftGate: {
    vdi: 'PASS' | 'FAIL' | 'PENDING';
    cleaning: 'CONFIRMED' | 'NOT_CONFIRMED';
    shiftStart: Date;
    /** False while the crew have not started the shift: the gate is checked at start. */
    started?: boolean;
  } | null;
  exceptions?: PolicyException[];
}

export interface AllocationResult {
  /** Ordered exactly as the wireframe-04 "Validate assignment" table. */
  checks: AllocationCheck[];
  allowed: boolean;
  /** Failures with no exception in place, split so the UI can offer the exception flow only where one exists. */
  blockers: AllocationCode[];
  exceptable: AllocationCode[];
}

type LabelledCheck = Check & { who?: string };

function fromGroup(
  code: AllocationCode,
  group: CheckGroup,
  checks: readonly LabelledCheck[],
  okText: string,
): {
  code: AllocationCode;
  result: AllocationCheck['result'];
  reasonText: string;
  overridable: boolean;
  details: string[];
} {
  const rel = checks.filter((c) => c.group === group);
  const failing = rel.filter((c) => c.result === 'FAIL');
  if (failing.length === 0)
    return { code, result: 'PASS', reasonText: okText, overridable: false, details: [] };
  return {
    code,
    result: 'FAIL',
    reasonText: failing[0]!.reasonText,
    // Overridable only if EVERY failing check is policy-level.
    overridable: failing.every((c) => c.overridable),
    // Plain words only: a person's name where known, never internal ids or check codes.
    details: failing.map((c) => (c.who ? `${c.who}: ${c.reasonText}` : c.reasonText)),
  };
}

export function validateAllocation(i: AllocationInput): AllocationResult {
  const staffChecks: LabelledCheck[] = i.staff.flatMap((s) =>
    s.readiness.checks.map((c) => ({ ...c, code: `${s.id}:${c.code}`, who: s.name })),
  );
  const vehicleChecks = i.vehicle.readiness.checks;
  const raw: ReturnType<typeof fromGroup>[] = [];

  raw.push(
    fromGroup(
      'STAFF_CLEARANCE',
      'CLEARANCE',
      staffChecks,
      'All crew cleared for their role across the job window',
    ),
  );
  raw.push(
    fromGroup(
      'LICENCE',
      'LICENCE',
      staffChecks,
      'Driver licence valid and category correct across the job window',
    ),
  );
  // Competence is the one group a policy exception can cover (and only if the requirement's blocking is POLICY).
  raw.push(
    fromGroup('COMPETENCE', 'COMPETENCE', staffChecks, 'Required competencies present and valid'),
  );
  raw.push(
    fromGroup(
      'VEHICLE_ROADWORTHY',
      'ROADWORTHY',
      vehicleChecks,
      'No critical defect; insurance, tax and MOT valid',
    ),
  );

  const cap = i.vehicle.capacity;
  const unsuitable: string[] = [];
  if (i.job.seatsNeeded > cap.seats)
    unsuitable.push(`needs ${i.job.seatsNeeded} seats, vehicle has ${cap.seats}`);
  if (i.job.wheelchairsNeeded > cap.wheelchairs)
    unsuitable.push(
      `needs ${i.job.wheelchairsNeeded} wheelchair places, vehicle has ${cap.wheelchairs}`,
    );
  // D3: capability counts only in-date, non-quarantined equipment, so say so plainly.
  const plain: string[] = [];
  if (i.job.stretchersNeeded > cap.stretchers) {
    if (cap.stretchers === 0) plain.push('No in-date stretcher on this vehicle');
    unsuitable.push(
      `needs ${i.job.stretchersNeeded} stretcher places, vehicle has ${cap.stretchers}`,
    );
  }
  if (i.job.bariatric && !cap.bariatricLimitKg) {
    plain.push('Vehicle has no bariatric limit recorded');
    unsuitable.push('not set up for bariatric patients');
  }
  if (i.job.loadKg > cap.maxLoadKg)
    unsuitable.push(`load ${i.job.loadKg} kg exceeds permitted ${cap.maxLoadKg} kg`);
  if (i.job.blueLights && cap.blueLightAuthorised === false) {
    plain.push('Vehicle is not authorised for blue-light driving');
    unsuitable.push('not authorised for blue-light driving');
  }
  raw.push(
    unsuitable.length === 0
      ? {
          code: 'VEHICLE_SUITABILITY',
          result: 'PASS',
          reasonText: 'Vehicle fits the job',
          overridable: false,
          details: [],
        }
      : {
          code: 'VEHICLE_SUITABILITY',
          result: 'FAIL',
          reasonText: plain[0] ?? `Vehicle unsuitable: ${unsuitable[0]}`,
          overridable: false,
          details: unsuitable,
        },
  );

  const equipProblems: string[] = [];
  for (const e of i.job.requiredEquipment) {
    const problem = !i.vehicle.equipmentPresent.includes(e)
      ? 'missing'
      : i.vehicle.quarantinedEquipment.includes(e)
        ? 'quarantined'
        : i.vehicle.expiredEquipment.includes(e)
          ? 'out of date'
          : null;
    if (problem) {
      equipProblems.push(`${e} ${problem}`);
    }
  }
  const equipChecks = vehicleChecks.filter((c) => c.group === 'EQUIPMENT' && c.result === 'FAIL');
  for (const c of equipChecks) equipProblems.push(c.reasonText);
  raw.push(
    equipProblems.length === 0
      ? {
          code: 'EQUIPMENT',
          result: 'PASS',
          reasonText: 'Required equipment present, in date and not quarantined',
          overridable: false,
          details: [],
        }
      : // Only non-safety-critical gaps could ever be excepted by policy; safety-critical never.
        {
          code: 'EQUIPMENT',
          result: 'FAIL',
          reasonText: `Equipment: ${equipProblems[0]}`,
          overridable: false,
          details: equipProblems,
        },
  );

  raw.push(
    i.conflicts.length === 0
      ? {
          code: 'TIME_CONFLICT',
          result: 'PASS',
          reasonText: 'No overlap for vehicle or crew',
          overridable: false,
          details: [],
        }
      : {
          code: 'TIME_CONFLICT',
          result: 'FAIL',
          reasonText: i.conflicts[0]!.text ?? 'Overlaps another booking',
          overridable: false,
          details: i.conflicts.map(
            (c) => c.text ?? `${c.resourceType} ${c.resourceId} already on job ${c.otherJobId}`,
          ),
        },
  );

  if (i.shiftGate === null) {
    raw.push({
      code: 'SHIFT_GATE',
      result: 'PENDING',
      reasonText: 'No shift context yet',
      overridable: false,
      details: [],
    });
  } else if (i.shiftGate.vdi === 'FAIL') {
    raw.push({
      code: 'SHIFT_GATE',
      result: 'FAIL',
      reasonText: 'VDI has a failed critical item',
      overridable: false,
      details: [],
    });
  } else if (i.shiftGate.vdi === 'PASS' && i.shiftGate.cleaning === 'CONFIRMED') {
    raw.push({
      code: 'SHIFT_GATE',
      result: 'PASS',
      reasonText: 'VDI passed and cleaning confirmed',
      overridable: false,
      details: [],
    });
  } else if (i.shiftGate.shiftStart.getTime() > i.now.getTime()) {
    // Pending before shift start is allowed for future allocation.
    raw.push({
      code: 'SHIFT_GATE',
      result: 'PENDING',
      reasonText: 'VDI and cleaning are not due until the shift starts',
      overridable: false,
      details: [],
    });
  } else if (i.shiftGate.started === false) {
    // Finding 71 (6 Nov 2026, pending product owner sign-off): past the start time a shift the
    // crew have not started fails the gate; it is only pending before the start time.
    raw.push({
      code: 'SHIFT_GATE',
      result: 'FAIL',
      reasonText: 'Shift has not been started',
      overridable: false,
      details: [],
    });
  } else {
    raw.push({
      code: 'SHIFT_GATE',
      result: 'FAIL',
      reasonText: 'Shift has started without a passed VDI and confirmed cleaning',
      overridable: false,
      details: [],
    });
  }

  const checks: AllocationCheck[] = raw.map((c) => {
    const ex = (i.exceptions ?? []).find(
      (e) =>
        e.code === c.code &&
        e.approvedBy !== '' &&
        e.reason !== '' &&
        e.expiresAt.getTime() > i.now.getTime(),
    );
    const excepted = c.result === 'FAIL' && c.overridable && !!ex;
    return {
      ...c,
      excepted,
      fix: c.result === 'FAIL' && !excepted ? fixFor(c.code, c.overridable, staffChecks) : null,
    };
  });

  const blockers = checks.filter((c) => c.result === 'FAIL' && !c.overridable).map((c) => c.code);
  const exceptable = checks
    .filter((c) => c.result === 'FAIL' && c.overridable && !c.excepted)
    .map((c) => c.code);
  return {
    checks,
    allowed: blockers.length === 0 && exceptable.length === 0,
    blockers,
    exceptable,
  };
}

/** E3: the next step for a failing check, in words, with the screen that does it. */
function fixFor(
  code: AllocationCode,
  overridable: boolean,
  staffChecks: readonly LabelledCheck[],
): { text: string; action: FixAction } {
  const failing = (suffix: string) =>
    staffChecks.some((c) => c.result === 'FAIL' && c.code.endsWith(`:${suffix}`));
  switch (code) {
    case 'STAFF_CLEARANCE':
      if (failing('CREW_SIZE'))
        return { text: 'Add a second crew member to this shift', action: 'SHIFT_ACTIONS' };
      if (failing('NO_DRIVER'))
        return { text: 'Add an approved driver to this shift', action: 'SHIFT_ACTIONS' };
      return {
        text: 'Clear the person on their staff record, or swap them off this shift',
        action: 'STAFF',
      };
    case 'LICENCE':
      return {
        text: 'Verify the driver’s licence, or put a driver with the right licence on this shift',
        action: 'SHIFT_ACTIONS',
      };
    case 'COMPETENCE':
      return overridable
        ? { text: 'Add a crew member who holds it, or request an exception', action: 'EXCEPTION' }
        : { text: 'Add a crew member who holds the competence', action: 'SHIFT_ACTIONS' };
    case 'VEHICLE_ROADWORTHY':
      return { text: 'Put the vehicle right, or change the shift’s vehicle', action: 'VEHICLE' };
    case 'VEHICLE_SUITABILITY':
      return {
        text: 'Change the shift’s vehicle to one that fits this job',
        action: 'SHIFT_ACTIONS',
      };
    case 'EQUIPMENT':
      return { text: 'Fit in-date equipment, or change the shift’s vehicle', action: 'VEHICLE' };
    case 'TIME_CONFLICT':
      return { text: 'Choose another shift, or move the other job', action: 'SHIFT_ACTIONS' };
    case 'SHIFT_GATE':
      return {
        text: 'The crew must pass the vehicle check, confirm cleaning and start the shift',
        action: 'SHIFT_ACTIONS',
      };
  }
}

/** Can anyone be offered an exception for this check at all? (JOB-03: never for statutory/safety-critical.) */
export function exceptionAvailable(check: AllocationCheck): boolean {
  return check.result === 'FAIL' && check.overridable;
}
