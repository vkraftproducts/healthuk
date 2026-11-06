import { addDays, compareDates, formatDate, londonDate, type ISODate } from './dates.js';
import { drivingCategoryFor } from './schedule3.js';
import type { Check } from './readiness.js';

/** D1: a vehicle needs an MOT once it is three years old (first registration date or year). */
export function motRequired(
  v: { firstRegisteredOn?: ISODate | null; year?: number | null },
  on: ISODate,
): boolean {
  if (v.firstRegisteredOn) return compareDates(addDays(v.firstRegisteredOn, 365 * 3), on) <= 0;
  // Only the year is known: assume 1 January so the MOT is never skipped too long.
  if (v.year) return Number(on.slice(0, 4)) - v.year >= 3;
  // Age unknown: treat it as needing an MOT rather than risk missing one.
  return true;
}

/** D1: the licence category the gross weight needs, in words ("Needs C1"). */
export function licenceNeededText(category: string, grossWeightKg: number | null): string {
  return `Needs ${drivingCategoryFor(category, grossWeightKg)}`;
}

/** Statutory vehicle documents, recognised from the requirement code or title. */
export type VehicleDocument = 'MOT' | 'INSURANCE' | 'TAX' | 'CONVERSION';
export function vehicleDocumentKind(codeOrTitle: string): VehicleDocument | null {
  const s = codeOrTitle.toUpperCase();
  if (/\bMOT\b/.test(s)) return 'MOT';
  if (/INSUR/.test(s)) return 'INSURANCE';
  if (/\bTAX\b|\bVED\b/.test(s)) return 'TAX';
  if (/CONVERSION/.test(s)) return 'CONVERSION';
  return null;
}

/**
 * D1/E3: a requirement check on a vehicle in the words the doc uses, e.g. "Insurance not
 * verified" or "MOT expired on 2 Nov 2026". Passing checks keep their text.
 */
export function vehicleDocumentText(
  title: string,
  check: Check,
  instance: { status: string; expiryDate: ISODate | null },
): string {
  if (check.result !== 'FAIL') return `${title}: ${check.reasonText}`;
  if (instance.status === 'GREY' || /No verified evidence/i.test(check.reasonText))
    return `${title} not verified`;
  if (/^Expires/.test(check.reasonText) && instance.expiryDate)
    return `${title} expires ${formatDate(instance.expiryDate)}, before the job ends`;
  const r = check.reasonText;
  return `${title} ${r.charAt(0).toLowerCase()}${r.slice(1)}`;
}

/** D1 header status: one word and the main reason. */
export type VehicleHeadline = 'AVAILABLE' | 'BLOCKED' | 'OFF_ROAD' | 'QUARANTINED';
export function vehicleHeadline(i: {
  offRoad: boolean;
  quarantined: boolean;
  statusReason: string | null;
  expectedReturnOn?: ISODate | null;
  failing: string[];
}): { status: VehicleHeadline; reason: string | null } {
  const back = i.expectedReturnOn ? `; expected back ${formatDate(i.expectedReturnOn)}` : '';
  if (i.offRoad) return { status: 'OFF_ROAD', reason: `${i.statusReason ?? 'Off road'}${back}` };
  if (i.quarantined) return { status: 'QUARANTINED', reason: i.statusReason ?? 'Quarantined' };
  if (i.failing.length) return { status: 'BLOCKED', reason: i.failing.join('; ') };
  return { status: 'AVAILABLE', reason: null };
}

/** D7: same receipt, or same amount and date on the same vehicle, flags a possible duplicate. */
export function expenseDuplicate(
  next: {
    vehicleId: string;
    incurredOn: ISODate;
    amountPence: number;
    receiptEvidenceId?: string | null;
  },
  existing: {
    vehicleId: string;
    incurredOn: ISODate;
    amountPence: number;
    receiptEvidenceId?: string | null;
  }[],
): boolean {
  return existing.some(
    (e) =>
      (!!next.receiptEvidenceId && e.receiptEvidenceId === next.receiptEvidenceId) ||
      (e.vehicleId === next.vehicleId &&
        e.incurredOn === next.incurredOn &&
        e.amountPence === next.amountPence),
  );
}

/** D5: a move takes effect on today or an earlier date only; future moves are not scheduled. */
export function moveDateProblem(effectiveOn: ISODate, now: Date): string | null {
  return compareDates(effectiveOn, londonDate(now)) > 0
    ? 'A move can take effect today or on an earlier date'
    : null;
}
