import { endOfLondonDay, formatDate, validAcrossWindow, type ISODate } from './dates.js';
import type { Effect, RequirementResult } from './status.js';

export type CheckResult = 'PASS' | 'FAIL' | 'PENDING';
/** Groups map readiness checks onto the allocation-validation rows (RULES_ENGINE §4). */
export type CheckGroup =
  'CLEARANCE' | 'LICENCE' | 'COMPETENCE' | 'ROADWORTHY' | 'EQUIPMENT' | 'SUITABILITY';

export interface Check {
  code: string;
  group: CheckGroup;
  result: CheckResult;
  reasonText: string;
  /** Only policy-level failures can ever be excepted; statutory/safety-critical never can. */
  overridable: boolean;
  requirementInstanceId?: string;
}

export type ReadinessState = 'READY' | 'BLOCKED' | 'RESTRICTED';
export interface Readiness {
  state: ReadinessState;
  checks: Check[];
}

export interface Window {
  start: Date;
  end: Date;
}

export interface RequirementEntry {
  instanceId?: string;
  code: string;
  group: CheckGroup;
  result: RequirementResult;
  validFrom?: ISODate | null;
  /** Expiry of the CURRENT verified evidence (not of a pending renewal). */
  expiryDate?: ISODate | null;
}

/** Turns one evaluated requirement into a check, across the whole job window (T8/T9/T10/T11). */
export function requirementCheck(entry: RequirementEntry, window: Window): Check {
  const { result } = entry;
  const common = {
    code: entry.code,
    group: entry.group,
    ...(entry.instanceId ? { requirementInstanceId: entry.instanceId } : {}),
  };
  const overridable = result.effect === 'POLICY_BLOCK';
  switch (result.status) {
    case 'NOT_APPLICABLE':
      return { ...common, result: 'PASS', reasonText: result.reasonText, overridable: false };
    case 'RED':
      return failIfBlocking(common, result.effect, result.reasonText);
    case 'GREY':
      return failIfBlocking(common, result.effect, result.reasonText);
    case 'AMBER':
    case 'GREEN': {
      const v = validAcrossWindow(
        { validFrom: entry.validFrom, expiryDate: entry.expiryDate },
        window,
      );
      if (v.ok)
        return { ...common, result: 'PASS', reasonText: result.reasonText, overridable: false };
      return {
        ...common,
        result: 'FAIL',
        overridable,
        reasonText:
          v.reason === 'EXPIRES_DURING_WINDOW'
            ? `Expires ${formatDate(entry.expiryDate as ISODate)} (until ${endOfLondonDay(entry.expiryDate as ISODate).toISOString()}) before the job ends`
            : 'Not yet valid at the job start',
      };
    }
  }
}

function failIfBlocking(
  common: Pick<Check, 'code' | 'group' | 'requirementInstanceId'>,
  effect: Effect,
  reasonText: string,
): Check {
  if (effect === 'NONE') return { ...common, result: 'PENDING', reasonText, overridable: false };
  return { ...common, result: 'FAIL', reasonText, overridable: effect === 'POLICY_BLOCK' };
}

/**
 * READY: every check passes (non-blocking PENDING is allowed).
 * BLOCKED: any failure that cannot be excepted.
 * RESTRICTED: only exceptable failures (policy) or declared restrictions remain.
 */
export function summariseReadiness(
  checks: readonly Check[],
  opts: { restrictions?: readonly string[] } = {},
): Readiness {
  const fails = checks.filter((c) => c.result === 'FAIL');
  let state: ReadinessState = 'READY';
  if (fails.some((c) => !c.overridable)) state = 'BLOCKED';
  else if (fails.length > 0 || (opts.restrictions?.length ?? 0) > 0) state = 'RESTRICTED';
  return { state, checks: [...checks] };
}

const pass = (code: string, group: CheckGroup, text: string): Check => ({
  code,
  group,
  result: 'PASS',
  reasonText: text,
  overridable: false,
});
const fail = (code: string, group: CheckGroup, text: string, overridable = false): Check => ({
  code,
  group,
  result: 'FAIL',
  reasonText: text,
  overridable,
});

export interface StaffInput {
  lifecycle: 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED' | 'LEAVER';
  roleApproved: boolean;
  /** Required for driving jobs: whether the licence category covers the vehicle. */
  licenceCategoryCovers: boolean | null;
  requirements: RequirementEntry[];
  /** Skills the job needs that the person does not hold validly. */
  missingCompetencies: string[];
  restrictions?: string[];
}

export function staffReadiness(input: StaffInput, window: Window): Readiness {
  const checks: Check[] = [];
  checks.push(
    input.lifecycle === 'ACTIVE'
      ? pass('LIFECYCLE', 'CLEARANCE', 'Active')
      : fail('LIFECYCLE', 'CLEARANCE', `Staff member is ${input.lifecycle.toLowerCase()}`),
  );
  checks.push(
    input.roleApproved
      ? pass('ROLE_APPROVED', 'CLEARANCE', 'Approved for the role')
      : fail('ROLE_APPROVED', 'CLEARANCE', 'Not approved for the required role'),
  );
  if (input.licenceCategoryCovers !== null) {
    checks.push(
      input.licenceCategoryCovers
        ? pass('LICENCE_CATEGORY', 'LICENCE', 'Licence category covers the vehicle')
        : fail('LICENCE_CATEGORY', 'LICENCE', 'Licence category does not cover the vehicle'),
    );
  }
  for (const e of input.requirements) checks.push(requirementCheck(e, window));
  for (const c of input.missingCompetencies)
    checks.push(fail(`COMPETENCE_${c}`, 'COMPETENCE', `Missing or expired competence: ${c}`, true));
  return summariseReadiness(checks, { restrictions: input.restrictions ?? [] });
}

export interface VehicleInput {
  quarantined: boolean;
  openCriticalDefect: boolean;
  maintenanceOverdue: boolean;
  requirements: RequirementEntry[];
}

export function vehicleReadiness(input: VehicleInput, window: Window): Readiness {
  const checks: Check[] = [];
  checks.push(
    input.openCriticalDefect
      ? fail('CRITICAL_DEFECT', 'ROADWORTHY', 'Open critical or stop-use defect')
      : pass('CRITICAL_DEFECT', 'ROADWORTHY', 'No critical defect'),
  );
  checks.push(
    input.quarantined
      ? fail('QUARANTINE', 'ROADWORTHY', 'Vehicle is quarantined')
      : pass('QUARANTINE', 'ROADWORTHY', 'Not quarantined'),
  );
  checks.push(
    input.maintenanceOverdue
      ? fail('MAINTENANCE', 'ROADWORTHY', 'Maintenance overdue by date or mileage')
      : pass('MAINTENANCE', 'ROADWORTHY', 'Maintenance in date'),
  );
  for (const e of input.requirements) checks.push(requirementCheck(e, window));
  return summariseReadiness(checks);
}

export interface EquipmentInput {
  quarantined: boolean;
  /** Each applicable regime (LOLER, servicing, calibration) is a separate requirement; no blanket expiry. */
  requirements: RequirementEntry[];
}

export function equipmentReadiness(input: EquipmentInput, window: Window): Readiness {
  const checks: Check[] = [
    input.quarantined
      ? fail('QUARANTINE', 'EQUIPMENT', 'Equipment is quarantined')
      : pass('QUARANTINE', 'EQUIPMENT', 'Not quarantined'),
  ];
  for (const e of input.requirements) checks.push(requirementCheck(e, window));
  return summariseReadiness(checks);
}
