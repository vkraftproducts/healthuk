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
const version = (o: Record<string, unknown>) => ({
  material: true,
  evidenceItemId: null,
  reviewDate: null,
  effectiveFrom: null,
  createdBy: 'u2',
  createdByName: 'Priya Governance',
  approvedBy: null,
  approvedByName: null,
  approvedAt: null,
  publishedAt: null,
  ...o,
});
const published = {
  id: 'p1',
  code: 'POL-IPC',
  title: 'Infection prevention',
  category: 'POLICY',
  ownerUserId: 'u3',
  ownerName: 'Sam Manager',
  readerRoles: ['CREW'],
  currentVersion: {
    id: 'v1',
    version: 1,
    effectiveFrom: '2026-10-01',
    reviewDate: '2026-11-01',
    reviewOverdue: true,
    material: true,
    evidenceItemId: null,
    documentEvidenceVersionId: null,
  },
  versions: [
    version({
      id: 'v1',
      version: 1,
      status: 'PUBLISHED',
      summary: 'Hand hygiene before every patient',
      approvedBy: 'u3',
      approvedByName: 'Sam Manager',
      approvedAt: '2026-10-30T14:00:00Z',
      publishedAt: '2026-10-01T08:00:00Z',
    }),
  ],
  acknowledgement: { acknowledged: 3, required: 5 },
  myAcknowledgement: 'REQUIRED',
};
const criticalPolicy = {
  ...published,
  id: 'p2',
  code: 'CRI-OXY',
  title: 'Oxygen cylinders',
  category: 'CRITICAL_INSTRUCTION',
};
const draftByMe = {
  ...published,
  id: 'p3',
  code: 'POL-NEW',
  title: 'Lone working',
  currentVersion: null,
  versions: [
    version({ id: 'v3', version: 1, status: 'IN_REVIEW', summary: 'First issue', createdBy: ME }),
  ],
  acknowledgement: { acknowledged: 0, required: 0 },
  myAcknowledgement: 'NOT_A_READER',
};
const approvedByOther = {
  ...draftByMe,
  id: 'p4',
  code: 'POL-APP',
  title: 'Manual handling',
  versions: [
    version({ id: 'v4', version: 1, status: 'APPROVED', summary: 'Lifting', material: false }),
  ],
};
const readers = [
  {
    userId: 'c1',
    displayName: 'Alex Crew',
    roleNames: ['Crew'],
    state: 'REQUIRED',
    acknowledgedAt: null,
  },
  {
    userId: 'c2',
    displayName: 'Bea Crew',
    roleNames: ['Crew'],
    state: 'CURRENT',
    acknowledgedAt: '2026-10-02T09:30:00Z',
  },
];
const people = [
  {
    id: ME,
    displayName: 'Dev',
    roleKeys: ['GOVERNANCE_LEAD'],
    roleNames: ['Governance lead'],
    locationIds: [],
  },
  {
    id: 'u3',
    displayName: 'Sam Manager',
    roleKeys: ['CREW'],
    roleNames: ['Crew'],
    locationIds: [],
  },
];

