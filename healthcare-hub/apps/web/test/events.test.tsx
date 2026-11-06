import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const EVT = '01900000-0000-7000-8000-000000000501';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'g@example.test', displayName: 'Dev' },
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
const people = [
  { id: ME, displayName: 'Dev', roleKeys: [], roleNames: ['Governance lead'], locationIds: [] },
  { id: 'u3', displayName: 'Sam Manager', roleKeys: [], roleNames: ['Manager'], locationIds: [] },
];
const event = {
  id: EVT,
  code: 'EVT-12',
  types: ['INCIDENT'],
  title: 'Patient fall during transfer',
  description: 'Slipped on the ramp',
  occurredAt: '2026-11-02T10:00:00Z',
  discoveredAt: '2026-11-02T10:05:00Z',
  locationId: null,
  severity: 'MODERATE',
  leadUserId: 'u3',
  leadName: 'Sam Manager',
  status: 'ASSESS',
  themes: [],
  links: [],
  restricted: false,
  candourFlag: true,
  candourDecided: false,
  version: 3,
  transitions: [
    {
      fromStatus: null,
      toStatus: 'TRIAGE',
      note: 'Recorded',
      byUserId: 'u3',
      byName: 'Sam Manager',
      at: '2026-11-02T10:10:00Z',
    },
  ],
  obligations: [
    {
      id: 'o1',
      body: 'CQC',
      trigger: 'Injury to a person using the service',
      basis: 'Regulation 18',
      deadlineAt: '2026-11-01T09:00:00Z',
      decision: 'PENDING',
      decisionReason: null,
      decidedByName: null,
      submittedAt: null,
      reference: null,
      overdue: true,
      version: 1,
    },
  ],
  candour: [],
  complaint: null,
  safeguarding: null,
  actions: [],
};
const complaintEvent = {
  ...event,
  types: ['COMPLAINT'],
  severity: 'NO_HARM',
  candourFlag: false,
  status: 'TRIAGE',
  obligations: [],
  complaint: {
    receivedOn: '2026-10-20',
    channel: 'EMAIL',
    acknowledgeBy: '2026-10-23',
    respondBy: '2026-11-17',
    acknowledgedOn: null,
    respondedOn: null,
    acknowledgeOverdue: true,
    respondOverdue: false,
    preferences: 'Email only',
    consentToShare: false,
    outcome: null,
    escalationRightsGiven: false,
    version: 2,
  },
};

function renderAt(path: string, permissions: string[], get: (p: string) => unknown) {
  const send = vi.fn(async () => ({ id: EVT }));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => (p === '/api/v1/admin/people' ? { data: people } : get(p)),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());
const MANAGE = ['events.event.view', 'events.event.manage', 'events.candour.decide'];

describe('events list and reporting [task 11]', () => {
  it('lists events in words with the lead and the candour flag', async () => {
    renderAt('/compliance?tab=events', ['events.event.view'], (p) =>
      p.startsWith('/api/v1/events') ? { data: [event] } : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /EVT-12/ });
    expect(row).toHaveTextContent('Incident');
    expect(row).toHaveTextContent('Moderate harm');
    expect(row).toHaveTextContent('Assess reporting duties');
    expect(row).toHaveTextContent('Sam Manager');
    expect(row).toHaveTextContent('Amber – Possible duty of candour – a person must decide');
    expect(
      within(row).getByRole('link', { name: 'EVT-12 Patient fall during transfer' }),
    ).toHaveAttribute('href', `/compliance/events/${EVT}`);
    expect(screen.queryByRole('form', { name: 'Report an event' })).toBeNull();
  });

  it('reports a complaint with its details', async () => {
    const { send } = renderAt('/compliance?tab=events', MANAGE, () => ({ data: [] }));
    const form = await screen.findByRole('form', { name: 'Report an event' });
    await userEvent.click(within(form).getByLabelText('Incident'));
    await userEvent.click(within(form).getByLabelText('Complaint'));
    await userEvent.type(within(form).getByLabelText('Short title'), 'Late collection');
    fireEvent.change(within(form).getByLabelText('When it happened'), {
      target: { value: '2026-11-01T09:00' },
    });
    await userEvent.type(
      within(form).getByLabelText('What happened (no patient names)'),
      'Collected an hour late',
    );
    fireEvent.change(within(form).getByLabelText('Received on'), {
      target: { value: '2026-11-02' },
    });
    await userEvent.selectOptions(within(form).getByLabelText('How it was received'), 'EMAIL');
    await userEvent.click(within(form).getByRole('button', { name: 'Record event' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/events',
        ORG,
        expect.objectContaining({
          types: ['COMPLAINT'],
          title: 'Late collection',
          severity: 'NO_HARM',
          leadUserId: ME,
          complaint: { receivedOn: '2026-11-02', channel: 'EMAIL', consentToShare: false },
        }),
      ),
    );
  });
});

