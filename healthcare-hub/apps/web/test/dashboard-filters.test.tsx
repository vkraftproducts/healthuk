import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG_A = '01900000-0000-7000-8000-000000000001';
const ORG_B = '01900000-0000-7000-8000-000000000002';
const LOC = '01900000-0000-7000-8000-000000000011';

const me = (orgId: string | null): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'm@example.test', displayName: 'M' },
  memberships: [
    {
      organisationId: ORG_A,
      organisationName: 'Alpha Transport',
      locationId: null,
      roleKey: 'REGISTERED_MANAGER',
      roleName: 'Registered manager',
    },
    {
      organisationId: ORG_B,
      organisationName: 'Beta Care',
      locationId: null,
      roleKey: 'REGISTERED_MANAGER',
      roleName: 'Registered manager',
    },
  ],
  permissions: ['dashboard.view'],
  activeOrganisationId: orgId,
  mfa: { required: false, satisfied: true },
});

const summary = {
  tiles: { overdue: 1, dueSoon: 2, blockedVehicles: 0, jobsToday: 3, unverified: 0 },
  modules: [],
  operations: { jobsAwaitingAllocation: 0, acknowledgementsDue: 0 },
  criticalOpen: 0,
  coverage: {
    numerator: 1,
    denominator: 2,
    exclusions: 0,
    percent: 50,
    label: 'Internal measure — not a CQC rating',
  },
  lastRefreshedAt: '2026-11-04T09:00:00.000Z',
  sources: [],
};
const group = {
  organisations: [
    {
      organisationId: ORG_A,
      organisationName: 'Alpha Transport',
      ok: true,
      unavailableReason: null,
      tiles: { overdue: 4, dueSoon: 1, blockedVehicles: 2, jobsToday: 5, unverified: 3 },
      criticalOpen: 1,
      worstStatus: 'RED',
    },
    {
      organisationId: ORG_B,
      organisationName: 'Beta Care',
      ok: false,
      unavailableReason: 'Source unavailable',
      tiles: null,
      criticalOpen: null,
      worstStatus: null,
    },
  ],
  totals: {
    overdue: 4,
    dueSoon: 1,
    blockedVehicles: 2,
    jobsToday: 5,
    unverified: 3,
    criticalOpen: 1,
  },
  lastRefreshedAt: '2026-11-04T09:00:00.000Z',
};

const ME = '01900000-0000-7000-8000-000000000101';
const OTHER = '01900000-0000-7000-8000-000000000102';
const modules = [
  { module: 'STAFF', status: 'AMBER', count: 2, label: 'unverified' },
  { module: 'FLEET', status: 'RED', count: 1, label: 'blocked' },
];
const rows = [
  {
    key: 'ACT:1',
    module: 'COMPLIANCE',
    item: 'A-1 Fix the sluice',
    ownerUserId: OTHER,
    ownerName: 'Priya Governance',
    deadline: '2026-11-04',
    status: 'RED',
    reasonText: 'Action overdue',
    tiles: ['overdue'],
    link: { type: 'ACTION', id: '01900000-0000-7000-8000-000000000901' },
  },
  {
    key: 'ACT:2',
    module: 'COMPLIANCE',
    item: 'A-2 Update the rota',
    ownerUserId: ME,
    ownerName: 'M',
    deadline: null,
    status: 'AMBER',
    reasonText: 'Action open',
    tiles: [],
    link: { type: 'ACTION', id: '01900000-0000-7000-8000-000000000902' },
  },
];

function setup() {
  const get = vi.fn(async (p: string) => {
    if (p.startsWith('/api/v1/dashboard/summary')) return { ...summary, modules };
    if (p.startsWith('/api/v1/dashboard/group')) return group;
    if (p.startsWith('/api/v1/dashboard/actions')) return { data: rows };
    if (p.includes('/locations')) return { data: [{ id: LOC, name: 'Watford' }] };
    if (p === '/api/v1/admin/people')
      return {
        data: [
          {
            id: OTHER,
            displayName: 'Priya Governance',
            roleKeys: ['GOVERNANCE_LEAD'],
            roleNames: ['Governance lead'],
            locationIds: [],
          },
        ],
      };
    return { data: [] };
  });
  const api = {
    me: async (o: string | null) => me(o),
    readyz: async () => ({ status: 'ready' as const }),
    get,
    send: async () => {
      throw new Error('unused');
    },
  } as unknown as ApiClient;
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/'] })} />);
  return get;
}

describe('dashboard filters and group view (DASH-01)', () => {
  it('sends the chosen location and date range to the API', async () => {
    const get = setup();
    await screen.findByLabelText('Overdue tasks: 1');
    await userEvent.selectOptions(screen.getByLabelText('Location'), LOC);
    await userEvent.type(screen.getByLabelText('Deadline from'), '2026-11-01');
    await userEvent.type(screen.getByLabelText('Deadline to'), '2026-11-30');
    await waitFor(() => {
      const last =
        get.mock.calls
          .map((c) => String(c[0]))
          .filter((p) => p.startsWith('/api/v1/dashboard/summary'))
          .pop() ?? '';
      expect(last).toContain(`locationId=${LOC}`);
      expect(last).toContain('dateFrom=2026-11-01');
      expect(last).toContain('dateTo=2026-11-30');
    });
  });

  it('does not apply an end date before the start date and says so', async () => {
    setup();
    await screen.findByLabelText('Overdue tasks: 1');
    await userEvent.type(screen.getByLabelText('Deadline from'), '2026-11-10');
    await userEvent.type(screen.getByLabelText('Deadline to'), '2026-11-01');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /end date is before the start date/i,
    );
  });

  it('names owners, shows UK dates, and lists owners by name for anyone (task 8)', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /Fix the sluice/ });
    expect(row).toHaveTextContent('Priya Governance');
    expect(row).toHaveTextContent('4 Nov 2026');
    expect(row).not.toHaveTextContent('2026-11-04');
    expect(screen.getByRole('row', { name: /Update the rota/ })).toHaveTextContent('M (you)');
    expect(
      await screen.findByRole('option', { name: 'Priya Governance (Governance lead)' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Last refreshed 4 Nov 2026, 09:00/)).toBeInTheDocument();
  });

  it('a module filter narrows the action list only and keeps module statuses (task 8)', async () => {
    const get = setup();
    await userEvent.click(await screen.findByRole('button', { name: /Fleet \(1 blocked\)/ }));
    await waitFor(() => {
      const calls = get.mock.calls.map((c) => String(c[0]));
      const actions = calls.filter((p) => p.startsWith('/api/v1/dashboard/actions'));
      const summaries = calls.filter((p) => p.startsWith('/api/v1/dashboard/summary'));
      expect(actions.some((p) => p.includes('module=FLEET'))).toBe(true);
      expect(summaries.every((p) => !p.includes('module='))).toBe(true);
    });
    expect(screen.getByRole('heading', { name: /Fleet only/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Staff \(2 unverified\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.queryByRole('heading', { name: /Fleet only/ })).toBeNull();
  });

  it('shows counts per organisation, with an unavailable organisation shown as such, not as zero', async () => {
    setup();
    const region = await screen.findByRole('region', { name: 'All my organisations' });
    await within(region).findByText('Alpha Transport');
    expect(region).toHaveTextContent('Alpha Transport');
    expect(region).toHaveTextContent('1 critical open');
    expect(region).toHaveTextContent('Beta Care');
    expect(region).toHaveTextContent('Source unavailable');
    expect(region).toHaveTextContent('4 overdue');
  });
});
