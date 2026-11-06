import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000105';
const OTHER = '01900000-0000-7000-8000-000000000101';
const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'governance@example.test', displayName: 'Gina' },
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

function renderAt(url: string, permissions: string[], get: (p: string) => unknown) {
  const send = vi.fn(async (..._a: unknown[]) => ({}));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [url] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

const rating = {
  id: 'r1',
  locationId: null,
  locationName: null,
  overall: 'GOOD',
  keyQuestions: { SAFE: 'REQUIRES_IMPROVEMENT' },
  publishedOn: '2026-09-01',
  reportUrl: null,
  displayDue: '2026-09-22',
  displayedPremisesOn: null,
  displayedWebsiteOn: null,
  noWebsite: false,
  current: true,
  display: {
    status: 'RED',
    reasonText: 'Not displayed at the premises and on the website – was due 22 Sept 2026',
  },
  recordedByName: 'Gina',
  version: 3,
};

describe('registration, ratings and governance records [task 21]', () => {
  it('shows the published rating as CQC gave it and records display dates in a dialog', async () => {
    const { send } = renderAt(
      '/compliance?tab=registration',
      ['compliance.registration.manage'],
      (p) =>
        p === '/api/v1/registration'
          ? {
              providerRef: '1-000',
              registeredManagerUserId: null,
              nominatedIndividual: null,
              conditions: null,
              statementOfPurposeItemId: null,
              insuranceItemId: null,
              bcpItemId: null,
              registeredActivities: [],
              version: 1,
            }
          : p === '/api/v1/cqc-ratings'
            ? { data: [rating] }
            : p === '/api/v1/registration/history'
              ? {
                  data: [
                    {
                      id: 'h1',
                      snapshot: {},
                      changedFields: ['providerRef'],
                      reason: 'New reference',
                      changedBy: OTHER,
                      changedByName: 'Manager',
                      changedAt: '2026-11-01T10:00:00Z',
                    },
                  ],
                }
              : { data: [] },
    );
    const ratings = await screen.findByRole('table', { name: 'Published CQC ratings' });
    const row = within(ratings).getByRole('row', { name: /Whole provider/ });
    expect(row).toHaveTextContent('Good');
    expect(row).toHaveTextContent('Safe: Requires improvement');
    expect(row).toHaveTextContent('Red – Not displayed at the premises and on the website');
    expect(screen.getByText(/never calculates or predicts a rating/)).toBeInTheDocument();
    const hist = screen.getByRole('table', { name: 'Registration record history' });
    expect(hist).toHaveTextContent('Provider reference');
    expect(hist).toHaveTextContent('New reference');

    await userEvent.click(
      within(row).getByRole('button', { name: /Record display: Whole provider/ }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText('Displayed at the premises on'),
      '2026-09-05',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'We have no website' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save display dates' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/cqc-ratings/r1',
        ORG,
        { displayedPremisesOn: '2026-09-05', noWebsite: true },
        3,
      ),
    );
  });

  it('the author of draft minutes is not offered their approval', async () => {
    renderAt('/compliance?tab=meetings', ['governance.meeting.manage'], (p) =>
      p === '/api/v1/governance-meetings'
        ? {
            data: [
              {
                id: 'm1',
                code: 'MTG-3',
                kind: 'BOARD',
                title: 'Synthetic board',
                heldOn: '2026-11-02',
                chair: 'Chair',
                attendees: ['A'],
                apologies: [],
                quorate: false,
                minutes: 'Minutes text',
                decisions: null,
                status: 'DRAFT',
                recordedBy: ME,
                recordedByName: 'Gina',
                approvedByName: null,
                approvedAt: null,
                actions: [],
                version: 1,
              },
            ],
          }
        : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /MTG-3/ });
    expect(row).toHaveTextContent('Amber – Not quorate');
    expect(row).toHaveTextContent('Amber – Draft – awaiting approval');
    await userEvent.click(
      within(row).getByRole('button', { name: 'Open meeting MTG-3 Synthetic board' }),
    );
    expect(
      await screen.findByText('You wrote these minutes, so someone else must approve them.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve minutes/ })).toBeNull();
  });

  it('a second person reviews a notification draft; the preparer cannot', async () => {
    const n = (id: string, preparedBy: string) => ({
      id,
      code: `NTF-${id}`,
      kind: 'SERIOUS_INJURY',
      eventId: null,
      eventCode: null,
      occurredOn: '2026-11-05',
      dueOn: '2026-11-06',
      summary: 'Synthetic summary text',
      actionsTaken: null,
      status: 'DRAFT',
      preparedBy,
      preparedByName: 'X',
      reviewedByName: null,
      submittedOn: null,
      cqcReference: null,
      notRequiredReason: null,
      state: { status: 'AMBER', reasonText: 'Draft, needs review – submit by 6 Nov 2026' },
      version: 2,
    });
    const { send } = renderAt('/compliance?tab=notifications', ['events.event.manage'], (p) =>
      p === '/api/v1/cqc-notifications' ? { data: [n('1', ME), n('2', OTHER)] } : { data: [] },
    );
    const mine = await screen.findByRole('row', { name: /NTF-1/ });
    expect(mine).toHaveTextContent('Someone else must review this.');
    expect(within(mine).queryByRole('button', { name: 'Review NTF-1' })).toBeNull();
    const theirs = screen.getByRole('row', { name: /NTF-2/ });
    expect(theirs).toHaveTextContent('Amber – Draft, needs review');
    await userEvent.click(within(theirs).getByRole('button', { name: 'Review NTF-2' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/cqc-notifications/2/transition',
        ORG,
        { to: 'READY' },
        2,
      ),
    );
    expect(screen.getByText(/it never sends them/)).toBeInTheDocument();
  });

  it('NHS contracts show the notice state in words and item counts [task 22]', async () => {
    renderAt('/compliance?tab=contracts', ['compliance.audit.view'], (p) =>
      p === '/api/v1/nhs-contracts'
        ? {
            contracts: [
              {
                id: 'k1',
                commissioner: 'Synthetic ICB',
                reference: 'NHS-SYN-1',
                service: 'Patient transport',
                contractType: 'NHS_STANDARD_SHORTFORM',
                startOn: '2026-04-01',
                endOn: '2027-03-31',
                noticeMonths: 6,
                noticeBy: '2026-09-30',
                reporting: 'MONTHLY',
                managerUserId: ME,
                managerName: 'Gina',
                reviewMeetingOn: null,
                notes: null,
                state: {
                  status: 'AMBER',
                  reasonText: 'Ends 31 Mar 2027; the notice date has passed',
                },
                version: 1,
              },
            ],
            items: [
              {
                instanceId: 'i1',
                templateCode: 'NHS-ORG-01',
                title: 'Data Security and Protection Toolkit submitted',
                status: 'RED',
                reasonText: 'No verified evidence on record',
                dueDate: null,
                ownerName: null,
              },
            ],
            summary: { total: 1, met: 0, notMet: 1, notApplicable: 0 },
            notAdopted: 14,
          }
        : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /NHS-SYN-1/ });
    expect(row).toHaveTextContent('NHS Standard Contract (shorter form)');
    expect(row).toHaveTextContent('Amber – Ends 31 Mar 2027');
    expect(within(row).queryByRole('button', { name: /Change contract/ })).toBeNull();
    const items = screen.getByRole('table', { name: 'NHS contract items' });
    expect(items).toHaveTextContent('Red – No verified evidence on record');
    expect(screen.getByText(/0 of 1 item\(s\) met/)).toHaveTextContent('14 item(s)');
  });

  it('the evidence pack form sends the chosen options [task 22]', async () => {
    const { send } = renderAt(
      '/compliance?tab=pack',
      ['reports.export', 'compliance.audit.view'],
      () => ({ data: [] }),
    );
    await userEvent.type(await screen.findByLabelText('From'), '2026-10-01');
    await userEvent.type(screen.getByLabelText('To'), '2026-10-31');
    await userEvent.selectOptions(screen.getByLabelText('Who is it for?'), 'NHS_CONTRACT');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Audits in the period' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'NHS contracts' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Index only (no evidence files)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Request pack' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/evidence-packs', ORG, {
        from: '2026-10-01',
        to: '2026-10-31',
        purpose: 'NHS_CONTRACT',
        sections: ['REQUIREMENTS', 'ACTIONS', 'POLICIES', 'CONTRACTS'],
        includeFiles: false,
        gapsOnly: false,
      }),
    );
  });

  it('the fit and proper tab is only offered with its own permission', async () => {
    renderAt('/compliance?tab=fpp', ['compliance.audit.view'], () => ({ data: [] }));
    expect(await screen.findByRole('tab', { name: 'Governance meetings' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Fit and proper' })).toBeNull();
  });
});
