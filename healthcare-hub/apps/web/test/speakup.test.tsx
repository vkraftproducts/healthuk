import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000102';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'hr@example.test', displayName: 'Hana' },
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
const concern = {
  id: 'c1',
  code: 'SPK-4',
  category: 'SEXUAL_HARASSMENT',
  channel: 'IN_APP',
  anonymous: true,
  thirdParty: false,
  raisedByName: null,
  summary: 'Synthetic concern text',
  raisedOn: '2026-10-20',
  acknowledgeDue: '2026-10-27',
  acknowledgedOn: null,
  acknowledgeOverdue: true,
  handlerUserId: null,
  handlerName: null,
  status: 'RECEIVED',
  feedbackGivenOn: null,
  outcome: null,
  outcomeText: null,
  lessons: null,
  closedOn: null,
  closedByName: null,
  detrimentCheckDue: null,
  detrimentCheckedOn: null,
  detrimentCheckOverdue: false,
  notes: [],
  version: 1,
};

function renderAt(permissions: string[], get: (p: string) => unknown) {
  const send = vi.fn(async (..._a: unknown[]) => ({
    code: 'SPK-5',
    raisedOn: '2026-11-06',
    anonymous: true,
    acknowledgeDue: '2026-11-13',
  }));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/speak-up'] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('speak up [task 20]', () => {
  it('anyone can raise an anonymous concern and is told nobody can see who raised it', async () => {
    const { send } = renderAt(['speakup.raise'], () => ({ data: [] }));
    expect(await screen.findByRole('tab', { name: 'Raise a concern' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Concerns' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Harassment prevention' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Raise a concern' });
    await userEvent.selectOptions(within(form).getByLabelText('What is it about?'), 'BULLYING');
    await userEvent.type(
      within(form).getByLabelText('What happened, and what worries you?'),
      'Synthetic: shouting at handover',
    );
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Raise it anonymously' }));
    expect(screen.getByRole('note')).toHaveTextContent('Your name is not stored');
    await userEvent.click(within(form).getByRole('button', { name: 'Send concern' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/speak-up', ORG, {
        category: 'BULLYING',
        summary: 'Synthetic: shouting at handover',
        anonymous: true,
        thirdParty: false,
      }),
    );
    expect(await screen.findByText(/Your reference is SPK-5/)).toHaveTextContent('13 Nov 2026');
  });

  it('checks an anonymous concern with its progress code and names the guardian [H6]', async () => {
    renderAt(['speakup.raise'], (p) => {
      if (p === '/api/v1/speak-up/guardian') return { guardianName: 'Gita Guardian' };
      if (p.startsWith('/api/v1/speak-up/progress?'))
        return {
          status: 'INVESTIGATING',
          feedback: 'We are talking to the team.',
          updatedOn: '2026-11-05',
        };
      return { data: [] };
    });
    expect(await screen.findByText(/guardian is Gita Guardian/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Check progress with your code' });
    const check = within(form).getByRole('button', { name: 'Check progress' });
    expect(check).toBeDisabled();
    await userEvent.type(within(form).getByLabelText(/Progress code/), 'abcd-efgh-jkmn');
    await userEvent.click(check);
    const result = await within(form).findByRole('status');
    expect(result).toHaveTextContent('Being looked into');
    expect(result).toHaveTextContent('5 Nov 2026');
    expect(result).toHaveTextContent('Feedback: We are talking to the team.');
  });

  it('a handler sees overdue acknowledgement in words and acknowledges in a dialog', async () => {
    const { send } = renderAt(['speakup.manage'], (p) =>
      p === '/api/v1/speak-up/c1'
        ? concern
        : p.startsWith('/api/v1/speak-up')
          ? { data: [concern] }
          : p === '/api/v1/admin/people'
            ? { data: [{ id: ME, displayName: 'Hana', roleKeys: [], roleNames: ['HR'] }] }
            : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /SPK-4/ });
    expect(row).toHaveTextContent('Anonymous');
    expect(row).toHaveTextContent('Red – Acknowledgement overdue (was due 27 Oct 2026)');
    await userEvent.click(within(row).getByRole('button', { name: 'Open concern SPK-4' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/speak-up/c1/acknowledge',
        ORG,
        expect.objectContaining({ handlerUserId: ME }),
      ),
    );
  });

  it('the person who prepared a risk assessment is not offered its approval', async () => {
    renderAt(['harassment.manage'], (p) =>
      p === '/api/v1/harassment/duty'
        ? {
            asOf: '2026-11-06',
            steps: [
              {
                step: 'RISK_ASSESSMENT',
                title: 'Sexual harassment risk assessment, approved and in date',
                status: 'AMBER',
                reasonText: 'A draft is waiting for approval',
              },
            ],
            concernsLast12Months: {},
            note: 'These are the steps the hub can see.',
          }
        : p === '/api/v1/harassment/assessments'
          ? {
              data: [
                {
                  id: 'a1',
                  title: 'Night work RA',
                  assessedOn: '2026-11-01',
                  reviewDue: '2027-11-01',
                  risks: [],
                  status: 'DRAFT',
                  preparedBy: ME,
                  preparedByName: 'Hana',
                  approvedByName: null,
                  approvedAt: null,
                  supersedesId: null,
                  version: 1,
                },
              ],
            }
          : { data: [] },
    );
    expect(await screen.findByText(/A draft is waiting for approval/)).toBeInTheDocument();
    const row = await screen.findByRole('row', { name: /Night work RA/ });
    expect(row).toHaveTextContent('Someone else must approve this.');
    expect(within(row).queryByRole('button', { name: 'Approve: Night work RA' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Edit: Night work RA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a new assessment' })).toBeNull();
  });
});
