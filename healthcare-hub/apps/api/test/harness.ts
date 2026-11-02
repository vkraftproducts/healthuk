import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import { createDb } from '@hub/db';
import { SEED_IDS, SEED_USERS, SEED_SUPPORT } from '@hub/db/admin';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const ISSUER = 'https://idp.test.example';
export const AUDIENCE = 'healthcare-hub-api';
export { SEED_IDS, SEED_USERS, SEED_SUPPORT };

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
const other = await generateKeyPair('RS256');

export interface TokenOpts {
  sub: string;
  amr?: string[];
  iss?: string;
  aud?: string;
  expiresIn?: string | number;
  wrongKey?: boolean;
  email?: string;
  emailVerified?: boolean;
}

export async function sign(o: TokenOpts): Promise<string> {
  return new SignJWT({
    amr: o.amr ?? ['pwd', 'mfa'],
    ...(o.email ? { email: o.email, email_verified: o.emailVerified ?? true } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(o.sub)
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.expiresIn ?? '5m')
    .sign(o.wrongKey ? other.privateKey : privateKey);
}

export async function makeApp(
  urls: { app: string },
  extraControllers: Parameters<typeof createApp>[0]['extraControllers'] = [],
) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    OIDC_ISSUER: ISSUER,
    OIDC_AUDIENCE: AUDIENCE,
    OIDC_JWKS_URI: 'https://idp.test.example/jwks',
    LOG_LEVEL: 'silent' as never,
  } as Record<string, string>);
  const logger = createLogger('silent');
  const db = createDb(urls.app);
  const app = await createApp({
    config,
    logger,
    db,
    keyResolver: createLocalJWKSet({ keys: [publicJwk] }),
    extraControllers,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, db };
}