function renderPolicies(permissions: string[], rows: unknown[] = [published]) {
  const send = vi.fn(async () => ({}));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) =>
      p === '/api/v1/policies'
        ? { data: rows }
        : p.endsWith('/readers')
          ? { data: readers }
          : p === '/api/v1/admin/people'
            ? { data: people }
            : { data: [] },
    send,
  };
  render(
    <App
      api={api}
      history={createMemoryHistory({ initialEntries: ['/compliance?tab=policies'] })}
    />,
  );
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('policies [task 10]', () => {
  it('shows the owner by name and an overdue review in words', async () => {
    renderPolicies(['compliance.policy.acknowledge']);
    const row = await screen.findByRole('row', { name: /POL-IPC Infection prevention/ });
    expect(row).toHaveTextContent('Sam Manager');
    expect(row).toHaveTextContent('v1 from 1 Oct 2026');
    expect(row).toHaveTextContent('Red – Review overdue – was due 1 Nov 2026');
    expect(row).toHaveTextContent('You need to read and acknowledge this');
    expect(screen.queryByRole('heading', { name: 'Add a policy' })).toBeNull();
  });

  it('a reader acknowledges after seeing what the policy says', async () => {
    const { send } = renderPolicies(['compliance.policy.acknowledge']);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Read and acknowledge: POL-IPC Infection prevention',
      }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Read and acknowledge: POL-IPC Infection prevention',
    });
    expect(dialog).toHaveTextContent('Hand hygiene before every patient');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/policies/p1/acknowledge', ORG, {}),
    );
  });

  it('a critical instruction needs the "read and understood" box ticked', async () => {
    const { send } = renderPolicies(['compliance.policy.acknowledge'], [criticalPolicy]);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Read and acknowledge: CRI-OXY Oxygen cylinders' }),
    );
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Acknowledge' });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByLabelText('I have read and understood this critical instruction'),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/policies/p2/acknowledge', ORG, {
        confirmCritical: true,
      }),
    );
  });

  it('the author cannot approve their own version; publishing is confirmed with a date', async () => {
    const { send } = renderPolicies(['compliance.policy.manage'], [draftByMe, approvedByOther]);
    const own = await screen.findByRole('row', { name: /POL-NEW Lone working/ });
    expect(own).toHaveTextContent('You wrote v1, so someone else must approve it.');
    expect(within(own).queryByRole('button', { name: /^Approve/ })).toBeNull();
    const other = screen.getByRole('row', { name: /POL-APP Manual handling/ });
    await userEvent.click(
      within(other).getByRole('button', { name: 'Publish v1: POL-APP Manual handling' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Publish v1: POL-APP Manual handling' });
    expect(dialog).toHaveTextContent('minor change: existing acknowledgements carry forward');
    fireEvent.change(within(dialog).getByLabelText('Takes effect from (optional, default today)'), {
      target: { value: '2026-11-10' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/policies/p4/versions/v4/transition', ORG, {
        to: 'PUBLISHED',
        effectiveFrom: '2026-11-10',
      }),
    );
  });

  it('a manager sees who has not acknowledged and the version history with names', async () => {
    renderPolicies(['compliance.policy.manage']);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Details: POL-IPC Infection prevention' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Details: POL-IPC Infection prevention' });
    expect(dialog).toHaveTextContent(
      'Written by Priya Governance; approved by Sam Manager, 30 Oct 2026, 14:00',
    );
    expect(await within(dialog).findByText('1 still need to acknowledge.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Alex Crew (Crew): Not yet acknowledged');
    expect(dialog).toHaveTextContent('Bea Crew (Crew): Acknowledged 2 Oct 2026, 10:30');
  });

  it('drafts a new version with whether it is a material change', async () => {
    const { send } = renderPolicies(['compliance.policy.manage']);
    await userEvent.click(
      await screen.findByRole('button', { name: 'New version: POL-IPC Infection prevention' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('What changed'), 'Typo fixes');
    await userEvent.click(
      within(dialog).getByLabelText('Material change (everyone must acknowledge again)'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/policies/p1/versions', ORG, {
        summary: 'Typo fixes',
        material: false,
      }),
    );
  });

  it('adds a policy with an owner and the roles that must read it', async () => {
    const { send } = renderPolicies(['compliance.policy.manage']);
    const form = await screen.findByRole('form', { name: 'Add a policy' });
    await userEvent.type(within(form).getByLabelText('Code'), 'POL-LONE');
    await userEvent.type(within(form).getByLabelText('Title'), 'Lone working');
    await userEvent.selectOptions(within(form).getByLabelText('Owner'), 'u3');
    await userEvent.type(within(form).getByLabelText('Summary of what it says'), 'Check in hourly');
    await userEvent.click(await within(form).findByLabelText('Crew'));
    await userEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/policies', ORG, {
        code: 'POL-LONE',
        title: 'Lone working',
        category: 'POLICY',
        ownerUserId: 'u3',
        readerRoles: ['CREW'],
        summary: 'Check in hourly',
      }),
    );
  });
});
