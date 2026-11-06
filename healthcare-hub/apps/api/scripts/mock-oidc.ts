/* eslint-disable no-console */
// DEV-ONLY identity provider: publishes a JWKS and signs in the seeded development accounts with a
// username and password checked against the database (packages/db/src/admin/dev-auth.ts).
// Refuses to start when NODE_ENV=production. Never deploy this: production uses Entra (ADR-0003).
//   GET  /.well-known/jwks.json
//   POST /token  { username, password }   ->  { access_token, refresh_token, expires_in }
//   POST /token  { refresh_token }        ->  the same, with the refresh token rotated
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { checkDevLogin } from '@hub/db/admin';

if (process.env.NODE_ENV === 'production') {
  console.error('mock-oidc must never run in production');
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error('mock-oidc needs DATABASE_ADMIN_URL to check passwords');
  process.exit(1);
}

const PORT = Number(process.env.MOCK_OIDC_PORT ?? 4010);
const ISSUER = process.env.OIDC_ISSUER ?? `http://localhost:${PORT}`;
const AUDIENCE = process.env.OIDC_AUDIENCE ?? 'healthcare-hub-api';
const ACCESS_SECONDS = 15 * 60;
const REFRESH_MS = 8 * 3_600_000;
const db = new pg.Pool({ connectionString: adminUrl, max: 4 });

// One development signing key kept on disk (apps/api/.data, git-ignored): a restarted or
// leftover mock server signs with the same key, so the API never sees a key it cannot verify.
const KEY_FILE = '.data/mock-oidc-key.json';
async function loadKey() {
  if (existsSync(KEY_FILE)) {
    const saved = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { privateJwk: JWK };
    return {
      privateKey: await importJWK(saved.privateJwk, 'RS256'),
      publicJwk: {
        ...saved.privateJwk,
        d: undefined,
        p: undefined,
        q: undefined,
        dp: undefined,
        dq: undefined,
        qi: undefined,
      },
    };
  }
  const pair = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify({ privateJwk }), { mode: 0o600 });
  return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
}
const { privateKey, publicJwk } = await loadKey();
const jwk = { ...JSON.parse(JSON.stringify(publicJwk)), kid: 'dev-1', alg: 'RS256', use: 'sig' };

/** Refresh tokens live in memory: restarting this server signs everyone out. */
const refreshTokens = new Map<string, { subject: string; expiresAt: number }>();

async function issue(subject: string) {
  // Development has no second factor; the claim lets privileged roles through, as before.
  const accessToken = await new SignJWT({ amr: ['pwd', 'mfa'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_SECONDS}s`)
    .sign(privateKey);
  const refreshToken = randomBytes(32).toString('base64url');
  refreshTokens.set(refreshToken, { subject, expiresAt: Date.now() + REFRESH_MS });
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_SECONDS,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('too large');
  }
  const body = JSON.parse(raw || '{}') as unknown;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET, POST');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.pathname === '/.well-known/jwks.json') return reply(200, { keys: [jwk] });
  if (url.pathname !== '/token') return reply(404, { error: 'not_found' });
  if (req.method !== 'POST')
    return reply(405, {
      error: 'method_not_allowed',
      detail: 'Sign in with POST /token and a username and password',
    });

  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch {
    return reply(400, { error: 'invalid_request' });
  }
  if (typeof body.refresh_token === 'string') {
    const held = refreshTokens.get(body.refresh_token);
    refreshTokens.delete(body.refresh_token); // rotated: each refresh token works once
    if (!held || held.expiresAt < Date.now()) return reply(401, { error: 'invalid_grant' });
    return reply(200, await issue(held.subject));
  }
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string')
    return reply(400, { error: 'invalid_request' });
  const client = await db.connect();
  try {
    const r = await checkDevLogin(client as unknown as pg.Client, username, password);
    if (!r.ok) return reply(r.reason === 'locked' ? 423 : 401, { error: r.reason });
    return reply(200, await issue(r.subject));
  } finally {
    client.release();
  }
}).listen(PORT, () => console.log(`mock OIDC (dev only) on :${PORT}`));
