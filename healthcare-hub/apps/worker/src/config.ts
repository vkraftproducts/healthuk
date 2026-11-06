import { z } from 'zod';

const PushTransport = z.enum(['outbox', 'expo', 'webpush']);

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
  /** Escalation email: `outbox` records only (development); `smtp` sends through SMTP_URL. */
  EMAIL_TRANSPORT: z.enum(['outbox', 'smtp']).default('outbox'),
  /** `smtp://user:pass@host:587` or `smtps://...:465`. Mailpit in docker compose: smtp://localhost:1025 */
  SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\//, 'Expected smtp:// or smtps://')
    .optional(),
  EMAIL_FROM: z.string().min(3).default('Healthcare Hub <no-reply@healthcare-hub.invalid>'),
  /** Escalation push: `outbox` (development), or `expo`, `webpush` or both (`expo,webpush`). */
  PUSH_TRANSPORT: z
    .string()
    .default('outbox')
    .transform((s) => [
      ...new Set(
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(PushTransport).min(1)),
  /** Web Push VAPID keys (base64url): public 65-byte P-256 point, private 32-byte scalar. */
  VAPID_PUBLIC_KEY: z.string().min(80).optional(),
  VAPID_PRIVATE_KEY: z.string().min(40).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:|https:\/\/)/, 'Expected mailto: or https://')
    .optional(),
});
export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production' && c.PUSH_PROVIDER !== 'expo')
    throw new Error('Invalid configuration: PUSH_PROVIDER must be expo in production');
  if (c.EMAIL_TRANSPORT === 'smtp' && !c.SMTP_URL)
    throw new Error('Invalid configuration: SMTP_URL is required when EMAIL_TRANSPORT=smtp');
  if (
    c.PUSH_TRANSPORT.includes('webpush') &&
    !(c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY && c.VAPID_SUBJECT)
  )
    throw new Error(
      'Invalid configuration: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required for webpush',
    );
  if (c.PUSH_TRANSPORT.includes('outbox') && c.PUSH_TRANSPORT.length > 1)
    throw new Error('Invalid configuration: PUSH_TRANSPORT=outbox cannot be combined');
  if (c.NODE_ENV === 'production' && c.EMAIL_TRANSPORT !== 'smtp')
    throw new Error('Invalid configuration: EMAIL_TRANSPORT must be smtp in production');
  if (c.NODE_ENV === 'production' && c.PUSH_TRANSPORT.includes('outbox'))
    throw new Error(
      'Invalid configuration: PUSH_TRANSPORT must be expo and/or webpush in production',
    );
  return c;
}
