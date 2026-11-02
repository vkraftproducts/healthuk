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
import { z } from 'zod';
import type { Db, TenantTx } from '@hub/db';
import {
  applyAutoRequirements,
  equipmentReadinessFor,
  recordOdometer,
  refreshVehicleStatus,
  recomputeInstance,
  vehicleCapability,
  vehicleReadinessFor,
} from '@hub/domain';
import { londonDate } from '@hub/rules';
import {
  EquipmentCreate,
  EquipmentPatch,
  FlagInput,
  MaintenanceDoneInput,
  MaintenancePlanInput,
  MoveInput,
  NeedsQuery,
  OdometerInput,
  RegimeInput,
  VehicleCreate,
  VehiclePatch,
  type EquipmentDto,
  type VehicleDetailDto,
  type VehicleDto,
} from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { day, toEquipmentDto, toPlanDto, toVehicleDto } from './fleet.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const VIEW = 'fleet.vehicle.view';
const MANAGE = 'fleet.vehicle.manage';
const ListQuery = z.object({
  status: z.enum(['AVAILABLE', 'BLOCKED', 'QUARANTINED', 'OFF_ROAD']).optional(),
  locationId: z.string().uuid().optional(),
  q: z.string().trim().max(30).optional(),
});

/** Vehicle register, odometer, maintenance and capability (FLT-01..03, FLT-08). */
@Controller('vehicles')
export class VehiclesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(ListQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.vehicle.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.locationId ? { baseLocationId: f.locationId } : {}),
          ...(f.q
            ? {
                OR: [
                  { callsign: { contains: f.q.toUpperCase() } },
                  { registration: { contains: f.q.replace(/\s/g, '').toUpperCase() } },
                ],
              }
            : {}),
        },
        orderBy: { callsign: 'asc' },
        take: 500,
      });
      const counts = await openDefectCounts(
        tx,
        rows.map((r) => r.id),
      );
      return { data: rows.map((v) => toVehicleDto(v, counts.get(v.id) ?? 0)), nextCursor: null };
    });
  }

  @RequirePermission(MANAGE)
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<VehicleDto> {
    const input = body(VehicleCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertLocation(tx, hub, input.baseLocationId);
      const clash = await tx.vehicle.findFirst({
        where: { OR: [{ registration: input.registration }, { callsign: input.callsign }] },
        select: { id: true },
      });
      if (clash)
        throw new HubError('CONFLICT', 409, 'That registration or callsign is already in use');
      const v = await tx.vehicle.create({
        data: {
          ...input,
          organisationId: hub.orgId as string,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await tx.vehicleLocationHistory.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: v.id,
          locationId: v.baseLocationId,
          reason: 'Vehicle added',
          movedBy: hub.user.id,
        },
      });
      const auto = await applyAutoRequirements(
        tx,
        {
          subjectType: 'VEHICLE',
          subjectId: v.id,
          kind: v.type,
          locationId: v.baseLocationId,
          organisationId: v.organisationId,
        },
        hub.user.id,
        new Date(),
      );
      await audit(this.db, tx, hub, {
        action: 'fleet.vehicle.create',
        entity: 'vehicle',
        entityId: v.id,
        summary: { callsign: v.callsign, requirementsApplied: auto },
      });
      return toVehicleDto(v, 0);
    });
  }

  @RequirePermission(VIEW)
  @Get(':id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<VehicleDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({
        where: { id },
        include: {
          plans: { where: { active: true }, orderBy: { createdAt: 'asc' } },
          readings: { orderBy: [{ readOn: 'desc' }, { createdAt: 'desc' }], take: 20 },
          locations: { orderBy: { at: 'desc' }, take: 20 },
        },
      });
      if (!v) throw notFound();
      const now = new Date();
      const counts = await openDefectCounts(tx, [id]);
      return {
        ...toVehicleDto(v, counts.get(id) ?? 0),
        maintenance: v.plans.map((p) => toPlanDto(p, v.currentOdometer, now)),
        readings: v.readings.map((r) => ({
          id: r.id,
          reading: r.reading,
          readOn: r.readOn.toISOString().slice(0, 10),
          source: r.source,
          flags: r.flags,
        })),
        locations: v.locations.map((l) => ({
          locationId: l.locationId,
          reason: l.reason,
          at: l.at.toISOString(),
        })),
        capability: await vehicleCapability(tx, id),
      };
    });
  }

  @RequirePermission(MANAGE)
  @Patch(':id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<VehicleDto> {
    const expected = ifMatchVersion(req);
    const input = body(VehiclePatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.vehicle.updateMany({
        where: { id, version: expected },
        data: { ...input, updatedBy: hub.user.id },
      });
      if (r.count === 0) throw staleOrNotFound((await tx.vehicle.count({ where: { id } })) > 0);
      await audit(this.db, tx, hub, {
        action: 'fleet.vehicle.update',
        entity: 'vehicle',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(VIEW)
  @Get(':id/readiness')
  async readiness(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Query() q: unknown,
  ) {
    const f = body(NeedsQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.vehicle.count({ where: { id } }))) throw notFound();
      const r = await vehicleReadinessFor(tx, {
        vehicleId: id,
        window: { start: new Date(f.from), end: new Date(f.to) },
        needs: { stretcher: f.stretcher, wheelchairs: f.wheelchairs, seats: f.seats },
        now: new Date(),
      });
      return { vehicleId: id, state: r.state, checks: r.checks, capability: r.capability };
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/odometer')
  async odometer(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(OdometerInput, raw);
    if (input.readOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The reading date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound();
      const r = await recordOdometer(tx, {
        vehicleId: id,
        organisationId: v.organisationId,
        reading: input.reading,
        readOn: input.readOn,
        source: 'MANUAL',
        by: hub.user.id,
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.odometer.record',
        entity: 'vehicle',
        entityId: id,
        summary: { reading: input.reading, flags: r.flags.join(',') },
      });
      return { id: r.id, reading: r.reading, readOn: input.readOn, flags: r.flags };
    });
  }

  @RequirePermission(VIEW)
  @Get(':id/maintenance')
  async maintenance(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({
        where: { id },
        include: { plans: { where: { active: true } } },
      });
      if (!v) throw notFound();
      const now = new Date();
      return { data: v.plans.map((p) => toPlanDto(p, v.currentOdometer, now)) };
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/maintenance')
  async addPlan(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(MaintenancePlanInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound();
      if (input.intervalMiles && input.lastDoneOdometer === undefined && v.currentOdometer === null)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Give the odometer at the last service so mileage can be tracked',
        );
      const p = await tx.maintenancePlan.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: id,
          title: input.title,
          intervalDays: input.intervalDays ?? null,
          intervalMiles: input.intervalMiles ?? null,
          lastDoneOn: input.lastDoneOn ? day(input.lastDoneOn) : null,
          lastDoneOdometer:
            input.lastDoneOdometer ?? (input.intervalMiles ? v.currentOdometer : null),
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.maintenance.plan',
        entity: 'maintenance_plan',
        entityId: p.id,
        summary: { vehicleId: id },
      });
      return toPlanDto(p, v.currentOdometer, new Date());
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/maintenance/:planId/done')
  async done(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('planId', idPipe) planId: string,
    @Body() raw: unknown,
  ) {
    const input = body(MaintenanceDoneInput, raw);
    if (input.doneOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.maintenancePlan.findFirst({
        where: { id: planId, vehicleId: id },
        include: { vehicle: true },
      });
      if (!p) throw notFound();
      await tx.maintenanceEvent.create({
        data: {
          organisationId: p.organisationId,
          planId,
          doneOn: day(input.doneOn),
          odometer: input.odometer ?? null,
          notes: input.notes ?? null,
          recordedBy: hub.user.id,
        },
      });
      if (input.odometer !== undefined)
        await recordOdometer(tx, {
          vehicleId: id,
          organisationId: p.organisationId,
          reading: input.odometer,
          readOn: input.doneOn,
          source: 'SERVICE',
          by: hub.user.id,
        });
      const u = await tx.maintenancePlan.update({
        where: { id: planId },
        data: {
          lastDoneOn: day(input.doneOn),
          lastDoneOdometer: input.odometer ?? p.lastDoneOdometer,
          updatedBy: hub.user.id,
        },
      });
      const v = await tx.vehicle.findUniqueOrThrow({ where: { id } });
      await audit(this.db, tx, hub, {
        action: 'fleet.maintenance.done',
        entity: 'maintenance_plan',
        entityId: planId,
        summary: { vehicleId: id },
      });
      return toPlanDto(u, v.currentOdometer, new Date());
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/move')
  async move(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<VehicleDto> {
    const input = body(MoveInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound();
      await assertLocation(tx, hub, input.locationId);
      if (v.baseLocationId === input.locationId)
        throw new HubError('CONFLICT', 409, 'Already based there');
      await tx.vehicleLocationHistory.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: id,
          locationId: input.locationId,
          reason: input.reason,
          movedBy: hub.user.id,
        },
      });
      await tx.vehicle.update({
        where: { id },
        data: { baseLocationId: input.locationId, updatedBy: hub.user.id },
      });
      await tx.requirementInstance.updateMany({
        where: { subjectType: 'VEHICLE', subjectId: id },
        data: { locationId: input.locationId },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.vehicle.move',
        entity: 'vehicle',
        entityId: id,
        summary: { locationId: input.locationId },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/quarantine')
  quarantine(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string, @Body() raw: unknown) {
    return this.flag(hub, id, raw, 'quarantined');
  }

  @RequirePermission(MANAGE)
  @Post(':id/off-road')
  offRoad(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string, @Body() raw: unknown) {
    return this.flag(hub, id, raw, 'offRoad');
  }

  private async flag(
    hub: HubRequestContext,
    id: string,
    raw: unknown,
    field: 'quarantined' | 'offRoad',
  ): Promise<VehicleDto> {
    const input = body(FlagInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound();
      if (v[field] === input.on) throw new HubError('CONFLICT', 409, 'No change');
      await tx.vehicle.update({
        where: { id },
        data: { [field]: input.on, updatedBy: hub.user.id },
      });
      await refreshVehicleStatus(tx, id);
      await audit(this.db, tx, hub, {
        action: `fleet.vehicle.${field === 'offRoad' ? 'off_road' : 'quarantine'}`,
        entity: 'vehicle',
        entityId: id,
        summary: { on: input.on },
      });
      return this.dto(tx, id);
    });
  }

  private async dto(tx: TenantTx, id: string): Promise<VehicleDto> {
    const v = await tx.vehicle.findUniqueOrThrow({ where: { id } });
    return toVehicleDto(v, (await openDefectCounts(tx, [id])).get(id) ?? 0);
  }
}

async function openDefectCounts(tx: TenantTx, ids: string[]): Promise<Map<string, number>> {
  const g = await tx.defect.groupBy({
    by: ['vehicleId'],
    where: { vehicleId: { in: ids }, status: { not: 'RELEASED' } },
    _count: { _all: true },
  });
  return new Map(g.map((x) => [x.vehicleId as string, x._count._all]));
}

async function assertLocation(tx: TenantTx, hub: HubRequestContext, id: string): Promise<void> {
  if (!(await tx.location.findUnique({ where: { id } }))) throw notFound();
  if (hub.locationIds && !hub.locationIds.includes(id)) throw notFound();
}

const EqListQuery = z.object({
  vehicleId: z.string().uuid().optional(),
  status: z.enum(['AVAILABLE', 'QUARANTINED', 'RETIRED']).optional(),
});
const QuarantineInput = z.strictObject({ reason: z.string().trim().min(3).max(500) });

/** Equipment register with separate inspection regimes and quarantine (FLT-03, FLT-08). */
@Controller('equipment')
export class EquipmentController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get()
  async list(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: EquipmentDto[] }> {
    const f = body(EqListQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.equipmentAsset.findMany({
        where: {
          ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
          ...(f.status ? { status: f.status } : { status: { not: 'RETIRED' } }),
        },
        include: { regimes: true },
        orderBy: { assetTag: 'asc' },
        take: 1000,
      });
      const inst = await instancesFor(
        tx,
        rows.flatMap((r) => r.regimes.map((g) => g.requirementInstanceId)),
      );
      return { data: rows.map((r) => toEquipmentDto(r, inst)) };
    });
  }

  @RequirePermission(MANAGE)
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<EquipmentDto> {
    const input = body(EquipmentCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.vehicleId && !(await tx.vehicle.count({ where: { id: input.vehicleId } })))
        throw notFound();
      if (input.locationId) await assertLocation(tx, hub, input.locationId);
      if (
        await tx.equipmentAsset.findFirst({
          where: { assetTag: input.assetTag },
          select: { id: true },
        })
      )
        throw new HubError('CONFLICT', 409, 'That asset tag is already in use');
      const a = await tx.equipmentAsset.create({
        data: {
          ...input,
          organisationId: hub.orgId as string,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await applyAutoRequirements(
        tx,
        {
          subjectType: 'EQUIPMENT',
          subjectId: a.id,
          kind: a.category,
          locationId: a.locationId,
          organisationId: a.organisationId,
        },
        hub.user.id,
        new Date(),
      );
      await audit(this.db, tx, hub, {
        action: 'fleet.equipment.create',
        entity: 'equipment_asset',
        entityId: a.id,
        summary: { assetTag: a.assetTag },
      });
      return this.dto(tx, a.id);
    });
  }

  @RequirePermission(VIEW)
  @Get(':id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<EquipmentDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.equipmentAsset.count({ where: { id } }))) throw notFound();
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Patch(':id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EquipmentDto> {
    const expected = ifMatchVersion(req);
    const input = body(EquipmentPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.vehicleId && !(await tx.vehicle.count({ where: { id: input.vehicleId } })))
        throw notFound();
      if (input.locationId) await assertLocation(tx, hub, input.locationId);
      const r = await tx.equipmentAsset.updateMany({
        where: { id, version: expected },
        data: { ...input, updatedBy: hub.user.id },
      });
      if (r.count === 0)
        throw staleOrNotFound((await tx.equipmentAsset.count({ where: { id } })) > 0);
      await audit(this.db, tx, hub, {
        action: 'fleet.equipment.update',
        entity: 'equipment_asset',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/quarantine')
  async quarantine(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EquipmentDto> {
    const input = body(QuarantineInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.equipmentAsset.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status !== 'AVAILABLE')
        throw new HubError('CONFLICT', 409, 'The asset is not in service');
      await tx.equipmentAsset.update({
        where: { id },
        data: { status: 'QUARANTINED', quarantineReason: input.reason, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.equipment.quarantine',
        entity: 'equipment_asset',
        entityId: id,
        summary: { vehicleId: a.vehicleId },
      });
      return this.dto(tx, id);
    });
  }

  /** Release from quarantine is a return-to-service decision (FLT-06). */
  @RequirePermission('fleet.return_to_service')
  @Post(':id/release')
  async release(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EquipmentDto> {
    const input = body(QuarantineInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.equipmentAsset.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.status !== 'QUARANTINED')
        throw new HubError('CONFLICT', 409, 'The asset is not quarantined');
      const open = await tx.defect.count({
        where: { assetId: id, stopUse: true, status: { not: 'RELEASED' } },
      });
      if (open > 0)
        throw new HubError(
          'OVERRIDE_NOT_PERMITTED',
          422,
          'Release the open stop-use defects first',
        );
      await tx.equipmentAsset.update({
        where: { id },
        data: { status: 'AVAILABLE', quarantineReason: null, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.equipment.release',
        entity: 'equipment_asset',
        entityId: id,
        summary: { reason: input.reason.slice(0, 120) },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/regimes')
  async regime(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<EquipmentDto> {
    const input = body(RegimeInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.equipmentAsset.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (await tx.inspectionRegime.findFirst({ where: { assetId: id, regime: input.regime } }))
        throw new HubError('CONFLICT', 409, 'That regime already exists for the asset');
      const v = await tx.requirementTemplateVersion.findFirst({
        where: { templateId: input.templateId, status: 'EFFECTIVE', organisationId: hub.orgId },
      });
      if (!v) throw new HubError('TEMPLATE_NOT_PUBLISHED', 422, 'Publish the template first');
      if (v.subjectType !== 'EQUIPMENT')
        throw new HubError('VALIDATION_FAILED', 400, 'Use an equipment requirement template');
      let inst = await tx.requirementInstance.findFirst({
        where: { templateId: input.templateId, subjectType: 'EQUIPMENT', subjectId: id },
      });
      if (!inst) {
        inst = await tx.requirementInstance.create({
          data: {
            organisationId: a.organisationId,
            templateId: input.templateId,
            templateVersionId: v.id,
            subjectType: 'EQUIPMENT',
            subjectId: id,
            locationId: a.locationId,
            createdBy: hub.user.id,
          },
        });
        await recomputeInstance(tx, inst.id, new Date());
      } else if (
        await tx.inspectionRegime.findFirst({ where: { requirementInstanceId: inst.id } })
      ) {
        throw new HubError(
          'CONFLICT',
          409,
          'Each regime needs its own requirement (no shared schedules)',
        );
      }
      await tx.inspectionRegime.create({
        data: {
          organisationId: a.organisationId,
          assetId: id,
          regime: input.regime,
          requirementInstanceId: inst.id,
          source: input.source ?? null,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.equipment.regime',
        entity: 'equipment_asset',
        entityId: id,
        summary: { regime: input.regime },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission(VIEW)
  @Get(':id/readiness')
  async readiness(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Query() q: unknown,
  ) {
    const f = body(NeedsQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.equipmentAsset.count({ where: { id } }))) throw notFound();
      const r = await equipmentReadinessFor(tx, {
        assetId: id,
        window: { start: new Date(f.from), end: new Date(f.to) },
        now: new Date(),
      });
      return { state: r.state, checks: r.checks };
    });
  }

  private async dto(tx: TenantTx, id: string): Promise<EquipmentDto> {
    const a = await tx.equipmentAsset.findUniqueOrThrow({
      where: { id },
      include: { regimes: true },
    });
    return toEquipmentDto(
      a,
      await instancesFor(
        tx,
        a.regimes.map((r) => r.requirementInstanceId),
      ),
    );
  }
}

function instancesFor(tx: TenantTx, ids: string[]) {
  return tx.requirementInstance.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, reasonText: true },
  });
}
