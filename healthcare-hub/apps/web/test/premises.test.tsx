import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ADMIN_LOC = '01900000-0000-7000-8000-000000000012';
const ME = '01900000-0000-7000-8000-000000000101';

const me = (orgId: string | null): MeResponse => ({
  user: { id: ME, email: 'm@example.test', displayName: 'Manager' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Org',
      locationId: null,
      roleKey: 'FLEET_PREMISES_LEAD',
      roleName: 'Lead',
    },
  ],
  permissions: ['premises.item.view', 'premises.item.manage'],
  activeOrganisationId: orgId,
  mfa: { required: false, satisfied: true },
});

function setup() {
  const send = vi.fn(async () => ({}));
  const api = {
    me: async (o: string | null) => me(o),
    readyz: async () => ({ status: 'ready' as const }),
    get: async (p: string) =>
      p.endsWith('/history')
        ? { data: [] }
        : p.includes('/locations')
          ? { data: [{ id: ADMIN_LOC, name: 'Head office', type: 'ADMIN_ONLY' }] }
          : p.includes('premises-items')
            ? {
                data: [
                  {
                    id: '1',
                    locationId: ADMIN_LOC,
                    controlArea: 'WATER',
                    title: 'Water risk assessment',
                    responsibleUserId: ME,
                    actionOwnerUserId: null,
                    contractorName: 'Synthetic Water Ltd',
                    assessmentRef: 'WRA-1',
                    assessedOn: '2026-09-15',
                    frequencySource: 'Competent person',
                    evidenceCount: 2,
                    requirementInstanceId: '01900000-0000-7000-8000-000000000999',
                    applicable: true,
                    status: 'AMBER',
                    reasonText: 'Due soon',
                    nextDue: '2026-12-01',
                  },
                ],
              }
            : { data: [] },
    send,
  } as unknown as ApiClient;
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/premises'] })} />);
  return send;
}

describe('premises register (HSE-01)', () => {
  it('shows contractor, assessment, evidence count and next due', async () => {
    setup();
    const row = await screen.findByRole('row', { name: /Water risk assessment/ });
    expect(row).toHaveTextContent('Synthetic Water Ltd');
    expect(row).toHaveTextContent('WRA-1 (15 Sep 2026)');
    expect(row).toHaveTextContent('2 documents');
    expect(row).toHaveTextContent('1 Dec 2026');
  });

  it('asks for confirmation before an infection-control item at an administration-only location', async () => {
    const send = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Add premises item' }));
    await userEvent.selectOptions(screen.getByLabelText('Location'), ADMIN_LOC);
    await userEvent.selectOptions(screen.getByLabelText('Control area'), 'COSHH_INFECTION');
    const save = screen.getByRole('button', { name: 'Save item' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Item'), 'Spill kit check');
    await userEvent.type(screen.getByLabelText(/Frequency source/), 'Manufacturer instructions');
    await userEvent.click(screen.getByLabelText(/I confirm infection-control items apply here/));
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(send).toHaveBeenCalled());
    const body = (send.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
    expect(body).toMatchObject({ controlArea: 'COSHH_INFECTION', confirmClinicalControl: true });
  });

  it('J1: records a finding as an action with a deadline', async () => {
    const send = setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Record a finding on Water risk assessment' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Record a finding on Water risk assessment',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Create action' });
    await userEvent.type(
      within(dialog).getByLabelText(/What was found/),
      'Dead leg on second floor needs removing',
    );
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Deadline'), '2026-12-15');
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/premises-items/1/findings', ORG, {
        title: 'Dead leg on second floor needs removing',
        deadline: '2026-12-15',
      }),
    );
  });

  it('J1: shows the item history', async () => {
    setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'History of Water risk assessment' }),
    );
    expect(
      await screen.findByRole('table', { name: 'Changes to Water risk assessment' }),
    ).toBeInTheDocument();
  });
});
