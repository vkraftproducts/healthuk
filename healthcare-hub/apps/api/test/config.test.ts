import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgresql://x',
  OIDC_ISSUER: 'https://login.example.test',
  OIDC_AUDIENCE: 'api',
  OIDC_JWKS_URI: 'https://login.example.test/jwks',
};

describe('config', () => {
  it('refuses a local/mock issuer in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        OIDC_ISSUER: 'http://localhost:4010',
        IP_HASH_SECRET: 'x'.repeat(40),
      }),
    ).toThrow(/Mock\/local OIDC/);
  });
  it('requires a strong IP hash secret in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/IP_HASH_SECRET/);
  });
  it('names invalid variables without printing their values', () => {
    try {
      loadConfig({ ...base, DATABASE_URL: '', API_PORT: 'secret-value' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/DATABASE_URL/);
      expect((e as Error).message).not.toContain('secret-value');
    }
  });
  it('refuses the development field-encryption key in production and accepts a real one', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      IP_HASH_SECRET: 'x'.repeat(40),
      BLOB_SIGNING_SECRET: 'y'.repeat(40),
    };
    expect(() => loadConfig(prod)).toThrow(/field-encryption key/);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(loadConfig({ ...prod, FIELD_ENCRYPTION_KEY: key }).FIELD_ENCRYPTION_KEY).toBe(key);
  });
});
