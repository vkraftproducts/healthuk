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
import { createAction, nextCode, refreshAuditOutcome } from '@hub/domain';
import {
  auditOverallResult,
  auditProgress,
  autoActionDeadline,
  isOverdue,
  londonDate,
  needsSpecialist,
  nextRecurrence,
  reauditDueDate,
  repeatedSelections,
  SECTOR_TEMPLATE_NOTE,
  summariseControl,
  templateState,
  unansweredControls,
  type AuditResult,
  type Severity,
} from '@hub/rules';
import type { FindingDto } from '@hub/contracts';
import {
  ActionCreateInput,
  ActionEvidenceInput,
  ActionListQuery,
  ActionPatch,
  ActionVerifyInput,
  AuditPublishInput,
  AuditReviewInput,
  AuditRunCreate,
  AuditTemplateClone,
  AuditTemplateCreate,
  AuditTemplateRetire,
  AuditVersionInput,
  FindingActionInput,
  ResponseInput,
  SampleInput,
  type ActionDto,
  type AuditRunDetailDto,
  type AuditRunDto,
  type AuditTemplateDto,
} from '@hub/contracts';
import { z } from 'zod';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
type Control = {
  code: string;
  question: string;
  guidance?: string;
  failureAction?: string;
  critical?: boolean;
};

type ActionRow = Prisma.ActionGetPayload<{ include: { history: true } }>;
export function toActionDto(a: ActionRow, now = new Date()): ActionDto {
  return {
    id: a.id,
    code: a.code,
    sourceType: a.sourceType as ActionDto['sourceType'],
    sourceId: a.sourceId,
    kind: a.kind as ActionDto['kind'],
    title: a.title,
    severity: a.severity,
    ownerUserId: a.ownerUserId,
    deadline: iso(a.deadline) as string,
    status: a.status,
    evidenceItemIds: a.evidenceItemIds,
    verifierUserId: a.verifierUserId,
    verifiedAt: a.verifiedAt?.toISOString() ?? null,
    reauditRunId: a.reauditRunId,
    overdue: a.status !== 'VERIFIED' && isOverdue(iso(a.deadline) as string, now),
    history: a.history
      .sort((x, y) => x.at.getTime() - y.at.getTime())
      .map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        note: h.note,
        byUserId: h.byUserId,
        at: h.at.toISOString(),
      })),
    version: a.version,
  };
}

/** Adds owner and history names to action DTOs for screens. */
export async function withActionNames(tx: TenantTx, dtos: ActionDto[]): Promise<ActionDto[]> {
  const names = await userNames(
    tx,
    dtos.flatMap((a) => [a.ownerUserId, ...a.history.map((h) => h.byUserId)]),
  );
  return dtos.map((a) => ({
    ...a,
    ownerName: names.get(a.ownerUserId) ?? null,
    history: a.history.map((h) => ({ ...h, byName: names.get(h.byUserId) ?? null })),
  }));
}

async function assertMember(tx: TenantTx, userId: string): Promise<void> {
  if (
    !(await tx.membership.count({ where: { userId, validTo: null, user: { status: 'ACTIVE' } } }))
  )
    throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
}

