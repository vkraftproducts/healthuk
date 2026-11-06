// DEV-ONLY: signs a seeded account in to the mock identity provider for the local scripts.
import { DEV_DEFAULT_PASSWORD } from '@hub/db/admin';

const tokens = new Map<string, { token: string; expiresAt: number }>();

/** `username` is the seeded account (`manager`, `dispatcher`, ...); DEV_PASSWORD overrides the default. */
export async function devToken(oidc: string, username: string): Promise<string> {
  const held = tokens.get(username);
  if (held && held.expiresAt > Date.now()) return held.token;
  const res = await fetch(`${oidc}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: process.env.DEV_PASSWORD ?? DEV_DEFAULT_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in as ${username} failed (${res.status})`);
  const b = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(username, {
    token: b.access_token,
    expiresAt: Date.now() + (b.expires_in - 60) * 1000,
  });
  return b.access_token;
}
