import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Db, Prisma, TenantTx } from '@hub/db';
import {
  affectedAllocations,
  raiseDefectAlert,
  recordOdometer,
  refreshVehicleStatus,
} from '@hub/domain';
import { londonDate } from '@hub/rules';
import type { CleaningDto } from '@hub/contracts';
import {
  CleaningInput,
  VdiAmendInput,
  VdiSubmit,
  VdiTemplateInput,
  VdiTemplateQuery,
  type VdiDto,
} from '@hub/contracts';
import { userNames } from '../evidence/evidence.mapper.js';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { assertNotFuture, audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { toVdiDto } from './fleet.mapper.js';

type CleaningDtoT = z.infer<typeof CleaningDto>;
const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MAX_OFFLINE_MS = 7 * 86_400_000;
const vdiInclude = {
  items: true,
  amendments: { orderBy: { at: 'asc' } },
  defects: { select: { id: true } },
} as const;
type TemplateItem = { code: string; label: string; critical: boolean };
const ListQuery = z.object({ vehicleId: z.string().uuid().optional() });

/**
 * Vehicle daily inspections and cleaning (FLT-04/05). Submissions are idempotent on the client's
 * submission id (UAT-06), immutable, and corrected only by amendments.
 */
@Controller()
export class InspectionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- templates --------------------------------------------------------------
  /** Crews get published checklists only; vehicle managers can ask for every version. */
  @OrgMember()
  @Get('vdi-templates')
  async templates(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, 'fleet.vdi.submit', 'fleet.vdi.view', 'fleet.vehicle.manage');
    const { all } = body(VdiTemplateQuery, q);
    const everything = all && hub.permissions.has('fleet.vehicle.manage');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.vdiTemplate.findMany({
        where: everything ? {} : { active: true, status: 'PUBLISHED' },
        orderBy: [{ name: 'asc' }, { version: 'desc' }],
      });
      const names = await userNames(tx, [
        ...rows.map((r) => r.createdBy),
        ...rows.map((r) => r.publishedBy),
      ]);
      return { data: rows.map((r) => tplDto(r, names)) };
    });
  }

  /** D6: the Fleet lead drafts a version; it is not used until someone else publishes it. */
  @RequirePermission('fleet.vehicle.manage')
  @Post('vdi-templates')
  async createTemplate(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(VdiTemplateInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const last = await tx.vdiTemplate.findFirst({
        where: { name: input.name },
        orderBy: { version: 'desc' },
      });
      const t = await tx.vdiTemplate.create({
        data: {
          organisationId: hub.orgId as string,
          name: input.name,
          version: (last?.version ?? 0) + 1,
          vehicleType: input.vehicleType ?? null,
          items: input.items as Prisma.InputJsonArray,
          active: false,
          status: 'DRAFT',
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.vdi_template.draft',
        entity: 'vdi_template',
        entityId: t.id,
        summary: { version: t.version },
      });
      return tplDto(t, await userNames(tx, [t.createdBy]));
    });
  }

  /**
   * D6: a second person publishes the draft. Publishing retires the previous version of the same
   * checklist and any other published checklist for the same vehicle type (one per type).
   */
  @RequirePermission('fleet.vehicle.manage')
  @Post('vdi-templates/:id/publish')
  async publishTemplate(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.vdiTemplate.findUnique({ where: { id } });
      if (!t) throw notFound();
      if (t.status !== 'DRAFT')
        throw new HubError('CONFLICT', 409, 'Only a draft checklist can be published');
      if (t.createdBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          403,
          'Someone other than the person who drafted this checklist must publish it',
        );
      const now = new Date();
      const older = await tx.vdiTemplate.findMany({
        where: {
          status: 'PUBLISHED',
          id: { not: id },
          OR: [{ name: t.name }, ...(t.vehicleType ? [{ vehicleType: t.vehicleType }] : [])],
        },
        select: { id: true },
      });
      if (older.length)
        await tx.vdiTemplate.updateMany({
          where: { id: { in: older.map((o) => o.id) } },
          data: { active: false, status: 'RETIRED' },
        });
      const u = await tx.vdiTemplate.update({
        where: { id },
        data: { active: true, status: 'PUBLISHED', publishedBy: hub.user.id, publishedAt: now },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.vdi_template.publish',
        entity: 'vdi_template',
        entityId: id,
        summary: { version: u.version, retired: older.length },
      });
      return tplDto(u, await userNames(tx, [u.createdBy, u.publishedBy]));
    });
  }

  @RequirePermission('fleet.vehicle.manage')
  @Post('vdi-templates/:id/retire')
  async retire(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.vdiTemplate.findUnique({ where: { id } });
      if (!t) throw notFound();
      if (t.status === 'RETIRED')
        throw new HubError('CONFLICT', 409, 'This checklist is already retired');
      const u = await tx.vdiTemplate.update({
        where: { id },
        data: { active: false, status: 'RETIRED' },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.vdi_template.retire',
        entity: 'vdi_template',
        entityId: id,
      });
      return tplDto(u, await userNames(tx, [u.createdBy, u.publishedBy]));
    });
  }

  // ---- VDI ------------------------------------------------------------------------
  @RequirePermission('fleet.vdi.submit')
  @Post('vdis')
  async submit(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<VdiDto> {
    const input = body(VdiSubmit, raw);
    const now = new Date();
    const captured = new Date(input.capturedAt);
    assertNotFuture(captured, now);
    if (now.getTime() - captured.getTime() > MAX_OFFLINE_MS)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Inspections older than 7 days cannot be submitted',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const dup = await tx.vdi.findFirst({
        where: { clientSubmissionId: input.clientSubmissionId },
        include: vdiInclude,
      });
      if (dup) {
        // Same submission retried (offline outbox): return the original, never a second record.
        if (dup.checkerUserId !== hub.user.id || dup.vehicleId !== input.vehicleId)
          throw new HubError(
            'CONFLICT',
            409,
            'That submission id was used for a different inspection',
          );
        return toVdiDto(dup, { duplicate: true, odometerFlags: [] });
      }
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
      if (!v) throw notFound();
      const t = await tx.vdiTemplate.findUnique({ where: { id: input.templateId } });
      if (!t) throw notFound();
      if (!t.active)
        throw new HubError(
          'CONFLICT',
          409,
          'That checklist version has been retired; reload the checklist',
        );
      const items = t.items as TemplateItem[];
      const byCode = new Map(input.results.map((r) => [r.code, r]));
      if (byCode.size !== input.results.length)
        throw new HubError('VALIDATION_FAILED', 400, 'Each item may be answered once');
      const missing = items.filter((i) => !byCode.has(i.code));
      const unknown = input.results.filter((r) => !items.some((i) => i.code === r.code));
      if (missing.length || unknown.length)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Answer every checklist item (and only those)',
        );
      if (input.results.some((r) => r.result !== 'PASS' && !r.reason))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'A failed or not-applicable item needs a reason',
        );
      for (const r of input.results)
        if (
          r.photoEvidenceItemId &&
          !(await tx.evidenceItem.count({ where: { id: r.photoEvidenceItemId } }))
        )
          throw notFound();
      const outcome = input.results.some((r) => r.result === 'FAIL') ? 'FAIL' : 'PASS';
      const vdi = await tx.vdi.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: v.id,
          templateId: t.id,
          shiftId: input.shiftId ?? null,
          checkerUserId: hub.user.id,
          odometer: input.odometer,
          outcome,
          clientSubmissionId: input.clientSubmissionId,
          capturedAt: captured,
          notes: input.notes ?? null,
        },
      });
      await tx.vdiItemResult.createMany({
        data: items.map((i) => {
          const r = byCode.get(i.code)!;
          return {
            organisationId: v.organisationId,
            vdiId: vdi.id,
            itemCode: i.code,
            critical: i.critical,
            result: r.result,
            reason: r.reason ?? null,
            photoEvidenceItemId: r.photoEvidenceItemId ?? null,
          };
        }),
      });
      const odo = await recordOdometer(tx, {
        vehicleId: v.id,
        organisationId: v.organisationId,
        reading: input.odometer,
        readOn: londonDate(captured),
        source: 'VDI',
        by: hub.user.id,
      });
      for (const i of items) {
        const r = byCode.get(i.code)!;
        if (r.result === 'FAIL')
          await this.defectFromFailure(tx, hub, v, vdi.id, i, r.reason ?? '', captured);
      }
      await refreshVehicleStatus(tx, v.id);
      await audit(this.db, tx, hub, {
        action: 'fleet.vdi.submit',
        entity: 'vdi',
        entityId: vdi.id,
        summary: { vehicleId: v.id, outcome },
      });
      const full = await tx.vdi.findUniqueOrThrow({ where: { id: vdi.id }, include: vdiInclude });
      return toVdiDto(full, { duplicate: false, odometerFlags: odo.flags });
    });
  }

  /** A failed critical item is a CRITICAL stop-use defect at once (UAT-03); others need classifying. */
  private async defectFromFailure(
    tx: TenantTx,
    hub: HubRequestContext,
    v: { id: string; organisationId: string; callsign: string },
    vdiId: string,
    item: TemplateItem,
    reason: string,
    at: Date,
  ): Promise<void> {
    const d = await tx.defect.create({
      data: {
        organisationId: v.organisationId,
        vehicleId: v.id,
        severity: item.critical ? 'CRITICAL' : 'MINOR',
        stopUse: item.critical,
        description: `VDI: ${item.label} failed – ${reason}`.slice(0, 1000),
        reportedBy: hub.user.id,
        discoveredAt: at,
        sourceVdiId: vdiId,
      },
    });
    if (item.critical) {
      await raiseDefectAlert(tx, d, v.callsign);
      await affectedAllocations(tx, v.id, at);
    }
  }

  @RequirePermission('fleet.vdi.view')
  @Get('vdis')
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: VdiDto[] }> {
    const f = body(ListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.vdi.findMany({
        where: f.vehicleId ? { vehicleId: f.vehicleId } : {},
        include: vdiInclude,
        orderBy: { capturedAt: 'desc' },
        take: 100,
      }),
    );
    return { data: rows.map((r) => toVdiDto(r, { duplicate: false, odometerFlags: [] })) };
  }

  @OrgMember()
  @Get('vdis/:id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<VdiDto> {
    requireAny(hub, 'fleet.vdi.view', 'fleet.vdi.submit');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vdi.findUnique({ where: { id }, include: vdiInclude });
      // Crew may read back only their own submissions.
      if (!v || (!hub.permissions.has('fleet.vdi.view') && v.checkerUserId !== hub.user.id))
        throw notFound();
      return toVdiDto(v, { duplicate: false, odometerFlags: [] });
    });
  }

  @OrgMember()
  @Post('vdis/:id/amendments')
  async amend(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<VdiDto> {
    requireAny(hub, 'fleet.vehicle.manage', 'fleet.vdi.submit');
    const input = body(VdiAmendInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vdi.findUnique({
        where: { id },
        include: { ...vdiInclude, vehicle: true, template: true },
      });
      if (!v || (!hub.permissions.has('fleet.vehicle.manage') && v.checkerUserId !== hub.user.id))
        throw notFound();
      const item = v.items.find((i) => i.itemCode === input.code);
      if (!item) throw new HubError('VALIDATION_FAILED', 400, 'Unknown checklist item');
      await tx.vdiAmendment.create({
        data: {
          organisationId: v.organisationId,
          vdiId: id,
          itemCode: input.code,
          newResult: input.newResult,
          reason: input.reason,
          amendedBy: hub.user.id,
        },
      });
      // Amending a failure to PASS never releases a defect: return to service is separate (FLT-06).
      if (input.newResult === 'FAIL') {
        const label = (v.template.items as TemplateItem[]).find((i) => i.code === input.code) ?? {
          code: input.code,
          label: input.code,
          critical: item.critical,
        };
        await this.defectFromFailure(tx, hub, v.vehicle, id, label, input.reason, new Date());
        await refreshVehicleStatus(tx, v.vehicleId);
      }
      await audit(this.db, tx, hub, {
        action: 'fleet.vdi.amend',
        entity: 'vdi',
        entityId: id,
        summary: { code: input.code, newResult: input.newResult },
      });
      const full = await tx.vdi.findUniqueOrThrow({ where: { id }, include: vdiInclude });
      return toVdiDto(full, { duplicate: false, odometerFlags: [] });
    });
  }

  // ---- cleaning -----------------------------------------------------------------------
  @RequirePermission('fleet.vdi.submit')
  @Post('cleaning-records')
  async clean(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(CleaningInput, raw);
    const now = new Date();
    const captured = new Date(input.capturedAt);
    assertNotFuture(captured, now);
    if (now.getTime() - captured.getTime() > MAX_OFFLINE_MS)
      throw new HubError('VALIDATION_FAILED', 400, 'Records older than 7 days cannot be submitted');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const dup = await tx.cleaningRecord.findFirst({
        where: { clientSubmissionId: input.clientSubmissionId },
      });
      if (dup) {
        if (dup.cleanedBy !== hub.user.id || dup.vehicleId !== input.vehicleId)
          throw new HubError('CONFLICT', 409, 'That submission id was used for a different record');
        return cleanDto(dup, true);
      }
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
      if (!v) throw notFound();
      const c = await tx.cleaningRecord.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: v.id,
          shiftId: input.shiftId ?? null,
          type: input.type,
          cleanedBy: hub.user.id,
          clientSubmissionId: input.clientSubmissionId,
          capturedAt: captured,
          notes: input.notes ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.cleaning.record',
        entity: 'cleaning_record',
        entityId: c.id,
        summary: { vehicleId: v.id, type: input.type },
      });
      return cleanDto(c, false);
    });
  }

  @RequirePermission('fleet.vdi.view')
  @Get('cleaning-records')
  async cleaning(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(ListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.cleaningRecord.findMany({
        where: f.vehicleId ? { vehicleId: f.vehicleId } : {},
        orderBy: { capturedAt: 'desc' },
        take: 100,
      }),
    );
    return { data: rows.map((r) => cleanDto(r, false)) };
  }
}

function tplDto(t: Prisma.VdiTemplateGetPayload<object>, names: Map<string, string>) {
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  return {
    id: t.id,
    name: t.name,
    version: t.version,
    vehicleType: t.vehicleType as never,
    items: (t.items as TemplateItem[]).map((i) => ({
      code: i.code,
      label: i.label,
      critical: !!i.critical,
    })),
    active: t.active,
    status: t.status as 'DRAFT' | 'PUBLISHED' | 'RETIRED',
    createdBy: t.createdBy,
    createdByName: name(t.createdBy),
    publishedBy: t.publishedBy,
    publishedByName: name(t.publishedBy),
    publishedAt: t.publishedAt ? t.publishedAt.toISOString() : null,
  };
}

function cleanDto(c: Prisma.CleaningRecordGetPayload<object>, duplicate: boolean): CleaningDtoT {
  return {
    id: c.id,
    vehicleId: c.vehicleId,
    type: c.type,
    cleanedBy: c.cleanedBy,
    capturedAt: c.capturedAt.toISOString(),
    receivedAt: c.receivedAt.toISOString(),
    duplicate,
  };
}
