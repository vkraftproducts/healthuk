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
  CANDOUR_STEP_TEXT,
  candourFlag,
  candourOutstanding,
  checkEventTransition,
  COMPLAINT_ACK_WORKING_DAYS,
  COMPLAINT_RESPONSE_WORKING_DAYS,
  complaintEscalationText,
  complaintTargets,
  complaintTargetsWorking,
  incidentCloseBlockers,
  isOverdue,
  londonDate,
  premisesIntervalStatus,
  type CandourStep,
  type EventStatus,
} from '@hub/rules';
import type { ObligationDto, PremisesDto, PremisesHistoryDto } from '@hub/contracts';
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
  PremisesFindingInput,
  PremisesPatch,
  PremisesSchedule,
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
import { userNames } from '../evidence/evidence.mapper.js';
import { toActionDto, withActionNames } from './audits.controller.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const VIEW = 'events.event.view';
const MANAGE = 'events.event.manage';

function eventDto(
  e: Prisma.EventGetPayload<object>,
  names: Map<string, string>,
  candourDecided: boolean,
): EventDto {
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
    leadName: names.get(e.leadUserId) ?? null,
    status: e.status,
    themes: e.themes,
    links: e.links as EventDto['links'],
    restricted: e.restricted,
    candourFlag: candourFlag(e.severity, e.types),
    candourDecided,
    hrRestricted: e.hrRestricted,
    reportedByName: e.reportedBy ? (names.get(e.reportedBy) ?? null) : null,
    place: e.place,
    peopleRefs: e.peopleRefs,
    immediateActions: e.immediateActions,
    stillAtRisk: e.stillAtRisk,
    nhsFunded: e.nhsFunded,
    category: e.category,
    priority: e.priority,
    protectionSteps: e.protectionSteps,
    triageDueAt: e.triageDueAt?.toISOString() ?? null,
    triagedAt: e.triagedAt?.toISOString() ?? null,
    triagedByName: e.triagedBy ? (names.get(e.triagedBy) ?? null) : null,
    triageOverdue: !!e.triageDueAt && !e.triagedAt && e.triageDueAt < new Date(),
    learningResponse: e.learningResponse,
    learningNotes: e.learningNotes,
    contributoryFactors: e.contributoryFactors,
    version: e.version,
  };
}

/** Reported through the any-role form: triage must be recorded before the event moves on. */
export const needsTriage = (e: { reportedBy: string | null; triagedAt: Date | null }) =>
  e.reportedBy !== null && e.triagedAt === null;

