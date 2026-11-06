import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ALL_PERMISSION_KEYS, AUTH_MESSAGES, type MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { NAV_ITEMS } from '../src/nav.js';

beforeEach(() => sessionStorage.clear());

const ORG_A = '01900000-0000-7000-8000-000000000001';
const ORG_B = '01900000-0000-7000-8000-000000000002';

const me = (orgId: string | null, permissions: string[]): MeResponse => ({
  user: {
    id: '01900000-0000-7000-8000-000000000101',
    email: 'm@example.test',
    displayName: 'Manager',
  },
  memberships: [
    {
      organisationId: ORG_A,
      organisationName: 'Meadowbank Patient Transport',
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
  it('shows every module in the left navigation to a role that can use them all', async () => {
    renderApp({
      me: async (o) => me(o, [...ALL_PERMISSION_KEYS]),
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

  it('shows each role only the pages it can use, and refuses the others [task 16]', async () => {
    const crew = [
      'crew.today.view',
      'staff.self.view',
      'staff.self.update',
      'fleet.expense.submit',
      'compliance.policy.acknowledge',
      'speakup.raise',
    ];
    const shell = {
      me: async (o: string | null) => me(o, crew),
      readyz: async () => ({ status: 'ready' as const }),
      get: async (path: string) =>
        path === '/api/v1/staff/me'
          ? {
              profile: {
                displayName: 'Alex Morgan',
                staffNo: 'ST-1',
                lifecycleState: 'ACTIVE',
                roles: [],
                activeRestrictions: [],
              },
              requirements: [],
              corrections: [],
            }
          : { data: [] },
    };
    const view = renderApp(shell);
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    const names = within(nav)
      .getAllByRole('link')
      .map((l) => l.textContent);
    // Crew submit expenses in the crew app, so Vehicles is not listed for them (finding 21).
    expect(names).toEqual(expect.arrayContaining(['Home', 'My record', 'Compliance', 'Speak up']));
    expect(names).not.toContain('Vehicles and assets');
    // WORKFLOWS A1 and F0: crew land on their own record, with a pointer to the crew app.
    expect(await screen.findByRole('heading', { name: 'My record' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Crew app' })).toHaveTextContent(
      /crew app on your work phone/,
    );
    view.unmount();
    renderApp(shell, '/settings');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not give access to this page.',
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
    ).toEqual(['Meadowbank Patient Transport', 'Second organisation']);
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

  it('goes back to the previous page from the breadcrumb, or home when there is none', async () => {
    const shell = {
      me: async (o: string | null) => me(o, ['premises.item.view', 'staff.profile.view_basic']),
      readyz: async () => ({ status: 'ready' as const }),
      get: async () => ({ data: [] }),
    };
    const current = (name: string) =>
      expect(screen.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    const back = () => screen.findByRole('button', { name: /^Go back: / });

    const view = renderApp(shell, '/premises');
    await userEvent.click(await screen.findByRole('link', { name: 'Staff' }));
    await waitFor(() => current('Staff'));
    await userEvent.click(await back());
    await waitFor(() => current('Premises safety'));
    view.unmount();

    renderApp(shell, '/staff');
    await userEvent.click(await back());
    await waitFor(() => current('Home'));
  });

  it('refetches what is on screen when the server signals a change, and says it is live', async () => {
    let signal: (e: 'ready' | 'change') => void = () => {};
    const get = vi.fn(async () => ({ data: [] }));
    renderApp(
      {
        me: async (o) => me(o, []),
        readyz: async () => ({ status: 'ready' }),
        get,
        watchChanges: (_org, onEvent, abort) =>
          new Promise<void>((resolve) => {
            signal = onEvent;
            onEvent('ready');
            abort.addEventListener('abort', () => resolve());
          }),
      },
      '/staff',
    );
    await waitFor(() => expect(screen.getByTestId('live-state')).toHaveTextContent('Live'));
    await waitFor(() => expect(get).toHaveBeenCalled());
    const before = get.mock.calls.length;
    signal('change');
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it('says when live updates are down rather than implying the figures are current', async () => {
    renderApp({
      me: async (o) => me(o, []),
      readyz: async () => ({ status: 'ready' }),
      watchChanges: async () => {
        throw new Error('offline');
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId('live-state')).toHaveTextContent(/Reconnecting.*out of date/),
    );
  });

  it('links each action row to the page that deals with it', async () => {
    const row = (item: string, module: string, link: Record<string, string>) => ({
      key: item,
      module,
      item,
      ownerUserId: null,
      deadline: null,
      status: 'RED',
      reasonText: 'Needs action',
      tiles: [],
      link,
    });
    const rows = [
      row('Vehicle', 'FLEET', { type: 'VEHICLE', id: 'v1' }),
      row('Audit', 'COMPLIANCE', { type: 'AUDIT_RUN', id: 'a1' }),
      row('Action', 'COMPLIANCE', { type: 'ACTION', id: 'x' }),
      row('Event', 'EVENTS', { type: 'EVENT', id: 'x' }),
      row('Job', 'JOBS', { type: 'JOB', id: 'x' }),
      row('Staff check', 'STAFF', {
        type: 'REQUIREMENT',
        id: 'x',
        subjectType: 'STAFF',
        subjectId: 's1',
      }),
      row('Vehicle check', 'FLEET', {
        type: 'REQUIREMENT',
        id: 'x',
        subjectType: 'VEHICLE',
        subjectId: 'v2',
      }),
      row('Fire check', 'PREMISES', {
        type: 'REQUIREMENT',
        id: 'x',
        subjectType: 'PREMISES',
        subjectId: 'p1',
      }),
    ];
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'ready' }),
      get: async (p: string) =>
        p.startsWith('/api/v1/dashboard/summary')
          ? {
              tiles: {},
              modules: [],
              operations: {},
              coverage: { percent: null },
              lastRefreshedAt: '2026-10-30T09:00:00Z',
              sources: [],
            }
          : { data: rows },
    });
    const expected: [string, string][] = [
      ['Fleet: Vehicle', '/vehicles/v1'],
      ['Compliance: Audit', '/compliance/audits/a1'],
      ['Compliance: Action', '/compliance?tab=actions'],
      ['Events: Event', '/compliance?tab=events'],
      ['Jobs: Job', '/planner'],
      ['Staff: Staff check', '/staff/s1'],
      ['Fleet: Vehicle check', '/vehicles/v2'],
      ['Premises: Fire check', '/premises'],
    ];
    for (const [name, href] of expected)
      expect(await screen.findByRole('link', { name })).toHaveAttribute('href', href);
  });

  it('opens the Compliance tab named in the URL, unless the user may not see it', async () => {
    const get = async () => ({ data: [] });
    const readyz = async () => ({ status: 'ready' }) as const;
    const view = renderApp(
      { me: async (o) => me(o, ['compliance.audit.view']), readyz, get },
      '/compliance?tab=actions',
    );
    expect(await screen.findByRole('tab', { name: 'Actions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    view.unmount();
    renderApp(
      { me: async (o) => me(o, ['compliance.audit.view']), readyz, get },
      '/compliance?tab=events',
    );
    expect(await screen.findByRole('tab', { name: 'Audits' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('selects a tab the role can open; no Audits tab without audit access [81, 90]', async () => {
    const asked: string[] = [];
    renderApp(
      {
        me: async (o) =>
          me(o, ['compliance.requirement.view', 'compliance.policy.acknowledge', 'dashboard.view']),
        readyz: async () => ({ status: 'ready' }) as const,
        get: async (path: string) => {
          asked.push(path);
          return { data: [] };
        },
      },
      '/compliance',
    );
    expect(await screen.findByRole('tab', { name: 'Policies' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'Audits' })).not.toBeInTheDocument();
    expect(asked.some((p) => p.includes('/audits'))).toBe(false);
    // The breadcrumb follows the page, not a fixed trail (finding 17).
    expect(screen.getByRole('button', { name: /^Go back: / })).toHaveAccessibleName(
      /Meadowbank Patient Transport \/ .* \/ Compliance$/,
    );
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
    expect(await screen.findByText(/Your role has no pages on the web yet/)).toHaveAttribute(
      'role',
      'status',
    );
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We cannot reach the server. Try again.',
    );
  });

  it('says no account was found for a sign-in with no Hub account [finding 92]', async () => {
    renderApp({
      me: async () => {
        throw new ApiError(401, 'UNAUTHENTICATED', AUTH_MESSAGES.unknownAccount);
      },
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No account found for this sign-in. Ask your administrator to invite you.',
    );
  });

  it('says access has ended for a deactivated account', async () => {
    renderApp({
      me: async () => {
        throw new ApiError(401, 'USER_INACTIVE');
      },
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your access to this organisation has ended.',
    );
  });

  it('hides ambulance modules for a dental organisation [finding 95]', async () => {
    const dental = (o: string | null): MeResponse => {
      const base = me(o, [...ALL_PERMISSION_KEYS]);
      return {
        ...base,
        memberships: base.memberships.map((m) => ({ ...m, sectorPacks: ['dental'] })),
      };
    };
    renderApp({ me: async (o) => dental(o), readyz: async () => ({ status: 'ready' }) });
    const nav = await screen.findByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Vehicles and assets' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Work planner' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Staff' })).toBeInTheDocument();
  });

  it('refuses an ambulance page opened directly in a dental organisation', async () => {
    renderApp(
      {
        me: async (o) => {
          const base = me(o, [...ALL_PERMISSION_KEYS]);
          return {
            ...base,
            memberships: base.memberships.map((m) => ({ ...m, sectorPacks: ['dental'] })),
          };
        },
        readyz: async () => ({ status: 'ready' }),
      },
      '/vehicles',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not give access to this page.',
    );
  });

  it('shows only the tiles the server says the role may see [finding 23, 88]', async () => {
    const summary = {
      tiles: { overdue: 1, dueSoon: 0, blockedVehicles: 0, jobsToday: 0, unverified: 0 },
      modules: [{ module: 'STAFF', status: 'AMBER', count: 1, label: 'unverified' }],
      operations: { jobsAwaitingAllocation: 0, acknowledgementsDue: 0 },
      criticalOpen: 0,
      coverage: {
        numerator: 1,
        denominator: 2,
        exclusions: 0,
        percent: 50,
        label: 'Internal measure — not a CQC rating',
      },
      lastRefreshedAt: '2026-10-30T09:00:00Z',
      sources: [{ name: 'requirements', ok: true }],
      visibleModules: ['STAFF'],
      visibleTiles: ['overdue', 'dueSoon'],
    };
    renderApp({
      me: async (o) => me(o, ['dashboard.view', 'staff.profile.view_basic']),
      readyz: async () => ({ status: 'ready' }),
      get: async (p: string) =>
        p.startsWith('/api/v1/dashboard/summary') ? summary : { data: [] },
    });
    expect(await screen.findByLabelText('Overdue tasks: 1')).toBeInTheDocument();
    const figures = screen.getByLabelText('Key figures');
    expect(within(figures).queryByText('Blocked vehicles')).toBeNull();
    expect(within(figures).queryByText('Jobs today')).toBeNull();
    expect(screen.queryByText('Jobs awaiting allocation')).toBeNull();
    expect(screen.getByText(/areas your role covers \(Registered manager\)/)).toBeInTheDocument();
  });

  it('says when a role has no dashboard figures at all', async () => {
    renderApp({
      me: async (o) => me(o, ['dashboard.view']),
      readyz: async () => ({ status: 'ready' }),
      get: async (p: string) =>
        p.startsWith('/api/v1/dashboard/summary')
          ? {
              tiles: { overdue: 0, dueSoon: 0, blockedVehicles: 0, jobsToday: 0, unverified: 0 },
              modules: [],
              operations: { jobsAwaitingAllocation: 0, acknowledgementsDue: 0 },
              criticalOpen: 0,
              coverage: { numerator: 0, denominator: 0, exclusions: 0, percent: null, label: '' },
              lastRefreshedAt: '2026-10-30T09:00:00Z',
              sources: [],
              visibleModules: [],
              visibleTiles: [],
            }
          : { data: [] },
    });
    expect(
      await screen.findByText(/Your role has no dashboard figures in this organisation/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Overdue tasks')).toBeNull();
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
    renderApp(api(['dashboard.view', 'admin.audit.view']), '/settings');
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

describe('stored organisation selection (task 23)', () => {
  const GONE = '01900000-0000-7000-8000-0000000000ff';
  beforeEach(() => sessionStorage.clear());

  it('drops a stored organisation that is not among the memberships', async () => {
    sessionStorage.setItem('hub.orgId', GONE);
    const asked: (string | null)[] = [];
    renderApp({
      me: async (o) => {
        asked.push(o);
        return { ...me(o === GONE ? null : o, ['dashboard.view']) };
      },
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeTruthy();
    await waitFor(() => expect(sessionStorage.getItem('hub.orgId')).toBe(ORG_A));
    expect(asked.at(-1)).toBe(ORG_A);
  });

  it('recovers when the server refuses the stored organisation', async () => {
    sessionStorage.setItem('hub.orgId', GONE);
    renderApp({
      me: async (o) => {
        if (o === GONE) throw new ApiError(403, 'FORBIDDEN');
        return me(o, ['dashboard.view']);
      },
      readyz: async () => ({ status: 'ready' }),
    });
    expect(await screen.findByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.queryByText(/Your access to this organisation has ended/)).toBeNull();
    await waitFor(() => expect(sessionStorage.getItem('hub.orgId')).toBe(ORG_A));
  });
});
