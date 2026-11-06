import { addDays, addMonths, type ISODate } from './dates.js';

/**
 * Report catalogue (PRD 4.10). Every measure documents its numerator, denominator, period and
 * inclusion rule; the same text is shown on screen, in CSV exports and in the management pack.
 */
export type ReportId =
  | 'WORKFORCE_READINESS'
  | 'SUPERVISION'
  | 'FLEET'
  | 'AUDITS_ACTIONS'
  | 'EVENTS'
  | 'POLICY_ACK'
  | 'PREMISES'
  | 'JOURNEYS'
  | 'NHS_KPI';

/** Information governance training target in the Data Security and Protection Toolkit. */
export const IG_TRAINING_TARGET = 95;
/** Requirement titles counted as data security (information governance) training. */
export const IG_TRAINING_TITLE = /data security|information governance/i;

export interface MeasureDefinition {
  key: string;
  label: string;
  numerator: string | null;
  denominator: string;
  period: string;
  inclusion: string;
}
export interface ReportDefinition {
  id: ReportId;
  title: string;
  summary: string;
  measures: readonly MeasureDefinition[];
}

const SNAPSHOT = 'Snapshot at the time the report is run';
const IN_PERIOD = 'Selected period (London dates, inclusive)';

export const REPORTS: readonly ReportDefinition[] = [
  {
    id: 'WORKFORCE_READINESS',
    title: 'Workforce readiness and training gaps',
    summary: 'Staff whose required checks and training are all current, and where the gaps are.',
    measures: [
      {
        key: 'ready',
        label: 'Staff fully ready',
        numerator:
          'Staff with at least one required check, all verified and in date (people with no checks set up are not ready)',
        denominator: 'Active and onboarding staff (leavers excluded)',
        period: SNAPSHOT,
        inclusion:
          'Required items are those mapped to the person’s approved roles, plus unmapped items',
      },
      {
        key: 'gaps',
        label: 'Training and check gaps',
        numerator: null,
        denominator: 'Required items not green, by requirement',
        period: SNAPSHOT,
        inclusion: 'Red, amber and grey (awaiting verification) items for non-leavers',
      },
    ],
  },
  {
    id: 'SUPERVISION',
    title: 'Supervision and appraisal: planned vs completed',
    summary: 'Supervision and appraisal requirements that are current against those planned.',
    measures: [
      {
        key: 'completed',
        label: 'Completed and current',
        numerator: 'Supervision/appraisal items that are green',
        denominator: 'Supervision/appraisal items that apply (not applicable excluded)',
        period: SNAPSHOT,
        inclusion: 'Requirements whose code contains SUPERVISION or APPRAISAL; leavers excluded',
      },
    ],
  },
  {
    id: 'FLEET',
    title: 'Fleet availability, defects and maintenance',
    summary: 'Vehicles available now, defects raised in the period and maintenance due.',
    measures: [
      {
        key: 'available',
        label: 'Vehicles available',
        numerator: 'Vehicles with status Available',
        denominator: 'Vehicles not retired',
        period: SNAPSHOT,
        inclusion: 'Blocked, quarantined and off-road vehicles count as unavailable',
      },
      {
        key: 'defects',
        label: 'Defects reported',
        numerator: null,
        denominator: 'Defects discovered in the period, by severity',
        period: IN_PERIOD,
        inclusion: 'Vehicle and equipment defects, including those raised from inspections',
      },
      {
        key: 'maintenance',
        label: 'Maintenance overdue',
        numerator: 'Active plans past their date or mileage',
        denominator: 'Active maintenance plans',
        period: SNAPSHOT,
        inclusion:
          'Whichever of date and mileage comes first; implausible odometer readings ignored',
      },
    ],
  },
  {
    id: 'AUDITS_ACTIONS',
    title: 'Overdue audits and action ageing',
    summary: 'Audits past their due date and open actions by age.',
    measures: [
      {
        key: 'auditsOverdue',
        label: 'Audits late',
        numerator: 'Audits submitted after their due date, or past it and still not submitted',
        denominator: 'Audits due in the period',
        period: IN_PERIOD,
        inclusion: 'Every audit run due in the period, whatever its status',
      },
      {
        key: 'actionAge',
        label: 'Open actions by age',
        numerator: null,
        denominator: 'Actions not yet verified, by days since raised (0–30, 31–60, 61–90, 90+)',
        period: SNAPSHOT,
        inclusion: 'Actions and re-audits from audits, events and risks; not split by location',
      },
    ],
  },
  {
    id: 'EVENTS',
    title: 'Incident and complaint trends',
    summary: 'Events recorded by month and type, and complaint response times.',
    measures: [
      {
        key: 'byMonth',
        label: 'Events by month and type',
        numerator: null,
        denominator:
          'Events that occurred in the period, by London month (an event can have several types)',
        period: IN_PERIOD,
        inclusion:
          'Only events you are allowed to see (restricted events need the restricted permission)',
      },
      {
        key: 'complaintsOnTime',
        label: 'Complaints responded to on time',
        numerator: 'Complaints responded to on or before the target date',
        denominator:
          'Complaints received in the period whose response date has passed or that have a response',
        period: IN_PERIOD,
        inclusion:
          'Targets from organisation settings (default 3 days to acknowledge, 28 to respond)',
      },
    ],
  },
  {
    id: 'POLICY_ACK',
    title: 'Policy acknowledgement by version',
    summary: 'For each published policy version, how many of the people who must read it have.',
    measures: [
      {
        key: 'acknowledged',
        label: 'Acknowledged',
        numerator: 'Readers who acknowledged this version',
        denominator: 'Current members whose role is in the policy’s reader roles',
        period: SNAPSHOT,
        inclusion: 'Published versions only; superseded versions shown for history',
      },
    ],
  },
  {
    id: 'PREMISES',
    title: 'Premises compliance',
    summary: 'Premises checks by status and location.',
    measures: [
      {
        key: 'compliant',
        label: 'Premises checks current',
        numerator: 'Applicable premises items whose requirement is green',
        denominator: 'Applicable premises items',
        period: SNAPSHOT,
        inclusion: 'Items marked not applicable are excluded and listed with their reason',
      },
    ],
  },
  {
    id: 'JOURNEYS',
    title: 'Journey punctuality, cancellations and aborts',
    summary:
      'How journeys in the period ended, and whether crews arrived within the pickup window.',
    measures: [
      {
        key: 'punctual',
        label: 'Arrived within pickup window',
        numerator:
          'Journeys whose crew-recorded arrival was at or before the end of the pickup window',
        denominator: 'Journeys in the period with a recorded arrival',
        period: IN_PERIOD,
        inclusion: 'Journey date in the period; arrival time is the time captured on the device',
      },
      {
        key: 'outcomes',
        label: 'Outcomes',
        numerator: null,
        denominator:
          'Journeys in the period by final state (completed, cancelled, aborted, refused, no access, open)',
        period: IN_PERIOD,
        inclusion: 'Each journey counted once by its current state',
      },
    ],
  },
  {
    id: 'NHS_KPI',
    title: 'NHS contract: items, DSPT and information governance training',
    summary:
      'Contract items that are current, the DSPT submission and data security training ' +
      'against the 95% target. Shows only what has been recorded.',
    measures: [
      {
        key: 'contractItems',
        label: 'Contract items current',
        numerator: 'NHS contract items whose requirement is green',
        denominator: 'NHS contract items adopted (not applicable excluded)',
        period: SNAPSHOT,
        inclusion: 'Items from the NHS contract pack; no figure when none are adopted',
      },
      {
        key: 'igTraining',
        label: 'Data security training current (target 95%)',
        numerator: 'Staff whose data security training requirement is green',
        denominator: 'Active staff who have a data security training requirement',
        period: SNAPSHOT,
        inclusion: 'Requirements titled data security or information governance; leavers excluded',
      },
    ],
  },
];

