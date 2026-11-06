import { compareDates, daysUntil, endOfLondonDay, londonDate, type ISODate } from './dates.js';
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

// ---- alerts centre and notification rules (task 24) --------------------------------------------

/** Events an organisation can route to extra roles (`OrgSettings.notificationRules`). */
export type NotificationEvent =
  | 'EXPIRY_WARNING'
  | 'ACTION_OVERDUE'
  | 'INCIDENT_REPORTED'
  | 'BREACH_RECORDED'
  | 'POLICY_PUBLISHED'
  | 'AUDIT_OVERDUE';

export interface NotificationRule {
  event: NotificationEvent;
  roleKeys: readonly string[];
  email: boolean;
}

/** How long a reported incident or a published policy stays in the alerts centre. */
export const INCIDENT_REPORTED_DAYS = 7;
export const POLICY_PUBLISHED_DAYS = 14;

/** The routable event a stored alert belongs to, or null when no rule can route it. */
export function alertEvent(sourceType: string): NotificationEvent | null {
  if (sourceType === 'REQUIREMENT') return 'EXPIRY_WARNING';
  if (sourceType === 'BREACH') return 'BREACH_RECORDED';
  return null;
}

/** Reads the stored rules defensively: settings JSON may predate the field. */
export function readNotificationRules(settings: unknown): NotificationRule[] {
  const raw = (settings as { notificationRules?: unknown } | null)?.notificationRules;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is NotificationRule =>
      !!r &&
      typeof (r as NotificationRule).event === 'string' &&
      Array.isArray((r as NotificationRule).roleKeys) &&
      typeof (r as NotificationRule).email === 'boolean',
  );
}

/** Role keys told about an event, in addition to the record owner. */
export function rolesForEvent(
  rules: readonly NotificationRule[],
  event: NotificationEvent,
): string[] {
  return [...new Set(rules.filter((r) => r.event === event).flatMap((r) => r.roleKeys))];
}

/** Role keys that also get the event by email (still subject to the email-reminders switch). */
export function emailRolesForEvent(
  rules: readonly NotificationRule[],
  event: NotificationEvent,
): string[] {
  return [...new Set(rules.filter((r) => r.event === event && r.email).flatMap((r) => r.roleKeys))];
}

/** Whether a person in `roleKeys` is told about `event` by a rule. */
export function toldByRule(
  rules: readonly NotificationRule[],
  event: NotificationEvent,
  roleKeys: readonly string[],
): boolean {
  const told = rolesForEvent(rules, event);
  return roleKeys.some((k) => told.includes(k));
}

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Alerts centre order: most serious first, then oldest first so nothing sinks out of sight. */
export function compareCentreItems(
  a: { severity: Severity; raisedAt: string },
  b: { severity: Severity; raisedAt: string },
): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.raisedAt.localeCompare(b.raisedAt)
  );
}

// ---- L2: escalation, deputies and snooze ------------------------------------------------------

export interface Escalation {
  /** Unacknowledged this many UK days after it was raised: the lead for the item kind is told. */
  leadAfterDays: number;
  /** ...and after this many, the registered manager. */
  managerAfterDays: number;
}
export type EscalationStage = 'OWNER' | 'LEAD' | 'MANAGER';

/** How far an unacknowledged alert has escalated, counted in whole UK days since it was raised. */
export function escalationStage(
  raisedAt: Date,
  now: Date,
  esc: Escalation,
  acknowledged = false,
): EscalationStage {
  if (acknowledged) return 'OWNER';
  const days = -daysUntil(londonDate(raisedAt), now);
  if (days >= esc.managerAfterDays) return 'MANAGER';
  if (days >= esc.leadAfterDays) return 'LEAD';
  return 'OWNER';
}

export interface DeputyCover {
  leadUserId: string;
  deputyUserId: string;
  from: ISODate;
  to: ISODate;
}

/** Whether cover is in force on `today` (both ends inclusive, UK dates). */
export function coverActive(c: DeputyCover, today: ISODate): boolean {
  return compareDates(c.from, today) <= 0 && compareDates(today, c.to) <= 0;
}

