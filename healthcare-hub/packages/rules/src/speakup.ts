import { addDays, compareDates, type ISODate } from './dates.js';

/**
 * Speaking up (Freedom to Speak Up) and the employer's duty to take reasonable steps to prevent
 * sexual harassment (Equality Act 2010 s40A, in force 26 October 2024). Pure: the caller passes
 * what the hub holds. The hub shows the steps it can see; whether they are "reasonable" is a
 * judgement for the organisation, so nothing here says an organisation is compliant.
 */
export const SPEAK_UP_ACK_DAYS = 7;
export const DETRIMENT_CHECK_DAYS = 90;

export const speakUpAcknowledgeDue = (raisedOn: ISODate): ISODate =>
  addDays(raisedOn, SPEAK_UP_ACK_DAYS);
export const detrimentCheckDue = (closedOn: ISODate): ISODate =>
  addDays(closedOn, DETRIMENT_CHECK_DAYS);

export type SpeakUpStatus = 'RECEIVED' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'CLOSED';

/** Why a concern cannot be closed yet, or null. */
export function speakUpCloseBlocker(c: {
  status: SpeakUpStatus;
  anonymous: boolean;
  feedbackGivenOn: ISODate | null;
}): string | null {
  if (c.status === 'CLOSED') return 'This concern is already closed';
  if (c.status === 'RECEIVED') return 'Acknowledge the concern before closing it';
  if (!c.anonymous && !c.feedbackGivenOn)
    return 'Record when feedback was given to the person who spoke up';
  return null;
}

/** H6: counts below this are shown as "fewer than 3" so a small team cannot be identified. */
export const SPEAK_UP_SUPPRESS_BELOW = 3;

