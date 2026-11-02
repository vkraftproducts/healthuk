import { z } from 'zod';
import { isoDateTime, page, uuid } from './common.js';

export const AuditEntryDto = z.object({
  id: uuid,
  seq: z.string(), // bigint as string
  occurredAt: isoDateTime,
  actorUserId: uuid.nullable(),
  actorType: z.enum(['USER', 'SYSTEM', 'SUPPORT']),
  action: z.string(),
  entity: z.string(),
  entityId: z.string(),
  hash: z.string(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

export const AuditListResponse = page(AuditEntryDto);

export const AuditListQuery = z.object({
  entity: z.string().max(100).optional(),
  actorId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;

export const VerifyChainResponse = z.object({
  intact: z.boolean(),
  brokenSeq: z.string().nullable(),
  reason: z.string().nullable(),
  verifiedAt: isoDateTime,
});
export type VerifyChainResponse = z.infer<typeof VerifyChainResponse>;
export type AuditListResponse = z.infer<typeof AuditListResponse>;
