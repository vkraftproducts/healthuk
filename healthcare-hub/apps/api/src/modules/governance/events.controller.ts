import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { createAction, nextCode, recomputeInstance } from '@hub/domain';
import {
  addDays,
  candourFlag,
  checkEventTransition,
  complaintTargets,
  londonDate,
  type EventStatus,
} from '@hub/rules';
import type { ObligationDto, PremisesDto } from '@hub/contracts';
import {
  CandourInput,
  ComplaintPatch,
  EventActionInput,
  EventCreate,
  EventListQuery,
  EventTransitionInput,
  ObligationInput,
  ObligationPatch,
  PremisesApplicability,
  PremisesCreate,
  type EventDetailDto,
  type EventDto,
} from '@hub/contracts';
import type { z } from 'zod';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import {
  assertNotFuture,
  audit,
  body,
  ifMatchVersion,
  requireAny,
  staleOrNotFound,
} from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { toActionDto } from './audits.controller.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const VIEW = 'events.event.view';
const MANAGE = 'events.event.manage';

function eventDto(e: Prisma.EventGetPayload<object>): EventDto {
  return {
    id: e.id,
    code: e.code,
    types: e.types as EventDto['types'],
    title: e.title,
    description: e.description,
    occurredAt: e.occurredAt.toISOString(),
    discoveredAt: e.discoveredAt.toISOString(),
    locationId: e.locationId,
    severity: e.severity,
    leadUserId: e.leadUserId,
    status: e.status,
    themes: e.themes,
    links: e.links as EventDto['links'],
    restricted: e.restricted,
    candourFlag: candourFlag(e.severity, e.types),
    version: e.version,
  };
}
const obligationDto = (
  o: Prisma.ReportingObligationGetPayload<object>,
  now: Date,
): z.infer<typeof ObligationDto> => ({
  id: o.id,
  body: o.body,
  trigger: o.triggerText,
  basis: o.basis,
  deadlineAt: o.deadlineAt?.toISOString() ?? null,
  decision: o.decision,
  decisionReason: o.decisionReason,
  submittedAt: o.submittedAt?.toISOString() ?? null,
  reference: o.reference,
  overdue: !!o.deadlineAt && o.deadlineAt < now && o.decision !== 'NOT_REQUIRED' && !o.submittedAt,
  version: o.version,
});

async function assertMember(tx: TenantTx, userId: string): Promise<void> {
  if (
    !(await tx.membership.count({ where: { userId, validTo: null, user: { status: 'ACTIVE' } } }))
  )
    throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
}

/**
 * One event record for incidents, accidents, near misses, safeguarding, complaints and defects
 * (EVT-01..04). Reporting duties are recorded one by one; candour is a person's decision.
 */
