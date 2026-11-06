import { addDays, type ISODate } from './dates.js';
import type { Severity } from './alerts.js';
import type { RagStatus } from './status.js';

// ---- Audits (AUD-01) -----------------------------------------------------------------
export type AuditResult =
  'COMPLIANT' | 'PARTIAL' | 'NON_COMPLIANT' | 'NOT_ASSESSED' | 'NOT_APPLICABLE';

export interface ControlSummary {
  pass: number;
  partial: number;
  fail: number;
  na: number;
  notAssessed: number;
  result: AuditResult;
  severity: Severity;
  /** e.g. "4 pass / 1 fail" (UI_SPEC 03). */
  text: string;
}

/** Rolls the sampled responses for one control into a finding (worst result wins). */
export function summariseControl(
  results: readonly AuditResult[],
  critical = false,
): ControlSummary {
  const n = (r: AuditResult) => results.filter((x) => x === r).length;
  const s = {
    pass: n('COMPLIANT'),
    partial: n('PARTIAL'),
    fail: n('NON_COMPLIANT'),
    na: n('NOT_APPLICABLE'),
    notAssessed: n('NOT_ASSESSED'),
  };
  const result: AuditResult = s.fail
    ? 'NON_COMPLIANT'
    : s.partial
      ? 'PARTIAL'
      : s.notAssessed
        ? 'NOT_ASSESSED'
        : s.pass
          ? 'COMPLIANT'
          : 'NOT_APPLICABLE';
  const severity: Severity =
    result === 'NON_COMPLIANT'
      ? critical
        ? 'CRITICAL'
        : 'HIGH'
      : result === 'PARTIAL'
        ? 'MEDIUM'
        : 'LOW';
  const parts = [`${s.pass} pass`];
  if (s.partial) parts.push(`${s.partial} partial`);
  parts.push(`${s.fail} fail`);
  if (s.na) parts.push(`${s.na} not applicable`);
  if (s.notAssessed) parts.push(`${s.notAssessed} not assessed`);
  return { ...s, result, severity, text: parts.join(' / ') };
}

export const needsAction = (r: AuditResult): boolean => r === 'NON_COMPLIANT' || r === 'PARTIAL';

/**
 * Audit outcome is driven by what is still outstanding, not by a percentage: a failure keeps
 * the audit RED until its actions are VERIFIED (uploading evidence is not enough, UAT-04).
 */
export function auditOutcome(
  findings: readonly { result: AuditResult; severity: Severity }[],
  actions: readonly {
    status: 'OPEN' | 'EVIDENCE_SUBMITTED' | 'VERIFIED' | 'REJECTED';
    severity: Severity;
    kind?: 'ACTION' | 'REAUDIT';
  }[],
): { status: RagStatus; reason: string; closed: boolean } {
  const failing = findings.filter((f) => needsAction(f.result));
  const open = actions.filter((a) => a.status !== 'VERIFIED' && a.kind !== 'REAUDIT');
  if (failing.length > 0 && actions.filter((a) => a.kind !== 'REAUDIT').length === 0)
    return { status: 'RED', reason: 'Action required', closed: false };
  if (open.some((a) => a.severity === 'CRITICAL' || a.severity === 'HIGH'))
    return { status: 'RED', reason: 'Action outstanding', closed: false };
  if (open.length > 0) return { status: 'AMBER', reason: 'Action outstanding', closed: false };
  if (findings.some((f) => f.result === 'NOT_ASSESSED'))
    return { status: 'GREY', reason: 'Not fully assessed', closed: true };
  if (failing.length > 0) return { status: 'GREEN', reason: 'Actions verified', closed: true };
  return { status: 'GREEN', reason: 'Compliant', closed: true };
}

/** AUD-02: warn when a subject was sampled in the last N audits of the same control set. */
export function repeatedSelections(
  newIds: readonly string[],
  recent: readonly (readonly string[])[],
): string[] {
  const seen = new Set(recent.flat());
  return newIds.filter((id) => seen.has(id));
}

// ---- Risk register ------------------------------------------------------------------
export type RiskRating = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
/** 5x5 matrix (likelihood x impact). Bands are the organisation default and can be configured. */
export function riskRating(
  likelihood: number,
  impact: number,
): { score: number; rating: RiskRating } {
  const score = likelihood * impact;
  const rating: RiskRating =
    score >= 20 ? 'EXTREME' : score >= 10 ? 'HIGH' : score >= 5 ? 'MEDIUM' : 'LOW';
  return { score, rating };
}

const RATING_WORD: Record<RiskRating, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  EXTREME: 'Extreme',
};
/** Band text with the score, for example "High 16" (WORKFLOWS H4). */
export function riskBandText(likelihood: number, impact: number): string {
  const r = riskRating(likelihood, impact);
  return `${RATING_WORD[r.rating]} ${r.score}`;
}

