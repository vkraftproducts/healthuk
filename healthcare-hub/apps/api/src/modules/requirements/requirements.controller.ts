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
import type { Db, TenantTx } from '@hub/db';
import { applyAutoRequirements, recomputeInstance, syncStaffRequirements } from '@hub/domain';
import { londonDate } from '@hub/rules';
import {
  AdoptTemplateInput,
  ApplicabilityInput,
  DueDateChangeInput,
  InstanceCreate,
  InstanceListQuery,
  InstancePatch,
  RetireTemplateInput,
  SPECIALIST_VALIDATED_PACKS,
  TemplateCreate,
  TemplateVersionInput,
  type InstanceDetailDto,
  type InstanceDto,
  type TemplateDto,
  type TemplateVersionDto,
} from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import {
  instanceInclude,
  toDate,
  toInstanceDto,
  toTemplateDto,
  toVersionDto,
} from './requirements.mapper.js';
import { evidenceForInstance } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });

function versionData(v: ReturnType<typeof TemplateVersionInput.parse>) {
  return {
    basisType: v.basisType,
    regulationRef: v.regulationRef ?? null,
    sourceUrl: v.sourceUrl ?? null,
    sourceVersionDate: v.sourceVersionDate ? toDate(v.sourceVersionDate) : null,
    subjectType: v.subjectType,
    applicabilityRule: v.applicabilityRule as object,
    evidenceType: v.evidenceType,
    recurrence: v.recurrence as object,
    warningDays: v.warningDays,
    dueSoonDays: v.dueSoonDays,
    blocking: v.blocking,
    deadlineKind: v.deadlineKind,
    approvalRole: v.approvalRole ?? null,
    frameworkMappings: v.frameworkMappings as object[],
  };
}

