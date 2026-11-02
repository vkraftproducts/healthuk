import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Db } from '@hub/db';
import {
  ActivityCreate,
  ActivityPatch,
  LocationCreate,
  LocationPatch,
  OrganisationPatch,
  ServiceCreate,
  ServicePatch,
  type ActivityDto,
  type LocationDto,
  type OrganisationDto,
  type ServiceDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { assertOrgParam, audit, body, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

type Json = Record<string, unknown>;
const toLocation = (l: {
  id: string;
  name: string;
  address: unknown;
  type: 'PATIENT_FACING' | 'ADMIN_ONLY';
  registered: boolean;
  archivedAt: Date | null;
  version: number;
}): LocationDto => ({
  id: l.id,
  name: l.name,
  address: (l.address ?? {}) as LocationDto['address'],
  type: l.type,
  registered: l.registered,
  archived: l.archivedAt !== null,
  version: l.version,
});
const toService = (s: {
  id: string;
  code: string;
  name: string;
  archivedAt: Date | null;
  version: number;
}): ServiceDto => ({
  id: s.id,
  code: s.code,
  name: s.name,
  archived: s.archivedAt !== null,
  version: s.version,
});
const toActivity = (a: {
  id: string;
  locationId: string;
  code: string;
  name: string;
  archivedAt: Date | null;
  version: number;
}): ActivityDto => ({
  id: a.id,
  locationId: a.locationId,
  code: a.code,
  name: a.name,
  archived: a.archivedAt !== null,
  version: a.version,
});

/** Organisation, locations, services and registered activities (PRD §3, §4.11). */
@Controller('organisations')
export class OrgController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get(':id')
  async get(@Hub() hub: HubRequestContext, @Param('id') id: string): Promise<OrganisationDto> {
    assertOrgParam(hub, id);
    const o = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.organisation.findUniqueOrThrow({ where: { id } }),
    );
    return {
      id: o.id,
      name: o.name,
      sectorPacks: o.sectorPacks,
      regulator: o.regulator,
      timezone: o.timezone,
      version: o.version,
    };
  }

  @RequirePermission('admin.org.manage')
  @Patch(':id')
  async update(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ): Promise<OrganisationDto> {
    assertOrgParam(hub, id);
    const patch = body(OrganisationPatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.organisation.updateMany({
        where: { id, version },
        data: { ...patch, updatedBy: hub.user.id },
      });
      if (r.count === 0)
        throw staleOrNotFound((await tx.organisation.findUnique({ where: { id } })) !== null);
      const o = await tx.organisation.findUniqueOrThrow({ where: { id } });
      await audit(this.db, tx, hub, {
        action: 'org.organisation.update',
        entity: 'organisation',
        entityId: id,
        summary: { fields: Object.keys(patch).join(',') },
      });
      return {
        id: o.id,
        name: o.name,
        sectorPacks: o.sectorPacks,
        regulator: o.regulator,
        timezone: o.timezone,
        version: o.version,
      };
    });
  }

  // ---- locations -----------------------------------------------------------
  @OrgMember()
  @Get(':id/locations')
  async locations(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
  ): Promise<{ data: LocationDto[] }> {
    assertOrgParam(hub, id);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.location.findMany({
        where: hub.locationIds ? { id: { in: [...hub.locationIds] } } : {},
        orderBy: { name: 'asc' },
      }),
    );
    return { data: rows.map(toLocation) };
  }

  @RequirePermission('admin.org.manage')
  @Post(':id/locations')
  async createLocation(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Body() raw: unknown,
  ): Promise<LocationDto> {
    assertOrgParam(hub, id);
    const input = body(LocationCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const l = await tx.location.create({
        data: { organisationId: id, ...input, createdBy: hub.user.id, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'org.location.create',
        entity: 'location',
        entityId: l.id,
      });
      return toLocation(l);
    });
  }

  @RequirePermission('admin.org.manage')
  @Patch(':id/locations/:locationId')
  async updateLocation(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Body() raw: unknown,
  ): Promise<LocationDto> {
    assertOrgParam(hub, id);
    const { archived, ...rest } = body(LocationPatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const data: Json = { ...rest, updatedBy: hub.user.id };
      if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
      const r = await tx.location.updateMany({ where: { id: locationId, version }, data });
      if (r.count === 0)
        throw staleOrNotFound(
          (await tx.location.findUnique({ where: { id: locationId } })) !== null,
        );
      const l = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
      await audit(this.db, tx, hub, {
        action: 'org.location.update',
        entity: 'location',
        entityId: locationId,
        summary: { archived: l.archivedAt !== null },
      });
      return toLocation(l);
    });
  }

  // ---- services ------------------------------------------------------------
  @OrgMember()
  @Get(':id/services')
  async services(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
  ): Promise<{ data: ServiceDto[] }> {
    assertOrgParam(hub, id);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.serviceType.findMany({ orderBy: { code: 'asc' } }),
    );
    return { data: rows.map(toService) };
  }

  @RequirePermission('admin.org.manage')
  @Post(':id/services')
  async createService(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Body() raw: unknown,
  ): Promise<ServiceDto> {
    assertOrgParam(hub, id);
    const input = body(ServiceCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const exists = await tx.serviceType.findUnique({
        where: { organisationId_code: { organisationId: id, code: input.code } },
      });
      if (exists)
        throw new HubError('VALIDATION_FAILED', 409, 'A service with this code already exists');
      const s = await tx.serviceType.create({
        data: { organisationId: id, ...input, createdBy: hub.user.id, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'org.service.create',
        entity: 'service_type',
        entityId: s.id,
      });
      return toService(s);
    });
  }

  @RequirePermission('admin.org.manage')
  @Patch(':id/services/:serviceId')
  async updateService(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() raw: unknown,
  ): Promise<ServiceDto> {
    assertOrgParam(hub, id);
    const { archived, ...rest } = body(ServicePatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const data: Json = { ...rest, updatedBy: hub.user.id };
      if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
      const r = await tx.serviceType.updateMany({ where: { id: serviceId, version }, data });
      if (r.count === 0)
        throw staleOrNotFound(
          (await tx.serviceType.findUnique({ where: { id: serviceId } })) !== null,
        );
      const s = await tx.serviceType.findUniqueOrThrow({ where: { id: serviceId } });
      await audit(this.db, tx, hub, {
        action: 'org.service.update',
        entity: 'service_type',
        entityId: serviceId,
      });
      return toService(s);
    });
  }

  // ---- registered activities ----------------------------------------------
  @OrgMember()
  @Get(':id/registered-activities')
  async activities(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
  ): Promise<{ data: ActivityDto[] }> {
    assertOrgParam(hub, id);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.registeredActivity.findMany({
        where: hub.locationIds ? { locationId: { in: [...hub.locationIds] } } : {},
        orderBy: [{ locationId: 'asc' }, { code: 'asc' }],
      }),
    );
    return { data: rows.map(toActivity) };
  }

  @RequirePermission('admin.org.manage')
  @Post(':id/registered-activities')
  async createActivity(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Body() raw: unknown,
  ): Promise<ActivityDto> {
    assertOrgParam(hub, id);
    const input = body(ActivityCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const loc = await tx.location.findUnique({ where: { id: input.locationId } });
      if (!loc) throw new HubError('NOT_FOUND', 404);
      const a = await tx.registeredActivity.create({
        data: { organisationId: id, ...input, createdBy: hub.user.id, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'org.activity.create',
        entity: 'registered_activity',
        entityId: a.id,
      });
      return toActivity(a);
    });
  }

  @RequirePermission('admin.org.manage')
  @Patch(':id/registered-activities/:activityId')
  async updateActivity(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Body() raw: unknown,
  ): Promise<ActivityDto> {
    assertOrgParam(hub, id);
    const { archived, ...rest } = body(ActivityPatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const data: Json = { ...rest, updatedBy: hub.user.id };
      if (archived !== undefined) data.archivedAt = archived ? new Date() : null;
      const r = await tx.registeredActivity.updateMany({
        where: { id: activityId, version },
        data,
      });
      if (r.count === 0)
        throw staleOrNotFound(
          (await tx.registeredActivity.findUnique({ where: { id: activityId } })) !== null,
        );
      const a = await tx.registeredActivity.findUniqueOrThrow({ where: { id: activityId } });
      await audit(this.db, tx, hub, {
        action: 'org.activity.update',
        entity: 'registered_activity',
        entityId: activityId,
      });
      return toActivity(a);
    });
  }
}
