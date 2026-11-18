// v36 Staff module: People, Onboarding (pipeline, person file, evidence review) and Shifts.
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { defaultGet, testApi, TEST_ORG } from './test-api.js';

const MANAGER = [
  'staff.profile.view_basic',
  'staff.profile.manage',
  'staff.lifecycle.transition',
  'compliance.evidence.upload',
  'compliance.evidence.verify',
  'jobs.job.view',
];
let n = 0;
const id = () => `01900000-0000-7000-8000-${String(++n).padStart(12, '0')}`;
const person = (o: Record<string, unknown>) => ({
  id: id(),
  staffNo: 'ST-0001',
  displayName: 'Synthetic Person',
  lifecycleState: 'ACTIVE',
  jobTitle: null,
  roles: ['CARE_ASSISTANT'],
  activeRestrictions: [],
  overallStatus: 'GREEN',
  checksSetUp: true,
  counts: { red: 0, amber: 0, grey: 0, green: 3 },
  ...o,
});
const ready = person({ displayName: 'Ready Rowan', staffNo: 'ST-0101' });
const blocked = person({
  displayName: 'Blocked Blake',
  staffNo: 'ST-0102',
  counts: { red: 1, amber: 0, grey: 1, green: 2 },
});
const starter = person({
  displayName: 'Starter Sam',
  staffNo: 'ST-0103',
  lifecycleState: 'CHECKS_IN_PROGRESS',
  roles: [],
  counts: { red: 0, amber: 0, grey: 2, green: 1 },
});
const review = person({
  displayName: 'Review Riley',
  staffNo: 'ST-0104',
  lifecycleState: 'READY_FOR_REVIEW',
  roles: [],
});
const unset = person({ displayName: 'Unset Uma', staffNo: 'ST-0105', checksSetUp: false });
const STAFF = [ready, blocked, starter, review, unset];

const DBS = id();
const MINE = id();
const queue = {
  data: [
    {
      id: DBS,
      title: 'DBS.pdf',
      mine: false,
      state: 'PENDING_VERIFICATION',
      requirements: [
        {
          instanceId: id(),
          templateTitle: 'DBS',
          deadlineKind: 'DUE',
          subjectType: 'STAFF',
          subjectId: starter.id,
          subjectLabel: 'Starter Sam',
        },
      ],
    },
    {
      id: MINE,
      title: 'MOT.pdf',
      mine: true,
      state: 'PENDING_VERIFICATION',
      requirements: [
        {
          instanceId: id(),
          templateTitle: 'MOT',
          deadlineKind: 'EXPIRY',
          subjectType: 'VEHICLE',
          subjectId: id(),
          subjectLabel: 'AMB-01',
        },
      ],
    },
  ],
};
const check = (o: Record<string, unknown>) => ({
  id: id(),
  templateTitle: 'Check',
  templateCode: 'AMB-STF-00',
  deadlineKind: 'DUE',
  status: 'GREY',
  reasonText: 'No verified evidence on record',
  currentlyVerified: false,
  required: false,
  ...o,
});
const dbsCheck = check({ templateTitle: 'Enhanced DBS check' });
const refCheck = check({ templateTitle: 'Two references' });
const idCheck = check({
  templateTitle: 'Proof of identity',
  status: 'GREEN',
  reasonText: 'Verified and in date',
  currentlyVerified: true,
});
const file = {
  ...starter,
  roleApprovals: [],
  restrictions: [],
  events: [
    {
      id: id(),
      toState: 'CHECKS_IN_PROGRESS',
      at: '2026-10-31T09:00:00Z',
      reason: 'Offer accepted',
    },
  ],
  requirements: [idCheck, dbsCheck, refCheck],
  allowedTransitions: ['READY_FOR_REVIEW', 'CANDIDATE'],
};
const evidence: Record<string, unknown> = {
  [`/api/v1/requirements/instances/${dbsCheck.id}/evidence`]: {
    data: [
      {
        id: DBS,
        title: 'DBS.pdf',
        state: 'PENDING_VERIFICATION',
        uploadedBy: 'someone-else',
        uploadedByName: 'Hana Rowe',
        uploadedAt: '2026-11-15T10:00:00Z',
        decidedAt: null,
      },
    ],
  },
  [`/api/v1/requirements/instances/${idCheck.id}/evidence`]: {
    data: [
      {
        id: id(),
        title: 'Passport.pdf',
        state: 'VERIFIED',
        uploadedBy: 'someone-else',
        uploadedByName: 'Hana Rowe',
        uploadedAt: '2026-11-02T10:00:00Z',
        reviewerName: 'Gina Ode',
        decidedAt: '2026-11-03T10:00:00Z',
      },
    ],
  },
  [`/api/v1/staff/${starter.id}/chase-log`]: {
    data: [
      {
        id: id(),
        staffId: starter.id,
        kind: 'REFERENCE',
        subject: 'Two references',
        requestedOn: '2026-11-04',
        chasedOn: '2026-11-11',
        receivedOn: null,
        note: null,
        createdAt: '2026-11-04T09:00:00Z',
      },
    ],
  },
};
const get = defaultGet((p) => {
  if (p.startsWith('/api/v1/staff?')) return { data: STAFF, nextCursor: null };
  if (p === '/api/v1/evidence/review-queue') return queue;
  if (p === `/api/v1/staff/${starter.id}`) return file;
  return evidence[p];
});
function renderAt(path: string, send = vi.fn(async () => ({}))) {
  render(
    <App
      api={testApi(MANAGER, get, { send })}
      history={createMemoryHistory({ initialEntries: [path] })}
    />,
  );
  return send;
}

