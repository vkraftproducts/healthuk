import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  AUTH_MESSAGES,
  LOCAL_REFRESH_ABSOLUTE_SECONDS,
  LOCAL_REFRESH_IDLE_SECONDS,
  passwordProblem,
  type ChangePasswordRequest,
  type ForcedPasswordChangeRequest,
  type LoginRequest,
  type LoginResponse,
  type MfaResetRequest,
  type MfaResetResponse,
  type MfaSetupResponse,
  type MfaVerifyRequest,
  type PasswordResetResponse,
  type TokenResponse,
} from '@hub/contracts';
import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import { CONFIG, type AppConfig } from '../../config.js';
import { DB } from '../../db.provider.js';
import { LOGGER } from '../../logger.provider.js';
import { tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, dbNow } from '../../common/http.js';
import { decryptField, encryptField, fieldKey } from '../../common/field-crypto.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { AttemptLimiter, applyFailure } from '../../auth/attempt-limiter.js';
import { LOCAL_KEYS, signLocalToken, type LocalSigningKeys } from '../../auth/local-keys.js';
import { mfaRequiredFor } from '../../auth/mfa.js';
import {
  dummyVerify,
  hashPassword,
  temporaryPassword,
  verifyPassword,
} from '../../auth/password.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../../auth/totp.js';
import { TokenService } from '../../auth/token.service.js';
import { UserCache } from '../../auth/user-cache.js';

/** A new refresh token for the cookie: the raw value never reaches the database or a log. */
export interface RefreshGrant {
  value: string;
  /** Seconds until this token's idle expiry, measured by the database clock. */
  maxAgeSeconds: number;
}
/** A reply body plus, when a session starts or rotates, the refresh token to set as a cookie. */
export interface WithRefresh<T> {
  body: T;
  refresh?: RefreshGrant;
}
type Issued = Required<WithRefresh<TokenResponse>>;

type RevokeReason =
  | 'LOGOUT'
  | 'REUSE'
  | 'EXPIRED'
  | 'PASSWORD_CHANGE'
  | 'PASSWORD_RESET'
  | 'MFA_RESET'
  | 'MFA_REQUIRED'
  | 'ACCESS_ENDED';

interface CredentialRow {
  user_id: string;
  username: string;
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
  must_change_password: boolean;
  totp_secret_encrypted: string | null;
  totp_enabled: boolean;
  totp_last_step: bigint | null;
}

type Stage = 'MFA' | 'MFA_SETUP' | 'PASSWORD_CHANGE';
interface Challenge {
  userId: string;
  stage: Stage;
  mfaRequired: boolean;
  mfaDone: boolean;
  expiresAt: number;
  attempts: number;
  /** TOTP secret shown during enrolment, kept only until the first code confirms it. */
  pendingSecret?: string;
}

interface Access {
  email: string;
  status: string;
  roleKeys: string[];
  currentOrgIds: string[];
  allOrgIds: string[];
  hasAccess: boolean;
}

type LockState = { failedAttempts: number; lockedUntil: number | null };

const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const IP_MAX_ATTEMPTS = 20;
const IP_WINDOW_MS = 15 * 60_000;

const invalid = () => new HubError('UNAUTHENTICATED', 401, AUTH_MESSAGES.invalid);
const locked = () => new HubError('UNAUTHENTICATED', 401, AUTH_MESSAGES.locked);
const ended = () => new HubError('USER_INACTIVE', 401, AUTH_MESSAGES.ended);
const expired = () => new HubError('UNAUTHENTICATED', 401, AUTH_MESSAGES.challengeExpired);
const sessionEnded = () => new HubError('UNAUTHENTICATED', 401, AUTH_MESSAGES.sessionEnded);

/**
 * Local username + password sign-in (AUTH_MODE=local, ADR 0006). Everything here answers 404 in
 * other modes. Never logs or audits passwords, hashes, TOTP codes or secrets; usernames appear only
 * as keyed hashes.
 */
