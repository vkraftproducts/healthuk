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
  user: { id: ME, email: 'p@example.test', displayName: 'Dev' },
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
const rule = (o: Record<string, unknown>) => ({
  id: 'rr1',
  category: 'AUDIT_LOG',
  retainMonths: 72,
  triggerDesc: 'The entry date',
  basis: 'Organisation schedule v1',
  action: 'REVIEW',
  status: 'REQUIRES_APPROVAL',
  approvedBy: null,
  approvedByName: null,
  approvedAt: null,
  changedBy: 'u2',
  changedByName: 'Priya Governance',
  version: 2,
  candidates: 4,
  held: 1,
  cutoff: '2020-11-06',
  ...o,
});
const rules = [
  rule({}),
  rule({ id: 'rr2', category: 'JOB_RECORDS', changedBy: ME, changedByName: 'Dev' }),
];
const dsr = {
  id: 'd1',
  code: 'DSR-3',
  type: 'ACCESS',
  subjectType: 'STAFF',
  staffId: 's1',
  staffName: 'Alex Crew',
  patientRef: null,
  description: 'Copy of HR file',
  receivedOn: '2026-10-20',
  dueOn: '2026-11-20',
  extendedTo: null,
  latestExtension: '2027-01-20',
  status: 'RECEIVED',
  outcome: null,
  exportJobId: null,
  handledByName: 'Dev',
  completedAt: null,
  overdue: false,
  version: 1,
};
const breach = {
  id: 'b1',
  code: 'BRE-2',
  title: 'Rota sent to wrong address',
  description: 'Synthetic',
  discoveredAt: '2026-11-05T09:00:00Z',
  occurredAt: null,
  dataCategories: ['Staff names'],
  subjectsEstimate: 12,
  containment: null,
  icoDeadline: '2026-11-08T09:00:00Z',
  clock: 'OPEN',
  hoursLeft: 50,
  risk: null,
  icoReportable: null,
  decisionReason: null,
  decidedByName: null,
  decidedAt: null,
  icoReportedAt: null,
  icoReference: null,
  lateReason: null,
  subjectsNotifiedAt: null,
  recordedByName: 'Dev',
  status: 'OPEN',
  version: 1,
};
const complaint = {
  id: 'c1',
  code: 'DPC-1',
  source: 'DATA_SUBJECT',
  summary: 'Unhappy with a request',
  receivedOn: '2026-09-01',
  acknowledgeDue: '2026-10-01',
  acknowledgedOn: null,
  acknowledgeOverdue: true,
  subjectRequestId: 'd1',
  subjectRequestCode: 'DSR-3',
  breachId: null,
  breachCode: null,
  ownerUserId: ME,
  ownerName: 'Dev',
  status: 'RECEIVED',
  outcome: null,
  resolvedOn: null,
  resolvedByName: null,
  version: 1,
};

async function renderPrivacy(permissions = ['privacy.manage', 'reports.export']) {
  const send = vi.fn(async () => ({}));
  const data: Record<string, unknown[]> = {
    '/api/v1/retention-rules': rules,
    '/api/v1/subject-requests': [dsr],
    '/api/v1/breaches': [breach],
    '/api/v1/dp-complaints': [complaint],
    '/api/v1/admin/people': [
      { id: ME, displayName: 'Dev', roleKeys: [], roleNames: ['Governance'], locationIds: [] },
    ],
  };
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => ({ data: data[p] ?? [] }),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/settings'] })} />);
  await userEvent.click(await screen.findByRole('tab', { name: 'Data protection' }));
  return { send };
}
beforeEach(() => sessionStorage.clear());

describe('data protection [task 13]', () => {
  it('the person who changed a retention rule cannot approve it; someone else can', async () => {
    const { send } = await renderPrivacy();
    const mine = await screen.findByRole('row', { name: /Job records/ });
    expect(mine).toHaveTextContent('Someone else must approve your change.');
    expect(within(mine).queryByRole('button', { name: /^Approve/ })).toBeNull();
    const other = screen.getByRole('row', { name: /Audit log/ });
    expect(other).toHaveTextContent('Changed by Priya Governance');
    await userEvent.click(within(other).getByRole('button', { name: 'Approve rule: Audit log' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve rule: Audit log' });
    expect(dialog).toHaveTextContent('4 record(s) are past the cutoff now');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/retention-rules/rr1/approve', ORG, {}),
    );
  });

  it('a subject request shows the person by name and starts with identity checking', async () => {
    const { send } = await renderPrivacy();
    const row = await screen.findByRole('row', { name: /DSR-3 Access/ });
    expect(row).toHaveTextContent('Alex Crew');
    expect(row).toHaveTextContent('Amber – Received – identity not yet verified');
    expect(row).toHaveTextContent('20 Nov 2026');
    expect(within(row).queryByRole('button', { name: /^Complete/ })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Build export/ })).toBeNull();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Identity verified: DSR-3 Access (copy of data)' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm' }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/subject-requests/d1/update', ORG, {
        status: 'IDENTITY_VERIFIED',
      }),
    );
  });

  it('a breach assessment records risk, reportability and reasons', async () => {
    const { send } = await renderPrivacy();
    const row = await screen.findByRole('row', { name: /BRE-2 Rota sent to wrong address/ });
    expect(row).toHaveTextContent('Amber – ICO decision due');
    expect(row).toHaveTextContent('about 12 people');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Assess: BRE-2 Rota sent to wrong address' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Risk to people'), 'HIGH_RISK');
    expect(within(dialog).getByLabelText('Report to the ICO')).toBeDisabled();
    await userEvent.type(
      within(dialog).getByRole('textbox'),
      'Names and shifts disclosed outside the organisation',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/breaches/b1/assessment',
        ORG,
        expect.objectContaining({
          risk: 'HIGH_RISK',
          icoReportable: true,
          decisionReason: 'Names and shifts disclosed outside the organisation',
        }),
      ),
    );
  });

  it('complaints show an overdue acknowledgement in words and record it with a date', async () => {
    const { send } = await renderPrivacy();
    const row = await screen.findByRole('row', { name: /DPC-1 The person themselves/ });
    expect(row).toHaveTextContent('Red – Overdue – was due 1 Oct 2026');
    expect(row).toHaveTextContent('Linked: DSR-3');
    await userEvent.click(
      within(row).getByRole('button', {
        name: 'Record acknowledgement: DPC-1 The person themselves',
      }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Acknowledged on'), {
      target: { value: '2026-10-05' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Record acknowledgement' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/dp-complaints/c1/acknowledge', ORG, {
        acknowledgedOn: '2026-10-05',
      }),
    );
  });
});
