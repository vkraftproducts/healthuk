import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { MockAuthClient, NotSignedInError, UnconfiguredEntraClient } from '../src/auth.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me: MeResponse = {
  user: {
    id: '01900000-0000-7000-8000-000000000101',
    email: 'h@example.test',
    displayName: 'Hana Rowe',
  },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Example organisation',
      locationId: null,
      roleKey: 'HR_LEAD',
      roleName: 'HR lead',
    },
  ],
  permissions: [],
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
};

function tokenServer() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const user = new URL(url).searchParams.get('user');
      return new Response(JSON.stringify({ access_token: `tok-${user}` }), { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('MockAuthClient', () => {
  it('needs a sign-in, keeps the token in memory and only the user name in session storage', async () => {
    tokenServer();
    const auth = new MockAuthClient('http://oidc.test');
    expect(auth.isSignedIn()).toBe(false);
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
    await auth.signIn('hr');
    expect(await auth.getToken()).toBe('tok-hr');
    expect(sessionStorage.getItem('hub.devUser')).toBe('hr');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('tok-');
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok-');
    // A reload restores the session by name and re-mints the token.
    expect(new MockAuthClient('http://oidc.test').currentUser()).toBe('hr');
    auth.signOut();
    expect(auth.isSignedIn()).toBe(false);
    expect(sessionStorage.getItem('hub.devUser')).toBeNull();
  });

  it('stays signed out when the sign-in server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const auth = new MockAuthClient('http://oidc.test');
    await expect(auth.signIn('manager')).rejects.toThrow(/not running/);
    expect(auth.isSignedIn()).toBe(false);
  });
});

describe('sign-in page', () => {
  function renderWith(auth: MockAuthClient | UnconfiguredEntraClient) {
    const api: ApiClient = {
      me: async () => me,
      readyz: async () => ({ status: 'ready' }),
      get: async () => ({ data: [] }),
      send: async () => ({}),
    };
    return render(
      <App api={api} auth={auth} history={createMemoryHistory({ initialEntries: ['/'] })} />,
    );
  }

  it('shows the sign-in page first, signs in as the chosen user and signs out again', async () => {
    tokenServer();
    renderWith(new MockAuthClient('http://oidc.test'));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: /Hana Rowe/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Hana Rowe')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You have signed out.');
    expect(sessionStorage.getItem('hub.devUser')).toBeNull();
  });

  it('offers Microsoft sign-in in production and explains when it is not configured', async () => {
    renderWith(new UnconfiguredEntraClient());
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/);
  });
});
