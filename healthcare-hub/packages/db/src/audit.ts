import type { TenantTx } from './context.js';
import type { ActorType, Prisma } from './generated/client.js';

export interface AuditEventInput {
  orgId: string;
  actorUserId: string | null;
  actorType?: ActorType;
  /** `module.resource.action`, e.g. `staff.sensitive.view`. */
  action: string;
  entity: string;
  entityId: string;
  /** Hash of the prior state (not the state itself). */
  beforeHash?: string;
  /** Summary of the change. MUST NOT contain PII or patient data; log IDs, not names. */
  afterSummary?: Prisma.InputJsonObject;
  /** Hash of the client IP (never the raw IP). */
  ipHash?: string;
}

/**
 * Appends an audit event. seq, prev_hash and hash are computed by the database trigger, so a
 * caller can neither forge nor skip the chain. Must be called inside withTenant().
 */
export async function appendAudit(
  tx: TenantTx,
  e: AuditEventInput,
): Promise<{ seq: bigint; hash: string }> {
  const row = await tx.auditLog.create({
    data: {
      organisationId: e.orgId,
      actorUserId: e.actorUserId,
      actorType: e.actorType ?? 'USER',
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      beforeHash: e.beforeHash ?? null,
      afterSummary: e.afterSummary ?? {},
      ipHash: e.ipHash ?? null,
    },
    select: { seq: true, hash: true },
  });
  return row;
}

export interface ChainBreak {
  brokenSeq: bigint;
  reason: string;
}

/** Returns null when the organisation's chain is intact, otherwise the first break. */
export async function verifyAuditChain(tx: TenantTx, orgId: string): Promise<ChainBreak | null> {
  const rows = await tx.$queryRaw<
    { broken_seq: bigint; reason: string }[]
  >`SELECT broken_seq, reason FROM audit_verify_chain(${orgId}::uuid)`;
  const first = rows[0];
  return first ? { brokenSeq: first.broken_seq, reason: first.reason } : null;
}
