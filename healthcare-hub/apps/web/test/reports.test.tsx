import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'm@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank Patient Transport',
      locationId: null,
      roleKey: 'X',
      roleName: 'X',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
const def = {
  key: 'available',
  label: 'Vehicles available',
  numerator: 'Vehicles with status Available',
  denominator: 'Vehicles not retired',
  period: 'Snapshot at the time the report is run',
  inclusion: 'Blocked, quarantined and off-road vehicles count as unavailable',
};
const fleet = {
  id: 'FLEET',
  title: 'Fleet availability, defects and maintenance',
  summary: 'Vehicles available now.',
  period: { from: '2026-11-01', to: '2026-11-02' },
  locationId: null,
  generatedAt: '2026-11-02T09:00:00Z',
  notice: 'Internal measure — not a CQC rating',
  measures: [
    {
      key: 'available',
      label: 'Vehicles available',
      value: 66.7,
      unit: 'PERCENT',
      numerator: 2,
      denominator: 3,
      definition: def,
    },
  ],
  tables: [
    {
      key: 'vehicles',
      title: 'Vehicles',
      columns: ['Vehicle', 'Status'],
      rows: [['AMB-03', 'BLOCKED']],
    },
  ],
};
function renderAt(permissions: string[]) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (path: string) =>
      path === '/api/v1/reports'
        ? { data: [{ id: 'FLEET', title: fleet.title, summary: '', measures: [def] }] }
        : path.startsWith('/api/v1/reports/')
          ? fleet
          : { data: [] },
    send: async () => ({}),
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/reports'] })} />);
}
beforeEach(() => sessionStorage.clear());

describe('reports page [PRD 4.10]', () => {
  it('shows each figure with what is counted, out of what, the period and what is included', async () => {
    renderAt(['reports.view', 'reports.export']);
    const card = await screen.findByRole('article', { name: 'Vehicles available' });
    expect(within(card).getByText('66.7%')).toBeInTheDocument();
    expect(within(card).getByText('2 of 3')).toBeInTheDocument();
    expect(within(card).getByText('Vehicles not retired')).toBeInTheDocument();
    expect(within(card).getByText(/off-road vehicles count as unavailable/)).toBeInTheDocument();
    expect(screen.getAllByText(/Internal measure — not a CQC rating/).length).toBeGreaterThan(0);
    expect(screen.getByRole('table', { name: 'Vehicles' })).toHaveTextContent('Blocked');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Monthly management pack' })).toBeInTheDocument();
  });

  it('without export permission there is no export or management pack', async () => {
    renderAt(['reports.view']);
    await screen.findByRole('article', { name: 'Vehicles available' });
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Monthly management pack' })).toBeNull();
  });

  it('without report permission the page says so', async () => {
    renderAt(['dashboard.view']);
    expect(await screen.findByText(/do not have permission to view reports/)).toBeInTheDocument();
  });
});
