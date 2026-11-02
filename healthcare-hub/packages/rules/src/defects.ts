export type DefectSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';

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
