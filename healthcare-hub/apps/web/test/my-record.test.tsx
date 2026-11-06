import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { addDays, londonDate } from '@hub/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000107';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'crew@example.test', displayName: 'Alex' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank Patient Transport',
      locationId: null,
      roleKey: 'CREW',
      roleName: 'Crew member',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});

const requirement = (over: Record<string, unknown>) => ({
  id: '01900000-0000-7000-8000-0000000000d1',
  templateTitle: 'Manual handling training',
  deadlineKind: 'DUE',
  dueDate: '2026-12-01',
  expiryDate: null,
  reviewDate: null,
  status: 'AMBER',
  reasonText: 'Due soon',
  required: true,
  version: 1,
  ...over,
});
const myRecord = {
  profile: {
    id: '01900000-0000-7000-8000-0000000000e1',
    staffNo: 'ST-0042',
    displayName: 'Alex Synthetic',
    lifecycleState: 'ACTIVE',
    roles: ['DRIVER', 'CARE_ASSISTANT'],
    activeRestrictions: [],
    jobTitle: 'Ambulance care assistant',
  },
  requirements: [
    requirement({}),
    requirement({
      id: '01900000-0000-7000-8000-0000000000d2',
      templateTitle: 'Driving licence check',
      deadlineKind: 'EXPIRY',
      dueDate: null,
      expiryDate: '2027-03-01',
      status: 'GREEN',
      reasonText: 'Verified',
    }),
  ],
  corrections: [
    {
      id: 'c1',
      field: 'phone',
      proposedValue: '07700 900000',
      reason: 'New number',
      status: 'OPEN',
      decisionNote: null,
      createdAt: '2026-11-02T10:00:00.000Z',
      version: 1,
    },
  ],
};
const supervisionRequest = {
  id: '01900000-0000-7000-8000-0000000000f1',
  staffId: myRecord.profile.id,
  staffName: 'Alex Synthetic',
  kind: 'SUPERVISION',
  instanceId: null,
  requirementTitle: null,
  currentDate: null,
  proposedDate: '2026-11-20',
  supervisorUserId: null,
  supervisorName: null,
  reason: 'Training plan',
  status: 'OPEN',
  decisionNote: null,
  bookedFor: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  version: 2,
};

function renderMe(permissions: string[], extra: (p: string) => unknown = () => undefined) {
  const send = vi.fn(async (..._a: unknown[]) => ({}));
  const gets: string[] = [];
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => {
      gets.push(p);
      const x = extra(p);
      if (x !== undefined) return x;
      if (p === '/api/v1/staff/me') return myRecord;
      if (p === '/api/v1/staff/me/requests') return { data: [supervisionRequest] };
      if (p.startsWith('/api/v1/staff/me/readiness'))
        return {
          staffId: myRecord.profile.id,
          role: 'DRIVER',
          state: 'BLOCKED',
          checks: [
            {
              code: 'LICENCE',
              group: 'STAFF_REQUIREMENTS',
              result: 'FAIL',
              reasonText: 'Driving licence expires during the window',
              overridable: false,
            },
          ],
          restrictions: [],
        };
      return { data: [] };
    },
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/me'] })} />);
  return { send, gets };
}
beforeEach(() => sessionStorage.clear());

const SELF = ['staff.self.view', 'staff.self.update'];

describe('My record [task 25]', () => {
  it('shows the record and offers a date change only for dates that are not expiries', async () => {
    renderMe(SELF);
    expect(await screen.findByRole('heading', { name: 'My record' })).toBeInTheDocument();
    expect(screen.getByText('Driver, Care assistant')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'My requirements' });
    expect(within(table).getByText('Due: 1 Dec 2026')).toBeInTheDocument();
    expect(
      within(table).getByRole('button', {
        name: 'Ask to change the date for Manual handling training',
      }),
    ).toBeInTheDocument();
    expect(
      within(table).queryByRole('button', {
        name: 'Ask to change the date for Driving licence check',
      }),
    ).not.toBeInTheDocument();
    expect(
      within(table).getByRole('button', { name: 'Request a review of Driving licence check' }),
    ).toBeInTheDocument();
  });

  it('asks for a date change through a dialog with a reason', async () => {
    const { send } = renderMe(SELF);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Ask to change the date for Manual handling training',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Send request' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('New date'), '2026-12-15');
    await userEvent.type(
      within(dialog).getByLabelText(/Why does the date need to change/),
      'On annual leave that week',
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/staff/me/requests', ORG, {
        kind: 'DUE_DATE_CHANGE',
        instanceId: '01900000-0000-7000-8000-0000000000d1',
        proposedDate: '2026-12-15',
        reason: 'On annual leave that week',
      }),
    );
  });

  it('checks readiness for a window and explains each check in words', async () => {
    const { gets } = renderMe(SELF);
    const form = await screen.findByRole('form', { name: 'Check my readiness' });
    await userEvent.click(within(form).getByRole('button', { name: 'Check readiness' }));
    const result = await screen.findByRole('status', { name: 'Readiness result' });
    expect(result).toHaveTextContent('Not ready');
    expect(result).toHaveTextContent('Not met – Driving licence expires during the window');
    expect(gets.some((p) => p.startsWith('/api/v1/staff/me/readiness?role=DRIVER'))).toBe(true);
  });

  it('books supervision and withdraws an open request with its version', async () => {
    const { send } = renderMe(SELF);
    const form = await screen.findByRole('form', { name: 'Book supervision' });
    const preferred = addDays(londonDate(new Date()), 7);
    await userEvent.type(within(form).getByLabelText('Preferred date'), preferred);
    await userEvent.type(
      within(form).getByLabelText('What would you like to talk about?'),
      'My training plan',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Request supervision' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/staff/me/requests', ORG, {
        kind: 'SUPERVISION',
        proposedDate: preferred,
        reason: 'My training plan',
      }),
    );
    const requests = screen.getByRole('table', { name: 'My requests' });
    expect(within(requests).getByText(/Waiting for a decision/)).toBeInTheDocument();
    await userEvent.click(within(requests).getByRole('button', { name: /^Withdraw Supervision/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        `/api/v1/staff/me/requests/${supervisionRequest.id}/withdraw`,
        ORG,
        {},
        2,
      ),
    );
  });

  it('hides the request buttons from a role that may only view', async () => {
    renderMe(['staff.self.view']);
    await screen.findByRole('table', { name: 'My requirements' });
    expect(screen.queryByRole('button', { name: /Request a review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Book supervision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upload a certificate/ })).not.toBeInTheDocument();
  });

  it('lets crew upload a certificate, which still needs someone else to verify it [82]', async () => {
    renderMe([...SELF, 'compliance.evidence.upload']);
    const table = await screen.findByRole('table', { name: 'My requirements' });
    await userEvent.click(
      within(table).getByRole('button', {
        name: 'Upload a certificate for Manual handling training',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Upload evidence for Manual handling training',
    });
    expect(within(dialog).getByRole('button', { name: 'Upload' })).toBeDisabled(); // no file yet
    expect(screen.getByText(/counts only once someone else has verified it/)).toBeInTheDocument();
  });
});
