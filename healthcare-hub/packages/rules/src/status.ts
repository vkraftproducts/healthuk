import {
  daysUntil,
  formatDate,
  isDueToday,
  isOverdue,
  londonDate,
  compareDates,
  type ISODate,
} from './dates.js';

export type RagStatus = 'RED' | 'AMBER' | 'GREEN' | 'GREY' | 'NOT_APPLICABLE';
export type ReasonCode =
  | 'NOT_APPLICABLE'
  | 'CRITICAL_FAILURE'
  | 'DUE_TODAY'
  | 'DUE_SOON'
  | 'AWAITING_REVIEW'
  | 'VALID'
  | 'OVERDUE'
  | 'EXPIRED'
  | 'POLICY_REVIEW_OVERDUE'
  | 'UNVERIFIED'
  | 'MISSING';
export type Blocking = 'NONE' | 'POLICY' | 'DEPLOYMENT_CRITICAL' | 'STATUTORY' | 'SAFETY_CRITICAL';
/** DUE = task deadline, EXPIRY = clearance expiry, REVIEW = policy review date (DBS has no expiry, HR-02). */
export type DeadlineKind = 'DUE' | 'EXPIRY' | 'REVIEW';
/** What a RED/GREY result does to the subject: nothing, a policy block (exception possible), or a hard block. */
export type Effect = 'NONE' | 'POLICY_BLOCK' | 'BLOCK';

export interface RequirementInput {
  applicability: 'APPLICABLE' | 'APPROVED_NOT_APPLICABLE';
  /** Open CRITICAL finding / failed critical check linked to the subject. */
  criticalFailure: boolean;
  /** Governing date. If null and the evidence has `validTo`, that becomes the EXPIRY deadline. */
  deadline: { kind: DeadlineKind; date: ISODate } | null;
  /** Current verified evidence (only VERIFIED evidence may be passed here). */
  verifiedEvidence: { validFrom: ISODate | null; validTo: ISODate | null } | null;
  /** A newer version awaiting verification exists. */
  pendingEvidence: boolean;
  /** Days before the deadline at which AMBER begins (default 30). */
  dueSoonDays?: number;
  blocking: Blocking;
}

export interface RequirementResult {
  status: RagStatus;
  reasonCode: ReasonCode;
  reasonText: string;
  effect: Effect;
  /** True when current verified evidence is within validity (used for coverage). */
  currentlyVerified: boolean;
  daysUntil: number | null;
}

export const DEFAULT_DUE_SOON_DAYS = 30;

function effectFor(blocking: Blocking): Effect {
  if (blocking === 'NONE') return 'NONE';
  return blocking === 'POLICY' ? 'POLICY_BLOCK' : 'BLOCK';
}

const NOUN: Record<DeadlineKind, string> = {
  DUE: 'Due',
  EXPIRY: 'Expires',
  REVIEW: 'Policy review date',
};

/**
 * RULES_ENGINE §2. Evaluates in this exact order; the first match wins.
 * Upload alone never yields GREEN: only `verifiedEvidence` can.
 */
