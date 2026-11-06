import type { OrgSettings } from '@hub/contracts';
import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import {
  LEAD_ROLE_BY_KIND,
  MAX_DELIVERY_ATTEMPTS,
  activeDeputy,
  alertItemKind,
  alertLink,
  daysUntil,
  escalationStage,
  formatDate,
  londonDate,
  notificationsPaused,
  retryDelayMinutes,
  type EscalationStage,
} from '@hub/rules';
import type {
  DeliveryRecipient,
  NotificationSender,
  OutboundMessage,
  SendOutcome,
} from './notification-senders.js';

/**
 * Email and push delivery of escalations (A6/A7, ALERT-04). When an open, unacknowledged and
 * unsnoozed alert reaches the lead stage (and later the registered manager stage) the people newly
 * brought in are queued in `notification_outbox`, one row per (escalation, recipient, channel).
 * The worker drains the outbox with retries and backoff. Content is generic text, a UK date and an
 * opaque in-app path only (non-negotiable 7); never a patient, a name, a code or a record title.
 */

export type EscalatedStage = Exclude<EscalationStage, 'OWNER'>;
export type OutboxChannel = 'EMAIL' | 'PUSH';

/** A stage reached longer ago than this is not announced (first run, or after downtime). */
export const ESCALATION_CATCH_UP_DAYS = 7;

const SEVERITY_WORD: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

export const ESCALATION_SUBJECT = 'An item needs your attention in Healthcare Hub';

/** The fixed message for an escalation. Pure; the only variables are fixed words, a date and an id. */
export function escalationMessage(i: {
  stage: EscalatedStage;
  severity: string;
  sourceType: string;
  sourceId: string;
  now: Date;
}): { subject: string; body: string; linkPath: string } {
  const who = i.stage === 'LEAD' ? 'to you as a team lead' : 'to you as registered manager';
  const link = alertLink(i.sourceType, i.sourceId);
  return {
    subject: ESCALATION_SUBJECT,
    body: [
      `An item in Healthcare Hub is still open and has been escalated ${who}.`,
      `Priority: ${SEVERITY_WORD[i.severity] ?? 'Not set'}.`,
      `Date: ${formatDate(londonDate(i.now))} (UK time).`,
      'Sign in to Healthcare Hub to see what it is and what to do.',
      'For privacy, this message never includes details about the item or any person.',
    ].join('\n'),
    linkPath: link === '/' ? '/alerts' : link,
  };
}

/**
 * Who an escalation stage reaches: the lead role for the item kind at the lead stage, the
 * registered manager at the manager stage (a person who is both is told once, as lead).
 */
export function stageTargets(
  stage: EscalatedStage,
  leadRole: string | undefined,
  roleKeys: readonly string[],
): boolean {
  const lead = !!leadRole && roleKeys.includes(leadRole);
  return stage === 'LEAD' ? lead : roleKeys.includes('REGISTERED_MANAGER') && !lead;
}

export function outboxKey(
  alertId: string,
  stage: EscalatedStage,
  userId: string,
  channel: OutboxChannel,
): string {
  return `${alertId}:${stage}:${userId}:${channel}`;
}

type Settings = Partial<
  Pick<OrgSettings, 'escalation' | 'deputies' | 'channels' | 'emailReminders'>
>;

/** The organisation's channel switches: email needs both the channel and email reminders on. */
function orgChannels(settings: unknown): { email: boolean; push: boolean } {
  const s = (settings ?? {}) as Settings;
  return {
    email: s.channels?.email !== false && s.emailReminders !== false,
    push: s.channels?.push !== false,
  };
}

interface Member {
  userId: string;
  roleKeys: string[];
}

async function activeMembers(tx: TenantTx, orgId: string): Promise<Map<string, Member>> {
  const rows = await tx.membership.findMany({
    where: { organisationId: orgId, validTo: null, user: { status: 'ACTIVE' } },
    select: { userId: true, role: { select: { key: true } } },
  });
  const out = new Map<string, Member>();
  for (const r of rows) {
    const m = out.get(r.userId) ?? { userId: r.userId, roleKeys: [] };
    if (!m.roleKeys.includes(r.role.key)) m.roleKeys.push(r.role.key);
    out.set(r.userId, m);
  }
  return out;
}

async function preferences(
  tx: TenantTx,
  userIds: readonly string[],
): Promise<Map<string, { email: boolean; push: boolean }>> {
  const rows = await tx.notificationPreference.findMany({
    where: { userId: { in: [...userIds] } },
    select: { userId: true, emailEnabled: true, pushEnabled: true },
  });
  return new Map(rows.map((p) => [p.userId, { email: p.emailEnabled, push: p.pushEnabled }]));
}

export interface EscalationPlan {
  created: number;
}

interface OutboxRow {
  organisationId: string;
  alertId: string;
  escalationStage: EscalatedStage;
  recipientUserId: string;
  channel: OutboxChannel;
  idempotencyKey: string;
  subject: string;
  body: string;
  linkPath: string;
  nextAttemptAt: Date;
  createdBy: string;
}

