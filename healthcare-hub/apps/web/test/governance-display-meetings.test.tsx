import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function renderAt(
  url: string,
  permissions: string[],
  get: (p: string) => unknown,
  send = vi.fn(async (..._a: unknown[]) => ({}) as unknown),
) {
  const getSpy = vi.fn(async (p: string) => get(p));
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: getSpy,
    send: send as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [url] })} />);
  return { send, get: getSpy };
}
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

const registration = {
  providerRef: '1-000',
  registeredManagerUserId: null,
  nominatedIndividual: null,
  conditions: null,
  statementOfPurposeItemId: null,
  insuranceItemId: null,
  bcpItemId: null,
  registeredActivities: [],
  version: 1,
};
const rating = {
  id: 'r1',
  locationId: null,
  locationName: null,
  overall: 'GOOD',
  keyQuestions: {},
  publishedOn: '2026-09-01',
  reportUrl: null,
  displayDue: '2026-09-22',
  displayedPremisesOn: null,
  displayedWebsiteOn: null,
  noWebsite: false,
  current: true,
  display: { status: 'RED', reasonText: 'Not displayed – was due 22 Sept 2026' },
  recordedByName: 'Gina',
  premisesEvidenceItemId: null,
  websiteEvidenceItemId: null,
  version: 4,
};

