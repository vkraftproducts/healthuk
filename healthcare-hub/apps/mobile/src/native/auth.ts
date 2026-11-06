import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type { AuthProvider, Tokens } from '../core/ports';
import type { MobileConfig } from '../config';

WebBrowser.maybeCompleteAuthSession();

/** Entra External ID with authorisation code + PKCE (no client secret on the device). */
export function entraAuth(cfg: MobileConfig): AuthProvider {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: cfg.scheme, path: 'auth' });
  const toTokens = (r: AuthSession.TokenResponse): Tokens => ({
    accessToken: r.accessToken,
    refreshToken: r.refreshToken ?? null,
    expiresAt: ((r.issuedAt ?? Math.floor(Date.now() / 1000)) + (r.expiresIn ?? 300)) * 1000,
  });
  return {
    async signIn() {
      const discovery = await AuthSession.fetchDiscoveryAsync(cfg.oidc.issuer);
      const req = new AuthSession.AuthRequest({
        clientId: cfg.oidc.clientId,
        redirectUri,
        scopes: cfg.oidc.scopes,
        usePKCE: true,
      });
      const res = await req.promptAsync(discovery);
      if (res.type !== 'success') throw new Error('Sign-in was cancelled');
      const t = await AuthSession.exchangeCodeAsync(
        {
          clientId: cfg.oidc.clientId,
          code: res.params.code!,
          redirectUri,
          extraParams: { code_verifier: req.codeVerifier! },
        },
        discovery,
      );
      return toTokens(t);
    },
    async refresh(refreshToken) {
      const discovery = await AuthSession.fetchDiscoveryAsync(cfg.oidc.issuer);
      const t = await AuthSession.refreshAsync(
        { clientId: cfg.oidc.clientId, refreshToken, scopes: cfg.oidc.scopes },
        discovery,
      );
      return toTokens(t);
    },
  };
}

/**
 * Local development only: signs devUser in to the mock OIDC with its password. Refused unless the
 * build is a development build pointing at a local mock issuer.
 */
export function devAuth(cfg: MobileConfig, fetchImpl: typeof fetch = fetch): AuthProvider {
  if (!cfg.devAuth || !/localhost|127\.0\.0\.1|10\.0\.2\.2/.test(cfg.oidc.issuer))
    throw new Error('Development sign-in is not available in this build');
  const get = async (): Promise<Tokens> => {
    const r = await fetchImpl(`${cfg.oidc.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: cfg.devUser, password: cfg.devPassword }),
    });
    if (!r.ok) throw new Error('Development sign-in failed');
    const b = (await r.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: b.access_token,
      refreshToken: null,
      expiresAt: Date.now() + (b.expires_in ?? 3600) * 1000,
    };
  };
  return { signIn: get, refresh: async () => get() };
}
