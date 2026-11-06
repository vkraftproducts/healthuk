import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { nextCode } from '@hub/domain';
import { eventTypesFor, londonDate, suggestObligations, triageDueAt, type Harm } from '@hub/rules';
import {
  AcceptSuggestionsInput,
  CandourStepInput,
  IncidentReportInput,
  LearningInput,
  TriageInput,
  type EventDetailDto,
  type MyReportDto,
} from '@hub/contracts';
import type { z } from 'zod';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { assertNotFuture, audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { complaintDates, EventsController } from './events.controller.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const REPORT = 'events.event.report';
const MANAGE = 'events.event.manage';
/** Told at once when someone is still at risk (WORKFLOWS H1). */
const AT_RISK_ROLES = ['REGISTERED_MANAGER', 'GOVERNANCE_LEAD'];

/**
 * Incident workflow (WORKFLOWS H1, H2, H5; finding 90): any staff member reports; a manager
 * triages within one working day, decides each suggested reporting duty, records candour steps
 * and the learning response. Patients are named only by job or booking reference.
 */
@Controller()
export class IncidentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Event types this organisation offers (IR(ME)R for dental, DoLS for care homes). */
  @RequirePermission(REPORT)
  @Get('incidents/types')
  async types(@Hub() hub: HubRequestContext): Promise<{ data: string[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => ({
      data: eventTypesFor(await packsOf(tx, hub.orgId as string)),
    }));
  }

  @RequirePermission(REPORT)
  @Post('incidents/report')
  async report(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(IncidentReportInput, raw);
    const now = new Date();
    const occurred = new Date(input.occurredAt);
    assertNotFuture(occurred, now);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const orgId = hub.orgId as string;
      if (!eventTypesFor(await packsOf(tx, orgId)).includes(input.kind))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'That type of report is not used in this organisation',
        );
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      if (input.photoItemIds.length) {
        const n = await tx.evidenceItem.count({ where: { id: { in: input.photoItemIds } } });
        if (n !== input.photoItemIds.length) throw notFound();
      }
      const leads = await leadsOf(tx);
      // The registered manager leads until triage names someone; the reporter if none is set up.
      const lead =
        leads.find((l) => l.role === 'REGISTERED_MANAGER')?.userId ??
        leads[0]?.userId ??
        hub.user.id;
      const dueAt = triageDueAt(now);
      const e = await tx.event.create({
        data: {
          organisationId: orgId,
          code: await nextCode(tx, orgId, 'EVT'),
          types: [input.kind],
          title: input.title,
          description: input.description,
          occurredAt: occurred,
          discoveredAt: now,
          locationId: input.locationId ?? null,
          severity: 'NO_HARM',
          leadUserId: lead,
          links: input.photoItemIds.map((id) => ({ type: 'EVIDENCE', id })),
          createdBy: hub.user.id,
          reportedBy: hub.user.id,
          place: input.place ?? null,
          peopleRefs: input.peopleRefs,
          immediateActions: input.immediateActions ?? null,
          stillAtRisk: input.stillAtRisk,
          nhsFunded: input.nhsFunded,
          triageDueAt: dueAt,
        },
      });
      await tx.eventTransition.create({
        data: {
          organisationId: orgId,
          eventId: e.id,
          fromStatus: null,
          toStatus: 'TRIAGE',
          note: 'Reported',
          byUserId: hub.user.id,
        },
      });
      if (input.complaint) {
        const t = await complaintDates(tx, orgId, input.complaint.receivedOn);
        await tx.complaintDetail.create({
          data: {
            eventId: e.id,
            organisationId: orgId,
            receivedOn: day(input.complaint.receivedOn),
            channel: input.complaint.channel,
            acknowledgeBy: day(t.acknowledgeBy),
            respondBy: day(t.respondBy),
            consentToShare: input.complaint.consentToShare,
            preferences: input.complaint.preferences ?? null,
          },
        });
      }
      let alerted = false;
      if (input.stillAtRisk) {
        // The reference only: no description, names or places in the alert or its deliveries.
        const alert = await tx.alert.create({
          data: {
            organisationId: orgId,
            sourceType: 'EVENT',
            sourceId: e.id,
            severity: 'CRITICAL',
            reasonCode: 'INCIDENT_STILL_AT_RISK',
            reasonText: `${e.code}: someone is still at risk. Open the report and act now.`,
            ownerUserId: lead,
            raisedAt: now,
          },
        });
        for (const l of leads)
          await tx.notificationDelivery.create({
            data: {
              organisationId: orgId,
              alertId: alert.id,
              channel: 'IN_APP',
              recipientUserId: l.userId,
              dedupeKey: `incident-at-risk:${e.id}:${l.userId}`,
            },
          });
        alerted = leads.length > 0;
      }
      // Restricted details never go into the audit summary.
      await audit(this.db, tx, hub, {
        action: 'events.event.report',
        entity: 'event',
        entityId: e.id,
        summary: {
          type: input.kind,
          stillAtRisk: input.stillAtRisk,
          people: input.peopleRefs.length,
        },
      });
      return {
        id: e.id,
        code: e.code,
        triageDueAt: dueAt.toISOString(),
        stillAtRiskAlerted: alerted,
        message: alerted
          ? `Report ${e.code} received. The registered manager and governance lead have ` +
            'been told someone is still at risk.'
          : `Report ${e.code} received. It will be triaged by the end of the next working day.`,
      };
    });
  }

  /** The reporter's own reports, with the status only (no other people's details). */
  @RequirePermission(REPORT)
  @Get('incidents/mine')
  async mine(@Hub() hub: HubRequestContext): Promise<{ data: z.infer<typeof MyReportDto>[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.event.findMany({
        where: { reportedBy: hub.user.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return {
        data: rows.map((e) => ({
          id: e.id,
          code: e.code,
          types: e.types,
          title: e.title,
          status: e.status,
          reportedAt: e.createdAt.toISOString(),
          triaged: !!e.triagedAt,
        })),
      };
    });
  }

  @RequirePermission(MANAGE)
  @Post('events/:id/triage')
  async triage(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(TriageInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      if (e.status !== 'TRIAGE')
        throw new HubError('CONFLICT', 409, 'Triage is recorded while the event is in triage');
      if (
        !(await tx.membership.count({
          where: { userId: input.leadUserId, validTo: null, user: { status: 'ACTIVE' } },
        }))
      )
        throw new HubError('VALIDATION_FAILED', 400, 'The lead is not an active member');
      if (input.linkedRiskIds.length) {
        const n = await tx.risk.count({ where: { id: { in: input.linkedRiskIds } } });
        if (n !== input.linkedRiskIds.length) throw notFound();
      }
      const links = [
        ...((e.links as { type: string; id: string }[]) ?? []),
        ...input.linkedRiskIds.map((rid) => ({ type: 'RISK', id: rid })),
      ];
      await tx.event.update({
        where: { id },
        data: {
          priority: input.priority,
          severity: input.harm,
          category: input.category,
          leadUserId: input.leadUserId,
          protectionSteps: input.protectionSteps,
          links: links as Prisma.InputJsonArray,
          ...(input.nhsFunded !== undefined ? { nhsFunded: input.nhsFunded } : {}),
          triagedAt: new Date(),
          triagedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.event.triage',
        entity: 'event',
        entityId: id,
        summary: { priority: input.priority, harm: input.harm, category: input.category },
      });
      return new EventsController(this.db).detail(tx, hub, id);
    });
  }

  /** Bodies that may need telling, worked out from type and harm. A person decides each one. */
  @RequirePermission(MANAGE)
  @Get('events/:id/obligation-suggestions')
  async suggestions(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id }, include: { obligations: true } });
      if (!e) throw notFound();
      const recorded = new Set(e.obligations.map((o) => o.body as string));
      return {
        data: suggestFor(e).map((s) => ({
          body: s.body,
          trigger: s.trigger,
          basis: s.basis,
          deadlineAt: s.deadlineAt?.toISOString() ?? null,
          deadlineText: s.deadlineText,
          draftText: s.draftText,
          recorded: recorded.has(s.body),
        })),
      };
    });
  }

  /** Adds the chosen suggestions as PENDING obligations; each still needs a decision. */
  @RequirePermission(MANAGE)
  @Post('events/:id/obligations/suggested')
  async acceptSuggestions(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(AcceptSuggestionsInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id }, include: { obligations: true } });
      if (!e) throw notFound();
      const recorded = new Set(e.obligations.map((o) => o.body as string));
      const all = suggestFor(e);
      for (const b of input.bodies) {
        const s = all.find((x) => x.body === b);
        if (!s)
          throw new HubError('VALIDATION_FAILED', 400, `${b} is not suggested for this event`);
        if (recorded.has(b)) continue;
        await tx.reportingObligation.create({
          data: {
            organisationId: e.organisationId,
            eventId: id,
            body: s.body,
            triggerText: s.trigger.slice(0, 500),
            basis: s.basis.slice(0, 500),
            deadlineAt: s.deadlineAt,
          },
        });
      }
      await audit(this.db, tx, hub, {
        action: 'events.obligation.add',
        entity: 'event',
        entityId: id,
        summary: { bodies: input.bodies.join(','), suggested: true },
      });
      return new EventsController(this.db).detail(tx, hub, id);
    });
  }

  /** Duty of candour steps, once the registered manager has decided candour applies. */
  @RequirePermission(MANAGE)
  @Post('events/:id/candour-steps')
  async candourStep(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(CandourStepInput, raw);
    if (input.doneOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      const decision = await tx.candourAssessment.findFirst({
        where: { eventId: id },
        orderBy: { decidedAt: 'desc' },
      });
      if (!decision?.notifiable)
        throw new HubError(
          'CONFLICT',
          409,
          'The registered manager must decide that duty of candour applies first',
        );
      if (await tx.eventCandourStep.count({ where: { eventId: id, step: input.step } }))
        throw new HubError('CONFLICT', 409, 'That step is already recorded');
      await tx.eventCandourStep.create({
        data: {
          organisationId: e.organisationId,
          eventId: id,
          step: input.step,
          doneOn: day(input.doneOn),
          note: input.note ?? null,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.candour.step',
        entity: 'event',
        entityId: id,
        summary: { step: input.step },
      });
      return new EventsController(this.db).detail(tx, hub, id);
    });
  }

  /** PSIRF learning response (required to close NHS-funded work). */
  @RequirePermission(MANAGE)
  @Post('events/:id/learning')
  async learning(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(LearningInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      if (e.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'The event is closed');
      await tx.event.update({
        where: { id },
        data: {
          learningResponse: input.response,
          learningNotes: input.notes,
          contributoryFactors: input.contributoryFactors ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.event.learning',
        entity: 'event',
        entityId: id,
        summary: { response: input.response },
      });
      return new EventsController(this.db).detail(tx, hub, id);
    });
  }
}