/** Audit builder, runs, sampling, findings and corrective actions (AUD-01/02, UAT-04). */
@Controller()
export class AuditsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- templates ------------------------------------------------------------------
  @RequirePermission('compliance.audit.view')
  @Get('audit-templates')
  async templates(@Hub() hub: HubRequestContext): Promise<{ data: AuditTemplateDto[] }> {
    const data = await this.db.withTenant(tenantOf(hub), async (tx) =>
      tplDtos(
        tx,
        await tx.auditTemplate.findMany({
          include: { versions: { orderBy: { version: 'desc' } } },
          orderBy: { code: 'asc' },
        }),
      ),
    );
    return { data };
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-templates')
  async createTemplate(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<AuditTemplateDto> {
    const input = body(AuditTemplateCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (await tx.auditTemplate.findFirst({ where: { code: input.code } }))
        throw new HubError('CONFLICT', 409, 'That code is already used');
      const t = await tx.auditTemplate.create({
        data: {
          organisationId: hub.orgId as string,
          code: input.code,
          title: input.title,
          domain: input.domain,
          sourceRef: input.sourceRef ?? null,
          createdBy: hub.user.id,
        },
      });
      await tx.auditTemplateVersion.create({
        data: versionData(t.organisationId, t.id, 1, input.version, hub.user.id),
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.create',
        entity: 'audit_template',
        entityId: t.id,
      });
      return this.tpl(tx, t.id);
    });
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-templates/:id/versions')
  async newVersion(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditTemplateDto> {
    const input = body(AuditVersionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.auditTemplate.findUnique({ where: { id }, include: { versions: true } });
      if (!t) throw notFound();
      if (t.versions.some((v) => v.status === 'DRAFT'))
        throw new HubError('CONFLICT', 409, 'Finish or discard the current draft first');
      const next = Math.max(...t.versions.map((v) => v.version)) + 1;
      await tx.auditTemplateVersion.create({
        data: versionData(t.organisationId, id, next, input, hub.user.id),
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.version',
        entity: 'audit_template',
        entityId: id,
        summary: { version: next },
      });
      return this.tpl(tx, id);
    });
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-templates/:id/versions/:versionId/publish')
  async publish(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('versionId', idPipe) versionId: string,
    @Body() raw: unknown,
  ): Promise<AuditTemplateDto> {
    const input = body(AuditPublishInput, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.auditTemplateVersion.findFirst({
        where: { id: versionId, templateId: id },
        include: { template: true },
      });
      if (!v) throw notFound();
      if (v.status !== 'DRAFT') throw new HubError('CONFLICT', 409, 'Already published');
      if (v.template.retiredAt) throw new HubError('CONFLICT', 409, 'The template is retired');
      if (v.createdBy === hub.user.id)
        throw new HubError(
          'FOUR_EYES_REQUIRED',
          422,
          'A second person must publish the version they did not write',
        );
      if (needsSpecialist(v.template.sectorPack) && !(input.specialistName && input.specialistRole))
        throw new HubError(
          'VALIDATION_FAILED',
          422,
          'Dental and care home content needs the validating specialist’s name and role',
        );
      await tx.auditTemplateVersion.updateMany({
        where: { templateId: id, status: 'PUBLISHED' },
        data: { status: 'RETIRED' },
      });
      await tx.auditTemplateVersion.update({
        where: { id: versionId },
        data: {
          status: 'PUBLISHED',
          approvedBy: hub.user.id,
          approvedAt: new Date(),
          specialistName: input.specialistName ?? null,
          specialistRole: input.specialistRole ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.publish',
        entity: 'audit_template',
        entityId: id,
        summary: { version: v.version },
      });
      return this.tpl(tx, id);
    });
  }

  /** Starter controls ship inactive; management activates them after review (DECISIONS A8). */
  @RequirePermission('compliance.requirement.manage')
  @Post('audit-templates/:id/activate')
  async activate(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AuditTemplateDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.auditTemplate.findUnique({ where: { id }, include: { versions: true } });
      if (!t) throw notFound();
      const published = t.versions.find((v) => v.status === 'PUBLISHED');
      if (!published) throw new HubError('TEMPLATE_NOT_PUBLISHED', 422, 'Publish a version first');
      if (t.active) throw new HubError('CONFLICT', 409, 'The template is already active');
      // Management approval is a separate person from whoever wrote the questions.
      if (published.createdBy === hub.user.id)
        throw new HubError(
          'FOUR_EYES_REQUIRED',
          422,
          'Someone other than the author of the published version must activate it',
        );
      if (t.retiredAt) throw new HubError('CONFLICT', 409, 'The template is retired');
      await tx.auditTemplate.update({ where: { id }, data: { active: true } });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.activate',
        entity: 'audit_template',
        entityId: id,
      });
      return this.tpl(tx, id);
    });
  }

  /** A new template starting from this one's latest version, as a draft (G1). */
  @RequirePermission('compliance.audit.run')
  @Post('audit-templates/:id/clone')
  async clone(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditTemplateDto> {
    const input = body(AuditTemplateClone, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const src = await tx.auditTemplate.findUnique({
        where: { id },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!src || !src.versions[0]) throw notFound();
      if (await tx.auditTemplate.findFirst({ where: { code: input.code } }))
        throw new HubError('CONFLICT', 409, 'That code is already used');
      const v = src.versions[0];
      const t = await tx.auditTemplate.create({
        data: {
          organisationId: hub.orgId as string,
          code: input.code,
          title: input.title,
          domain: src.domain,
          sourceRef: src.sourceRef,
          sectorPack: src.sectorPack,
          proposedCadence: src.proposedCadence,
          clonedFrom: src.id,
          createdBy: hub.user.id,
        },
      });
      await tx.auditTemplateVersion.create({
        data: {
          organisationId: t.organisationId,
          templateId: t.id,
          version: 1,
          controls: v.controls as Prisma.InputJsonArray,
          sampleMethod: v.sampleMethod,
          sampleSize: v.sampleSize,
          methods: v.methods,
          frequency: v.frequency,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.clone',
        entity: 'audit_template',
        entityId: t.id,
        summary: { from: src.code },
      });
      return this.tpl(tx, t.id);
    });
  }

  /** Retired templates cannot be scheduled; past runs and results stay unchanged. */
  @RequirePermission('compliance.requirement.manage')
  @Post('audit-templates/:id/retire')
  async retire(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditTemplateDto> {
    const input = body(AuditTemplateRetire, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.auditTemplate.findUnique({ where: { id } });
      if (!t) throw notFound();
      if (t.retiredAt) throw new HubError('CONFLICT', 409, 'The template is already retired');
      await tx.auditTemplate.update({
        where: { id },
        data: {
          active: false,
          retiredAt: new Date(),
          retiredBy: hub.user.id,
          retiredReason: input.reason,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit_template.retire',
        entity: 'audit_template',
        entityId: id,
      });
      return this.tpl(tx, id);
    });
  }

  // ---- runs -------------------------------------------------------------------------
  @RequirePermission('compliance.audit.view')
  @Get('audit-runs')
  async runs(@Hub() hub: HubRequestContext): Promise<{ data: AuditRunDto[] }> {
    const data = await this.db.withTenant(tenantOf(hub), async (tx) =>
      runDtos(
        tx,
        await tx.auditRun.findMany({
          include: { templateVersion: { include: { template: true } } },
          orderBy: [{ dueDate: 'asc' }, { code: 'asc' }],
          take: 500,
        }),
      ),
    );
    return { data };
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-runs')
  async createRun(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<AuditRunDto> {
    const input = body(AuditRunCreate, raw);
    if (input.periodFrom && input.periodTo && input.periodTo < input.periodFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'The period ends before it starts');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.auditTemplateVersion.findUnique({
        where: { id: input.templateVersionId },
        include: { template: true },
      });
      if (!v) throw notFound();
      if (v.status !== 'PUBLISHED')
        throw new HubError('TEMPLATE_NOT_PUBLISHED', 422, 'Runs use a published version');
      if (!v.template.active)
        throw new HubError(
          'TEMPLATE_NOT_PUBLISHED',
          422,
          v.template.retiredAt
            ? 'The template is retired'
            : 'The template is not active yet (management approval needed)',
        );
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      if (input.serviceId && !(await tx.serviceType.findUnique({ where: { id: input.serviceId } })))
        throw notFound();
      await assertMember(tx, input.auditorUserId);
      await assertMember(tx, input.ownerUserId);
      if (input.reviewerUserId) {
        if (input.reviewerUserId === input.auditorUserId)
          throw new HubError('SELF_APPROVAL', 422, 'The reviewer must not be the auditor');
        await assertMember(tx, input.reviewerUserId);
      }
      const r = await this.newRun(tx, hub, { ...input, templateVersionId: v.id });
      return (await runDtos(tx, [{ ...r, templateVersion: v }]))[0]!;
    });
  }

  @RequirePermission('compliance.audit.view')
  @Get('audit-runs/:id')
  async run(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AuditRunDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.auditRun.count({ where: { id } }))) throw notFound();
      return this.detail(tx, id);
    });
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-runs/:id/samples')
  async sample(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditRunDetailDto> {
    const input = body(SampleInput, raw);
    if (input.dateTo < input.dateFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'The date range ends before it starts');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const run = await this.openRun(tx, id);
      // AUD-02: repeated selection of the same subjects needs a recorded reason.
      const recent = await tx.auditSample.findMany({
        where: {
          run: { templateVersion: { templateId: run.templateVersion.templateId } },
          runId: { not: id },
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      const repeats = repeatedSelections(
        input.subjectIds,
        recent.map((r) => r.subjectIds),
      );
      if (repeats.length > 0 && !input.repeatReason)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          `${repeats.length} subject(s) were sampled in recent audits; give a reason to sample them again`,
        );
      await tx.auditSample.create({
        data: {
          organisationId: run.organisationId,
          runId: id,
          populationDesc: input.populationDesc,
          selectionMethod: input.selectionMethod,
          dateFrom: day(input.dateFrom),
          dateTo: day(input.dateTo),
          subjectType: input.subjectType,
          subjectIds: input.subjectIds,
          reviewerUserId: hub.user.id,
          repeatReason: input.repeatReason ?? null,
        },
      });
      if (run.status === 'SCHEDULED')
        await tx.auditRun.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit.sample',
        entity: 'audit_run',
        entityId: id,
        summary: { subjects: input.subjectIds.length },
      });
      return this.detail(tx, id);
    });
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-runs/:id/responses')
  async respond(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditRunDetailDto> {
    const input = body(ResponseInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const run = await this.openRun(tx, id);
      const controls = run.templateVersion.controls as Control[];
      for (const r of input.responses) {
        if (!controls.some((c) => c.code === r.controlCode))
          throw new HubError('VALIDATION_FAILED', 400, `Unknown control ${r.controlCode}`);
        if (
          ['PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE', 'NOT_ASSESSED'].includes(r.result) &&
          !r.note
        )
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            'Partial, failed, N/A and not-assessed answers need a note giving the reason',
          );
        if (!run.templateVersion.methods.includes(r.method))
          throw new HubError('VALIDATION_FAILED', 400, 'That method is not used by this audit');
        if (r.evidenceItemId && !(await tx.evidenceItem.count({ where: { id: r.evidenceItemId } })))
          throw notFound();
      }
      await tx.auditResponse.createMany({
        data: input.responses.map((r) => ({
          organisationId: run.organisationId,
          runId: id,
          controlCode: r.controlCode,
          subjectId: r.subjectId ?? null,
          result: r.result,
          method: r.method,
          note: r.note ?? null,
          evidenceItemId: r.evidenceItemId ?? null,
          recordedBy: hub.user.id,
        })),
      });
      if (run.status === 'SCHEDULED')
        await tx.auditRun.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit.respond',
        entity: 'audit_run',
        entityId: id,
        summary: { responses: input.responses.length },
      });
      return this.detail(tx, id);
    });
  }

  /** Submitting fixes the responses and computes one finding per control (worst result wins). */
  @RequirePermission('compliance.audit.run')
  @Post('audit-runs/:id/submit')
  async submit(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AuditRunDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const run = await this.openRun(tx, id);
      const responses = await tx.auditResponse.findMany({
        where: { runId: id },
        orderBy: { recordedAt: 'asc' },
      });
      if (responses.length === 0)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Record at least one response before submitting',
        );
      const controls = run.templateVersion.controls as Control[];
      const missing = unansweredControls(
        controls,
        responses.map((r) => r.controlCode),
      );
      if (missing.length > 0)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Answer every control before submitting (use N/A or Not assessed with a reason): ' +
            missing.join(', '),
        );
      const submissionNo = run.submissionNo + 1;
      // The latest answer per (control, subject) counts; earlier ones stay as history.
      const latest = new Map<string, (typeof responses)[number]>();
      for (const r of responses) latest.set(`${r.controlCode}|${r.subjectId ?? ''}`, r);
      const failed: { finding: string; control: Control; severity: Severity }[] = [];
      for (const c of controls) {
        const results = [...latest.values()]
          .filter((r) => r.controlCode === c.code)
          .map((r) => r.result as AuditResult);
        const s = summariseControl(results, !!c.critical);
        const f = await tx.auditFinding.create({
          data: {
            organisationId: run.organisationId,
            runId: id,
            controlCode: c.code,
            passCount: s.pass,
            partialCount: s.partial,
            failCount: s.fail,
            naCount: s.na,
            result: s.result,
            severity: s.severity,
            summary: s.text,
            createdBy: hub.user.id,
            submissionNo,
          },
        });
        if (s.result === 'NON_COMPLIANT' || s.result === 'PARTIAL')
          failed.push({ finding: f.id, control: c, severity: s.severity as Severity });
      }
      // Failures become draft actions owned by the audit owner (G2); a returned audit that is
      // submitted again does not duplicate actions already raised for the same control.
      const earlier = await tx.auditFinding.findMany({
        where: { runId: id, submissionNo: { lt: submissionNo } },
        select: { id: true, controlCode: true },
      });
      const raised = new Set(
        (
          await tx.action.findMany({
            where: { sourceType: 'FINDING', sourceId: { in: earlier.map((x) => x.id) } },
            select: { sourceId: true },
          })
        ).map((a) => earlier.find((x) => x.id === a.sourceId)?.controlCode),
      );
      const today = londonDate(new Date());
      const deadlines: string[] = [];
      for (const x of failed) {
        if (raised.has(x.control.code)) continue;
        const deadline = autoActionDeadline(x.severity, today);
        deadlines.push(deadline);
        await createAction(tx, {
          organisationId: run.organisationId,
          sourceType: 'FINDING',
          sourceId: x.finding,
          title: (x.control.failureAction || `Put right: ${x.control.question}`).slice(0, 300),
          severity: x.severity,
          ownerUserId: run.ownerUserId,
          deadline,
          by: hub.user.id,
        });
      }
      await tx.auditRun.update({
        where: { id },
        data: { status: 'SUBMITTED', submittedAt: new Date(), submissionNo, reviewState: null },
      });
      // Re-audit after the action deadlines, on the same template version (G2).
      const due = reauditDueDate(deadlines);
      if (due)
        await this.newRun(tx, hub, {
          templateVersionId: run.templateVersionId,
          title: `Re-audit: ${run.title}`.slice(0, 200),
          locationId: run.locationId ?? undefined,
          serviceId: run.serviceId ?? undefined,
          reviewerUserId: run.reviewerUserId ?? undefined,
          auditorUserId: run.auditorUserId,
          ownerUserId: run.ownerUserId,
          dueDate: due,
          reauditOf: id,
        });
      await refreshAuditOutcome(tx, id);
      await audit(this.db, tx, hub, {
        action: 'compliance.audit.submit',
        entity: 'audit_run',
        entityId: id,
        summary: { submissionNo, actions: deadlines.length },
      });
      return this.detail(tx, id);
    });
  }

  /**
   * Reviewer accepts (the audit is locked; a recurring audit gets its next run) or returns it
   * with a reason (answers can be added and it is submitted again). Never the auditor.
   */
  @RequirePermission('compliance.audit.run')
  @Post('audit-runs/:id/review')
  async review(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AuditRunDetailDto> {
    const input = body(AuditReviewInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const run = await tx.auditRun.findUnique({ where: { id } });
      if (!run) throw notFound();
      if (run.status === 'SCHEDULED' || run.status === 'IN_PROGRESS')
        throw new HubError('CONFLICT', 409, 'The audit has not been submitted yet');
      if (run.reviewState)
        throw new HubError(
          'CONFLICT',
          409,
          run.reviewState === 'ACCEPTED'
            ? 'The audit has already been accepted'
            : 'The audit was returned; it must be submitted again first',
        );
      if (run.auditorUserId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'The auditor cannot review their own audit');
      if (run.reviewerUserId && run.reviewerUserId !== hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'Only the named reviewer can review this audit');
      await tx.auditReview.create({
        data: {
          organisationId: run.organisationId,
          runId: id,
          submissionNo: run.submissionNo,
          decision: input.decision,
          reason: input.reason || 'Accepted',
          reviewedBy: hub.user.id,
        },
      });
      let nextRunId: string | null = run.nextRunId;
      if (input.decision === 'ACCEPTED' && run.recurrenceMonths && !run.nextRunId) {
        const next = await this.newRun(tx, hub, {
          templateVersionId: run.templateVersionId,
          title: run.title,
          locationId: run.locationId ?? undefined,
          serviceId: run.serviceId ?? undefined,
          reviewerUserId: run.reviewerUserId ?? undefined,
          recurrenceMonths: run.recurrenceMonths,
          auditorUserId: run.auditorUserId,
          ownerUserId: run.ownerUserId,
          dueDate: nextRecurrence(iso(run.dueDate) as string, run.recurrenceMonths),
        });
        nextRunId = next.id;
      }
      await tx.auditRun.update({
        where: { id },
        data: { reviewState: input.decision, nextRunId },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.audit.review',
        entity: 'audit_run',
        entityId: id,
        summary: { decision: input.decision, submissionNo: run.submissionNo },
      });
      return this.detail(tx, id);
    });
  }

  @RequirePermission('compliance.audit.run')
  @Post('audit-runs/:id/findings')
  async observation(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<z.infer<typeof FindingDto>> {
    const input = body(
      z.strictObject({
        controlCode: z.string(),
        summary: z.string().trim().min(3).max(1000),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      }),
      raw,
    );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const run = await tx.auditRun.findUnique({ where: { id } });
      if (!run) throw notFound();
      if (run.status === 'SCHEDULED' || run.status === 'IN_PROGRESS')
        throw new HubError(
          'CONFLICT',
          409,
          'Submit the audit first; observations are added to submitted audits',
        );
      if (run.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'The audit is closed');
      const f = await tx.auditFinding.create({
        data: {
          organisationId: run.organisationId,
          runId: id,
          controlCode: input.controlCode,
          result: 'NON_COMPLIANT',
          severity: input.severity,
          summary: input.summary,
          failCount: 1,
          createdBy: hub.user.id,
          submissionNo: Math.max(1, run.submissionNo),
        },
      });
      await refreshAuditOutcome(tx, id);
      await audit(this.db, tx, hub, {
        action: 'compliance.audit.observation',
        entity: 'audit_finding',
        entityId: f.id,
        summary: { runId: id, severity: input.severity },
      });
      return {
        id: f.id,
        controlCode: f.controlCode,
        passCount: 0,
        partialCount: 0,
        failCount: 1,
        naCount: 0,
        result: f.result,
        severity: f.severity,
        summary: f.summary,
      };
    });
  }

  @RequirePermission('compliance.action.manage')
  @Post('findings/:id/actions')
  async findingAction(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ActionDto> {
    const input = body(FindingActionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const f = await tx.auditFinding.findUnique({
        where: { id },
        include: { run: { include: { templateVersion: true } } },
      });
      if (!f) throw notFound();
      if (f.run.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'The audit is closed');
      if (input.deadline < londonDate(new Date()))
        throw new HubError('VALIDATION_FAILED', 400, 'The deadline is in the past');
      await assertMember(tx, input.ownerUserId);
      let reauditRunId: string | null = null;
      if (input.kind === 'REAUDIT') {
        // The re-audit is a new run on the same template version; the original stays unchanged.
        const r = await this.newRun(tx, hub, {
          templateVersionId: f.run.templateVersionId,
          title: `Re-audit: ${f.run.title}`.slice(0, 200),
          locationId: f.run.locationId ?? undefined,
          auditorUserId: f.run.auditorUserId,
          ownerUserId: input.ownerUserId,
          dueDate: input.deadline,
          reauditOf: f.runId,
        });
        reauditRunId = r.id;
      }
      const a = await createAction(tx, {
        organisationId: f.organisationId,
        sourceType: 'FINDING',
        sourceId: id,
        kind: input.kind,
        title: input.title,
        severity: input.severity ?? f.severity,
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
        reauditRunId,
      });
      await refreshAuditOutcome(tx, f.runId);
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { findingId: id, kind: input.kind },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }

  // ---- actions --------------------------------------------------------------------------
  @OrgMember()
  @Get('actions')
  async actions(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: ActionDto[] }> {
    requireAny(hub, 'compliance.audit.view', 'compliance.action.manage', 'events.event.view');
    const f = body(ActionListQuery, q);
    const today = new Date(`${londonDate(new Date())}T00:00:00.000Z`);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.action.findMany({
        where: {
          ...(f.status === 'ACTIVE' ? { status: { not: 'VERIFIED' } } : { status: f.status }),
          ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
          ...(f.sourceType ? { sourceType: f.sourceType } : {}),
          ...(f.overdue === 'true' ? { deadline: { lt: today }, NOT: { status: 'VERIFIED' } } : {}),
          ...(f.overdue === 'false' ? { deadline: { gte: today } } : {}),
        },
        include: { history: true },
        orderBy: [{ deadline: 'asc' }, { code: 'asc' }],
        take: 500,
      });
      const findings = await tx.auditFinding.findMany({
        where: {
          id: { in: rows.filter((a) => a.sourceType === 'FINDING').map((a) => a.sourceId) },
        },
        select: { id: true, runId: true },
      });
      const runOf = new Map(findings.map((x) => [x.id, x.runId]));
      return {
        data: await withActionNames(
          tx,
          rows.map((a) => {
            const auditRunId = a.sourceType === 'FINDING' ? runOf.get(a.sourceId) : undefined;
            return { ...toActionDto(a), ...(auditRunId ? { auditRunId } : {}) };
          }),
        ),
      };
    });
  }

  /** Raise an action from any source with an owner picked (G3). */
  @RequirePermission('compliance.action.manage')
  @Post('actions')
  async raiseAction(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ActionDto> {
    const input = body(ActionCreateInput, raw);
    if (input.deadline < londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The deadline is in the past');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const id = input.sourceId;
      const found =
        input.sourceType === 'FINDING'
          ? await tx.auditFinding.count({ where: { id } })
          : input.sourceType === 'EVENT'
            ? await tx.event.count({ where: { id } })
            : input.sourceType === 'RISK'
              ? await tx.risk.count({ where: { id } })
              : input.sourceType === 'CORRESPONDENCE'
                ? await tx.regulatoryCorrespondence.count({ where: { id } })
                : input.sourceType === 'FEEDBACK'
                  ? await tx.feedbackItem.count({ where: { id } })
                  : input.sourceType === 'PREMISES'
                    ? await tx.premisesItem.count({ where: { id } })
                    : await tx.governanceMeeting.count({ where: { id } });
      if (!found) throw notFound();
      await assertMember(tx, input.ownerUserId);
      const a = await createAction(tx, {
        organisationId: hub.orgId as string,
        sourceType: input.sourceType,
        sourceId: id,
        title: input.title,
        severity: input.severity ?? 'MEDIUM',
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
      });
      if (input.sourceType === 'FINDING') await this.refreshSource(tx, input);
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { sourceType: input.sourceType },
      });
      const row = await tx.action.findUniqueOrThrow({
        where: { id: a.id },
        include: { history: true },
      });
      return (await withActionNames(tx, [toActionDto(row)]))[0]!;
    });
  }

  @OrgMember()
  @Get('actions/:id')
  async action(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<ActionDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.action.findUnique({ where: { id }, include: { history: true } });
      const allowed =
        hub.permissions.has('compliance.audit.view') ||
        hub.permissions.has('compliance.action.manage') ||
        a?.ownerUserId === hub.user.id;
      if (!a || !allowed) throw notFound();
      return (await withActionNames(tx, [toActionDto(a)]))[0]!;
    });
  }

  @RequirePermission('compliance.action.manage')
  @Patch('actions/:id')
  async patchAction(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ActionDto> {
    const expected = ifMatchVersion(req);
    const input = body(ActionPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.action.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status === 'VERIFIED')
        throw new HubError('CONFLICT', 409, 'A verified action cannot be changed');
      if (input.deadline && input.deadline < londonDate(new Date()))
        throw new HubError('VALIDATION_FAILED', 400, 'The deadline is in the past');
      if (input.ownerUserId) await assertMember(tx, input.ownerUserId);
      const r = await tx.action.updateMany({
        where: { id, version: expected },
        data: {
          ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
          ...(input.deadline ? { deadline: day(input.deadline) } : {}),
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      const changes = [
        input.ownerUserId && input.ownerUserId !== a.ownerUserId ? 'owner changed' : null,
        input.deadline && input.deadline !== iso(a.deadline)
          ? `deadline moved from ${iso(a.deadline)} to ${input.deadline}`
          : null,
      ].filter(Boolean);
      await tx.actionHistory.create({
        data: {
          organisationId: a.organisationId,
          actionId: id,
          fromStatus: a.status,
          toStatus: a.status,
          note: `${changes.join('; ') || 'No change'}: ${input.reason}`.slice(0, 2000),
          byUserId: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.update',
        entity: 'action',
        entityId: id,
        summary: { owner: !!input.ownerUserId, deadline: !!input.deadline },
      });
      const updated = await tx.action.findUniqueOrThrow({
        where: { id },
        include: { history: true },
      });
      return (await withActionNames(tx, [toActionDto(updated)]))[0]!;
    });
  }

  /** Evidence moves the action to EVIDENCE_SUBMITTED only; closure needs verification (UAT-04). */
  @OrgMember()
  @Post('actions/:id/evidence')
  async evidence(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ActionDto> {
    const input = body(ActionEvidenceInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.action.findUnique({ where: { id } });
      if (!a || (a.ownerUserId !== hub.user.id && !hub.permissions.has('compliance.action.manage')))
        throw notFound();
      if (a.kind === 'REAUDIT')
        throw new HubError('CONFLICT', 409, 'A re-audit is closed by completing the re-audit run');
      if (a.status === 'VERIFIED')
        throw new HubError('CONFLICT', 409, 'The action is already verified');
      for (const itemId of input.evidenceItemIds) {
        const ok = await tx.evidenceVersion.count({ where: { itemId, scanStatus: 'CLEAN' } });
        if (!ok)
          throw new HubError(
            'EVIDENCE_NOT_VERIFIED',
            422,
            'Evidence must be uploaded and pass the file check first',
          );
      }
      await tx.action.update({
        where: { id },
        data: {
          status: 'EVIDENCE_SUBMITTED',
          evidenceItemIds: [...new Set([...a.evidenceItemIds, ...input.evidenceItemIds])],
          evidenceBy: hub.user.id,
        },
      });
      await tx.actionHistory.create({
        data: {
          organisationId: a.organisationId,
          actionId: id,
          fromStatus: a.status,
          toStatus: 'EVIDENCE_SUBMITTED',
          note: input.note ?? 'Evidence submitted',
          byUserId: hub.user.id,
        },
      });
      await this.refreshSource(tx, a);
      await audit(this.db, tx, hub, {
        action: 'compliance.action.evidence',
        entity: 'action',
        entityId: id,
        summary: { items: input.evidenceItemIds.length },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id }, include: { history: true } }),
      );
    });
  }

  @RequirePermission('compliance.action.verify')
  @Post('actions/:id/verify')
  async verify(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ActionDto> {
    const input = body(ActionVerifyInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.action.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status === 'VERIFIED') throw new HubError('CONFLICT', 409, 'Already verified');
      if (a.ownerUserId === hub.user.id || a.evidenceBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          422,
          'Verification must be by someone other than the owner and the person who submitted the evidence',
        );
      if (a.kind === 'REAUDIT') {
        const run = a.reauditRunId
          ? await tx.auditRun.findUnique({ where: { id: a.reauditRunId } })
          : null;
        if (input.decision === 'ACCEPTED' && run?.status !== 'CLOSED')
          throw new HubError('CONFLICT', 409, 'The re-audit has not been completed and closed yet');
      } else if (a.status !== 'EVIDENCE_SUBMITTED') {
        throw new HubError(
          'EVIDENCE_NOT_VERIFIED',
          422,
          'There is no submitted evidence to verify',
        );
      }
      const to = input.decision === 'ACCEPTED' ? 'VERIFIED' : 'REJECTED';
      await tx.action.update({
        where: { id },
        data: {
          status: to,
          ...(to === 'VERIFIED' ? { verifierUserId: hub.user.id, verifiedAt: new Date() } : {}),
        },
      });
      await tx.actionHistory.create({
        data: {
          organisationId: a.organisationId,
          actionId: id,
          fromStatus: a.status,
          toStatus: to,
          note: input.reason,
          byUserId: hub.user.id,
        },
      });
      await this.refreshSource(tx, a);
      await audit(this.db, tx, hub, {
        action: 'compliance.action.verify',
        entity: 'action',
        entityId: id,
        summary: { decision: input.decision },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id }, include: { history: true } }),
      );
    });
  }

  // ---- helpers --------------------------------------------------------------------------
  private async refreshSource(tx: TenantTx, a: { sourceType: string; sourceId: string }) {
    if (a.sourceType !== 'FINDING') return;
    const f = await tx.auditFinding.findUnique({ where: { id: a.sourceId } });
    if (f) await refreshAuditOutcome(tx, f.runId);
  }

  private async newRun(
    tx: TenantTx,
    hub: HubRequestContext,
    i: {
      templateVersionId: string;
      title: string;
      locationId?: string;
      periodFrom?: string;
      periodTo?: string;
      auditorUserId: string;
      ownerUserId: string;
      dueDate: string;
      reauditOf?: string;
      serviceId?: string;
      reviewerUserId?: string;
      recurrenceMonths?: number;
    },
  ) {
    const code = await nextCode(tx, hub.orgId as string, 'AUD');
    const r = await tx.auditRun.create({
      data: {
        organisationId: hub.orgId as string,
        code,
        templateVersionId: i.templateVersionId,
        title: i.title,
        locationId: i.locationId ?? null,
        serviceId: i.serviceId ?? null,
        reviewerUserId: i.reviewerUserId ?? null,
        recurrenceMonths: i.recurrenceMonths ?? null,
        periodFrom: i.periodFrom ? day(i.periodFrom) : null,
        periodTo: i.periodTo ? day(i.periodTo) : null,
        auditorUserId: i.auditorUserId,
        ownerUserId: i.ownerUserId,
        dueDate: day(i.dueDate),
        reauditOf: i.reauditOf ?? null,
        createdBy: hub.user.id,
      },
    });
    await audit(this.db, tx, hub, {
      action: 'compliance.audit.schedule',
      entity: 'audit_run',
      entityId: r.id,
      summary: { code },
    });
    return r;
  }

  /** Open for answers while scheduled or in progress, or after a reviewer returned it. */
  private async openRun(tx: TenantTx, id: string) {
    const run = await tx.auditRun.findUnique({ where: { id }, include: { templateVersion: true } });
    if (!run) throw notFound();
    const open = run.status === 'SCHEDULED' || run.status === 'IN_PROGRESS';
    if (!open && run.reviewState !== 'RETURNED')
      throw new HubError(
        'CONFLICT',
        409,
        'The audit has been submitted; the original record is fixed',
      );
    return run;
  }

  private async tpl(tx: TenantTx, id: string): Promise<AuditTemplateDto> {
    const t = await tx.auditTemplate.findUniqueOrThrow({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    return (await tplDtos(tx, [t]))[0]!;
  }

  private async detail(tx: TenantTx, id: string): Promise<AuditRunDetailDto> {
    const r0 = await tx.auditRun.findUniqueOrThrow({
      where: { id },
      include: {
        templateVersion: { include: { template: true } },
        samples: { orderBy: { createdAt: 'asc' } },
        responses: { orderBy: { recordedAt: 'asc' } },
        findings: { orderBy: { controlCode: 'asc' } },
        reviews: { orderBy: { reviewedAt: 'asc' } },
      },
    });
    // Findings of the latest submission; earlier ones (before a return) stay in the database.
    const r = {
      ...r0,
      findings: r0.findings.filter((f) => f.submissionNo === Math.max(1, r0.submissionNo)),
    };
    const controlList = r.templateVersion.controls as Control[];
    const reviewers = await userNames(
      tx,
      r.reviews.map((x) => x.reviewedBy),
    );
    const actions = await tx.action.findMany({
      where: { sourceType: 'FINDING', sourceId: { in: r.findings.map((f) => f.id) } },
      include: { history: true },
      orderBy: { code: 'asc' },
    });
    const recent = await tx.auditSample.findMany({
      where: {
        run: { templateVersion: { templateId: r.templateVersion.templateId } },
        runId: { not: id },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    const recorders = await userNames(
      tx,
      r.responses.map((x) => x.recordedBy),
    );
    return {
      ...(await runDtos(tx, [r]))[0]!,
      controls: controlList.map((c) => ({
        code: c.code,
        question: c.question,
        critical: !!c.critical,
        ...(c.guidance ? { guidance: c.guidance } : {}),
        ...(c.failureAction ? { failureAction: c.failureAction } : {}),
      })),
      progress: auditProgress(
        controlList,
        r.responses.map((x) => x.controlCode),
      ),
      overall:
        r.findings.length > 0
          ? auditOverallResult(
              r.findings.map((f) => ({
                result: f.result as AuditResult,
                critical: !!controlList.find((c) => c.code === f.controlCode)?.critical,
              })),
            )
          : { result: null, text: 'Not submitted yet' },
      reviews: r.reviews.map((x) => ({
        decision: x.decision as 'ACCEPTED' | 'RETURNED',
        reason: x.reason,
        byName: reviewers.get(x.reviewedBy) ?? null,
        at: x.reviewedAt.toISOString(),
      })),
      methods: r.templateVersion.methods as AuditRunDetailDto['methods'],
      samples: r.samples.map((s) => ({
        id: s.id,
        populationDesc: s.populationDesc,
        selectionMethod: s.selectionMethod,
        dateFrom: iso(s.dateFrom) as string,
        dateTo: iso(s.dateTo) as string,
        subjectType: s.subjectType,
        subjectIds: s.subjectIds,
        repeatWarning: repeatedSelections(
          s.subjectIds,
          recent.map((x) => x.subjectIds),
        ),
      })),
      responses: r.responses.map((x) => ({
        id: x.id,
        controlCode: x.controlCode,
        subjectId: x.subjectId,
        result: x.result,
        method: x.method,
        note: x.note,
        recordedBy: x.recordedBy,
        recordedByName: recorders.get(x.recordedBy) ?? null,
        recordedAt: x.recordedAt.toISOString(),
      })),
      findings: r.findings.map((f) => ({
        id: f.id,
        controlCode: f.controlCode,
        passCount: f.passCount,
        partialCount: f.partialCount,
        failCount: f.failCount,
        naCount: f.naCount,
        result: f.result,
        severity: f.severity,
        summary: f.summary,
      })),
      actions: await withActionNames(
        tx,
        actions.map((a) => toActionDto(a)),
      ),
    };
  }
}

function versionData(
  orgId: string,
  templateId: string,
  version: number,
  v: z.infer<typeof AuditVersionInput>,
  by: string,
) {
  return {
    organisationId: orgId,
    templateId,
    version,
    controls: v.controls as Prisma.InputJsonArray,
    sampleMethod: v.sampleMethod ?? null,
    sampleSize: v.sampleSize ?? null,
    methods: v.methods,
    createdBy: by,
  };
}

type TemplateRow = Prisma.AuditTemplateGetPayload<{ include: { versions: true } }>;
async function tplDtos(tx: TenantTx, rows: TemplateRow[]): Promise<AuditTemplateDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((t) => t.versions.flatMap((v) => [v.createdBy, v.approvedBy])),
  );
  return rows.map((t) => tplDto(t, names));
}

function tplDto(t: TemplateRow, names: Map<string, string>): AuditTemplateDto {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    domain: t.domain,
    sourceRef: t.sourceRef,
    active: t.active,
    versions: t.versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status as 'DRAFT' | 'PUBLISHED' | 'RETIRED',
      controls: (v.controls as Control[]).map((c) => ({ ...c, critical: !!c.critical })),
      sampleMethod: v.sampleMethod,
      sampleSize: v.sampleSize,
      methods: v.methods,
      createdBy: v.createdBy,
      createdByName: name(v.createdBy),
      approvedBy: v.approvedBy,
      approvedByName: name(v.approvedBy),
      approvedAt: v.approvedAt?.toISOString() ?? null,
      frequency: v.frequency,
      specialistName: v.specialistName,
      specialistRole: v.specialistRole,
    })),
    sectorPack: t.sectorPack,
    proposedCadence: t.proposedCadence,
    state: templateState({ active: t.active, retired: !!t.retiredAt, versions: t.versions }),
    validationNote:
      needsSpecialist(t.sectorPack) && !t.versions.some((v) => v.specialistName)
        ? SECTOR_TEMPLATE_NOTE
        : null,
    retiredAt: t.retiredAt?.toISOString() ?? null,
    retiredReason: t.retiredReason,
    clonedFrom: t.clonedFrom,
  };
}

