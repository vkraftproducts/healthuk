import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me = (orgId: string | null): MeResponse => ({
  user: {
    id: '01900000-0000-7000-8000-000000000101',
    email: 'a@example.test',
    displayName: 'Admin',
  },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Org',
      locationId: null,
      roleKey: 'ORG_ADMIN',
      roleName: 'Admin',
    },
  ],
  permissions: ['admin.settings.manage'],
  activeOrganisationId: orgId,
  mfa: { required: false, satisfied: true },
});

const listing = {
  notice: 'Mock integrations only. No external system is contacted and every record is synthetic.',
  data: [
    {
      adapter: 'TELEMATICS',
      name: 'Vehicle telematics',
      direction: 'INBOUND',
      summary: 'Daily odometer readings.',
      treatment: 'Flagged like any other reading.',
      connected: true,
      mode: 'MOCK',
      lastRunAt: null,
      lastStatus: null,
    },
    {
      adapter: 'PAYROLL',
      name: 'Payroll export',
      direction: 'OUTBOUND',
      summary: 'Planned hours.',
      treatment: 'Hours only.',
      connected: false,
      mode: null,
      lastRunAt: null,
      lastStatus: null,
    },
  ],
  recentRuns: [
    {
      id: '1',
      adapter: 'FLEETX',
      direction: 'INBOUND',
      status: 'PARTIAL',
      scenario: 'faults',
      startedAt: '2026-11-04T09:00:00.000Z',
      finishedAt: '2026-11-04T09:00:01.000Z',
      recordsSeen: 5,
      recordsApplied: 3,
      recordsFlagged: 1,
      recordsSkipped: 1,
      notes: ['ZZ-999: no vehicle with this callsign, record skipped'],
      error: null,
    },
  ],
};

function setup() {
  const send = vi.fn(async () => ({}));
  const api = {
    me: async (o: string | null) => me(o),
    readyz: async () => ({ status: 'ready' as const }),
    get: async (p: string) => (p.startsWith('/api/v1/integrations') ? listing : { data: [] }),
    send,
  } as unknown as ApiClient;
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
  return send;
}

describe('integrations panel (mock)', () => {
  it('says plainly that everything is mock and shows recent runs with their notes', async () => {
    setup();
    await userEvent.click(await screen.findByRole('tab', { name: 'Integrations' }));
    expect(await screen.findByRole('note')).toHaveTextContent(/Mock integrations only/);
    expect(await screen.findByText(/ZZ-999: no vehicle/)).toBeInTheDocument();
    expect(screen.getByText(/3 applied, 1 flagged, 1 skipped of 5/)).toBeInTheDocument();
  });

  it('connects an adapter and runs a mock sync, asking for faulty records when ticked', async () => {
    const send = setup();
    await userEvent.click(await screen.findByRole('tab', { name: 'Integrations' }));
    const payroll = await screen.findByRole('listitem', { name: 'Payroll export' });
    await userEvent.click(within(payroll).getByRole('button', { name: 'Connect (mock)' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/integrations/PAYROLL/connect', ORG, {}),
    );
    await userEvent.click(screen.getByLabelText(/Include faulty records/));
    const tel = screen.getByRole('listitem', { name: 'Vehicle telematics' });
    await userEvent.click(within(tel).getByRole('button', { name: 'Run mock sync' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/integrations/TELEMATICS/sync', ORG, {
        scenario: 'faults',
      }),
    );
  });
});