@Injectable()
export class LocalAuthService {
  private readonly ipLimiter = new AttemptLimiter(IP_MAX_ATTEMPTS, IP_WINDOW_MS);
  /** Mirrors the account lockout for usernames that do not exist (see ADR 0006). */
  private readonly ghosts = new Map<string, LockState>();
  /** Keyed by SHA-256 of the challenge id; the id itself is never stored. */
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(UserCache) private readonly cache: UserCache,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Optional() @Inject(LOCAL_KEYS) private readonly keys?: LocalSigningKeys | null,
  ) {}

  // ---- public sign-in steps ------------------------------------------------------------------

  async login(input: LoginRequest, ip: string): Promise<WithRefresh<LoginResponse>> {
    const keys = this.enabled();
    const ipHash = this.ipHash(ip);
    this.limit(ipHash);
    const usernameHash = this.usernameHash(input.username);
    const now = Date.now();
    const cred = await this.findByUsername(input.username);

    if (!cred) {
      await dummyVerify(input.password); // same scrypt work as a real account
      const ghost = this.ghosts.get(usernameHash) ?? { failedAttempts: 0, lockedUntil: null };
      const isLocked = ghost.lockedUntil !== null && ghost.lockedUntil > now;
      const next = isLocked ? { ...ghost, lockedNow: false } : applyFailure(ghost, now);
      if (this.ghosts.size > 10_000) this.ghosts.clear();
      this.ghosts.set(usernameHash, {
        failedAttempts: next.failedAttempts,
        lockedUntil: next.lockedUntil,
      });
      this.log.warn(
        { event: 'auth.login.failure', reason: 'UNKNOWN_USER', usernameHash, ipHash },
        'local sign-in refused',
      );
      throw isLocked || next.lockedNow ? locked() : invalid();
    }

    const ok = await verifyPassword(input.password, cred.password_hash);
    if (cred.locked_until && cred.locked_until.getTime() > now) {
      // Locked: the reply is the same whether or not the password was right.
      await this.auditFailure(cred.user_id, 'LOCKED', usernameHash, ipHash);
      throw locked();
    }
    if (!ok) {
      const lockedNow = await this.recordFailure(cred.user_id, now);
      await this.auditFailure(cred.user_id, 'BAD_PASSWORD', usernameHash, ipHash, lockedNow);
      throw lockedNow ? locked() : invalid();
    }

    // Correct password from here on: only now may the reply say more.
    await this.withCredentials(
      cred.user_id,
      (tx) =>
        tx.$executeRaw`UPDATE local_credential SET failed_attempts = 0, locked_until = NULL
        WHERE user_id = ${cred.user_id}::uuid`,
    );
    const access = await this.access(cred.user_id);
    if (!access.hasAccess) {
      await this.auditUser(access.allOrgIds, cred.user_id, null, 'auth.login.failure', ipHash, {
        reason: 'ACCESS_ENDED',
        usernameHash,
      });
      throw ended();
    }
    return this.nextStep(keys, cred, mfaRequiredFor(access.roleKeys), false, ipHash);
  }

  async mfaSetup(challengeId: string, ip: string): Promise<MfaSetupResponse> {
    this.enabled();
    this.limit(this.ipHash(ip));
    const ch = this.peek(challengeId, ['MFA_SETUP']);
    if (ch.pendingSecret)
      throw new HubError(
        'CONFLICT',
        409,
        'Enrolment has already started. Sign in again to restart.',
      );
    const cred = await this.findByUser(ch.userId);
    if (!cred) throw expired();
    ch.pendingSecret = newTotpSecret();
    return { secret: ch.pendingSecret, otpauthUri: otpauthUri(ch.pendingSecret, cred.username) };
  }

  async mfaVerify(input: MfaVerifyRequest, ip: string): Promise<WithRefresh<LoginResponse>> {
    const keys = this.enabled();
    const ipHash = this.ipHash(ip);
    this.limit(ipHash);
    const ch = this.peek(input.challengeId, ['MFA', 'MFA_SETUP']);
    const cred = await this.findByUser(ch.userId);
    if (!cred) throw expired();
    const now = Date.now();
    let accepted = false;

    if (ch.stage === 'MFA_SETUP') {
      if (!ch.pendingSecret)
        throw new HubError('VALIDATION_FAILED', 400, 'Start enrolment before entering a code.');
      const step = verifyTotp(ch.pendingSecret, input.code, now, null);
      if (step !== null) {
        const enc = encryptField(ch.pendingSecret, this.fieldKey());
        await this.withCredentials(
          ch.userId,
          (tx) =>
            tx.$executeRaw`UPDATE local_credential
              SET totp_secret_encrypted = ${enc}, totp_enabled = true, totp_last_step = ${step},
                  updated_by = ${ch.userId}::uuid
            WHERE user_id = ${ch.userId}::uuid`,
        );
        const orgIds = (await this.access(ch.userId)).currentOrgIds;
        await this.auditUser(orgIds, ch.userId, ch.userId, 'auth.mfa.enrol', ipHash);
        accepted = true;
      }
    } else {
      const secret = cred.totp_secret_encrypted
        ? decryptField(cred.totp_secret_encrypted, this.fieldKey())
        : null;
      const last = cred.totp_last_step === null ? null : Number(cred.totp_last_step);
      const step = secret ? verifyTotp(secret, input.code, now, last) : null;
      if (step !== null) {
        // Conditional update: two requests racing with the same code cannot both succeed.
        const n = await this.withCredentials(
          ch.userId,
          (tx) =>
            tx.$executeRaw`UPDATE local_credential SET totp_last_step = ${step}
            WHERE user_id = ${ch.userId}::uuid
              AND (totp_last_step IS NULL OR totp_last_step < ${step})`,
        );
        accepted = n === 1;
      }
    }

    if (!accepted) {
      ch.attempts += 1;
      if (ch.attempts >= CHALLENGE_MAX_ATTEMPTS)
        this.challenges.delete(this.key(input.challengeId));
      const access = await this.access(ch.userId);
      await this.auditUser(access.currentOrgIds, ch.userId, null, 'auth.mfa.failure', ipHash, {
        stage: ch.stage,
      });
      throw new HubError('UNAUTHENTICATED', 401, AUTH_MESSAGES.badCode);
    }
    this.challenges.delete(this.key(input.challengeId));
    const fresh = (await this.findByUser(ch.userId)) ?? cred;
    return this.nextStep(keys, fresh, ch.mfaRequired, true, ipHash);
  }

  async forcedPasswordChange(input: ForcedPasswordChangeRequest, ip: string): Promise<Issued> {
    const keys = this.enabled();
    const ipHash = this.ipHash(ip);
    this.limit(ipHash);
    const ch = this.peek(input.challengeId, ['PASSWORD_CHANGE']);
    const cred = await this.findByUser(ch.userId);
    if (!cred) throw expired();
    await this.setNewPassword(cred, input.newPassword);
    await this.revokeAll(ch.userId, 'PASSWORD_CHANGE');
    this.challenges.delete(this.key(input.challengeId));
    const orgIds = (await this.access(ch.userId)).currentOrgIds;
    await this.auditUser(orgIds, ch.userId, ch.userId, 'auth.password.change', ipHash, {
      forced: true,
    });
    return this.issue(keys, ch.userId, ch.mfaDone, ipHash);
  }

  // ---- signed-in actions ----------------------------------------------------------------------

  async changePassword(
    hub: HubRequestContext,
    input: ChangePasswordRequest,
    ip: string,
  ): Promise<WithRefresh<{ changed: true }>> {
    this.enabled();
    this.limit(this.ipHash(ip));
    const cred = await this.findByUser(hub.user.id);
    if (!cred) throw notFound();
    const now = Date.now();
    if (cred.locked_until && cred.locked_until.getTime() > now)
      throw new HubError('RATE_LIMITED', 429, AUTH_MESSAGES.locked);
    if (!(await verifyPassword(input.currentPassword, cred.password_hash))) {
      const lockedNow = await this.recordFailure(cred.user_id, now);
      if (lockedNow) throw new HubError('RATE_LIMITED', 429, AUTH_MESSAGES.locked);
      throw new HubError('VALIDATION_FAILED', 400, AUTH_MESSAGES.wrongCurrentPassword);
    }
    await this.setNewPassword(cred, input.newPassword);
    // Every other session ends; this one continues with a fresh refresh family.
    const sessionsEnded = await this.revokeAll(hub.user.id, 'PASSWORD_CHANGE');
    const refresh = await this.newFamily(hub.user.id, hub.mfaSatisfied);
    const access = await this.access(hub.user.id);
    const orgIds = hub.orgId ? [hub.orgId] : access.currentOrgIds;
    await this.auditUser(orgIds, hub.user.id, hub.user.id, 'auth.password.change', hub.ipHash, {
      forced: false,
      sessionsEnded,
    });
    return { body: { changed: true }, refresh };
  }

  /**
   * New access token from the refresh cookie. The presented token is used up and replaced by a new
   * one in the same family. A token that was already used means it was copied: the whole family
   * ends and the event is audited. Access, and MFA for the person's current roles, are checked
   * again on every refresh, so ended access or a new privileged role stops the session.
   */
  async refresh(raw: string | null, ip: string): Promise<Issued> {
    const keys = this.enabled();
    const ipHash = this.ipHash(ip);
    if (!raw) throw sessionEnded();
    type Row = {
      id: string;
      user_id: string;
      family_id: string;
      mfa: boolean;
      used: boolean;
      revoked: boolean;
      live: boolean;
    };
    const [row] = await this.withCredentials(
      null,
      (tx) =>
        tx.$queryRaw<Row[]>`
        SELECT id, user_id, family_id, mfa,
               used_at IS NOT NULL AS used, revoked_at IS NOT NULL AS revoked,
               (expires_at > now() AND family_expires_at > now()) AS live
          FROM local_refresh_token WHERE token_hash = ${this.key(raw)}`,
    );
    if (!row || row.revoked) throw sessionEnded();
    if (row.used) {
      await this.reuseDetected(row.user_id, row.family_id, ipHash);
      throw sessionEnded();
    }
    if (!row.live) {
      await this.revokeFamily(row.family_id, 'EXPIRED');
      throw sessionEnded();
    }
    const access = await this.access(row.user_id);
    if (!access.hasAccess) {
      await this.revokeAll(row.user_id, 'ACCESS_ENDED');
      throw ended();
    }
    if (mfaRequiredFor(access.roleKeys) && !row.mfa) {
      await this.revokeFamily(row.family_id, 'MFA_REQUIRED');
      throw sessionEnded();
    }

    const value = randomBytes(32).toString('base64url');
    const next = await this.withCredentials(row.user_id, async (tx) => {
      // Conditional: of two requests racing with the same token only one rotates it.
      const n = await tx.$executeRaw`UPDATE local_refresh_token SET used_at = now()
        WHERE id = ${row.id}::uuid AND used_at IS NULL AND revoked_at IS NULL`;
      if (n !== 1) return null;
      const [created] = await tx.$queryRaw<{ id: string; max_age: number }[]>`
        INSERT INTO local_refresh_token
               (token_hash, user_id, family_id, mfa, expires_at, family_expires_at)
        SELECT ${this.key(value)}, user_id, family_id, mfa,
               least(now() + ${LOCAL_REFRESH_IDLE_SECONDS}::int * interval '1 second',
                     family_expires_at),
               family_expires_at
          FROM local_refresh_token WHERE id = ${row.id}::uuid
        RETURNING id, floor(extract(epoch FROM expires_at - now()))::int AS max_age`;
      await tx.$executeRaw`UPDATE local_refresh_token SET replaced_by = ${created!.id}::uuid
        WHERE id = ${row.id}::uuid`;
      return created!;
    });
    if (!next) {
      await this.reuseDetected(row.user_id, row.family_id, ipHash);
      throw sessionEnded();
    }
    const amr = row.mfa ? ['pwd', 'otp'] : ['pwd'];
    const body = await signLocalToken(
      keys,
      this.config.OIDC_AUDIENCE,
      { id: row.user_id, email: access.email },
      amr,
    );
    return { body, refresh: { value, maxAgeSeconds: next.max_age } };
  }

  /**
   * Signs out: ends the refresh family in the cookie (if any) and records it. Works with an expired
   * access token, so it is public; a still-valid local bearer token identifies the person when there
   * is no cookie. Always answers the same.
   */
  async logout(
    raw: string | null,
    bearer: string | null,
    ip: string,
  ): Promise<{ signedOut: true }> {
    this.enabled();
    const ipHash = this.ipHash(ip);
    let userId: string | null = null;
    let familyEnded = false;
    if (raw) {
      const [row] = await this.withCredentials(
        null,
        (tx) =>
          tx.$queryRaw<{ user_id: string; family_id: string }[]>`
          SELECT user_id, family_id FROM local_refresh_token WHERE token_hash = ${this.key(raw)}`,
      );
      if (row) {
        userId = row.user_id;
        familyEnded = (await this.revokeFamily(row.family_id, 'LOGOUT')) > 0;
      }
    }
    if (!userId && bearer) {
      try {
        userId = (await this.tokens.verify(bearer)).localUserId;
      } catch {
        // Expired or not ours: nothing to record.
      }
    }
    if (userId) {
      const orgIds = (await this.access(userId)).currentOrgIds;
      await this.auditUser(orgIds, userId, userId, 'auth.logout', ipHash, {
        sessionEnded: familyEnded,
      });
    }
    return { signedOut: true };
  }

  /**
   * Administrator MFA reset: removes the member's authenticator so they enrol a new one at their
   * next sign-in, and ends their refresh sessions (access tokens already issued run out within 15
   * minutes). Current members of the administrator's organisation only (else 404); never oneself.
   */
  async mfaReset(
    hub: HubRequestContext,
    userId: string,
    input: MfaResetRequest,
  ): Promise<MfaResetResponse> {
    this.enabled();
    if (userId === hub.user.id)
      throw new HubError(
        'FORBIDDEN',
        403,
        'You cannot reset your own MFA. Ask another administrator.',
      );
    await this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = await dbNow(tx);
      const member = await tx.membership.findFirst({
        where: {
          userId,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: { id: true },
      });
      if (!member) throw notFound();
      await tx.$executeRaw`SELECT set_config('app.local_auth', 'on', true)`;
      const [cred] = await tx.$queryRaw<{ totp_enabled: boolean }[]>`
        SELECT totp_enabled FROM local_credential WHERE user_id = ${userId}::uuid FOR UPDATE`;
      if (cred)
        await tx.$executeRaw`UPDATE local_credential
            SET totp_secret_encrypted = NULL, totp_enabled = false, totp_last_step = NULL,
                updated_by = ${hub.user.id}::uuid
          WHERE user_id = ${userId}::uuid`;
      const sessions = await tx.$executeRaw`UPDATE local_refresh_token
          SET revoked_at = now(), revoked_reason = 'MFA_RESET'
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
      await audit(this.db, tx, hub, {
        action: 'auth.mfa.reset',
        entity: 'app_user',
        entityId: userId,
        summary: { reason: input.reason, hadMfa: !!cred?.totp_enabled, sessionsEnded: sessions },
      });
    });
    return { mfaReset: true };
  }

  /**
   * Administrator reset: a one-time temporary password, returned once, that must be changed at the
   * next sign-in. Only for a current member of the administrator's organisation; never one's own.
   * MFA enrolment is kept (a reset never removes the second factor; see mfaReset). Their refresh
   * sessions end.
   */
  async resetPassword(hub: HubRequestContext, userId: string): Promise<PasswordResetResponse> {
    this.enabled();
    if (userId === hub.user.id)
      throw new HubError(
        'FORBIDDEN',
        403,
        'You cannot reset your own password. Use Change password instead.',
      );
    const temp = temporaryPassword();
    const hash = await hashPassword(temp);
    await this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = await dbNow(tx);
      const member = await tx.membership.findFirst({
        where: {
          userId,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        include: { user: { select: { email: true } } },
      });
      if (!member) throw notFound();
      await tx.$executeRaw`SELECT set_config('app.local_auth', 'on', true)`;
      await tx.$executeRaw`
        INSERT INTO local_credential (user_id, username, password_hash, must_change_password,
                                      created_by, updated_by)
        VALUES (${userId}::uuid, ${member.user.email}, ${hash}, true,
                ${hub.user.id}::uuid, ${hub.user.id}::uuid)
        ON CONFLICT (user_id) DO UPDATE
          SET password_hash = EXCLUDED.password_hash, must_change_password = true,
              password_changed_at = now(), failed_attempts = 0, locked_until = NULL,
              updated_by = EXCLUDED.updated_by`;
      const sessions = await tx.$executeRaw`UPDATE local_refresh_token
          SET revoked_at = now(), revoked_reason = 'PASSWORD_RESET'
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
      await audit(this.db, tx, hub, {
        action: 'auth.password.reset',
        entity: 'app_user',
        entityId: userId,
        summary: { mustChangePassword: true, sessionsEnded: sessions },
      });
    });
    return { temporaryPassword: temp, mustChangePassword: true };
  }

  // ---- steps and tokens -----------------------------------------------------------------------

  private async nextStep(
    keys: LocalSigningKeys,
    cred: CredentialRow,
    mfaRequired: boolean,
    mfaDone: boolean,
    ipHash: string,
  ): Promise<WithRefresh<LoginResponse>> {
    const base = { userId: cred.user_id, mfaRequired, mfaDone };
    if (mfaRequired && !mfaDone) {
      if (cred.totp_enabled)
        return {
          body: { mfaRequired: true, challengeId: this.challenge({ ...base, stage: 'MFA' }) },
        };
      return {
        body: {
          mfaSetupRequired: true,
          challengeId: this.challenge({ ...base, stage: 'MFA_SETUP' }),
        },
      };
    }
    if (cred.must_change_password)
      return {
        body: {
          passwordChangeRequired: true,
          challengeId: this.challenge({ ...base, stage: 'PASSWORD_CHANGE' }),
        },
      };
    return this.issue(keys, cred.user_id, mfaDone, ipHash);
  }

  /** Completes a password sign-in: an access token and a new refresh family. */
  private async issue(
    keys: LocalSigningKeys,
    userId: string,
    mfaDone: boolean,
    ipHash: string,
  ): Promise<Issued> {
    // Re-checked at the last step: access may have ended while the user was entering a code.
    const access = await this.access(userId);
    if (!access.hasAccess) throw ended();
    await this.db.withIdentity(
      userId,
      (tx) =>
        tx.$executeRaw`UPDATE app_user
          SET last_login_at = now(),
              status = CASE WHEN status = 'INVITED' THEN 'ACTIVE'::user_status ELSE status END
        WHERE id = ${userId}::uuid`,
    );
    if (access.status === 'INVITED') this.cache.evictUser(userId);
    const amr = mfaDone ? ['pwd', 'otp'] : ['pwd'];
    await this.auditUser(access.currentOrgIds, userId, userId, 'auth.login.success', ipHash, {
      amr: amr.join('+'),
    });
    const user = { id: userId, email: access.email };
    const body = await signLocalToken(keys, this.config.OIDC_AUDIENCE, user, amr);
    return { body, refresh: await this.newFamily(userId, mfaDone) };
  }

  // ---- refresh families -----------------------------------------------------------------------

  private async newFamily(userId: string, mfa: boolean): Promise<RefreshGrant> {
    const value = randomBytes(32).toString('base64url');
    const [row] = await this.withCredentials(
      userId,
      (tx) =>
        tx.$queryRaw<{ max_age: number }[]>`
        INSERT INTO local_refresh_token
               (token_hash, user_id, family_id, mfa, expires_at, family_expires_at)
        VALUES (${this.key(value)}, ${userId}::uuid, gen_random_uuid(), ${mfa},
                now() + ${LOCAL_REFRESH_IDLE_SECONDS}::int * interval '1 second',
                now() + ${LOCAL_REFRESH_ABSOLUTE_SECONDS}::int * interval '1 second')
        RETURNING floor(extract(epoch FROM expires_at - now()))::int AS max_age`,
    );
    return { value, maxAgeSeconds: row!.max_age };
  }

  private revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
    return this.withCredentials(
      null,
      (tx) =>
        tx.$executeRaw`UPDATE local_refresh_token SET revoked_at = now(), revoked_reason = ${reason}
        WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL`,
    );
  }

  private revokeAll(userId: string, reason: RevokeReason): Promise<number> {
    return this.withCredentials(
      userId,
      (tx) =>
        tx.$executeRaw`UPDATE local_refresh_token SET revoked_at = now(), revoked_reason = ${reason}
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`,
    );
  }

  /** A used refresh token came back: someone holds a copy. End the family and record it. */
  private async reuseDetected(userId: string, familyId: string, ipHash: string): Promise<void> {
    const revoked = await this.revokeFamily(familyId, 'REUSE');
    const access = await this.access(userId);
    const orgIds = access.currentOrgIds.length ? access.currentOrgIds : access.allOrgIds;
    this.log.warn({ event: 'auth.refresh.reuse', userId, ipHash }, 'refresh token reused');
    await this.auditUser(orgIds, userId, null, 'auth.refresh.reuse', ipHash, {
      familyId,
      sessionsEnded: revoked,
    });
  }

  private challenge(c: Omit<Challenge, 'expiresAt' | 'attempts'>): string {
    const now = Date.now();
    for (const [k, v] of this.challenges) if (v.expiresAt <= now) this.challenges.delete(k);
    if (this.challenges.size > 10_000) this.challenges.clear();
    const id = randomBytes(32).toString('base64url');
    this.challenges.set(this.key(id), { ...c, expiresAt: now + CHALLENGE_TTL_MS, attempts: 0 });
    return id;
  }

  private peek(id: string, stages: Stage[]): Challenge {
    const ch = this.challenges.get(this.key(id));
    if (!ch || ch.expiresAt <= Date.now() || !stages.includes(ch.stage)) {
      if (ch && ch.expiresAt <= Date.now()) this.challenges.delete(this.key(id));
      throw expired();
    }
    return ch;
  }

  private key(id: string): string {
    return createHash('sha256').update(id).digest('hex');
  }

  // ---- credentials and access -----------------------------------------------------------------

  private async setNewPassword(cred: CredentialRow, newPassword: string): Promise<void> {
    const problem = passwordProblem(cred.username, newPassword);
    if (problem) throw new HubError('VALIDATION_FAILED', 400, problem);
    if (await verifyPassword(newPassword, cred.password_hash))
      throw new HubError('VALIDATION_FAILED', 400, 'Choose a password you are not already using.');
    const hash = await hashPassword(newPassword);
    await this.withCredentials(
      cred.user_id,
      (tx) =>
        tx.$executeRaw`UPDATE local_credential
          SET password_hash = ${hash}, password_changed_at = now(), must_change_password = false,
              failed_attempts = 0, locked_until = NULL, updated_by = ${cred.user_id}::uuid
        WHERE user_id = ${cred.user_id}::uuid`,
    );
  }

  /** Counts a wrong password under a row lock. Returns true when this failure starts a lockout. */
  private recordFailure(userId: string, now: number): Promise<boolean> {
    return this.withCredentials(userId, async (tx) => {
      type Row = { failed_attempts: number; locked_until: Date | null };
      const [row] = await tx.$queryRaw<Row[]>`
        SELECT failed_attempts, locked_until FROM local_credential
         WHERE user_id = ${userId}::uuid FOR UPDATE`;
      if (!row) return false;
      if (row.locked_until && row.locked_until.getTime() > now) return false;
      const next = applyFailure(
        { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until?.getTime() ?? null },
        now,
      );
      const until = next.lockedUntil === null ? null : new Date(next.lockedUntil);
      await tx.$executeRaw`UPDATE local_credential
          SET failed_attempts = ${next.failedAttempts}, locked_until = ${until}::timestamptz
        WHERE user_id = ${userId}::uuid`;
      return next.lockedNow;
    });
  }

  /** Opens the credential table for this transaction only (see migration 0038). */
  private withCredentials<T>(userId: string | null, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.withIdentity(userId ?? SYSTEM_USER_ID, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.local_auth', 'on', true)`;
      return fn(tx);
    });
  }

  private async findByUsername(username: string): Promise<CredentialRow | null> {
    const rows = await this.withCredentials(
      null,
      (tx) =>
        tx.$queryRaw<CredentialRow[]>`
        SELECT user_id, username, password_hash, failed_attempts, locked_until,
               must_change_password, totp_secret_encrypted, totp_enabled, totp_last_step
          FROM local_credential WHERE username = ${username}`,
    );
    return rows[0] ?? null;
  }

  private async findByUser(userId: string): Promise<CredentialRow | null> {
    const rows = await this.withCredentials(
      userId,
      (tx) =>
        tx.$queryRaw<CredentialRow[]>`
        SELECT user_id, username, password_hash, failed_attempts, locked_until,
               must_change_password, totp_secret_encrypted, totp_enabled, totp_last_step
          FROM local_credential WHERE user_id = ${userId}::uuid`,
    );
    return rows[0] ?? null;
  }

  /** Same rules as HubGuard: ACTIVE (or first sign-in of an INVITED user) and current access. */
  private access(userId: string): Promise<Access> {
    return this.db.withIdentity(userId, async (tx) => {
      const now = await dbNow(tx);
      const [u] = await tx.$queryRaw<
        { email: string; status: string; is_platform_support: boolean }[]
      >`SELECT email, status, is_platform_support FROM app_user WHERE id = ${userId}::uuid`;
      const all = await tx.membership.findMany({
        where: { userId },
        include: { role: { select: { key: true } } },
      });
      const current = all.filter((m) => m.validFrom <= now && (!m.validTo || m.validTo > now));
      const grants = u?.is_platform_support
        ? await tx.supportAccessGrant.count({
            where: { supportUserId: userId, startsAt: { lte: now }, endsAt: { gt: now } },
          })
        : 0;
      const roleKeys = [...new Set(current.map((m) => m.role.key))];
      if (u?.is_platform_support) roleKeys.push('PLATFORM_SUPPORT');
      const statusOk = u?.status === 'ACTIVE' || u?.status === 'INVITED';
      return {
        email: u?.email ?? '',
        status: u?.status ?? 'UNKNOWN',
        roleKeys,
        currentOrgIds: [...new Set(current.map((m) => m.organisationId))],
        allOrgIds: [...new Set(all.map((m) => m.organisationId))],
        hasAccess: !!u && statusOk && (current.length > 0 || grants > 0),
      };
    });
  }

  // ---- audit (sign-in happens before an organisation is chosen) -------------------------------

  /**
   * The audit log is per organisation, and sign-in happens before one is chosen: the event is
   * written to every organisation the person currently belongs to (all past ones for a refused,
   * ended account). Unknown usernames have no organisation and go to the application log only.
   */
  private async auditUser(
    orgIds: readonly string[],
    userId: string,
    actorUserId: string | null,
    action: string,
    ipHash: string,
    summary: Record<string, string | number | boolean> = {},
  ): Promise<void> {
    if (orgIds.length === 0) {
      this.log.info({ event: action, userId, ipHash }, 'local sign-in event (no organisation)');
      return;
    }
    for (const orgId of orgIds)
      await this.db.withTenant({ orgId, userId }, (tx) =>
        this.db.appendAudit(tx, {
          orgId,
          actorUserId,
          action,
          entity: 'app_user',
          entityId: userId,
          afterSummary: { ...summary, method: 'local' },
          ipHash,
        }),
      );
  }

  private async auditFailure(
    userId: string,
    reason: string,
    usernameHash: string,
    ipHash: string,
    lockedNow = false,
  ): Promise<void> {
    const access = await this.access(userId);
    const orgIds = access.currentOrgIds.length ? access.currentOrgIds : access.allOrgIds;
    await this.auditUser(orgIds, userId, null, 'auth.login.failure', ipHash, {
      reason,
      usernameHash,
      lockedNow,
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private enabled(): LocalSigningKeys {
    if (this.config.AUTH_MODE !== 'local' || !this.keys) throw notFound();
    return this.keys;
  }

  private limit(ipHash: string): void {
    if (!this.ipLimiter.take(ipHash)) throw new HubError('RATE_LIMITED', 429, AUTH_MESSAGES.locked);
  }

  private ipHash(ip: string): string {
    return createHmac('sha256', this.config.IP_HASH_SECRET).update(ip).digest('hex');
  }

  private usernameHash(username: string): string {
    return createHmac('sha256', this.config.IP_HASH_SECRET)
      .update(`username:${username}`)
      .digest('hex')
      .slice(0, 32);
  }

  private fieldKey(): Buffer {
    return fieldKey(this.config.FIELD_ENCRYPTION_KEY);
  }
}