// ---- Policies (COMP-04) ---------------------------------------------------------------
export type AckState = 'CURRENT' | 'CARRIED_FORWARD' | 'REQUIRED' | 'NO_PUBLISHED_VERSION';
/**
 * Whether a reader has acknowledged the policy. `published` lists every version that has been
 * PUBLISHED (newest first). A non-material change carries an earlier acknowledgement forward;
 * a material change forces re-acknowledgement.
 */
export function ackState(
  published: readonly { id: string; material: boolean }[],
  acknowledged: ReadonlySet<string>,
): AckState {
  if (published.length === 0) return 'NO_PUBLISHED_VERSION';
  if (acknowledged.has(published[0]!.id)) return 'CURRENT';
  for (let i = 0; i < published.length; i++) {
    if (published[i]!.material) return 'REQUIRED';
    const prev = published[i + 1];
    if (prev && acknowledged.has(prev.id)) return 'CARRIED_FORWARD';
  }
  return 'REQUIRED';
}

// ---- Events (EVT-01..04) --------------------------------------------------------------
export type EventStatus =
  | 'TRIAGE'
  | 'PROTECT'
  | 'ASSESS'
  | 'INVESTIGATE'
  | 'RESPOND'
  | 'ACTIONS'
  | 'LEARNING_VERIFIED'
  | 'CLOSED';
export const EVENT_FLOW: readonly EventStatus[] = [
  'TRIAGE',
  'PROTECT',
  'ASSESS',
  'INVESTIGATE',
  'RESPOND',
  'ACTIONS',
  'LEARNING_VERIFIED',
  'CLOSED',
];

export type EventRefusal =
  | 'NOT_ALLOWED'
  | 'OBLIGATIONS_UNDECIDED'
  | 'CANDOUR_UNDECIDED'
  | 'ACTIONS_OPEN'
  | 'NOT_TRIAGED'
  | 'CANDOUR_INCOMPLETE'
  | 'LEARNING_RESPONSE_MISSING';

/**
 * Forward one step at a time (or back one step to reopen), with gates on reporting duties, candour
 * and actions. The optional gates (triage, candour steps, PSIRF learning response) apply when the
 * caller passes them (WORKFLOWS H1).
 */
export function checkEventTransition(i: {
  from: EventStatus;
  to: EventStatus;
  pendingObligations: number;
  candourFlagged: boolean;
  candourDecided: boolean;
  openActions: number;
  triaged?: boolean;
  candourStepsOutstanding?: number;
  learningResponseMissing?: boolean;
}): EventRefusal | null {
  const a = EVENT_FLOW.indexOf(i.from);
  const b = EVENT_FLOW.indexOf(i.to);
  if (i.from === 'CLOSED' || !(b === a + 1 || b === a - 1)) return 'NOT_ALLOWED';
  if (b < a) return null;
  if (i.from === 'TRIAGE' && i.triaged === false) return 'NOT_TRIAGED';
  // Leaving ASSESS means every reporting duty has a recorded decision (no assumption either way).
  if (i.from === 'ASSESS' && i.pendingObligations > 0) return 'OBLIGATIONS_UNDECIDED';
  if (i.from === 'ASSESS' && i.candourFlagged && !i.candourDecided) return 'CANDOUR_UNDECIDED';
  if (i.from === 'INVESTIGATE' && i.learningResponseMissing) return 'LEARNING_RESPONSE_MISSING';
  if (i.to === 'LEARNING_VERIFIED' && i.openActions > 0) return 'ACTIONS_OPEN';
  if (i.to === 'CLOSED' && (i.candourStepsOutstanding ?? 0) > 0) return 'CANDOUR_INCOMPLETE';
  if (i.to === 'CLOSED' && i.pendingObligations > 0) return 'OBLIGATIONS_UNDECIDED';
  return null;
}

/** The system flags possible duty of candour; a person decides (never automatic). */
export function candourFlag(
  severity: 'NO_HARM' | 'LOW' | 'MODERATE' | 'SEVERE' | 'DEATH',
  types: readonly string[],
): boolean {
  const harmful = severity === 'MODERATE' || severity === 'SEVERE' || severity === 'DEATH';
  return harmful && types.some((t) => t === 'INCIDENT' || t === 'ACCIDENT' || t === 'SAFEGUARDING');
}

/** Complaint targets from the organisation's configured policy (calendar days). */
export function complaintTargets(
  receivedOn: ISODate,
  policy: { acknowledgeDays: number; respondDays: number },
): { acknowledgeBy: ISODate; respondBy: ISODate } {
  return {
    acknowledgeBy: addDays(receivedOn, policy.acknowledgeDays),
    respondBy: addDays(receivedOn, policy.respondDays),
  };
}
