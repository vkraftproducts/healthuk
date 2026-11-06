import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
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
      organisationName: 'Exora',
      locationId: null,
      roleKey: 'HR_LEAD',
      roleName: 'HR lead',
    },
  ],
  permissions: [],
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
};

/** A sign-in server: one account, hr / "right password", and refresh tokens. */
function tokenServer(o: { expiresIn?: number } = {}) {
  const requests: Record<string, string>[] = [];
  let minted = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      requests.push(body);
      const ok =
        (body.username === 'hr' && body.password === 'right password') ||
        body.refresh_token === 'refresh-1';
      if (!ok) return new Response(JSON.stringify({ error: 'invalid' }), { status: 401 });
      minted += 1;
      return new Response(
        JSON.stringify({
          access_token: `tok-${minted}`,
          refresh_token: 'refresh-1',
          expires_in: o.expiresIn ?? 900,
        }),
      );
    }),
  );
  return requests;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('MockAuthClient', () => {
  it('stays signed in across a reload, keeping only the refresh token, in this tab only', async () => {
    const requests = tokenServer();
    await new MockAuthClient('http://oidc.test').signIn('hr', 'right password');
    const stored = JSON.stringify({ ...sessionStorage });
    expect(stored).toContain('refresh-1');
    expect(stored).not.toMatch(/tok-|right password/);
    expect(JSON.stringify({ ...localStorage })).toBe('{}');

    const reloaded = new MockAuthClient('http://oidc.test');
    expect(reloaded.isSignedIn()).toBe(true);
    expect(reloaded.currentUser()).toBe('hr');
    expect(await reloaded.getToken()).toBe('tok-2');
    expect(requests[1]).toEqual({ refresh_token: 'refresh-1' });
    reloaded.signOut();
    expect(sessionStorage.length).toBe(0);
  });

  it('asks for one new token when several parts of the page need one at once', async () => {
    const requests = tokenServer();
    await new MockAuthClient('http://oidc.test').signIn('hr', 'right password');
    const reloaded = new MockAuthClient('http://oidc.test');
    const tokens = await Promise.all([
      reloaded.getToken(),
      reloaded.getToken(),
      reloaded.getToken(),
    ]);
    expect(new Set(tokens)).toEqual(new Set(['tok-2']));
    expect(requests.filter((r) => r.refresh_token)).toHaveLength(1);
  });

  it('forgets a stored session the sign-in server no longer accepts', async () => {
    tokenServer();
    sessionStorage.setItem('hub.devSession', JSON.stringify({ user: 'hr', refreshToken: 'stale' }));
    const auth = new MockAuthClient('http://oidc.test');
    expect(auth.isSignedIn()).toBe(true);
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
    expect(auth.isSignedIn()).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });

  it('signs in with a username and password, and keeps tokens in memory only', async () => {
    const requests = tokenServer();
    const auth = new MockAuthClient('http://oidc.test');
    expect(auth.isSignedIn()).toBe(false);
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
    await auth.signIn('hr', 'right password');
    expect(await auth.getToken()).toBe('tok-1');
    expect(auth.currentUser()).toBe('hr');
    for (const store of [sessionStorage, localStorage]) {
      expect(JSON.stringify({ ...store })).not.toMatch(/tok-|right password/);
    }
    // The password is sent once, in the body, and never kept.
    expect(requests).toEqual([{ username: 'hr', password: 'right password' }]);
    auth.signOut();
    expect(auth.isSignedIn()).toBe(false);
  });

  it('refuses a wrong password, and says so without guessing which part was wrong', async () => {
    tokenServer();
    const auth = new MockAuthClient('http://oidc.test');
    await expect(auth.signIn('hr', 'wrong')).rejects.toThrow(
      'The username or password is incorrect.',
    );
    expect(auth.isSignedIn()).toBe(false);
  });

  it('renews an expiring token with the refresh token, never with the password', async () => {
    const requests = tokenServer({ expiresIn: 900 });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const auth = new MockAuthClient('http://oidc.test');
    await auth.signIn('hr', 'right password');
    now.mockReturnValue(1_000_000 + 10 * 60_000);
    expect(await auth.getToken()).toBe('tok-1');
    now.mockReturnValue(1_000_000 + 15 * 60_000);
    expect(await auth.getToken()).toBe('tok-2');
    expect(requests[1]).toEqual({ refresh_token: 'refresh-1' });
    now.mockRestore();
  });

  it('stays signed out when the sign-in server is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    const auth = new MockAuthClient('http://oidc.test');
    await expect(auth.signIn('hr', 'right password')).rejects.toThrow(/not running/);
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

  it('signs in with a username and password, and signs out again', async () => {
    tokenServer();
    renderWith(new MockAuthClient('http://oidc.test'));
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();

    await userEvent.type(screen.getByLabelText('Username'), 'hr');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The username or password is incorrect.',
    );
    expect(screen.getByLabelText('Password')).toHaveValue('');

    await userEvent.type(screen.getByLabelText('Password'), 'right password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Hana Rowe')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You have signed out.');
  });

  it('starts again on the dashboard after signing out and back in, not on the last page', async () => {
    tokenServer();
    renderWith(new MockAuthClient('http://oidc.test'));
    const signInAs = async () => {
      await userEvent.type(screen.getByLabelText('Username'), 'hr');
      await userEvent.type(screen.getByLabelText('Password'), 'right password');
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      return screen.findByRole('navigation', { name: 'Primary' });
    };
    let nav = await signInAs();
    await userEvent.click(within(nav).getByRole('link', { name: 'Staff' }));
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Staff' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    nav = await signInAs();
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
  });

  it('goes back to the sign-in page, saying why, when a stored session has ended', async () => {
    tokenServer();
    sessionStorage.setItem('hub.devSession', JSON.stringify({ user: 'hr', refreshToken: 'stale' }));
    const auth = new MockAuthClient('http://oidc.test');
    const api: ApiClient = {
      me: async () => {
        await auth.getToken();
        return me;
      },
      readyz: async () => ({ status: 'ready' }),
      get: async () => ({ data: [] }),
      send: async () => ({}),
    };
    render(<App api={api} auth={auth} history={createMemoryHistory({ initialEntries: ['/'] })} />);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended');
  });

  it('uses a real password field the browser can fill and will not show', () => {
    renderWith(new MockAuthClient('http://oidc.test'));
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('offers Microsoft sign-in in production and explains when it is not configured', async () => {
    renderWith(new UnconfiguredEntraClient());
    expect(screen.queryByLabelText('Password')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not configured/);
  });
});
