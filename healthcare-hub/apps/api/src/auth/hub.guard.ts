import { createHmac } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DB } from '../db.provider.js';
import type { Db, ResolvedUser } from '@hub/db';
import { CONFIG, type AppConfig } from '../config.js';
import { PUBLIC_KEY } from '../common/decorators.js';
import type { HubRequest } from '../common/context.js';
import { HubError, notFound } from '../common/problem.filter.js';
import { mfaRequiredFor } from './mfa.js';
import { TokenService } from './token.service.js';
import { UserCache } from './user-cache.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authentication + request context (runs before PermissionGuard):
 *  1. Verify the bearer token (issuer, audience, expiry, signature).
 *  2. Map the IdP subject to a user (linking a pending invitation on first sign-in when the IdP has
 *     verified the email); only ACTIVE users pass (leavers/suspended => 401).
 *  3. A user with no current membership and no active support grant is treated as revoked (401).
 *  4. If X-Org-Id is sent, it must match a current membership or an active support grant (else 404).
 *  5. Roles, permissions and location scope come from the database - never from the token.
 */
@Injectable()
export class HubGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(UserCache) private readonly cache: UserCache,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]))
      return true;
    const req = ctx.switchToHttp().getRequest<HubRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match?.[1]) throw new HubError('UNAUTHENTICATED', 401);

    const token = await this.tokens.verify(match[1]);
    const user = await this.lookupUser(token.sub, token.verifiedEmail);
    if (!user) throw new HubError('UNAUTHENTICATED', 401);
    if (user.status !== 'ACTIVE') throw new HubError('USER_INACTIVE', 401);

    const ipHash = createHmac('sha256', this.config.IP_HASH_SECRET)
      .update(req.ip ?? '')
      .digest('hex');
    const orgHeader = req.headers['x-org-id'];
    const deviceHeader = req.headers['x-device-id'];
    const locHeader = req.headers['x-location-id'];
    const now = new Date();

    const { memberships, grants, supportPerms, deviceRevoked } = await this.db.withIdentity(
      user.id,
      async (tx) => {
        const memberships = await tx.membership.findMany({
          where: {
            userId: user.id,
            validFrom: { lte: now },
            OR: [{ validTo: null }, { validTo: { gt: now } }],
          },
          include: { role: { include: { rolePermissions: true } } },
        });
        const grants = await tx.supportAccessGrant.findMany({
          where: { supportUserId: user.id, startsAt: { lte: now }, endsAt: { gt: now } },
        });
        const supportRole = grants.length
          ? await tx.role.findFirst({
              where: { organisationId: null, key: 'PLATFORM_SUPPORT' },
              include: { rolePermissions: true },
            })
          : null;
        // The crew app identifies its device: a revoked device is refused (the app then wipes itself).
        const device =
          typeof deviceHeader === 'string' && deviceHeader.length > 0 && deviceHeader.length <= 100
            ? await tx.deviceSession.findUnique({
                where: { userId_deviceId: { userId: user.id, deviceId: deviceHeader } },
                select: { revokedAt: true },
              })
            : null;
        return {
          memberships,
          grants,
          supportPerms: supportRole?.rolePermissions.map((p) => p.permissionKey) ?? [],
          deviceRevoked: !!device?.revokedAt,
        };
      },
    );

    if (deviceRevoked) throw new HubError('DEVICE_REVOKED', 401);
    // No current access anywhere: the user has been revoked (leaver) - the next call fails (US-SYS-1).
    if (memberships.length === 0 && grants.length === 0) throw new HubError('USER_INACTIVE', 401);

    let orgId: string | null = null;
    let roleKeys: string[] = [];
    let permissions = new Set<string>();
    let locationIds: string[] | null = null;
    let support = false;
    let grantId: string | null = null;

    if (typeof orgHeader === 'string' && orgHeader !== '') {
      if (!UUID.test(orgHeader)) throw notFound();
      const inOrg = memberships.filter((m) => m.organisationId === orgHeader);
      const grant = grants.find((g) => g.organisationId === orgHeader);
      if (inOrg.length > 0) {
        orgId = orgHeader;
        roleKeys = [...new Set(inOrg.map((m) => m.role.key))];
        permissions = new Set(
          inOrg.flatMap((m) => m.role.rolePermissions.map((rp) => rp.permissionKey)),
        );
        locationIds = inOrg.some((m) => m.locationId === null)
          ? null
          : [...new Set(inOrg.map((m) => m.locationId as string))];
      } else if (grant) {
        orgId = orgHeader;
        support = true;
        grantId = grant.id;
        roleKeys = ['PLATFORM_SUPPORT'];
        permissions = new Set(supportPerms);
        locationIds = null;
      } else {
        throw notFound(); // never reveal that the organisation exists
      }
      if (typeof locHeader === 'string' && locHeader !== '') {
        if (!UUID.test(locHeader) || (locationIds !== null && !locationIds.includes(locHeader)))
          throw notFound();
        locationIds = [locHeader];
      }
    }

    req.hub = {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      orgId,
      roleKeys,
      permissions,
      locationIds,
      mfaSatisfied: token.amr.includes('mfa'),
      mfaRequired: mfaRequiredFor(roleKeys),
      ipHash,
      support,
    };

    if (support && orgId && grantId) {
      // Every request made through a break-glass grant is audited and visible to the organisation.
      await this.db.withTenant({ orgId, userId: user.id, permissions: [...permissions] }, (tx) =>
        this.db.appendAudit(tx, {
          orgId,
          actorUserId: user.id,
          actorType: 'SUPPORT',
          action: 'support.access.request',
          entity: 'support_access_grant',
          entityId: grantId,
          afterSummary: { method: req.method, path: req.url.split('?')[0] ?? '' },
          ipHash,
        }),
      );
    }
    return true;
  }

  private async lookupUser(
    sub: string,
    verifiedEmail: string | null,
  ): Promise<ResolvedUser | null> {
    const hit = this.cache.get(sub);
    if (hit?.user) return hit.user;
    let user = await this.db.resolveUser(sub);
    if (!user && verifiedEmail) user = await this.db.linkInvitedUser(sub, verifiedEmail);
    if (user) this.cache.set(sub, user);
    return user;
  }
}
