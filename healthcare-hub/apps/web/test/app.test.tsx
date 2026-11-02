import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { NAV_ITEMS } from '../src/nav.js';

const ORG_A = '01900000-0000-7000-8000-000000000001';
const ORG_B = '01900000-0000-7000-8000-000000000002';

const me = (orgId: string | null, permissions: string[]): MeResponse => ({
  user: {
    id: '01900000-0000-7000-8000-000000000101',
    email: 'm@example.test',
    displayName: 'Dev Manager',
  },
  memberships: [
    {
      organisationId: ORG_A,
      organisationName: 'Example organisation',
      locationId: null,
      roleKey: 'REGISTERED_MANAGER',
      roleName: 'Registered manager',
    },
    {
      organisationId: ORG_B,
      organisationName: 'Second organisation',
      locationId: null,
      roleKey: 'HR_LEAD',
      roleName: 'HR lead',
    },
  ],
  permissions,
  activeOrganisationId: orgId,
  mfa: { required: true, satisfied: true },
});

const unused = async (): Promise<never> => {
  throw new Error('not used in this test');
};
function renderApp(api: Pick<ApiClient, 'me' | 'readyz'> & Partial<ApiClient>, path = '/') {
  const full: ApiClient = { get: unused, send: unused, ...api };
  return render(<App api={full} history={createMemoryHistory({ initialEntries: [path] })} />);
}

describe('web shell', () => {
  it('shows every module in the left navigation', async () => {
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'ready' }),
    });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    for (const item of NAV_ITEMS)
      expect(within(nav).getByRole('link', { name: item.label })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it("lists only the user's organisations and re-queries with the selected one", async () => {
    const meFn = vi.fn(async (o: string | null) => me(o, ['dashboard.view']));
    renderApp({ me: meFn, readyz: async () => ({ status: 'ready' }) });
    const select = await screen.findByLabelText('Organisation');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Example organisation', 'Second organisation']);
    await userEvent.selectOptions(select, ORG_B);
    await waitFor(() => expect(meFn).toHaveBeenCalledWith(ORG_B));
  });

  it("shows real tile counts including today's jobs, and the internal-measure notice", async () => {
    const summary = {
      tiles: { overdue: 3, dueSoon: 2, blockedVehicles: 1, jobsToday: 6, unverified: 4 },
      modules: [{ module: 'FLEET', status: 'RED', count: 1, label: 'blocked' }],
      operations: { jobsAwaitingAllocation: 2, acknowledgementsDue: 1 },
      criticalOpen: 0,
      coverage: {
        numerator: 5,
        denominator: 10,
        exclusions: 1,
        percent: 50,
        label: 'Internal measure — not a CQC rating',
      },
      lastRefreshedAt: '2026-10-30T09:00:00Z',
      sources: [{ name: 'jobs', ok: true }],
    };
    const rows = [
      {
        key: 'VEH:1',
        module: 'FLEET',
        item: 'AMB-03',
        ownerUserId: null,
        deadline: null,
        status: 'RED',
        reasonText: 'Blocked – 1 open stop-use defect',
        tiles: ['blockedVehicles'],
        link: { type: 'VEHICLE', id: '1' },
      },
    ];
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'ready' }),
      get: async (p: string) =>
        p.startsWith('/api/v1/dashboard/summary') ? summary : { data: rows },
    });
    expect(await screen.findByLabelText('Overdue tasks: 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Jobs today: 6')).toBeInTheDocument();
    expect(screen.getByText('Jobs awaiting allocation').nextSibling).toHaveTextContent('2');
    expect(screen.getByRole('row', { name: /AMB-03/ })).toHaveTextContent(
      'Red – Blocked – 1 open stop-use defect',
    );
    expect(screen.getByText('Internal measure — not a CQC rating')).toBeInTheDocument();
    expect(screen.getByText(/not CQC ratings/)).toBeInTheDocument();
  });

  it('shows "source unavailable" rather than stale or zero figures when the dashboard cannot load', async () => {
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByText(/Source unavailable/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Overdue tasks: \d/)).toBeNull();
  });

  it('hides dashboard content without the permission (server still enforces)', async () => {
    renderApp({ me: async (o) => me(o, []), readyz: async () => ({ status: 'ready' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');
    expect(screen.queryByText('Overdue tasks')).toBeNull();
  });

  it('shows an explicit source-unavailable state, with text and not colour alone', async () => {
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'degraded' }),
    });
    expect(await screen.findByText('Red – source unavailable')).toBeInTheDocument();
  });

  it('shows an error (no stale data) when the account cannot be loaded', async () => {
    renderApp({
      me: async () => {
        throw new Error('boom');
      },
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Source unavailable');
  });
});

describe('settings screens', () => {
  const rows: Record<string, unknown[]> = {
    [`/api/v1/organisations/${ORG_A}/locations`]: [
      { id: 'l1', name: 'Watford', registered: true, archived: false, version: 1 },
    ],
    [`/api/v1/organisations/${ORG_A}/services`]: [],
    [`/api/v1/organisations/${ORG_A}/registered-activities`]: [],
    '/api/v1/admin/users': [
      {
        id: 'u1',
        displayName: 'Pat Manager',
        email: 'pat@example.test',
        status: 'ACTIVE',
        memberships: [{ roleName: 'Registered manager', validTo: null }],
      },
    ],
    '/api/v1/admin/roles': [
      { id: 'r1', name: 'Crew member', isSystem: true, permissions: ['crew.today.view'] },
    ],
  };
  const sent: { method: string; path: string; body: unknown }[] = [];
  beforeEach(() => sessionStorage.clear());
  const api = (perms: string[]) => ({
    me: async (o: string | null) => me(o, perms),
    readyz: async () => ({ status: 'ready' }),
    get: async (path: string) => ({ data: rows[path] ?? [] }),
    send: async (method: 'POST' | 'PATCH', path: string, _o: string | null, body: unknown) => {
      sent.push({ method, path, body });
      return {};
    },
  });

  it('lists locations and hides admin tabs and actions without permission', async () => {
    renderApp(api(['dashboard.view']), '/settings');
    expect(
      await within(await screen.findByRole('main')).findByText('Watford', {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Users and roles' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive Watford/ })).toBeNull();
  });

  it('lets an admin invite a user and shows the result', async () => {
    sent.length = 0;
    renderApp(api(['admin.users.manage', 'admin.org.manage']), '/settings');
    fireEvent.click(await screen.findByRole('tab', { name: 'Users and roles' }));
    expect(await screen.findByText('Pat Manager')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Invite user' });
    fireEvent.change(form.querySelector('input[type=email]')!, {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(form.querySelectorAll('input')[1]!, { target: { value: 'New Person' } });
    fireEvent.change(form.querySelector('select')!, { target: { value: 'r1' } });
    fireEvent.submit(form);
    expect(await screen.findByText(/Invitation created/)).toBeTruthy();
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/admin/users',
      body: { email: 'new@example.test', roleId: 'r1' },
    });
  });
});
