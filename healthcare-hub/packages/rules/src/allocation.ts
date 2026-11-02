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
}

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
  };
  staff: { id: string; readiness: Readiness }[];
  vehicle: {
    id: string;
    readiness: Readiness;
    capacity: Capacity;
    equipmentPresent: string[];
    quarantinedEquipment: string[];
    expiredEquipment: string[];
  };
  /** Overlaps already computed by the data layer (incl. travel buffer and breaks). */
  conflicts: { resourceType: 'STAFF' | 'VEHICLE'; resourceId: string; otherJobId: string }[];
  shiftGate: {
    vdi: 'PASS' | 'FAIL' | 'PENDING';
    cleaning: 'CONFIRMED' | 'NOT_CONFIRMED';
    shiftStart: Date;
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

function fromGroup(
  code: AllocationCode,
  group: CheckGroup,
  checks: readonly Check[],
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
    details: failing.map((c) => `${c.code}: ${c.reasonText}`),
  };
}

export function validateAllocation(i: AllocationInput): AllocationResult {
  const staffChecks = i.staff.flatMap((s) =>
    s.readiness.checks.map((c) => ({ ...c, code: `${s.id}:${c.code}` })),
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
  if (i.job.stretchersNeeded > cap.stretchers)
    unsuitable.push(
      `needs ${i.job.stretchersNeeded} stretcher places, vehicle has ${cap.stretchers}`,
    );
  if (i.job.loadKg > cap.maxLoadKg)
    unsuitable.push(`load ${i.job.loadKg} kg exceeds permitted ${cap.maxLoadKg} kg`);
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
          reasonText: `Vehicle unsuitable: ${unsuitable[0]}`,
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
          reasonText: 'Overlaps another booking',
          overridable: false,
          details: i.conflicts.map(
            (c) => `${c.resourceType} ${c.resourceId} already on job ${c.otherJobId}`,
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
    return { ...c, excepted: c.result === 'FAIL' && c.overridable && !!ex };
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

/** Can anyone be offered an exception for this check at all? (JOB-03: never for statutory/safety-critical.) */
export function exceptionAvailable(check: AllocationCheck): boolean {
  return check.result === 'FAIL' && check.overridable;
}
