import {
  addDays,
  compareDates,
  daysUntil,
  formatDate,
  isOverdue,
  londonDate,
  type ISODate,
} from './dates.js';

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

export interface FirstLimit {
  /** Which limit is expected to be reached first; null when there is not enough to say. */
  first: 'DATE' | 'MILEAGE' | null;
  /** Average miles a day over the readings used; null with fewer than two readings. */
  milesPerDay: number | null;
  /** When the mileage limit is expected to be reached at that rate. */
  mileageDueOn: ISODate | null;
  text: string;
}

/**
 * D2: which limit of a date-and-mileage plan comes first, from recent readings (newest first or
 * in any order). Uses readings from the last `lookbackDays` only so an old pattern does not count.
 */
export function firstLimit(
  i: {
    dueDate: ISODate | null;
    dueOdometer: number | null;
    readings: { reading: number; on: ISODate }[];
    lookbackDays?: number;
  },
  now: Date,
): FirstLimit {
  const today = londonDate(now);
  const lookback = i.lookbackDays ?? 90;
  const recent = i.readings
    .filter((r) => compareDates(today, r.on) <= lookback)
    .sort((a, b) => compareDates(a.on, b.on));
  const oldest = recent[0];
  const newest = recent[recent.length - 1];
  const days = oldest && newest ? compareDates(newest.on, oldest.on) : 0;
  const milesPerDay =
    oldest && newest && days > 0 && newest.reading >= oldest.reading
      ? (newest.reading - oldest.reading) / days
      : null;
  if (i.dueOdometer === null)
    return i.dueDate
      ? { first: 'DATE', milesPerDay, mileageDueOn: null, text: 'Date limit only' }
      : { first: null, milesPerDay, mileageDueOn: null, text: 'No limit set' };
  if (!newest || milesPerDay === null || milesPerDay <= 0)
    return {
      first: i.dueDate ? null : 'MILEAGE',
      milesPerDay,
      mileageDueOn: null,
      text: i.dueDate
        ? 'Not enough recent readings to say which limit comes first'
        : 'Mileage limit only',
    };
  const left = Math.max(0, i.dueOdometer - newest.reading);
  const mileageDueOn = addDays(newest.on, Math.ceil(left / milesPerDay));
  const rate = `${Math.round(milesPerDay)} miles a day`;
  if (!i.dueDate || compareDates(mileageDueOn, i.dueDate) < 0)
    return {
      first: 'MILEAGE',
      milesPerDay,
      mileageDueOn,
      text: `Mileage limit likely first, around ${formatDate(mileageDueOn)} at ${rate}`,
    };
  return {
    first: 'DATE',
    milesPerDay,
    mileageDueOn,
    text: `Date limit first (${formatDate(i.dueDate)}); mileage at ${rate} reaches it later`,
  };
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
