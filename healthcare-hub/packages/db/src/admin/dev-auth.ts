// DEVELOPMENT sign-in only: usernames and hashed passwords for the mock identity provider
// (apps/api scripts/mock-oidc.ts). Production signs in with Microsoft Entra External ID and the
// application stores no passwords (ADR-0003, SECURITY_COMPLIANCE §1).
//
// The table lives in its own schema, created and read by the migrator role only: the application
// role (hub_app) cannot see it, so nothing in a request handler can reach a password hash.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

/** The password `pnpm db:seed` gives every development account, unless DEV_PASSWORD is set. */
export const DEV_DEFAULT_PASSWORD = 'Exora-dev-2026';
export const MIN_PASSWORD_LENGTH = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const N = 32768;
const R = 8;
const P = 1;

function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { N: n, r, p, maxmem: 128 * n * r * 2 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

const normalise = (username: string) => username.trim().toLowerCase();

export async function ensureDevAuth(c: pg.Client): Promise<void> {
  await c.query('CREATE SCHEMA IF NOT EXISTS dev_auth');
  await c.query('REVOKE ALL ON SCHEMA dev_auth FROM PUBLIC');
  await c.query(`CREATE TABLE IF NOT EXISTS dev_auth.credential (
    username        text PRIMARY KEY CHECK (username = lower(btrim(username)) AND username <> ''),
    idp_subject     text NOT NULL UNIQUE,
    password_hash   text NOT NULL,
    failed_attempts int NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
  )`);
}

/** Sets (or resets) one account's password, and clears any lock. */
export async function setDevPassword(
  c: pg.Client,
  username: string,
  subject: string,
  password: string,
): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  await c.query(
    `INSERT INTO dev_auth.credential (username, idp_subject, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL,
           updated_at = now()`,
    [normalise(username), subject, await hashPassword(password)],
  );
}

/** Gives each account the password, unless it already has one (a changed password survives a re-seed). */
export async function seedDevCredentials(
  c: pg.Client,
  accounts: { username: string; subject: string }[],
  password: string,
): Promise<void> {
  for (const a of accounts)
    await c.query(
      `INSERT INTO dev_auth.credential (username, idp_subject, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [normalise(a.username), a.subject, await hashPassword(password)],
    );
}

export type DevLoginResult =
  { ok: true; subject: string } | { ok: false; reason: 'invalid' | 'locked' };

/**
 * Checks a username and password. An unknown username gets the same answer, after the same work,
 * as a wrong password. Five wrong passwords lock the account for 15 minutes.
 */
export async function checkDevLogin(
  c: pg.Client,
  username: string,
  password: string,
  now = new Date(),
): Promise<DevLoginResult> {
  const { rows } = await c.query<{
    idp_subject: string;
    password_hash: string;
    failed_attempts: number;
    locked_until: Date | null;
  }>(
    'SELECT idp_subject, password_hash, failed_attempts, locked_until FROM dev_auth.credential WHERE username = $1',
    [normalise(username)],
  );
  const row = rows[0];
  if (!row) {
    await hashPassword(password);
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until && row.locked_until > now) return { ok: false, reason: 'locked' };
  if (!(await verifyPassword(password, row.password_hash))) {
    const failures = row.failed_attempts + 1;
    const lock = failures >= MAX_FAILURES;
    await c.query(
      'UPDATE dev_auth.credential SET failed_attempts = $2, locked_until = $3 WHERE username = $1',
      [
        normalise(username),
        lock ? 0 : failures,
        lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null,
      ],
    );
    return { ok: false, reason: 'invalid' };
  }
  await c.query(
    'UPDATE dev_auth.credential SET failed_attempts = 0, locked_until = NULL WHERE username = $1',
    [normalise(username)],
  );
  return { ok: true, subject: row.idp_subject };
}
