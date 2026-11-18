import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { createAction, nextCode } from '@hub/domain';
import { addMonths, compareDates, londonDate, notificationTargetDate } from '@hub/rules';
import {
  ContinuityPlanCreate,
  ContinuityPlanRetire,
  ContinuityTestRecord,
  DsptMark,
  DsptStart,
  DsptSubmit,
  SopDraft,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { assertActiveMember, day, idPipe, iso, nextRegisterCode, ymd } from './shared.js';

type PlanRow = Prisma.ContinuityPlanGetPayload<{ include: { tests: true } }>;

/**
 * v36 screen 43, Business continuity: plans with an owner and a test log. Each plan is tested at
 * least once a year; a result short of a clean pass records what happens next.
 */
@Controller('continuity-plans')
export class ContinuityPlansController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.audit.view', 'compliance.policy.manage', 'compliance.registration.manage');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.continuityPlan.findMany({
        include: { tests: { orderBy: { testedOn: 'desc' } } },
        orderBy: [{ status: 'asc' }, { code: 'asc' }],
      });
      return { data: await planDtos(tx, rows) };
    });
  }

  @RequirePermission('compliance.policy.manage')
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(ContinuityPlanCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertActiveMember(tx, input.ownerUserId, 'The owner');
      const p = await tx.continuityPlan.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextRegisterCode(tx, hub.orgId as string, 'BCP'),
          title: input.title,
          steps: input.steps,
          ownerUserId: input.ownerUserId,
          createdBy: hub.user.id,
        },
        include: { tests: true },
      });
      await audit(this.db, tx, hub, {
        action: 'continuity.plan.create',
        entity: 'continuity_plan',
        entityId: p.id,
      });
      return (await planDtos(tx, [p]))[0]!;
    });
  }

  @RequirePermission('compliance.policy.manage')
  @Post(':id/retire')
  async retire(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(ContinuityPlanRetire, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.continuityPlan.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (p.status === 'RETIRED') throw new HubError('CONFLICT', 409, 'Already retired');
      const saved = await tx.continuityPlan.update({
        where: { id },
        data: { status: 'RETIRED', retiredAt: new Date(), retiredBy: hub.user.id },
        include: { tests: true },
      });
      await audit(this.db, tx, hub, {
        action: 'continuity.plan.retire',
        entity: 'continuity_plan',
        entityId: id,
        summary: { reasonGiven: input.reason.length > 0 },
      });
      return (await planDtos(tx, [saved]))[0]!;
    });
  }

  @OrgMember()
  @Post(':id/tests')
  async test(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    requireAny(hub, 'compliance.policy.manage', 'fleet.vehicle.manage', 'jobs.allocate');
    const input = body(ContinuityTestRecord, raw);
    if (input.testedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The test date cannot be in the future');
    if (input.result !== 'PASSED' && !input.followUp)
      throw new HubError('VALIDATION_FAILED', 400, 'Say what happens next after this result');
    const raises = input.result === 'ACTIONS_RAISED' || input.result === 'FAILED';
    if (raises && (!input.actionOwnerUserId || !input.actionDeadline))
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Choose who owns the action and the date it is due',
      );
    if (raises && input.actionDeadline! < londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The action deadline cannot be in the past');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.continuityPlan.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (p.status === 'RETIRED') throw new HubError('CONFLICT', 409, 'This plan is retired');
      let actionId: string | null = null;
      if (raises) {
        await assertActiveMember(tx, input.actionOwnerUserId!, 'The action owner');
        const a = await createAction(tx, {
          organisationId: p.organisationId,
          sourceType: 'CONTINUITY',
          sourceId: p.id,
          title: `${p.code} continuity test: ${input.followUp!}`.slice(0, 200),
          severity: input.result === 'FAILED' ? 'HIGH' : 'MEDIUM',
          ownerUserId: input.actionOwnerUserId!,
          deadline: input.actionDeadline!,
          by: hub.user.id,
        });
        actionId = a.id;
      }
      await tx.continuityTest.create({
        data: {
          organisationId: p.organisationId,
          planId: p.id,
          testedOn: day(input.testedOn),
          method: input.method,
          result: input.result,
          notes: input.notes ?? null,
          followUp: input.followUp ?? null,
          recordedBy: hub.user.id,
          actionId,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'continuity.plan.test',
        entity: 'continuity_plan',
        entityId: id,
        summary: { result: input.result, method: input.method, actionId },
      });
      const fresh = await tx.continuityPlan.findUniqueOrThrow({
        where: { id },
        include: { tests: { orderBy: { testedOn: 'desc' } } },
      });
      return (await planDtos(tx, [fresh]))[0]!;
    });
  }
}

