import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const VEH = '01900000-0000-7000-8000-000000000301';
const BASE_A = '01900000-0000-7000-8000-000000000201';
const BASE_B = '01900000-0000-7000-8000-000000000202';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'f@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank Patient Transport',
      locationId: null,
      roleKey: 'FLEET_LEAD',
      roleName: 'Fleet lead',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
const vehicle = (over: object = {}) => ({
  id: VEH,
  callsign: 'AMB-03',
  registration: 'AB12CDE',
  type: 'AMBULANCE',
  baseLocationId: BASE_A,
  seats: 4,
  wheelchairCapacity: 1,
  stretcher: true,
  currentOdometer: 42000,
  openDefects: 0,
  status: 'AVAILABLE',
  statusReason: null,
  offRoad: false,
  quarantined: false,
  licenceCategory: 'C1',
  version: 2,
  maintenance: [
    {
      id: 'm1',
      title: 'Annual service',
      intervalDays: 365,
      intervalMiles: null,
      dueDate: '2027-01-01',
      dueOdometer: null,
      state: 'OK',
      by: 'DATE',
      text: 'Due 1 Jan 2027',
    },
  ],
  readings: [],
  locations: [],
  capability: { stretcher: true, wheelchairCapacity: 1, clinicalKit: true, lost: [] },
  ...over,
});
const history = {
  data: [
    {
      id: 'h1',
      flag: 'OFF_ROAD',
      on: true,
      reason: 'Brake warning light',
      jobsReleased: 2,
      changedBy: 'u1',
      changedByName: 'Sam Fleet',
      changedAt: '2026-11-02T09:30:00Z',
    },
  ],
};

function renderVehicle(permissions: string[], v = vehicle(), readiness: object = {}) {
  const send = vi.fn(async () => ({}));
  const get = vi.fn(async (p: string) => {
    if (p === `/api/v1/vehicles/${VEH}`) return v;
    if (p.endsWith('/status-history')) return history;
    if (p.includes('/readiness?')) return readiness;
    if (p.endsWith('/locations'))
      return {
        data: [
          { id: BASE_A, name: 'North base' },
          { id: BASE_B, name: 'South base' },
        ],
      };
    return { data: [] };
  });
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: get as ApiClient['get'],
    send: send as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [`/vehicles/${VEH}`] })} />);
  return { send, get };
}
beforeEach(() => sessionStorage.clear());

const FLEET = ['fleet.vehicle.view', 'fleet.vehicle.manage', 'fleet.return_to_service'];

