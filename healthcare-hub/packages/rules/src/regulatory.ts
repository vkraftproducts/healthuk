import { addDays, addMonths, compareDates, formatDate, type ISODate } from './dates.js';

/**
 * Registration-related duties the hub can track but never decide: displaying the rating CQC
 * published (reg 20A), directors' fit and proper person checks (reg 5) and drafting statutory
 * notifications (regs 16 and 18). Pure: the caller passes what the hub holds. Nothing here works
 * out, predicts or claims a CQC rating.
 */
export type RegState = 'GREEN' | 'AMBER' | 'RED' | 'GREY' | 'NOT_APPLICABLE';
export interface RegStatus {
  status: RegState;
  reasonText: string;
}

// ---- Rating display (reg 20A) ----------------------------------------------------------------
export const RATING_DISPLAY_DAYS = 21;
export const ratingDisplayDue = (publishedOn: ISODate): ISODate =>
  addDays(publishedOn, RATING_DISPLAY_DAYS);

export function ratingDisplayState(
  r: {
    publishedOn: ISODate;
    displayedPremisesOn: ISODate | null;
    displayedWebsiteOn: ISODate | null;
    noWebsite: boolean;
  },
  today: ISODate,
): RegStatus {
  const due = ratingDisplayDue(r.publishedOn);
  const missing: string[] = [];
  if (!r.displayedPremisesOn) missing.push('at the premises');
  if (!r.noWebsite && !r.displayedWebsiteOn) missing.push('on the website');
  if (missing.length === 0) return { status: 'GREEN', reasonText: 'Displayed where required' };
  const where = missing.join(' and ');
  if (compareDates(today, due) > 0)
    return { status: 'RED', reasonText: `Not displayed ${where} – was due ${formatDate(due)}` };
  return { status: 'AMBER', reasonText: `Display ${where} by ${formatDate(due)}` };
}

// ---- Directors' fit and proper person checks (reg 5) -----------------------------------------
export const FPP_ITEMS = [
  'IDENTITY',
  'DBS',
  'BANKRUPTCY_INSOLVENCY',
  'DISQUALIFIED_DIRECTORS',
  'EMPLOYMENT_HISTORY',
  'REFERENCES',
  'QUALIFICATIONS',
  'HEALTH_DECLARATION',
  'SERIOUS_MISCONDUCT',
] as const;
export type FppItem = (typeof FPP_ITEMS)[number];
export const FPP_ITEM_TEXT: Record<FppItem, string> = {
  IDENTITY: 'Proof of identity',
  DBS: 'DBS check at the right level',
  BANKRUPTCY_INSOLVENCY: 'Bankruptcy and insolvency search',
  DISQUALIFIED_DIRECTORS: 'Disqualified directors search',
  EMPLOYMENT_HISTORY: 'Full employment history, gaps explained',
  REFERENCES: 'References, including the last employer',
  QUALIFICATIONS: 'Qualifications and professional registration',
  HEALTH_DECLARATION: 'Health declaration (able to do the role)',
  SERIOUS_MISCONDUCT: 'No serious misconduct or mismanagement found',
};
export const FPP_REVIEW_MONTHS = 12;
export const FPP_DUE_SOON_DAYS = 30;
export const fppNextReviewDue = (checkedOn: ISODate): ISODate =>
  addMonths(checkedOn, FPP_REVIEW_MONTHS);

export interface FppCheckInput {
  checkedOn: ISODate;
  items: { item: string; done: boolean }[];
  declarationOn: ISODate | null;
  outcome: 'FIT' | 'NOT_FIT' | 'FURTHER_REVIEW';
  nextReviewDue: ISODate;
}

/** Items in FPP_ITEMS not marked done on this check. */
export function fppOutstanding(items: { item: string; done: boolean }[]): FppItem[] {
  return FPP_ITEMS.filter((k) => !items.some((i) => i.item === k && i.done));
}

/** The state of a director's latest check (null means none recorded). */
export function fppState(latest: FppCheckInput | null, today: ISODate): RegStatus {
  if (!latest) return { status: 'RED', reasonText: 'No fit and proper check recorded' };
  if (latest.outcome === 'NOT_FIT')
    return { status: 'RED', reasonText: 'Latest check found the person not fit and proper' };
  if (latest.outcome === 'FURTHER_REVIEW')
    return { status: 'AMBER', reasonText: 'Latest check needs further review' };
  const outstanding = fppOutstanding(latest.items);
  if (outstanding.length)
    return {
      status: 'AMBER',
      reasonText: `${outstanding.length} check item(s) not done: ${outstanding
        .map((k) => FPP_ITEM_TEXT[k])
        .join(', ')}`,
    };
  if (!latest.declarationOn) return { status: 'AMBER', reasonText: 'Self-declaration not signed' };
  if (compareDates(today, latest.nextReviewDue) > 0)
    return {
      status: 'RED',
      reasonText: `Annual review overdue – was due ${formatDate(latest.nextReviewDue)}`,
    };
  if (compareDates(addDays(today, FPP_DUE_SOON_DAYS), latest.nextReviewDue) >= 0)
    return {
      status: 'AMBER',
      reasonText: `Annual review due ${formatDate(latest.nextReviewDue)}`,
    };
  return {
    status: 'GREEN',
    reasonText: `Checked ${formatDate(latest.checkedOn)}; next review ${formatDate(
      latest.nextReviewDue,
    )}`,
  };
}

