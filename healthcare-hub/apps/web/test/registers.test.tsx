import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
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
const claim = (o: Record<string, unknown>) => ({
  id: 'e1',
  vehicleId: 'v1',
  vehicleLabel: 'AMB-03 (AB12CDE)',
  submittedBy: 'u7',
  submittedByName: 'Alex Morgan',
  spentOn: '2026-11-02',
  category: 'FUEL',
  odometer: null,
  quantity: 40,
  unit: 'LITRES',
  amountPence: 6210,
  currency: 'GBP',
  supplier: null,
  receiptEvidenceItemId: null,
  duplicateOf: null,
  status: 'SUBMITTED',
  decidedBy: null,
  decidedByName: null,
  decisionNote: null,
  version: 1,
  ...o,
});
const asset = {
  id: 'a1',
  assetTag: 'STR-04',
  category: 'STRETCHER',
  model: 'Synthetic 2000',
  serial: null,
  manufacturer: 'MockCo',
  swlKg: 227,
  vehicleId: null,
  locationId: null,
  capability: 'STRETCHER',
  status: 'AVAILABLE',
  quarantineReason: null,
  regimes: [],
  version: 1,
};
const template = (id: string, title: string, subjectType: string, status = 'EFFECTIVE') => ({
  id,
  code: id,
  title,
  pack: 'ORG',
  isLibrary: false,
  versions: [{ id: `${id}v`, status, subjectType }],
});

function renderFleet(permissions: string[], data: Record<string, unknown[]>) {
  const send = vi.fn(async () => ({}));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => ({ data: data[p.split('?')[0]!] ?? [], nextCursor: null }),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/vehicles'] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('registers and forms [task 15]', () => {
  it('the expense register shows names and UK dates, and a rejection needs a reason', async () => {
    const { send } = renderFleet(['fleet.vehicle.view', 'fleet.expense.approve'], {
      '/api/v1/fuel-expenses': [claim({})],
    });
    await userEvent.click(await screen.findByRole('tab', { name: 'Fuel and expenses' }));
    const row = await screen.findByRole('row', { name: /AMB-03/ });
    expect(row).toHaveTextContent('2 Nov 2026');
    expect(row).toHaveTextContent('Alex Morgan');
    expect(row).toHaveTextContent('Amber – Awaiting approval');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Reject: Fuel £62.10 on 2 Nov 2026' }),
    );
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject claim' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'No receipt attached');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/fuel-expenses/e1/approve', ORG, {
        decision: 'REJECTED',
        note: 'No receipt attached',
      }),
    );
  });

  it('nobody is offered approval of their own claim', async () => {
    renderFleet(['fleet.vehicle.view', 'fleet.expense.approve'], {
      '/api/v1/fuel-expenses': [claim({ submittedBy: ME, submittedByName: 'Dev' })],
    });
    await userEvent.click(await screen.findByRole('tab', { name: 'Fuel and expenses' }));
    const row = await screen.findByRole('row', { name: /AMB-03/ });
    expect(row).toHaveTextContent('Someone else must approve your claim.');
    expect(within(row).queryByRole('button', { name: /^Approve/ })).toBeNull();
  });

  it('a crew member without vehicle access is sent to the crew app, not the register', async () => {
    renderFleet(['fleet.expense.submit'], { '/api/v1/fuel-expenses': [claim({})] });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not give access to this page.',
    );
    expect(screen.queryByRole('tab', { name: 'Vehicles' })).toBeNull();
  });

  it('equipment without a regime is "not set up", and a regime uses a published template', async () => {
    const { send } = renderFleet(['fleet.vehicle.view', 'fleet.vehicle.manage'], {
      '/api/v1/equipment': [asset],
      '/api/v1/requirements/templates': [
        template('t1', 'LOLER thorough examination (6 monthly)', 'EQUIPMENT'),
        template('t2', 'MOT', 'VEHICLE'),
        template('t3', 'Draft service', 'EQUIPMENT', 'DRAFT'),
      ],
    });
    await userEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    const row = await screen.findByRole('row', { name: /STR-04/ });
    expect(row).toHaveTextContent('No inspection regime set up');
    expect(screen.getByRole('form', { name: 'Add equipment' })).toBeInTheDocument();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Add inspection regime to STR-04' }),
    );
    const dialog = screen.getByRole('dialog');
    const pick = within(dialog).getByLabelText('Requirement it follows');
    await waitFor(() =>
      expect(
        within(pick)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([
        'Choose a published equipment requirement',
        'LOLER thorough examination (6 monthly)',
      ]),
    );
    await userEvent.selectOptions(within(dialog).getByLabelText('Regime'), 'LOLER_THOROUGH');
    await userEvent.selectOptions(pick, 't1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add regime' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/equipment/a1/regimes', ORG, {
        regime: 'LOLER_THOROUGH',
        templateId: 't1',
      }),
    );
  });
});
