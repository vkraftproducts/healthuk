import { createHash } from 'node:crypto';
import pg from 'pg';
import { decodeJwt } from 'jose';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AUTH_MESSAGES } from '@hub/contracts';
import { DEFAULT_SEED_LOCAL_PASSWORD } from '@hub/db/admin';
import { hashPassword } from '../src/auth/password.js';
import { totpCode, totpCodeForStep, totpStep } from '../src/auth/totp.js';
import { SEED_IDS, SEED_USERS, makeApp, sign } from './harness.js';

/**
 * Local username + password sign-in (AUTH_MODE=local, ADR 0006). Every request carries its own
 * X-Forwarded-For address (the app trusts the proxy header) so the per-IP limit only bites in the
 * test that is about it.
 */
const urls = inject('urls');
const PASSWORD = process.env.SEED_LOCAL_PASSWORD || DEFAULT_SEED_LOCAL_PASSWORD;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let app: NestFastifyApplication;
let devApp: NestFastifyApplication;
let closeAll: () => Promise<void>;
/** The organisation administrator's MFA token, set when the administrator first enrols below. */
let orgAdminToken = '';

let ipSeq = 0;
const nextIp = () => {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
};

interface CallOpts {
  body?: unknown;
  ip?: string;
  token?: string;
  org?: string;
  on?: NestFastifyApplication;
  /** The refresh token, sent as the hub_refresh cookie. */
  refresh?: string;
  origin?: string;
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: CallOpts = {},
): Promise<{ status: number; body: J; setCookie: string | null; refresh: string | null }> {
  const res = await (o.on ?? app).inject({
    method,
    url,
    headers: {
      'x-forwarded-for': o.ip ?? nextIp(),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.org ? { 'x-org-id': o.org } : {}),
      ...(o.refresh ? { cookie: `other=1; hub_refresh=${o.refresh}` } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
    },
    payload: method === 'POST' ? JSON.stringify(o.body ?? {}) : undefined,
  });
  const raw = res.headers['set-cookie'];
  const setCookie = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  const refresh = setCookie ? (/^hub_refresh=([^;]*)/.exec(setCookie)?.[1] ?? null) : null;
  return {
    status: res.statusCode,
    body: res.body ? (JSON.parse(res.body) as J) : {},
    setCookie,
    refresh: refresh || null,
  };
}

const refresh = (cookie: string | null, o: CallOpts = {}) =>
  call('POST', '/api/v1/auth/refresh', { ...o, ...(cookie ? { refresh: cookie } : {}) });

const login = (username: string, password: string, ip?: string) =>
  call('POST', '/api/v1/auth/login', { body: { username, password }, ip });

const resetUrl = (id: string) => `/api/v1/admin/users/${id}/reset-password`;

/** A 6-digit code that matches none of the codes valid around now. */
function wrongCode(secret: string): string {
  const step = totpStep(Date.now());
  const valid = new Set([-1, 0, 1, 2].map((d) => totpCodeForStep(secret, step + d)));
  for (let n = 0; ; n += 1) {
    const c = String(n).padStart(6, '0');
    if (!valid.has(c)) return c;
  }
}

/** First sign-in of a privileged user: enrol TOTP; returns the secret, used code and token. */
async function enrolAndSignIn(username: string, password = PASSWORD) {
  const first = await login(username, password);
  expect(first.status).toBe(200);
  expect(first.body.mfaSetupRequired).toBe(true);
  const setup = await call('POST', '/api/v1/auth/mfa/setup', {
    body: { challengeId: first.body.challengeId },
  });
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const code = totpCode(secret, Date.now());
  const verified = await call('POST', '/api/v1/auth/mfa/verify', {
    body: { challengeId: first.body.challengeId, code },
  });
  expect(verified.status).toBe(200);
  return {
    secret,
    code,
    token: verified.body.access_token as string,
    refresh: verified.refresh,
    setup: setup.body,
  };
}

