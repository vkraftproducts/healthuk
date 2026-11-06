/**
 * Auth client abstraction. Tokens are held in memory only - never localStorage (SECURITY_COMPLIANCE §1).
 *
 *  - MockAuthClient: development against the dev-only mock OIDC server (apps/api `dev:oidc`),
 *    which checks a username and password against the development database.
 *  - Production: Microsoft Entra External ID via OIDC Authorization Code + PKCE (ADR-0003).
 *    That client is wired in once the Entra tenant exists (open question tracked in DECISIONS.md);
 *    until then production builds show the sign-in page with Microsoft sign-in unavailable.
 */
export interface AuthClient {
  readonly kind: 'dev' | 'entra';
  /** Returns a valid access token. Throws NotSignedInError when nobody is signed in. */
  getToken(): Promise<string>;
  /** Starts a session. Dev: username and password. Entra: redirects to Microsoft. */
  signIn(username?: string, password?: string): Promise<void>;
  signOut(): void;
  /** True when a session exists (a token may still be fetched lazily). */
  isSignedIn(): boolean;
  /** The signed-in dev username, when known. */
  currentUser(): string | null;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
  }
}

const SESSION_KEY = 'hub.devSession';
type StoredSession = { user: string; refreshToken: string };

function readSession(): StoredSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as StoredSession | null;
    return s && typeof s.user === 'string' && typeof s.refreshToken === 'string' ? s : null;
  } catch {
    return null;
  }
}
function writeSession(s: StoredSession | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the session lasts until the page is reloaded */
  }
}

/**
 * Dev-only client. The access token lives in memory only. So that a reload keeps the developer
 * signed in, the refresh token is kept in sessionStorage: this tab only, gone when it closes,
 * rotated on every use. The password is sent once and never kept.
 */
export class MockAuthClient implements AuthClient {
  readonly kind = 'dev' as const;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private refreshToken: string | null = null;
  private user: string | null = null;
  /** One refresh at a time: a refresh token works once, so parallel callers share the result. */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly baseUrl: string) {
    const s = readSession();
    this.user = s?.user ?? null;
    this.refreshToken = s?.refreshToken ?? null;
  }

  private async requestToken(body: Record<string, string>): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Dev sign-in failed: the mock sign-in server is not running (pnpm dev).');
    }
    if (res.status === 423)
      throw new Error('Too many wrong passwords. This account is locked for 15 minutes.');
    if (!res.ok) throw new Error('The username or password is incorrect.');
    const b = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    this.token = b.access_token;
    this.refreshToken = b.refresh_token ?? null;
    // A minute early, so a token is not sent just as it expires.
    this.tokenExpiresAt = Date.now() + ((b.expires_in ?? 900) - 60) * 1000;
    if (this.user && this.refreshToken)
      writeSession({ user: this.user, refreshToken: this.refreshToken });
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (!this.user || !this.refreshToken) throw new NotSignedInError();
    const refreshToken = this.refreshToken;
    this.refreshing ??= this.requestToken({ refresh_token: refreshToken }).finally(() => {
      this.refreshing = null;
    });
    try {
      await this.refreshing;
    } catch {
      this.signOut();
      throw new NotSignedInError();
    }
    return this.token as string;
  }
  async signIn(username?: string, password?: string): Promise<void> {
    const name = username?.trim().toLowerCase();
    if (!name || !password) throw new Error('Enter your username and password.');
    this.signOut();
    this.user = name;
    try {
      await this.requestToken({ username: name, password });
    } catch (e) {
      this.user = null;
      throw e;
    }
  }
  signOut(): void {
    this.token = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
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

export function createAuthClient(): AuthClient {
  if (import.meta.env.PROD) return new UnconfiguredEntraClient();
  return new MockAuthClient(import.meta.env.VITE_MOCK_OIDC_URL ?? 'http://localhost:4010');
}
