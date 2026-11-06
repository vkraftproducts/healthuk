import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { CONFIG, type AppConfig } from '../config.js';
import { HubError } from '../common/problem.filter.js';
import { LOGGER } from '../logger.provider.js';
import {
  LOCAL_ISSUER,
  LOCAL_KEYS,
  LOCAL_SUBJECT_PREFIX,
  type LocalSigningKeys,
} from './local-keys.js';

export const KEY_RESOLVER = Symbol('KEY_RESOLVER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rejected = (code: string) => Object.assign(new Error(code), { code });

export interface VerifiedToken {
  sub: string;
  /** Authentication methods references; MFA satisfied per mfaSatisfiedBy() (mfa.ts). */
  amr: readonly string[];
  /** Only set when the IdP states the address is verified. */
  verifiedEmail: string | null;
  /** Set only for tokens this API signed for local sign-in: the app_user id they were issued to. */
  localUserId: string | null;
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEY_RESOLVER) private readonly keys: JWTVerifyGetKey,
    @Optional() @Inject(LOGGER) private readonly log?: Logger,
    @Optional() @Inject(LOCAL_KEYS) private readonly localKeys?: LocalSigningKeys | null,
  ) {}

  /**
   * Validates signature, issuer, audience and expiry. Any failure is a generic 401.
   * AUTH_MODE=local: ONLY tokens signed by this API's local key (issuer healthcare-hub-local) are
   * accepted, so a running mock OIDC server cannot bypass the password check. Other modes: only the
   * configured OIDC issuer; the local issuer is never trusted.
   */
  async verify(token: string): Promise<VerifiedToken> {
    try {
      const local = this.config.AUTH_MODE === 'local';
      let payload: JWTPayload;
      if (local) {
        if (!this.localKeys) throw rejected('NO_LOCAL_KEY');
        ({ payload } = await jwtVerify(token, this.localKeys.publicKey, {
          issuer: LOCAL_ISSUER,
          audience: this.config.OIDC_AUDIENCE,
          algorithms: [this.localKeys.alg],
          clockTolerance: 5,
          requiredClaims: ['sub', 'exp', 'iat'],
        }));
      } else {
        ({ payload } = await jwtVerify(token, this.keys, {
          issuer: this.config.OIDC_ISSUER,
          audience: this.config.OIDC_AUDIENCE,
          algorithms: ['RS256', 'ES256', 'PS256'],
          clockTolerance: 5,
          requiredClaims: ['sub', 'exp'],
        }));
      }
      const amr = Array.isArray(payload.amr)
        ? payload.amr.filter((v): v is string => typeof v === 'string')
        : [];
      const email =
        typeof payload.email === 'string' && payload.email_verified === true
          ? payload.email.toLowerCase()
          : null;
      const sub = String(payload.sub);
      let localUserId: string | null = null;
      if (local) {
        const id = sub.startsWith(LOCAL_SUBJECT_PREFIX)
          ? sub.slice(LOCAL_SUBJECT_PREFIX.length)
          : '';
        if (!UUID.test(id)) throw rejected('BAD_LOCAL_SUBJECT');
        localUserId = id.toLowerCase();
      }
      return { sub, amr, verifiedEmail: email, localUserId };
    } catch (e) {
      // Why it failed (error code and claim only, never the token) to make sign-in problems
      // diagnosable; the caller still gets a generic 401.
      const err = e as { code?: string; claim?: string };
      this.log?.warn({ reason: err.code ?? 'UNKNOWN', claim: err.claim }, 'token rejected');
      throw new HubError('UNAUTHENTICATED', 401);
    }
  }
}