async function planDtos(tx: TenantTx, rows: PlanRow[]) {
  const actionIds = rows.flatMap((r) => r.tests.map((t) => t.actionId)).filter((x): x is string => !!x);
  const actions = new Map(
    (actionIds.length
      ? await tx.action.findMany({
          where: { id: { in: actionIds } },
          select: { id: true, code: true, status: true },
        })
      : []
    ).map((a) => [a.id, a]),
  );
  const names = await userNames(tx, [
    ...rows.map((r) => r.ownerUserId),
    ...rows.flatMap((r) => r.tests.map((t) => t.recordedBy)),
  ]);
  const today = londonDate(new Date());
  return rows.map((p) => {
    const tests = [...p.tests].sort((a, b) => b.testedOn.getTime() - a.testedOn.getTime());
    const last = tests[0];
    const testDue = last ? addMonths(ymd(last.testedOn)!, 12) : null;
    return {
      id: p.id,
      code: p.code,
      title: p.title,
      steps: p.steps,
      ownerUserId: p.ownerUserId,
      ownerName: names.get(p.ownerUserId) ?? null,
      status: p.status as 'ACTIVE' | 'RETIRED',
      lastTestedOn: last ? ymd(last.testedOn) : null,
      lastResult: last?.result ?? null,
      testDue,
      testOverdue: p.status === 'ACTIVE' && (!testDue || compareDates(testDue, today) < 0),
      tests: tests.map((t) => ({
        id: t.id,
        testedOn: ymd(t.testedOn)!,
        method: t.method,
        result: t.result,
        notes: t.notes,
        followUp: t.followUp,
        recordedByName: names.get(t.recordedBy) ?? null,
        actionId: t.actionId,
        actionCode: t.actionId ? (actions.get(t.actionId)?.code ?? null) : null,
        actionStatus: t.actionId ? String(actions.get(t.actionId)?.status ?? '') || null : null,
      })),
    };
  });
}

// ================================================================================================
type SopRow = Prisma.StatementOfPurposeVersionGetPayload<object>;

/**
 * v36 screen 40, Statement of purpose. Versions are drafted, then published by a second person.
 * Publishing supersedes the previous version and drafts the CQC notification (within 28 days).
 */
