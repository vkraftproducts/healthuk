import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const VEH = '01900000-0000-7000-8000-000000000301';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'f@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Exora',
      locationId: null,
      roleKey: 'X',
      roleName: 'X',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
const vehicle = {
  id: VEH,
  callsign: 'AMB-03',
  registration: 'AB12CDE',
  type: 'AMBULANCE',
  seats: 4,
  wheelchairCapacity: 1,
  stretcher: true,
  currentOdometer: 42000,
  openDefects: 1,
  status: 'BLOCKED',
  statusReason: '1 open stop-use defect',
  licenceCategory: 'C1',
  version: 2,
};
const defect = {
  id: 'd1',
  vehicleId: VEH,
  severity: 'CRITICAL',
  stopUse: true,
  description: 'Ramp hinge cracked',
  discoveredAt: '2026-10-30T08:00:00Z',
  status: 'REPAIRED',
  version: 3,
};

function renderAt(
  path: string,
  permissions: string[],
  get: (p: string) => unknown,
  send = vi.fn(async () => ({})),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('vehicles and assets', () => {
  it('shows a blocked vehicle with its reason in words', async () => {
    renderAt('/vehicles', ['fleet.vehicle.view'], (p) =>
      p.startsWith('/api/v1/vehicles') ? { data: [vehicle], nextCursor: null } : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /AMB-03/ });
    expect(row).toHaveTextContent('Red – Blocked – 1 open stop-use defect');
    expect(screen.queryByRole('heading', { name: 'Add a vehicle' })).toBeNull();
  });

  it('repaired defects offer return to service only to people allowed to release', async () => {
    const get = (p: string) =>
      p.startsWith('/api/v1/defects') ? { data: [defect] } : { data: [] };
    renderAt('/vehicles', ['fleet.vehicle.view'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Critical – stop use');
    expect(within(row).queryByRole('button', { name: 'Return to service' })).toBeNull();
  });

  it('releasing asks for the post-repair check and calls the release endpoint', async () => {
    const get = (p: string) =>
      p.startsWith('/api/v1/defects') ? { data: [defect] } : { data: [] };
    vi.spyOn(window, 'prompt').mockReturnValue('Ramp load-tested after repair');
    const { send } = renderAt('/vehicles', ['fleet.vehicle.view', 'fleet.return_to_service'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Return to service' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/defects/d1/release', ORG, {
        reason: 'Ramp load-tested after repair',
      }),
    );
  });

  it('vehicle page shows lost capability and maintenance status in words', async () => {
    renderAt(`/vehicles/${VEH}`, ['fleet.vehicle.view'], (p) =>
      p === `/api/v1/vehicles/${VEH}`
        ? {
            ...vehicle,
            maintenance: [
              {
                id: 'm1',
                title: 'Service',
                intervalDays: 365,
                intervalMiles: 10000,
                dueDate: '2027-01-01',
                dueOdometer: 50000,
                state: 'OVERDUE',
                by: 'MILEAGE',
                text: 'Service overdue by mileage (50100 mi, due at 50000 mi)',
              },
            ],
            readings: [],
            locations: [],
            capability: {
              stretcher: false,
              wheelchairCapacity: 1,
              clinicalKit: true,
              lost: ['Stretcher STR-1 unavailable'],
            },
          }
        : { data: [] },
    );
    expect(
      await screen.findByText(/Capability reduced: Stretcher STR-1 unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Service/ })).toHaveTextContent(
      'Red – Service overdue by mileage',
    );
  });
});
