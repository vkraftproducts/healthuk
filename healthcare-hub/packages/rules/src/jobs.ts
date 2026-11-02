import { addDays, compareDates, type ISODate } from './dates.js';

/** Job lifecycle (PRD 4.8). Exceptional outcomes always carry a reason. */
export type JobState =
  | 'BOOKED'
  | 'ASSESSED'
  | 'ALLOCATED'
  | 'OFFERED'
  | 'ACKNOWLEDGED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'PATIENT_ON_BOARD'
  | 'AT_DESTINATION'
  | 'HANDOVER_COMPLETE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUSED'
  | 'NO_ACCESS'
  | 'ABORTED'
  | 'REASSIGNED';

const NEXT: Record<JobState, readonly JobState[]> = {
  BOOKED: ['ASSESSED', 'ALLOCATED', 'CANCELLED'],
  ASSESSED: ['ALLOCATED', 'CANCELLED'],
  ALLOCATED: ['OFFERED', 'REASSIGNED', 'CANCELLED'],
  OFFERED: ['ACKNOWLEDGED', 'REFUSED', 'REASSIGNED', 'CANCELLED'],
  ACKNOWLEDGED: ['EN_ROUTE', 'REASSIGNED', 'CANCELLED'],
  EN_ROUTE: ['ARRIVED', 'ABORTED'],
  ARRIVED: ['PATIENT_ON_BOARD', 'NO_ACCESS', 'ABORTED'],
  PATIENT_ON_BOARD: ['AT_DESTINATION', 'ABORTED'],
  AT_DESTINATION: ['HANDOVER_COMPLETE'],
  HANDOVER_COMPLETE: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REFUSED: ['ALLOCATED', 'CANCELLED'],
  NO_ACCESS: [],
  ABORTED: [],
  REASSIGNED: ['ALLOCATED', 'CANCELLED'],
};
/** States the crew report from the road; everything else is a control-room action. */
export const CREW_STATES: readonly JobState[] = [
  'ACKNOWLEDGED',
  'REFUSED',
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
  'HANDOVER_COMPLETE',
  'COMPLETED',
  'NO_ACCESS',
  'ABORTED',
];
export const REASON_REQUIRED: readonly JobState[] = [
  'CANCELLED',
  'REFUSED',
  'NO_ACCESS',
  'ABORTED',
  'REASSIGNED',
];
/** Jobs waiting for a vehicle and crew. */
export const ALLOCATABLE: readonly JobState[] = ['BOOKED', 'ASSESSED', 'REASSIGNED', 'REFUSED'];
/** Jobs holding a live allocation. */
export const HOLDS_ALLOCATION: readonly JobState[] = [
  'ALLOCATED',
  'OFFERED',
  'ACKNOWLEDGED',
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
  'HANDOVER_COMPLETE',
];

export type JobRefusal = 'NOT_ALLOWED' | 'REASON_REQUIRED' | 'NOT_YOURS';

export function checkJobTransition(i: {
  from: JobState;
  to: JobState;
  actor: 'CREW' | 'CONTROL';
  reason?: string | null;
}): JobRefusal | null {
  if (!NEXT[i.from].includes(i.to)) return 'NOT_ALLOWED';
  if ((i.actor === 'CREW') !== CREW_STATES.includes(i.to)) return 'NOT_YOURS';
  if (REASON_REQUIRED.includes(i.to) && !(i.reason && i.reason.trim().length >= 3))
    return 'REASON_REQUIRED';
  return null;
}

export const jobNext = (s: JobState): readonly JobState[] => NEXT[s];

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY';
  interval: number;
  /** ISO weekdays 1 (Mon)..7 (Sun); weekly rules only. Default: the start date's weekday. */
  byWeekday?: number[];
  until: ISODate;
}

const isoWeekday = (d: ISODate): number => ((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * Expands a recurring journey into individual dates (each becomes its own amendable job).
 * Capped at `max` instances so a mistaken rule cannot flood the planner.
 */
export function expandRecurrence(start: ISODate, rule: RecurrenceRule, max = 100): ISODate[] {
  const out: ISODate[] = [];
  if (compareDates(rule.until, start) < 0 || rule.interval < 1) return out;
  if (rule.freq === 'DAILY') {
    for (
      let d = start;
      compareDates(d, rule.until) <= 0 && out.length < max;
      d = addDays(d, rule.interval)
    )
      out.push(d);
    return out;
  }
  const days = new Set(rule.byWeekday?.length ? rule.byWeekday : [isoWeekday(start)]);
  const weekStart = addDays(start, 1 - isoWeekday(start));
  for (
    let w = weekStart;
    compareDates(w, rule.until) <= 0 && out.length < max;
    w = addDays(w, 7 * rule.interval)
  ) {
    for (let i = 0; i < 7 && out.length < max; i++) {
      const d = addDays(w, i);
      if (compareDates(d, start) < 0 || compareDates(d, rule.until) > 0) continue;
      if (days.has(i + 1)) out.push(d);
    }
  }
  return out;
}

/** How a job planned for today appears on the dashboard (DASH-01); null when it no longer counts. */
export interface JobDashboardRow {
  status: 'RED' | 'AMBER' | 'GREEN' | 'GREY';
  reasonText: string;
  /** Tiles this job is counted in; every tile equals its drill-down rows (UAT-08). */
  tiles: string[];
}
export function jobDashboardRow(
  state: JobState,
  plannedStart: Date,
  now: Date,
): JobDashboardRow | null {
  if (state === 'CANCELLED') return null;
  const late = plannedStart.getTime() < now.getTime();
  const t = (...more: string[]) => ['jobsToday', ...more];
  if (ALLOCATABLE.includes(state)) {
    const again = state === 'REASSIGNED' || state === 'REFUSED';
    return {
      status: again || late ? 'RED' : 'AMBER',
      reasonText: late
        ? 'Past planned start and still unallocated'
        : again
          ? 'Needs a new crew and vehicle'
          : 'Awaiting allocation',
      tiles: t('awaitingAllocation'),
    };
  }
  if (state === 'ALLOCATED' || state === 'OFFERED' || state === 'ACKNOWLEDGED') {
    if (late)
      return {
        status: 'RED',
        reasonText: 'Past planned start and not under way',
        tiles: t(...(state === 'OFFERED' ? ['acknowledgementsDue'] : [])),
      };
    if (state === 'ALLOCATED')
      return { status: 'AMBER', reasonText: 'Allocated – not yet offered to crew', tiles: t() };
    if (state === 'OFFERED')
      return {
        status: 'AMBER',
        reasonText: 'Awaiting crew acknowledgement',
        tiles: t('acknowledgementsDue'),
      };
    return { status: 'GREEN', reasonText: 'Acknowledged by crew', tiles: t() };
  }
  if (state === 'NO_ACCESS' || state === 'ABORTED')
    return {
      status: 'GREY',
      reasonText: state === 'NO_ACCESS' ? 'Ended – no access' : 'Ended – aborted',
      tiles: t(),
    };
  return {
    status: 'GREEN',
    reasonText: state === 'COMPLETED' ? 'Completed' : 'Under way',
    tiles: t(),
  };
}
