import { londonDate, type ISODate } from './dates.js';
import type { RequirementResult } from './status.js';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export interface DerivedAlert {
  severity: Severity;
  reasonCode: string;
  reasonText: string;
}

/** Alerts are derived from source state, never authored (ALERT-03/04). */
export function deriveAlert(r: RequirementResult, blocksDeployment: boolean): DerivedAlert | null {
  switch (r.status) {
    case 'RED':
      return {
        severity: blocksDeployment || r.reasonCode === 'CRITICAL_FAILURE' ? 'CRITICAL' : 'HIGH',
        reasonCode: r.reasonCode,
        reasonText: r.reasonText,
      };
    case 'GREY':
      return {
        severity: blocksDeployment ? 'HIGH' : 'MEDIUM',
        reasonCode: r.reasonCode,
        reasonText: r.reasonText,
      };
    case 'AMBER':
      return {
        severity:
          r.reasonCode === 'DUE_TODAY' ? 'HIGH' : r.reasonCode === 'DUE_SOON' ? 'MEDIUM' : 'LOW',
        reasonCode: r.reasonCode,
        reasonText: r.reasonText,
      };
    default:
      return null;
  }
}

/** The warning threshold (e.g. 30) the item has most recently crossed, or null if none. */
export function currentWarningWindow(
  daysUntil: number,
  warningDays: readonly number[],
): number | null {
  if (daysUntil < 0) return null;
  const crossed = warningDays.filter((w) => daysUntil <= w);
  return crossed.length === 0 ? null : Math.min(...crossed);
}

/** Notification dedupe key: one per (alert, channel, window day) (ALERT-04). */
export function dedupeKey(alertId: string, channel: string, windowDay: ISODate): string {
  return `${alertId}|${channel}|${windowDay}`;
}

export function windowDay(now: Date): ISODate {
  return londonDate(now);
}

/** Snoozing pauses notifications only; status and due dates never change (T16, ALERT-03). */
export function notificationsPaused(snoozedUntil: Date | null, now: Date): boolean {
  return snoozedUntil !== null && snoozedUntil.getTime() > now.getTime();
}

export type EscalationTarget = 'OWNER' | 'DEPUTY' | 'MANAGER';
/** Owner → deputy when owner absent → manager when both are. */
export function escalationTarget(i: {
  ownerAbsent: boolean;
  deputyAbsent: boolean;
  hasDeputy: boolean;
}): EscalationTarget {
  if (!i.ownerAbsent) return 'OWNER';
  if (i.hasDeputy && !i.deputyAbsent) return 'DEPUTY';
  return 'MANAGER';
}

/** Exponential backoff with a cap: 1, 2, 4, 8, ... minutes up to 60. */
export function retryDelayMinutes(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1));
}

export const MAX_DELIVERY_ATTEMPTS = 6;
