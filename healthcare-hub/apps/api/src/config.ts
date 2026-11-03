import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URI: z.string().url(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  IP_HASH_SECRET: z.string().min(16).default('dev-only-ip-hash-secret-change-me'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  EVIDENCE_DIR: z.string().min(1).default('./.data/evidence'),
  BLOB_SIGNING_SECRET: z.string().min(16).default('dev-only-blob-signing-secret-change-me'),
  /** 32 bytes, base64. Dev default only; production must supply its own (checked below). */
  FIELD_ENCRYPTION_KEY: z.string().min(40).default('ZGV2LW9ubHktZmllbGQta2V5LTMyLWJ5dGVzLWxvbmc='),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Requests per user (or IP) per minute. Raised only for load-test environments. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(100_000).default(300),
  /** How long one live-updates stream stays open before the client must reconnect. */
  LIVE_STREAM_MAX_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
});

export type AppConfig = z.infer<typeof Env>;
export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Names only: never print values (they may be secrets).
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid configuration: ${names}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/.test(cfg.OIDC_ISSUER)) {
    throw new Error('Mock/local OIDC issuer is not permitted in production');
  }
  if (cfg.NODE_ENV === 'production' && (!env.IP_HASH_SECRET || env.IP_HASH_SECRET.length < 32)) {
    throw new Error('IP_HASH_SECRET (>= 32 chars) is required in production');
  }
  if (
    cfg.NODE_ENV === 'production' &&
    (!env.BLOB_SIGNING_SECRET || env.BLOB_SIGNING_SECRET.length < 32)
  ) {
    throw new Error('BLOB_SIGNING_SECRET (>= 32 chars) is required in production');
  }
  if (cfg.NODE_ENV === 'production' && cfg.FIELD_ENCRYPTION_KEY.startsWith('ZGV2LW9ubHkt')) {
    throw new Error('The development field-encryption key is not permitted in production');
  }
  if (cfg.NODE_ENV === 'production' && cfg.RATE_LIMIT_PER_MINUTE > 1000) {
    throw new Error('RATE_LIMIT_PER_MINUTE above 1000 is not permitted in production');
  }
  return cfg;
}