/**
 * Queues outbox rows for every escalation stage reached by an open alert. Idempotent: the
 * idempotency key is (alert, stage, recipient, channel), so re-running changes nothing. The
 * alert's owner is not told (they already have it); deputies covering a target today are.
 */
export async function planEscalationDeliveries(
  tx: TenantTx,
  orgId: string,
  now: Date,
): Promise<EscalationPlan> {
  const org = await tx.organisation.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  });
  const cfg = (org.settings ?? {}) as Settings;
  const channels = orgChannels(org.settings);
  if (!channels.email && !channels.push) return { created: 0 };
  const esc = cfg.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 };
  const deputies = cfg.deputies ?? [];
  const today = londonDate(now);

  const alerts = await tx.alert.findMany({
    where: { state: 'OPEN' },
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      severity: true,
      ownerUserId: true,
      snoozedUntil: true,
      raisedAt: true,
    },
    // Newest first: anything older than the catch-up window is skipped anyway.
    orderBy: { raisedAt: 'desc' },
    take: 1000,
  });
  if (alerts.length === 0) return { created: 0 };
  const reqIds = alerts.filter((a) => a.sourceType === 'REQUIREMENT').map((a) => a.sourceId);
  const subjects = new Map(
    (
      await tx.requirementInstance.findMany({
        where: { id: { in: reqIds } },
        select: { id: true, subjectType: true },
      })
    ).map((r) => [r.id, r.subjectType as string]),
  );
  const members = await activeMembers(tx, orgId);
  const prefs = await preferences(tx, [...members.keys()]);
  const withDevice = new Set(
    (
      await tx.pushDevice.findMany({
        where: { revokedAt: null, userId: { in: [...members.keys()] } },
        select: { userId: true },
      })
    ).map((d) => d.userId),
  );

  let created = 0;
  for (const a of alerts) {
    if (notificationsPaused(a.snoozedUntil, now)) continue;
    const stage = escalationStage(a.raisedAt, now, esc, false);
    if (stage === 'OWNER') continue;
    const daysOpen = -daysUntil(londonDate(a.raisedAt), now);
    const leadRole = LEAD_ROLE_BY_KIND[alertItemKind(a.sourceType, subjects.get(a.sourceId))];
    const reached: EscalatedStage[] = stage === 'MANAGER' ? ['LEAD', 'MANAGER'] : ['LEAD'];
    const rows: OutboxRow[] = [];
    for (const s of reached) {
      const after = s === 'LEAD' ? esc.leadAfterDays : esc.managerAfterDays;
      if (daysOpen - after > ESCALATION_CATCH_UP_DAYS) continue;
      const told = new Set<string>();
      for (const m of members.values()) {
        if (!stageTargets(s, leadRole, m.roleKeys)) continue;
        told.add(m.userId);
        // A deputy covering for the person today is told as well (A6 deputies).
        const deputy = activeDeputy(deputies, m.userId, today);
        if (deputy && members.has(deputy)) told.add(deputy);
      }
      if (a.ownerUserId) told.delete(a.ownerUserId);
      const msg = escalationMessage({
        stage: s,
        severity: a.severity,
        sourceType: a.sourceType,
        sourceId: a.sourceId,
        now,
      });
      for (const userId of told) {
        const p = prefs.get(userId) ?? { email: true, push: true };
        const wanted: OutboxChannel[] = [];
        if (channels.email && p.email) wanted.push('EMAIL');
        if (channels.push && p.push && withDevice.has(userId)) wanted.push('PUSH');
        for (const channel of wanted)
          rows.push({
            organisationId: orgId,
            alertId: a.id,
            escalationStage: s,
            recipientUserId: userId,
            channel,
            idempotencyKey: outboxKey(a.id, s, userId, channel),
            subject: msg.subject,
            body: msg.body,
            linkPath: msg.linkPath,
            nextAttemptAt: now,
            createdBy: SYSTEM_USER_ID,
          });
      }
    }
    if (rows.length === 0) continue;
    const r = await tx.notificationOutbox.createMany({ data: rows, skipDuplicates: true });
    created += r.count;
  }
  return { created };
}

