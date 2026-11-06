import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const me = (permissions: string[]): MeResponse => ({
  user: {
    id: '01900000-0000-7000-8000-000000000105',
    email: 'g@example.test',
    displayName: 'Gina',
  },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Meadowbank Patient Transport',
      locationId: null,
      roleKey: 'GOVERNANCE_LEAD',
      roleName: 'Governance lead',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});

const alertItem = {
  key: 'REQUIREMENT:01900000-0000-7000-8000-0000000000a1',
  event: 'EXPIRY_WARNING',
  sourceType: 'REQUIREMENT',
  sourceId: '01900000-0000-7000-8000-0000000000a1',
  alertId: '01900000-0000-7000-8000-0000000000b1',
  alertVersion: 2,
  severity: 'HIGH',
  title: 'INS-01 – Employers liability insurance',
  reasonText: 'Expired',
  raisedAt: '2026-11-01T09:00:00.000Z',
  dueOn: '2026-10-31',
  state: 'OPEN',
  snoozedUntil: null,
  why: 'RULE',
  link: '/',
};
const actionItem = {
  ...alertItem,
  key: 'ACTION:01900000-0000-7000-8000-0000000000c1',
  event: 'ACTION_OVERDUE',
  sourceType: 'ACTION',
  sourceId: '01900000-0000-7000-8000-0000000000c1',
  alertId: null,
  alertVersion: null,
  severity: 'MEDIUM',
  title: 'ACT-7 – Re-audit hand hygiene',
  reasonText: 'Overdue',
  why: 'ROLE',
  link: '/compliance?tab=actions',
};

function renderAlerts(permissions: string[]) {
  const send = vi.fn(async (..._a: unknown[]) => ({}));
  const paths: string[] = [];
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => {
      paths.push(p);
      return {
        items: p.includes('event=ACTION_OVERDUE') ? [actionItem] : [alertItem, actionItem],
        rules: [{ event: 'EXPIRY_WARNING', email: true, roleNames: ['Governance lead'] }],
        emailReminders: true,
      };
    },
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/alerts'] })} />);
  return { send, paths };
}
beforeEach(() => sessionStorage.clear());

describe('alerts centre [task 24]', () => {
  it('lists alerts with words, says why each is shown, and explains the rules', async () => {
    renderAlerts(['compliance.requirement.view']);
    const table = await screen.findByRole('table', { name: 'Your alerts' });
    await within(table).findByText('INS-01 – Employers liability insurance');
    expect(within(table).getByText(/High: Expired/)).toBeInTheDocument();
    expect(within(table).getByText('A notification rule includes your role')).toBeInTheDocument();
    expect(within(table).getByText('Your role covers this area')).toBeInTheDocument();
    expect(within(table).getAllByText('31 Oct 2026')).toHaveLength(2);
    const rules = screen.getByRole('list', { name: 'Notification rules that include your role' });
    expect(rules).toHaveTextContent(
      'Compliance items due or expiring: told to Governance lead, by email as well',
    );
    expect(
      within(table).queryByRole('button', { name: /Acknowledge INS-01/ }),
    ).not.toBeInTheDocument();
  });

  it('filters by area on the server and hides role-only items on request', async () => {
    const { paths } = renderAlerts(['compliance.requirement.view']);
    const table = await screen.findByRole('table', { name: 'Your alerts' });
    await within(table).findByText('ACT-7 – Re-audit hand hygiene');
    await userEvent.click(screen.getByLabelText('Only things I own or was told about'));
    expect(within(table).queryByText('ACT-7 – Re-audit hand hygiene')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'ACTION_OVERDUE');
    await waitFor(() => expect(paths).toContain('/api/v1/alerts/centre?event=ACTION_OVERDUE'));
  });

  it('acknowledges and snoozes through dialogs, never browser pop-ups', async () => {
    const { send } = renderAlerts(['compliance.requirement.view', 'compliance.requirement.manage']);
    const ack = await screen.findByRole('button', {
      name: 'Acknowledge INS-01 – Employers liability insurance',
    });
    expect(screen.queryByRole('button', { name: /Acknowledge ACT-7/ })).not.toBeInTheDocument();
    await userEvent.click(ack);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        `/api/v1/alerts/${alertItem.alertId}/acknowledge`,
        ORG,
        {},
      ),
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Snooze reminders for INS-01 – Employers liability insurance',
      }),
    );
    const snooze = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(snooze).getByLabelText('Pause reminders for'), '3');
    await userEvent.type(
      within(snooze).getByLabelText(/^Why are you snoozing it\?/),
      'Renewal booked',
    );
    await userEvent.click(within(snooze).getByRole('button', { name: 'Snooze reminders' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/alerts/${alertItem.alertId}/snooze`, ORG, {
        until: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        reason: 'Renewal booked',
      }),
    );
  });
});
