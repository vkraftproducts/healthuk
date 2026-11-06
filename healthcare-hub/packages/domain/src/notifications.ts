import type { TenantTx } from '@hub/db';
import {
  MAX_DELIVERY_ATTEMPTS,
  alertLink,
  currentWarningWindow,
  dedupeKey,
  daysUntil,
  emailRolesForEvent,
  escalationTarget,
  londonDate,
  notificationsPaused,
  readNotificationRules,
  retryDelayMinutes,
  rolesForEvent,
  type ISODate,
  type NotificationEvent,
} from '@hub/rules';

export interface PlanOutcome {
  created: number;
  escalated: number;
}

const iso = (d: Date | null): ISODate | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Plans notification deliveries for open alerts (ALERT-04): deduplicated by (alert, channel,
 * window), owner first, then deputy, then the registered manager(s). Acknowledged and snoozed
 * alerts are skipped; their status is untouched (ALERT-03). Content is IDs and codes only.
 */
export async function planNotifications(
  tx: TenantTx,
  orgId: string,
  now: Date,
): Promise<PlanOutcome> {
  const org = await tx.organisation.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  });
  const settings = (org.settings ?? {}) as { emailReminders?: boolean; deputyEscalation?: boolean };
  const email = settings.emailReminders !== false;
  const deputyOn = settings.deputyEscalation !== false;
  const rules = readNotificationRules(org.settings);
  const alerts = await tx.alert.findMany({ where: { state: 'OPEN', sourceType: 'REQUIREMENT' } });
  const managers = await tx.membership.findMany({
    where: {
      organisationId: orgId,
      validTo: null,
      role: { key: 'REGISTERED_MANAGER' },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
  });
  const today = londonDate(now);
  let created = 0;
  let escalated = 0;

  const deliver = async (
    alertId: string,
    userId: string,
    channels: readonly ('IN_APP' | 'EMAIL')[],
    windowKey: string,
    escalatedTo: string | null,
  ) => {
    for (const channel of channels) {
      const r = await tx.notificationDelivery.createMany({
        data: [
          {
            organisationId: orgId,
            alertId,
            channel,
            recipientUserId: userId,
            dedupeKey: `${dedupeKey(alertId, channel, windowKey)}|${userId}`,
            escalatedTo,
          },
        ],
        skipDuplicates: true,
      });
      created += r.count;
    }
  };
  // Notification rules tell extra roles, in addition to the owner chain (OrgSettings).
  const ruleMembers = async (event: NotificationEvent) => {
    const roleKeys = rolesForEvent(rules, event);
    if (roleKeys.length === 0) return [];
    const emailRoles = emailRolesForEvent(rules, event);
    const rows = await tx.membership.findMany({
      where: {
        organisationId: orgId,
        validTo: null,
        role: { key: { in: roleKeys } },
        user: { status: 'ACTIVE' },
      },
      select: { userId: true, role: { select: { key: true } } },
    });
    const byUser = new Map<string, boolean>();
    for (const m of rows)
      byUser.set(m.userId, (byUser.get(m.userId) ?? false) || emailRoles.includes(m.role.key));
    return [...byUser].map(([userId, wantsEmail]) => ({
      userId,
      channels: email && wantsEmail ? (['IN_APP', 'EMAIL'] as const) : (['IN_APP'] as const),
    }));
  };
  const expiryRule = await ruleMembers('EXPIRY_WARNING');

  for (const a of alerts) {
    if (notificationsPaused(a.snoozedUntil, now)) continue;
    const inst = await tx.requirementInstance.findUnique({
      where: { id: a.sourceId },
      include: { templateVersion: true },
    });
    if (!inst) continue;

    // Window key: due-soon items notify once per warning threshold crossed; everything else daily.
    let windowKey: string = today;
    if (a.reasonCode === 'DUE_SOON') {
      const kind = inst.templateVersion.deadlineKind;
      const d = iso(
        kind === 'DUE' ? inst.dueDate : kind === 'EXPIRY' ? inst.expiryDate : inst.reviewDate,
      );
      const w = d
        ? currentWarningWindow(daysUntil(d, now), inst.templateVersion.warningDays)
        : null;
      if (w === null) continue; // inside the amber window but outside every configured warning threshold
      windowKey = `W${w}`;
    }

    const active = async (id: string | null): Promise<boolean> =>
      id
        ? (await tx.appUser.count({
            where: {
              id,
              status: 'ACTIVE',
              memberships: { some: { organisationId: orgId, validTo: null } },
            },
          })) > 0
        : false;
    const ownerOk = await active(inst.ownerUserId);
    const deputyOk = deputyOn && (await active(inst.deputyUserId));
    const target = escalationTarget({
      ownerAbsent: !ownerOk,
      deputyAbsent: !deputyOk,
      hasDeputy: deputyOn && inst.deputyUserId !== null,
    });
    const recipients =
      target === 'OWNER'
        ? [inst.ownerUserId as string]
        : target === 'DEPUTY'
          ? [inst.deputyUserId as string]
          : managers.map((m) => m.userId);
    if (target !== 'OWNER' && recipients.length > 0) escalated += 1;

    for (const userId of recipients)
      await deliver(
        a.id,
        userId,
        email ? ['IN_APP', 'EMAIL'] : ['IN_APP'],
        windowKey,
        target === 'OWNER' ? null : target,
      );
    for (const m of expiryRule)
      if (!recipients.includes(m.userId))
        await deliver(a.id, m.userId, m.channels, windowKey, 'RULE');
  }

  // Breach alerts reach only the roles a rule names; the breach itself is run from Settings.
  const breachRule = await ruleMembers('BREACH_RECORDED');
  if (breachRule.length > 0) {
    const breaches = await tx.alert.findMany({ where: { state: 'OPEN', sourceType: 'BREACH' } });
    for (const a of breaches) {
      if (notificationsPaused(a.snoozedUntil, now)) continue;
      for (const m of breachRule) await deliver(a.id, m.userId, m.channels, today, 'RULE');
    }
  }
  return { created, escalated };
}

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export interface DispatchOutcome {
  sent: number;
  failed: number;
  dead: number;
}

