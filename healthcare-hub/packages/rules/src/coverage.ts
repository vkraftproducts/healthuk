import { worstStatus, type RagStatus, type RequirementResult } from './status.js';

export interface Counts {
  overdue: number;
  dueSoon: number;
  unverified: number;
  blocked: number;
}

/** Four separate numbers - never merged into one (PRD 4.2, ALERT-03). */
export function dashboardCounts(results: readonly RequirementResult[]): Counts {
  const c: Counts = { overdue: 0, dueSoon: 0, unverified: 0, blocked: 0 };
  for (const r of results) {
    if (r.status === 'RED' && r.reasonCode !== 'CRITICAL_FAILURE') c.overdue += 1;
    if (r.status === 'AMBER' && (r.reasonCode === 'DUE_SOON' || r.reasonCode === 'DUE_TODAY'))
      c.dueSoon += 1;
    if (r.status === 'GREY' || (r.status === 'AMBER' && r.reasonCode === 'AWAITING_REVIEW'))
      c.unverified += 1;
    if ((r.status === 'RED' || r.status === 'GREY') && r.effect === 'BLOCK') c.blocked += 1;
  }
  return c;
}

/** A module is RED if any item in it is a critical RED (hard-blocking or critical failure). */
export function moduleStatus(results: readonly RequirementResult[]): RagStatus {
  if (
    results.some(
      (r) => r.status === 'RED' && (r.effect === 'BLOCK' || r.reasonCode === 'CRITICAL_FAILURE'),
    )
  )
    return 'RED';
  return worstStatus(results.map((r) => r.status));
}

export interface Coverage {
  numerator: number;
  denominator: number;
  exclusions: number;
  percent: number | null;
  label: 'Internal measure — not a CQC rating';
}

/** Verified current applicable / applicable. N/A items are excluded and counted separately (T18). */
export function evidenceCoverage(results: readonly RequirementResult[]): Coverage {
  const applicable = results.filter((r) => r.status !== 'NOT_APPLICABLE');
  const numerator = applicable.filter((r) => r.currentlyVerified && r.status !== 'RED').length;
  return {
    numerator,
    denominator: applicable.length,
    exclusions: results.length - applicable.length,
    percent:
      applicable.length === 0 ? null : Math.round((numerator / applicable.length) * 1000) / 10,
    label: 'Internal measure — not a CQC rating',
  };
}
