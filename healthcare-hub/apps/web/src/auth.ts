/**
 * Auth client abstraction. Tokens are held in memory only - never localStorage (SECURITY_COMPLIANCE §1).
 *
 *  - MockAuthClient: development against the dev-only mock OIDC server (apps/api `dev:oidc`).
 *    The sign-in page lets a developer pick one of the seeded synthetic users.
 *  - Production: Microsoft Entra External ID via OIDC Authorization Code + PKCE (ADR-0003).
 *    That client is wired in once the Entra tenant exists (open question tracked in DECISIONS.md);
 *    until then production builds show the sign-in page with Microsoft sign-in unavailable.
 *  - LocalAuthClient (VITE_AUTH_MODE=local): username + password checked by the API, with TOTP
 *    for privileged roles (ADR 0006, an approved exception for local and pilot use).
 */
import { AUTH_MESSAGES } from '@hub/contracts';

export interface AuthClient {
  readonly kind: 'dev' | 'entra' | 'local';
  /** Returns a valid access token. Throws NotSignedInError when nobody is signed in. */
  getToken(): Promise<string>;
  /** Starts a session. Dev: `user` is a seeded dev user key. Entra: redirects to Microsoft. */
  signIn(user?: string): Promise<void>;
  signOut(): void;
  /** True when a session exists (a token may still be fetched lazily). */
  isSignedIn(): boolean;
  /** The signed-in dev user key, when known. */
  currentUser(): string | null;
  /** Optional: resume a session after a reload without asking again. True when signed in. */
  restore?(): Promise<boolean>;
}

/** Shown when the sign-in has no Healthcare Hub account behind it (finding 92). */
export const UNKNOWN_ACCOUNT = AUTH_MESSAGES.unknownAccount;

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
  }
}

/** Synthetic users created by `pnpm db:seed` (packages/db/src/admin/seed.ts). */
/**
 * Every seeded synthetic user, grouped by organisation. Sector users exist after
 * `pnpm db:seed:sectors`; signing in as one before that is refused by the API.
 */
export const DEV_USERS = [
  { key: 'manager', name: 'Manager', role: 'Registered manager', org: 'Exora' },
  { key: 'director', name: 'Dee Rector', role: 'Director', org: 'Exora' },
  { key: 'hr', name: 'Hana Rowe', role: 'HR lead', org: 'Exora' },
  { key: 'fleet', name: 'Finn Lee', role: 'Fleet lead', org: 'Exora' },
  { key: 'premises', name: 'Priya Mason', role: 'Premises lead', org: 'Exora' },
  {
    key: 'orgadmin',
    name: 'Olu Adeyemi',
    role: 'Organisation administrator',
    org: 'Exora',
  },
  { key: 'governance', name: 'Gina Ode', role: 'Governance lead', org: 'Exora' },
  { key: 'dispatcher', name: 'Dispatcher', role: 'Dispatcher', org: 'Exora' },
  { key: 'auditor', name: 'Audrey Ward', role: 'Auditor (read only)', org: 'Exora' },
  { key: 'crew', name: 'Alex Morgan', role: 'Crew', org: 'Exora' },
  { key: 'crew2', name: 'Sam Taylor', role: 'Crew', org: 'Exora' },
  { key: 'other-manager', name: 'Other Manager', role: 'Registered manager', org: 'Other' },
  { key: 'other-crew', name: 'Other Crew', role: 'Crew', org: 'Other' },
  { key: 'dental-manager', name: 'Dana Mock', role: 'Registered manager', org: 'Dental' },
  { key: 'dental-admin', name: 'Dev Mock', role: 'Organisation administrator', org: 'Dental' },
  { key: 'carehome-manager', name: 'Casey Mock', role: 'Registered manager', org: 'Care home' },
  {
    key: 'carehome-admin',
    name: 'Charlie Mock',
    role: 'Organisation administrator',
    org: 'Care home',
  },
] as const;

export const DEV_USER_GROUPS: Record<string, string> = {
  Exora: 'Exora International Ltd (Exora Medical, ambulance)',
  Other: 'Other organisation (isolation checks)',
  Dental: 'Mock dental practice (draft pack)',
  'Care home': 'Mock care home (draft pack)',
};

