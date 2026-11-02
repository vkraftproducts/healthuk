import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { CONFIG, type AppConfig } from '../config.js';
import { HubError } from '../common/problem.filter.js';
import { LOGGER } from '../logger.provider.js';

export const KEY_RESOLVER = Symbol('KEY_RESOLVER');

export interface VerifiedToken {
  sub: string;
  /** Authentication methods references; MFA satisfied when it includes `mfa`. */
  amr: readonly string[];
  /** Only set when the IdP states the address is verified. */
  verifiedEmail: string | null;
}

@Injectable()
export class TokenService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(KEY_RESOLVER) private readonly keys: JWTVerifyGetKey,
    @Optional() @Inject(LOGGER) private readonly log?: Logger,
  ) {}

  /** Validates signature, issuer, audience and expiry. Any failure is a generic 401. */
  async verify(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.OIDC_ISSUER,
        audience: this.config.OIDC_AUDIENCE,
        algorithms: ['RS256', 'ES256', 'PS256'],
        clockTolerance: 5,
        requiredClaims: ['sub', 'exp'],
      });
      const amr = Array.isArray(payload.amr)
        ? payload.amr.filter((v): v is string => typeof v === 'string')
        : [];
      const email =
        typeof payload.email === 'string' && payload.email_verified === true
          ? payload.email.toLowerCase()
          : null;
      return { sub: String(payload.sub), amr, verifiedEmail: email };
    } catch (e) {
      // Why it failed (error code and claim only, never the token) to make sign-in problems
      // diagnosable; the caller still gets a generic 401.
      const err = e as { code?: string; claim?: string };
      this.log?.warn({ reason: err.code ?? 'UNKNOWN', claim: err.claim }, 'token rejected');
      throw new HubError('UNAUTHENTICATED', 401);
    }
  }
}