// ---- CQC statutory notifications (regs 16 and 18) --------------------------------------------
export const CQC_NOTIFICATION_KINDS = [
  'DEATH',
  'SERIOUS_INJURY',
  'ABUSE_ALLEGATION',
  'POLICE_INCIDENT',
  'SERVICE_DISRUPTION',
  'MANAGER_ABSENCE',
  'CHANGE_OF_DETAILS',
  'OTHER',
] as const;
export type CqcNotificationKind = (typeof CQC_NOTIFICATION_KINDS)[number];
/** Planned absences of the registered manager of 28 days or more are notified 28 days ahead. */
export const MANAGER_ABSENCE_NOTICE_DAYS = 28;

/**
 * The hub's internal target date. Most notifications are due "without delay", which the hub
 * treats as the day after it happened; a planned manager absence is due 28 days before it starts.
 * This is a prompt, not legal advice on the deadline.
 */
export function notificationTargetDate(
  kind: CqcNotificationKind,
  occurredOn: ISODate,
  planned = false,
): ISODate {
  if (kind === 'MANAGER_ABSENCE' && planned)
    return addDays(occurredOn, -MANAGER_ABSENCE_NOTICE_DAYS);
  return addDays(occurredOn, 1);
}

/** Suggests which notification an event may need; null when none is suggested. */
export function suggestNotificationKind(e: {
  types: string[];
  severity: string;
}): CqcNotificationKind | null {
  if (e.severity === 'DEATH') return 'DEATH';
  if (e.types.includes('SAFEGUARDING')) return 'ABUSE_ALLEGATION';
  if (e.severity === 'SEVERE') return 'SERIOUS_INJURY';
  return null;
}

export type CqcNotificationStatus = 'DRAFT' | 'READY' | 'SUBMITTED' | 'NOT_REQUIRED';
export const CQC_NOTIFICATION_NEXT: Record<CqcNotificationStatus, CqcNotificationStatus[]> = {
  DRAFT: ['READY', 'NOT_REQUIRED'],
  READY: ['SUBMITTED', 'DRAFT'],
  SUBMITTED: [],
  NOT_REQUIRED: [],
};

export function notificationState(
  n: { status: CqcNotificationStatus; dueOn: ISODate; submittedOn: ISODate | null },
  today: ISODate,
): RegStatus {
  if (n.status === 'NOT_REQUIRED')
    return { status: 'NOT_APPLICABLE', reasonText: 'Decided not to be notifiable' };
  if (n.status === 'SUBMITTED' && n.submittedOn)
    return compareDates(n.submittedOn, n.dueOn) > 0
      ? {
          status: 'AMBER',
          reasonText: `Submitted ${formatDate(n.submittedOn)}, after the target of ${formatDate(
            n.dueOn,
          )}`,
        }
      : { status: 'GREEN', reasonText: `Submitted to CQC on ${formatDate(n.submittedOn)}` };
  const step = n.status === 'READY' ? 'Reviewed, not yet submitted' : 'Draft, needs review';
  if (compareDates(today, n.dueOn) > 0)
    return { status: 'RED', reasonText: `${step} – target was ${formatDate(n.dueOn)}` };
  return { status: 'AMBER', reasonText: `${step} – submit by ${formatDate(n.dueOn)}` };
}

// ---- NHS contracts (task 22) -----------------------------------------------------------------
export const NHS_CONTRACT_PACK = 'NHS_CONTRACT_V1';
/** NHS contract items: adopted from the NHS pack, or an organisation's own template coded NHS-. */
export const isNhsContractItem = (t: { pack: string; code: string }): boolean =>
  t.pack === NHS_CONTRACT_PACK || t.code.toUpperCase().startsWith('NHS-');

/** The last day notice can be given, or null when no notice applies. */
export function contractNoticeBy(endOn: ISODate, noticeMonths: number): ISODate | null {
  return noticeMonths > 0 ? addMonths(endOn, -noticeMonths) : null;
}

export function contractState(
  c: { startOn: ISODate; endOn: ISODate; noticeMonths: number },
  today: ISODate,
): RegStatus {
  if (compareDates(today, c.startOn) < 0)
    return { status: 'GREY', reasonText: `Starts ${formatDate(c.startOn)}` };
  if (compareDates(today, c.endOn) > 0)
    return { status: 'NOT_APPLICABLE', reasonText: `Ended ${formatDate(c.endOn)}` };
  const noticeBy = contractNoticeBy(c.endOn, c.noticeMonths);
  if (noticeBy && compareDates(today, noticeBy) >= 0)
    return {
      status: 'AMBER',
      reasonText: `Ends ${formatDate(c.endOn)}; the notice date (${formatDate(
        noticeBy,
      )}) has been reached, so agree renewal or exit`,
    };
  return { status: 'GREEN', reasonText: `Running until ${formatDate(c.endOn)}` };
}

/** Counts of NHS contract items by status (an item is met only when verified evidence makes it green). */
export function summariseContractItems(statuses: string[]): {
  total: number;
  met: number;
  notMet: number;
  notApplicable: number;
} {
  const notApplicable = statuses.filter((s) => s === 'NOT_APPLICABLE').length;
  const met = statuses.filter((s) => s === 'GREEN').length;
  return {
    total: statuses.length,
    met,
    notMet: statuses.length - met - notApplicable,
    notApplicable,
  };
}

// ---- Governance meetings ---------------------------------------------------------------------
export const MEETING_KINDS = [
  'BOARD',
  'CLINICAL_GOVERNANCE',
  'HEALTH_AND_SAFETY',
  'QUALITY',
  'INFECTION_CONTROL',
  'OTHER',
] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];
