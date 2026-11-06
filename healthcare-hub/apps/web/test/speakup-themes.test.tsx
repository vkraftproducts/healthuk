import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { recentQuarters } from '../src/pages/speakup/SpeakUp.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000102';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'guardian@example.test', displayName: 'Gita' },
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
const concern = (o: Record<string, unknown>) => ({
  id: 'c1',
  code: 'SPK-7',
  category: 'BULLYING',
  channel: 'IN_APP',
  anonymous: true,
  thirdParty: false,
  raisedByName: null,
  summary: 'Synthetic concern text',
  raisedOn: '2026-10-20',
  acknowledgeDue: '2026-10-27',
  acknowledgedOn: '2026-10-21',
  acknowledgeOverdue: false,
  handlerUserId: ME,
  handlerName: 'Gita',
  status: 'INVESTIGATING',
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
  version: 2,
  ...o,
});

function renderAt(permissions: string[], get: (p: string) => unknown) {
  const send = vi.fn(async (..._a: unknown[]) => ({}));
  const getSpy = vi.fn(async (p: string) => get(p));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: getSpy,
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/speak-up'] })} />);
  return { send, get: getSpy };
}
beforeEach(() => sessionStorage.clear());

describe('speak-up themes and feedback to anonymous raisers [H6]', () => {
  it('lists quarters newest first across a year boundary', () => {
    expect(recentQuarters('2026-02-10', 3)).toEqual(['2026-Q1', '2025-Q4', '2025-Q3']);
  });

  it('shows themes by quarter in words, with small counts hidden as the server sends them', async () => {
    const { get } = renderAt(['speakup.manage'], (p) =>
      p.startsWith('/api/v1/speak-up/themes?')
        ? {
            quarter: '2026-Q3',
            from: '2026-07-01',
            to: '2026-09-30',
            total: '5',
            themes: [
              { category: 'BULLYING', count: '3' },
              { category: 'SEXUAL_HARASSMENT', count: 'fewer than 3' },
            ],
            note: 'Counts below 3 are hidden so that nobody can be identified.',
          }
        : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Themes' }));
    const select = await screen.findByLabelText('Quarter');
    const q3 = recentQuarters(new Date().toISOString().slice(0, 10))[1]!;
    await userEvent.selectOptions(select, q3);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(`/api/v1/speak-up/themes?quarter=${q3}`, ORG),
    );
    const table = await screen.findByRole('table', { name: /Speak-up themes/ });
    expect(within(table).getByRole('row', { name: /Bullying/ })).toHaveTextContent('3');
    expect(within(table).getByRole('row', { name: /Sexual harassment/ })).toHaveTextContent(
      'fewer than 3',
    );
    expect(table).not.toHaveTextContent('SEXUAL_HARASSMENT');
    expect(screen.getByRole('note')).toHaveTextContent('nobody can be identified');
    expect(screen.getByText(/1 Jul 2026 to 30 Sep 2026/)).toBeInTheDocument();
  });

  it('is not offered to someone who can only raise concerns', async () => {
    renderAt(['speakup.raise'], () => ({ data: [] }));
    expect(await screen.findByRole('tab', { name: 'Raise a concern' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Themes' })).toBeNull();
  });

  it('a handler writes feedback for an anonymous raiser in a dialog', async () => {
    const c = concern({});
    const { send } = renderAt(['speakup.manage'], (p) =>
      p === '/api/v1/speak-up/c1'
        ? c
        : p.startsWith('/api/v1/speak-up')
          ? { data: [c] }
          : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /SPK-7/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Open concern SPK-7' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Write feedback for the raiser' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Do not name anyone');
    const save = within(dialog).getByRole('button', { name: 'Save feedback' });
    expect(save).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'We have spoken to the team.');
    await userEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/speak-up/c1/progress-feedback', ORG, {
        feedback: 'We have spoken to the team.',
      }),
    );
  });

  it('named concerns get feedback recorded as a note, not through a progress code', async () => {
    const c = concern({ anonymous: false, raisedByName: 'Sam Colleague' });
    renderAt(['speakup.manage'], (p) =>
      p === '/api/v1/speak-up/c1'
        ? c
        : p.startsWith('/api/v1/speak-up')
          ? { data: [c] }
          : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /SPK-7/ });
    await userEvent.click(within(row).getByRole('button', { name: 'Open concern SPK-7' }));
    expect(await screen.findByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write feedback for the raiser' })).toBeNull();
  });
});
