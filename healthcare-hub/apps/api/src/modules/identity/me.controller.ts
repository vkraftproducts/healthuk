import { Controller, Get, Inject } from '@nestjs/common';
import type { Db } from '@hub/db';
import type { MeResponse } from '@hub/contracts';
import { AuthenticatedOnly } from '../../common/decorators.js';
import { Hub, type HubRequestContext } from '../../common/context.js';
import { DB } from '../../db.provider.js';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @AuthenticatedOnly()
  @Get()
  async me(@Hub() hub: HubRequestContext): Promise<MeResponse> {
    const now = new Date();
    const memberships = await this.db.withIdentity(hub.user.id, (tx) =>
      tx.membership.findMany({
        where: {
          userId: hub.user.id,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        include: {
          organisation: { select: { name: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return {
      user: { id: hub.user.id, email: hub.user.email, displayName: hub.user.displayName },
      memberships: memberships.map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        locationId: m.locationId,
        roleKey: m.role.key,
        roleName: m.role.name,
      })),
      permissions: [...hub.permissions].sort(),
      activeOrganisationId: hub.orgId,
      mfa: { required: hub.mfaRequired, satisfied: hub.mfaSatisfied },
    };
  }
}
