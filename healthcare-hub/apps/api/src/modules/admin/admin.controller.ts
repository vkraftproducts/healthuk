import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import {
  type PersonDto,
  ALL_PERMISSION_KEYS,
  AddMembership,
  InviteUser,
  MembershipChange,
  NON_INVITABLE_ROLE_KEYS,
  PERMISSIONS,
  RevokeUser,
  RoleCreate,
  RolePatch,
  SettingsPatch,
  OrgSettings,
  SupportGrantCreate,
  SupportGrantEnd,
  SELF_SERVICE_PERMISSIONS,
  type AdminUserDto,
  type RoleDto,
  type SettingsResponse,
  type SupportGrantDto,
} from '@hub/contracts';
import type { Db, TenantTx } from '@hub/db';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, dbNow, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { UserCache } from '../../auth/user-cache.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { flagFutureShifts } from '../staff/control-flags.js';

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
      // A3: someone who already has access is given a different role through Change access.
      const current = await tx.membership.findFirst({
        where: {
          user: { email: input.email },
          OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
        },
        select: { userId: true },
      });
      if (current)
        throw new HubError(
          'CONFLICT',
          409,
          'This person already has access here. Use Change access to give them a different ' +
            'role or location.',
          [{ code: 'EXISTING_USER', userId: current.userId }],
        );
      const staff = input.staffId
        ? await tx.staff.findUnique({ where: { id: input.staffId } })
        : null;
      if (input.staffId && !staff) throw notFound();
      if (staff?.userId)
        throw new HubError('CONFLICT', 409, 'That staff record already has a sign-in linked');
      if (staff?.lifecycleState === 'LEAVER')
        throw new HubError('CONFLICT', 409, 'That person has left; they cannot be invited');
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
      if (staff) {
        if (await tx.staff.findFirst({ where: { userId: id }, select: { id: true } }))
          throw new HubError('CONFLICT', 409, 'This sign-in is already linked to a staff record');
        await tx.staff.update({
          where: { id: staff.id },
          data: { userId: id, updatedBy: hub.user.id },
        });
      }
      await audit(this.db, tx, hub, {
        action: 'admin.user.invite',
        entity: 'app_user',
        entityId: id,
        summary: { roleId: input.roleId, staffId: staff?.id ?? null },
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
      if (id === hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'You cannot change your own access');
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
   * Changes a person's role or location. History is kept: the current membership ends now and a new
   * one starts with the new role or location. Nobody can change their own access.
   */
  @RequirePermission('admin.users.manage')
  @Patch('memberships/:id')
  async changeMembership(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<{ membershipId: string }> {
    const id = uuidParam(rawId);
    const input = body(MembershipChange, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const m = await tx.membership.findUnique({ where: { id } });
      if (!m) throw notFound();
      if (m.userId === hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'You cannot change your own role or location');
      if (m.validTo && m.validTo <= new Date())
        throw new HubError('CONFLICT', 409, 'This membership has already ended');
      const roleId = input.roleId ?? m.roleId;
      const locationId = input.locationId === undefined ? m.locationId : input.locationId;
      if (roleId === m.roleId && locationId === m.locationId)
        throw new HubError('VALIDATION_FAILED', 400, 'Nothing would change');
      await this.assertGrantable(tx, hub, roleId);
      if (roleId !== m.roleId) await this.assertNotLastManager(tx, m.userId, [m.id]);
      if (locationId && !(await tx.location.findUnique({ where: { id: locationId } })))
        throw new HubError('NOT_FOUND', 404, 'Role or location not available');
      await tx.$executeRaw`
        UPDATE membership SET valid_to = greatest(now(), valid_from + interval '1 millisecond'), updated_by = ${hub.user.id}::uuid
        WHERE id = ${id}::uuid`;
      const next = await tx.membership.create({
        data: {
          organisationId: hub.orgId as string,
          userId: m.userId,
          roleId,
          locationId,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'admin.membership.change',
        entity: 'membership',
        entityId: next.id,
        summary: {
          userId: m.userId,
          from: id,
          roleChanged: roleId !== m.roleId,
          locationChanged: locationId !== m.locationId,
          reasonLength: input.reason.length,
        },
      });
      this.cache.evictUser(m.userId);
      return { membershipId: next.id };
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
      await this.assertNotLastManager(tx, id, null);
      const memberships = await tx.$executeRaw`
        UPDATE membership SET valid_to = greatest(now(), valid_from + interval '1 millisecond'), updated_by = ${hub.user.id}::uuid
        WHERE user_id = ${id}::uuid AND (valid_to IS NULL OR valid_to > now())`;
      const devices = await tx.deviceSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Local sign-in: their browser sessions cannot be refreshed any more (ADR 0006).
      await tx.$queryRaw`SELECT revoke_local_refresh_tokens(${id}::uuid, 'ACCESS_ENDED')`;
      // A3: their future shifts are flagged to control (the planner itself is not edited).
      const staff = await tx.staff.findFirst({ where: { userId: id }, select: { id: true } });
      const flagged = staff
        ? await flagFutureShifts(tx, hub.orgId as string, staff.id, 'ACCESS_ENDED')
        : 0;
      await audit(this.db, tx, hub, {
        action: 'admin.user.revoke',
        entity: 'app_user',
        entityId: id,
        summary: { memberships, devices: devices.count, reason, futureBookingsFlagged: flagged },
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

  // ---- people directory (owner and assignee pickers) -------------------------
  /**
   * Active members of this organisation with their role names, for "assign to" pickers. Names only:
   * no email or contact details, so any member may see it.
   */
  @OrgMember()
  @Get('people')
  async people(@Hub() hub: HubRequestContext): Promise<{ data: PersonDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.membership.findMany({
        where: {
          OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
          user: { status: 'ACTIVE' },
        },
        include: {
          user: { select: { id: true, displayName: true } },
          role: { select: { key: true, name: true } },
        },
      }),
    );
    const byUser = new Map<string, PersonDto>();
    for (const m of rows) {
      if (m.role.key === 'PLATFORM_SUPPORT') continue;
      const p = byUser.get(m.userId) ?? {
        id: m.user.id,
        displayName: m.user.displayName,
        roleKeys: [],
        roleNames: [],
        locationIds: [],
      };
      if (!p.roleKeys.includes(m.role.key)) {
        p.roleKeys.push(m.role.key);
        p.roleNames.push(m.role.name);
      }
      if (m.locationId && !p.locationIds.includes(m.locationId)) p.locationIds.push(m.locationId);
      byUser.set(m.userId, p);
    }
    return {
      data: [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
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
    const parsed = body(SettingsPatch, raw);
    // Only the keys actually sent change; a default never overwrites what is stored.
    const sent = new Set(Object.keys((raw ?? {}) as object));
    const patch = Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k)));
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await tx.organisation.findUniqueOrThrow({ where: { id: hub.orgId as string } });
      const people = [
        ...(parsed.deputies ?? []).flatMap((d) => [d.leadUserId, d.deputyUserId]),
        ...(parsed.speakUpGuardianUserId ? [parsed.speakUpGuardianUserId] : []),
      ];
      for (const userId of new Set(people)) {
        const n = await tx.membership.count({
          where: { userId, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
        });
        if (n === 0)
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            'Deputies, leads and the guardian must be current members of this organisation',
          );
      }
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
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.supportAccessGrant.findMany({
        orderBy: { startsAt: 'desc' },
        take: 100,
      });
      const ends = await tx.supportAccessEnd.findMany({
        where: { grantId: { in: rows.map((g) => g.id) } },
      });
      const names = await userNames(
        tx,
        rows.map((g) => g.approvedBy),
      );
      const now = new Date();
      return {
        data: rows.map((g) => {
          const end = ends.find((e) => e.grantId === g.id) ?? null;
          return {
            id: g.id,
            supportUserId: g.supportUserId,
            supportUserName: 'Platform support',
            approvedBy: g.approvedBy,
            approvedByName: names.get(g.approvedBy) ?? 'Unknown',
            reason: g.reason,
            startsAt: g.startsAt.toISOString(),
            endsAt: g.endsAt.toISOString(),
            endedEarlyAt: end?.endedAt.toISOString() ?? null,
            endedEarlyReason: end?.reason ?? null,
            active: !end && g.startsAt <= now && g.endsAt > now,
          };
        }),
      };
    });
  }

  /** A4: end support access before its time is up. The grant itself is never edited. */
  @RequirePermission('admin.support.approve')
  @Post('support-access-grants/:id/end')
  @HttpCode(200)
  async endGrant(
    @Hub() hub: HubRequestContext,
    @Param('id') rawId: string,
    @Body() raw: unknown,
  ): Promise<SupportGrantDto> {
    const id = uuidParam(rawId);
    const { reason } = body(SupportGrantEnd, raw);
    if (hub.support) throw new HubError('FORBIDDEN', 403);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const g = await tx.supportAccessGrant.findUnique({ where: { id } });
      if (!g) throw notFound();
      if (await tx.supportAccessEnd.findUnique({ where: { grantId: id } }))
        throw new HubError('CONFLICT', 409, 'This support access has already been ended');
      const now = await dbNow(tx);
      if (g.endsAt <= now)
        throw new HubError('CONFLICT', 409, 'This support access has already expired');
      const end = await tx.supportAccessEnd.create({
        data: { organisationId: g.organisationId, grantId: id, endedBy: hub.user.id, reason },
      });
      await audit(this.db, tx, hub, {
        action: 'admin.support.end',
        entity: 'support_access_grant',
        entityId: id,
        summary: { reason },
      });
      this.cache.evictUser(g.supportUserId);
      return {
        id: g.id,
        supportUserId: g.supportUserId,
        approvedBy: g.approvedBy,
        reason: g.reason,
        startsAt: g.startsAt.toISOString(),
        endsAt: g.endsAt.toISOString(),
        endedEarlyAt: end.endedAt.toISOString(),
        endedEarlyReason: reason,
        active: false,
      };
    });
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
  /** A3: an organisation always keeps at least one registered manager. */
  private async assertNotLastManager(
    tx: TenantTx,
    userId: string,
    membershipIds: string[] | null,
  ): Promise<void> {
    const current = { OR: [{ validTo: null }, { validTo: { gt: new Date() } }] };
    const managers = await tx.membership.findMany({
      where: { ...current, role: { key: 'REGISTERED_MANAGER' } },
      select: { id: true, userId: true },
    });
    const losing = managers.filter(
      (m) => m.userId === userId && (membershipIds === null || membershipIds.includes(m.id)),
    );
    if (losing.length === 0) return;
    const remaining = managers.filter((m) => !losing.some((l) => l.id === m.id));
    if (remaining.length === 0)
      throw new HubError(
        'CONFLICT',
        409,
        'This is the only registered manager. ' +
          'Give someone else the registered manager role first.',
      );
  }

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
    if (NON_INVITABLE_ROLE_KEYS.includes(role.key))
      throw new HubError(
        'FORBIDDEN',
        403,
        'Support access is granted for a limited time under Support access, not as a role',
      );
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
