import type { Check, Readiness } from './readiness.js';

export interface ShiftGateInput {
  shiftVehicleId: string;
  /** Latest VDI for this shift; null if none submitted. */
  vdi: { vehicleId: string; shiftId: string; failedCritical: boolean } | null;
  shiftId: string;
  cleaningConfirmed: { vehicleId: string; shiftId: string } | null;
  staffReadiness: Readiness;
}

export interface ShiftGateResult {
  canStart: boolean;
  checks: Pick<Check, 'code' | 'result' | 'reasonText'>[];
}

/** FLT-04/FLT-05, UAT-03. A vehicle swap needs a new VDI + cleaning for the replacement. */
export function evaluateShiftGate(i: ShiftGateInput): ShiftGateResult {
  const vdiOk =
    i.vdi !== null && i.vdi.vehicleId === i.shiftVehicleId && i.vdi.shiftId === i.shiftId;
  const checks: ShiftGateResult['checks'] = [
    vdiOk
      ? i.vdi!.failedCritical
        ? { code: 'VDI', result: 'FAIL', reasonText: 'VDI has a failed critical item' }
        : { code: 'VDI', result: 'PASS', reasonText: 'VDI submitted with no critical failure' }
      : {
          code: 'VDI',
          result: 'PENDING',
          reasonText: 'VDI for this vehicle and shift has not been submitted',
        },
  ];
  const cleanOk =
    i.cleaningConfirmed !== null &&
    i.cleaningConfirmed.vehicleId === i.shiftVehicleId &&
    i.cleaningConfirmed.shiftId === i.shiftId;
  checks.push(
    cleanOk
      ? { code: 'CLEANING', result: 'PASS', reasonText: 'Pre-shift cleaning confirmed' }
      : {
          code: 'CLEANING',
          result: 'PENDING',
          reasonText: 'Pre-shift cleaning not confirmed for this vehicle and shift',
        },
  );
  checks.push(
    i.staffReadiness.state === 'READY'
      ? { code: 'STAFF_READY', result: 'PASS', reasonText: 'Staff readiness re-validated' }
      : {
          code: 'STAFF_READY',
          result: 'FAIL',
          reasonText: `Staff readiness is ${i.staffReadiness.state.toLowerCase()}`,
        },
  );
  return { canStart: checks.every((c) => c.result === 'PASS'), checks };
}