describe('rating display evidence [I2]', () => {
  it('uploads a premises photo and links it to the rating display', async () => {
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', put);
    const send = vi.fn(async (_m: unknown, path: unknown) =>
      path === '/api/v1/evidence/uploads'
        ? { uploadUrl: 'http://blob.test/p', evidenceVersionId: 'v1', evidenceItemId: 'item-photo' }
        : path === '/api/v1/evidence/v1/complete'
          ? { state: 'PENDING_VERIFICATION' }
          : {},
    );
    renderAt(
      '/compliance?tab=registration',
      ['compliance.registration.manage'],
      (p) =>
        p === '/api/v1/cqc-ratings'
          ? { data: [rating] }
          : p === '/api/v1/registration'
            ? registration
            : { data: [] },
      send as never,
    );
    const table = await screen.findByRole('table', { name: 'Published CQC ratings' });
    const row = within(table).getByRole('row', { name: /Whole provider/ });
    expect(row).toHaveTextContent('No premises photo; no website capture');
    await userEvent.click(
      within(row).getByRole('button', { name: /Record display: Whole provider/ }),
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Uploading does not make anything green');
    await userEvent.type(
      within(dialog).getByLabelText('Displayed at the premises on'),
      '2026-09-05',
    );
    await userEvent.upload(
      within(dialog).getByLabelText('Photo of the premises display (optional)'),
      new File(['x'], 'poster.jpg', { type: 'image/jpeg' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save display dates' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/cqc-ratings/r1',
        ORG,
        {
          displayedPremisesOn: '2026-09-05',
          noWebsite: false,
          premisesEvidenceItemId: 'item-photo',
        },
        4,
      ),
    );
    expect(put).toHaveBeenCalledWith(
      'http://blob.test/p',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('shows evidence already on file in words', async () => {
    renderAt('/compliance?tab=registration', ['compliance.audit.view'], (p) =>
      p === '/api/v1/cqc-ratings'
        ? { data: [{ ...rating, premisesEvidenceItemId: 'a', websiteEvidenceItemId: 'b' }] }
        : p === '/api/v1/registration'
          ? registration
          : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /Whole provider/ });
    expect(row).toHaveTextContent('Premises photo on file; website capture on file');
    expect(within(row).queryByRole('button', { name: /Record display/ })).toBeNull();
  });
});

const meeting = (o: Record<string, unknown>) => ({
  id: 'm1',
  code: 'MTG-3',
  kind: 'BOARD',
  title: 'Synthetic board',
  heldOn: '2026-09-02',
  chair: 'Chair',
  attendees: ['A'],
  apologies: [],
  quorate: true,
  minutes: 'Minutes text',
  decisions: null,
  status: 'DRAFT',
  recordedBy: OTHER,
  recordedByName: 'Manager',
  approvedByName: null,
  approvedAt: null,
  actions: [],
  approvedAtMeetingId: null,
  approvedAtMeetingCode: null,
  version: 2,
  ...o,
});
const pack = {
  generatedAt: '2026-11-06T09:30:00.000Z',
  sinceOn: '2026-10-02',
  incidents: { opened: 4, open: 2 },
  complaints: { opened: 1, open: 1 },
  actions: { open: 6, overdue: 2 },
  audits: { submitted: 3, nonCompliant: 1, overdue: 0 },
  risks: { open: 5, high: 1, reviewOverdue: 0 },
  notifications: { drafts: 1, overdue: 0 },
  policies: { reviewOverdue: 1 },
  previousDraftMinutes: [{ id: 'm1', code: 'MTG-3', heldOn: '2026-09-02' }],
  openMeetingActions: [
    { id: 'a1', code: 'ACT-9', title: 'Refresh fire training', deadline: '2026-12-01' },
  ],
};

describe('governance meetings [I3]', () => {
  const meetings = [
    meeting({}),
    meeting({ id: 'm2', code: 'MTG-4', title: 'Synthetic October board', heldOn: '2026-10-02' }),
    meeting({
      id: 'm0',
      code: 'MTG-2',
      title: 'Earlier board',
      heldOn: '2026-08-01',
      status: 'APPROVED',
    }),
  ];
  const get = (p: string) =>
    p === '/api/v1/governance-meetings'
      ? { data: meetings }
      : p === '/api/v1/governance-meetings/pack'
        ? pack
        : { data: [] };

  it('builds the meeting pack only when asked, with overdue items in words', async () => {
    const { get: spy } = renderAt('/compliance?tab=meetings', ['compliance.audit.view'], get);
    const build = await screen.findByRole('button', { name: 'Build the meeting pack' });
    expect(spy).not.toHaveBeenCalledWith('/api/v1/governance-meetings/pack', ORG);
    await userEvent.click(build);
    const figures = await screen.findByRole('table', { name: 'Meeting pack figures' });
    expect(within(figures).getByRole('row', { name: /Actions/ })).toHaveTextContent(
      'Red – 2 overdue',
    );
    expect(within(figures).getByRole('row', { name: /Audits/ })).toHaveTextContent(
      'Green – None overdue',
    );
    expect(within(figures).getByRole('row', { name: /Incidents/ })).toHaveTextContent(
      '4 reported since, 2 still open',
    );
    expect(screen.getByText(/Since 2 Oct 2026/)).toHaveTextContent('6 Nov 2026, 09:30');
    expect(
      screen.getByRole('table', { name: 'Open actions from earlier meetings' }),
    ).toHaveTextContent('ACT-9');
    const drafts = screen.getByRole('table', { name: 'Minutes waiting to be agreed' });
    await userEvent.click(within(drafts).getByRole('button', { name: 'Open minutes of MTG-3' }));
    expect(
      await screen.findByRole('region', { name: 'MTG-3: Synthetic board' }),
    ).toBeInTheDocument();
  });

  it('approves minutes at a later meeting, offering only meetings held after them', async () => {
    const { send } = renderAt(
      '/compliance?tab=meetings',
      ['compliance.audit.view', 'governance.meeting.manage'],
      get,
    );
    const row = await screen.findByRole('row', { name: /MTG-3/ });
    await userEvent.click(
      within(row).getByRole('button', { name: 'Open meeting MTG-3 Synthetic board' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Approve minutes of MTG-3' }));
    const dialog = screen.getByRole('dialog');
    const picker = within(dialog).getByLabelText('Agreed at which meeting?');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Not recorded', 'MTG-4 Synthetic October board (held 2 Oct 2026)']);
    await userEvent.selectOptions(picker, 'm2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve minutes' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/governance-meetings/m1/approve',
        ORG,
        { approvedAtMeetingId: 'm2' },
        2,
      ),
    );
  });

  it('shows the meeting approved minutes were agreed at', async () => {
    renderAt('/compliance?tab=meetings', ['compliance.audit.view'], (p) =>
      p === '/api/v1/governance-meetings'
        ? {
            data: [
              meeting({
                status: 'APPROVED',
                approvedByName: 'Gina',
                approvedAt: '2026-10-02T15:00:00.000Z',
                approvedAtMeetingId: 'm2',
                approvedAtMeetingCode: 'MTG-4',
              }),
            ],
          }
        : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /MTG-3/ });
    await userEvent.click(
      within(row).getByRole('button', { name: 'Open meeting MTG-3 Synthetic board' }),
    );
    const detail = await screen.findByRole('region', { name: 'MTG-3: Synthetic board' });
    expect(detail).toHaveTextContent('Agreed atMeeting MTG-4');
    expect(within(detail).queryByRole('button', { name: /Approve minutes/ })).toBeNull();
  });
});
