import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  ActivityCreate,
  ActivityPatch,
  LocationCreate,
  LocationPatch,
  OrganisationPatch,
  SECTOR_PACKS,
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
  kind: string | null;
  cqcLocationId: string | null;
  registered: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  version: number;
}): LocationDto => ({
  id: l.id,
  name: l.name,
  address: (l.address ?? {}) as LocationDto['address'],
  type: l.type,
  kind: (l.kind ?? null) as LocationDto['kind'],
  cqcLocationId: l.cqcLocationId,
  registered: l.registered,
  archived: l.archivedAt !== null,
  archiveReason: l.archiveReason,
  version: l.version,
});
const toService = (
  s: { id: string; code: string; name: string; archivedAt: Date | null; version: number },
  locationIds: string[],
): ServiceDto => ({
  id: s.id,
  code: s.code,
  name: s.name,
  archived: s.archivedAt !== null,
  locationIds,
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
const toOrg = (o: {
  id: string;
  name: string;
  legalName: string | null;
  tradingName: string | null;
  cqcProviderId: string | null;
  address: unknown;
  mainContact: unknown;
  sectorPacks: string[];
  regulator: string;
  timezone: string;
  version: number;
}): OrganisationDto => ({
  id: o.id,
  name: o.name,
  legalName: o.legalName,
  tradingName: o.tradingName,
  cqcProviderId: o.cqcProviderId,
  address: (o.address ?? {}) as OrganisationDto['address'],
  mainContact: (o.mainContact ?? {}) as OrganisationDto['mainContact'],
  sectorPacks: o.sectorPacks,
  regulator: o.regulator,
  timezone: o.timezone,
  version: o.version,
});

/** Library pack prefixes that belong to each sector pack (pack-only content). */
const PACK_PREFIX: Record<string, string> = {
  ambulance: 'AMBULANCE',
  dental: 'DENTAL',
  care_home: 'CARE_HOME',
};

/** Organisation, locations, services and registered activities (PRD §3, §4.11, WORKFLOWS A2). */
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
    return toOrg(o);
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
      const cur = await tx.organisation.findUnique({ where: { id } });
      if (!cur) throw staleOrNotFound(false);
      if (patch.sectorPacks) {
        const off = cur.sectorPacks.filter((p) => !patch.sectorPacks!.includes(p));
        for (const pack of off) await this.assertPackUnused(tx, id, pack);
      }
      const { address, mainContact, ...rest } = patch;
      const r = await tx.organisation.updateMany({
        where: { id, version },
        data: {
          ...rest,
          ...(address ? { address } : {}),
          ...(mainContact ? { mainContact } : {}),
          updatedBy: hub.user.id,
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      const o = await tx.organisation.findUniqueOrThrow({ where: { id } });
      await audit(this.db, tx, hub, {
        action: 'org.organisation.update',
        entity: 'organisation',
        entityId: id,
        summary: {
          fields: Object.keys(patch).join(','),
          ...(patch.sectorPacks ? { sectorPacks: patch.sectorPacks.join(',') } : {}),
        },
      });
      return toOrg(o);
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
      await this.assertUniqueName(tx, input.name);
      const l = await tx.location.create({
        data: { organisationId: id, ...input, createdBy: hub.user.id, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'org.location.create',
        entity: 'location',
        entityId: l.id,
        summary: { kind: l.kind, registered: l.registered },
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
    const { archived, archiveReason, ...rest } = body(LocationPatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const cur = await tx.location.findUnique({ where: { id: locationId } });
      if (!cur) throw staleOrNotFound(false);
      if (rest.name && rest.name.toLowerCase() !== cur.name.toLowerCase())
        await this.assertUniqueName(tx, rest.name, locationId);
      if (archived === true && cur.archivedAt === null) await this.assertArchivable(tx, cur);
      const data: Json = { ...rest, updatedBy: hub.user.id };
      if (archived !== undefined) {
        data.archivedAt = archived ? new Date() : null;
        data.archiveReason = archived ? (archiveReason ?? null) : null;
      }
      const r = await tx.location.updateMany({ where: { id: locationId, version }, data });
      if (r.count === 0) throw staleOrNotFound(true);
      const l = await tx.location.findUniqueOrThrow({ where: { id: locationId } });
      await audit(this.db, tx, hub, {
        action: archived === true ? 'org.location.archive' : 'org.location.update',
        entity: 'location',
        entityId: locationId,
        summary: {
          archived: l.archivedAt !== null,
          fields: Object.keys(rest).join(','),
          ...(archived === true && archiveReason ? { reason: archiveReason } : {}),
        },
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
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [rows, links] = await Promise.all([
        tx.serviceType.findMany({ orderBy: { code: 'asc' } }),
        tx.serviceLocation.findMany({ select: { serviceId: true, locationId: true } }),
      ]);
      const of = (sid: string) => links.filter((l) => l.serviceId === sid).map((l) => l.locationId);
      return { data: rows.map((s) => toService(s, of(s.id))) };
    });
  }

  @RequirePermission('admin.org.manage')
  @Post(':id/services')
  async createService(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Body() raw: unknown,
  ): Promise<ServiceDto> {
    assertOrgParam(hub, id);
    const { locationIds, ...input } = body(ServiceCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const exists = await tx.serviceType.findUnique({
        where: { organisationId_code: { organisationId: id, code: input.code } },
      });
      if (exists)
        throw new HubError('VALIDATION_FAILED', 409, 'A service with this code already exists');
      const s = await tx.serviceType.create({
        data: { organisationId: id, ...input, createdBy: hub.user.id, updatedBy: hub.user.id },
      });
      const ids = await this.setServiceLocations(tx, hub, s.id, locationIds);
      await audit(this.db, tx, hub, {
        action: 'org.service.create',
        entity: 'service_type',
        entityId: s.id,
        summary: { locations: ids.length },
      });
      return toService(s, ids);
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
    const { archived, locationIds, ...rest } = body(ServicePatch, raw);
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
      const ids =
        locationIds !== undefined
          ? await this.setServiceLocations(tx, hub, serviceId, locationIds)
          : (
              await tx.serviceLocation.findMany({
                where: { serviceId },
                select: { locationId: true },
              })
            ).map((l) => l.locationId);
      await audit(this.db, tx, hub, {
        action: 'org.service.update',
        entity: 'service_type',
        entityId: serviceId,
        summary: { locationsChanged: locationIds !== undefined, locations: ids.length },
      });
      return toService(s, ids);
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

  // ---- helpers -------------------------------------------------------------
  /** A2: two locations cannot share a name (case and spacing ignored). */
  private async assertUniqueName(tx: TenantTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.location.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash)
      throw new HubError('CONFLICT', 409, `There is already a location called "${name.trim()}"`);
  }

  /**
   * A2: refuse archiving the last active location, or one where staff are based or vehicles are
   * kept, and say why.
   */
  private async assertArchivable(tx: TenantTx, loc: { id: string; name: string }): Promise<void> {
    const others = await tx.location.count({ where: { archivedAt: null, id: { not: loc.id } } });
    if (others === 0)
      throw new HubError(
        'CONFLICT',
        409,
        `${loc.name} is the only active location. Add another location before archiving it.`,
      );
    const [staff, vehicles] = await Promise.all([
      tx.staff.count({ where: { primaryLocationId: loc.id, lifecycleState: { not: 'LEAVER' } } }),
      tx.vehicle.count({ where: { baseLocationId: loc.id } }),
    ]);
    const why = [
      staff ? `${staff} active staff member${staff === 1 ? ' is' : 's are'} based there` : '',
      vehicles ? `${vehicles} vehicle${vehicles === 1 ? ' is' : 's are'} kept there` : '',
    ].filter(Boolean);
    if (why.length)
      throw new HubError(
        'CONFLICT',
        409,
        `${loc.name} cannot be archived: ${why.join(' and ')}. Move them first.`,
      );
  }

  /** A2: a sector pack cannot be switched off while records that only it uses still exist. */
  private async assertPackUnused(tx: TenantTx, orgId: string, pack: string): Promise<void> {
    const prefix = PACK_PREFIX[pack];
    const templates = prefix
      ? await tx.requirementTemplate.findMany({
          where: { organisationId: orgId, pack: { startsWith: prefix } },
          select: { code: true, title: true },
          orderBy: { code: 'asc' },
        })
      : [];
    const vehicles = pack === 'ambulance' ? await tx.vehicle.count() : 0;
    const items = [
      ...templates.map((t) => `${t.code} ${t.title}`),
      ...(vehicles ? [`${vehicles} vehicle${vehicles === 1 ? '' : 's'}`] : []),
    ];
    if (items.length === 0) return;
    const shown = items.slice(0, 10);
    const more = items.length > shown.length ? `, and ${items.length - shown.length} more` : '';
    throw new HubError(
      'CONFLICT',
      409,
      `The ${SECTOR_PACKS[pack] ?? pack} pack cannot be switched off while these records use ` +
        `it: ${shown.join('; ')}${more}.`,
      items.map((title) => ({ title })),
    );
  }

  private async setServiceLocations(
    tx: TenantTx,
    hub: HubRequestContext,
    serviceId: string,
    locationIds: readonly string[],
  ): Promise<string[]> {
    const ids = [...new Set(locationIds)];
    if (ids.length) {
      const found = await tx.location.count({ where: { id: { in: ids } } });
      if (found !== ids.length)
        throw new HubError('NOT_FOUND', 404, 'One or more locations were not found');
    }
    await tx.serviceLocation.deleteMany({ where: { serviceId, locationId: { notIn: ids } } });
    const have = (
      await tx.serviceLocation.findMany({ where: { serviceId }, select: { locationId: true } })
    ).map((l) => l.locationId);
    for (const locationId of ids.filter((l) => !have.includes(l)))
      await tx.serviceLocation.create({
        data: {
          organisationId: hub.orgId as string,
          serviceId,
          locationId,
          createdBy: hub.user.id,
        },
      });
    return ids;
  }
}