describe('vehicle operations (task 26)', () => {
  it('takes a vehicle off the road with a reason and shows the history', async () => {
    const { send } = renderVehicle(FLEET);
    await userEvent.click(await screen.findByRole('tab', { name: 'Status and readiness' }));
    const table = await screen.findByRole('table', { name: 'Status history' });
    const row = await within(table).findByRole('row', { name: /Brake warning light/ });
    expect(row).toHaveTextContent('Off the road started');
    expect(row).toHaveTextContent('Sam Fleet');
    await userEvent.click(screen.getByRole('button', { name: 'Take AMB-03 off the road' }));
    const dialog = screen.getByRole('dialog', { name: 'Take AMB-03 off the road' });
    expect(dialog).toHaveTextContent('go back to the planner');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Windscreen cracked');
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Why is it off the road?'),
      'AWAITING_PARTS',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/vehicles/${VEH}/off-road`, ORG, {
        on: true,
        reason: 'Windscreen cracked',
        reasonCode: 'AWAITING_PARTS',
      }),
    );
  });

  it('return to service is offered only with that permission', async () => {
    renderVehicle(
      ['fleet.vehicle.view', 'fleet.vehicle.manage'],
      vehicle({ offRoad: true, status: 'OFF_ROAD', statusReason: 'Taken off the road by fleet' }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Status and readiness' }));
    expect(await screen.findByText(/Returning a vehicle to service needs/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Put AMB-03 back on the road' })).toBeNull();
  });

  it('moves the base and checks readiness for a window', async () => {
    const { send, get } = renderVehicle(FLEET, vehicle(), {
      vehicleId: VEH,
      state: 'BLOCKED',
      checks: [
        {
          code: 'VEHICLE_STATUS',
          group: 'VEHICLE',
          result: 'FAIL',
          reasonText: 'Vehicle is off the road',
          overridable: false,
        },
      ],
      capability: { stretcher: true, wheelchairCapacity: 1, clinicalKit: true, lost: [] },
    });
    await userEvent.click(await screen.findByRole('tab', { name: 'Status and readiness' }));
    expect(await screen.findByText('North base')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move AMB-03 to another base' }));
    const dialog = screen.getByRole('dialog', { name: 'Move AMB-03 to another base' });
    await userEvent.selectOptions(within(dialog).getByLabelText('New base'), BASE_B);
    await userEvent.type(within(dialog).getByRole('textbox'), 'Covering the south rota');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move vehicle' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/vehicles/${VEH}/move`, ORG, {
        locationId: BASE_B,
        reason: 'Covering the south rota',
      }),
    );
    const form = screen.getByRole('form', { name: 'Check readiness of AMB-03' });
    await userEvent.click(within(form).getByRole('button', { name: 'Check readiness' }));
    expect(await screen.findByText(/^Result:/)).toHaveTextContent('Blocked');
    const checks = screen.getByRole('table', { name: 'Vehicle readiness checks' });
    expect(within(checks).getByRole('row', { name: /off the road/ })).toHaveTextContent('Fail');
    expect(get).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/api/v1/vehicles/${VEH}/readiness\\?from=`)),
      ORG,
    );
  });

  it('records a service as done from the maintenance table', async () => {
    const { send } = renderVehicle(FLEET);
    const row = await screen.findByRole('row', { name: /Annual service/ });
    await userEvent.click(
      within(row).getByRole('button', { name: 'Record service done for Annual service' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Record service done for Annual service' });
    await userEvent.type(within(dialog).getByLabelText('Odometer (miles)'), '43000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record service' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        `/api/v1/vehicles/${VEH}/maintenance/m1/done`,
        ORG,
        expect.objectContaining({ odometer: 43000 }),
      ),
    );
  });

  it('D2: the fleet lead corrects a flagged odometer reading with a reason', async () => {
    const flagged = {
      id: 'r1',
      reading: 4200,
      readOn: '2026-11-03',
      source: 'VDI',
      flags: ['ODOMETER_DECREASED'],
      review: null,
    };
    const { send } = renderVehicle(FLEET, vehicle({ readings: [flagged] }));
    const table = await screen.findByRole('table', { name: /odometer/i });
    expect(within(table).getByText(/needs a fleet review/)).toBeInTheDocument();
    await userEvent.click(
      within(table).getByRole('button', { name: 'Review the 3 Nov 2026 reading of AMB-03' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Review the 3 Nov 2026 reading of AMB-03' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Decision'), 'CORRECTED');
    await userEvent.type(within(dialog).getByLabelText('Correct reading (miles)'), '42100');
    await userEvent.type(within(dialog).getByLabelText(/Why\?/), 'Driver missed a digit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/vehicles/${VEH}/odometer/r1/review`, ORG, {
        decision: 'CORRECTED',
        correctedReading: 42100,
        reason: 'Driver missed a digit',
      }),
    );
  });

  it('D5: a base move can be backdated', async () => {
    const { send } = renderVehicle(FLEET);
    await userEvent.click(await screen.findByRole('tab', { name: 'Status and readiness' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Move AMB-03 to another base' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Move AMB-03 to another base' });
    await userEvent.selectOptions(within(dialog).getByLabelText('New base'), BASE_B);
    const date = within(dialog).getByLabelText('Takes effect on');
    await userEvent.clear(date);
    await userEvent.type(date, '2026-11-01');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Moved last week');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move vehicle' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/vehicles/${VEH}/move`, ORG, {
        locationId: BASE_B,
        reason: 'Moved last week',
        effectiveOn: '2026-11-01',
      }),
    );
  });
});
