import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { SignJWT } from 'jose';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';

/** Issuer of tokens minted by this API for local sign-in (AUTH_MODE=local, ADR 0006). */
export const LOCAL_ISSUER = 'healthcare-hub-local';
export const LOCAL_SUBJECT_PREFIX = 'local|';
export const LOCAL_TOKEN_TTL_SECONDS = 15 * 60;
export const LOCAL_KEYS = Symbol('LOCAL_KEYS');

export interface LocalSigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  alg: 'ES256' | 'RS256';
  kid: string;
}

/**
 * The local sign-in key pair, or null when AUTH_MODE is not `local` (then no local token is ever
 * trusted). LOCAL_AUTH_PRIVATE_KEY (PKCS#8 PEM, EC P-256 or RSA >= 2048) is required in production;
 * in development an ephemeral key is generated, so a restart signs everybody out.
 */
export function loadLocalSigningKeys(config: AppConfig, log?: Logger): LocalSigningKeys | null {
  if (config.AUTH_MODE !== 'local') return null;
  if (config.LOCAL_AUTH_PRIVATE_KEY) {
    // Env files often carry the PEM on one line with literal \n.
    const pem = config.LOCAL_AUTH_PRIVATE_KEY.replace(/\\n/g, '\n');
    const privateKey = createPrivateKey({ key: pem, format: 'pem' });
    const publicKey = createPublicKey(privateKey);
    const type = privateKey.asymmetricKeyType;
    const details = privateKey.asymmetricKeyDetails;
    if (type === 'ec' && details?.namedCurve === 'prime256v1')
      return { privateKey, publicKey, alg: 'ES256', kid: 'local-1' };
    if (type === 'rsa' && (details?.modulusLength ?? 0) >= 2048)
      return { privateKey, publicKey, alg: 'RS256', kid: 'local-1' };
    throw new Error('LOCAL_AUTH_PRIVATE_KEY must be an EC P-256 or RSA (2048+) private key');
  }
  if (config.NODE_ENV === 'production')
    throw new Error('LOCAL_AUTH_PRIVATE_KEY is required for AUTH_MODE=local in production');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  log?.info('local sign-in: generated an ephemeral signing key (development only)');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, alg: 'ES256', kid: 'local-dev' };
}

/**
 * Mints an access token that TokenService accepts in local mode. Claims only identify the user;
 * roles and permissions always come from the database. `amr` is ['pwd'] or ['pwd', 'otp'].
 */
export async function signLocalToken(
  keys: LocalSigningKeys,
  audience: string,
  user: { id: string; email: string },
  amr: readonly string[],
): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number }> {
  const token = await new SignJWT({ email: user.email, email_verified: true, amr: [...amr] })
    .setProtectedHeader({ alg: keys.alg, kid: keys.kid, typ: 'JWT' })
    .setSubject(`${LOCAL_SUBJECT_PREFIX}${user.id}`)
    .setIssuer(LOCAL_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${LOCAL_TOKEN_TTL_SECONDS}s`)
    .sign(keys.privateKey);
  return { access_token: token, token_type: 'Bearer', expires_in: LOCAL_TOKEN_TTL_SECONDS };
}
