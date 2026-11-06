import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { londonDate } from '@hub/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const DSR = '01900000-0000-7000-8000-000000000777';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'g@example.test', displayName: 'Dev' },
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
const disclosure = {
  id: 'd1',
  subjectRequestId: DSR,
  subjectRequestCode: 'DSR-0003',
  disclosedTo: 'Synthetic Police Force',
  purpose: 'Crime prevention request',
  lawfulBasis: 'Legal obligation (Article 6(1)(c))',
  dataDescription: 'Journey times for one booking reference',
  disclosedOn: '2026-11-02',
  recordedBy: 'u1',
  recordedByName: 'Gill Governance',
  recordedAt: '2026-11-02T10:15:00Z',
};
const run = {
  id: 'l1',
  category: 'PATIENT_CONTACT',
  action: 'ANONYMISE',
  cutoff: '2018-11-01',
  candidates: 12,
  affected: 10,
  held: 2,
  runAt: '2026-11-03T02:00:00Z',
};

function renderSettings() {
  const send = vi.fn(async () => ({}));
  const get = vi.fn(async (p: string) => {
    if (p.startsWith('/api/v1/disclosures')) return { data: [disclosure] };
    if (p.startsWith('/api/v1/retention-log')) return { data: [run] };
    if (p === '/api/v1/subject-requests')
      return { data: [{ id: DSR, code: 'DSR-0003', type: 'ACCESS' }] };
    return { data: [] };
  });
  const api: ApiClient = {
    me: async () => me(['privacy.manage']),
    readyz: async () => ({ status: 'ready' }),
    get: get as ApiClient['get'],
    send: send as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
  return { send, get };
}
beforeEach(() => sessionStorage.clear());

describe('data protection logs (task 27)', () => {
  it('lists disclosures with who recorded them and the linked request', async () => {
    renderSettings();
    await userEvent.click(await screen.findByRole('tab', { name: 'Data protection' }));
    const table = await screen.findByRole('table', { name: 'Disclosures' });
    const row = await within(table).findByRole('row', { name: /Synthetic Police Force/ });
    expect(row).toHaveTextContent('2 Nov 2026');
    expect(row).toHaveTextContent('DSR-0003');
    expect(row).toHaveTextContent('Gill Governance');
  });

  it('records a disclosure linked to a subject request', async () => {
    const { send } = renderSettings();
    await userEvent.click(await screen.findByRole('tab', { name: 'Data protection' }));
    const form = await screen.findByRole('form', { name: 'Record a disclosure' });
    await userEvent.type(
      within(form).getByLabelText('Shared with (organisation or role)'),
      'Synthetic Insurer',
    );
    await userEvent.type(within(form).getByLabelText('Purpose'), 'Claim handling');
    await userEvent.type(within(form).getByLabelText('Lawful basis'), 'Contract');
    await userEvent.type(
      within(form).getByLabelText(/What was shared/),
      'Incident date and vehicle callsign',
    );
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: 'DSR-0003 – Access' })).toBeInTheDocument(),
    );
    await userEvent.selectOptions(within(form).getByLabelText(/Linked subject request/), DSR);
    await userEvent.click(within(form).getByRole('button', { name: 'Record disclosure' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/disclosures', ORG, {
        disclosedTo: 'Synthetic Insurer',
        purpose: 'Claim handling',
        lawfulBasis: 'Contract',
        dataDescription: 'Incident date and vehicle callsign',
        disclosedOn: londonDate(new Date()),
        subjectRequestId: DSR,
      }),
    );
  });

  it('shows the retention log in words and filters by records category', async () => {
    const { get } = renderSettings();
    await userEvent.click(await screen.findByRole('tab', { name: 'Data protection' }));
    const table = await screen.findByRole('table', { name: 'Retention runs' });
    const row = await within(table).findByRole('row', { name: /Patient contact/ });
    expect(row).toHaveTextContent('Anonymised');
    expect(row).toHaveTextContent('1 Nov 2018');
    const filter = screen.getByRole('group', { name: 'Filter the retention log' });
    await userEvent.selectOptions(within(filter).getByLabelText('Records'), 'PATIENT_CONTACT');
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/v1/retention-log?category=PATIENT_CONTACT', ORG),
    );
  });
});
