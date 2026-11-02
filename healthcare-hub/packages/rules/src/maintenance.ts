import { compareDates, daysUntil, formatDate, isOverdue, type ISODate } from './dates.js';

export interface MaintenanceInput {
  dueDate: ISODate | null;
  /** Odometer reading at which the service falls due (last service odometer + threshold). */
  dueOdometer: number | null;
  currentOdometer: number | null;
  /** Miles before `dueOdometer` at which the item becomes "due soon". */
  dueSoonMiles?: number;
  dueSoonDays?: number;
}

export type MaintenanceState = {
  state: 'OK' | 'DUE_SOON' | 'OVERDUE';
  by: 'DATE' | 'MILEAGE' | null;
  text: string;
};

/** Mileage + date: whichever comes first (FLT-02, T12). */
export function maintenanceState(i: MaintenanceInput, now: Date): MaintenanceState {
  const soonMiles = i.dueSoonMiles ?? 500;
  const soonDays = i.dueSoonDays ?? 30;
  if (i.dueOdometer !== null && i.currentOdometer !== null && i.currentOdometer > i.dueOdometer) {
    return {
      state: 'OVERDUE',
      by: 'MILEAGE',
      text: `Service overdue by mileage (${i.currentOdometer} mi, due at ${i.dueOdometer} mi)`,
    };
  }
  if (i.dueDate && isOverdue(i.dueDate, now)) {
    return { state: 'OVERDUE', by: 'DATE', text: `Service overdue since ${formatDate(i.dueDate)}` };
  }
  if (
    i.dueOdometer !== null &&
    i.currentOdometer !== null &&
    i.dueOdometer - i.currentOdometer <= soonMiles
  ) {
    return { state: 'DUE_SOON', by: 'MILEAGE', text: `Service due within ${soonMiles} miles` };
  }
  if (i.dueDate && daysUntil(i.dueDate, now) <= soonDays) {
    return { state: 'DUE_SOON', by: 'DATE', text: `Service due ${formatDate(i.dueDate)}` };
  }
  return { state: 'OK', by: null, text: 'Service in date' };
}

/** T13: a reading lower than the previous one is flagged, not silently accepted. */
export function checkOdometer(
  previous: { reading: number; on: ISODate } | null,
  next: { reading: number; on: ISODate },
): { flags: ('ODOMETER_DECREASED' | 'ODOMETER_IMPLAUSIBLE_JUMP' | 'READING_BEFORE_PREVIOUS')[] } {
  const flags: ('ODOMETER_DECREASED' | 'ODOMETER_IMPLAUSIBLE_JUMP' | 'READING_BEFORE_PREVIOUS')[] =
    [];
  if (previous) {
    if (compareDates(next.on, previous.on) < 0) flags.push('READING_BEFORE_PREVIOUS');
    if (next.reading < previous.reading) flags.push('ODOMETER_DECREASED');
    else if (
      next.reading - previous.reading >
      2000 + 1000 * Math.max(1, Math.abs(compareDates(next.on, previous.on)))
    )
      flags.push('ODOMETER_IMPLAUSIBLE_JUMP');
  }
  return { flags };
}
