import 'reflect-metadata';
import { createRemoteJWKSet } from 'jose';
import { createDb } from '@hub/db';
import { createApp } from './app.js';
import { switchOffMfaForDevelopment } from './auth/mfa.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  if (config.DEV_DISABLE_MFA) {
    switchOffMfaForDevelopment();
    logger.warn('DEV_DISABLE_MFA is on: privileged roles sign in without an authenticator code');
  }
  const db = createDb(config.DATABASE_URL);
  const app = await createApp({
    config,
    logger,
    db,
    keyResolver: createRemoteJWKSet(new URL(config.OIDC_JWKS_URI)),
  });
  app.enableShutdownHooks();
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
  logger.info({ port: config.API_PORT }, 'api listening');
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : 'unknown'}\n`);
  process.exit(1);
});
