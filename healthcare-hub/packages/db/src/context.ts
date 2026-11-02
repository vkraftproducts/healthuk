import type { Prisma, PrismaClient } from './generated/client.js';

export type TenantTx = Prisma.TransactionClient;

export interface TenantContext {
  orgId: string;
  userId: string;
  /** Permission keys granted in this request; exposed to restricted-table RLS policies. */
  permissions?: readonly string[];
  /** Location scope; null/undefined = all locations in the organisation. */
  locationIds?: readonly string[] | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new TypeError(`${what} must be a UUID`);
}

const TX_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

/**
 * Runs `fn` in a transaction with the tenant context applied via transaction-local settings,
 * which Postgres Row-Level Security policies read. This is the ONLY way request handlers
 * touch tenant data.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.orgId, 'orgId');
  assertUuid(ctx.userId, 'userId');
  ctx.locationIds?.forEach((id) => assertUuid(id, 'locationId'));
  const permissions = (ctx.permissions ?? []).join(',');
  const locations = ctx.locationIds ? ctx.locationIds.join(',') : '';
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.org_id', ${ctx.orgId}, true),
      set_config('app.user_id', ${ctx.userId}, true),
      set_config('app.permissions', ${permissions}, true),
      set_config('app.location_ids', ${locations}, true)`;
    return fn(tx);
  }, TX_OPTIONS);
}

/** Identity-only context (no organisation selected yet), e.g. listing a user's own memberships. */
export async function withIdentity<T>(
  prisma: PrismaClient,
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'userId');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT
      set_config('app.org_id', '', true),
      set_config('app.user_id', ${userId}, true),
      set_config('app.permissions', '', true),
      set_config('app.location_ids', '', true)`;
    return fn(tx);
  }, TX_OPTIONS);
}