@Controller('requirements')
export class RequirementsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- templates -----------------------------------------------------------
  @RequirePermission('compliance.requirement.view')
  @Get('templates')
  async templates(@Hub() hub: HubRequestContext): Promise<{ data: TemplateDto[] }> {
    const [rows, retired] = await this.db.withTenant(tenantOf(hub), (tx) =>
      Promise.all([
        tx.requirementTemplate.findMany({
          include: { versions: true },
          orderBy: [{ pack: 'asc' }, { code: 'asc' }],
        }),
        tx.requirementTemplateRetirement.findMany(),
      ]),
    );
    const byTemplate = new Map(retired.map((r) => [r.templateId, r]));
    return {
      data: rows.map((t) => {
        const r = byTemplate.get(t.id);
        return {
          ...toTemplateDto(t),
          retired: r
            ? { reason: r.reason, retiredBy: r.retiredBy, retiredAt: r.retiredAt.toISOString() }
            : null,
        };
      }),
    };
  }

  /**
   * A5: retire an organisation requirement with a reason instead of deleting it. Nothing new is
   * created from it; requirements already on record stay in history.
   */
  @RequirePermission('admin.settings.manage')
  @Post('templates/:id/retire')
  async retire(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<TemplateDto> {
    const { reason } = body(RetireTemplateInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.requirementTemplate.findFirst({
        where: { id, organisationId: hub.orgId },
        include: { versions: true },
      });
      if (!t) throw notFound();
      if (await this.retirement(tx, id))
        throw new HubError('CONFLICT', 409, 'This requirement is already retired');
      const roles = await tx.roleRequirement.count({ where: { templateId: id } });
      if (roles > 0)
        throw new HubError(
          'CONFLICT',
          409,
          `Still required for ${roles} role${roles === 1 ? '' : 's'}. ` +
            'Remove it from those roles first.',
        );
      const r = await tx.requirementTemplateRetirement.create({
        data: {
          organisationId: hub.orgId as string,
          templateId: id,
          reason,
          retiredBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'requirements.template.retire',
        entity: 'requirement_template',
        entityId: id,
        summary: { reason },
      });
      return {
        ...toTemplateDto(t),
        retired: { reason, retiredBy: hub.user.id, retiredAt: r.retiredAt.toISOString() },
      };
    });
  }

  @RequirePermission('admin.settings.manage')
  @Post('templates')
  async createTemplate(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<TemplateDto> {
    const input = body(TemplateCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const exists = await tx.requirementTemplate.findFirst({
        where: { organisationId: hub.orgId, pack: 'CUSTOM', code: input.code },
      });
      if (exists) throw new HubError('CONFLICT', 409, 'A template with this code already exists');
      const t = await tx.requirementTemplate.create({
        data: {
          organisationId: hub.orgId,
          pack: 'CUSTOM',
          code: input.code,
          title: input.title,
          createdBy: hub.user.id,
          versions: {
            create: {
              organisationId: hub.orgId,
              version: 1,
              createdBy: hub.user.id,
              ...versionData(input.version),
            },
          },
        },
        include: { versions: true },
      });
      await audit(this.db, tx, hub, {
        action: 'requirements.template.create',
        entity: 'requirement_template',
        entityId: t.id,
      });
      return toTemplateDto(t);
    });
  }

  @RequirePermission('admin.settings.manage')
  @Post('templates/:id/adopt')
  async adopt(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw?: unknown,
  ): Promise<TemplateDto> {
    const input = body(AdoptTemplateInput, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const lib = await tx.requirementTemplate.findFirst({
        where: { id, organisationId: null },
        include: { versions: true },
      });
      if (!lib) throw notFound();
      const needsPack = SPECIALIST_VALIDATED_PACKS[lib.pack];
      if (needsPack) {
        const org = await tx.organisation.findUniqueOrThrow({ where: { id: hub.orgId as string } });
        if (!org.sectorPacks.includes(needsPack))
          throw new HubError(
            'CONFLICT',
            409,
            `The ${needsPack.replace('_', ' ')} pack is not enabled for this organisation`,
          );
        if (!input.specialistValidatedBy || !input.specialistOrganisation)
          throw new HubError(
            'VALIDATION_FAILED',
            422,
            'This is draft starting content. Name the specialist who validated it and their ' +
              'organisation before adopting.',
          );
      }
      if (await this.retirement(tx, id))
        throw new HubError('CONFLICT', 409, 'This library item has been retired');
      const src =
        [...lib.versions]
          .sort((a, b) => b.version - a.version)
          .find((v) => v.status === 'EFFECTIVE') ??
        [...lib.versions].sort((a, b) => b.version - a.version)[0];
      if (!src) throw notFound();
      const dup = await tx.requirementTemplate.findFirst({
        where: { organisationId: hub.orgId, pack: lib.pack, code: lib.code },
      });
      if (dup)
        throw new HubError('CONFLICT', 409, 'This library template has already been adopted');
      const t = await tx.requirementTemplate.create({
        data: {
          organisationId: hub.orgId,
          pack: lib.pack,
          code: lib.code,
          title: lib.title,
          createdBy: hub.user.id,
          versions: {
            create: {
              organisationId: hub.orgId,
              version: 1,
              createdBy: hub.user.id,
              basisType: src.basisType,
              regulationRef: src.regulationRef,
              sourceUrl: src.sourceUrl,
              sourceVersionDate: src.sourceVersionDate,
              subjectType: src.subjectType,
              applicabilityRule: src.applicabilityRule as object,
              evidenceType: src.evidenceType,
              recurrence: src.recurrence as object,
              warningDays: src.warningDays,
              dueSoonDays: src.dueSoonDays,
              blocking: src.blocking,
              deadlineKind: src.deadlineKind,
              approvalRole: src.approvalRole,
              frameworkMappings: src.frameworkMappings as object[],
            },
          },
        },
        include: { versions: true },
      });
      await audit(this.db, tx, hub, {
        action: 'requirements.template.adopt',
        entity: 'requirement_template',
        entityId: t.id,
        summary: {
          fromLibraryId: id,
          ...(input.specialistValidatedBy
            ? { specialistValidatedBy: input.specialistValidatedBy }
            : {}),
          ...(input.specialistOrganisation
            ? { specialistOrganisation: input.specialistOrganisation }
            : {}),
        },
      });
      return toTemplateDto(t);
    });
  }

  @RequirePermission('admin.settings.manage')
  @Post('templates/:id/versions')
  async newVersion(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<TemplateVersionDto> {
    const input = body(TemplateVersionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.requirementTemplate.findFirst({
        where: { id, organisationId: hub.orgId },
        include: { versions: { select: { version: true, status: true } } },
      });
      if (!t) throw notFound();
      if (await this.retirement(tx, id))
        throw new HubError('CONFLICT', 409, 'This requirement has been retired');
      if (t.versions.some((v) => v.status === 'DRAFT'))
        throw new HubError(
          'CONFLICT',
          409,
          'A draft version already exists; edit or publish it first',
        );
      const next = Math.max(0, ...t.versions.map((v) => v.version)) + 1;
      const v = await tx.requirementTemplateVersion.create({
        data: {
          organisationId: hub.orgId,
          templateId: id,
          version: next,
          createdBy: hub.user.id,
          ...versionData(input),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'requirements.version.create',
        entity: 'requirement_template_version',
        entityId: v.id,
        summary: { version: next },
      });
      return toVersionDto(v);
    });
  }

  @RequirePermission('admin.settings.manage')
  @Patch('templates/:id/versions/:versionId')
  async editVersion(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('versionId', idPipe) versionId: string,
    @Body() raw: unknown,
  ): Promise<TemplateVersionDto> {
    const patch = body(TemplateVersionInput.partial(), raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const cur = await tx.requirementTemplateVersion.findFirst({
        where: { id: versionId, templateId: id, organisationId: hub.orgId },
      });
      if (!cur) throw notFound();
      if (cur.status !== 'DRAFT')
        throw new HubError(
          'CONFLICT',
          409,
          'Published versions are immutable; create a new version',
        );
      const merged = TemplateVersionInput.parse({
        basisType: cur.basisType,
        regulationRef: cur.regulationRef ?? undefined,
        sourceUrl: cur.sourceUrl ?? undefined,
        sourceVersionDate: cur.sourceVersionDate?.toISOString().slice(0, 10),
        subjectType: cur.subjectType,
        applicabilityRule: cur.applicabilityRule,
        evidenceType: cur.evidenceType,
        recurrence: cur.recurrence,
        warningDays: cur.warningDays,
        dueSoonDays: cur.dueSoonDays,
        blocking: cur.blocking,
        deadlineKind: cur.deadlineKind,
        approvalRole: cur.approvalRole ?? undefined,
        frameworkMappings: cur.frameworkMappings,
        ...patch,
      });
      const v = await tx.requirementTemplateVersion.update({
        where: { id: versionId },
        data: versionData(merged),
      });
      await audit(this.db, tx, hub, {
        action: 'requirements.version.update',
        entity: 'requirement_template_version',
        entityId: versionId,
        summary: { fields: Object.keys(patch).join(',') },
      });
      return toVersionDto(v);
    });
  }

  @RequirePermission('admin.requirements.publish')
  @Post('templates/:id/versions/:versionId/publish')
  async publish(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('versionId', idPipe) versionId: string,
  ): Promise<TemplateVersionDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const cur = await tx.requirementTemplateVersion.findFirst({
        where: { id: versionId, templateId: id, organisationId: hub.orgId },
      });
      if (!cur) throw notFound();
      if (cur.status !== 'DRAFT')
        throw new HubError('CONFLICT', 409, 'Only a draft can be published');
      if (cur.createdBy === hub.user.id) {
        throw new HubError('FOUR_EYES_REQUIRED', 422, 'Another person must publish this');
      }
      if (await this.retirement(tx, id))
        throw new HubError('CONFLICT', 409, 'This requirement has been retired');
      const now = new Date();
      const today = toDate(londonDate(now));
      await tx.requirementTemplateVersion.updateMany({
        where: { templateId: id, status: 'EFFECTIVE' },
        data: { status: 'SUPERSEDED', effectiveTo: today },
      });
      const v = await tx.requirementTemplateVersion.update({
        where: { id: versionId },
        data: {
          status: 'EFFECTIVE',
          approvedBy: hub.user.id,
          approvedAt: now,
          effectiveFrom: today,
        },
      });
      // Existing instances move to the new rules and are re-evaluated straight away.
      const moved = await tx.requirementInstance.findMany({
        where: { templateId: id },
        select: { id: true },
      });
      await tx.requirementInstance.updateMany({
        where: { templateId: id },
        data: { templateVersionId: versionId },
      });
      for (const m of moved) await recomputeInstance(tx, m.id, now);
      // A5: publishing applies straight away to everyone and everything it covers.
      let created = 0;
      if (v.subjectType === 'STAFF') {
        const staff = await tx.staff.findMany({
          where: { lifecycleState: { not: 'LEAVER' } },
          select: { id: true },
        });
        for (const s of staff)
          created += (await syncStaffRequirements(tx, s.id, hub.user.id, now)).length;
      } else if (v.subjectType === 'VEHICLE') {
        for (const x of await tx.vehicle.findMany())
          created += await applyAutoRequirements(
            tx,
            {
              subjectType: 'VEHICLE',
              subjectId: x.id,
              kind: x.type,
              locationId: x.baseLocationId,
              organisationId: x.organisationId,
            },
            hub.user.id,
            now,
          );
      } else if (v.subjectType === 'EQUIPMENT') {
        for (const x of await tx.equipmentAsset.findMany())
          created += await applyAutoRequirements(
            tx,
            {
              subjectType: 'EQUIPMENT',
              subjectId: x.id,
              kind: x.category,
              locationId: x.locationId,
              organisationId: x.organisationId,
            },
            hub.user.id,
            now,
          );
      }
      await audit(this.db, tx, hub, {
        action: 'requirements.version.publish',
        entity: 'requirement_template_version',
        entityId: versionId,
        summary: { version: v.version, instances: moved.length, created },
      });
      return toVersionDto(v);
    });
  }

  // ---- instances -----------------------------------------------------------
  @RequirePermission('compliance.requirement.view')
  @Get('instances')
  async list(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: InstanceDto[]; nextCursor: string | null }> {
    const f = body(InstanceListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.requirementInstance.findMany({
        where: {
          ...(f.subjectType ? { subjectType: f.subjectType } : {}),
          ...(f.subjectId ? { subjectId: f.subjectId } : {}),
          ...(f.status ? { status: { in: f.status.split(',') as never[] } } : {}),
          ...(f.ownerId ? { ownerUserId: f.ownerId } : {}),
          ...(f.locationId ? { locationId: f.locationId } : {}),
          // Location-scoped users see their locations plus organisation-level items.
          ...(hub.locationIds
            ? { OR: [{ locationId: null }, { locationId: { in: [...hub.locationIds] } }] }
            : {}),
          ...(f.cursor ? { id: { gt: f.cursor } } : {}),
        },
        include: instanceInclude,
        orderBy: { id: 'asc' },
        take: f.limit + 1,
      }),
    );
    const more = rows.length > f.limit;
    const data = rows.slice(0, f.limit);
    return {
      data: data.map(toInstanceDto),
      nextCursor: more ? (data[data.length - 1]?.id ?? null) : null,
    };
  }

  @RequirePermission('compliance.requirement.manage')
  @Post('instances')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<InstanceDto> {
    const input = body(InstanceCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.requirementTemplate.findFirst({
        where: { id: input.templateId, organisationId: hub.orgId },
        include: { versions: { where: { status: 'EFFECTIVE' } } },
      });
      if (!t) throw notFound();
      if (await this.retirement(tx, t.id))
        throw new HubError('CONFLICT', 409, 'This requirement has been retired');
      const ev = t.versions[0];
      if (!ev)
        throw new HubError(
          'TEMPLATE_NOT_PUBLISHED',
          422,
          'Publish the template before creating requirements from it',
        );
      if (ev.subjectType !== input.subjectType)
        throw new HubError('VALIDATION_FAILED', 400, 'Subject type does not match the template');
      await this.assertSubject(tx, hub, input.subjectType, input.subjectId);
      await this.assertMembers(tx, hub, [input.ownerUserId, input.deputyUserId]);
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      if (hub.locationIds && input.locationId && !hub.locationIds.includes(input.locationId))
        throw notFound();
      const dup = await tx.requirementInstance.findFirst({
        where: { templateId: t.id, subjectType: input.subjectType, subjectId: input.subjectId },
      });
      if (dup)
        throw new HubError('CONFLICT', 409, 'This requirement already exists for the subject');
      const i = await tx.requirementInstance.create({
        data: {
          organisationId: hub.orgId as string,
          templateId: t.id,
          templateVersionId: ev.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          locationId: input.locationId,
          ownerUserId: input.ownerUserId,
          deputyUserId: input.deputyUserId,
          anchorDate: input.anchorDate
            ? toDate(input.anchorDate)
            : input.dueDate && (ev.recurrence as { type?: string }).type === 'FIXED_CALENDAR'
              ? toDate(input.dueDate)
              : null,
          dueDate: input.dueDate ? toDate(input.dueDate) : null,
          expiryDate: input.expiryDate ? toDate(input.expiryDate) : null,
          reviewDate: input.reviewDate ? toDate(input.reviewDate) : null,
          createdBy: hub.user.id,
        },
      });
      await recomputeInstance(tx, i.id, new Date());
      await audit(this.db, tx, hub, {
        action: 'requirements.instance.create',
        entity: 'requirement_instance',
        entityId: i.id,
        summary: { templateId: t.id, subjectType: input.subjectType },
      });
      return toInstanceDto(
        await tx.requirementInstance.findUniqueOrThrow({
          where: { id: i.id },
          include: instanceInclude,
        }),
      );
    });
  }

  @RequirePermission('compliance.requirement.view')
  @Get('instances/:id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<InstanceDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const i = await this.load(tx, hub, id);
      const [decisions, changes] = await Promise.all([
        tx.applicabilityDecision.findMany({
          where: { instanceId: id },
          orderBy: { createdAt: 'desc' },
        }),
        tx.dueDateChange.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'desc' } }),
      ]);
      return {
        ...toInstanceDto(i),
        decisions: decisions.map((x) => ({
          id: x.id,
          decision: x.decision,
          reason: x.reason,
          reviewerId: x.reviewerId,
          reviewDate: x.reviewDate.toISOString().slice(0, 10),
          createdAt: x.createdAt.toISOString(),
        })),
        dueDateChanges: changes.map((c) => ({
          id: c.id,
          field: c.field as 'DUE' | 'EXPIRY' | 'REVIEW',
          oldDate: c.oldDate?.toISOString().slice(0, 10) ?? null,
          newDate: c.newDate.toISOString().slice(0, 10),
          reason: c.reason,
          approverId: c.approverId,
          createdAt: c.createdAt.toISOString(),
        })),
      };
    });
  }

  @RequirePermission('compliance.requirement.manage')
  @Patch('instances/:id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<InstanceDto> {
    const patch = body(InstancePatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.load(tx, hub, id);
      await this.assertMembers(tx, hub, [patch.ownerUserId ?? null, patch.deputyUserId ?? null]);
      const r = await tx.requirementInstance.updateMany({
        where: { id, version },
        data: { ...patch, updatedBy: hub.user.id },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      await recomputeInstance(tx, id, new Date()); // keeps the alert owner in step
      await audit(this.db, tx, hub, {
        action: 'requirements.instance.update',
        entity: 'requirement_instance',
        entityId: id,
        summary: { fields: Object.keys(patch).join(',') },
      });
      return toInstanceDto(
        await tx.requirementInstance.findUniqueOrThrow({ where: { id }, include: instanceInclude }),
      );
    });
  }

  @RequirePermission('compliance.applicability.decide')
  @Post('instances/:id/applicability')
  async applicability(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<InstanceDto> {
    const input = body(ApplicabilityInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const i = await this.load(tx, hub, id);
      const now = new Date();
      await tx.applicabilityDecision.create({
        data: {
          organisationId: i.organisationId,
          instanceId: id,
          decision: input.decision,
          reason: input.reason,
          reviewerId: hub.user.id,
          reviewDate: toDate(londonDate(now)),
        },
      });
      await tx.requirementInstance.update({
        where: { id },
        data: { applicability: input.decision, updatedBy: hub.user.id },
      });
      await recomputeInstance(tx, id, now);
      await audit(this.db, tx, hub, {
        action: 'requirements.instance.applicability',
        entity: 'requirement_instance',
        entityId: id,
        summary: { decision: input.decision },
      });
      return toInstanceDto(
        await tx.requirementInstance.findUniqueOrThrow({ where: { id }, include: instanceInclude }),
      );
    });
  }

  @RequirePermission('compliance.due_date.change')
  @Post('instances/:id/due-date-change')
  async dueDateChange(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<InstanceDto> {
    const input = body(DueDateChangeInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const i = await this.load(tx, hub, id);
      const kind = i.templateVersion.deadlineKind;
      if (input.field !== kind)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          `This requirement is governed by its ${kind.toLowerCase()} date`,
        );
      // An expiry comes from verified evidence. Moving it by hand would let an expired clearance pass.
      if (kind === 'EXPIRY')
        throw new HubError(
          'OVERRIDE_NOT_PERMITTED',
          422,
          'Expiry dates come from verified evidence and cannot be edited',
        );
      // B8: statutory dates (licence, MOT, insurance and the like) never move; only local policy.
      if (i.templateVersion.basisType === 'STATUTORY' || i.templateVersion.blocking === 'STATUTORY')
        throw new HubError(
          'OVERRIDE_NOT_PERMITTED',
          422,
          'This is a statutory date and cannot be moved. Only local-policy due dates can change.',
        );
      if (input.approverId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Another person must approve the change');
      await this.assertApprover(tx, hub, input.approverId);
      const old = kind === 'DUE' ? i.dueDate : i.reviewDate;
      await tx.dueDateChange.create({
        data: {
          organisationId: i.organisationId,
          instanceId: id,
          field: kind,
          oldDate: old,
          newDate: toDate(input.newDate),
          reason: input.reason,
          approverId: input.approverId,
          createdBy: hub.user.id,
        },
      });
      await tx.requirementInstance.update({
        where: { id },
        data: {
          [kind === 'DUE' ? 'dueDate' : 'reviewDate']: toDate(input.newDate),
          updatedBy: hub.user.id,
        },
      });
      await recomputeInstance(tx, id, new Date());
      await audit(this.db, tx, hub, {
        action: 'requirements.instance.due_date_change',
        entity: 'requirement_instance',
        entityId: id,
        summary: {
          field: kind,
          approverId: input.approverId,
          oldDate: old ? old.toISOString().slice(0, 10) : null,
          newDate: input.newDate,
          reason: input.reason,
        },
      });
      return toInstanceDto(
        await tx.requirementInstance.findUniqueOrThrow({ where: { id }, include: instanceInclude }),
      );
    });
  }

  @RequirePermission('compliance.requirement.view')
  @Get('instances/:id/evidence')
  async evidence(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.load(tx, hub, id);
      return { data: await evidenceForInstance(tx, id, hub) };
    });
  }

  // ---- helpers -------------------------------------------------------------
  private retirement(tx: TenantTx, templateId: string) {
    return tx.requirementTemplateRetirement.findUnique({ where: { templateId } });
  }

  /** Loads an instance visible to the caller (organisation via RLS, location scope here). */
  private async load(tx: TenantTx, hub: HubRequestContext, id: string) {
    const i = await tx.requirementInstance.findUnique({ where: { id }, include: instanceInclude });
    if (!i) throw notFound();
    if (hub.locationIds && i.locationId && !hub.locationIds.includes(i.locationId))
      throw notFound();
    return i;
  }

  private async assertSubject(
    tx: TenantTx,
    hub: HubRequestContext,
    type: string,
    subjectId: string,
  ): Promise<void> {
    if (type === 'ORGANISATION' && subjectId !== hub.orgId) throw notFound();
    if (type === 'PREMISES' && !(await tx.location.findUnique({ where: { id: subjectId } })))
      throw notFound();
    if (type === 'SERVICE' && !(await tx.serviceType.findUnique({ where: { id: subjectId } })))
      throw notFound();
    if (type === 'STAFF' && !(await tx.staff.findUnique({ where: { id: subjectId } })))
      throw notFound();
    if (type === 'VEHICLE' && !(await tx.vehicle.findUnique({ where: { id: subjectId } })))
      throw notFound();
    if (type === 'EQUIPMENT' && !(await tx.equipmentAsset.findUnique({ where: { id: subjectId } })))
      throw notFound();
  }

  private async assertMembers(
    tx: TenantTx,
    hub: HubRequestContext,
    ids: (string | null)[],
  ): Promise<void> {
    for (const id of ids) {
      if (!id) continue;
      const n = await tx.membership.count({
        where: { userId: id, validTo: null, user: { status: 'ACTIVE' } },
      });
      if (n === 0)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Owner must be an active member of this organisation',
        );
    }
  }

  private async assertApprover(
    tx: TenantTx,
    _hub: HubRequestContext,
    approverId: string,
  ): Promise<void> {
    const n = await tx.membership.count({
      where: {
        userId: approverId,
        validTo: null,
        user: { status: 'ACTIVE' },
        role: { rolePermissions: { some: { permissionKey: 'compliance.due_date.change' } } },
      },
    });
    if (n === 0)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'The approver must be an active member who may change due dates',
      );
  }
}