@Controller('statement-of-purpose')
export class StatementOfPurposeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.registration.manage', 'compliance.audit.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.statementOfPurposeVersion.findMany({ orderBy: { versionNo: 'desc' } });
      return { data: await sopDtos(tx, rows, hub.user.id) };
    });
  }

  @RequirePermission('compliance.registration.manage')
  @Post()
  async draft(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(SopDraft, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const open = await tx.statementOfPurposeVersion.count({ where: { status: 'DRAFT' } });
      if (open)
        throw new HubError('CONFLICT', 409, 'A draft is already waiting to be published or withdrawn');
      if (input.evidenceItemId) {
        const e = await tx.evidenceItem.count({ where: { id: input.evidenceItemId } });
        if (!e) throw notFound();
      }
      const last = await tx.statementOfPurposeVersion.findFirst({ orderBy: { versionNo: 'desc' } });
      const v = await tx.statementOfPurposeVersion.create({
        data: {
          organisationId: hub.orgId as string,
          versionNo: (last?.versionNo ?? 0) + 1,
          summary: input.summary,
          evidenceItemId: input.evidenceItemId ?? null,
          draftedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'registration.sop.draft',
        entity: 'statement_of_purpose_version',
        entityId: v.id,
        summary: { versionNo: v.versionNo },
      });
      return (await sopDtos(tx, [v], hub.user.id))[0]!;
    });
  }

  @RequirePermission('compliance.registration.manage')
  @Post(':id/publish')
  async publish(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.statementOfPurposeVersion.findUnique({ where: { id } });
      if (!v) throw notFound();
      if (v.status !== 'DRAFT') throw new HubError('CONFLICT', 409, 'Only a draft can be published');
      if (v.draftedBy === hub.user.id)
        throw new HubError('FOUR_EYES_REQUIRED', 422, 'You drafted this version, so someone else must publish it');
      const orgId = v.organisationId;
      await tx.statementOfPurposeVersion.updateMany({
        where: { status: 'PUBLISHED' },
        data: { status: 'SUPERSEDED' },
      });
      const today = londonDate(new Date());
      const n = await tx.cqcNotification.create({
        data: {
          organisationId: orgId,
          code: await nextCode(tx, orgId, 'NTF'),
          kind: 'CHANGE_OF_DETAILS',
          occurredOn: day(today),
          dueOn: day(notificationTargetDate('CHANGE_OF_DETAILS', today)),
          summary:
            `Statement of purpose version ${v.versionNo} published in the hub. ` +
            'Send the updated statement of purpose to CQC and record the submission.',
          preparedBy: hub.user.id,
        },
      });
      const saved = await tx.statementOfPurposeVersion.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          publishedBy: hub.user.id,
          publishedAt: new Date(),
          notificationId: n.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'registration.sop.publish',
        entity: 'statement_of_purpose_version',
        entityId: id,
        summary: { versionNo: v.versionNo, notificationId: n.id },
      });
      return (await sopDtos(tx, [saved], hub.user.id))[0]!;
    });
  }

  @RequirePermission('compliance.registration.manage')
  @Post(':id/withdraw')
  async withdraw(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.statementOfPurposeVersion.findUnique({ where: { id } });
      if (!v) throw notFound();
      if (v.status !== 'DRAFT') throw new HubError('CONFLICT', 409, 'Only a draft can be withdrawn');
      const saved = await tx.statementOfPurposeVersion.update({
        where: { id },
        data: { status: 'WITHDRAWN' },
      });
      await audit(this.db, tx, hub, {
        action: 'registration.sop.withdraw',
        entity: 'statement_of_purpose_version',
        entityId: id,
      });
      return (await sopDtos(tx, [saved], hub.user.id))[0]!;
    });
  }
}

async function sopDtos(tx: TenantTx, rows: SopRow[], me: string) {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.draftedBy, r.publishedBy]),
  );
  const ntfIds = rows.map((r) => r.notificationId).filter((x): x is string => !!x);
  const ntf = ntfIds.length
    ? new Map(
        (
          await tx.cqcNotification.findMany({
            where: { id: { in: ntfIds } },
            select: { id: true, code: true },
          })
        ).map((n) => [n.id, n.code]),
      )
    : new Map<string, string>();
  return rows.map((r) => ({
    id: r.id,
    versionNo: r.versionNo,
    summary: r.summary,
    evidenceItemId: r.evidenceItemId,
    status: r.status as 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'WITHDRAWN',
    draftedByName: names.get(r.draftedBy) ?? null,
    draftedAt: r.draftedAt.toISOString(),
    publishedByName: r.publishedBy ? (names.get(r.publishedBy) ?? null) : null,
    publishedAt: iso(r.publishedAt),
    notificationId: r.notificationId,
    notificationCode: r.notificationId ? (ntf.get(r.notificationId) ?? null) : null,
    draftedByMe: r.draftedBy === me,
  }));
}

// ================================================================================================
/** The evidence items tracked for each toolkit year (they mirror the v36 list). */
const DSPT_ITEMS = [
  'Staff data security training at 95% or more',
  'Data protection officer named',
  'Information asset register reviewed this year',
  'Business continuity plan tested this year',
  'Unsupported software removed',
  'Breach reporting process tested',
  'Data processing contracts in place',
  'Backups tested by restore',
];
type DsptRow = Prisma.DsptAssessmentGetPayload<{ include: { items: true } }>;

/**
 * v36 screen 39, DSP Toolkit. One assessment per toolkit year with the evidence items tracked
 * towards it. The hub does not submit to the toolkit; it records the submission and outcome.
 */