/** Complaint targets: org settings in calendar days when set, otherwise 3 and 20 working days. */
export async function complaintDates(
  tx: TenantTx,
  orgId: string,
  receivedOn: string,
): Promise<{ acknowledgeBy: string; respondBy: string }> {
  const settings = ((await tx.organisation.findUniqueOrThrow({ where: { id: orgId } })).settings ??
    {}) as { complaintAcknowledgeDays?: number; complaintRespondDays?: number };
  if (settings.complaintAcknowledgeDays || settings.complaintRespondDays)
    return complaintTargets(receivedOn, {
      acknowledgeDays: settings.complaintAcknowledgeDays ?? 3,
      respondDays: settings.complaintRespondDays ?? 28,
    });
  return complaintTargetsWorking(receivedOn, {
    acknowledgeWorkingDays: COMPLAINT_ACK_WORKING_DAYS,
    respondWorkingDays: COMPLAINT_RESPONSE_WORKING_DAYS,
  });
}
const obligationDto = (
  o: Prisma.ReportingObligationGetPayload<object>,
  now: Date,
  names: Map<string, string> = new Map(),
): z.infer<typeof ObligationDto> => ({
  id: o.id,
  body: o.body,
  trigger: o.triggerText,
  basis: o.basis,
  deadlineAt: o.deadlineAt?.toISOString() ?? null,
  decision: o.decision,
  decisionReason: o.decisionReason,
  decidedByName: o.decidedBy ? (names.get(o.decidedBy) ?? null) : null,
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
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.event.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.type ? { types: { has: f.type } } : {}),
          ...(f.open === 'true' ? { status: { not: 'CLOSED' } } : {}),
          ...(f.open === 'false' ? { status: 'CLOSED' } : {}),
        },
        include: { candour: { select: { id: true }, take: 1 } },
        orderBy: { occurredAt: 'desc' },
        take: 500,
      });
      const names = await userNames(
        tx,
        rows.flatMap((e) => [e.leadUserId, e.reportedBy, e.triagedBy]),
      );
      return { data: rows.map((e) => eventDto(e, names, e.candour.length > 0)) };
    });
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
      if (d.hrRestricted)
        await audit(this.db, tx, hub, {
          action: 'events.harassment.view',
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
      const latestCandour = await tx.candourAssessment.findFirst({
        where: { eventId: id },
        orderBy: { decidedAt: 'desc' },
      });
      const steps = await tx.eventCandourStep.findMany({
        where: { eventId: id },
        select: { step: true },
      });
      const refusal = checkEventTransition({
        from: e.status as EventStatus,
        to: input.to,
        pendingObligations: await tx.reportingObligation.count({
          where: { eventId: id, decision: 'PENDING' },
        }),
        candourFlagged: candourFlag(e.severity, e.types),
        candourDecided: !!latestCandour,
        openActions: await tx.action.count({
          where: { sourceType: 'EVENT', sourceId: id, status: { not: 'VERIFIED' } },
        }),
        triaged: !needsTriage(e),
        candourStepsOutstanding: candourOutstanding(
          latestCandour?.notifiable ?? null,
          steps.map((s) => s.step),
        ).length,
        learningResponseMissing: e.nhsFunded && !e.learningResponse,
      });
      const text: Record<string, string> = {
        NOT_ALLOWED: 'Events move one step at a time',
        OBLIGATIONS_UNDECIDED: 'Record a decision for every reporting obligation first',
        CANDOUR_UNDECIDED:
          'A duty of candour decision is needed first (the system flagged this event)',
        ACTIONS_OPEN: 'Actions must be verified before learning can be confirmed',
        NOT_TRIAGED: 'Record the triage (priority, harm, category, lead, protection steps) first',
        CANDOUR_INCOMPLETE: 'Record every duty of candour step before closing',
        LEARNING_RESPONSE_MISSING: 'NHS-funded work needs a PSIRF learning response recorded first',
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
      const updated = await tx.reportingObligation.findUniqueOrThrow({ where: { id } });
      return obligationDto(updated, new Date(), await userNames(tx, [updated.decidedBy]));
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
    if (input.reopenReason && (input.respondedOn || input.outcome))
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Reopening clears the response; record the new response afterwards',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const current = await tx.complaintDetail.findUnique({ where: { eventId: id } });
      if (input.reopenReason && current && !current.respondedOn)
        throw new HubError(
          'CONFLICT',
          409,
          'Only a complaint that has been responded to can reopen',
        );
      if (input.outcome && !(input.respondedOn ?? current?.respondedOn))
        throw new HubError('VALIDATION_FAILED', 400, 'Record the response date with the outcome');
      const r = await tx.complaintDetail.updateMany({
        where: { eventId: id, version: expected },
        data: {
          ...(input.acknowledgedOn ? { acknowledgedOn: day(input.acknowledgedOn) } : {}),
          ...(input.respondedOn ? { respondedOn: day(input.respondedOn) } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
          ...(input.escalationRightsGiven !== undefined
            ? { escalationRightsGiven: input.escalationRightsGiven }
            : {}),
          ...(input.reopenReason ? { respondedOn: null, outcome: null } : {}),
        },
      });
      if (r.count === 0) throw staleOrNotFound(!!current);
      if (input.reopenReason) {
        const e = await tx.event.findUniqueOrThrow({ where: { id } });
        // History stays: the reopening is a transition back to INVESTIGATE with the reason.
        if (e.status !== 'INVESTIGATE') {
          await tx.eventTransition.create({
            data: {
              organisationId: e.organisationId,
              eventId: id,
              fromStatus: e.status,
              toStatus: 'INVESTIGATE',
              note: `Complaint reopened: ${input.reopenReason}`,
              byUserId: hub.user.id,
            },
          });
          await tx.event.update({ where: { id }, data: { status: 'INVESTIGATE' } });
        }
      }
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
      if (input.actionOwnerUserId) await assertMember(tx, input.actionOwnerUserId);
      // An administration-only base does not get clinical infection-control items by default.
      if (
        loc.type === 'ADMIN_ONLY' &&
        input.controlArea === 'COSHH_INFECTION' &&
        !input.confirmClinicalControl
      )
        throw new HubError(
          'VALIDATION_FAILED',
          422,
          'This is an administration-only location. Confirm that infection-control items apply here.',
        );
      const instanceId = input.templateId
        ? await premisesInstance(tx, hub, loc, input.templateId, input.responsibleUserId)
        : null;
      const p = await tx.premisesItem.create({
        data: {
          organisationId: loc.organisationId,
          locationId: loc.id,
          controlArea: input.controlArea,
          areaName: input.areaName ?? null,
          title: input.title,
          responsibleUserId: input.responsibleUserId,
          frequencySource: input.frequencySource,
          intervalMonths: input.intervalMonths ?? null,
          requirementInstanceId: instanceId,
          // "Same as responsible person" is stored as that person, so the register names them.
          actionOwnerUserId: input.actionOwnerUserId ?? input.responsibleUserId,
          contractorName: input.contractorName ?? null,
          assessmentRef: input.assessmentRef ?? null,
          assessedOn: input.assessedOn ? day(input.assessedOn) : null,
          createdBy: hub.user.id,
        },
      });
      await premisesHistory(tx, hub, p, 'CREATED', 'Item added to the register', null, {
        title: p.title,
        area: p.areaName,
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
    const today = londonDate(new Date());
    if (input.reviewOn && input.reviewOn <= today)
      throw new HubError('VALIDATION_FAILED', 400, 'The review date must be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(p.locationId)) throw notFound();
      if (input.reviewerId) await assertMember(tx, input.reviewerId);
      const reviewerId = input.reviewerId ?? hub.user.id;
      const reviewOn = input.reviewOn ?? addDays(today, 365);
      await tx.premisesItem.update({
        where: { id },
        data: {
          applicable: input.applicable,
          applicabilityReason: input.reason,
          decidedBy: hub.user.id,
          applicabilityReviewerId: reviewerId,
          applicabilityReviewOn: day(reviewOn),
        },
      });
      await premisesHistory(
        tx,
        hub,
        p,
        'APPLICABILITY',
        input.applicable ? 'Marked as applying' : `Not applicable: ${input.reason}`,
        { applicable: p.applicable },
        { applicable: input.applicable, reviewerId, reviewOn },
      );
      if (p.requirementInstanceId) {
        const decision = input.applicable ? 'APPLICABLE' : 'APPROVED_NOT_APPLICABLE';
        await tx.applicabilityDecision.create({
          data: {
            organisationId: p.organisationId,
            instanceId: p.requirementInstanceId,
            decision,
            reason: input.reason,
            reviewerId,
            reviewDate: day(reviewOn),
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

  @RequirePermission('premises.item.manage')
  @Patch('premises-items/:id')
  async patchPremises(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const expected = ifMatchVersion(req);
    const input = body(PremisesPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(p.locationId)) throw notFound();
      if (input.responsibleUserId) await assertMember(tx, input.responsibleUserId);
      if (input.actionOwnerUserId) await assertMember(tx, input.actionOwnerUserId);
      const r = await tx.premisesItem.updateMany({
        where: { id, version: expected },
        data: {
          ...input,
          ...(input.assessedOn !== undefined
            ? { assessedOn: input.assessedOn ? day(input.assessedOn) : null }
            : {}),
          updatedAt: new Date(),
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      const keys = Object.keys(input) as (keyof typeof input)[];
      const was = p as unknown as Record<string, unknown>;
      await premisesHistory(
        tx,
        hub,
        p,
        'EDITED',
        `Changed: ${keys.join(', ')}`,
        Object.fromEntries(
          keys.map((k) => [k, was[k] instanceof Date ? iso(was[k] as Date) : (was[k] ?? null)]),
        ),
        Object.fromEntries(keys.map((k) => [k, input[k] ?? null])),
      );
      // The linked requirement follows the responsible person, so its alerts reach them.
      if (input.responsibleUserId && p.requirementInstanceId)
        await tx.requirementInstance.update({
          where: { id: p.requirementInstanceId },
          data: { ownerUserId: input.responsibleUserId, updatedBy: hub.user.id },
        });
      await audit(this.db, tx, hub, {
        action: 'premises.item.update',
        entity: 'premises_item',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return premisesDto(tx, await tx.premisesItem.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Link a schedule to an item saved without one, with its first due date (finding 65). */
  @RequirePermission('premises.item.manage')
  @Post('premises-items/:id/schedule')
  async schedulePremises(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(PremisesSchedule, raw);
    if (input.dueDate && input.dueDate < londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The first due date cannot be in the past');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(p.locationId)) throw notFound();
      if (p.requirementInstanceId)
        throw new HubError('CONFLICT', 409, 'This item already has a schedule');
      const loc = await tx.location.findUniqueOrThrow({ where: { id: p.locationId } });
      const instanceId = await premisesInstance(
        tx,
        hub,
        loc,
        input.templateId,
        p.responsibleUserId,
        input.dueDate,
      );
      await tx.premisesItem.update({
        where: { id },
        data: { requirementInstanceId: instanceId, updatedAt: new Date() },
      });
      await premisesHistory(tx, hub, p, 'SCHEDULE', 'Requirement linked', null, {
        templateId: input.templateId,
        dueDate: input.dueDate ?? null,
      });
      await audit(this.db, tx, hub, {
        action: 'premises.item.schedule',
        entity: 'premises_item',
        entityId: id,
        summary: { templateId: input.templateId, dueDateSet: !!input.dueDate },
      });
      return premisesDto(tx, await tx.premisesItem.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** J1: a finding on an item becomes an action, owned by the action owner unless chosen. */
  @RequirePermission('premises.item.manage')
  @Post('premises-items/:id/findings')
  async premisesFinding(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(PremisesFindingInput, raw);
    if (input.deadline < londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The deadline cannot be in the past');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(p.locationId)) throw notFound();
      const owner = input.ownerUserId ?? p.actionOwnerUserId ?? p.responsibleUserId;
      await assertMember(tx, owner);
      const code = await nextCode(tx, p.organisationId, 'ACT');
      const a = await tx.action.create({
        data: {
          organisationId: p.organisationId,
          code,
          sourceType: 'PREMISES',
          sourceId: id,
          kind: 'ACTION',
          title: input.title,
          severity: input.severity ?? (p.controlArea === 'OXYGEN' ? 'HIGH' : 'MEDIUM'),
          ownerUserId: owner,
          deadline: day(input.deadline),
          createdBy: hub.user.id,
        },
      });
      await tx.actionHistory.create({
        data: {
          organisationId: p.organisationId,
          actionId: a.id,
          fromStatus: null,
          toStatus: 'OPEN',
          note: 'Created from a premises finding',
          byUserId: hub.user.id,
        },
      });
      await premisesHistory(tx, hub, p, 'FINDING', `Finding raised as action ${code}`, null, {
        actionId: a.id,
        deadline: input.deadline,
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { premisesItemId: id },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }

  /** J1: every change to an item, newest first (append-only). */
  @RequirePermission('premises.item.view')
  @Get('premises-items/:id/history')
  async premisesHistoryList(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.premisesItem.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(p.locationId)) throw notFound();
      const rows = await tx.premisesItemHistory.findMany({
        where: { itemId: id },
        orderBy: { changedAt: 'desc' },
        take: 200,
      });
      const names = await userNames(
        tx,
        rows.map((r) => r.changedBy),
      );
      const data: z.infer<typeof PremisesHistoryDto>[] = rows.map((r) => ({
        id: r.id,
        change: r.change as z.infer<typeof PremisesHistoryDto>['change'],
        summary: r.summary,
        before: (r.before ?? null) as Record<string, unknown> | null,
        after: (r.after ?? null) as Record<string, unknown> | null,
        changedBy: r.changedBy,
        changedByName: names.get(r.changedBy) ?? null,
        changedAt: r.changedAt.toISOString(),
      }));
      return { data };
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

  /** Public so the incident workflow controller returns the same detail; not a route. */
  async detail(tx: TenantTx, hub: HubRequestContext, id: string): Promise<EventDetailDto> {
    const e = await tx.event.findUniqueOrThrow({
      where: { id },
      include: {
        transitions: { orderBy: { at: 'asc' } },
        obligations: { orderBy: { createdAt: 'asc' } },
        candour: { orderBy: { decidedAt: 'asc' } },
        candourSteps: { orderBy: { recordedAt: 'asc' } },
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
    const names = await userNames(tx, [
      e.leadUserId,
      e.reportedBy,
      e.triagedBy,
      ...e.transitions.map((t) => t.byUserId),
      ...e.candour.map((c) => c.decidedBy),
      ...e.candourSteps.map((s) => s.recordedBy),
      ...e.obligations.map((o) => o.decidedBy),
    ]);
    const c = e.complaint;
    const ackBy = iso(c?.acknowledgeBy ?? null);
    const respondBy = iso(c?.respondBy ?? null);
    const latest = e.candour[e.candour.length - 1] ?? null;
    const outstanding = candourOutstanding(
      latest?.notifiable ?? null,
      e.candourSteps.map((s) => s.step),
    );
    const closeBlockers = incidentCloseBlockers({
      triaged: !needsTriage(e),
      pendingObligations: e.obligations.filter((o) => o.decision === 'PENDING').length,
      candourFlagged: candourFlag(e.severity, e.types),
      candourDecision: latest?.notifiable ?? null,
      candourStepsOutstanding: outstanding.length,
      openActions: actions.filter((a) => a.status !== 'VERIFIED').length,
      nhsFunded: e.nhsFunded,
      learningRecorded: !!e.learningResponse,
    });
    return {
      ...eventDto(e, names, e.candour.length > 0),
      candourSteps: e.candourSteps.map((s) => ({
        step: s.step,
        label: CANDOUR_STEP_TEXT[s.step as CandourStep] ?? s.step,
        doneOn: iso(s.doneOn) as string,
        note: s.note,
        byName: names.get(s.recordedBy) ?? null,
        at: s.recordedAt.toISOString(),
      })),
      candourOutstanding: outstanding.map((s) => CANDOUR_STEP_TEXT[s]),
      closeBlockers,
      transitions: e.transitions.map((t) => ({
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        note: t.note,
        byUserId: t.byUserId,
        byName: names.get(t.byUserId) ?? null,
        at: t.at.toISOString(),
      })),
      obligations: e.obligations.map((o) => obligationDto(o, now, names)),
      candour: e.candour.map((x) => ({
        notifiable: x.notifiable,
        reason: x.reason,
        decidedBy: x.decidedBy,
        decidedByName: names.get(x.decidedBy) ?? null,
        decidedAt: x.decidedAt.toISOString(),
      })),
      complaint: e.complaint
        ? {
            receivedOn: iso(e.complaint.receivedOn) as string,
            channel: e.complaint.channel,
            acknowledgeBy: ackBy as string,
            respondBy: respondBy as string,
            acknowledgedOn: iso(e.complaint.acknowledgedOn),
            respondedOn: iso(e.complaint.respondedOn),
            acknowledgeOverdue: !e.complaint.acknowledgedOn && isOverdue(ackBy as string, now),
            respondOverdue: !e.complaint.respondedOn && isOverdue(respondBy as string, now),
            preferences: e.complaint.preferences,
            consentToShare: e.complaint.consentToShare,
            outcome: e.complaint.outcome,
            escalationRightsGiven: e.complaint.escalationRightsGiven,
            escalationText: complaintEscalationText(e.nhsFunded),
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
      actions: await withActionNames(
        tx,
        actions.map((a) => toActionDto(a, now)),
      ),
    };
  }
}

/**
 * The requirement behind a premises item. Only an organisation-owned template with a published
 * version can be used; library templates must be adopted and published first.
 */
async function premisesInstance(
  tx: TenantTx,
  hub: HubRequestContext,
  loc: { id: string; organisationId: string },
  templateId: string,
  ownerUserId: string,
  dueDate?: string,
): Promise<string> {
  const v = await tx.requirementTemplateVersion.findFirst({
    where: { templateId, status: 'EFFECTIVE', organisationId: hub.orgId },
  });
  if (!v)
    throw new HubError(
      'TEMPLATE_NOT_PUBLISHED',
      422,
      'That schedule has no published version in your organisation. ' +
        'Adopt and publish it under Requirements first, or save the item without a schedule.',
    );
  if (v.subjectType !== 'PREMISES')
    throw new HubError('VALIDATION_FAILED', 400, 'Choose a premises schedule');
  const existing = await tx.requirementInstance.findFirst({
    where: { templateId, subjectType: 'PREMISES', subjectId: loc.id },
  });
  if (existing) return existing.id;
  const fixed = (v.recurrence as { type?: string } | null)?.type === 'FIXED_CALENDAR';
  const inst = await tx.requirementInstance.create({
    data: {
      organisationId: loc.organisationId,
      templateId,
      templateVersionId: v.id,
      subjectType: 'PREMISES',
      subjectId: loc.id,
      locationId: loc.id,
      ownerUserId,
      dueDate: dueDate ? day(dueDate) : null,
      anchorDate: dueDate && fixed ? day(dueDate) : null,
      createdBy: hub.user.id,
    },
  });
  await recomputeInstance(tx, inst.id, new Date());
  return inst.id;
}

/** J1: append-only history of a premises item. */
async function premisesHistory(
  tx: TenantTx,
  hub: HubRequestContext,
  p: { id: string; organisationId: string },
  change: 'CREATED' | 'EDITED' | 'APPLICABILITY' | 'SCHEDULE' | 'FINDING',
  summary: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await tx.premisesItemHistory.create({
    data: {
      organisationId: p.organisationId,
      itemId: p.id,
      change,
      summary: summary.slice(0, 1000),
      before: (before ?? undefined) as Prisma.InputJsonObject | undefined,
      after: (after ?? undefined) as Prisma.InputJsonObject | undefined,
      changedBy: hub.user.id,
    },
  });
}

async function premisesDto(
  tx: TenantTx,
  p: Prisma.PremisesItemGetPayload<object>,
): Promise<z.infer<typeof PremisesDto>> {
  const i = p.requirementInstanceId
    ? await tx.requirementInstance.findUnique({
        where: { id: p.requirementInstanceId },
        include: {
          template: { select: { title: true } },
          templateVersion: { select: { deadlineKind: true } },
        },
      })
    : null;
  const names = await userNames(tx, [
    p.responsibleUserId,
    p.actionOwnerUserId,
    p.applicabilityReviewerId,
  ]);
  const own = premisesIntervalStatus(p, londonDate(new Date()));
  // J1: oxygen storage at a base where ambulances are kept is deployment-critical.
  const deploymentCritical =
    p.controlArea === 'OXYGEN' &&
    (await tx.vehicle.count({ where: { baseLocationId: p.locationId } })) > 0;
  const status = !p.applicable
    ? ('NOT_APPLICABLE' as const)
    : (i?.status ?? own?.status ?? ('GREY' as const));
  const reason = !p.applicable
    ? 'Approved as not applicable'
    : (i?.reasonText ?? own?.reasonText ?? 'No schedule linked yet');
  return {
    id: p.id,
    locationId: p.locationId,
    controlArea: p.controlArea,
    title: p.title,
    responsibleUserId: p.responsibleUserId,
    responsibleName: names.get(p.responsibleUserId) ?? null,
    frequencySource: p.frequencySource,
    requirementInstanceId: p.requirementInstanceId,
    scheduleTitle: i?.template.title ?? null,
    deadlineKind: i?.templateVersion.deadlineKind ?? null,
    applicable: p.applicable,
    applicabilityReason: p.applicabilityReason,
    applicabilityReviewerId: p.applicabilityReviewerId,
    applicabilityReviewerName: p.applicabilityReviewerId
      ? (names.get(p.applicabilityReviewerId) ?? null)
      : null,
    applicabilityReviewOn: iso(p.applicabilityReviewOn),
    areaName: p.areaName,
    intervalMonths: p.intervalMonths,
    actionOwnerUserId: p.actionOwnerUserId,
    actionOwnerName: p.actionOwnerUserId ? (names.get(p.actionOwnerUserId) ?? null) : null,
    contractorName: p.contractorName,
    assessmentRef: p.assessmentRef,
    assessedOn: iso(p.assessedOn),
    evidenceCount: p.requirementInstanceId
      ? await tx.evidenceLink.count({ where: { instanceId: p.requirementInstanceId } })
      : 0,
    status,
    reasonText: deploymentCritical && status === 'RED' ? `Deployment-critical: ${reason}` : reason,
    nextDue: i ? iso(i.dueDate ?? i.expiryDate ?? i.reviewDate) : (own?.nextDue ?? null),
    deploymentCritical,
    version: p.version,
  };
}