/** Delivers due notifications. Retries with backoff; after MAX_DELIVERY_ATTEMPTS the row is DEAD. */
export async function dispatchNotifications(
  tx: TenantTx,
  orgId: string,
  now: Date,
  mailer: Mailer,
  appUrl: string,
): Promise<DispatchOutcome> {
  const due = await tx.notificationDelivery.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
    include: { alert: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  const out: DispatchOutcome = { sent: 0, failed: 0, dead: 0 };
  for (const n of due) {
    if (n.channel === 'IN_APP') {
      await tx.notificationDelivery.update({
        where: { id: n.id },
        data: { status: 'SENT', sentAt: now, attempts: n.attempts + 1 },
      });
      out.sent += 1;
      continue;
    }
    const user = await tx.appUser.findUnique({
      where: { id: n.recipientUserId },
      select: { email: true, status: true },
    });
    try {
      if (!user || user.status !== 'ACTIVE') throw new Error('RECIPIENT_UNAVAILABLE');
      // No patient or staff names: the code and a link only (non-negotiable 7).
      const breach = n.alert.sourceType === 'BREACH';
      const what = breach ? 'A data protection breach' : 'A compliance item';
      const heading = breach ? 'Data protection breach' : 'Compliance item';
      const link =
        n.alert.sourceType === 'REQUIREMENT'
          ? `${appUrl}/compliance/requirements/${n.alert.sourceId}`
          : `${appUrl}${alertLink(n.alert.sourceType, n.alert.sourceId)}`;
      await mailer.send({
        to: user.email,
        subject: `${heading} needs attention (${n.alert.severity.toLowerCase()})`,
        text: `${what} needs attention: ${n.alert.reasonCode}.\nOpen it here: ${link}\n`,
      });
      await tx.notificationDelivery.update({
        where: { id: n.id },
        data: { status: 'SENT', sentAt: now, attempts: n.attempts + 1, lastError: null },
      });
      out.sent += 1;
    } catch (e) {
      const attempts = n.attempts + 1;
      const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
      await tx.notificationDelivery.update({
        where: { id: n.id },
        data: {
          status: dead ? 'DEAD' : 'FAILED',
          attempts,
          nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(attempts) * 60_000),
          lastError: (e instanceof Error ? e.message : 'ERROR').slice(0, 120),
        },
      });
      if (dead) out.dead += 1;
      else out.failed += 1;
    }
  }
  return out;
}
