import { daysUntil, type ISODate } from './dates.js';

export type DefectSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export type DefectStatus = 'OPEN' | 'REPAIRING' | 'REPAIRED' | 'RELEASED';

export interface DefectEffects {
  blockVehicle: boolean;
  /** Future allocation ids that must move to NEEDS_REASSIGNMENT (FLT-06, T14). */
  reassign: string[];
  alertControl: boolean;
  /** Minor defects need a named classifier and a repair deadline before they can be accepted. */
  needsClassification: boolean;
}

export function defectEffects(
  defect: {
    severity: DefectSeverity;
    stopUse: boolean;
    classifiedBy?: string | null;
    repairDeadline?: string | null;
  },
  futureAllocationIds: readonly string[],
): DefectEffects {
  const stop = defect.severity === 'CRITICAL' || defect.stopUse;
  return {
    blockVehicle: stop,
    reassign: stop ? [...futureAllocationIds] : [],
    alertControl: stop,
    needsClassification:
      !stop && defect.severity === 'MINOR' && (!defect.classifiedBy || !defect.repairDeadline),
  };
}

/** Repair complete is not return to service: release needs the permission AND a finished repair (FLT-06). */
export function canReleaseVehicle(i: {
  repairCompleted: boolean;
  hasReturnToServicePermission: boolean;
  openStopUseDefects: number;
}): { ok: boolean; reason: string | null } {
  if (!i.hasReturnToServicePermission)
    return { ok: false, reason: 'Return to service needs the fleet return-to-service permission' };
  if (!i.repairCompleted) return { ok: false, reason: 'Repair is not complete' };
  if (i.openStopUseDefects > 0) return { ok: false, reason: 'Other stop-use defects remain open' };
  return { ok: true, reason: null };
}

export type RepairDueState = 'NONE' | 'DUE' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'DONE';

/**
 * Where a defect stands against its repair deadline (date-only, Europe/London, ALERT-01).
 * Once the repair is signed off the deadline no longer applies; release is tracked separately.
 */
export function repairDueState(
  d: { status: DefectStatus; repairDeadline: ISODate | null },
  now: Date,
  soonDays = 7,
): { state: RepairDueState; daysLeft: number | null } {
  if (d.status === 'REPAIRED' || d.status === 'RELEASED') return { state: 'DONE', daysLeft: null };
  if (!d.repairDeadline) return { state: 'NONE', daysLeft: null };
  const daysLeft = daysUntil(d.repairDeadline, now);
  const state =
    daysLeft < 0
      ? 'OVERDUE'
      : daysLeft === 0
        ? 'DUE_TODAY'
        : daysLeft <= soonDays
          ? 'DUE_SOON'
          : 'DUE';
  return { state, daysLeft };
}
