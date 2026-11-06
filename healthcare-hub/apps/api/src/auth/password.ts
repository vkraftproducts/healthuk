import { randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing for local sign-in (ADR 0006): scrypt from node:crypto, per-user 16-byte salt,
 * N=2^15 r=8 p=1, 64-byte key. Stored as `scrypt$N$r$p$saltB64$hashB64`. Never log either value.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// 128 * N * r = 32 MiB; Node's default ceiling is exactly that, so leave headroom.
const MAX_MEM = 96 * 1024 * 1024;

function derive(password: string, salt: Buffer, opts: ScryptOptions, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, len, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, { N, r: R, p: P, maxmem: MAX_MEM }, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time check. A malformed or out-of-range stored value never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  const sane =
    Number.isInteger(n) &&
    n >= 16_384 &&
    n <= 131_072 &&
    (n & (n - 1)) === 0 &&
    r >= 8 &&
    r <= 16 &&
    p >= 1 &&
    p <= 4 &&
    salt.length >= 16 &&
    expected.length >= 32 &&
    expected.length <= 128;
  if (!sane) return false;
  const opts = { N: n, r, p, maxmem: 4 * 128 * n * r };
  const actual = await derive(password, salt, opts, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | null = null;
/**
 * Spends the same scrypt work as a real check, for usernames that do not exist, so response time
 * does not reveal whether an account exists.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(18).toString('base64'));
  await verifyPassword(password, await dummy);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** One-time temporary password for an administrator reset: 20 characters, ~117 bits. */
export function temporaryPassword(): string {
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
    if (i === 4 || i === 9 || i === 14) out += '-';
  }
  return out;
}
