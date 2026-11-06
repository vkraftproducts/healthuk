import { randomBytes, scrypt } from 'node:crypto';
import type pg from 'pg';

// Local username + password sign-in for the seeded synthetic users (AUTH_MODE=local, ADR 0006).
// Username = the user's email. The password is a synthetic development value from
// SEED_LOCAL_PASSWORD (default below, local development only). Never runs in production.
// Nobody gets TOTP here: privileged roles enrol at their first sign-in.

export const DEFAULT_SEED_LOCAL_PASSWORD = 'Hub-Dev-Password-2026!';

/** Same format and parameters as apps/api/src/auth/password.ts (scrypt 2^15/8/1, 64 bytes). */
function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      64,
      { N: 32_768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 },
      (err, key) =>
        err
          ? reject(err)
          : resolve(`scrypt$32768$8$1$${salt.toString('base64')}$${key.toString('base64')}`),
    ),
  );
}

/**
 * Adds a credential for each user that has none (an existing, possibly changed, password is never
 * overwritten). Runs inside the caller's transaction on the migrator connection.
 */
export async function seedLocalCredentials(
  c: pg.Client,
  users: readonly { id: string; email: string }[],
): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  const password = process.env.SEED_LOCAL_PASSWORD || DEFAULT_SEED_LOCAL_PASSWORD;
  await c.query(`SELECT set_config('app.local_auth', 'on', true)`);
  for (const u of users) {
    const exists = await c.query('SELECT 1 FROM local_credential WHERE user_id = $1', [u.id]);
    if (exists.rowCount) continue;
    await c.query(
      `INSERT INTO local_credential (user_id, username, password_hash, must_change_password)
       VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`,
      [u.id, u.email.toLowerCase(), await hashPassword(password)],
    );
  }
}
