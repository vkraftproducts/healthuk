import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Application role (RLS applies). */
  DATABASE_URL: z.string().min(1),
  /** pg-boss needs DDL rights on its own schema; use a dedicated connection string. */
  QUEUE_DATABASE_URL: z.string().min(1),
  /** Same blob store as the API (Azure Blob in deployed environments). */
  EVIDENCE_DIR: z.string().min(1).default('../api/.data/evidence'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Crew app push: `expo` sends through the Expo push service; `log` records only (development). */
  PUSH_PROVIDER: z.enum(['log', 'expo']).default('log'),
  EXPO_ACCESS_TOKEN: z.string().min(10).optional(),
});
export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.PUSH_PROVIDER !== 'expo')
    throw new Error('Invalid configuration: PUSH_PROVIDER must be expo in production');
  return parsed.data;
}
