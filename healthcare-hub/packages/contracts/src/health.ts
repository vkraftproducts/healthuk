import { z } from 'zod';

export const HealthResponse = z.object({ status: z.literal('ok') });
export const ReadyResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.object({ database: z.enum(['ok', 'fail']) }),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