/** H6: the first and last UK date of a quarter such as `2026-Q4`. */
export function quarterRange(quarter: string): { from: ISODate; to: ISODate } {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw new RangeError(`Invalid quarter: ${quarter}`);
  const year = Number(m[1]);
  const startMonth = (Number(m[2]) - 1) * 3 + 1;
  const from = `${year}-${String(startMonth).padStart(2, '0')}-01`;
  return { from, to: addDays(addMonthsStart(from, 3), -1) };
}
const addMonthsStart = (d: ISODate, n: number): ISODate => {
  const [y, mo] = d.split('-').map(Number) as [number, number];
  const idx = y * 12 + (mo - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
};

/** H6: a count for reporting, hidden when small. */
export function suppressedCount(n: number): string {
  if (n === 0) return '0';
  return n < SPEAK_UP_SUPPRESS_BELOW ? `fewer than ${SPEAK_UP_SUPPRESS_BELOW}` : String(n);
}

/** H6: themes by category for a set of concerns (categories only, never summaries). */
export function speakUpThemes(
  categories: readonly string[],
): { category: string; count: string }[] {
  const counts = new Map<string, number>();
  for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
  // Hidden counts sort together by name, so their order gives nothing away.
  const rank = (n: number) => (n < SPEAK_UP_SUPPRESS_BELOW ? 0 : n);
  return [...counts.entries()]
    .sort((a, b) => rank(b[1]) - rank(a[1]) || a[0].localeCompare(b[0]))
    .map(([category, n]) => ({ category, count: suppressedCount(n) }));
}

export const SPEAK_UP_NEXT: Record<SpeakUpStatus, SpeakUpStatus[]> = {
  RECEIVED: ['ACKNOWLEDGED'],
  ACKNOWLEDGED: ['INVESTIGATING', 'CLOSED'],
  INVESTIGATING: ['CLOSED'],
  CLOSED: [],
};

export type DutyStepKey =
  'RISK_ASSESSMENT' | 'POLICY' | 'TRAINING' | 'CONCERNS_ACKNOWLEDGED' | 'DETRIMENT_CHECKS';
export interface DutyStep {
  step: DutyStepKey;
  title: string;
  status: 'GREEN' | 'AMBER' | 'RED' | 'GREY';
  reasonText: string;
}
export interface HarassmentDutyInput {
  asOf: ISODate;
  /** Latest approved risk assessment, or null. */
  assessment: { approvedOn: ISODate; reviewDue: ISODate } | null;
  hasDraftAssessment: boolean;
  /** A published policy whose title mentions harassment, or null. */
  policy: { title: string; reviewDate: ISODate | null } | null;
  /** A requirement about harassment mapped to roles, with how many people have met it. */
  training: { title: string; required: number; met: number } | null;
  /** Null when the caller cannot see speak-up concerns (no speakup.manage). */
  overdueAcknowledgements: number | null;
  overdueDetrimentChecks: number | null;
}

export const DUTY_TITLES: Record<DutyStepKey, string> = {
  RISK_ASSESSMENT: 'Sexual harassment risk assessment, approved and in date',
  POLICY: 'Published policy on harassment and how to report it',
  TRAINING: 'Training for staff on harassment, mapped to roles',
  CONCERNS_ACKNOWLEDGED: `Concerns acknowledged within ${SPEAK_UP_ACK_DAYS} days`,
  DETRIMENT_CHECKS: 'People who spoke up asked whether they suffered any detriment',
};

export function harassmentDutySteps(i: HarassmentDutyInput): DutyStep[] {
  const step = (s: DutyStepKey, status: DutyStep['status'], reasonText: string): DutyStep => ({
    step: s,
    title: DUTY_TITLES[s],
    status,
    reasonText,
  });
  const out: DutyStep[] = [];

  if (!i.assessment)
    out.push(
      step(
        'RISK_ASSESSMENT',
        i.hasDraftAssessment ? 'AMBER' : 'RED',
        i.hasDraftAssessment ? 'A draft is waiting for approval' : 'No risk assessment recorded',
      ),
    );
  else if (compareDates(i.assessment.reviewDue, i.asOf) < 0)
    out.push(step('RISK_ASSESSMENT', 'RED', `Review was due ${i.assessment.reviewDue}`));
  else
    out.push(
      step(
        'RISK_ASSESSMENT',
        'GREEN',
        `Approved ${i.assessment.approvedOn}; review due ${i.assessment.reviewDue}`,
      ),
    );

  if (!i.policy) out.push(step('POLICY', 'RED', 'No published policy mentions harassment'));
  else if (i.policy.reviewDate && compareDates(i.policy.reviewDate, i.asOf) < 0)
    out.push(
      step('POLICY', 'AMBER', `"${i.policy.title}" was due for review ${i.policy.reviewDate}`),
    );
  else out.push(step('POLICY', 'GREEN', `"${i.policy.title}" is published`));

  if (!i.training) out.push(step('TRAINING', 'RED', 'No harassment training is mapped to a role'));
  else if (i.training.required === 0)
    out.push(step('TRAINING', 'GREY', `"${i.training.title}" applies to nobody yet`));
  else
    out.push(
      step(
        'TRAINING',
        i.training.met === i.training.required ? 'GREEN' : 'AMBER',
        `${i.training.met} of ${i.training.required} people have verified training`,
      ),
    );

  const hidden = 'Only people who handle speak-up concerns can see this';
  if (i.overdueAcknowledgements === null) out.push(step('CONCERNS_ACKNOWLEDGED', 'GREY', hidden));
  else if (i.overdueAcknowledgements)
    out.push(
      step(
        'CONCERNS_ACKNOWLEDGED',
        'RED',
        `${i.overdueAcknowledgements} concern(s) not acknowledged in time`,
      ),
    );
  else
    out.push(
      step('CONCERNS_ACKNOWLEDGED', 'GREEN', 'No concern is waiting past its acknowledgement date'),
    );
  if (i.overdueDetrimentChecks === null) out.push(step('DETRIMENT_CHECKS', 'GREY', hidden));
  else if (i.overdueDetrimentChecks)
    out.push(step('DETRIMENT_CHECKS', 'AMBER', `${i.overdueDetrimentChecks} follow-up(s) overdue`));
  else out.push(step('DETRIMENT_CHECKS', 'GREEN', 'No detriment follow-up is overdue'));
  return out;
}