@Controller('dspt')
export class DsptController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'privacy.manage', 'compliance.audit.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.dsptAssessment.findMany({
        include: { items: { orderBy: { position: 'asc' } } },
        orderBy: { year: 'desc' },
      });
      return { data: await dsptDtos(tx, rows) };
    });
  }

  @RequirePermission('privacy.manage')
  @Post()
  async start(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(DsptStart, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const dup = await tx.dsptAssessment.count({ where: { year: input.year } });
      if (dup) throw new HubError('CONFLICT', 409, 'That toolkit year is already started');
      const a = await tx.dsptAssessment.create({
        data: {
          organisationId: hub.orgId as string,
          year: input.year,
          dueOn: day(input.dueOn),
          createdBy: hub.user.id,
          items: {
            create: DSPT_ITEMS.map((title, i) => ({
              organisationId: hub.orgId as string,
              position: i + 1,
              title,
            })),
          },
        },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.dspt.start',
        entity: 'dspt_assessment',
        entityId: a.id,
        summary: { year: a.year },
      });
      return (await dsptDtos(tx, [a]))[0]!;
    });
  }

  /** An item is marked as in place with a note saying where the evidence is. */
  @RequirePermission('privacy.manage')
  @Post('items/:id/in-place')
  async mark(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(DsptMark, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const item = await tx.dsptItem.findUnique({ where: { id }, include: { assessment: true } });
      if (!item) throw notFound();
      if (item.assessment.status === 'SUBMITTED')
        throw new HubError('CONFLICT', 409, 'This toolkit year is already submitted');
      if (item.status === 'IN_PLACE') throw new HubError('CONFLICT', 409, 'Already in place');
      if (input.evidenceItemId) {
        const e = await tx.evidenceItem.count({ where: { id: input.evidenceItemId } });
        if (!e) throw notFound();
      }
      await tx.dsptItem.update({
        where: { id },
        data: {
          status: 'IN_PLACE',
          evidenceNote: input.evidenceNote,
          evidenceItemId: input.evidenceItemId ?? null,
          markedBy: hub.user.id,
          markedAt: new Date(),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.dspt.item_in_place',
        entity: 'dspt_item',
        entityId: id,
      });
      const a = await tx.dsptAssessment.findUniqueOrThrow({
        where: { id: item.assessmentId },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      return (await dsptDtos(tx, [a]))[0]!;
    });
  }

  @RequirePermission('privacy.manage')
  @Post(':id/submit')
  async submit(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(DsptSubmit, raw);
    if (input.submittedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The submission date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.dsptAssessment.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status === 'SUBMITTED') throw new HubError('CONFLICT', 409, 'Already submitted');
      await tx.dsptAssessment.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          submittedOn: day(input.submittedOn),
          outcome: input.outcome,
          submittedBy: hub.user.id,
          reference: input.reference ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.dspt.submit',
        entity: 'dspt_assessment',
        entityId: id,
        summary: { outcome: input.outcome },
      });
      const fresh = await tx.dsptAssessment.findUniqueOrThrow({
        where: { id },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      return (await dsptDtos(tx, [fresh]))[0]!;
    });
  }
}

async function dsptDtos(tx: TenantTx, rows: DsptRow[]) {
  const names = await userNames(tx, [
    ...rows.map((r) => r.submittedBy),
    ...rows.flatMap((r) => r.items.map((i) => i.markedBy)),
  ]);
  return rows.map((a) => ({
    id: a.id,
    year: a.year,
    dueOn: ymd(a.dueOn)!,
    status: a.status as 'IN_PROGRESS' | 'SUBMITTED',
    submittedOn: ymd(a.submittedOn),
    outcome: a.outcome,
    submittedByName: a.submittedBy ? (names.get(a.submittedBy) ?? null) : null,
    reference: a.reference,
    inPlace: a.items.filter((i) => i.status === 'IN_PLACE').length,
    total: a.items.length,
    items: a.items.map((i) => ({
      id: i.id,
      position: i.position,
      title: i.title,
      status: i.status as 'NOT_YET' | 'IN_PLACE',
      evidenceNote: i.evidenceNote,
      evidenceItemId: i.evidenceItemId,
      markedByName: i.markedBy ? (names.get(i.markedBy) ?? null) : null,
      markedAt: iso(i.markedAt),
      hint: /training/i.test(i.title)
        ? 'Check the current figure in Staff › Training & reviews'
        : /continuity/i.test(i.title)
          ? 'Business continuity tests are logged under Planning › Business continuity'
          : null,
    })),
  }));
}
