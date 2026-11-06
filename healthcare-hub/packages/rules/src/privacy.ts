import { addDays, addMonths, londonDate, type ISODate } from './dates.js';

/**
 * UK GDPR timing rules (SECURITY_COMPLIANCE §4). Pure: the API and worker pass `now`.
 */

/** A subject request is answered within one calendar month of receipt (Art 12(3)). */
export const subjectRequestDue = (receivedOn: ISODate): ISODate => addMonths(receivedOn, 1);
/** It may be extended by up to two further months for complex or numerous requests. */
export const subjectRequestLatestExtension = (receivedOn: ISODate): ISODate =>
  addMonths(receivedOn, 3);

/**
 * K2: the clock pauses while proof of identity is awaited. The effective due date is the due
 * date (or the agreed extension) moved on by the days paused.
 */
export function subjectRequestEffectiveDue(
  dueOn: ISODate,
  extendedTo: ISODate | null,
  pausedDays: number,
): ISODate {
  return addDays(extendedTo ?? dueOn, Math.max(0, pausedDays));
}

/** K2: whole days between asking for identity and receiving it (never negative). */
export function identityPauseDays(requestedOn: ISODate | null, verifiedOn: ISODate): number {
  if (!requestedOn) return 0;
  return Math.max(0, utcDay(verifiedOn) - utcDay(requestedOn));
}
const utcDay = (d: ISODate) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

export interface BreachAnswerSet {
  specialCategory: boolean;
  identifiable: boolean;
  volume: 'ONE' | 'FEW' | 'MANY';
  likelyHarm: 'NONE' | 'SOME' | 'SERIOUS';
  recovered: boolean;
}

/**
 * K1: the risk the guided answers point to. A suggestion shown beside the decision: the person
 * deciding still records the risk and their reason.
 */
export function suggestBreachRisk(a: BreachAnswerSet): 'UNLIKELY' | 'RISK' | 'HIGH_RISK' {
  if (!a.identifiable) return 'UNLIKELY';
  if (a.likelyHarm === 'SERIOUS' || (a.specialCategory && a.likelyHarm !== 'NONE'))
    return 'HIGH_RISK';
  if (a.likelyHarm === 'NONE' && a.recovered && a.volume !== 'MANY') return 'UNLIKELY';
  return 'RISK';
}

export const ICO_HOURS = 72;
export type BreachClockState = 'REPORTED' | 'NOT_REPORTABLE' | 'OVERDUE' | 'DUE_SOON' | 'OPEN';

/**
 * The 72-hour ICO clock runs from discovery. Due soon in the last 24 hours; overdue afterwards
 * unless reported or assessed as not reportable.
 */
export function breachClock(b: {
  discoveredAt: Date;
  icoReportable: boolean | null;
  icoReportedAt: Date | null;
  now: Date;
}): { state: BreachClockState; deadline: Date; hoursLeft: number } {
  const deadline = new Date(b.discoveredAt.getTime() + ICO_HOURS * 3_600_000);
  const hoursLeft = Math.floor((deadline.getTime() - b.now.getTime()) / 3_600_000);
  const state: BreachClockState = b.icoReportedAt
    ? 'REPORTED'
    : b.icoReportable === false
      ? 'NOT_REPORTABLE'
      : b.now > deadline
        ? 'OVERDUE'
        : hoursLeft < 24
          ? 'DUE_SOON'
          : 'OPEN';
  return { state, deadline, hoursLeft };
}

/** Records older than this London date are past their retention period. */
export const retentionCutoff = (now: Date, retainMonths: number): ISODate =>
  addMonths(londonDate(now), -retainMonths);

export type RetentionCategory =
  | 'PATIENT_CONTACT'
  | 'JOB_RECORDS'
  | 'STAFF_HR_RECORDS'
  | 'DBS_RECORDS'
  | 'EVENT_RECORDS'
  | 'COMPLAINTS'
  | 'SAFEGUARDING'
  | 'AUDIT_RECORDS'
  | 'AUDIT_LOG';

const CONFIRM =
  'Placeholder: confirm against your approved retention schedule (e.g. NHS Records Management Code of Practice) before approving.';

/** Defaults are placeholders that require approval; nothing is acted on until approved. */
export const DEFAULT_RETENTION: readonly {
  category: RetentionCategory;
  retainMonths: number;
  triggerDesc: string;
  basis: string;
}[] = [
  { category: 'PATIENT_CONTACT', retainMonths: 96, triggerDesc: 'Journey date', basis: CONFIRM },
  { category: 'JOB_RECORDS', retainMonths: 96, triggerDesc: 'Journey date', basis: CONFIRM },
  {
    category: 'STAFF_HR_RECORDS',
    retainMonths: 72,
    triggerDesc: 'Date the person left',
    basis: CONFIRM,
  },
  {
    category: 'DBS_RECORDS',
    retainMonths: 6,
    triggerDesc: 'Date the check was recorded',
    basis: CONFIRM,
  },
  {
    category: 'EVENT_RECORDS',
    retainMonths: 120,
    triggerDesc: 'Date the event occurred',
    basis: CONFIRM,
  },
  {
    category: 'COMPLAINTS',
    retainMonths: 120,
    triggerDesc: 'Date the complaint was received',
    basis: CONFIRM,
  },
  {
    category: 'SAFEGUARDING',
    retainMonths: 300,
    triggerDesc: 'Date the concern was raised',
    basis: CONFIRM,
  },
  { category: 'AUDIT_RECORDS', retainMonths: 72, triggerDesc: 'Audit due date', basis: CONFIRM },
  {
    category: 'AUDIT_LOG',
    retainMonths: 72,
    triggerDesc: 'Date of the logged action',
    basis: CONFIRM,
  },
];
