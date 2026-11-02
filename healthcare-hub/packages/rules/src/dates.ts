import { DateTime } from 'luxon';

/** All business dates are evaluated in this zone (ALERT-01). */
export const LONDON = 'Europe/London';

/** Date-only value, `YYYY-MM-DD`. */
export type ISODate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function utcDays(d: ISODate): number {
  assertISODate(d);
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day) / DAY_MS;
}

function fromUtcDays(n: number): ISODate {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function assertISODate(d: string): asserts d is ISODate {
  if (!ISO_DATE.test(d) || !DateTime.fromISO(d, { zone: 'utc' }).isValid) {
    throw new RangeError(`Invalid ISO date: ${d}`);
  }
}

/** Calendar date in Europe/London for an instant. */
export function londonDate(now: Date): ISODate {
  return DateTime.fromJSDate(now, { zone: LONDON }).toISODate() as ISODate;
}

/** The last instant (23:59:59.999 Europe/London) on which a date-only deadline is still satisfied. */
export function endOfLondonDay(d: ISODate): Date {
  assertISODate(d);
  return DateTime.fromISO(d, { zone: LONDON }).endOf('day').toJSDate();
}

/** First instant (00:00 Europe/London) of a date. */
export function startOfLondonDay(d: ISODate): Date {
  assertISODate(d);
  return DateTime.fromISO(d, { zone: LONDON }).startOf('day').toJSDate();
}

export function isDueToday(d: ISODate, now: Date): boolean {
  return londonDate(now) === d;
}

export function isOverdue(d: ISODate, now: Date): boolean {
  return now.getTime() > endOfLondonDay(d).getTime();
}

/** Whole calendar days from today (London) to `d`; negative once past. Never 24h blocks. */
export function daysUntil(d: ISODate, now: Date): number {
  return utcDays(d) - utcDays(londonDate(now));
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUtcDays(utcDays(d) + n);
}

/**
 * Adds calendar months, clamping the day to the month length. Callers pass the ORIGINAL anchor and
 * the total months so 31 Jan + 2 months is 31 Mar, not 28 Feb + 1 month (RULES_ENGINE §1).
 */
export function addMonths(anchor: ISODate, months: number): ISODate {
  assertISODate(anchor);
  const [y, m, day] = anchor.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const dd = Math.min(day, last);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return utcDays(a) - utcDays(b);
}

/** Human date such as "12 Nov 2026" (en-GB). */
export function formatDate(d: ISODate): string {
  assertISODate(d);
  return DateTime.fromISO(d, { zone: 'utc' }).setLocale('en-GB').toFormat('d LLL yyyy');
}

/**
 * Valid for a job only if `validFrom <= plannedStart` and `plannedEnd <= endOfLondonDay(expiry)`
 * (RULES_ENGINE §1). Either bound may be absent.
 */
export function validAcrossWindow(
  clearance: { validFrom?: ISODate | null; expiryDate?: ISODate | null },
  window: { start: Date; end: Date },
): { ok: true } | { ok: false; reason: 'NOT_YET_VALID' | 'EXPIRES_DURING_WINDOW' } {
  if (
    clearance.validFrom &&
    window.start.getTime() < startOfLondonDay(clearance.validFrom).getTime()
  ) {
    return { ok: false, reason: 'NOT_YET_VALID' };
  }
  if (
    clearance.expiryDate &&
    window.end.getTime() > endOfLondonDay(clearance.expiryDate).getTime()
  ) {
    return { ok: false, reason: 'EXPIRES_DURING_WINDOW' };
  }
  return { ok: true };
}

/** An instant from a London wall-clock date and time (`HH:mm`), DST-aware. */
export function londonDateTime(d: ISODate, hhmm: string): Date {
  assertISODate(d);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) throw new RangeError(`Invalid time: ${hhmm}`);
  return DateTime.fromISO(`${d}T${hhmm}`, { zone: LONDON }).toJSDate();
}

/** `HH:mm` on the London clock for an instant. */
export function londonTime(at: Date): string {
  return DateTime.fromJSDate(at, { zone: LONDON }).toFormat('HH:mm');
}
