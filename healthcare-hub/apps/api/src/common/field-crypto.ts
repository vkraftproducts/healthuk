import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level encryption for individual high-risk fields (e.g. DBS certificate number,
 * DATA_MODEL `cert_number_encrypted`). AES-256-GCM; the key comes from Key Vault in Azure.
 * Format: `enc:v1:<iv>:<tag>:<ciphertext>` (base64url).
 */
const PREFIX = 'enc:v1:';

export function encryptField(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function decryptField(value: string, key: Buffer): string | null {
  if (!value.startsWith(PREFIX)) return null;
  const [iv, tag, ct] = value.slice(PREFIX.length).split(':');
  if (!iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function fieldKey(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}
