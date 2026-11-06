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
import { createAction, nextCode } from '@hub/domain';
import {
  CQC_NOTIFICATION_NEXT,
  NHS_CONTRACT_PACK,
  addDays,
  compareDates,
  contractNoticeBy,
  contractState,
  fppNextReviewDue,
  isNhsContractItem,
  summariseContractItems,
  fppState,
  londonDate,
  notificationState,
  notificationTargetDate,
  ratingDisplayDue,
  ratingDisplayState,
  riskRating,
  suggestNotificationKind,
  type CqcNotificationStatus,
} from '@hub/rules';
import {
  CqcNotificationInput,
  CqcNotificationPatch,
  CqcNotificationQuery,
  CqcNotificationTransition,
  CqcRatingDisplayInput,
  CqcRatingInput,
  EventActionInput,
  FppCheckInput,
  MeetingApproveInput,
  MeetingInput,
  MeetingPatch,
  MeetingQuery,
  NhsContractInput,
  NhsContractPatch,
  type CqcNotificationDto,
  type NhsContractDto,
  type NhsContractsDto,
  type CqcRatingDto,
  type FppCheckDto,
  type FppDirectorDto,
  type MeetingDto,
  type MeetingPackDto,
  type NotificationSuggestionDto,
  type RegistrationHistoryDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { toActionDto } from './audits.controller.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const REG = 'compliance.registration.manage';
const VIEW = 'compliance.audit.view';
const MEETINGS = 'governance.meeting.manage';
const FPP = 'governance.fit_proper.manage';
const EVENTS = 'events.event.manage';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
const ds = (x: Date) => x.toISOString().slice(0, 10);

type RatingRow = Prisma.CqcRatingRecordGetPayload<object>;
type FppRow = Prisma.DirectorFppCheckGetPayload<object>;
type MeetingRow = Prisma.GovernanceMeetingGetPayload<object>;
type NotificationRow = Prisma.CqcNotificationGetPayload<object>;
type ContractRow = Prisma.NhsContractGetPayload<object>;

function notFuture(date: string, today: string, what: string): void {
  if (compareDates(date, today) > 0)
    throw new HubError('VALIDATION_FAILED', 400, `${what} cannot be in the future`);
}

/**
 * Task 21: registration history, the rating as CQC published it and where it is displayed,
 * directors' fit and proper person checks, governance meetings (with actions) and drafts of CQC
 * statutory notifications. The hub never calculates a rating and never sends anything to CQC.
 */
@Controller()
export class RegulatoryController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- registration history --------------------------------------------------------------------
  @OrgMember()
  @Get('registration/history')
  async registrationHistory(
    @Hub() hub: HubRequestContext,
  ): Promise<{ data: RegistrationHistoryDto[] }> {
    requireAny(hub, REG, VIEW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.registrationHistory.findMany({
        orderBy: { changedAt: 'desc' },
        take: 200,
      });
      const names = await userNames(
        tx,
        rows.map((r) => r.changedBy),
      );
      return {
        data: rows.map((r) => ({
          id: r.id,
          snapshot: (r.snapshot ?? {}) as Record<string, unknown>,
          changedFields: r.changedFields,
          reason: r.reason,
          changedBy: r.changedBy,
          changedByName: names.get(r.changedBy) ?? null,
          changedAt: r.changedAt.toISOString(),
        })),
      };
    });
  }

  // ---- CQC rating display (reg 20A) ------------------------------------------------------------
  @OrgMember()
  @Get('cqc-ratings')
  async ratings(@Hub() hub: HubRequestContext): Promise<{ data: CqcRatingDto[] }> {
    requireAny(hub, REG, VIEW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.cqcRatingRecord.findMany({
        orderBy: [{ publishedOn: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
      return { data: await ratingDtos(tx, rows) };
    });
  }

  @RequirePermission(REG)
  @Post('cqc-ratings')
  async recordRating(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<CqcRatingDto> {
    const input = body(CqcRatingInput, raw);
    notFuture(input.publishedOn, londonDate(new Date()), 'The publication date');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.locationId && !(await tx.location.count({ where: { id: input.locationId } })))
        throw new HubError('VALIDATION_FAILED', 400, 'Unknown location');
      const r = await tx.cqcRatingRecord.create({
        data: {
          organisationId: hub.orgId as string,
          locationId: input.locationId ?? null,
          overall: input.overall,
          keyQuestions: input.keyQuestions,
          publishedOn: day(input.publishedOn),
          reportUrl: input.reportUrl ?? null,
          displayDue: day(ratingDisplayDue(input.publishedOn)),
          noWebsite: input.noWebsite,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.rating.record',
        entity: 'cqc_rating_record',
        entityId: r.id,
        summary: { overall: input.overall, locationId: input.locationId ?? null },
      });
      return (await ratingDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(REG)
  @Patch('cqc-ratings/:id')
  async ratingDisplay(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CqcRatingDto> {
    const expected = ifMatchVersion(req);
    const input = body(CqcRatingDisplayInput, raw);
    const today = londonDate(new Date());
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.cqcRatingRecord.findUnique({ where: { id } });
      if (!r) throw notFound();
      for (const [k, v] of [
        ['The premises display date', input.displayedPremisesOn],
        ['The website display date', input.displayedWebsiteOn],
      ] as const) {
        if (!v) continue;
        notFuture(v, today, k);
        if (compareDates(v, ds(r.publishedOn)) < 0)
          throw new HubError('VALIDATION_FAILED', 400, `${k} is before the rating was published`);
      }
      for (const item of [input.premisesEvidenceItemId, input.websiteEvidenceItemId]) {
        if (item && !(await tx.evidenceItem.count({ where: { id: item } })))
          throw new HubError('VALIDATION_FAILED', 400, 'Unknown evidence item');
      }
      const u = await tx.cqcRatingRecord.updateMany({
        where: { id, version: expected },
        data: {
          ...(input.premisesEvidenceItemId
            ? { premisesEvidenceItemId: input.premisesEvidenceItemId }
            : {}),
          ...(input.websiteEvidenceItemId
            ? { websiteEvidenceItemId: input.websiteEvidenceItemId }
            : {}),
          ...(input.displayedPremisesOn
            ? { displayedPremisesOn: day(input.displayedPremisesOn) }
            : {}),
          ...(input.displayedWebsiteOn
            ? { displayedWebsiteOn: day(input.displayedWebsiteOn) }
            : {}),
          ...(input.noWebsite !== undefined ? { noWebsite: input.noWebsite } : {}),
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'compliance.rating.display',
        entity: 'cqc_rating_record',
        entityId: id,
        summary: {
          premises: input.displayedPremisesOn ?? null,
          website: input.displayedWebsiteOn ?? null,
          evidence: !!(input.premisesEvidenceItemId || input.websiteEvidenceItemId),
        },
      });
      const fresh = await tx.cqcRatingRecord.findUniqueOrThrow({ where: { id } });
      return (await ratingDtos(tx, [fresh]))[0]!;
    });
  }

  // ---- directors' fit and proper person checks (reg 5) -----------------------------------------
  @RequirePermission(FPP)
  @Get('fit-and-proper')
  async fpp(
    @Hub() hub: HubRequestContext,
  ): Promise<{ directors: FppDirectorDto[]; checks: FppCheckDto[] }> {
    const today = londonDate(new Date());
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.directorFppCheck.findMany({
        orderBy: [{ checkedOn: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      });
      const checks = await fppDtos(tx, rows);
      const byName = new Map<string, FppCheckDto[]>();
      for (const c of checks) {
        const k = c.directorName.trim().toLowerCase();
        byName.set(k, [...(byName.get(k) ?? []), c]);
      }
      const directors = [...byName.values()].map((list) => {
        const latest = list[0]!;
        return {
          directorName: latest.directorName,
          directorRole: latest.directorRole,
          latest,
          state: fppState(latest, today),
          checks: list.length,
        };
      });
      await audit(this.db, tx, hub, {
        action: 'governance.fit_proper.view',
        entity: 'director_fpp_check',
        entityId: hub.orgId as string,
        summary: { directors: directors.length },
      });
      return { directors, checks };
    });
  }

  @RequirePermission(FPP)
  @Post('fit-and-proper')
  async recordFpp(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<FppCheckDto> {
    const input = body(FppCheckInput, raw);
    const today = londonDate(new Date());
    notFuture(input.checkedOn, today, 'The check date');
    if (input.declarationOn) notFuture(input.declarationOn, today, 'The declaration date');
    if (new Set(input.items.map((i) => i.item)).size !== input.items.length)
      throw new HubError('VALIDATION_FAILED', 400, 'Each check item can appear only once');
    if (input.userId === hub.user.id)
      throw new HubError(
        'SELF_APPROVAL',
        422,
        'Someone else must record your own fit and proper check',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (
        input.userId &&
        !(await tx.membership.count({ where: { userId: input.userId, validTo: null } }))
      )
        throw new HubError('VALIDATION_FAILED', 400, 'The person is not a member');
      const r = await tx.directorFppCheck.create({
        data: {
          organisationId: hub.orgId as string,
          directorName: input.directorName,
          directorRole: input.directorRole,
          userId: input.userId ?? null,
          checkedOn: day(input.checkedOn),
          items: input.items,
          declarationOn: input.declarationOn ? day(input.declarationOn) : null,
          outcome: input.outcome,
          nextReviewDue: day(fppNextReviewDue(input.checkedOn)),
          notes: input.notes ?? null,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'governance.fit_proper.record',
        entity: 'director_fpp_check',
        entityId: r.id,
        summary: { outcome: input.outcome },
      });
      return (await fppDtos(tx, [r]))[0]!;
    });
  }

  // ---- governance meetings ---------------------------------------------------------------------
  @OrgMember()
  @Get('governance-meetings')
  async meetings(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: MeetingDto[] }> {
    requireAny(hub, MEETINGS, VIEW);
    const f = body(MeetingQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.governanceMeeting.findMany({
        where: { ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}) },
        orderBy: [{ heldOn: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      });
      return { data: await meetingDtos(tx, rows) };
    });
  }

  /** Figures for the next meeting's agenda, read from live records at the time of asking. */
  @OrgMember()
  @Get('governance-meetings/pack')
  async meetingPack(@Hub() hub: HubRequestContext): Promise<MeetingPackDto> {
    requireAny(hub, MEETINGS, VIEW);
    const now = new Date();
    const today = londonDate(now);
    const todayD = day(today);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const last = await tx.governanceMeeting.findFirst({ orderBy: { heldOn: 'desc' } });
      const sinceOn = last ? ds(last.heldOn) : addDays(today, -90);
      const since = day(sinceOn);
      const openEvent = { status: { not: 'CLOSED' as const } };
      const complaint = { types: { has: 'COMPLAINT' } };
      const [
        incOpened,
        incOpen,
        cmpOpened,
        cmpOpen,
        actOpen,
        actOverdue,
        audSubmitted,
        audRed,
        audOverdue,
        risks,
        ntfDrafts,
        ntfOverdue,
        policyVersions,
        drafts,
        meetingActions,
      ] = await Promise.all([
        tx.event.count({ where: { createdAt: { gte: since }, NOT: complaint } }),
        tx.event.count({ where: { ...openEvent, NOT: complaint } }),
        tx.event.count({ where: { createdAt: { gte: since }, ...complaint } }),
        tx.event.count({ where: { ...openEvent, ...complaint } }),
        tx.action.count({ where: { status: { not: 'VERIFIED' } } }),
        tx.action.count({ where: { status: { not: 'VERIFIED' }, deadline: { lt: todayD } } }),
        tx.auditRun.count({ where: { submittedAt: { gte: since } } }),
        tx.auditRun.count({ where: { submittedAt: { gte: since }, outcome: 'RED' } }),
        tx.auditRun.count({ where: { submittedAt: null, dueDate: { lt: todayD } } }),
        tx.risk.findMany({
          where: { status: 'OPEN' },
          select: { residualLikelihood: true, residualImpact: true, reviewDate: true },
        }),
        tx.cqcNotification.count({ where: { status: 'DRAFT' } }),
        tx.cqcNotification.count({
          where: { status: { in: ['DRAFT', 'READY'] }, dueOn: { lt: todayD } },
        }),
        tx.policyVersion.findMany({
          where: { status: 'PUBLISHED', reviewDate: { lt: todayD } },
          select: { documentId: true },
        }),
        tx.governanceMeeting.findMany({
          where: { status: 'DRAFT' },
          orderBy: { heldOn: 'asc' },
          select: { id: true, code: true, heldOn: true },
        }),
        tx.action.findMany({
          where: { sourceType: 'MEETING', status: { not: 'VERIFIED' } },
          orderBy: { deadline: 'asc' },
          select: { id: true, code: true, title: true, deadline: true },
          take: 100,
        }),
      ]);
      await audit(this.db, tx, hub, {
        action: 'governance.meeting.pack',
        entity: 'governance_meeting',
        entityId: hub.orgId as string,
        summary: { sinceOn },
      });
      return {
        generatedAt: now.toISOString(),
        sinceOn,
        incidents: { opened: incOpened, open: incOpen },
        complaints: { opened: cmpOpened, open: cmpOpen },
        actions: { open: actOpen, overdue: actOverdue },
        audits: { submitted: audSubmitted, nonCompliant: audRed, overdue: audOverdue },
        risks: {
          open: risks.length,
          high: risks.filter((r) =>
            ['HIGH', 'EXTREME'].includes(riskRating(r.residualLikelihood, r.residualImpact).rating),
          ).length,
          reviewOverdue: risks.filter((r) => r.reviewDate < todayD).length,
        },
        notifications: { drafts: ntfDrafts, overdue: ntfOverdue },
        policies: { reviewOverdue: new Set(policyVersions.map((p) => p.documentId)).size },
        previousDraftMinutes: drafts.map((m) => ({ id: m.id, code: m.code, heldOn: ds(m.heldOn) })),
        openMeetingActions: meetingActions.map((a) => ({
          id: a.id,
          code: a.code,
          title: a.title,
          deadline: ds(a.deadline),
        })),
      };
    });
  }

  @OrgMember()
  @Get('governance-meetings/:id')
  async meeting(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<MeetingDto> {
    requireAny(hub, MEETINGS, VIEW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.governanceMeeting.findUnique({ where: { id } });
      if (!r) throw notFound();
      return (await meetingDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(MEETINGS)
  @Post('governance-meetings')
  async recordMeeting(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<MeetingDto> {
    const input = body(MeetingInput, raw);
    notFuture(input.heldOn, londonDate(new Date()), 'The meeting date');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const code = await nextCode(tx, hub.orgId as string, 'MTG');
      const r = await tx.governanceMeeting.create({
        data: {
          organisationId: hub.orgId as string,
          code,
          kind: input.kind,
          title: input.title,
          heldOn: day(input.heldOn),
          chair: input.chair,
          attendees: input.attendees,
          apologies: input.apologies,
          quorate: input.quorate,
          minutes: input.minutes,
          decisions: input.decisions ?? null,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'governance.meeting.record',
        entity: 'governance_meeting',
        entityId: r.id,
        summary: { code, kind: input.kind, quorate: input.quorate },
      });
      return (await meetingDtos(tx, [r]))[0]!;
    });
  }

  /** Draft minutes only. Whoever edits them last cannot approve them. */
  @RequirePermission(MEETINGS)
  @Patch('governance-meetings/:id')
  async editMeeting(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<MeetingDto> {
    const expected = ifMatchVersion(req);
    const input = body(MeetingPatch, raw);
    if (input.heldOn) notFuture(input.heldOn, londonDate(new Date()), 'The meeting date');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const m = await tx.governanceMeeting.findUnique({ where: { id } });
      if (!m) throw notFound();
      if (m.status !== 'DRAFT')
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Approved minutes cannot be changed');
      const u = await tx.governanceMeeting.updateMany({
        where: { id, version: expected, status: 'DRAFT' },
        data: {
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.heldOn ? { heldOn: day(input.heldOn) } : {}),
          ...(input.chair ? { chair: input.chair } : {}),
          ...(input.attendees ? { attendees: input.attendees } : {}),
          ...(input.apologies ? { apologies: input.apologies } : {}),
          ...(input.quorate !== undefined ? { quorate: input.quorate } : {}),
          ...(input.minutes ? { minutes: input.minutes } : {}),
          ...(input.decisions !== undefined ? { decisions: input.decisions } : {}),
          recordedBy: hub.user.id,
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'governance.meeting.edit',
        entity: 'governance_meeting',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      const fresh = await tx.governanceMeeting.findUniqueOrThrow({ where: { id } });
      return (await meetingDtos(tx, [fresh]))[0]!;
    });
  }

  @RequirePermission(MEETINGS)
  @Post('governance-meetings/:id/approve')
  async approveMeeting(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<MeetingDto> {
    const expected = ifMatchVersion(req);
    const input = body(MeetingApproveInput, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const m = await tx.governanceMeeting.findUnique({ where: { id } });
      if (!m) throw notFound();
      if (m.status !== 'DRAFT')
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'These minutes are already approved');
      if (m.recordedBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          422,
          'Someone other than the person who wrote the minutes must approve them',
        );
      if (input.approvedAtMeetingId) {
        const at = await tx.governanceMeeting.findUnique({
          where: { id: input.approvedAtMeetingId },
        });
        if (!at) throw new HubError('VALIDATION_FAILED', 400, 'Unknown meeting');
        if (at.id === id || compareDates(ds(at.heldOn), ds(m.heldOn)) <= 0)
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            'Minutes are approved at a later meeting, not the meeting they record',
          );
      }
      const u = await tx.governanceMeeting.updateMany({
        where: { id, version: expected, status: 'DRAFT' },
        data: {
          status: 'APPROVED',
          approvedBy: hub.user.id,
          approvedAt: new Date(),
          approvedAtMeetingId: input.approvedAtMeetingId ?? null,
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'governance.meeting.approve',
        entity: 'governance_meeting',
        entityId: id,
        summary: { code: m.code, atMeeting: input.approvedAtMeetingId ?? null },
      });
      const fresh = await tx.governanceMeeting.findUniqueOrThrow({ where: { id } });
      return (await meetingDtos(tx, [fresh]))[0]!;
    });
  }

  /** Actions agreed at a meeting go into the normal action log (closed only by verification). */
  @RequirePermission(MEETINGS)
  @Post('governance-meetings/:id/actions')
  async meetingAction(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(EventActionInput, raw);
    if (compareDates(input.deadline, londonDate(new Date())) < 0)
      throw new HubError('VALIDATION_FAILED', 400, 'The deadline is in the past');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const m = await tx.governanceMeeting.findUnique({ where: { id } });
      if (!m) throw notFound();
      if (
        !(await tx.membership.count({
          where: { userId: input.ownerUserId, validTo: null, user: { status: 'ACTIVE' } },
        }))
      )
        throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
      const a = await createAction(tx, {
        organisationId: m.organisationId,
        sourceType: 'MEETING',
        sourceId: id,
        title: input.title,
        severity: input.severity ?? 'MEDIUM',
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { meetingId: id },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }

  // ---- NHS contracts and contract items (task 22) ----------------------------------------------
  @OrgMember()
  @Get('nhs-contracts')
  async contracts(@Hub() hub: HubRequestContext): Promise<NhsContractsDto> {
    requireAny(hub, REG, VIEW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.nhsContract.findMany({ orderBy: [{ endOn: 'asc' }] });
      const instances = await tx.requirementInstance.findMany({
        where: {
          OR: [
            { template: { pack: NHS_CONTRACT_PACK } },
            { template: { code: { startsWith: 'NHS-' } } },
          ],
        },
        include: { template: { select: { code: true, title: true, pack: true } } },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
      const items = instances.filter((i) => isNhsContractItem(i.template));
      const templates = await tx.requirementTemplate.findMany({
        where: { pack: NHS_CONTRACT_PACK },
        select: { organisationId: true, code: true },
      });
      const adopted = new Set(templates.filter((t) => t.organisationId).map((t) => t.code));
      const notAdopted = templates.filter((t) => !t.organisationId && !adopted.has(t.code)).length;
      const names = await userNames(tx, [
        ...rows.map((r) => r.managerUserId),
        ...items.map((i) => i.ownerUserId),
      ]);
      return {
        contracts: rows.map((r) => contractDto(r, names)),
        items: items.map((i) => ({
          instanceId: i.id,
          templateCode: i.template.code,
          title: i.template.title,
          status: i.status as NhsContractsDto['items'][number]['status'],
          reasonText: i.reasonText,
          dueDate: d(i.dueDate),
          ownerName: i.ownerUserId ? (names.get(i.ownerUserId) ?? null) : null,
        })),
        summary: summariseContractItems(items.map((i) => i.status)),
        notAdopted,
      };
    });
  }

  @RequirePermission(REG)
  @Post('nhs-contracts')
  async addContract(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<NhsContractDto> {
    const input = body(NhsContractInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertActiveMember(tx, input.managerUserId);
      if (await tx.nhsContract.count({ where: { reference: input.reference } }))
        throw new HubError('CONFLICT', 409, 'A contract with this reference is already recorded');
      const r = await tx.nhsContract.create({
        data: {
          organisationId: hub.orgId as string,
          commissioner: input.commissioner,
          reference: input.reference,
          service: input.service,
          contractType: input.contractType,
          startOn: day(input.startOn),
          endOn: day(input.endOn),
          noticeMonths: input.noticeMonths,
          reporting: input.reporting,
          managerUserId: input.managerUserId,
          reviewMeetingOn: input.reviewMeetingOn ? day(input.reviewMeetingOn) : null,
          notes: input.notes ?? null,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.contract.record',
        entity: 'nhs_contract',
        entityId: r.id,
        summary: { contractType: input.contractType },
      });
      return contractDto(r, await userNames(tx, [r.managerUserId]));
    });
  }

  @RequirePermission(REG)
  @Patch('nhs-contracts/:id')
  async editContract(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<NhsContractDto> {
    const expected = ifMatchVersion(req);
    const input = body(NhsContractPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.nhsContract.findUnique({ where: { id } });
      if (!c) throw notFound();
      const startOn = input.startOn ?? ds(c.startOn);
      const endOn = input.endOn ?? ds(c.endOn);
      if (compareDates(endOn, startOn) <= 0)
        throw new HubError('VALIDATION_FAILED', 400, 'The end date must be after the start date');
      if (input.managerUserId) await assertActiveMember(tx, input.managerUserId);
      const u = await tx.nhsContract.updateMany({
        where: { id, version: expected },
        data: {
          ...(input.commissioner ? { commissioner: input.commissioner } : {}),
          ...(input.service ? { service: input.service } : {}),
          ...(input.contractType ? { contractType: input.contractType } : {}),
          ...(input.startOn ? { startOn: day(input.startOn) } : {}),
          ...(input.endOn ? { endOn: day(input.endOn) } : {}),
          ...(input.noticeMonths !== undefined ? { noticeMonths: input.noticeMonths } : {}),
          ...(input.reporting ? { reporting: input.reporting } : {}),
          ...(input.managerUserId ? { managerUserId: input.managerUserId } : {}),
          ...(input.reviewMeetingOn !== undefined
            ? { reviewMeetingOn: input.reviewMeetingOn ? day(input.reviewMeetingOn) : null }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'compliance.contract.update',
        entity: 'nhs_contract',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      const fresh = await tx.nhsContract.findUniqueOrThrow({ where: { id } });
      return contractDto(fresh, await userNames(tx, [fresh.managerUserId]));
    });
  }

  // ---- CQC statutory notification drafts -------------------------------------------------------
  @OrgMember()
  @Get('cqc-notifications')
  async notifications(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: CqcNotificationDto[] }> {
    requireAny(hub, EVENTS, REG);
    const f = body(CqcNotificationQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.cqcNotification.findMany({
        where: f.status ? { status: f.status } : {},
        orderBy: [{ dueOn: 'asc' }, { createdAt: 'desc' }],
        take: 200,
      });
      return { data: await notificationDtos(tx, rows) };
    });
  }

  /** Recent events (last 90 days) that may be notifiable and have no notification yet. */
  @OrgMember()
  @Get('cqc-notifications/suggestions')
  async suggestions(@Hub() hub: HubRequestContext): Promise<{ data: NotificationSuggestionDto[] }> {
    requireAny(hub, EVENTS, REG);
    const since = day(addDays(londonDate(new Date()), -90));
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const events = await tx.event.findMany({
        where: { occurredAt: { gte: since } },
        select: {
          id: true,
          code: true,
          title: true,
          types: true,
          severity: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: 300,
      });
      const linked = new Set(
        (
          await tx.cqcNotification.findMany({
            where: { eventId: { in: events.map((e) => e.id) } },
            select: { eventId: true },
          })
        ).map((n) => n.eventId),
      );
      const data: NotificationSuggestionDto[] = [];
      for (const e of events) {
        const kind = suggestNotificationKind({ types: e.types, severity: e.severity });
        if (kind && !linked.has(e.id))
          data.push({
            eventId: e.id,
            eventCode: e.code,
            title: e.title,
            occurredOn: londonDate(e.occurredAt),
            kind,
          });
      }
      return { data };
    });
  }

  @RequirePermission(EVENTS)
  @Post('cqc-notifications')
  async draftNotification(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<CqcNotificationDto> {
    const input = body(CqcNotificationInput, raw);
    if (!(input.kind === 'MANAGER_ABSENCE' && input.planned))
      notFuture(input.occurredOn, londonDate(new Date()), 'The date it happened');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.eventId && !(await tx.event.count({ where: { id: input.eventId } })))
        throw new HubError('VALIDATION_FAILED', 400, 'Unknown event');
      const code = await nextCode(tx, hub.orgId as string, 'NTF');
      const r = await tx.cqcNotification.create({
        data: {
          organisationId: hub.orgId as string,
          code,
          kind: input.kind,
          eventId: input.eventId ?? null,
          occurredOn: day(input.occurredOn),
          dueOn: day(notificationTargetDate(input.kind, input.occurredOn, input.planned)),
          summary: input.summary,
          actionsTaken: input.actionsTaken ?? null,
          preparedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'governance.notification.draft',
        entity: 'cqc_notification',
        entityId: r.id,
        summary: { code, kind: input.kind, eventId: input.eventId ?? null },
      });
      return (await notificationDtos(tx, [r]))[0]!;
    });
  }

  /** Drafts only. Whoever edits a draft last becomes its preparer, so cannot review it. */
  @RequirePermission(EVENTS)
  @Patch('cqc-notifications/:id')
  async editNotification(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CqcNotificationDto> {
    const expected = ifMatchVersion(req);
    const input = body(CqcNotificationPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const n = await tx.cqcNotification.findUnique({ where: { id } });
      if (!n) throw notFound();
      if (n.status !== 'DRAFT')
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Only a draft can be edited');
      const u = await tx.cqcNotification.updateMany({
        where: { id, version: expected, status: 'DRAFT' },
        data: {
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.actionsTaken !== undefined ? { actionsTaken: input.actionsTaken } : {}),
          preparedBy: hub.user.id,
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'governance.notification.edit',
        entity: 'cqc_notification',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      const fresh = await tx.cqcNotification.findUniqueOrThrow({ where: { id } });
      return (await notificationDtos(tx, [fresh]))[0]!;
    });
  }

  @RequirePermission(EVENTS)
  @Post('cqc-notifications/:id/transition')
  async moveNotification(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CqcNotificationDto> {
    const expected = ifMatchVersion(req);
    const input = body(CqcNotificationTransition, raw);
    const today = londonDate(new Date());
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const n = await tx.cqcNotification.findUnique({ where: { id } });
      if (!n) throw notFound();
      const from = n.status as CqcNotificationStatus;
      if (!CQC_NOTIFICATION_NEXT[from].includes(input.to))
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          `A notification that is ${from.toLowerCase().replace('_', ' ')} cannot move to ${input.to
            .toLowerCase()
            .replace('_', ' ')}`,
        );
      let data: Prisma.CqcNotificationUpdateManyMutationInput;
      if (input.to === 'READY') {
        if (n.preparedBy === hub.user.id)
          throw new HubError(
            'SELF_APPROVAL',
            422,
            'Someone other than the person who prepared it must review it',
          );
        data = { status: 'READY', reviewedBy: hub.user.id, reviewedAt: new Date() };
      } else if (input.to === 'DRAFT') {
        data = { status: 'DRAFT', reviewedBy: null, reviewedAt: null };
      } else if (input.to === 'SUBMITTED') {
        notFuture(input.submittedOn, today, 'The submission date');
        if (n.kind !== 'MANAGER_ABSENCE' && compareDates(input.submittedOn, ds(n.occurredOn)) < 0)
          throw new HubError('VALIDATION_FAILED', 400, 'Submitted before it happened');
        data = {
          status: 'SUBMITTED',
          submittedOn: day(input.submittedOn),
          cqcReference: input.cqcReference,
        };
      } else {
        data = { status: 'NOT_REQUIRED', notRequiredReason: input.reason };
      }
      const u = await tx.cqcNotification.updateMany({
        where: { id, version: expected, status: from },
        data,
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'governance.notification.transition',
        entity: 'cqc_notification',
        entityId: id,
        summary: { from, to: input.to },
      });
      const fresh = await tx.cqcNotification.findUniqueOrThrow({ where: { id } });
      return (await notificationDtos(tx, [fresh]))[0]!;
    });
  }
}

async function assertActiveMember(tx: TenantTx, userId: string): Promise<void> {
  if (
    !(await tx.membership.count({ where: { userId, validTo: null, user: { status: 'ACTIVE' } } }))
  )
    throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
}

function contractDto(r: ContractRow, names: Map<string, string>): NhsContractDto {
  const startOn = ds(r.startOn);
  const endOn = ds(r.endOn);
  return {
    id: r.id,
    commissioner: r.commissioner,
    reference: r.reference,
    service: r.service,
    contractType: r.contractType as NhsContractDto['contractType'],
    startOn,
    endOn,
    noticeMonths: r.noticeMonths,
    noticeBy: contractNoticeBy(endOn, r.noticeMonths),
    reporting: r.reporting as NhsContractDto['reporting'],
    managerUserId: r.managerUserId,
    managerName: names.get(r.managerUserId) ?? null,
    reviewMeetingOn: d(r.reviewMeetingOn),
    notes: r.notes,
    state: contractState({ startOn, endOn, noticeMonths: r.noticeMonths }, londonDate(new Date())),
    version: r.version,
  };
}

async function ratingDtos(tx: TenantTx, rows: RatingRow[]): Promise<CqcRatingDto[]> {
  const today = londonDate(new Date());
  const locIds = [...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))];
  const locs = locIds.length
    ? await tx.location.findMany({
        where: { id: { in: locIds } },
        select: { id: true, name: true },
      })
    : [];
  const locName = new Map(locs.map((l) => [l.id, l.name]));
  const latest = await tx.cqcRatingRecord.findMany({
    orderBy: [{ publishedOn: 'desc' }, { createdAt: 'desc' }],
    select: { id: true, locationId: true },
  });
  const currentIds = new Set<string>();
  const seen = new Set<string>();
  for (const l of latest) {
    const k = l.locationId ?? 'provider';
    if (!seen.has(k)) {
      seen.add(k);
      currentIds.add(l.id);
    }
  }
  const names = await userNames(
    tx,
    rows.map((r) => r.recordedBy),
  );
  return rows.map((r) => {
    const current = currentIds.has(r.id);
    const display = current
      ? ratingDisplayState(
          {
            publishedOn: ds(r.publishedOn),
            displayedPremisesOn: d(r.displayedPremisesOn),
            displayedWebsiteOn: d(r.displayedWebsiteOn),
            noWebsite: r.noWebsite,
          },
          today,
        )
      : { status: 'NOT_APPLICABLE' as const, reasonText: 'Replaced by a later rating' };
    return {
      id: r.id,
      locationId: r.locationId,
      locationName: r.locationId ? (locName.get(r.locationId) ?? null) : null,
      overall: r.overall as CqcRatingDto['overall'],
      keyQuestions: (r.keyQuestions ?? {}) as CqcRatingDto['keyQuestions'],
      publishedOn: ds(r.publishedOn),
      reportUrl: r.reportUrl,
      displayDue: ds(r.displayDue),
      displayedPremisesOn: d(r.displayedPremisesOn),
      displayedWebsiteOn: d(r.displayedWebsiteOn),
      noWebsite: r.noWebsite,
      current,
      display,
      recordedByName: names.get(r.recordedBy) ?? null,
      premisesEvidenceItemId: r.premisesEvidenceItemId,
      websiteEvidenceItemId: r.websiteEvidenceItemId,
      version: r.version,
    };
  });
}

async function fppDtos(tx: TenantTx, rows: FppRow[]): Promise<FppCheckDto[]> {
  const names = await userNames(
    tx,
    rows.map((r) => r.recordedBy),
  );
  return rows.map((r) => ({
    id: r.id,
    directorName: r.directorName,
    directorRole: r.directorRole,
    userId: r.userId,
    checkedOn: ds(r.checkedOn),
    items: (Array.isArray(r.items) ? r.items : []) as FppCheckDto['items'],
    declarationOn: d(r.declarationOn),
    outcome: r.outcome as FppCheckDto['outcome'],
    nextReviewDue: ds(r.nextReviewDue),
    notes: r.notes,
    recordedByName: names.get(r.recordedBy) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function meetingDtos(tx: TenantTx, rows: MeetingRow[]): Promise<MeetingDto[]> {
  const actions = rows.length
    ? await tx.action.findMany({
        where: { sourceType: 'MEETING', sourceId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const names = await userNames(tx, [
    ...rows.flatMap((r) => [r.recordedBy, r.approvedBy]),
    ...actions.map((a) => a.ownerUserId),
  ]);
  const atIds = rows.map((r) => r.approvedAtMeetingId).filter((x): x is string => !!x);
  const atCodes = new Map(
    (atIds.length
      ? await tx.governanceMeeting.findMany({
          where: { id: { in: atIds } },
          select: { id: true, code: true },
        })
      : []
    ).map((m) => [m.id, m.code]),
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    kind: r.kind as MeetingDto['kind'],
    title: r.title,
    heldOn: ds(r.heldOn),
    chair: r.chair,
    attendees: r.attendees,
    apologies: r.apologies,
    quorate: r.quorate,
    minutes: r.minutes,
    decisions: r.decisions,
    status: r.status as MeetingDto['status'],
    recordedBy: r.recordedBy,
    recordedByName: names.get(r.recordedBy) ?? null,
    approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    actions: actions
      .filter((a) => a.sourceId === r.id)
      .map((a) => ({
        id: a.id,
        code: a.code,
        title: a.title,
        status: a.status,
        deadline: ds(a.deadline),
        ownerName: names.get(a.ownerUserId) ?? null,
      })),
    approvedAtMeetingId: r.approvedAtMeetingId,
    approvedAtMeetingCode: r.approvedAtMeetingId
      ? (atCodes.get(r.approvedAtMeetingId) ?? null)
      : null,
    version: r.version,
  }));
}

async function notificationDtos(
  tx: TenantTx,
  rows: NotificationRow[],
): Promise<CqcNotificationDto[]> {
  const today = londonDate(new Date());
  const eventIds = [...new Set(rows.map((r) => r.eventId).filter((x): x is string => !!x))];
  const events = eventIds.length
    ? await tx.event.findMany({ where: { id: { in: eventIds } }, select: { id: true, code: true } })
    : [];
  const codes = new Map(events.map((e) => [e.id, e.code]));
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.preparedBy, r.reviewedBy]),
  );
  return rows.map((r) => {
    const status = r.status as CqcNotificationStatus;
    return {
      id: r.id,
      code: r.code,
      kind: r.kind as CqcNotificationDto['kind'],
      eventId: r.eventId,
      eventCode: r.eventId ? (codes.get(r.eventId) ?? null) : null,
      occurredOn: ds(r.occurredOn),
      dueOn: ds(r.dueOn),
      summary: r.summary,
      actionsTaken: r.actionsTaken,
      status,
      preparedBy: r.preparedBy,
      preparedByName: names.get(r.preparedBy) ?? null,
      reviewedByName: r.reviewedBy ? (names.get(r.reviewedBy) ?? null) : null,
      submittedOn: d(r.submittedOn),
      cqcReference: r.cqcReference,
      notRequiredReason: r.notRequiredReason,
      state: notificationState(
        { status, dueOn: ds(r.dueOn), submittedOn: d(r.submittedOn) },
        today,
      ),
      version: r.version,
    };
  });
}
