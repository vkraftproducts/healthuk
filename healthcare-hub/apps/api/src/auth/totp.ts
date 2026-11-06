import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP: HMAC-SHA1, 30-second step, 6 digits. Secrets are RFC 4648 base32 (no padding). */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 random bytes (160 bits, the RFC 4226 recommendation), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCodeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totpCode(secret: string, atMs: number): string {
  return totpCodeForStep(secret, totpStep(atMs));
}

/**
 * Checks a code within ±1 step of `atMs`. Returns the matched step, or null. A step at or before
 * `lastStep` is refused, so the same code (or an older one) can never be used twice.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(atMs);
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing does not reveal which window matched.
  for (const step of [now - 1, now, now + 1]) {
    const ok = timingSafeEqual(Buffer.from(totpCodeForStep(secret, step)), Buffer.from(code));
    if (ok && matched === null && (lastStep === null || step > lastStep)) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: string, account: string): string {
  const issuer = 'Healthcare Hub';
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = [
    `secret=${secret}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    'digits=6',
    'period=30',
  ].join('&');
  return `otpauth://totp/${label}?${q}`;
}
