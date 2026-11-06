import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'm@example.test', displayName: 'Dev' },
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
const risk = {
  id: 'r1',
  code: 'RSK-1',
  hazard: 'Manual handling on stairs',
  peopleAffected: 'Crew and patients',
  inherent: { likelihood: 4, impact: 4, score: 16, rating: 'HIGH' },
  residual: { likelihood: 2, impact: 4, score: 8, rating: 'MEDIUM' },
  controls: 'Carry chairs',
  ownerUserId: 'u3',
  ownerName: 'Sam Manager',
  reviewDate: '2026-10-15',
  reviewOverdue: true,
  locationId: null,
  status: 'OPEN',
  linkedEventIds: ['e1'],
  linkedEvents: [{ id: 'e1', code: 'EVT-4', title: 'Fall on stairs' }],
  openActions: 2,
  version: 3,
};
const closedRisk = { ...risk, id: 'r2', code: 'RSK-2', hazard: 'Old hazard', status: 'CLOSED' };
const action = {
  id: 'a1',
  code: 'ACT-1',
  sourceType: 'RISK',
  sourceId: 'r1',
  kind: 'ACTION',
  title: 'Fit stair chairs',
  severity: 'MEDIUM',
  ownerUserId: ME,
  ownerName: 'Dev',
  deadline: '2026-10-20',
  status: 'OPEN',
  evidenceItemIds: [],
  verifierUserId: null,
  verifiedAt: null,
  reauditRunId: null,
  overdue: true,
  history: [],
  version: 2,
};
const people = [
  { id: ME, displayName: 'Dev', roleKeys: [], roleNames: ['Manager'], locationIds: [] },
  { id: 'u3', displayName: 'Sam Manager', roleKeys: [], roleNames: ['Manager'], locationIds: [] },
];

function renderTab(tab: string, permissions: string[]) {
  const send = vi.fn(async () => ({}));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) =>
      p === '/api/v1/risks'
        ? { data: [risk, closedRisk] }
        : p === '/api/v1/actions'
          ? { data: [action] }
          : p === '/api/v1/admin/people'
            ? { data: people }
            : { data: [] },
    send,
  };
  render(
    <App api={api} history={createMemoryHistory({ initialEntries: [`/compliance?tab=${tab}`] })} />,
  );
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('risk register [task 12]', () => {
  it('shows ratings, owner, overdue review and links in words; closed risks are hidden', async () => {
    renderTab('risks', ['compliance.audit.view']);
    const row = await screen.findByRole('row', { name: /RSK-1 Manual handling on stairs/ });
    expect(row).toHaveTextContent('Red – High (4 × 4 = 16)');
    expect(row).toHaveTextContent('Amber – Medium (2 × 4 = 8)');
    expect(row).toHaveTextContent('Sam Manager');
    expect(row).toHaveTextContent('Red – Review overdue – was due 15 Oct 2026');
    expect(within(row).getByRole('link', { name: 'EVT-4' })).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '2 open' })).toBeInTheDocument();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('row', { name: /RSK-2/ })).toBeNull();
    await userEvent.click(screen.getByLabelText('Show closed risks'));
    expect(screen.getByRole('row', { name: /RSK-2 Old hazard/ })).toHaveTextContent('Closed');
  });

  it('a manager adds a risk with 1–5 scores', async () => {
    const { send } = renderTab('risks', ['compliance.risk.manage']);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a risk' }));
    const form = screen.getByRole('form', { name: 'Add a risk' });
    await userEvent.type(within(form).getByLabelText('Hazard or risk'), 'Slippery ramps');
    await userEvent.type(within(form).getByLabelText('Who could be harmed'), 'Crew');
    await userEvent.selectOptions(within(form).getByLabelText('Likelihood before controls'), '4');
    await userEvent.type(within(form).getByLabelText('Controls in place'), 'Grit in winter');
    await userEvent.selectOptions(within(form).getByLabelText('Impact with controls'), '2');
    fireEvent.change(within(form).getByLabelText('Review by'), { target: { value: '2027-01-31' } });
    await userEvent.click(within(form).getByRole('button', { name: 'Add risk' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/risks', ORG, {
        hazard: 'Slippery ramps',
        peopleAffected: 'Crew',
        inherentLikelihood: 4,
        inherentImpact: 3,
        controls: 'Grit in winter',
        residualLikelihood: 3,
        residualImpact: 2,
        ownerUserId: ME,
        reviewDate: '2027-01-31',
      }),
    );
  });

  it('a review needs a new review date and sends the version', async () => {
    const { send } = renderTab('risks', ['compliance.risk.manage']);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review RSK-1 Manual handling on stairs' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Review RSK-1 Manual handling on stairs' });
    const save = within(dialog).getByRole('button', { name: 'Save review' });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Likelihood with controls'), '1');
    fireEvent.change(within(dialog).getByLabelText('Next review by'), {
      target: { value: '2027-02-01' },
    });
    await userEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/risks/r1',
        ORG,
        {
          controls: 'Carry chairs',
          residualLikelihood: 1,
          residualImpact: 4,
          ownerUserId: 'u3',
          reviewDate: '2027-02-01',
        },
        3,
      ),
    );
  });

  it('raises an action from a risk and warns when closing with open actions', async () => {
    const { send } = renderTab('risks', ['compliance.risk.manage']);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Raise an action for RSK-1 Manual handling on stairs',
      }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('What needs to be done'), 'Buy chairs');
    fireEvent.change(within(dialog).getByLabelText('Deadline'), {
      target: { value: '2026-12-01' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Raise action' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/risks/r1/actions', ORG, {
        title: 'Buy chairs',
        ownerUserId: 'u3',
        deadline: '2026-12-01',
      }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Close RSK-1 Manual handling on stairs' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Close RSK-1 Manual handling on stairs' }),
    ).toHaveTextContent('still has 2 open action(s)');
  });
});

describe('actions table [task 12]', () => {
  it('shows owner names and overdue deadlines in words', async () => {
    renderTab('actions', ['compliance.audit.view']);
    const row = await screen.findByRole('row', { name: /ACT-1 Fit stair chairs/ });
    expect(row).toHaveTextContent('Dev (you)');
    expect(row).toHaveTextContent('Red – Overdue – was due 20 Oct 2026');
    expect(within(row).queryByRole('button', { name: /Change owner or deadline/ })).toBeNull();
  });

  it('a manager reassigns an action with a reason', async () => {
    const { send } = renderTab('actions', ['compliance.audit.view', 'compliance.action.manage']);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Change owner or deadline for ACT-1 Fit stair chairs',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Change ACT-1 Fit stair chairs' });
    const save = within(dialog).getByRole('button', { name: 'Save change' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Owner'), 'u3');
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'Sam leads manual handling');
    await userEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/actions/a1',
        ORG,
        { ownerUserId: 'u3', reason: 'Sam leads manual handling' },
        2,
      ),
    );
  });
});
