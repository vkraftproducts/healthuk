import { addDays, addMonths, compareDates, type ISODate } from './dates.js';
import type { AuditResult } from './governance.js';
import type { Severity } from './alerts.js';

/**
 * Audit workflow helpers (WORKFLOWS G1, G2). Pure: no I/O, `today` is passed in.
 */

/** Sector pack templates ship as drafts that a specialist must validate (G1, M). */
export const SECTOR_TEMPLATE_NOTE = 'Draft content, specialist validation required';
export const SPECIALIST_PACKS: readonly string[] = ['dental', 'care_home'];
export const needsSpecialist = (pack: string | null | undefined): boolean =>
  !!pack && SPECIALIST_PACKS.includes(pack);

/** Template lifecycle in words, from its versions and flags. */
export type TemplateState = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'RETIRED';
export function templateState(t: {
  active: boolean;
  retired: boolean;
  versions: readonly { status: string }[];
}): TemplateState {
  if (t.retired) return 'RETIRED';
  if (t.active && t.versions.some((v) => v.status === 'PUBLISHED')) return 'ACTIVE';
  if (t.versions.some((v) => v.status === 'PUBLISHED')) return 'PUBLISHED';
  return 'DRAFT';
}

/** Results that need a reason (G2): not applicable and not assessed, plus partial and failed. */
export const RESULTS_NEEDING_REASON: readonly AuditResult[] = [
  'PARTIAL',
  'NON_COMPLIANT',
  'NOT_APPLICABLE',
  'NOT_ASSESSED',
];

/** Controls with no answer yet (the latest answer per control counts). */
export function unansweredControls(
  controls: readonly { code: string }[],
  answered: readonly string[],
): string[] {
  const done = new Set(answered);
  return controls.filter((c) => !done.has(c.code)).map((c) => c.code);
}

/** Answered controls out of all controls, for "save as you go" progress. */
export function auditProgress(
  controls: readonly { code: string }[],
  answered: readonly string[],
): { answered: number; total: number; percent: number } {
  const total = controls.length;
  const n = total - unansweredControls(controls, answered).length;
  return { answered: n, total, percent: total ? Math.round((n / total) * 100) : 0 };
}

/**
 * Overall result: any failed critical control makes the audit non-compliant, whatever else
 * passed. Otherwise the worst control result.
 */
export function auditOverallResult(
  findings: readonly { result: AuditResult; critical: boolean }[],
): { result: AuditResult; text: string } {
  if (findings.some((f) => f.critical && f.result === 'NON_COMPLIANT'))
    return { result: 'NON_COMPLIANT', text: 'Non-compliant: a critical control failed' };
  if (findings.some((f) => f.result === 'NON_COMPLIANT'))
    return { result: 'NON_COMPLIANT', text: 'Non-compliant: one or more controls failed' };
  if (findings.some((f) => f.result === 'PARTIAL'))
    return { result: 'PARTIAL', text: 'Partly compliant' };
  if (findings.some((f) => f.result === 'NOT_ASSESSED'))
    return { result: 'NOT_ASSESSED', text: 'Not fully assessed' };
  if (findings.some((f) => f.result === 'COMPLIANT'))
    return { result: 'COMPLIANT', text: 'Compliant' };
  return { result: 'NOT_APPLICABLE', text: 'Nothing applicable' };
}

/** Default deadline for an action created from a failed control. */
export function autoActionDeadline(severity: Severity, today: ISODate): ISODate {
  const days: Record<Severity, number> = { CRITICAL: 7, HIGH: 14, MEDIUM: 30, LOW: 60 };
  return addDays(today, days[severity] ?? 30);
}

/** The re-audit is due the day after the last action deadline (same template version). */
export function reauditDueDate(deadlines: readonly ISODate[]): ISODate | null {
  if (deadlines.length === 0) return null;
  const last = [...deadlines].sort(compareDates)[deadlines.length - 1]!;
  return addDays(last, 1);
}

/** Next due date of a recurring audit. */
export const nextRecurrence = (dueDate: ISODate, months: number): ISODate =>
  addMonths(dueDate, months);

export type SampleMethod = 'RANDOM' | 'EVERY_NTH' | 'TARGETED';
export const SAMPLE_METHOD_TEXT: Record<SampleMethod, string> = {
  RANDOM: 'Random',
  EVERY_NTH: 'Every nth record',
  TARGETED: 'Targeted (reason given)',
};

/**
 * Picks a sample from a population. `random` returns a number in [0, 1); pass Math.random on
 * screen and a seeded function in tests. Targeted samples are chosen by a person, not here.
 */
export function pickSample(
  population: readonly string[],
  method: Exclude<SampleMethod, 'TARGETED'>,
  size: number,
  random: () => number = Math.random,
): string[] {
  const n = Math.max(0, Math.min(size, population.length));
  if (n === 0) return [];
  if (method === 'EVERY_NTH') {
    const step = Math.max(1, Math.floor(population.length / n));
    const out: string[] = [];
    for (let i = 0; i < population.length && out.length < n; i += step) out.push(population[i]!);
    return out;
  }
  const pool = [...population];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

/** Calendar cell state for a scheduled audit (red when overdue). */
export function auditCalendarState(
  r: { dueDate: ISODate; status: string },
  today: ISODate,
): 'OVERDUE' | 'DUE' | 'DONE' {
  if (r.status !== 'SCHEDULED' && r.status !== 'IN_PROGRESS') return 'DONE';
  return compareDates(today, r.dueDate) > 0 ? 'OVERDUE' : 'DUE';
}
