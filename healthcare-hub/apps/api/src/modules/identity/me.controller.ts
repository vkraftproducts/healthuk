import { Controller, Get, Inject } from '@nestjs/common';
import type { Db } from '@hub/db';
import type { MeResponse } from '@hub/contracts';
import { AuthenticatedOnly } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, dbNow } from '../../common/http.js';
import { DB } from '../../db.provider.js';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @AuthenticatedOnly()
  @Get()
  async me(@Hub() hub: HubRequestContext): Promise<MeResponse> {
    const memberships = await this.db.withIdentity(hub.user.id, async (tx) => {
      const now = await dbNow(tx);
      return tx.membership.findMany({
        where: {
          userId: hub.user.id,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        include: {
          organisation: { select: { name: true, sectorPacks: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
    });
    if (hub.orgId && !hub.support) await this.recordSignIn(hub);
    return {
      user: { id: hub.user.id, email: hub.user.email, displayName: hub.user.displayName },
      memberships: memberships.map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        locationId: m.locationId,
        roleKey: m.role.key,
        roleName: m.role.name,
        sectorPacks: m.organisation.sectorPacks,
      })),
      permissions: [...hub.permissions].sort(),
      activeOrganisationId: hub.orgId,
      mfa: { required: hub.mfaRequired, satisfied: hub.mfaSatisfied },
      support: hub.supportEndsAt ? { endsAt: hub.supportEndsAt.toISOString() } : null,
    };
  }

  /** A1: a sign-in is audited and shown as "Last signed in"; once per window, not per call. */
  private async recordSignIn(hub: HubRequestContext): Promise<void> {
    await this.db.withTenant(tenantOf(hub), async (tx) => {
      const me = await tx.membership.findFirst({
        where: { userId: hub.user.id },
        select: { user: { select: { lastLoginAt: true } } },
      });
      const last = me?.user.lastLoginAt?.getTime() ?? 0;
      if (Date.now() - last < SIGN_IN_WINDOW_MS) return;
      await tx.$executeRaw`SELECT record_sign_in()`;
      await audit(this.db, tx, hub, {
        action: 'auth.sign_in',
        entity: 'app_user',
        entityId: hub.user.id,
        summary: { mfa: hub.mfaSatisfied },
      });
    });
  }
}

const SIGN_IN_WINDOW_MS = 8 * 3_600_000;
