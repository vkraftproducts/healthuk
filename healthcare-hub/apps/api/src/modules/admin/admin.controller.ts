import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ALL_PERMISSION_KEYS,
  AddMembership,
  InviteUser,
  PERMISSIONS,
  RevokeUser,
  RoleCreate,
  RolePatch,
  SettingsPatch,
  OrgSettings,
  SupportGrantCreate,
  SELF_SERVICE_PERMISSIONS,
  type AdminUserDto,
  type RoleDto,
  type SettingsResponse,
  type SupportGrantDto,
} from '@hub/contracts';
import type { Db, TenantTx } from '@hub/db';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { UserCache } from '../../auth/user-cache.js';
import { DB } from '../../db.provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v: string) => {
  if (!UUID.test(v)) throw notFound();
  return v;
};

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(UserCache) private readonly cache: UserCache,
  ) {}

  // ---- users ---------------------------------------------------------------
  @RequirePermission('admin.users.manage')
  @Get('users')
  async users(@Hub() hub: HubRequestContext): Promise<{ data: AdminUserDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.membership.findMany({
        include: { user: true, role: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const byUser = new Map<string, AdminUserDto>();
    for (const m of rows) {
      const u = byUser.get(m.userId) ?? {
        id: m.user.id,
        email: m.user.email,
        displayName: m.user.displayName,
        status: m.user.status,
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
        memberships: [],
      };
      u.memberships.push({
        membershipId: m.id,
        roleId: m.roleId,
        roleKey: m.role.key,
        roleName: m.role.name,
        locationId: m.locationId,
        validFrom: m.validFrom.toISOString(),
        validTo: m.validTo?.toISOString() ?? null,
      });
      byUser.set(m.userId, u);
    }
    return { data: [...byUser.values()] };
  }

  @RequirePermission('admin.users.manage')
  @Post('users')
  async invite(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<{ id: string }> {
    const input = body(InviteUser, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.assertGrantable(tx, hub, input.roleId);
      let id: string;
      try {
        const r = await tx.$queryRaw<{ invite_user: string }[]>`
          SELECT invite_user(${input.email}, ${input.displayName}, ${input.roleId}::uuid, ${input.locationId}::uuid)`;
        id = r[0]!.invite_user;
      } catch (e) {
        if (/not available/.test((e as Error).message))
          throw new HubError('NOT_FOUND', 404, 'Role or location not available');
        throw e;
      }
      await audit(this.db, tx, hub, {
        action: 'admin.user.invite',
        entity: 'app_user',
        entityId: id,
        summary: { roleId: input.roleId },
      });
      return { id };
    });
  }

  @RequirePermission('admin.users.manage')
  @Post('users/:id/memberships')
  async addMembership(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<{ membershipId: string }> {
    const id = uuidParam(rawId);
    const input = body(AddMembership, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const member = await tx.membership.findFirst({ where: { userId: id } });
      if (!member) throw notFound();
      await this.assertGrantable(tx, hub, input.roleId);
      const loc = input.locationId
        ? await tx.location.findUnique({ where: { id: input.locationId } })
        : true;
      const role = await tx.role.findUnique({ where: { id: input.roleId } });
      if (!loc || !role) throw new HubError('NOT_FOUND', 404, 'Role or location not available');
      const m = await tx.membership.create({
        data: {
          organisationId: hub.orgId as string,
          userId: id,
          roleId: input.roleId,
          locationId: input.locationId,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'admin.membership.add',
        entity: 'membership',
        entityId: m.id,
        summary: { userId: id, roleId: input.roleId },
      });
      return { membershipId: m.id };
    });
  }

  /**
   * Revokes a person's access to this organisation immediately: all current memberships end now and
   * their devices are revoked. Authorship of historic records is retained. The next API call by the
   * person returns 401 once they hold no access anywhere (US-SYS-1).
   */
  @RequirePermission('admin.users.manage')
  @Post('users/:id/revoke')
  @HttpCode(200)
  async revoke(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<{ revokedMemberships: number; revokedDevices: number }> {
    const id = uuidParam(rawId);
    const { reason } = body(RevokeUser, raw);
    if (id === hub.user.id)
      throw new HubError('FORBIDDEN', 403, 'You cannot revoke your own access');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const exists = await tx.membership.findFirst({ where: { userId: id } });
      if (!exists) throw notFound();
      const memberships = await tx.$executeRaw`
        UPDATE membership SET valid_to = greatest(now(), valid_from + interval '1 millisecond'), updated_by = ${hub.user.id}::uuid
        WHERE user_id = ${id}::uuid AND (valid_to IS NULL OR valid_to > now())`;
      const devices = await tx.deviceSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'admin.user.revoke',
        entity: 'app_user',
        entityId: id,
        summary: { memberships, devices: devices.count, reasonLength: reason.length },
      });
      this.cache.evictUser(id);
      return { revokedMemberships: memberships, revokedDevices: devices.count };
    });
  }

  // ---- roles & permissions -------------------------------------------------
  @RequirePermission('admin.roles.manage')
  @Get('permissions')
  permissions() {
    return {
      data: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
    };
  }

  @RequirePermission('admin.roles.manage')
  @Get('roles')
  async roles(@Hub() hub: HubRequestContext): Promise<{ data: RoleDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.role.findMany({
        include: { rolePermissions: true },
        orderBy: [{ isSystem: 'desc' }, { key: 'asc' }],
      }),
    );
    return { data: rows.map(toRole) };
  }

  @RequirePermission('admin.roles.manage')
  @Post('roles')
  async createRole(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<RoleDto> {
    const input = body(RoleCreate, raw);
    this.assertKnownPermissions(input.permissions);
    this.assertCanGrant(hub, input.permissions);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const clash = await tx.role.findFirst({ where: { key: input.key } });
      if (clash)
        throw new HubError('VALIDATION_FAILED', 409, 'A role with this key already exists');
      const role = await tx.role.create({
        data: {
          organisationId: hub.orgId as string,
          key: input.key,
          name: input.name,
          derivedFrom: input.derivedFrom,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await this.setPermissions(tx, role.id, input.permissions);
      await audit(this.db, tx, hub, {
        action: 'admin.role.create',
        entity: 'role',
        entityId: role.id,
        summary: { permissions: input.permissions.length },
      });
      return toRole(
        await tx.role.findUniqueOrThrow({
          where: { id: role.id },
          include: { rolePermissions: true },
        }),
      );
    });
  }

  @RequirePermission('admin.roles.manage')
  @Patch('roles/:id')
  async updateRole(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<RoleDto> {
    const id = uuidParam(rawId);
    const patch = body(RolePatch, raw);
    const version = ifMatchVersion(req);
    if (patch.permissions) {
      this.assertKnownPermissions(patch.permissions);
      this.assertCanGrant(hub, patch.permissions);
    }
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const role = await tx.role.findUnique({ where: { id } });
      if (!role) throw notFound();
      if (role.isSystem)
        throw new HubError(
          'FORBIDDEN',
          403,
          'System roles cannot be changed; create a custom role instead',
        );
      const r = await tx.role.updateMany({
        where: { id, version },
        data: { ...(patch.name ? { name: patch.name } : {}), updatedBy: hub.user.id },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      if (patch.permissions) await this.setPermissions(tx, id, patch.permissions);
      await audit(this.db, tx, hub, {
        action: 'admin.role.update',
        entity: 'role',
        entityId: id,
        summary: { permissionsChanged: patch.permissions !== undefined },
      });
      return toRole(
        await tx.role.findUniqueOrThrow({ where: { id }, include: { rolePermissions: true } }),
      );
    });
  }

  // ---- settings ------------------------------------------------------------
  @OrgMember()
  @Get('settings')
  async settings(@Hub() hub: HubRequestContext): Promise<SettingsResponse> {
    const o = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.organisation.findUniqueOrThrow({ where: { id: hub.orgId as string } }),
    );
    return { settings: OrgSettings.parse(o.settings), version: o.version };
  }

  @RequirePermission('admin.settings.manage')
  @Patch('settings')
  async updateSettings(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Body() raw: unknown,
  ): Promise<SettingsResponse> {
    const patch = body(SettingsPatch, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await tx.organisation.findUniqueOrThrow({ where: { id: hub.orgId as string } });
      const next = OrgSettings.parse({ ...(o.settings as object), ...patch });
      const r = await tx.organisation.updateMany({
        where: { id: o.id, version },
        data: { settings: next, updatedBy: hub.user.id },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'admin.settings.update',
        entity: 'organisation',
        entityId: o.id,
        summary: { fields: Object.keys(patch).join(',') },
      });
      const fresh = await tx.organisation.findUniqueOrThrow({ where: { id: o.id } });
      return { settings: OrgSettings.parse(fresh.settings), version: fresh.version };
    });
  }

  // ---- break-glass support access -----------------------------------------
  @RequirePermission('admin.support.view')
  @Get('support-access-grants')
  async grants(@Hub() hub: HubRequestContext): Promise<{ data: SupportGrantDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.supportAccessGrant.findMany({ orderBy: { startsAt: 'desc' }, take: 100 }),
    );
    const now = new Date();
    return {
      data: rows.map((g) => ({
        id: g.id,
        supportUserId: g.supportUserId,
        approvedBy: g.approvedBy,
        reason: g.reason,
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt.toISOString(),
        active: g.startsAt <= now && g.endsAt > now,
      })),
    };
  }

  @RequirePermission('admin.support.approve')
  @Post('support-access-grants')
  async approveGrant(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<SupportGrantDto> {
    const input = body(SupportGrantCreate, raw);
    if (hub.support) throw new HubError('FORBIDDEN', 403);
    const supportUserId = await this.db.findSupportUser(input.supportUserEmail);
    if (!supportUserId) throw notFound();
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + input.hours * 3_600_000);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const g = await tx.supportAccessGrant.create({
        data: {
          organisationId: hub.orgId as string,
          supportUserId,
          approvedBy: hub.user.id,
          reason: input.reason,
          startsAt,
          endsAt,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'admin.support.approve',
        entity: 'support_access_grant',
        entityId: g.id,
        summary: { hours: input.hours },
      });
      return {
        id: g.id,
        supportUserId,
        approvedBy: hub.user.id,
        reason: g.reason,
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt.toISOString(),
        active: true,
      };
    });
  }

  // ---- helpers -------------------------------------------------------------
  private assertKnownPermissions(keys: readonly string[]): void {
    const unknown = keys.filter((k) => !(ALL_PERMISSION_KEYS as readonly string[]).includes(k));
    if (unknown.length)
      throw new HubError('VALIDATION_FAILED', 400, `Unknown permissions: ${unknown.join(', ')}`);
  }

  /** No privilege escalation: you can only grant permissions you hold yourself. */
  private assertCanGrant(hub: HubRequestContext, keys: readonly string[]): void {
    const missing = keys.filter(
      (k) => !hub.permissions.has(k) && !SELF_SERVICE_PERMISSIONS.includes(k),
    );
    if (missing.length)
      throw new HubError(
        'OVERRIDE_NOT_PERMITTED',
        422,
        `You cannot grant permissions you do not hold: ${missing.join(', ')}`,
      );
  }

  private async assertGrantable(
    tx: TenantTx,
    hub: HubRequestContext,
    roleId: string,
  ): Promise<void> {
    const role = await tx.role.findUnique({
      where: { id: roleId },
      include: { rolePermissions: true },
    });
    if (!role) throw new HubError('NOT_FOUND', 404, 'Role or location not available');
    this.assertCanGrant(
      hub,
      role.rolePermissions.map((p) => p.permissionKey),
    );
  }

  private async setPermissions(
    tx: TenantTx,
    roleId: string,
    keys: readonly string[],
  ): Promise<void> {
    await tx.rolePermission.deleteMany({ where: { roleId } });
    try {
      for (const permissionKey of new Set(keys))
        await tx.rolePermission.create({ data: { roleId, permissionKey } });
    } catch (e) {
      if (/cannot be granted/.test((e as Error).message)) {
        throw new HubError(
          'OVERRIDE_NOT_PERMITTED',
          422,
          'A restricted permission cannot be granted to a role derived from dispatcher or crew',
        );
      }
      throw e;
    }
  }
}

function toRole(r: {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  derivedFrom: string | null;
  version: number;
  rolePermissions: { permissionKey: string }[];
}): RoleDto {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    isSystem: r.isSystem,
    derivedFrom: r.derivedFrom,
    permissions: r.rolePermissions.map((p) => p.permissionKey).sort(),
    version: r.version,
  };
}
