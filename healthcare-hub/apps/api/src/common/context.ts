import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { TenantContext } from '@hub/db';

export interface HubRequestContext {
  user: { id: string; email: string; displayName: string };
  /** Selected organisation (X-Org-Id), validated against memberships. */
  orgId: string | null;
  roleKeys: readonly string[];
  permissions: ReadonlySet<string>;
  /** null = all locations in the organisation. */
  locationIds: readonly string[] | null;
  mfaSatisfied: boolean;
  mfaRequired: boolean;
  ipHash: string;
  /** Acting through an org-approved break-glass grant (platform support). */
  support: boolean;
  /** When that grant ends (A4 banner); absent outside support access. */
  supportEndsAt?: Date;
}

export type HubRequest = FastifyRequest & { hub?: HubRequestContext };

export function getHub(req: HubRequest): HubRequestContext {
  if (!req.hub) throw new Error('Request context missing (guard did not run)');
  return req.hub;
}

/** Injects the validated request context. */
export const Hub = createParamDecorator((_d: unknown, ctx: ExecutionContext) =>
  getHub(ctx.switchToHttp().getRequest<HubRequest>()),
);

/** Tenant context for db.withTenant(); throws if no organisation has been selected. */
export function tenantOf(hub: HubRequestContext): TenantContext {
  if (!hub.orgId) throw new Error('Organisation context required');
  return {
    orgId: hub.orgId,
    userId: hub.user.id,
    permissions: [...hub.permissions],
    locationIds: hub.locationIds,
  };
}
