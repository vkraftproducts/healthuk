/**
 * Auth client abstraction. Tokens are held in memory only - never localStorage (SECURITY_COMPLIANCE §1).
 *
 *  - MockAuthClient: development against the dev-only mock OIDC server (apps/api `dev:oidc`).
 *    The sign-in page lets a developer pick one of the seeded synthetic users.
 *  - Production: Microsoft Entra External ID via OIDC Authorization Code + PKCE (ADR-0003).
 *    That client is wired in once the Entra tenant exists (open question tracked in DECISIONS.md);
 *    until then production builds show the sign-in page with Microsoft sign-in unavailable.
 */
export interface AuthClient {
  readonly kind: 'dev' | 'entra';
  /** Returns a valid access token. Throws NotSignedInError when nobody is signed in. */
  getToken(): Promise<string>;
  /** Starts a session. Dev: `user` is a seeded dev user key. Entra: redirects to Microsoft. */
  signIn(user?: string): Promise<void>;
  signOut(): void;
  /** True when a session exists (a token may still be fetched lazily). */
  isSignedIn(): boolean;
  /** The signed-in dev user key, when known. */
  currentUser(): string | null;
}

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
  }
}

/** Synthetic users created by `pnpm db:seed` (packages/db/src/admin/seed.ts). */
export const DEV_USERS = [
  { key: 'manager', name: 'Dev Manager', role: 'Registered manager' },
  { key: 'admin', name: 'Ola Admin', role: 'Organisation admin' },
  { key: 'hr', name: 'Hana Rowe', role: 'HR lead' },
  { key: 'fleet', name: 'Finn Lee', role: 'Fleet lead' },
  { key: 'governance', name: 'Gina Ode', role: 'Governance lead' },
  { key: 'dispatcher', name: 'Dev Dispatcher', role: 'Dispatcher' },
  { key: 'auditor', name: 'Audrey Ward', role: 'Auditor (read only)' },
  { key: 'crew', name: 'Alex Morgan', role: 'Crew' },
  { key: 'other-manager', name: 'Other Manager', role: 'Manager, other organisation' },
] as const;

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
  private user: string | null;

  constructor(
    private readonly baseUrl: string,
    initialUser: string | null = readSession(),
  ) {
    this.user = initialUser;
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.user) throw new NotSignedInError();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/token?user=${encodeURIComponent(this.user)}`);
    } catch {
      throw new Error('Dev sign-in failed: the mock sign-in server is not running (pnpm dev).');
    }
    if (!res.ok) throw new Error('Dev sign-in failed: unknown user.');
    const body = (await res.json()) as { access_token: string };
    this.token = body.access_token;
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

export function createAuthClient(): AuthClient {
  if (import.meta.env.PROD) return new UnconfiguredEntraClient();
  return new MockAuthClient(import.meta.env.VITE_MOCK_OIDC_URL ?? 'http://localhost:4010');
}
