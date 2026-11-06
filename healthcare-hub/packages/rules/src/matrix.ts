import { addMonths, compareDates, formatDate, type ISODate } from './dates.js';

/**
 * Training matrix cells (HR-03). A cell is one person against one requirement mapped to a role.
 * Only verified evidence counts as met; a required item with no record is missing, not "blank".
 */
export type MatrixCellState =
  'MET' | 'DUE_SOON' | 'OVERDUE' | 'AWAITING' | 'MISSING' | 'NOT_REQUIRED';

export interface MatrixCellInput {
  required: boolean;
  /** Stored RAG status of the person's requirement, or null when they have none. */
  status: 'RED' | 'AMBER' | 'GREEN' | 'GREY' | 'NOT_APPLICABLE' | null;
  /** Stored reason code; UNVERIFIED means evidence is uploaded and waiting for a reviewer. */
  reasonCode?: string | null;
}

export function matrixCellState(c: MatrixCellInput): MatrixCellState {
  if (!c.required || c.status === 'NOT_APPLICABLE') return 'NOT_REQUIRED';
  if (c.status === 'GREEN') return 'MET';
  if (c.status === 'AMBER') return 'DUE_SOON';
  if (c.status === 'RED') return 'OVERDUE';
  if (c.status === 'GREY' && c.reasonCode === 'UNVERIFIED') return 'AWAITING';
  return 'MISSING';
}

/** The words shown in a matrix cell (WORKFLOWS C1); colour always goes with them. */
export function matrixCellText(state: MatrixCellState, validUntil: ISODate | null): string {
  switch (state) {
    case 'MET':
      return validUntil ? `Verified, valid until ${formatDate(validUntil)}` : 'Verified';
    case 'DUE_SOON':
      return validUntil ? `Due soon, expires ${formatDate(validUntil)}` : 'Due soon';
    case 'OVERDUE':
      return 'Overdue or expired';
    case 'AWAITING':
      return 'Awaiting verification';
    case 'MISSING':
      return 'Not done';
    default:
      return 'Not required';
  }
}

export interface MatrixColumnSummary {
  required: number;
  met: number;
  dueSoon: number;
  overdue: number;
  awaiting: number;
  missing: number;
  /** Whole-number percentage of required cells that are met (null when none are required). */
  percentMet: number | null;
}

export function summariseMatrixColumn(states: readonly MatrixCellState[]): MatrixColumnSummary {
  const n = (s: MatrixCellState) => states.filter((x) => x === s).length;
  const met = n('MET');
  const required = states.length - n('NOT_REQUIRED');
  return {
    required,
    met,
    dueSoon: n('DUE_SOON'),
    overdue: n('OVERDUE'),
    awaiting: n('AWAITING'),
    missing: n('MISSING'),
    percentMet: required ? Math.floor((met / required) * 100) : null,
  };
}

/** A row has a gap when any required cell is not met (due soon counts as met for now). */
export function matrixRowHasGap(states: readonly MatrixCellState[]): boolean {
  return states.some((s) => s === 'OVERDUE' || s === 'MISSING' || s === 'AWAITING');
}

/** Expiry from a course interval when none was entered (WORKFLOWS C1). */
export function trainingExpiry(
  completedOn: ISODate,
  intervalMonths: number | null,
  entered: ISODate | null,
): ISODate | null {
  if (entered) return entered;
  return intervalMonths ? addMonths(completedOn, intervalMonths) : null;
}

// ---- competencies (WORKFLOWS C4) ---------------------------------------------------------------

export interface CompetencyRecord {
  code: string;
  outcome: string;
  assessedOn: ISODate;
  expiresOn?: ISODate | null;
}

/**
 * Whether a person holds skill `code` on `onDate`: their latest assessment for it was
 * "competent" and has not expired. For the planner (E3) to check each skill a booking needs.
 */
export function hasCompetence(
  records: readonly CompetencyRecord[],
  code: string,
  onDate: ISODate,
): boolean {
  const latest = records
    .filter((r) => r.code === code && compareDates(r.assessedOn, onDate) <= 0)
    .sort((a, b) => compareDates(b.assessedOn, a.assessedOn))[0];
  if (!latest || latest.outcome !== 'COMPETENT') return false;
  return !latest.expiresOn || compareDates(latest.expiresOn, onDate) >= 0;
}

/** Skills from `needed` that nobody in `crew` holds on `onDate` (empty means covered). */
export function missingCompetences(
  crew: readonly (readonly CompetencyRecord[])[],
  needed: readonly string[],
  onDate: ISODate,
): string[] {
  return needed.filter((code) => !crew.some((records) => hasCompetence(records, code, onDate)));
}
