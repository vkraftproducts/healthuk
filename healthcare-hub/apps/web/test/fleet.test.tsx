import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const VEH = '01900000-0000-7000-8000-000000000301';
const ME = '01900000-0000-7000-8000-000000000101';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'f@example.test', displayName: 'Dev' },
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
  subjectLabel: 'AMB-03',
  severity: 'CRITICAL',
  stopUse: true,
  description: 'Ramp hinge cracked',
  reportedByName: 'Alex Crew',
  discoveredAt: '2026-10-30T08:00:00Z',
  status: 'REPAIRED',
  repairDue: 'DONE',
  repairedBy: 'u9',
  repairedByName: 'Pat Repairer',
  repairedAt: '2026-10-31T10:00:00Z',
  release: null,
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
    const { send } = renderAt('/vehicles', ['fleet.vehicle.view', 'fleet.return_to_service'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    await userEvent.click(await screen.findByRole('button', { name: /Return to service/ }));
    const dialog = await screen.findByRole('dialog', {
      name: /^Return to service: .*Ramp hinge cracked$/,
    });
    await userEvent.type(
      within(dialog).getByLabelText(/What was checked after the repair/),
      'Ramp load-tested after repair',
    );
    const confirm = within(dialog).getByRole('button', { name: 'Return to service' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /I have checked the repair/ }),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/defects/d1/release', ORG, {
        reason: 'Ramp load-tested after repair',
      }),
    );
  });

  it('the person who signed off the repair is told someone else must release it', async () => {
    const mine = { ...defect, repairedBy: ME, repairedByName: 'Dev' };
    renderAt('/vehicles', ['fleet.vehicle.view', 'fleet.return_to_service'], (p) =>
      p.startsWith('/api/v1/defects') ? { data: [mine] } : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Repaired – awaiting return to service');
    expect(row).toHaveTextContent('Signed off by Dev, 31 Oct 2026');
    expect(row).toHaveTextContent('Someone other than the repairer must return it to service.');
    expect(within(row).queryByRole('button', { name: /Return to service/ })).toBeNull();
    expect(within(row).getByRole('button', { name: /Send back for repair/ })).toBeInTheDocument();
  });

  it('signing off a repair asks what was repaired and sends it with the version', async () => {
    const open = {
      ...defect,
      status: 'REPAIRING',
      repairDue: 'NONE',
      repairedBy: null,
      repairedByName: null,
      repairedAt: null,
    };
    const { send } = renderAt('/vehicles', ['fleet.vehicle.view', 'fleet.defect.manage'], (p) =>
      p.startsWith('/api/v1/defects') ? { data: [open] } : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Being repaired');
    expect(row).toHaveTextContent('Repair before use');
    await userEvent.click(within(row).getByRole('button', { name: /Sign off repair/ }));
    const dialog = await screen.findByRole('dialog', { name: /Sign off repair/ });
    expect(dialog).toHaveTextContent('Signing off does not put it back into service');
    const confirm = within(dialog).getByRole('button', { name: 'Sign off repair' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/What was repaired/), 'Hinge replaced');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/defects/d1',
        ORG,
        { status: 'REPAIRED', repairNotes: 'Hinge replaced' },
        3,
      ),
    );
  });

  it('an unclassified minor defect must be classified with a deadline before repair', async () => {
    const minor = {
      ...defect,
      severity: 'MINOR',
      stopUse: false,
      status: 'OPEN',
      classifiedBy: null,
      repairDeadline: null,
      repairDue: 'NONE',
    };
    const { send } = renderAt('/vehicles', ['fleet.vehicle.view', 'fleet.defect.manage'], (p) =>
      p.startsWith('/api/v1/defects') ? { data: [minor] } : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Grey – Not classified – needs a repair deadline');
    expect(within(row).queryByRole('button', { name: /Sign off repair/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /Start repair/ })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /Classify/ }));
    const dialog = await screen.findByRole('dialog', { name: /Classify defect/ });
    const save = within(dialog).getByRole('button', { name: 'Save classification' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Repair deadline/), {
      target: { value: '2026-11-20' },
    });
    await userEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/defects/d1',
        ORG,
        { severity: 'MINOR', repairDeadline: '2026-11-20' },
        3,
      ),
    );
  });

  it('an overdue repair deadline is shown in words, with the UK date', async () => {
    const late = {
      ...defect,
      severity: 'MAJOR',
      stopUse: false,
      status: 'OPEN',
      classifiedBy: 'u2',
      repairDeadline: '2026-11-01',
      repairDue: 'OVERDUE',
    };
    renderAt('/vehicles', ['fleet.vehicle.view'], (p) =>
      p.startsWith('/api/v1/defects') ? { data: [late] } : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Red – Overdue – was due 1 Nov 2026');
    expect(row).toHaveTextContent('AMB-03');
  });

  it('sending a repair back asks what is still wrong and calls reopen', async () => {
    const { send } = renderAt(
      '/vehicles',
      ['fleet.vehicle.view', 'fleet.return_to_service'],
      (p) => (p.startsWith('/api/v1/defects') ? { data: [defect] } : { data: [] }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    await userEvent.click(await screen.findByRole('button', { name: /Send back for repair/ }));
    const dialog = await screen.findByRole('dialog', { name: /Send back for repair/ });
    await userEvent.type(within(dialog).getByLabelText(/What is still wrong/), 'Ramp still drops');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send back' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/defects/d1/reopen', ORG, {
        reason: 'Ramp still drops',
      }),
    );
  });

  it('released defects can be listed with who returned them to service', async () => {
    const released = {
      ...defect,
      status: 'RELEASED',
      repairDue: 'DONE',
      release: {
        releasedBy: 'u3',
        releasedByName: 'Sam Fleet',
        reason: 'Load-tested',
        evidenceItemId: null,
        at: '2026-11-01T09:30:00Z',
      },
    };
    const get = vi.fn((p: string) =>
      p.includes('status=RELEASED') ? { data: [released] } : { data: [] },
    );
    renderAt('/vehicles', ['fleet.vehicle.view'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    await userEvent.selectOptions(await screen.findByLabelText('Show'), 'RELEASED');
    const row = await screen.findByRole('row', { name: /Ramp hinge/ });
    expect(row).toHaveTextContent('Returned to service');
    expect(row).toHaveTextContent('By Sam Fleet, 1 Nov 2026, 09:30: Load-tested');
    expect(get).toHaveBeenCalledWith('/api/v1/defects?status=RELEASED');
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

  it('finding 21: no fuel and expenses tab without an expense permission', async () => {
    renderAt('/vehicles', ['fleet.vehicle.view'], () => ({ data: [] }));
    expect(await screen.findByRole('tab', { name: 'Vehicles' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Fuel and expenses' })).toBeNull();
  });

  it('D4: reports a critical defect and lists the jobs sent back', async () => {
    const send = vi.fn(async () => ({
      ...defect,
      status: 'OPEN',
      affectedJobCodes: ['J-0042'],
    }));
    renderAt(
      '/vehicles',
      ['fleet.vehicle.view', 'fleet.defect.create'],
      (p) => (p.startsWith('/api/v1/vehicles') ? { data: [vehicle] } : { data: [] }),
      send,
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Defects' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Report a defect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report a defect' });
    await within(dialog).findByRole('option', { name: 'AMB-03' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Vehicle'), VEH);
    await userEvent.selectOptions(within(dialog).getByLabelText('Severity'), 'CRITICAL');
    expect(within(dialog).getByRole('checkbox', { name: /Stop use now/ })).toBeChecked();
    await userEvent.type(within(dialog).getByLabelText('What is wrong?'), 'Ramp hinge cracked');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Report defect' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/defects', ORG, {
        vehicleId: VEH,
        severity: 'CRITICAL',
        stopUse: true,
        description: 'Ramp hinge cracked',
        photoEvidenceItemIds: [],
      }),
    );
    expect(await screen.findByText(/Jobs sent back for reassignment: J-0042/)).toBeInTheDocument();
  });
});