@Controller()
export class EventsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get('events')
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: EventDto[] }> {
    const f = body(EventListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.event.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.type ? { types: { has: f.type } } : {}),
          ...(f.open === 'true' ? { status: { not: 'CLOSED' } } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: 500,
      }),
    );
    return { data: rows.map(eventDto) };
  }

  @RequirePermission(MANAGE)
  @Post('events')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<EventDetailDto> {
    const input = body(EventCreate, raw);
    const now = new Date();
    const occurred = new Date(input.occurredAt);
    const discovered = input.discoveredAt ? new Date(input.discoveredAt) : now;
    assertNotFuture(occurred, now);
    assertNotFuture(discovered, now);
    if (discovered < occurred)
      throw new HubError('VALIDATION_FAILED', 400, 'Discovered before it occurred');
    if (input.types.includes('COMPLAINT') !== !!input.complaint)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Complaints need complaint details (and only complaints)',
      );
    if (input.types.includes('SAFEGUARDING') !== !!input.safeguarding)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Safeguarding events need case details (and only those)',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertMember(tx, input.leadUserId);
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      await this.assertLinks(tx, input.links);
      const orgId = hub.orgId as string;
      const e = await tx.event.create({
        data: {
          organisationId: orgId,
          code: await nextCode(tx, orgId, 'EVT'),
          types: input.types,
          title: input.title,
          description: input.description,
          occurredAt: occurred,
          discoveredAt: discovered,
          locationId: input.locationId ?? null,
          severity: input.severity,
          leadUserId: input.leadUserId,
          themes: input.themes,
          links: input.links as Prisma.InputJsonArray,
          createdBy: hub.user.id,
        },
      });
      await tx.eventTransition.create({
        data: {
          organisationId: orgId,
          eventId: e.id,
          fromStatus: null,
          toStatus: 'TRIAGE',
          note: 'Recorded',
          byUserId: hub.user.id,
        },
      });
      if (input.complaint) {
        const settings = ((await tx.organisation.findUniqueOrThrow({ where: { id: orgId } }))
          .settings ?? {}) as { complaintAcknowledgeDays?: number; complaintRespondDays?: number };
        const t = complaintTargets(input.complaint.receivedOn, {
          acknowledgeDays: settings.complaintAcknowledgeDays ?? 3,
          respondDays: settings.complaintRespondDays ?? 28,
        });
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
      if (input.safeguarding)
        await tx.safeguardingCase.create({
          data: {
            eventId: e.id,
            organisationId: orgId,
            details: input.safeguarding.details,
            agencies: input.safeguarding.agencies ?? null,
            referralRef: input.safeguarding.referralRef ?? null,
          },
        });
      // Restricted details never go into the audit summary.
      await audit(this.db, tx, hub, {
        action: 'events.event.create',
        entity: 'event',
        entityId: e.id,
        summary: { types: input.types.join(','), severity: input.severity },
      });
      return this.detail(tx, hub, e.id);
    });
  }

  @RequirePermission(VIEW)
  @Get('events/:id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<EventDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.event.count({ where: { id } }))) throw notFound();
      const d = await this.detail(tx, hub, id);
      if (d.restricted && hub.permissions.has('events.safeguarding.view'))
        await audit(this.db, tx, hub, {
          action: 'events.safeguarding.view',
          entity: 'event',
          entityId: id,
        });
      return d;
    });
  }

  @RequirePermission(MANAGE)
  @Post('events/:id/transition')
  async transition(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(EventTransitionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      const refusal = checkEventTransition({
        from: e.status as EventStatus,
        to: input.to,
        pendingObligations: await tx.reportingObligation.count({
          where: { eventId: id, decision: 'PENDING' },
        }),
        candourFlagged: candourFlag(e.severity, e.types),
        candourDecided: (await tx.candourAssessment.count({ where: { eventId: id } })) > 0,
        openActions: await tx.action.count({
          where: { sourceType: 'EVENT', sourceId: id, status: { not: 'VERIFIED' } },
        }),
      });
      const text: Record<string, string> = {
        NOT_ALLOWED: 'Events move one step at a time',
        OBLIGATIONS_UNDECIDED: 'Record a decision for every reporting obligation first',
        CANDOUR_UNDECIDED:
          'A duty of candour decision is needed first (the system flagged this event)',
        ACTIONS_OPEN: 'Actions must be verified before learning can be confirmed',
      };
      if (refusal) throw new HubError('TRANSITION_NOT_ALLOWED', 422, text[refusal]);
      await tx.eventTransition.create({
        data: {
          organisationId: e.organisationId,
          eventId: id,
          fromStatus: e.status,
          toStatus: input.to,
          note: input.note,
          byUserId: hub.user.id,
        },
      });
      await tx.event.update({ where: { id }, data: { status: input.to } });
      await audit(this.db, tx, hub, {
        action: 'events.event.transition',
        entity: 'event',
        entityId: id,
        summary: { from: e.status, to: input.to },
      });
      return this.detail(tx, hub, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post('events/:id/obligations')
  async addObligation(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(ObligationInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      if (await tx.reportingObligation.findFirst({ where: { eventId: id, body: input.body } }))
        throw new HubError('CONFLICT', 409, 'Already recorded for that body');
      const o = await tx.reportingObligation.create({
        data: {
          organisationId: e.organisationId,
          eventId: id,
          body: input.body,
          triggerText: input.trigger,
          basis: input.basis,
          deadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.obligation.add',
        entity: 'reporting_obligation',
        entityId: o.id,
        summary: { body: input.body },
      });
      return obligationDto(o, new Date());
    });
  }

  @RequirePermission(MANAGE)
  @Patch('obligations/:id')
  async patchObligation(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const expected = ifMatchVersion(req);
    const input = body(ObligationPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await tx.reportingObligation.findUnique({ where: { id } });
      if (!o) throw notFound();
      if (input.decision && !input.decisionReason)
        throw new HubError('VALIDATION_FAILED', 400, 'A decision needs a reason');
      const decision = input.decision ?? o.decision;
      if ((input.submittedAt || input.reference) && decision !== 'REQUIRED')
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Only a required notification can be submitted',
        );
      if (input.submittedAt) assertNotFuture(new Date(input.submittedAt), new Date());
      if (
        input.receiptItemId &&
        !(await tx.evidenceItem.count({ where: { id: input.receiptItemId } }))
      )
        throw notFound();
      const r = await tx.reportingObligation.updateMany({
        where: { id, version: expected },
        data: {
          ...(input.decision
            ? {
                decision: input.decision,
                decisionReason: input.decisionReason,
                decidedBy: hub.user.id,
              }
            : {}),
          ...(input.submittedAt ? { submittedAt: new Date(input.submittedAt) } : {}),
          ...(input.reference ? { reference: input.reference } : {}),
          ...(input.receiptItemId ? { receiptItemId: input.receiptItemId } : {}),
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'events.obligation.update',
        entity: 'reporting_obligation',
        entityId: id,
        summary: { decision, submitted: !!input.submittedAt },
      });
      return obligationDto(
        await tx.reportingObligation.findUniqueOrThrow({ where: { id } }),
        new Date(),
      );
    });
  }

  @RequirePermission('events.candour.decide')
  @Post('events/:id/candour-assessment')
  async candour(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const input = body(CandourInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      await tx.candourAssessment.create({
        data: {
          organisationId: e.organisationId,
          eventId: id,
          notifiable: input.notifiable,
          reason: input.reason,
          decidedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.candour.decide',
        entity: 'event',
        entityId: id,
        summary: { notifiable: input.notifiable },
      });
      return this.detail(tx, hub, id);
    });
  }

  @RequirePermission(MANAGE)
  @Patch('events/:id/complaint')
  async complaint(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EventDetailDto> {
    const expected = ifMatchVersion(req);
    const input = body(ComplaintPatch, raw);
    const today = londonDate(new Date());
    if (
      (input.acknowledgedOn && input.acknowledgedOn > today) ||
      (input.respondedOn && input.respondedOn > today)
    )
      throw new HubError('VALIDATION_FAILED', 400, 'Dates cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.complaintDetail.updateMany({
        where: { eventId: id, version: expected },
        data: {
          ...(input.acknowledgedOn ? { acknowledgedOn: day(input.acknowledgedOn) } : {}),
          ...(input.respondedOn ? { respondedOn: day(input.respondedOn) } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
          ...(input.escalationRightsGiven !== undefined
            ? { escalationRightsGiven: input.escalationRightsGiven }
            : {}),
        },
      });
      if (r.count === 0)
        throw staleOrNotFound((await tx.complaintDetail.count({ where: { eventId: id } })) > 0);
      await audit(this.db, tx, hub, {
        action: 'events.complaint.update',
        entity: 'event',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.detail(tx, hub, id);
    });
  }

  @OrgMember()
  @Post('events/:id/actions')
  async action(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    requireAny(hub, MANAGE, 'compliance.action.manage');
    const input = body(EventActionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.event.findUnique({ where: { id } });
      if (!e) throw notFound();
      await assertMember(tx, input.ownerUserId);
      const sev =
        input.severity ??
        (e.severity === 'SEVERE' || e.severity === 'DEATH'
          ? 'CRITICAL'
          : e.severity === 'MODERATE'
            ? 'HIGH'
            : 'MEDIUM');
      const a = await createAction(tx, {
        organisationId: e.organisationId,
        sourceType: 'EVENT',
        sourceId: id,
        title: input.title,
        severity: sev,
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { eventId: id },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }

  // ---- premises (HSE-01) ---------------------------------------------------------------------
  @RequirePermission('premises.item.view')
  @Get('premises-items')
  async premises(@Hub() hub: HubRequestContext) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.premisesItem.findMany({
        orderBy: [{ locationId: 'asc' }, { controlArea: 'asc' }],
      });
      return { data: await Promise.all(rows.map((r) => premisesDto(tx, r))) };
    });
  }

  @RequirePermission('premises.item.manage')
  @Post('premises-items')
  async addPremises(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(PremisesCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const loc = await tx.location.findUnique({ where: { id: input.locationId } });
      if (!loc) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(loc.id)) throw notFound();
      await assertMember(tx, input.responsibleUserId);
      let instanceId: string | null = null;
      if (input.templateId) {
        const v = await tx.requirementTemplateVersion.findFirst({
          where: { templateId: input.templateId, status: 'EFFECTIVE', organisationId: hub.orgId },
        });
        if (!v) throw new HubError('TEMPLATE_NOT_PUBLISHED', 422, 'Publish the template first');
        if (v.subjectType !== 'PREMISES')
          throw new HubError('VALIDATION_FAILED', 400, 'Use a premises requirement template');
        const existing = await tx.requirementInstance.findFirst({
          where: { templateId: input.templateId, subjectType: 'PREMISES', subjectId: loc.id },
        });
        const inst =
          existing ??
          (await tx.requirementInstance.create({
            data: {
              organisationId: loc.organisationId,
              templateId: input.templateId,
              templateVersionId: v.id,
              subjectType: 'PREMISES',
              subjectId: loc.id,
              locationId: loc.id,
              ownerUserId: input.responsibleUserId,
              createdBy: hub.user.id,
            },
          }));
        if (!existing) await recomputeInstance(tx, inst.id, new Date());
        instanceId = inst.id;
      }
      const p = await tx.premisesItem.create({
        data: {
          organisationId: loc.organisationId,
          locationId: loc.id,
          controlArea: input.controlArea,
          title: input.title,
          responsibleUserId: input.responsibleUserId,
          frequencySource: input.frequencySource,
          requirementInstanceId: instanceId,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'premises.item.create',
        entity: 'premises_item',
        entityId: p.id,
        summary: { area: input.controlArea },
      });
      return premisesDto(tx, p);
    });
  }

  /** Not-applicable needs a reason and a decider; the linked requirement records the same decision. */
  @RequirePermission('premises.item.manage')
  @Post('premises-items/:id/applicability')
  async applicability(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(PremisesApplicability, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      await tx.premisesItem.update({
        where: { id },
        data: {
          applicable: input.applicable,
          applicabilityReason: input.reason,
          decidedBy: hub.user.id,
        },
      });
      if (p.requirementInstanceId) {
        const decision = input.applicable ? 'APPLICABLE' : 'APPROVED_NOT_APPLICABLE';
        await tx.applicabilityDecision.create({
          data: {
            organisationId: p.organisationId,
            instanceId: p.requirementInstanceId,
            decision,
            reason: input.reason,
            reviewerId: hub.user.id,
            reviewDate: day(addDays(londonDate(new Date()), 365)),
          },
        });
        await tx.requirementInstance.update({
          where: { id: p.requirementInstanceId },
          data: { applicability: decision },
        });
        await recomputeInstance(tx, p.requirementInstanceId, new Date());
      }
      await audit(this.db, tx, hub, {
        action: 'premises.item.applicability',
        entity: 'premises_item',
        entityId: id,
        summary: { applicable: input.applicable },
      });
      return premisesDto(tx, await tx.premisesItem.findUniqueOrThrow({ where: { id } }));
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------
  private async assertLinks(tx: TenantTx, links: { type: string; id: string }[]) {
    for (const l of links) {
      const n =
        l.type === 'STAFF'
          ? await tx.staff.count({ where: { id: l.id } })
          : l.type === 'VEHICLE'
            ? await tx.vehicle.count({ where: { id: l.id } })
            : l.type === 'EQUIPMENT'
              ? await tx.equipmentAsset.count({ where: { id: l.id } })
              : l.type === 'EVENT'
                ? await tx.event.count({ where: { id: l.id } })
                : 1; // JOB links are checked once jobs exist (M6)
      if (!n) throw notFound();
    }
  }

  private async detail(tx: TenantTx, hub: HubRequestContext, id: string): Promise<EventDetailDto> {
    const e = await tx.event.findUniqueOrThrow({
      where: { id },
      include: {
        transitions: { orderBy: { at: 'asc' } },
        obligations: { orderBy: { createdAt: 'asc' } },
        candour: { orderBy: { decidedAt: 'asc' } },
        complaint: true,
        safeguarding: true,
      },
    });
    const actions = await tx.action.findMany({
      where: { sourceType: 'EVENT', sourceId: id },
      include: { history: true },
    });
    const now = new Date();
    const sg = hub.permissions.has('events.safeguarding.view') ? e.safeguarding : null;
    return {
      ...eventDto(e),
      transitions: e.transitions.map((t) => ({
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        note: t.note,
        byUserId: t.byUserId,
        at: t.at.toISOString(),
      })),
      obligations: e.obligations.map((o) => obligationDto(o, now)),
      candour: e.candour.map((c) => ({
        notifiable: c.notifiable,
        reason: c.reason,
        decidedBy: c.decidedBy,
        decidedAt: c.decidedAt.toISOString(),
      })),
      complaint: e.complaint
        ? {
            receivedOn: iso(e.complaint.receivedOn) as string,
            channel: e.complaint.channel,
            acknowledgeBy: iso(e.complaint.acknowledgeBy) as string,
            respondBy: iso(e.complaint.respondBy) as string,
            acknowledgedOn: iso(e.complaint.acknowledgedOn),
            respondedOn: iso(e.complaint.respondedOn),
            consentToShare: e.complaint.consentToShare,
            outcome: e.complaint.outcome,
            escalationRightsGiven: e.complaint.escalationRightsGiven,
            version: e.complaint.version,
          }
        : null,
      safeguarding: sg
        ? {
            details: sg.details,
            agencies: sg.agencies,
            referralRef: sg.referralRef,
            outcome: sg.outcome,
          }
        : null,
      actions: actions.map((a) => toActionDto(a, now)),
    };
  }
}

async function premisesDto(
  tx: TenantTx,
  p: Prisma.PremisesItemGetPayload<object>,
): Promise<z.infer<typeof PremisesDto>> {
  const i = p.requirementInstanceId
    ? await tx.requirementInstance.findUnique({ where: { id: p.requirementInstanceId } })
    : null;
  return {
    id: p.id,
    locationId: p.locationId,
    controlArea: p.controlArea,
    title: p.title,
    responsibleUserId: p.responsibleUserId,
    frequencySource: p.frequencySource,
    requirementInstanceId: p.requirementInstanceId,
    applicable: p.applicable,
    applicabilityReason: p.applicabilityReason,
    status: !p.applicable ? ('NOT_APPLICABLE' as const) : (i?.status ?? ('GREY' as const)),
    reasonText: !p.applicable
      ? 'Approved as not applicable'
      : (i?.reasonText ?? 'No schedule linked yet'),
    nextDue: i ? iso(i.dueDate ?? i.expiryDate ?? i.reviewDate) : null,
    version: p.version,
  };
}
