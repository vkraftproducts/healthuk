import { z } from 'zod';
import { isoDateTime, page, uuid } from './common.js';

export const AuditEntryDto = z.object({
  id: uuid,
  seq: z.string(), // bigint as string
  occurredAt: isoDateTime,
  actorUserId: uuid.nullable(),
  actorName: z.string().nullable().optional(),
  /** L4: the actor's role(s) in this organisation today (names, comma separated). */
  actorRole: z.string().nullable().optional(),
  actorType: z.enum(['USER', 'SYSTEM', 'SUPPORT']),
  action: z.string(),
  entity: z.string(),
  entityId: z.string(),
  /** L4: the reason given, when the action needed one. */
  reason: z.string().nullable().optional(),
  /** L4: what changed, as short plain values (never patient data). */
  summary: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  hash: z.string(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;

export const AuditListResponse = page(AuditEntryDto);

export const AuditListQuery = z.object({
  entity: z.string().max(100).optional(),
  /** L4: an action or an action prefix such as `staff.` */
  action: z
    .string()
    .max(100)
    .regex(/^[a-z0-9_.]+$/)
    .optional(),
  entityId: z.string().max(100).optional(),
  actorId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type AuditListQuery = z.infer<typeof AuditListQuery>;
/** L4: the CSV export takes the same filters, without paging (capped at 5,000 rows). */
export const AuditExportQuery = AuditListQuery.omit({ cursor: true, limit: true });
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

export const VerifyChainResponse = z.object({
  intact: z.boolean(),
  brokenSeq: z.string().nullable(),
  reason: z.string().nullable(),
  verifiedAt: isoDateTime,
});
export type VerifyChainResponse = z.infer<typeof VerifyChainResponse>;
export type AuditListResponse = z.infer<typeof AuditListResponse>;
