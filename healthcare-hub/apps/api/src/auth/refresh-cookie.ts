import type { AppConfig } from '../config.js';

/**
 * The local sign-in refresh cookie (ADR 0006). HttpOnly (scripts never see it), SameSite=Strict,
 * sent only to /api/v1/auth, and Secure everywhere except plain-http development. Web and API must
 * therefore be same-site. Only this one cookie is read, so no cookie plugin is needed.
 */
export const REFRESH_COOKIE = 'hub_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** 32 random bytes, base64url, as minted by the local-auth service. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function cookieSecure(config: AppConfig): boolean {
  return config.NODE_ENV === 'production' || config.PUBLIC_API_URL.startsWith('https:');
}

/** The refresh token from a Cookie header, or null when absent or not shaped like one. */
export function readRefreshCookie(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN_SHAPE.test(value) ? value : null;
  }
  return null;
}

function attributes(secure: boolean): string {
  return `Path=${REFRESH_COOKIE_PATH}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function refreshCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${REFRESH_COOKIE}=${value}; Max-Age=${maxAge}; ${attributes(secure)}`;
}

export function clearedRefreshCookie(secure: boolean): string {
  return `${REFRESH_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${attributes(secure)}`;
}