type RunRow = Prisma.AuditRunGetPayload<object> & {
  templateVersion: { template: { code: string; domain: AuditRunDto['domain'] } };
};
async function runDtos(tx: TenantTx, rows: RunRow[]): Promise<AuditRunDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.auditorUserId, r.ownerUserId, r.reviewerUserId]),
  );
  const now = new Date();
  return rows.map((r) => runDto(r, names, now));
}

function runDto(r: RunRow, names: Map<string, string>, now: Date): AuditRunDto {
  const due = iso(r.dueDate) as string;
  return {
    id: r.id,
    code: r.code,
    templateVersionId: r.templateVersionId,
    templateCode: r.templateVersion.template.code,
    title: r.title,
    domain: r.templateVersion.template.domain,
    locationId: r.locationId,
    periodFrom: iso(r.periodFrom),
    periodTo: iso(r.periodTo),
    auditorUserId: r.auditorUserId,
    auditorName: names.get(r.auditorUserId) ?? null,
    ownerUserId: r.ownerUserId,
    ownerName: names.get(r.ownerUserId) ?? null,
    dueDate: due,
    overdue: (r.status === 'SCHEDULED' || r.status === 'IN_PROGRESS') && isOverdue(due, now),
    status: r.status,
    outcome: r.outcome,
    outcomeReason: r.outcomeReason,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    reauditOf: r.reauditOf,
    serviceId: r.serviceId,
    reviewerUserId: r.reviewerUserId,
    reviewerName: r.reviewerUserId ? (names.get(r.reviewerUserId) ?? null) : null,
    recurrenceMonths: r.recurrenceMonths,
    reviewState: r.reviewState as AuditRunDto['reviewState'],
    submissionNo: r.submissionNo,
    version: r.version,
  };
}