/** Audit actions recorded in the example organisation for one person. */
async function auditFor(userId: string, like = 'auth.%') {
  return admin(async (c) => {
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    const q = await c.query(
      `SELECT action, after_summary::text AS s FROM audit_log
        WHERE entity_id = $1 AND action LIKE $2 ORDER BY occurred_at`,
      [userId, like],
    );
    return q.rows as { action: string; s: string }[];
  });
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urls.admin });
  await c.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/** A synthetic CREW member of the example organisation, created for this file only. */
async function makeUser(
  id: string,
  email: string,
  o: { status?: 'ACTIVE' | 'INVITED'; password?: string; role?: string } = {},
) {
  await admin(async (c) => {
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    await c.query(`SELECT set_config('app.local_auth', 'on', true)`);
    await c.query(
      `INSERT INTO app_user (id, email, display_name, status)
       VALUES ($1, $2, 'Synthetic person', $3)`,
      [id, email, o.status ?? 'ACTIVE'],
    );
    await c.query(
      `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
       SELECT $1, $2, id, now() - interval '1 day' FROM role
        WHERE organisation_id IS NULL AND key = $3`,
      [ORG, id, o.role ?? 'CREW'],
    );
    if (o.password)
      await c.query(
        `INSERT INTO local_credential (user_id, username, password_hash) VALUES ($1, $2, $3)`,
        [id, email, await hashPassword(o.password)],
      );
  });
}

beforeAll(async () => {
  const made = await makeApp(urls, [], { AUTH_MODE: 'local' });
  const dev = await makeApp(urls);
  app = made.app;
  devApp = dev.app;
  closeAll = async () => {
    await app.close();
    await devApp.close();
    await made.db.close();
    await dev.db.close();
  };
});
afterAll(async () => closeAll());

