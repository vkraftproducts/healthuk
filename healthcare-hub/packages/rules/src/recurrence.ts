import { addDays, addMonths, compareDates, type ISODate } from './dates.js';

export type RecurrenceType =
  'FIXED_CALENDAR' | 'COMPLETION_BASED' | 'MILEAGE' | 'EVENT_TRIGGERED' | 'PER_SHIFT';
export type IntervalUnit = 'DAYS' | 'MONTHS' | 'YEARS';
export interface Interval {
  unit: IntervalUnit;
  every: number;
}

function addInterval(from: ISODate, i: Interval, times: number): ISODate {
  switch (i.unit) {
    case 'DAYS':
      return addDays(from, i.every * times);
    case 'MONTHS':
      return addMonths(from, i.every * times);
    case 'YEARS':
      return addMonths(from, i.every * 12 * times);
  }
}

/** The k-th scheduled occurrence counted from the ORIGINAL anchor (anchor day is preserved). */
export function occurrence(anchor: ISODate, interval: Interval, k: number): ISODate {
  if (!Number.isInteger(interval.every) || interval.every < 1)
    throw new RangeError('Interval must be a positive integer');
  return addInterval(anchor, interval, k);
}

/**
 * FIXED_CALENDAR: next due = the first scheduled occurrence after the previous SCHEDULED due date.
 * Completing late (or early) never shifts the timetable (T7).
 */
export function nextFixedCalendar(
  anchor: ISODate,
  interval: Interval,
  previousScheduled: ISODate,
): ISODate {
  let k = 0;
  while (compareDates(occurrence(anchor, interval, k), previousScheduled) <= 0) k += 1;
  return occurrence(anchor, interval, k);
}

/** COMPLETION_BASED: completion date + interval. */
export function nextCompletionBased(completedOn: ISODate, interval: Interval): ISODate {
  return occurrence(completedOn, interval, 1);
}

export type NextDue =
  | { kind: 'DATE'; date: ISODate }
  | { kind: 'NONE'; reason: 'EVENT_TRIGGERED' | 'PER_SHIFT' | 'MILEAGE_ONLY' };

/** Dispatch on recurrence type. MILEAGE is handled by `maintenance.ts` (whichever comes first). */
export function nextDue(input: {
  type: RecurrenceType;
  interval?: Interval;
  anchor?: ISODate;
  previousScheduled?: ISODate;
  completedOn?: ISODate;
}): NextDue {
  switch (input.type) {
    case 'FIXED_CALENDAR':
      if (!input.interval || !input.anchor || !input.previousScheduled)
        throw new TypeError('FIXED_CALENDAR needs interval, anchor and previousScheduled');
      return {
        kind: 'DATE',
        date: nextFixedCalendar(input.anchor, input.interval, input.previousScheduled),
      };
    case 'COMPLETION_BASED':
      if (!input.interval || !input.completedOn)
        throw new TypeError('COMPLETION_BASED needs interval and completedOn');
      return { kind: 'DATE', date: nextCompletionBased(input.completedOn, input.interval) };
    case 'MILEAGE':
      return { kind: 'NONE', reason: 'MILEAGE_ONLY' };
    case 'EVENT_TRIGGERED':
      return { kind: 'NONE', reason: 'EVENT_TRIGGERED' };
    case 'PER_SHIFT':
      return { kind: 'NONE', reason: 'PER_SHIFT' };
  }
}
