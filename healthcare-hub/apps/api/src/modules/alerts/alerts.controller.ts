import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@hub/db';
import {
  AlertCentreQuery,
  DEFAULT_ITEM_RULES,
  SnoozeInput,
  type AlertCentreDto,
  type AlertCentreEvent,
  type AlertCentreItemDto,
  type AlertCentreReason,
  type AlertCountDto,
  type AlertDto,
  type OrgSettings,
} from '@hub/contracts';
import {
  INCIDENT_REPORTED_DAYS,
  POLICY_PUBLISHED_DAYS,
  alertEvent,
  alertItemKind,
  alertLink,
  compareCentreItems,
  coveringFor,
  escalationStage,
  londonDate,
  readNotificationRules,
  recipientReason,
  snoozeUntil,
  toldByRule,
  type NotificationEvent,
  type Recipient,
} from '@hub/rules';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MAX_SNOOZE_MS = 30 * 86_400_000;
const ListQuery = z.object({
  state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
});

const toDto = (a: {
  id: string;
  sourceType: string;
  sourceId: string;
  severity: AlertDto['severity'];
  reasonCode: string;
  reasonText: string;
  ownerUserId: string | null;
  state: AlertDto['state'];
  snoozedUntil: Date | null;
  snoozeReason?: string | null;
  raisedAt: Date;
  version: number;
}): AlertDto => ({
  snoozeReason: a.snoozeReason ?? null,
  id: a.id,
  sourceType: a.sourceType,
  sourceId: a.sourceId,
  severity: a.severity,
  reasonCode: a.reasonCode,
  reasonText: a.reasonText,
  ownerUserId: a.ownerUserId,
  state: a.state,
  snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
  raisedAt: a.raisedAt.toISOString(),
  version: a.version,
});