export const reportDefinition = (id: ReportId): ReportDefinition =>
  REPORTS.find((r) => r.id === id)!;

/** A rate as a percentage to one decimal place; null when there is nothing to measure. */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export type AgeBand = '0–30' | '31–60' | '61–90' | '90+';
export const AGE_BANDS: readonly AgeBand[] = ['0–30', '31–60', '61–90', '90+'];
export function ageBand(days: number): AgeBand {
  if (days <= 30) return '0–30';
  if (days <= 60) return '31–60';
  if (days <= 90) return '61–90';
  return '90+';
}

/** 'YYYY-MM' months touched by the period, in order. */
export function monthsIn(from: ISODate, to: ISODate): string[] {
  const out: string[] = [];
  let m = `${from.slice(0, 7)}-01`;
  while (m.slice(0, 7) <= to.slice(0, 7)) {
    out.push(m.slice(0, 7));
    m = addMonths(m, 1);
  }
  return out;
}

/** First and last London date of a 'YYYY-MM' month. */
export function monthPeriod(month: string): { from: ISODate; to: ISODate } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid month: ${month}`);
  const from = `${month}-01`;
  return { from, to: addDays(addMonths(from, 1), -1) };
}

/** Arrived at or before the end of the pickup window. */
export const punctual = (arrivedAt: Date, pickupTo: Date): boolean =>
  arrivedAt.getTime() <= pickupTo.getTime();
