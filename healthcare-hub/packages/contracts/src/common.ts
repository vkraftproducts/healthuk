import { z } from 'zod';

export const uuid = z.string().uuid();
/** Date-only field, `YYYY-MM-DD`. Evaluated in Europe/London by the rules package (ALERT-01). */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoDateTime = z.string().datetime({ offset: true });

export const RagStatus = z.enum(['RED', 'AMBER', 'GREEN', 'GREY', 'NOT_APPLICABLE']);
export type RagStatus = z.infer<typeof RagStatus>;

/** Every response for a status-bearing entity includes this triple (API_SPEC). */
export const StatusInfo = z.object({
  status: RagStatus,
  reasonCode: z.string(),
  reasonText: z.string(),
});
export type StatusInfo = z.infer<typeof StatusInfo>;

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });
