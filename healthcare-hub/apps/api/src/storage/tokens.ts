import { createHmac, timingSafeEqual } from 'node:crypto';

export interface BlobTokenClaims {
  /** evidence_version id */
  v: string;
  /** organisation id */
  o: string;
  /** PUT = upload to quarantine, GET = download */
  m: 'PUT' | 'GET';
  /** expiry, epoch seconds */
  e: number;
  /** maximum bytes accepted (PUT) */
  max?: number;
  /** Token kind: absent = evidence version, EXPORT = generated export (never interchangeable). */
  k?: 'EXPORT';
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Self-contained, HMAC-signed, short-lived URL token (stands in for an Azure SAS in dev and tests). */
export function signBlobToken(claims: BlobTokenClaims, secret: string): string {
  const payload = b64(JSON.stringify(claims));
  const mac = createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${b64(mac)}`;
}

export function verifyBlobToken(token: string, secret: string, now: Date): BlobTokenClaims | null {
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as BlobTokenClaims;
    if (
      typeof c.v !== 'string' ||
      typeof c.o !== 'string' ||
      (c.m !== 'PUT' && c.m !== 'GET') ||
      typeof c.e !== 'number'
    )
      return null;
    return c.e * 1000 > now.getTime() ? c : null;
  } catch {
    return null;
  }
}