export interface DrainOutcome {
  sent: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

export interface Senders {
  email?: NotificationSender;
  push?: NotificationSender;
}

/**
 * Sends due outbox rows. Success: SENT. Failure: retried with exponential backoff
 * (`retryDelayMinutes`) until MAX_DELIVERY_ATTEMPTS, then FAILED. Rows whose alert is no longer
 * open, whose recipient left or switched the channel off, or (push) who has no device are
 * CANCELLED. A snoozed alert's rows wait until the snooze ends. Delivery is at-least-once.
 */
export async function drainNotificationOutbox(
  tx: TenantTx,
  orgId: string,
  now: Date,
  senders: Senders,
  appUrl: string,
): Promise<DrainOutcome> {
  const out: DrainOutcome = { sent: 0, retrying: 0, failed: 0, cancelled: 0 };
  const due = await tx.notificationOutbox.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  if (due.length === 0) return out;

  const org = await tx.organisation.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  });
  const channels = orgChannels(org.settings);
  const alerts = new Map(
    (
      await tx.alert.findMany({
        where: { id: { in: [...new Set(due.map((r) => r.alertId))] } },
        select: { id: true, state: true, snoozedUntil: true },
      })
    ).map((a) => [a.id, a]),
  );
  const userIds = [...new Set(due.map((r) => r.recipientUserId))];
  const members = await activeMembers(tx, orgId);
  const users = new Map(
    (
      await tx.appUser.findMany({
        where: { id: { in: userIds } },
        select: { id: true, email: true, status: true },
      })
    ).map((u) => [u.id, u]),
  );
  const prefs = await preferences(tx, userIds);
  const loadDevices = async (userId: string) =>
    (
      await tx.pushDevice.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, kind: true, token: true },
      })
    ).map((d) => ({ id: d.id, kind: d.kind as 'EXPO' | 'WEB_PUSH', token: d.token }));

  const close = (
    id: string,
    status: 'CANCELLED' | 'FAILED',
    lastError: string,
    attempts?: number,
  ) =>
    tx.notificationOutbox.update({
      where: { id },
      data: { status, lastError, ...(attempts === undefined ? {} : { attempts }) },
    });

  for (const row of due) {
    const alert = alerts.get(row.alertId);
    if (!alert || alert.state !== 'OPEN') {
      await close(row.id, 'CANCELLED', 'NO_LONGER_OPEN');
      out.cancelled += 1;
      continue;
    }
    if (alert.snoozedUntil && notificationsPaused(alert.snoozedUntil, now)) {
      await tx.notificationOutbox.update({
        where: { id: row.id },
        data: { nextAttemptAt: alert.snoozedUntil },
      });
      continue;
    }
    const user = users.get(row.recipientUserId);
    if (!user || user.status !== 'ACTIVE' || !members.has(row.recipientUserId)) {
      await close(row.id, 'CANCELLED', 'RECIPIENT_UNAVAILABLE');
      out.cancelled += 1;
      continue;
    }
    const channel = row.channel as OutboxChannel;
    const pref = prefs.get(row.recipientUserId) ?? { email: true, push: true };
    const allowed = channel === 'EMAIL' ? channels.email && pref.email : channels.push && pref.push;
    if (!allowed) {
      await close(row.id, 'CANCELLED', 'OPTED_OUT');
      out.cancelled += 1;
      continue;
    }
    const devices = channel === 'PUSH' ? await loadDevices(row.recipientUserId) : [];
    if (channel === 'PUSH' && devices.length === 0) {
      await close(row.id, 'CANCELLED', 'NO_DEVICE');
      out.cancelled += 1;
      continue;
    }
    const sender = channel === 'EMAIL' ? senders.email : senders.push;
    const recipient: DeliveryRecipient = { userId: user.id, email: user.email, devices };
    const msg: OutboundMessage = {
      subject: row.subject,
      body: row.body,
      linkPath: row.linkPath,
      url: `${appUrl.replace(/\/$/, '')}${row.linkPath}`,
      alertId: row.alertId,
    };
    const outcome: SendOutcome = sender
      ? await sender.send(recipient, msg)
      : { ok: false, error: 'NO_SENDER' };
    if (outcome.invalidDeviceIds?.length)
      await tx.pushDevice.updateMany({
        where: { id: { in: outcome.invalidDeviceIds }, revokedAt: null },
        data: { revokedAt: now },
      });
    const attempts = row.attempts + 1;
    if (outcome.ok) {
      await tx.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: now, attempts, lastError: null },
      });
      out.sent += 1;
      continue;
    }
    const error = (outcome.error ?? 'ERROR').slice(0, 120);
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await close(row.id, 'FAILED', error, attempts);
      out.failed += 1;
      continue;
    }
    await tx.notificationOutbox.update({
      where: { id: row.id },
      data: {
        attempts,
        lastError: error,
        nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(attempts) * 60_000),
      },
    });
    out.retrying += 1;
  }
  return out;
}

/** Plans then drains escalation deliveries for every organisation (worker job). */
export async function escalationsAll(
  db: Db,
  now: Date,
  senders: Senders,
  appUrl: string,
  log?: (msg: string, ctx: object) => void,
): Promise<EscalationPlan & DrainOutcome> {
  const out = { created: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0 };
  for (const orgId of await db.listOrganisations()) {
    const ctx = { orgId, userId: SYSTEM_USER_ID };
    try {
      const p = await db.withTenant(ctx, (tx) => planEscalationDeliveries(tx, orgId, now));
      const d = await db.withTenant(ctx, (tx) =>
        drainNotificationOutbox(tx, orgId, now, senders, appUrl),
      );
      out.created += p.created;
      out.sent += d.sent;
      out.retrying += d.retrying;
      out.failed += d.failed;
      out.cancelled += d.cancelled;
    } catch (e) {
      log?.('escalation delivery failed', {
        orgId,
        error: e instanceof Error ? e.name : 'unknown',
      });
    }
  }
  return out;
}