export function evaluateRequirement(input: RequirementInput, now: Date): RequirementResult {
  const base = { currentlyVerified: false, daysUntil: null as number | null };

  // 1. Approved not applicable.
  if (input.applicability === 'APPROVED_NOT_APPLICABLE') {
    return {
      ...base,
      status: 'NOT_APPLICABLE',
      reasonCode: 'NOT_APPLICABLE',
      reasonText: 'Approved as not applicable',
      effect: 'NONE',
    };
  }
  // 2. Critical failure.
  if (input.criticalFailure) {
    return {
      ...base,
      status: 'RED',
      reasonCode: 'CRITICAL_FAILURE',
      reasonText: 'Open critical failure',
      effect: effectFor(input.blocking),
    };
  }

  const today = londonDate(now);
  const ev = input.verifiedEvidence;
  const deadline =
    input.deadline ?? (ev?.validTo ? { kind: 'EXPIRY' as const, date: ev.validTo } : null);
  const days = deadline ? daysUntil(deadline.date, now) : null;
  const evidenceCurrent =
    ev !== null &&
    (ev.validFrom === null || compareDates(ev.validFrom, today) <= 0) &&
    (ev.validTo === null || !isOverdue(ev.validTo, now));
  const deadlineMissed = deadline !== null && isOverdue(deadline.date, now);

  // 3. Current verified evidence within validity.
  if (ev && evidenceCurrent && !deadlineMissed) {
    const window = input.dueSoonDays ?? DEFAULT_DUE_SOON_DAYS;
    const verified = { currentlyVerified: true, daysUntil: days };
    if (deadline && isDueToday(deadline.date, now)) {
      return {
        ...verified,
        status: 'AMBER',
        reasonCode: 'DUE_TODAY',
        reasonText: `${NOUN[deadline.kind]} today (${formatDate(deadline.date)})`,
        effect: 'NONE',
      };
    }
    if (deadline && days !== null && days <= window) {
      return {
        ...verified,
        status: 'AMBER',
        reasonCode: 'DUE_SOON',
        reasonText: `${NOUN[deadline.kind]} in ${days} day${days === 1 ? '' : 's'} (${formatDate(deadline.date)})`,
        effect: 'NONE',
      };
    }
    if (input.pendingEvidence) {
      return {
        ...verified,
        status: 'AMBER',
        reasonCode: 'AWAITING_REVIEW',
        reasonText: 'Newer evidence is awaiting review; current verified evidence is still valid',
        effect: 'NONE',
      };
    }
    return {
      ...verified,
      status: 'GREEN',
      reasonCode: 'VALID',
      reasonText: 'Verified and in date',
      effect: 'NONE',
    };
  }

  // 4. No current verified evidence.
  const effect = effectFor(input.blocking);
  const out = { currentlyVerified: false, daysUntil: days };
  // 4b first when a renewal is waiting (T10): upload never turns anything green, and the subject stays blocked.
  if (input.pendingEvidence) {
    const lapsed = deadlineMissed || (ev !== null && !evidenceCurrent);
    return {
      ...out,
      status: 'GREY',
      reasonCode: 'UNVERIFIED',
      reasonText: lapsed
        ? 'Previous evidence has lapsed and the renewal has not been verified yet'
        : 'Evidence uploaded but not verified yet',
      effect,
    };
  }
  // 4a.
  if (deadline && deadlineMissed) {
    if (deadline.kind === 'REVIEW') {
      return {
        ...out,
        status: 'RED',
        reasonCode: 'POLICY_REVIEW_OVERDUE',
        reasonText: `Policy review date passed (${formatDate(deadline.date)})`,
        effect,
      };
    }
    const code = deadline.kind === 'EXPIRY' ? 'EXPIRED' : 'OVERDUE';
    return {
      ...out,
      status: 'RED',
      reasonCode: code,
      reasonText: `${code === 'EXPIRED' ? 'Expired' : 'Overdue'} since ${formatDate(deadline.date)}`,
      effect,
    };
  }
  if (ev && ev.validTo !== null && isOverdue(ev.validTo, now)) {
    return {
      ...out,
      status: 'RED',
      reasonCode: 'EXPIRED',
      reasonText: `Expired on ${formatDate(ev.validTo)}`,
      effect,
    };
  }
  if (ev && !evidenceCurrent) {
    return {
      ...out,
      status: 'GREY',
      reasonCode: 'MISSING',
      reasonText: 'Verified evidence is not valid yet',
      effect,
    };
  }
  return {
    ...out,
    status: 'GREY',
    reasonCode: 'MISSING',
    reasonText: 'No verified evidence on record',
    effect,
  };
}

/** A tile or module is RED if any critical (hard-blocking) item is RED. */
export function worstStatus(statuses: readonly RagStatus[]): RagStatus {
  for (const s of ['RED', 'AMBER', 'GREY', 'GREEN'] as const) if (statuses.includes(s)) return s;
  return 'NOT_APPLICABLE';
}
