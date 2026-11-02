import type { CrewShiftDto, CrewTodayDto } from '@hub/contracts';
import { CREW_STATES, jobNext, offlineStartAllowed, type JobState } from '@hub/rules';
import type { OutboxItem } from './outbox';

export const DOWNTIME_TEXT = 'Follow downtime procedure – call control.';
export const BLOCKED_TEXT = 'Shift start blocked until complete.';
export const PENDING_TEXT = 'Done on this device – pending sync';

type Card = CrewShiftDto['gate']['cards'][number];

/**
 * Gate cards with this device's unsent work shown: a VDI or pre-shift clean done offline counts
 * locally as "complete – pending sync". The server re-checks everything when it arrives.
 */
export function gateWithPending(shift: CrewShiftDto, outbox: readonly OutboxItem[]): Card[] {
  const mine = outbox.filter(
    (i) => i.state === 'PENDING' && (i.payload as { shiftId?: string }).shiftId === shift.id,
  );
  const critical = new Set(
    (shift.vdiTemplate?.items ?? []).filter((i) => i.critical).map((i) => i.code),
  );
  const vdiOk = mine.some(
    (i) =>
      i.type === 'VDI' &&
      !((i.payload.results as { code: string; result: string }[] | undefined) ?? []).some(
        (r) => r.result === 'FAIL' && critical.has(r.code),
      ),
  );
  const cleanOk = mine.some(
    (i) => i.type === 'CLEANING' && (i.payload as { type?: string }).type === 'PRE_SHIFT',
  );
  return shift.gate.cards.map((c) =>
    c.state === 'REQUIRED' && ((c.code === 'VDI' && vdiOk) || (c.code === 'CLEANING' && cleanOk))
      ? { ...c, state: 'COMPLETE', reasonText: PENDING_TEXT }
      : c,
  );
}

export type StartDecision =
  | { kind: 'ONLINE' }
  | { kind: 'OFFLINE_OK' }
  | { kind: 'BLOCKED'; text: string }
  | { kind: 'DOWNTIME'; text: string }
  | { kind: 'STARTED' };

/**
 * Can "Start shift" be pressed? Online the server decides (and shows its checks). Offline it is
 * allowed only when every gate card is satisfied and eligibility was confirmed by the server in the
 * last 30 minutes; otherwise the crew follow the downtime procedure (MOBILE_APP "Offline").
 */
export function startDecision(i: {
  today: CrewTodayDto;
  savedAt: Date;
  cards: readonly Card[];
  online: boolean;
  now: Date;
}): StartDecision {
  const s = i.today.shift;
  if (!s) return { kind: 'BLOCKED', text: 'No shift today.' };
  if (s.state === 'STARTED') return { kind: 'STARTED' };
  const ready = i.cards.every((c) => c.state === 'APPROVED' || c.state === 'COMPLETE');
  if (!ready) return { kind: 'BLOCKED', text: BLOCKED_TEXT };
  if (i.online) return { kind: 'ONLINE' };
  const verified = new Date(
    Math.min(i.savedAt.getTime(), new Date(i.today.eligibilityCheckedAt).getTime()),
  );
  return offlineStartAllowed({ lastVerifiedAt: verified, now: i.now })
    ? { kind: 'OFFLINE_OK' }
    : { kind: 'DOWNTIME', text: DOWNTIME_TEXT };
}

/** States the crew can move a job to from here (the same rule the server applies). */
export function crewNextStates(state: JobState): JobState[] {
  return jobNext(state).filter((s) => CREW_STATES.includes(s));
}

/** Exceptional outcomes need a reason (server REASON_REQUIRED). */
export const NEEDS_REASON: readonly JobState[] = ['REFUSED', 'NO_ACCESS', 'ABORTED'];

/** Accepting a new allocation needs the server: offline, call control instead. */
export function offlineBlocked(to: JobState, online: boolean): boolean {
  return !online && to === 'ACKNOWLEDGED';
}

/** The job state after this device's unsent status updates (shown with a pending badge). */
export function stateWithPending(
  jobId: string,
  serverState: JobState,
  outbox: readonly OutboxItem[],
): { state: JobState; pending: boolean } {
  const mine = outbox.filter(
    (i) => i.type === 'JOB_STATUS' && i.ref === jobId && i.state === 'PENDING',
  );
  const last = mine[mine.length - 1];
  return last
    ? { state: (last.payload as { state: JobState }).state, pending: true }
    : { state: serverState, pending: false };
}

/** A job is "under way" once the crew have set off; a stop-use defect then means call control. */
export const UNDER_WAY: readonly JobState[] = [
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
];

export const STATE_LABEL: Record<JobState, string> = {
  BOOKED: 'Booked',
  ASSESSED: 'Assessed',
  ALLOCATED: 'Allocated',
  OFFERED: 'Offered to you',
  ACKNOWLEDGED: 'Acknowledged',
  EN_ROUTE: 'En route',
  ARRIVED: 'Arrived',
  PATIENT_ON_BOARD: 'Patient on board',
  AT_DESTINATION: 'At destination',
  HANDOVER_COMPLETE: 'Handover complete',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUSED: 'Refused',
  NO_ACCESS: 'No access',
  ABORTED: 'Aborted',
  REASSIGNED: 'Reassigned',
};

/** Button text for each crew action (large single-tap buttons, used when stationary). */
export const ACTION_LABEL: Partial<Record<JobState, string>> = {
  ACKNOWLEDGED: 'Acknowledge job',
  REFUSED: 'Cannot take this job',
  EN_ROUTE: 'Set off – en route',
  ARRIVED: 'Confirm arrival',
  PATIENT_ON_BOARD: 'Patient on board',
  AT_DESTINATION: 'Arrived at destination',
  HANDOVER_COMPLETE: 'Handover complete',
  COMPLETED: 'Complete job',
  NO_ACCESS: 'No access',
  ABORTED: 'Abort job',
};