describe('local sign-in [ADR 0006]', () => {
  it('signs crew in with the right password and no MFA; the token works on /me', async () => {
    const r = await login('crew@example.test', PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.token_type).toBe('Bearer');
    expect(r.body.expires_in).toBe(900);
    const claims = decodeJwt(r.body.access_token as string);
    expect(claims.iss).toBe('healthcare-hub-local');
    expect(claims.sub).toBe(`local|${SEED_USERS.crew!.id}`);
    expect(claims.amr).toEqual(['pwd']);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(900);

    const me = await call('GET', '/api/v1/me', { token: r.body.access_token, org: ORG });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('crew@example.test');
    expect(me.body.mfa).toEqual({ required: false, satisfied: false });
  });

  it('accepts the username in any letter case and with spaces around it', async () => {
    const r = await login('  CREW@Example.Test ', PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
  });

  it('gives the same generic error for a wrong password and an unknown user', async () => {
    const wrong = await login('crew@example.test', 'Not-The-Password-123');
    const unknown = await login('nobody.here@example.test', PASSWORD);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.detail).toBe(AUTH_MESSAGES.invalid);
    const shape = (b: J) => ({ code: b.code, title: b.title, detail: b.detail, type: b.type });
    expect(shape(unknown.body)).toEqual(shape(wrong.body));
    expect(JSON.stringify(wrong.body)).not.toContain('Not-The-Password-123');
  });

  it('refuses OIDC-issuer tokens in local mode (no way around the password)', async () => {
    const token = await sign({ sub: 'dev|crew' });
    const me = await call('GET', '/api/v1/me', { token, org: ORG });
    expect(me.status).toBe(401);
  });

  it('locks after 5 consecutive failures, even against the right password', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const r = await login('crew2@example.test', `Wrong-password-${i}-xx`);
      expect(r.status).toBe(401);
      expect(r.body.detail).toBe(AUTH_MESSAGES.invalid);
    }
    const fifth = await login('crew2@example.test', 'Wrong-password-5-xx');
    expect(fifth.status).toBe(401);
    expect(fifth.body.detail).toBe(AUTH_MESSAGES.locked);
    const right = await login('crew2@example.test', PASSWORD);
    expect(right.status).toBe(401);
    expect(right.body.detail).toBe(AUTH_MESSAGES.locked);
    expect(right.body.access_token).toBeUndefined();
  });

  it('shows the same lockout for a username that does not exist', async () => {
    const replies: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      const r = await login('ghost.person@example.test', `Guess-number-${i}-xx`);
      replies.push(r.body.detail as string);
    }
    expect(replies.slice(0, 4)).toEqual(Array(4).fill(AUTH_MESSAGES.invalid));
    expect(replies.slice(4)).toEqual([AUTH_MESSAGES.locked, AUTH_MESSAGES.locked]);
  });

  it('rate limits sign-in attempts from one address (20 per 15 minutes)', async () => {
    const ip = '10.99.0.1';
    for (let i = 0; i < 20; i += 1) {
      const r = await login(`rate${i}@example.test`, 'Whatever-password-1', ip);
      expect(r.status).toBe(401);
    }
    const blocked = await login('crew@example.test', PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.access_token).toBeUndefined();
    // MFA verification shares the same limit.
    const mfa = await call('POST', '/api/v1/auth/mfa/verify', {
      ip,
      body: { challengeId: 'x'.repeat(43), code: '123456' },
    });
    expect(mfa.status).toBe(429);
  });

  it('makes a manager enrol TOTP, then challenges for a code [SEC-01]', async () => {
    const enrolled = await enrolAndSignIn('manager@example.test');
    const { secret, token, setup } = enrolled;
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/Healthcare%20Hub:manager%40example\.test/);
    expect(setup.otpauthUri).toContain(`secret=${secret}`);
    expect(decodeJwt(token).amr).toEqual(['pwd', 'otp']);
    const me = await call('GET', '/api/v1/me', { token, org: ORG });
    expect(me.body.mfa).toEqual({ required: true, satisfied: true });

    // Next sign-in: a challenge, not a token.
    const second = await login('manager@example.test', PASSWORD);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ mfaRequired: true, challengeId: expect.any(String) });
    const challengeId = second.body.challengeId as string;

    const bad = await call('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeId, code: wrongCode(secret) },
    });
    expect(bad.status).toBe(401);
    expect(bad.body.detail).toBe(AUTH_MESSAGES.badCode);
    // The code already used at enrolment is never accepted again.
    const reused = await call('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeId, code: enrolled.code },
    });
    expect(reused.status).toBe(401);

    const ok = await call('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeId, code: totpCode(secret, Date.now() + 30_000) },
    });
    expect(ok.status).toBe(200);
    expect(decodeJwt(ok.body.access_token as string).amr).toEqual(['pwd', 'otp']);
    // The challenge is single use.
    const again = await call('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeId, code: totpCode(secret, Date.now() + 30_000) },
    });
    expect(again.status).toBe(401);
    expect(again.body.detail).toBe(AUTH_MESSAGES.challengeExpired);
  });

  it('says access has ended only after the right password', async () => {
    const id = '01900000-0000-7000-8000-000000000881';
    const email = 'local.leaver@example.test';
    await makeUser(id, email, { password: 'Synthetic-Leaver-Pass-1' });
    expect((await login(email, 'Synthetic-Leaver-Pass-1')).status).toBe(200);
    await admin(async (c) => {
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      await c.query(`UPDATE membership SET valid_to = now() WHERE user_id = $1`, [id]);
    });
    const wrong = await login(email, 'Not-the-leaver-pass-1');
    expect(wrong.body.detail).toBe(AUTH_MESSAGES.invalid);
    const right = await login(email, 'Synthetic-Leaver-Pass-1');
    expect(right.status).toBe(401);
    expect(right.body.code).toBe('USER_INACTIVE');
    expect(right.body.detail).toBe(AUTH_MESSAGES.ended);
  });

  describe('administrator password reset', () => {
    const starterId = '01900000-0000-7000-8000-000000000882';
    const starter = 'local.starter@example.test';
    const newPass = 'Synthetic-Starter-Pass-77';
    let adminToken = '';

    beforeAll(async () => {
      await makeUser(starterId, starter, { status: 'INVITED' });
      adminToken = (await enrolAndSignIn('orgadmin@example.test')).token;
      orgAdminToken = adminToken;
    });

    it('sets a one-time temporary password that must be changed at sign-in', async () => {
      const reset = await call('POST', resetUrl(starterId), { token: adminToken, org: ORG });
      expect(reset.status).toBe(200);
      expect(reset.body.mustChangePassword).toBe(true);
      const temp = reset.body.temporaryPassword as string;
      expect(temp.length).toBeGreaterThanOrEqual(20);

      const first = await login(starter, temp);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        passwordChangeRequired: true,
        challengeId: expect.any(String),
      });
      const challengeId = first.body.challengeId as string;
      const change = (newPassword: string) =>
        call('POST', '/api/v1/auth/forced-password-change', {
          body: { challengeId, newPassword },
        });

      const short = await change('short');
      expect(short.status).toBe(400);
      expect(short.body.detail).toBe('Use at least 12 characters.');
      expect((await change(starter)).status).toBe(400);
      expect((await change('Password1234')).status).toBe(400);

      const changed = await change(newPass);
      expect(changed.status).toBe(200);
      const me = await call('GET', '/api/v1/me', { token: changed.body.access_token, org: ORG });
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe(starter);

      expect((await login(starter, temp)).body.detail).toBe(AUTH_MESSAGES.invalid);
      expect((await login(starter, newPass)).body.access_token).toBeTruthy();

      // Audited in the organisation, with no password in the record.
      const rows = await admin(async (c) => {
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        const q = await c.query(
          `SELECT action, after_summary::text AS s FROM audit_log
            WHERE entity_id = $1 AND action LIKE 'auth.%'`,
          [starterId],
        );
        return q.rows as { action: string; s: string }[];
      });
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'auth.password.reset',
          'auth.password.change',
          'auth.login.success',
        ]),
      );
      for (const r of rows) {
        expect(r.s).not.toContain(temp);
        expect(r.s).not.toContain(newPass);
      }
    });

    it('lets a signed-in person change their own password', async () => {
      const token = (await login(starter, newPass)).body.access_token as string;
      const wrong = await call('POST', '/api/v1/auth/change-password', {
        token,
        body: { currentPassword: 'Not-my-password-9', newPassword: 'Synthetic-Starter-Pass-88' },
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.detail).toBe(AUTH_MESSAGES.wrongCurrentPassword);
      const ok = await call('POST', '/api/v1/auth/change-password', {
        token,
        body: { currentPassword: newPass, newPassword: 'Synthetic-Starter-Pass-88' },
      });
      expect(ok.status).toBe(200);
      expect((await login(starter, 'Synthetic-Starter-Pass-88')).status).toBe(200);
      const out = await call('POST', '/api/v1/auth/logout', { token, org: ORG });
      expect(out.body).toEqual({ signedOut: true });
    });

    it('refuses an administrator resetting their own password', async () => {
      const r = await call('POST', resetUrl(SEED_USERS.orgAdmin!.id), {
        token: adminToken,
        org: ORG,
      });
      expect(r.status).toBe(403);
      expect(r.body.temporaryPassword).toBeUndefined();
    });

    it('answers 404 for a person who is not a member of the organisation', async () => {
      const r = await call('POST', resetUrl(SEED_USERS.otherCrew!.id), {
        token: adminToken,
        org: ORG,
      });
      expect(r.status).toBe(404);
    });

    it('refuses the reset to someone without admin.users.manage', async () => {
      const crew = (await login('crew@example.test', PASSWORD)).body.access_token as string;
      const r = await call('POST', resetUrl(starterId), { token: crew, org: ORG });
      expect(r.status).toBe(403);
    });
  });

  describe('refresh tokens', () => {
    const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

    it('sets an HttpOnly, SameSite=Strict cookie for /api/v1/auth and stores only its hash', async () => {
      const r = await login('crew@example.test', PASSWORD);
      expect(r.status).toBe(200);
      expect(r.setCookie).toMatch(/^hub_refresh=[A-Za-z0-9_-]{43}; Max-Age=(17\d\d|1800); /);
      expect(r.setCookie).toContain('Path=/api/v1/auth');
      expect(r.setCookie).toContain('HttpOnly');
      expect(r.setCookie).toContain('SameSite=Strict');
      expect(r.setCookie).not.toContain('Secure'); // plain-http test configuration
      const value = r.refresh!;
      expect(JSON.stringify(r.body)).not.toContain(value);
      const stored = await admin(async (c) => {
        await c.query(`SELECT set_config('app.local_auth', 'on', true)`);
        const q = await c.query(
          `SELECT token_hash = $2 AS hashed, mfa,
                  extract(epoch FROM family_expires_at - created_at)::int AS absolute
             FROM local_refresh_token WHERE token_hash IN ($1, $2)`,
          [value, sha256(value)],
        );
        return q.rows as { hashed: boolean; mfa: boolean; absolute: number }[];
      });
      expect(stored).toEqual([{ hashed: true, mfa: false, absolute: 12 * 3600 }]);
    });

    it('rotates the token on every refresh and the new access token works', async () => {
      const first = await login('crew@example.test', PASSWORD);
      const r1 = await refresh(first.refresh);
      expect(r1.status).toBe(200);
      expect(r1.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
      expect(decodeJwt(r1.body.access_token as string).amr).toEqual(['pwd']);
      expect(r1.refresh).toBeTruthy();
      expect(r1.refresh).not.toBe(first.refresh);
      const me = await call('GET', '/api/v1/me', { token: r1.body.access_token, org: ORG });
      expect(me.status).toBe(200);
      const r2 = await refresh(r1.refresh);
      expect(r2.status).toBe(200);
      expect(r2.refresh).not.toBe(r1.refresh);
    });

    it('treats reuse of a rotated token as theft: the whole family ends and it is audited', async () => {
      const id = '01900000-0000-7000-8000-000000000883';
      await makeUser(id, 'local.reuse@example.test', { password: 'Synthetic-Reuse-Pass-1' });
      const other = await login('local.reuse@example.test', 'Synthetic-Reuse-Pass-1');
      const first = await login('local.reuse@example.test', 'Synthetic-Reuse-Pass-1');
      const rotated = await refresh(first.refresh);
      expect(rotated.status).toBe(200);

      const replay = await refresh(first.refresh);
      expect(replay.status).toBe(401);
      expect(replay.body.detail).toBe(AUTH_MESSAGES.sessionEnded);
      expect(replay.body.access_token).toBeUndefined();
      expect(replay.setCookie).toMatch(/^hub_refresh=; Max-Age=0;/);
      // The legitimate holder's newer token is gone too.
      expect((await refresh(rotated.refresh)).status).toBe(401);
      // Another sign-in (another family) is untouched.
      expect((await refresh(other.refresh)).status).toBe(200);

      const rows = await auditFor(id, 'auth.refresh.%');
      expect(rows.map((r) => r.action)).toEqual(['auth.refresh.reuse']);
      expect(rows[0]!.s).not.toContain(first.refresh!);
    });

    it('refuses a missing or unknown cookie, and a request from another origin', async () => {
      const none = await refresh(null);
      expect(none.status).toBe(401);
      expect(none.body.detail).toBe(AUTH_MESSAGES.sessionEnded);
      expect((await refresh('A'.repeat(43))).status).toBe(401);
      const r = await login('crew@example.test', PASSWORD);
      const cross = await refresh(r.refresh, { origin: 'https://attacker.example' });
      expect(cross.status).toBe(403);
      expect(cross.setCookie).toBeNull();
      expect((await refresh(r.refresh)).status).toBe(200);
    });

    it('logout ends the session and clears the cookie without a valid access token', async () => {
      const id = '01900000-0000-7000-8000-000000000884';
      await makeUser(id, 'local.logout@example.test', { password: 'Synthetic-Logout-Pass-1' });
      const r = await login('local.logout@example.test', 'Synthetic-Logout-Pass-1');
      const out = await call('POST', '/api/v1/auth/logout', { refresh: r.refresh! });
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ signedOut: true });
      expect(out.setCookie).toMatch(/^hub_refresh=; Max-Age=0;.*Path=\/api\/v1\/auth/);
      expect((await refresh(r.refresh)).status).toBe(401);
      const rows = await auditFor(id, 'auth.logout');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.s).toContain('"sessionEnded": true');
      // Nothing to end: still the same answer.
      const empty = await call('POST', '/api/v1/auth/logout');
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ signedOut: true });
    });

    it('ends every other session when the password changes', async () => {
      const id = '01900000-0000-7000-8000-000000000885';
      const email = 'local.changer@example.test';
      await makeUser(id, email, { password: 'Synthetic-Changer-Pass-1' });
      const a = await login(email, 'Synthetic-Changer-Pass-1');
      const b = await login(email, 'Synthetic-Changer-Pass-1');
      const changed = await call('POST', '/api/v1/auth/change-password', {
        token: a.body.access_token,
        body: {
          currentPassword: 'Synthetic-Changer-Pass-1',
          newPassword: 'Synthetic-Changer-Pass-2',
        },
      });
      expect(changed.status).toBe(200);
      expect(changed.refresh).toBeTruthy();
      expect((await refresh(a.refresh)).status).toBe(401);
      expect((await refresh(b.refresh)).status).toBe(401);
      expect((await refresh(changed.refresh)).status).toBe(200);
    });

    it('stops refreshing once access has ended', async () => {
      const id = '01900000-0000-7000-8000-000000000886';
      await makeUser(id, 'local.ended@example.test', { password: 'Synthetic-Ended-Pass-1' });
      const r = await login('local.ended@example.test', 'Synthetic-Ended-Pass-1');
      await admin(async (c) => {
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await c.query(`UPDATE membership SET valid_to = now() WHERE user_id = $1`, [id]);
      });
      const refused = await refresh(r.refresh);
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('USER_INACTIVE');
      expect(refused.body.detail).toBe(AUTH_MESSAGES.ended);
    });

    it('asks for the second factor again when a new role needs MFA', async () => {
      const id = '01900000-0000-7000-8000-000000000887';
      await makeUser(id, 'local.promoted@example.test', { password: 'Synthetic-Promo-Pass-1' });
      const r = await login('local.promoted@example.test', 'Synthetic-Promo-Pass-1');
      await admin(async (c) => {
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
        await c.query(
          `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
           SELECT $1, $2, id, now() - interval '1 minute' FROM role
            WHERE organisation_id IS NULL AND key = 'REGISTERED_MANAGER'`,
          [ORG, id],
        );
      });
      const refused = await refresh(r.refresh);
      expect(refused.status).toBe(401);
      expect(refused.body.detail).toBe(AUTH_MESSAGES.sessionEnded);
    });
  });

  describe('administrator MFA reset', () => {
    const targetId = '01900000-0000-7000-8000-000000000888';
    const target = 'local.mfa.reset@example.test';
    const pass = 'Synthetic-Hr-Lead-Pass-41';
    const resetMfa = (
      id: string,
      token: string,
      b: unknown = { reason: 'Lost phone; ID checked' },
    ) => call('POST', `/api/v1/admin/users/${id}/mfa-reset`, { token, org: ORG, body: b });

    beforeAll(async () => {
      expect(orgAdminToken).toBeTruthy();
      await makeUser(targetId, target, { password: pass, role: 'HR_LEAD' });
    });

    it('removes the authenticator and ends sessions; the person enrols again at sign-in', async () => {
      const enrolled = await enrolAndSignIn(target, pass);
      const r = await resetMfa(targetId, orgAdminToken);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ mfaReset: true });
      expect(JSON.stringify(r.body)).not.toContain(enrolled.secret);

      expect((await refresh(enrolled.refresh)).status).toBe(401);
      const next = await login(target, pass);
      expect(next.status).toBe(200);
      expect(next.body).toEqual({ mfaSetupRequired: true, challengeId: expect.any(String) });

      const rows = await auditFor(targetId, 'auth.mfa.reset');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.s).toContain('Lost phone; ID checked');
      expect(rows[0]!.s).toContain('"hadMfa": true');
      expect(rows[0]!.s).not.toContain(enrolled.secret);
    });

    it('needs a reason', async () => {
      expect((await resetMfa(targetId, orgAdminToken, {})).status).toBe(400);
      expect((await resetMfa(targetId, orgAdminToken, { reason: ' ' })).status).toBe(400);
    });

    it('refuses an administrator resetting their own MFA', async () => {
      const r = await resetMfa(SEED_USERS.orgAdmin!.id, orgAdminToken);
      expect(r.status).toBe(403);
    });

    it('answers 404 for a person who is not a member of the organisation', async () => {
      expect((await resetMfa(SEED_USERS.otherCrew!.id, orgAdminToken)).status).toBe(404);
      expect((await resetMfa('01900000-0000-7000-8000-0000000008ff', orgAdminToken)).status).toBe(
        404,
      );
    });

    it('refuses someone without admin.users.manage', async () => {
      const crew = (await login('crew@example.test', PASSWORD)).body.access_token as string;
      expect((await resetMfa(targetId, crew)).status).toBe(403);
    });

    it('ends refresh sessions on a password reset and on revoked access', async () => {
      const resetId = '01900000-0000-7000-8000-000000000889';
      await makeUser(resetId, 'local.reset.sessions@example.test', {
        password: 'Synthetic-Reset-Pass-1',
      });
      const a = await login('local.reset.sessions@example.test', 'Synthetic-Reset-Pass-1');
      const reset = await call('POST', resetUrl(resetId), { token: orgAdminToken, org: ORG });
      expect(reset.status).toBe(200);
      expect((await refresh(a.refresh)).status).toBe(401);

      const revokeId = '01900000-0000-7000-8000-000000000890';
      await makeUser(revokeId, 'local.revoked@example.test', {
        password: 'Synthetic-Revoke-Pass-1',
      });
      const b = await login('local.revoked@example.test', 'Synthetic-Revoke-Pass-1');
      const revoked = await call('POST', `/api/v1/admin/users/${revokeId}/revoke`, {
        token: orgAdminToken,
        org: ORG,
        body: { reason: 'Left the service today' },
      });
      expect(revoked.status).toBe(200);
      const state = await admin(async (c) => {
        await c.query(`SELECT set_config('app.local_auth', 'on', true)`);
        const q = await c.query(
          `SELECT DISTINCT revoked_reason FROM local_refresh_token WHERE user_id = $1`,
          [revokeId],
        );
        return q.rows.map((x: { revoked_reason: string | null }) => x.revoked_reason);
      });
      expect(state).toEqual(['ACCESS_ENDED']);
      expect((await refresh(b.refresh)).status).toBe(401);
    });
  });

  it('does not exist unless AUTH_MODE=local', async () => {
    const r = await call('POST', '/api/v1/auth/login', {
      on: devApp,
      body: { username: 'crew@example.test', password: PASSWORD },
    });
    expect(r.status).toBe(404);
    expect((await call('POST', '/api/v1/auth/refresh', { on: devApp })).status).toBe(404);
    expect((await call('POST', '/api/v1/auth/logout', { on: devApp })).status).toBe(404);
  });
});
