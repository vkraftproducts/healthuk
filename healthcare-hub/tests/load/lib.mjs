// Shared helpers for the local load scripts (development only: tokens come from the mock OIDC).
export const API = process.env.HUB_API_URL ?? 'http://localhost:4000';
export const OIDC = process.env.OIDC_ISSUER ?? 'http://localhost:4010';
export const ORG = process.env.HUB_ORG_ID ?? '01900000-0000-7000-8000-000000000001';
const tokens = new Map();
export async function token(user) {
  if (!tokens.has(user)) {
    const r = await fetch(`${OIDC}/token?user=${user}&mfa=1`);
    tokens.set(user, (await r.json()).access_token);
  }
  return tokens.get(user);
}
export async function call(user, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await token(user)}`,
      'x-org-id': ORG,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