describe('Staff / People (v36)', () => {
  it('shows checks verified and readiness in words, with the reason when not ready', async () => {
    renderAt('/staff');
    const row = await screen.findByRole('button', { name: /ST-0102/ });
    expect(row).toHaveTextContent('2 of 4');
    expect(row).toHaveTextContent('Not ready');
    expect(row).toHaveTextContent('1 overdue or expired, 1 missing or unverified');
    expect(screen.getByRole('button', { name: /ST-0105/ })).toHaveTextContent(
      'No checks set up for the approved role yet',
    );
    expect(screen.getByRole('button', { name: /ST-0103/ })).toHaveTextContent('Onboarding');
  });
});

describe('Staff / Onboarding pipeline (v36)', () => {
  it('groups starters by stage with counts and tags in words', async () => {
    renderAt('/staff?tab=onboarding');
    const col = await screen.findByRole('region', { name: 'Checks in progress' });
    const card = await within(col).findByRole('button', { name: /Starter Sam/ });
    expect(card).toHaveTextContent('1 of 3 checks verified');
    await waitFor(() => expect(card).toHaveTextContent('1 to verify'));
    expect(
      within(screen.getByRole('region', { name: 'Ready for review' })).getByText(
        'Awaiting sign-off',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Active' })).getByRole('button', {
        name: /Blocked Blake/,
      }),
    ).toHaveTextContent('2 outstanding');
  });

  it('opens the person file: who uploaded and verified, chase dates, and Verify for someone else’s upload', async () => {
    const send = renderAt('/staff?tab=onboarding');
    await userEvent.click(await screen.findByRole('button', { name: /Starter Sam/ }));
    const idRow = (await screen.findByText('Proof of identity', { selector: 'strong' })).closest('tr')!;
    await waitFor(() => expect(idRow).toHaveTextContent('Gina Ode'));
    const refRow = screen.getByText('Two references', { selector: 'strong' }).closest('tr')!;
    expect(refRow).toHaveTextContent('Requested 4 Nov 2026');
    expect(refRow).toHaveTextContent('Chased 11 Nov 2026');
    const dbsRow = screen.getByText('Enhanced DBS check', { selector: 'strong' }).closest('tr')!;
    await waitFor(() => expect(dbsRow).toHaveTextContent('Received – awaiting verification'));
    expect(dbsRow).toHaveTextContent('by Hana Rowe');
    await userEvent.click(within(dbsRow).getByRole('button', { name: /Verify/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/evidence/${DBS}/verify`, TEST_ORG, {
        decision: 'ACCEPTED',
      }),
    );
  });

  it('submits for approval with a reason', async () => {
    const send = renderAt('/staff?tab=onboarding');
    await userEvent.click(await screen.findByRole('button', { name: /Starter Sam/ }));
    await userEvent.click(await screen.findByRole('button', { name: /Submit for approval/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'All checks verified');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        `/api/v1/staff/${starter.id}/transition`,
        TEST_ORG,
        {
          to: 'READY_FOR_REVIEW',
          reason: 'All checks verified',
        },
      ),
    );
  });

  it('evidence review filters the queue by area (v36: no counts over the queue)', async () => {
    renderAt('/staff?tab=onboarding&view=review');
    const table = await screen.findByRole('table', { name: 'Waiting for verification' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(2));
    const all = within(table).getAllByRole('row').length;
    await userEvent.click(screen.getByRole('radio', { name: 'Vehicle' }));
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeLessThan(all));
  });
});

describe('Staff / Shifts rota (v36)', () => {
  it('shows each person’s week and a working-time prompt in words', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
      new Date(),
    );
    const t = (h: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + h * 3_600_000).toISOString();
    const shift = (s: string, e: string) => ({
      id: id(),
      vehicleCallsign: 'AMB-01',
      state: 'PLANNED',
      startsAt: s,
      endsAt: e,
      crew: [
        {
          staffId: ready.id,
          staffNo: 'ST-0101',
          displayName: 'Ready Rowan',
          role: 'DRIVER',
          startsAt: s,
          endsAt: e,
          active: true,
        },
      ],
    });
    const shifts = [shift(t(-14), t(-4)), shift(t(4), t(14))];
    const api = testApi(
      MANAGER,
      defaultGet((p) => (p.startsWith('/api/v1/shifts?date=') ? { data: shifts } : undefined)),
    );
    render(
      <App api={api} history={createMemoryHistory({ initialEntries: ['/staff?tab=shifts'] })} />,
    );
    expect(await screen.findByText('Ready Rowan')).toBeInTheDocument();
    expect(
      await screen.findByText(/Only 8h rest since last shift \(11h minimum\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/need a working-time check/)).toBeInTheDocument();
  });
});