/** The people `userId` is covering for today. */
export function coveringFor(
  deputies: readonly DeputyCover[],
  userId: string,
  today: ISODate,
): string[] {
  return deputies
    .filter((d) => d.deputyUserId === userId && coverActive(d, today))
    .map((d) => d.leadUserId);
}

/** The deputy standing in for `leadUserId` today, or null. */
export function activeDeputy(
  deputies: readonly DeputyCover[],
  leadUserId: string,
  today: ISODate,
): string | null {
  const cover = deputies.find((d) => d.leadUserId === leadUserId && coverActive(d, today));
  return cover?.deputyUserId ?? null;
}

/** The A6 item kind a stored alert belongs to (requirements split by what they are about). */
export function alertItemKind(sourceType: string, subjectType?: string | null): string {
  if (sourceType === 'REQUIREMENT') {
    if (subjectType === 'VEHICLE') return 'VEHICLE_DOCUMENT';
    if (subjectType === 'EQUIPMENT') return 'EQUIPMENT_REGIME';
    if (subjectType === 'PREMISES') return 'PREMISES_ITEM';
    return 'STAFF_REQUIREMENT';
  }
  if (sourceType === 'DEFECT') return 'EQUIPMENT_REGIME';
  if (sourceType === 'BREACH' || sourceType === 'RETENTION') return 'DP_DEADLINE';
  if (sourceType === 'STAFF') return 'STAFF_REQUIREMENT';
  if (sourceType === 'ACTION') return 'ACTION';
  if (sourceType === 'AUDIT') return 'AUDIT';
  return 'INCIDENT_OBLIGATION';
}

/** The role that leads each item kind: told on escalation (or at once, if the rule says so). */
export const LEAD_ROLE_BY_KIND: Record<string, string> = {
  STAFF_REQUIREMENT: 'HR_LEAD',
  VEHICLE_DOCUMENT: 'FLEET_LEAD',
  EQUIPMENT_REGIME: 'FLEET_LEAD',
  PREMISES_ITEM: 'PREMISES_LEAD',
  ACTION: 'GOVERNANCE_LEAD',
  AUDIT: 'GOVERNANCE_LEAD',
  INCIDENT_OBLIGATION: 'GOVERNANCE_LEAD',
  DP_DEADLINE: 'GOVERNANCE_LEAD',
};

export type Recipient = 'OWNER' | 'LEAD' | 'REGISTERED_MANAGER';

/**
 * Why a person with `roleKeys` is told about an item of `kind`, given the organisation's
 * recipients for that kind and how far the alert has escalated. 'RULE' when the recipients
 * name them from the start, 'ESCALATED' when only escalation brings them in.
 */
export function recipientReason(i: {
  kind: string;
  recipients: readonly Recipient[];
  stage: EscalationStage;
  roleKeys: readonly string[];
}): 'RULE' | 'ESCALATED' | null {
  const lead = i.roleKeys.includes(LEAD_ROLE_BY_KIND[i.kind] ?? '');
  const manager = i.roleKeys.includes('REGISTERED_MANAGER');
  const named =
    (lead && i.recipients.includes('LEAD')) ||
    (manager && i.recipients.includes('REGISTERED_MANAGER'));
  if (named) return 'RULE';
  if (lead && i.stage !== 'OWNER') return 'ESCALATED';
  if (manager && i.stage === 'MANAGER') return 'ESCALATED';
  return null;
}

/** Snoozing to a date means "until the end of that UK day". */
export function snoozeUntil(until: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(until) ? endOfLondonDay(until) : new Date(until);
}

/** Web page for an alert's source; never carries personal data. */
export function alertLink(sourceType: string, sourceId: string): string {
  switch (sourceType) {
    case 'REQUIREMENT':
      return '/';
    case 'STAFF':
      return `/staff/${sourceId}`;
    case 'BREACH':
    case 'RETENTION':
      return '/settings';
    case 'DEFECT':
      return '/vehicles';
    case 'JOB':
      return '/planner';
    case 'ACTION':
      return '/compliance?tab=actions';
    case 'AUDIT':
      return `/compliance/audits/${sourceId}`;
    case 'EVENT':
      return `/compliance/events/${sourceId}`;
    case 'POLICY':
      return '/compliance?tab=policies';
    default:
      return '/alerts';
  }
}
