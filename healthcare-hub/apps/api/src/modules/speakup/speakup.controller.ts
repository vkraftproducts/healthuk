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
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { nextCode } from '@hub/domain';
import {
  SPEAK_UP_SUPPRESS_BELOW,
  addDays,
  compareDates,
  detrimentCheckDue,
  harassmentDutySteps,
  londonDate,
  quarterRange,
  speakUpAcknowledgeDue,
  speakUpCloseBlocker,
  speakUpThemes,
  suppressedCount,
  type SpeakUpStatus,
} from '@hub/rules';
import {
  HarassmentAssessmentInput,
  SpeakUpAcknowledge,
  SpeakUpClose,
  SpeakUpNoteInput,
  SpeakUpProgressFeedback,
  SpeakUpProgressQuery,
  SpeakUpQuery,
  SpeakUpRaise,
  SpeakUpRecord,
  SpeakUpStart,
  SpeakUpThemesQuery,
  type HarassmentAssessmentDto,
  type HarassmentDutyDto,
  type SpeakUpDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const RAISE = 'speakup.raise';
const MANAGE = 'speakup.manage';
const HARASSMENT = 'harassment.manage';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

type ConcernRow = Prisma.SpeakUpConcernGetPayload<{ include: { notes: true } }>;
type AssessmentRow = Prisma.HarassmentRiskAssessmentGetPayload<object>;

/**
 * Task 20: speaking up and the duty to prevent sexual harassment. Who raised a named concern is
 * visible only to handlers (`speakup.manage`, enforced by RLS too). Anonymous concerns raised in
 * the hub store no raiser and no recorder, and their audit event names no actor.
 */
@Controller()
export class SpeakUpController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- raising ---------------------------------------------------------------------------------
  @RequirePermission(RAISE)
  @Post('speak-up')
  async raise(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(SpeakUpRaise, raw);
    const raisedOn = londonDate(new Date());
    const due = speakUpAcknowledgeDue(raisedOn);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const code = await nextCode(tx, hub.orgId as string, 'SPK');
      const id = uuidv7();
      // createMany: no RETURNING, so an anonymous raiser never reads the row back (RLS).
      await tx.speakUpConcern.createMany({
        data: [
          {
            id,
            organisationId: hub.orgId as string,
            code,
            category: input.category,
            channel: 'IN_APP',
            anonymous: input.anonymous,
            thirdParty: input.thirdParty,
            raisedBy: input.anonymous ? null : hub.user.id,
            recordedBy: input.anonymous ? null : hub.user.id,
            summary: input.summary,
            raisedOn: day(raisedOn),
            acknowledgeDue: day(due),
          },
        ],
      });
      if (input.anonymous)
        await this.db.appendAudit(tx, {
          orgId: hub.orgId as string,
          actorUserId: null,
          actorType: 'SYSTEM',
          action: 'speakup.concern.raise',
          entity: 'speak_up_concern',
          entityId: code,
          afterSummary: { category: input.category, anonymous: true },
        });
      else
        await audit(this.db, tx, hub, {
          action: 'speakup.concern.raise',
          entity: 'speak_up_concern',
          entityId: code,
          summary: { category: input.category, anonymous: false },
        });
      // H6: an anonymous raiser gets a code to check progress; only its hash is stored.
      const progressCode = input.anonymous ? newProgressCode() : undefined;
      if (progressCode)
        await tx.speakUpProgress.createMany({
          data: [
            {
              organisationId: hub.orgId as string,
              concernId: id,
              codeHash: hashCode(progressCode),
              status: 'RECEIVED',
            },
          ],
        });
      return {
        code,
        raisedOn,
        anonymous: input.anonymous,
        acknowledgeDue: due,
        ...(progressCode ? { progressCode } : {}),
      };
    });
  }

  /** H6: progress for an anonymous code. Stage and feedback only; nothing that identifies. */
  @RequirePermission(RAISE)
  @Get('speak-up/progress')
  async progress(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const { code } = body(SpeakUpProgressQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.speakUpProgress.findFirst({ where: { codeHash: hashCode(code) } });
      if (!p) throw new HubError('NOT_FOUND', 404, 'No concern matches that code');
      return {
        status: p.status as 'RECEIVED' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'CLOSED',
        feedback: p.feedback,
        updatedOn: londonDate(p.updatedAt),
      };
    });
  }

  /** H6: who to speak to. The guardian is named in Settings, Notifications. */
  @RequirePermission(RAISE)
  @Get('speak-up/guardian')
  async guardian(@Hub() hub: HubRequestContext) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await tx.organisation.findUniqueOrThrow({
        where: { id: hub.orgId as string },
        select: { settings: true },
      });
      const id = (o.settings as { speakUpGuardianUserId?: string | null } | null)
        ?.speakUpGuardianUserId;
      const names = id ? await userNames(tx, [id]) : new Map<string, string>();
      return { guardianName: id ? (names.get(id) ?? null) : null };
    });
  }

  /** H6: quarterly themes for the board, with small numbers hidden. */
  @OrgMember()
  @Get('speak-up/themes')
  async themes(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, MANAGE, 'reports.view');
    const { quarter } = body(SpeakUpThemesQuery, q);
    const { from, to } = quarterRange(quarter);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.speakUpConcern.findMany({
        where: { raisedOn: { gte: day(from), lte: day(to) } },
        select: { category: true },
      });
      return {
        quarter,
        from,
        to,
        total: suppressedCount(rows.length),
        themes: speakUpThemes(rows.map((r) => r.category)) as {
          category: SpeakUpDto['category'];
          count: string;
        }[],
        note:
          `Counts below ${SPEAK_UP_SUPPRESS_BELOW} are hidden so that nobody can be identified. ` +
          'Themes use categories only, never what people wrote.',
      };
    });
  }

  /** H6: feedback an anonymous raiser sees with their code. */
  @RequirePermission(MANAGE)
  @Post('speak-up/:id/progress-feedback')
  async progressFeedback(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SpeakUpDto> {
    const { feedback } = body(SpeakUpProgressFeedback, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await this.load(tx, id);
      if (!c.anonymous)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Give feedback to a named person directly and record it as feedback',
        );
      const r = await tx.speakUpProgress.updateMany({
        where: { concernId: id },
        data: { feedback, updatedAt: new Date() },
      });
      if (r.count === 0) throw new HubError('CONFLICT', 409, 'This concern has no progress code');
      const today = londonDate(new Date());
      await this.statusNote(tx, hub, id, `Feedback for the raiser: ${feedback}`, today);
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.progress_feedback',
        entity: 'speak_up_concern',
        entityId: id,
      });
      return this.dto(tx, id);
    });
  }

  /** The caller's own named concerns: progress only, never the handler's notes. */
  @RequirePermission(RAISE)
  @Get('speak-up/mine')
  async mine(@Hub() hub: HubRequestContext) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.speakUpConcern.findMany({
        where: { raisedBy: hub.user.id },
        orderBy: { raisedOn: 'desc' },
        take: 100,
      });
      return {
        data: rows.map((r) => ({
          code: r.code,
          category: r.category,
          raisedOn: d(r.raisedOn)!,
          status: r.status,
          acknowledgedOn: d(r.acknowledgedOn),
          feedbackGivenOn: d(r.feedbackGivenOn),
          closedOn: d(r.closedOn),
        })),
      };
    });
  }

  // ---- handling --------------------------------------------------------------------------------
  @RequirePermission(MANAGE)
  @Get('speak-up')
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: SpeakUpDto[] }> {
    const f = body(SpeakUpQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.speakUpConcern.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.category ? { category: f.category } : {}),
        },
        include: { notes: true },
        orderBy: [{ status: 'asc' }, { acknowledgeDue: 'asc' }],
        take: 500,
      });
      return { data: await concernDtos(tx, rows, false) };
    });
  }

  @RequirePermission(MANAGE)
  @Get('speak-up/:id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<SpeakUpDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.speakUpConcern.findUnique({ where: { id }, include: { notes: true } });
      if (!c) throw notFound();
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.view',
        entity: 'speak_up_concern',
        entityId: id,
      });
      return (await concernDtos(tx, [c], true))[0]!;
    });
  }

  /** A handler recording a concern received in person, by phone, email or letter. */
  @RequirePermission(MANAGE)
  @Post('speak-up/record')
  async record(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<SpeakUpDto> {
    const input = body(SpeakUpRecord, raw);
    if (input.raisedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date raised cannot be in the future');
    if (input.anonymous === !!input.raisedByUserId)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        input.anonymous
          ? 'An anonymous concern cannot name who raised it'
          : 'Choose who raised the concern, or mark it anonymous',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      for (const u of [input.raisedByUserId, input.handlerUserId]) if (u) await assertMember(tx, u);
      if (input.handlerUserId && input.handlerUserId === input.raisedByUserId)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The handler cannot be the person who raised it',
        );
      const c = await tx.speakUpConcern.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'SPK'),
          category: input.category,
          channel: input.channel,
          anonymous: input.anonymous,
          thirdParty: input.thirdParty,
          raisedBy: input.raisedByUserId ?? null,
          recordedBy: hub.user.id,
          summary: input.summary,
          raisedOn: day(input.raisedOn),
          acknowledgeDue: day(speakUpAcknowledgeDue(input.raisedOn)),
          handlerUserId: input.handlerUserId ?? null,
        },
        include: { notes: true },
      });
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.record',
        entity: 'speak_up_concern',
        entityId: c.id,
        summary: { category: c.category, channel: c.channel, anonymous: c.anonymous },
      });
      return (await concernDtos(tx, [c], true))[0]!;
    });
  }

  @RequirePermission(MANAGE)
  @Post('speak-up/:id/acknowledge')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SpeakUpDto> {
    const input = body(SpeakUpAcknowledge, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await this.load(tx, id);
      if (c.status !== 'RECEIVED')
        throw new HubError('CONFLICT', 409, 'This concern has already been acknowledged');
      if (input.acknowledgedOn < d(c.raisedOn)! || input.acknowledgedOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The acknowledgement date must be on or after the date raised and not in the future',
        );
      await assertMember(tx, input.handlerUserId);
      if (input.handlerUserId === c.raisedBy)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The handler cannot be the person who raised it',
        );
      await tx.speakUpConcern.update({
        where: { id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedOn: day(input.acknowledgedOn),
          handlerUserId: input.handlerUserId,
        },
      });
      await this.statusNote(tx, hub, id, 'Acknowledged', input.acknowledgedOn);
      await syncProgress(tx, id, 'ACKNOWLEDGED');
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.acknowledge',
        entity: 'speak_up_concern',
        entityId: id,
        summary: { late: input.acknowledgedOn > d(c.acknowledgeDue)! },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post('speak-up/:id/start')
  async start(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SpeakUpDto> {
    const input = body(SpeakUpStart, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await this.load(tx, id);
      if (c.status !== 'ACKNOWLEDGED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          c.status === 'RECEIVED'
            ? 'Acknowledge the concern first'
            : 'The concern is already being looked into or is closed',
        );
      await tx.speakUpConcern.update({ where: { id }, data: { status: 'INVESTIGATING' } });
      await this.statusNote(tx, hub, id, input.note, londonDate(new Date()));
      await syncProgress(tx, id, 'INVESTIGATING');
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.investigate',
        entity: 'speak_up_concern',
        entityId: id,
      });
      return this.dto(tx, id);
    });
  }

  /** Notes are never edited: feedback to the person and detriment checks are notes too. */
  @RequirePermission(MANAGE)
  @Post('speak-up/:id/notes')
  async note(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SpeakUpDto> {
    const input = body(SpeakUpNoteInput, raw);
    if (input.on > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date cannot be in the future');
    if ((input.kind === 'DETRIMENT_CHECK') !== (input.detrimentReported !== undefined))
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Say whether detriment was reported, and only for a detriment check',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await this.load(tx, id);
      if (input.on < d(c.raisedOn)!)
        throw new HubError('VALIDATION_FAILED', 400, 'The date is before the concern was raised');
      if (c.anonymous && input.kind !== 'NOTE')
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Feedback and detriment checks need a named person; this concern is anonymous',
        );
      if (input.kind === 'DETRIMENT_CHECK' && c.status !== 'CLOSED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the detriment check after the concern is closed',
        );
      await tx.speakUpNote.create({
        data: {
          organisationId: c.organisationId,
          concernId: id,
          kind: input.kind,
          note: input.note,
          onDate: day(input.on),
          detrimentReported: input.kind === 'DETRIMENT_CHECK' ? input.detrimentReported! : null,
          createdBy: hub.user.id,
        },
      });
      if (input.kind === 'FEEDBACK')
        await tx.speakUpConcern.update({ where: { id }, data: { feedbackGivenOn: day(input.on) } });
      if (input.kind === 'DETRIMENT_CHECK')
        await tx.speakUpConcern.update({
          where: { id },
          data: { detrimentCheckedOn: day(input.on) },
        });
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.note',
        entity: 'speak_up_concern',
        entityId: id,
        summary: {
          kind: input.kind,
          detrimentReported: input.detrimentReported ?? null,
        },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post('speak-up/:id/close')
  async close(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SpeakUpDto> {
    const input = body(SpeakUpClose, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await this.load(tx, id);
      const blocker = speakUpCloseBlocker({
        status: c.status as SpeakUpStatus,
        anonymous: c.anonymous,
        feedbackGivenOn: d(c.feedbackGivenOn),
      });
      if (blocker && c.status === 'CLOSED') throw new HubError('CONFLICT', 409, blocker);
      if (blocker) throw new HubError('TRANSITION_NOT_ALLOWED', 422, blocker);
      if (input.closedOn < d(c.acknowledgedOn)! || input.closedOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The closing date must be on or after the acknowledgement and not in the future',
        );
      await tx.speakUpConcern.update({
        where: { id },
        data: {
          status: 'CLOSED',
          outcome: input.outcome,
          outcomeText: input.outcomeText,
          lessons: input.lessons ?? null,
          closedOn: day(input.closedOn),
          closedBy: hub.user.id,
          detrimentCheckDue: c.anonymous ? null : day(detrimentCheckDue(input.closedOn)),
        },
      });
      await this.statusNote(tx, hub, id, 'Closed', input.closedOn);
      await syncProgress(tx, id, 'CLOSED');
      await audit(this.db, tx, hub, {
        action: 'speakup.concern.close',
        entity: 'speak_up_concern',
        entityId: id,
        summary: { outcome: input.outcome },
      });
      return this.dto(tx, id);
    });
  }

  // ---- harassment risk assessment and duty -----------------------------------------------------
  @RequirePermission(HARASSMENT)
  @Get('harassment/assessments')
  async assessments(@Hub() hub: HubRequestContext): Promise<{ data: HarassmentAssessmentDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.harassmentRiskAssessment.findMany({
        orderBy: [{ createdAt: 'desc' }],
        take: 50,
      });
      return { data: await assessmentDtos(tx, rows) };
    });
  }

  @RequirePermission(HARASSMENT)
  @Post('harassment/assessments')
  async createAssessment(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<HarassmentAssessmentDto> {
    const input = body(HarassmentAssessmentInput, raw);
    assertAssessmentDates(input.assessedOn, input.reviewDue);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (await tx.harassmentRiskAssessment.count({ where: { status: 'DRAFT' } }))
        throw new HubError('CONFLICT', 409, 'There is already a draft: finish or edit that one');
      const current = await tx.harassmentRiskAssessment.findFirst({
        where: { status: 'APPROVED' },
        orderBy: { approvedAt: 'desc' },
      });
      const a = await tx.harassmentRiskAssessment.create({
        data: {
          organisationId: hub.orgId as string,
          title: input.title,
          assessedOn: day(input.assessedOn),
          reviewDue: day(input.reviewDue),
          risks: input.risks as unknown as Prisma.InputJsonValue,
          preparedBy: hub.user.id,
          supersedesId: current?.id ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'harassment.assessment.create',
        entity: 'harassment_risk_assessment',
        entityId: a.id,
        summary: { risks: input.risks.length },
      });
      return (await assessmentDtos(tx, [a]))[0]!;
    });
  }

  @RequirePermission(HARASSMENT)
  @Patch('harassment/assessments/:id')
  async patchAssessment(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<HarassmentAssessmentDto> {
    const expected = ifMatchVersion(req);
    const input = body(HarassmentAssessmentInput, raw);
    assertAssessmentDates(input.assessedOn, input.reviewDue);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.harassmentRiskAssessment.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status !== 'DRAFT')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'An approved assessment cannot be changed: start a new draft',
        );
      const r = await tx.harassmentRiskAssessment.updateMany({
        where: { id, version: expected, status: 'DRAFT' },
        data: {
          title: input.title,
          assessedOn: day(input.assessedOn),
          reviewDue: day(input.reviewDue),
          risks: input.risks as unknown as Prisma.InputJsonValue,
          // Whoever last edited the draft prepared it, so they cannot approve it.
          preparedBy: hub.user.id,
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'harassment.assessment.update',
        entity: 'harassment_risk_assessment',
        entityId: id,
        summary: { risks: input.risks.length },
      });
      const u = await tx.harassmentRiskAssessment.findUniqueOrThrow({ where: { id } });
      return (await assessmentDtos(tx, [u]))[0]!;
    });
  }

  @RequirePermission(HARASSMENT)
  @Post('harassment/assessments/:id/approve')
  async approveAssessment(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<HarassmentAssessmentDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.harassmentRiskAssessment.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status !== 'DRAFT') throw new HubError('CONFLICT', 409, 'Already approved');
      if (a.preparedBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          422,
          'Someone other than the person who prepared it must approve it',
        );
      await tx.harassmentRiskAssessment.updateMany({
        where: { status: 'APPROVED' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.harassmentRiskAssessment.update({
        where: { id },
        data: { status: 'APPROVED', approvedBy: hub.user.id, approvedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'harassment.assessment.approve',
        entity: 'harassment_risk_assessment',
        entityId: id,
      });
      const u = await tx.harassmentRiskAssessment.findUniqueOrThrow({ where: { id } });
      return (await assessmentDtos(tx, [u]))[0]!;
    });
  }

  /** The prevention steps the hub can see. Never a statement that the duty is met. */
  @RequirePermission(HARASSMENT)
  @Get('harassment/duty')
  async duty(@Hub() hub: HubRequestContext): Promise<HarassmentDutyDto> {
    const now = new Date();
    const asOf = londonDate(now);
    const handler = hub.permissions.has(MANAGE);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [approved, drafts, policies, templates] = await Promise.all([
        tx.harassmentRiskAssessment.findFirst({
          where: { status: 'APPROVED' },
          orderBy: { approvedAt: 'desc' },
        }),
        tx.harassmentRiskAssessment.count({ where: { status: 'DRAFT' } }),
        tx.policyDocument.findMany({
          where: {
            title: { contains: 'harass', mode: 'insensitive' },
            versions: { some: { status: 'PUBLISHED' } },
          },
          include: { versions: { where: { status: 'PUBLISHED' } } },
          take: 5,
        }),
        tx.requirementTemplate.findMany({
          where: { title: { contains: 'harass', mode: 'insensitive' } },
          select: { id: true, title: true },
        }),
      ]);
      const mapped = templates.length
        ? await tx.roleRequirement.findMany({
            where: { templateId: { in: templates.map((t) => t.id) } },
            select: { templateId: true },
          })
        : [];
      const training = templates.find((t) => mapped.some((m) => m.templateId === t.id)) ?? null;
      const [required, met] = training
        ? await Promise.all([
            tx.requirementInstance.count({
              where: {
                subjectType: 'STAFF',
                templateId: training.id,
                status: { not: 'NOT_APPLICABLE' },
              },
            }),
            tx.requirementInstance.count({
              where: { subjectType: 'STAFF', templateId: training.id, status: 'GREEN' },
            }),
          ])
        : [0, 0];
      const policy = policies[0] ?? null;
      const since = day(addDays(asOf, -365));
      const [overdueAck, overdueDetriment, recent] = handler
        ? await Promise.all([
            tx.speakUpConcern.count({
              where: { status: 'RECEIVED', acknowledgeDue: { lt: day(asOf) } },
            }),
            tx.speakUpConcern.count({
              where: {
                status: 'CLOSED',
                detrimentCheckedOn: null,
                detrimentCheckDue: { lt: day(asOf) },
              },
            }),
            tx.speakUpConcern.findMany({
              where: { raisedOn: { gte: since } },
              select: { category: true },
            }),
          ])
        : [null, null, []];
      const counts: Record<string, number> = {};
      for (const r of recent) counts[r.category] = (counts[r.category] ?? 0) + 1;
      const reviewDate = policy?.versions[0]?.reviewDate ?? null;
      return {
        asOf,
        steps: harassmentDutySteps({
          asOf,
          assessment: approved
            ? {
                approvedOn: londonDate(approved.approvedAt!),
                reviewDue: d(approved.reviewDue)!,
              }
            : null,
          hasDraftAssessment: drafts > 0,
          policy: policy ? { title: policy.title, reviewDate: d(reviewDate) } : null,
          training: training ? { title: training.title, required, met } : null,
          overdueAcknowledgements: overdueAck,
          overdueDetrimentChecks: overdueDetriment,
        }),
        concernsLast12Months: counts,
        note:
          'These are the steps the hub can see. Whether they amount to reasonable steps to ' +
          'prevent sexual harassment is a judgement for the organisation.',
      };
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------
  private async load(tx: TenantTx, id: string) {
    const c = await tx.speakUpConcern.findUnique({ where: { id } });
    if (!c) throw notFound();
    return c;
  }

  private async dto(tx: TenantTx, id: string): Promise<SpeakUpDto> {
    const c = await tx.speakUpConcern.findUniqueOrThrow({
      where: { id },
      include: { notes: true },
    });
    return (await concernDtos(tx, [c], true))[0]!;
  }

  private statusNote(tx: TenantTx, hub: HubRequestContext, id: string, note: string, on: string) {
    return tx.speakUpNote.create({
      data: {
        organisationId: hub.orgId as string,
        concernId: id,
        kind: 'STATUS',
        note,
        onDate: day(on),
        createdBy: hub.user.id,
      },
    });
  }
}

/** H6: the stage an anonymous raiser sees follows the concern. */
function syncProgress(tx: TenantTx, concernId: string, status: string) {
  return tx.speakUpProgress.updateMany({
    where: { concernId },
    data: { status, updatedAt: new Date() },
  });
}

/** Unambiguous letters and digits (no 0/O, 1/I/L), in three groups of four. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newProgressCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase()).digest('hex');

/** A version 7 id (time-ordered), made here so an anonymous raise never reads the row back. */
function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function assertMember(tx: TenantTx, userId: string) {
  if (
    !(await tx.membership.count({
      where: { userId, validTo: null, user: { status: 'ACTIVE' } },
    }))
  )
    throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
}

function assertAssessmentDates(assessedOn: string, reviewDue: string) {
  if (assessedOn > londonDate(new Date()))
    throw new HubError('VALIDATION_FAILED', 400, 'The assessment date cannot be in the future');
  if (compareDates(reviewDue, assessedOn) <= 0)
    throw new HubError('VALIDATION_FAILED', 400, 'The review date must be after the assessment');
}

async function concernDtos(
  tx: TenantTx,
  rows: ConcernRow[],
  withNotes: boolean,
  now = new Date(),
): Promise<SpeakUpDto[]> {
  const today = londonDate(now);
  const names = await userNames(
    tx,
    rows.flatMap((r) => [
      r.raisedBy,
      r.handlerUserId,
      r.closedBy,
      ...(withNotes ? r.notes.map((n) => n.createdBy) : []),
    ]),
  );
  return rows.map((r): SpeakUpDto => ({
    id: r.id,
    code: r.code,
    category: r.category as SpeakUpDto['category'],
    channel: r.channel as SpeakUpDto['channel'],
    anonymous: r.anonymous,
    thirdParty: r.thirdParty,
    raisedByName: r.raisedBy ? (names.get(r.raisedBy) ?? null) : null,
    summary: r.summary,
    raisedOn: d(r.raisedOn)!,
    acknowledgeDue: d(r.acknowledgeDue)!,
    acknowledgedOn: d(r.acknowledgedOn),
    acknowledgeOverdue: !r.acknowledgedOn && d(r.acknowledgeDue)! < today,
    handlerUserId: r.handlerUserId,
    handlerName: r.handlerUserId ? (names.get(r.handlerUserId) ?? null) : null,
    status: r.status as SpeakUpDto['status'],
    feedbackGivenOn: d(r.feedbackGivenOn),
    outcome: r.outcome as SpeakUpDto['outcome'],
    outcomeText: r.outcomeText,
    lessons: r.lessons,
    closedOn: d(r.closedOn),
    closedByName: r.closedBy ? (names.get(r.closedBy) ?? null) : null,
    detrimentCheckDue: d(r.detrimentCheckDue),
    detrimentCheckedOn: d(r.detrimentCheckedOn),
    detrimentCheckOverdue:
      !!r.detrimentCheckDue && !r.detrimentCheckedOn && d(r.detrimentCheckDue)! < today,
    ...(withNotes
      ? {
          notes: [...r.notes]
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((n) => ({
              id: n.id,
              kind: n.kind as 'NOTE' | 'FEEDBACK' | 'DETRIMENT_CHECK' | 'STATUS',
              note: n.note,
              on: d(n.onDate)!,
              detrimentReported: n.detrimentReported,
              createdByName: names.get(n.createdBy) ?? null,
              createdAt: n.createdAt.toISOString(),
            })),
        }
      : {}),
    version: r.version,
  }));
}

async function assessmentDtos(
  tx: TenantTx,
  rows: AssessmentRow[],
): Promise<HarassmentAssessmentDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.preparedBy, r.approvedBy]),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    assessedOn: d(r.assessedOn)!,
    reviewDue: d(r.reviewDue)!,
    risks: r.risks as unknown as HarassmentAssessmentDto['risks'],
    status: r.status as HarassmentAssessmentDto['status'],
    preparedBy: r.preparedBy,
    preparedByName: names.get(r.preparedBy) ?? null,
    approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    supersedesId: r.supersedesId,
    version: r.version,
  }));
}
