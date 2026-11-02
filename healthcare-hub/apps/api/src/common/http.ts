import type { z } from 'zod';
import { HubError, notFound } from './problem.filter.js';
import type { HubRequest, HubRequestContext } from './context.js';
import type { Db, TenantTx } from '@hub/db';

/** Parses the `If-Match` header (`"3"` or `3`) used for optimistic concurrency (API_SPEC). */
export function ifMatchVersion(req: HubRequest): number {
  const raw = req.headers['if-match'];
  const m = typeof raw === 'string' ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim()) : null;
  if (!m?.[1])
    throw new HubError(
      'VALIDATION_FAILED',
      400,
      'If-Match header with the current version is required',
    );
  return Number(m[1]);
}

/** After a versioned updateMany matched nothing: 404 if the row is not visible, else 409. */
export function staleOrNotFound(exists: boolean): HubError {
  return exists
    ? new HubError('STALE_VERSION', 409, 'The record was changed by someone else; reload and retry')
    : notFound();
}

/** The `:id` in /organisations/:id must be the selected organisation, otherwise it does not exist for this caller. */
export function assertOrgParam(hub: HubRequestContext, id: string): string {
  if (!hub.orgId || hub.orgId !== id) throw notFound();
  return hub.orgId;
}

export function body<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export interface AuditArgs {
  action: string;
  entity: string;
  entityId: string;
  /** IDs and statuses only - never names or other PII. */
  summary?: Record<string, string | number | boolean | null>;
}

/** Appends an audit event inside the caller's transaction so the change and its record commit atomically. */
export function audit(db: Db, tx: TenantTx, hub: HubRequestContext, a: AuditArgs) {
  return db.appendAudit(tx, {
    orgId: hub.orgId as string,
    actorUserId: hub.user.id,
    actorType: hub.support ? 'SUPPORT' : 'USER',
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    afterSummary: a.summary ?? {},
    ipHash: hub.ipHash,
  });
}

/** For routes open to several permissions (declared @OrgMember): at least one is required. */
export function requireAny(hub: HubRequestContext, ...keys: string[]): void {
  if (!keys.some((k) => hub.permissions.has(k))) throw new HubError('FORBIDDEN', 403);
}

/** Parses a page-less list filter and refuses captured times far in the future (clock skew). */
export function assertNotFuture(at: Date, now: Date, slackMs = 5 * 60_000): void {
  if (at.getTime() > now.getTime() + slackMs)
    throw new HubError('VALIDATION_FAILED', 400, 'The captured time is in the future');
}