const SESSION_KEY = 'hub.devUser';

function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function writeSession(user: string | null): void {
  try {
    if (user) sessionStorage.setItem(SESSION_KEY, user);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session lasts until the page is reloaded */
  }
}

/**
 * Dev-only client. Only the chosen dev user *name* is kept in sessionStorage (so a reload stays
 * signed in); the token itself lives in memory and is re-minted after a reload.
 */
export class MockAuthClient implements AuthClient {
  readonly kind = 'dev' as const;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private user: string | null;

  constructor(
    private readonly baseUrl: string,
    initialUser: string | null = readSession(),
  ) {
    this.user = initialUser;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.user) throw new NotSignedInError();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/token?user=${encodeURIComponent(this.user)}`);
    } catch {
      throw new Error('Dev sign-in failed: the mock sign-in server is not running (pnpm dev).');
    }
    if (!res.ok) throw new Error(UNKNOWN_ACCOUNT);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = body.access_token;
    // A minute early, so a token is not sent just as it expires.
    this.tokenExpiresAt = Date.now() + ((body.expires_in ?? 900) - 60) * 1000;
    return this.token;
  }
  async signIn(user?: string): Promise<void> {
    if (!user) throw new Error('Choose a user');
    this.user = user;
    this.token = null;
    try {
      await this.getToken();
    } catch (e) {
      this.user = null;
      throw e;
    }
    writeSession(user);
  }
  signOut(): void {
    this.token = null;
    this.user = null;
    writeSession(null);
  }
  isSignedIn(): boolean {
    return this.user !== null;
  }
  currentUser(): string | null {
    return this.user;
  }
}

/** Production placeholder until the Entra External ID tenant is configured (DECISIONS.md). */
export class UnconfiguredEntraClient implements AuthClient {
  readonly kind = 'entra' as const;
  getToken(): Promise<string> {
    return Promise.reject(new NotSignedInError());
  }
  signIn(): Promise<void> {
    return Promise.reject(
      new Error('Microsoft sign-in is not configured for this environment yet.'),
    );
  }
  signOut(): void {}
  isSignedIn(): boolean {
    return false;
  }
  currentUser(): string | null {
    return null;
  }
}

const LOCAL_USERNAME_KEY = 'hub.localUsername';

/** Next step of a local sign-in (each challenge is single use and lasts 5 minutes). */
export type LocalStep =
  | { kind: 'signed-in' }
  | { kind: 'mfa'; challengeId: string }
  | { kind: 'mfa-setup'; challengeId: string }
  | { kind: 'password-change'; challengeId: string };

/** A refused local sign-in step; `message` is the server's wording (WORKFLOWS A1). */
export class LocalAuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Username + password sign-in run by the Healthcare Hub API (VITE_AUTH_MODE=local, ADR 0006).
 * The 15-minute access token lives in memory only: nothing is written to localStorage, and only
 * the username (never a token or password) is kept in sessionStorage to pre-fill the form.
 * The session continues through the refresh token, which the API keeps in an HttpOnly cookie that
 * this code never sees: an expired access token is renewed with POST /auth/refresh, and after a
 * reload restore() renews it silently. The cookie lasts 30 minutes idle and 12 hours at most.
 */
export class LocalAuthClient implements AuthClient {
  readonly kind = 'local' as const;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private user: string | null = null;
  private pendingUser: string | null = null;
  /** After sign-out no refresh is attempted until the next sign-in. */
  private signedOut = false;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly apiBase = '') {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    this.token = null;
    if (!this.signedOut && (await this.refresh()) && this.token) return this.token;
    throw new NotSignedInError();
  }

  /** At app start: renew the session from the refresh cookie, if there is one. */
  async restore(): Promise<boolean> {
    if (this.isSignedIn()) return true;
    if (this.signedOut) return false;
    const ok = await this.refresh();
    if (ok && !this.user) this.user = this.rememberedUsername() || null;
    return ok;
  }

  /**
   * One refresh at a time: within this tab (shared promise) and, where the browser supports Web
   * Locks, across tabs, because each refresh token works once and a second use ends the session.
   */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        return locks
          ? await locks.request('hub-local-refresh', () => this.refreshOnce())
          : await this.refreshOnce();
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async refreshOnce(): Promise<boolean> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const r = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof r?.access_token !== 'string') return false;
    this.keep(r.access_token, r.expires_in);
    return true;
  }

  private keep(token: string, expiresIn: unknown): void {
    this.token = token;
    const ttl = typeof expiresIn === 'number' ? expiresIn : 900;
    // A minute early, so a token is not sent just as it expires.
    this.tokenExpiresAt = Date.now() + (ttl - 60) * 1000;
  }
  /** Local sign-in is a multi-step form: use login() and the step methods instead. */
  signIn(): Promise<void> {
    return Promise.reject(new Error('Enter your username and password.'));
  }
  login(username: string, password: string): Promise<LocalStep> {
    this.pendingUser = username.trim().toLowerCase();
    try {
      sessionStorage.setItem(LOCAL_USERNAME_KEY, this.pendingUser);
    } catch {
      /* storage unavailable */
    }
    return this.step('/api/v1/auth/login', { username, password });
  }
  async setupMfa(challengeId: string): Promise<{ secret: string; otpauthUri: string }> {
    return (await this.post('/api/v1/auth/mfa/setup', { challengeId })) as {
      secret: string;
      otpauthUri: string;
    };
  }
  verifyMfa(challengeId: string, code: string): Promise<LocalStep> {
    return this.step('/api/v1/auth/mfa/verify', { challengeId, code });
  }
  changeTemporaryPassword(challengeId: string, newPassword: string): Promise<LocalStep> {
    return this.step('/api/v1/auth/forced-password-change', { challengeId, newPassword });
  }
  signOut(): void {
    const token = this.token && Date.now() < this.tokenExpiresAt ? this.token : null;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.user = null;
    this.pendingUser = null;
    this.signedOut = true;
    // Ends the refresh session and clears its cookie. Best effort: the token is gone either way.
    void fetch(`${this.apiBase}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }).catch(() => undefined);
  }
  isSignedIn(): boolean {
    return this.token !== null && Date.now() < this.tokenExpiresAt;
  }
  currentUser(): string | null {
    return this.user;
  }
  /** The last username typed in this tab (pre-fills the form; never a password or token). */
  rememberedUsername(): string {
    try {
      return sessionStorage.getItem(LOCAL_USERNAME_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private async step(path: string, body: unknown): Promise<LocalStep> {
    const r = (await this.post(path, body)) as Record<string, unknown>;
    if (typeof r.access_token === 'string') {
      this.keep(r.access_token, r.expires_in);
      this.user = this.pendingUser;
      this.signedOut = false;
      return { kind: 'signed-in' };
    }
    const challengeId = String(r.challengeId ?? '');
    if (r.mfaRequired) return { kind: 'mfa', challengeId };
    if (r.mfaSetupRequired) return { kind: 'mfa-setup', challengeId };
    if (r.passwordChangeRequired) return { kind: 'password-change', challengeId };
    throw new LocalAuthError('Sign-in failed. Try again.', 500, 'INTERNAL');
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        // The completed sign-in sets the HttpOnly refresh cookie.
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new LocalAuthError('We cannot reach the server. Try again.', 0, 'OFFLINE');
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = typeof json?.detail === 'string' ? json.detail : null;
      const code = typeof json?.code === 'string' ? json.code : 'INTERNAL';
      const errors: unknown = json?.errors;
      const fieldError = Array.isArray(errors)
        ? (errors as { message?: string }[])[0]?.message
        : undefined;
      throw new LocalAuthError(
        detail ?? fieldError ?? 'Sign-in failed. Try again.',
        res.status,
        code,
      );
    }
    return json;
  }
}

export function createAuthClient(): AuthClient {
  const mode = import.meta.env.VITE_AUTH_MODE;
  if (mode === 'local') return new LocalAuthClient();
  if (mode === 'entra' || import.meta.env.PROD) return new UnconfiguredEntraClient();
  return new MockAuthClient(import.meta.env.VITE_MOCK_OIDC_URL ?? 'http://localhost:4010');
}
