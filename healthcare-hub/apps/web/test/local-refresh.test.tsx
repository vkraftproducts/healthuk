import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { type MeResponse } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { LocalAuthClient, NotSignedInError } from '../src/auth.js';

type Reply = { status: number; body: unknown };
type Sent = { path: string; method: string; credentials: RequestCredentials | undefined };

/** Fake API: answers each request in turn and records the path, method and credentials mode. */
function fakeApi(replies: Reply[]) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: new URL(url, 'http://web.test').pathname,
        method: init?.method ?? 'GET',
        credentials: init?.credentials,
      });
      const next = replies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
  return sent;
}

const token = (t: string, expires_in = 900) => ({
  status: 200,
  body: { access_token: t, token_type: 'Bearer', expires_in },
});
const ended = {
  status: 401,
  body: { status: 401, code: 'UNAUTHENTICATED', detail: 'Your session has ended. Sign in again.' },
};
const refreshCall: Sent = { path: '/api/v1/auth/refresh', method: 'POST', credentials: 'include' };

const storedText = () =>
  JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage });

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('local sign-in refresh [ADR 0006]', () => {
  it('resumes the session silently after a reload, keeping the token in memory only', async () => {
    const sent = fakeApi([token('tok-refreshed')]);
    sessionStorage.setItem('hub.localUsername', 'crew@example.test');
    const auth = new LocalAuthClient('');
    expect(auth.isSignedIn()).toBe(false);
    expect(await auth.restore()).toBe(true);
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.currentUser()).toBe('crew@example.test');
    expect(await auth.getToken()).toBe('tok-refreshed');
    expect(sent).toEqual([refreshCall]);
    expect(storedText()).not.toContain('tok-refreshed');
  });

  it('renews an expired access token on demand through the cookie', async () => {
    // expires_in shorter than the one-minute margin: the token counts as expired at once.
    const sent = fakeApi([token('tok-1', 30), token('tok-2')]);
    const auth = new LocalAuthClient('');
    await auth.login('crew@example.test', 'Synthetic-pass-1');
    expect(await auth.getToken()).toBe('tok-2');
    expect(sent[0]).toMatchObject({ path: '/api/v1/auth/login', credentials: 'include' });
    expect(sent[1]).toEqual(refreshCall);
  });

  it('sends one refresh for callers that need a token at the same time', async () => {
    const sent = fakeApi([token('tok-shared')]);
    const auth = new LocalAuthClient('');
    const [a, b, c] = await Promise.all([auth.getToken(), auth.getToken(), auth.restore()]);
    expect([a, b, c]).toEqual(['tok-shared', 'tok-shared', true]);
    expect(sent).toEqual([refreshCall]);
  });

  it('is signed out when the refresh is refused, and never refreshes after sign-out', async () => {
    const sent = fakeApi([
      ended,
      ended,
      token('tok-1'),
      { status: 200, body: { signedOut: true } },
    ]);
    const auth = new LocalAuthClient('');
    expect(await auth.restore()).toBe(false);
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
    expect(sent).toHaveLength(2); // the failed restore and the failed on-demand refresh

    await auth.login('crew@example.test', 'Synthetic-pass-1');
    auth.signOut();
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
    expect(await auth.restore()).toBe(false);
    expect(sent.slice(2)).toEqual([
      { path: '/api/v1/auth/login', method: 'POST', credentials: 'include' },
      { path: '/api/v1/auth/logout', method: 'POST', credentials: 'include' },
    ]);
  });
});

describe('app start with local sign-in', () => {
  const me: MeResponse = {
    user: {
      id: '01900000-0000-7000-8000-000000000101',
      email: 'm@example.test',
      displayName: 'Manager',
    },
    memberships: [
      {
        organisationId: '01900000-0000-7000-8000-000000000001',
        organisationName: 'Meadowbank Patient Transport',
        locationId: null,
        roleKey: 'REGISTERED_MANAGER',
        roleName: 'Registered manager',
      },
    ],
    permissions: ['dashboard.view'],
    activeOrganisationId: '01900000-0000-7000-8000-000000000001',
    mfa: { required: true, satisfied: true },
  };
  const api: ApiClient = {
    me: async () => me,
    readyz: async () => ({ status: 'ready' }),
    get: async () => ({ data: [] }),
    send: async () => ({}),
  } as unknown as ApiClient;
  const renderApp = (auth: LocalAuthClient) =>
    render(
      // Settings, not the dashboard: the shell is what matters here, not dashboard data.
      <App
        api={api}
        auth={auth}
        history={createMemoryHistory({ initialEntries: ['/settings'] })}
      />,
    );

  it('goes straight to the app when the refresh cookie still works', async () => {
    fakeApi([token('tok-reload')]);
    renderApp(new LocalAuthClient(''));
    expect(screen.getByRole('status')).toHaveTextContent('Checking your sign-in…');
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Sign in with your organisation account' }),
    ).toBeNull();
  });

  it('shows the sign-in page when there is no session to resume', async () => {
    fakeApi([ended]);
    renderApp(new LocalAuthClient(''));
    expect(
      await screen.findByRole('heading', { name: 'Sign in with your organisation account' }),
    ).toBeInTheDocument();
  });
});