async function packsOf(tx: TenantTx, orgId: string): Promise<string[] | null> {
  const org = await tx.organisation.findUnique({
    where: { id: orgId },
    select: { sectorPacks: true },
  });
  return org?.sectorPacks ?? null;
}

/** Active registered managers and governance leads, registered manager first. */
async function leadsOf(tx: TenantTx): Promise<{ userId: string; role: string }[]> {
  const rows = await tx.membership.findMany({
    where: { validTo: null, user: { status: 'ACTIVE' }, role: { key: { in: AT_RISK_ROLES } } },
    select: { userId: true, role: { select: { key: true } } },
  });
  const seen = new Set<string>();
  return rows
    .map((r) => ({ userId: r.userId, role: r.role.key }))
    .sort((a, b) => AT_RISK_ROLES.indexOf(a.role) - AT_RISK_ROLES.indexOf(b.role))
    .filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
}

function suggestFor(e: {
  code: string;
  types: string[];
  severity: string;
  category: string | null;
  nhsFunded: boolean;
  occurredAt: Date;
  discoveredAt: Date;
}) {
  return suggestObligations({
    code: e.code,
    types: e.types,
    harm: e.severity as Harm,
    category: e.category,
    nhsFunded: e.nhsFunded,
    occurredAt: e.occurredAt,
    discoveredAt: e.discoveredAt,
  });
}