/** Who may see a stored alert through their role alone, by source. */
const ROLE_SEES: Record<string, readonly string[]> = {
  REQUIREMENT: ['compliance.requirement.view'],
  BREACH: ['privacy.manage'],
  RETENTION: ['privacy.manage'],
  DEFECT: ['fleet.defect.manage', 'fleet.return_to_service', 'jobs.allocate'],
  JOB: ['jobs.allocate'],
  STAFF: ['jobs.allocate', 'staff.profile.manage'],
};
const SOURCE_LABEL: Record<string, string> = {
  REQUIREMENT: 'Compliance item',
  BREACH: 'Data protection breach',
  RETENTION: 'Retention review',
  DEFECT: 'Vehicle or equipment defect',
  JOB: 'Job',
  STAFF: 'Staff member: check future shifts',
};
const WHY_RANK: Record<AlertCentreReason, number> = {
  OWNER: 0,
  DEPUTY: 1,
  NOTIFIED: 2,
  ESCALATED: 3,
  RULE: 4,
  ROLE: 5,
};
type Settings = Partial<Pick<OrgSettings, 'escalation' | 'deputies' | 'itemRules'>>;
const eventSeverity = (s: string): AlertCentreItemDto['severity'] =>
  s === 'SEVERE' || s === 'DEATH' ? 'CRITICAL' : s === 'MODERATE' ? 'HIGH' : 'MEDIUM';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Alerts are derived from requirement state; these endpoints only change notification behaviour (ALERT-03). */
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * The signed-in person's alerts centre. Every item says why the person sees it: they own it,
   * they were notified, a notification rule names their role, or their role covers that area.
   * Titles are codes or record titles only, never patient details.
   */
  @OrgMember()
  @Get('centre')
  async centre(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<AlertCentreDto> {
    const f = body(AlertCentreQuery, q);
    const me = hub.user.id;
    const now = new Date();
    const today = day(londonDate(now));
    const has = (keys: readonly string[]) => keys.some((k) => hub.permissions.has(k));
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const org = await tx.organisation.findUniqueOrThrow({
        where: { id: hub.orgId as string },
        select: { settings: true },
      });
      const rules = readNotificationRules(org.settings);
      const told = (e: NotificationEvent) => toldByRule(rules, e, hub.roleKeys);
      const cfg = (org.settings ?? {}) as Settings;
      const esc = cfg.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 };
      const itemRules = cfg.itemRules ?? DEFAULT_ITEM_RULES;
      // L2: a deputy sees what the person they cover owns, while the cover dates are in force.
      const covering = coveringFor(cfg.deputies ?? [], me, londonDate(now));
      const covers = (owner: string | null) => !!owner && covering.includes(owner);
      const items: AlertCentreItemDto[] = [];
      const why = (owner: boolean, rule: boolean, role: boolean): AlertCentreReason | null =>
        owner ? 'OWNER' : rule ? 'RULE' : role ? 'ROLE' : null;

      // Stored alerts (requirements, breaches, retention reviews, defects, jobs).
      const alerts = await tx.alert.findMany({
        where: { state: f.includeAcknowledged ? { not: 'RESOLVED' } : 'OPEN' },
        orderBy: { raisedAt: 'desc' },
        take: 500,
      });
      const notified = new Set(
        (
          await tx.notificationDelivery.findMany({
            where: {
              recipientUserId: me,
              channel: 'IN_APP',
              alertId: { in: alerts.map((a) => a.id) },
            },
            select: { alertId: true },
          })
        ).map((d) => d.alertId),
      );
      const reqIds = alerts.filter((a) => a.sourceType === 'REQUIREMENT').map((a) => a.sourceId);
      const reqs = new Map(
        (
          await tx.requirementInstance.findMany({
            where: { id: { in: reqIds } },
            select: {
              id: true,
              dueDate: true,
              expiryDate: true,
              subjectType: true,
              template: { select: { code: true, title: true } },
            },
          })
        ).map((r) => [r.id, r]),
      );
      const breachIds = alerts.filter((a) => a.sourceType === 'BREACH').map((a) => a.sourceId);
      const breaches = new Map(
        (
          await tx.breachRecord.findMany({
            where: { id: { in: breachIds } },
            select: { id: true, code: true },
          })
        ).map((b) => [b.id, b.code]),
      );
      const jobIds = alerts.filter((a) => a.sourceType === 'JOB').map((a) => a.sourceId);
      const jobs = new Map(
        (
          await tx.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, code: true } })
        ).map((j) => [j.id, j.code]),
      );
      for (const a of alerts) {
        const event = alertEvent(a.sourceType);
        const req = reqs.get(a.sourceId);
        const kind = alertItemKind(a.sourceType, req?.subjectType);
        const recipients = (itemRules.find((r) => r.kind === kind)?.recipients ?? [
          'OWNER',
          'LEAD',
        ]) as Recipient[];
        const stage = escalationStage(a.raisedAt, now, esc, a.state === 'ACKNOWLEDGED');
        const byRecipients = recipientReason({ kind, recipients, stage, roleKeys: hub.roleKeys });
        const reason: AlertCentreReason | null =
          a.ownerUserId === me
            ? 'OWNER'
            : covers(a.ownerUserId)
              ? 'DEPUTY'
              : notified.has(a.id)
                ? 'NOTIFIED'
                : byRecipients === 'ESCALATED'
                  ? 'ESCALATED'
                  : (event && told(event)) || byRecipients === 'RULE'
                    ? 'RULE'
                    : has(ROLE_SEES[a.sourceType] ?? [])
                      ? 'ROLE'
                      : null;
        if (!reason) continue;
        const code = req?.template.code ?? breaches.get(a.sourceId) ?? jobs.get(a.sourceId);
        const label = req?.template.title ?? SOURCE_LABEL[a.sourceType] ?? 'Alert';
        items.push({
          key: `${a.sourceType}:${a.sourceId}`,
          event: (event ?? 'OPERATIONS') as AlertCentreEvent,
          sourceType: a.sourceType,
          sourceId: a.sourceId,
          alertId: a.id,
          alertVersion: a.version,
          severity: a.severity,
          title: code ? `${code} – ${label}` : label,
          reasonText: a.reasonText,
          raisedAt: a.raisedAt.toISOString(),
          dueOn: isoDay(req?.dueDate ?? req?.expiryDate ?? null),
          state: a.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'OPEN',
          snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
          snoozeReason: a.snoozeReason ?? null,
          why: reason,
          link: alertLink(a.sourceType, a.sourceId),
        });
      }

      // Overdue actions.
      const actionRule = told('ACTION_OVERDUE');
      const actionRole = has(['compliance.action.manage', 'compliance.action.verify']);
      const actions = await tx.action.findMany({
        where: {
          status: { in: ['OPEN', 'REJECTED'] },
          deadline: { lt: today },
          ...(actionRule || actionRole ? {} : { ownerUserId: { in: [me, ...covering] } }),
        },
        orderBy: { deadline: 'asc' },
        take: 200,
      });
      for (const a of actions) {
        const w = covers(a.ownerUserId)
          ? 'DEPUTY'
          : why(a.ownerUserId === me, actionRule, actionRole);
        if (!w) continue;
        items.push({
          key: `ACTION:${a.id}`,
          event: 'ACTION_OVERDUE',
          sourceType: 'ACTION',
          sourceId: a.id,
          alertId: null,
          alertVersion: null,
          severity: a.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
          title: `${a.code} – ${a.title}`,
          reasonText: a.status === 'REJECTED' ? 'Overdue – evidence was rejected' : 'Overdue',
          raisedAt: a.deadline.toISOString(),
          dueOn: isoDay(a.deadline),
          state: 'OPEN',
          snoozedUntil: null,
          why: w,
          link: alertLink('ACTION', a.id),
        });
      }

      // Overdue audits.
      const auditRule = told('AUDIT_OVERDUE');
      const runs = await tx.auditRun.findMany({
        where: {
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          dueDate: { lt: today },
          ...(auditRule ? {} : { OR: [{ ownerUserId: me }, { auditorUserId: me }] }),
        },
        orderBy: { dueDate: 'asc' },
        take: 200,
      });
      for (const r of runs) {
        const w = why(r.ownerUserId === me || r.auditorUserId === me, auditRule, false);
        if (!w) continue;
        items.push({
          key: `AUDIT:${r.id}`,
          event: 'AUDIT_OVERDUE',
          sourceType: 'AUDIT',
          sourceId: r.id,
          alertId: null,
          alertVersion: null,
          severity: 'HIGH',
          title: `${r.code} – ${r.title}`,
          reasonText: r.status === 'SCHEDULED' ? 'Overdue – not started' : 'Overdue – not finished',
          raisedAt: r.dueDate.toISOString(),
          dueOn: isoDay(r.dueDate),
          state: 'OPEN',
          snoozedUntil: null,
          why: w,
          link: alertLink('AUDIT', r.id),
        });
      }

      // Newly reported incidents and events: code only, never the title or description.
      const eventRule = told('INCIDENT_REPORTED');
      const eventRole = has(['events.event.manage']);
      const since = new Date(now.getTime() - INCIDENT_REPORTED_DAYS * 86_400_000);
      const events = await tx.event.findMany({
        where: {
          createdAt: { gte: since },
          status: { not: 'CLOSED' },
          ...(eventRule || eventRole ? {} : { leadUserId: me }),
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, code: true, severity: true, leadUserId: true, createdAt: true },
      });
      for (const e of events) {
        const w = why(e.leadUserId === me, eventRule, eventRole);
        if (!w) continue;
        items.push({
          key: `EVENT:${e.id}`,
          event: 'INCIDENT_REPORTED',
          sourceType: 'EVENT',
          sourceId: e.id,
          alertId: null,
          alertVersion: null,
          severity: eventSeverity(e.severity),
          title: `${e.code} – New report`,
          reasonText: 'Reported recently – check it has been triaged',
          raisedAt: e.createdAt.toISOString(),
          dueOn: null,
          state: 'OPEN',
          snoozedUntil: null,
          why: w,
          link: alertLink('EVENT', e.id),
        });
      }

      // Newly published policies: owners, rule roles, and readers who have not acknowledged yet.
      const policyRule = told('POLICY_PUBLISHED');
      const published = await tx.policyVersion.findMany({
        where: {
          status: 'PUBLISHED',
          publishedAt: { gte: new Date(now.getTime() - POLICY_PUBLISHED_DAYS * 86_400_000) },
        },
        include: {
          document: { select: { code: true, title: true, ownerUserId: true, readerRoles: true } },
          acks: { where: { userId: me }, select: { id: true } },
        },
        orderBy: { publishedAt: 'desc' },
        take: 100,
      });
      for (const p of published) {
        const reader =
          p.acks.length === 0 &&
          hub.permissions.has('compliance.policy.acknowledge') &&
          (p.document.readerRoles.length === 0 ||
            p.document.readerRoles.some((k) => hub.roleKeys.includes(k)));
        const w = why(p.document.ownerUserId === me, policyRule, reader);
        if (!w) continue;
        items.push({
          key: `POLICY:${p.id}`,
          event: 'POLICY_PUBLISHED',
          sourceType: 'POLICY',
          sourceId: p.id,
          alertId: null,
          alertVersion: null,
          severity: 'LOW',
          title: `${p.document.code} – ${p.document.title} (version ${p.version})`,
          reasonText: reader ? 'Published – please read and acknowledge' : 'Published',
          raisedAt: (p.publishedAt as Date).toISOString(),
          dueOn: null,
          state: 'OPEN',
          snoozedUntil: null,
          why: w,
          link: alertLink('POLICY', p.id),
        });
      }

      const mine = rules.filter((r) => r.roleKeys.some((k) => hub.roleKeys.includes(k)));
      const roleRows = await tx.role.findMany({
        where: { key: { in: [...new Set(mine.flatMap((r) => r.roleKeys))] } },
        select: { key: true, name: true },
      });
      const roleName = new Map(roleRows.map((r) => [r.key, r.name]));
      const settings = (org.settings ?? {}) as { emailReminders?: boolean };
      const shown = f.event ? items.filter((i) => i.event === f.event) : items;
      return {
        items: shown.sort((a, b) => compareCentreItems(a, b) || WHY_RANK[a.why] - WHY_RANK[b.why]),
        rules: mine.map((r) => ({
          event: r.event,
          email: r.email,
          roleNames: r.roleKeys.map((k) => roleName.get(k) ?? k),
        })),
        emailReminders: settings.emailReminders !== false,
      };
    });
  }

  @RequirePermission('compliance.requirement.view')
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: AlertDto[] }> {
    const f = body(ListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.alert.findMany({
        where: {
          state: f.state ?? { not: 'RESOLVED' },
          ...(f.severity ? { severity: f.severity } : {}),
        },
        orderBy: [{ severity: 'asc' }, { raisedAt: 'desc' }],
        take: 200,
      }),
    );
    return { data: rows.map(toDto) };
  }

  @RequirePermission('compliance.requirement.manage')
  @Post(':id/acknowledge')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AlertDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.alert.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.state === 'RESOLVED')
        throw new HubError('CONFLICT', 409, 'The alert is already resolved');
      const u = await tx.alert.update({
        where: { id },
        data: { state: 'ACKNOWLEDGED', acknowledgedBy: hub.user.id, acknowledgedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'alerts.acknowledge',
        entity: 'alert',
        entityId: id,
      });
      return toDto(u);
    });
  }

  @RequirePermission('compliance.requirement.manage')
  @Post(':id/snooze')
  async snooze(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AlertDto> {
    const input = body(SnoozeInput, raw);
    const until = snoozeUntil(input.until);
    const now = Date.now();
    if (until.getTime() <= now || until.getTime() > now + MAX_SNOOZE_MS)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Snooze must end in the future and within 30 days',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.alert.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.state === 'RESOLVED')
        throw new HubError('CONFLICT', 409, 'The alert is already resolved');
      // Notifications pause; the underlying requirement status and its due date are untouched.
      const u = await tx.alert.update({
        where: { id },
        data: { snoozedUntil: until, snoozeReason: input.reason, snoozedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'alerts.snooze',
        entity: 'alert',
        entityId: id,
        summary: { until: until.toISOString(), reason: input.reason },
      });
      return toDto(u);
    });
  }

  /** L2: the number on the bell: what the centre shows as open and not snoozed. */
  @OrgMember()
  @Get('count')
  async count(@Hub() hub: HubRequestContext): Promise<AlertCountDto> {
    const centre = await this.centre(hub, {});
    const now = Date.now();
    const open = centre.items.filter(
      (i) => i.state === 'OPEN' && !(i.snoozedUntil && new Date(i.snoozedUntil).getTime() > now),
    );
    return {
      open: open.length,
      critical: open.filter((i) => i.severity === 'CRITICAL').length,
    };
  }
}