describe('event workflow page [task 11]', () => {
  const get = (e: unknown) => (p: string) => (p === `/api/v1/events/${EVT}` ? e : { data: [] });

  it('explains what blocks the next stage and shows an overdue duty in words', async () => {
    renderAt(`/compliance/events/${EVT}`, MANAGE, get(event));
    expect(
      await screen.findByText('Record a decision on 1 reporting duty before moving on.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Investigate' })).toBeDisabled();
    const duty = screen.getByRole('row', { name: /CQC notification/ });
    expect(duty).toHaveTextContent('Red – Overdue – was due 1 Nov 2026, 09:00');
    expect(screen.getByText('No decision recorded yet.')).toBeInTheDocument();
    expect(screen.getByText(/Triage by Sam Manager: Recorded/)).toBeInTheDocument();
  });

  it('decides a reporting duty with a reason and the record version', async () => {
    const { send } = renderAt(`/compliance/events/${EVT}`, MANAGE, get(event));
    await userEvent.click(await screen.findByRole('button', { name: 'Decide: CQC notification' }));
    const dialog = screen.getByRole('dialog', { name: 'Decide: CQC notification' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Decision'), 'NOT_REQUIRED');
    await userEvent.type(
      within(dialog).getByLabelText(/Reason for the decision/),
      'No injury after review',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/obligations/o1',
        ORG,
        { decision: 'NOT_REQUIRED', decisionReason: 'No injury after review' },
        1,
      ),
    );
  });

  it('records a candour decision only with a reason of at least 10 characters', async () => {
    const { send } = renderAt(`/compliance/events/${EVT}`, MANAGE, get(event));
    await userEvent.click(await screen.findByRole('button', { name: 'Record decision' }));
    const dialog = screen.getByRole('dialog', { name: 'Record duty of candour decision' });
    const confirm = within(dialog).getByRole('button', { name: 'Record decision' });
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Is this a notifiable safety incident?'),
      'yes',
    );
    await userEvent.type(within(dialog).getByLabelText('Reason (at least 10 characters)'), 'Harm');
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText('Reason (at least 10 characters)'),
      ' to the patient',
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/events/${EVT}/candour-assessment`, ORG, {
        notifiable: true,
        reason: 'Harm to the patient',
      }),
    );
  });

  it('tracks complaint targets and records the acknowledgement', async () => {
    const { send } = renderAt(`/compliance/events/${EVT}`, MANAGE, get(complaintEvent));
    expect(await screen.findByText('Red – Overdue – was due 23 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('By 17 Nov 2026')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Duty of candour' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Record acknowledgement' }));
    const dialog = screen.getByRole('dialog', { name: 'Record complaint acknowledgement' });
    fireEvent.change(within(dialog).getByLabelText('Acknowledged on'), {
      target: { value: '2026-10-24' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record acknowledgement' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        `/api/v1/events/${EVT}/complaint`,
        ORG,
        { acknowledgedOn: '2026-10-24' },
        2,
      ),
    );
  });

  it('moves to the next stage with a note', async () => {
    const { send } = renderAt(`/compliance/events/${EVT}`, MANAGE, get(complaintEvent));
    await userEvent.click(await screen.findByRole('button', { name: 'Move to Make safe' }));
    const dialog = screen.getByRole('dialog', { name: 'Move to Make safe' });
    await userEvent.type(within(dialog).getByLabelText(/What was done at this stage/), 'Triaged');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move on' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/events/${EVT}/transition`, ORG, {
        to: 'PROTECT',
        note: 'Triaged',
      }),
    );
  });
});
