/* eslint-disable no-console */
// DEV-ONLY mock OIDC provider: publishes a JWKS and mints tokens for the seeded dev users.
// Refuses to start when NODE_ENV=production. Never deploy this.
//   GET /.well-known/jwks.json
//   GET /token?user=manager|other-manager&mfa=1   ->  { access_token }
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';

if (process.env.NODE_ENV === 'production') {
  console.error('mock-oidc must never run in production');
  process.exit(1);
}

const PORT = Number(process.env.MOCK_OIDC_PORT ?? 4010);
const ISSUER = process.env.OIDC_ISSUER ?? `http://localhost:${PORT}`;
const AUDIENCE = process.env.OIDC_AUDIENCE ?? 'healthcare-hub-api';
const USERS: Record<string, string> = {
  manager: 'dev|manager',
  'other-manager': 'dev|other-manager',
};

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

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER);
  res.setHeader('access-control-allow-origin', '*');
  if (url.pathname === '/.well-known/jwks.json') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (url.pathname === '/token') {
    const name = url.searchParams.get('user') ?? 'manager';
    // Any seeded dev user (dev|hr, dev|dispatcher, dev|crew, ...); the API still decides access.
    const sub = USERS[name] ?? (/^[a-z0-9-]{1,40}$/.test(name) ? `dev|${name}` : undefined);
    if (!sub) {
      res.statusCode = 400;
      res.end('unknown dev user');
      return;
    }
    const amr = url.searchParams.get('mfa') === '0' ? ['pwd'] : ['pwd', 'mfa'];
    const token = await new SignJWT({ amr })
      .setProtectedHeader({ alg: 'RS256', kid: 'dev-1' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(privateKey);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 900 }));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(PORT, () => console.log(`mock OIDC (dev only) on :${PORT}`));
