import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { ApiError, type ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { fieldsOf } from '../src/pages/staff/RecordForm.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const STAFF = '01900000-0000-7000-8000-000000000201';

const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'm@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Exora',
      locationId: null,
      roleKey: 'X',
      roleName: 'X',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});

const MANAGER = [
  'staff.profile.view_basic',
  'staff.profile.manage',
  'staff.lifecycle.transition',
  'staff.approve_role',
  'staff.restrict',
  'compliance.evidence.upload',
];
const listRow = {
  id: STAFF,
  staffNo: 'ST-0042',
  displayName: 'Synthetic Crew',
  roles: ['DRIVER', 'CARE_ASSISTANT'],
  lifecycleState: 'ACTIVE',
  activeRestrictions: ['NO_NIGHT_SHIFTS'],
  overallStatus: 'AMBER',
  counts: { red: 0, amber: 1, grey: 0, green: 2 },
};
const instance = (o: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  templateId: crypto.randomUUID(),
  templateTitle: 'Driving licence',
  deadlineKind: 'EXPIRY',
  dueDate: null,
  expiryDate: '2026-12-01',
  reviewDate: null,
  status: 'AMBER',
  reasonText: 'Expires in 32 days (01/12/2026)',
  currentlyVerified: true,
  required: true,
  ...o,
});
const detail = {
  ...listRow,
  userId: null,
  primaryLocationId: ORG,
  managerStaffId: null,
  jobTitle: 'Ambulance care assistant',
  workingPattern: null,
  version: 3,
  roleApprovals: [],
  restrictions: [],
  events: [
    {
      id: 'e1',
      fromState: null,
      toState: 'ACTIVE',
      reason: 'Seeded',
      actorUserId: 'u',
      at: '2026-10-01T09:00:00Z',
    },
  ],
  requirements: [
    instance({}),
    instance({
      templateTitle: 'DBS suitability review',
      deadlineKind: 'REVIEW',
      expiryDate: null,
      reviewDate: '2029-03-01',
      status: 'GREEN',
      reasonText: 'Verified and in date',
    }),
    instance({ templateTitle: 'Paramedic registration', status: 'GREY', required: false }),
  ],
  allowedTransitions: ['SUSPENDED', 'LEAVER'],
};

function renderAt(
  path: string,
  permissions: string[],
  get: (p: string) => Promise<unknown>,
  send = vi.fn(async () => ({})),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send,
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}

beforeEach(() => sessionStorage.clear());

describe('staff list (/staff)', () => {
  it('shows the register with status in words, not colour alone', async () => {
    renderAt('/staff', MANAGER, async (p) =>
      p.startsWith('/api/v1/staff?') ? { data: [listRow], nextCursor: null } : { data: [] },
    );
    const table = await screen.findByRole('table', { name: 'Staff register' });
    const row = await within(table).findByRole('row', { name: /ST-0042/ });
    expect(within(row).getByRole('link', { name: 'Synthetic Crew' })).toBeInTheDocument();
    expect(row).toHaveTextContent('Driver, Care assistant');
    expect(row).toHaveTextContent('No night shifts');
    expect(row).toHaveTextContent('Amber – 1 due soon');
    expect(screen.getByRole('heading', { name: 'Add a staff member' })).toBeInTheDocument();
  });

  it('dispatchers get the clearance-only view and the explanatory note', async () => {
    const { displayName, id, lifecycleState, roles, staffNo, activeRestrictions } = listRow;
    renderAt('/staff', ['staff.profile.view_clearance'], async () => ({
      data: [{ displayName, id, lifecycleState, roles, staffNo, activeRestrictions }],
      nextCursor: null,
    }));
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Dispatcher view shows approved roles and restrictions only.',
    );
    const table = await screen.findByRole('table', { name: 'Staff register' });
    expect(within(table).queryByRole('columnheader', { name: 'Compliance' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add a staff member' })).toBeNull();
  });

  it('refuses the page without a staff permission', async () => {
    renderAt('/staff', ['dashboard.view'], async () => ({ data: [] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have access');
  });
});

describe('staff profile (/staff/:id)', () => {
  it('shows requirements with labelled dates, and marks items not required for current roles', async () => {
    renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    expect(await screen.findByRole('heading', { name: /Synthetic Crew/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Requirements' });
    expect(within(table).getByRole('row', { name: /Driving licence/ })).toHaveTextContent(
      'Expiry: 2026-12-01',
    );
    expect(within(table).getByRole('row', { name: /DBS suitability/ })).toHaveTextContent(
      'Policy review date: 2029-03-01',
    );
    expect(within(table).getByRole('row', { name: /Paramedic registration/ })).toHaveTextContent(
      'Not required for current roles',
    );
    expect(screen.getByRole('tab', { name: 'Recruitment' })).toBeInTheDocument();
  });

  it('hides restricted DBS records without staff.sensitive.view (the API refuses them too)', async () => {
    const get = vi.fn(async (p: string) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    renderAt(`/staff/${STAFF}`, MANAGER, get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Recruitment' }));
    expect(await screen.findByRole('heading', { name: 'References' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'DBS (restricted)' })).toBeNull();
    expect(get.mock.calls.some(([p]) => p.endsWith('/dbs'))).toBe(false);
  });

  it('shows DBS with its "no expiry" explanation to people with sensitive access', async () => {
    renderAt(`/staff/${STAFF}`, [...MANAGER, 'staff.sensitive.view'], async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Recruitment' }));
    expect(await screen.findByRole('heading', { name: 'DBS (restricted)' })).toBeInTheDocument();
    expect(screen.getByText(/A DBS certificate has no expiry/)).toBeInTheDocument();
  });

  it('lifecycle changes need a reason and go to the API', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    const section = await screen.findByRole('region', { name: 'Change lifecycle' });
    await userEvent.selectOptions(within(section).getByLabelText('Move to'), 'SUSPENDED');
    await userEvent.type(
      within(section).getByLabelText('Reason (required)'),
      'Investigation opened',
    );
    await userEvent.click(within(section).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/staff/${STAFF}/transition`, ORG, {
        to: 'SUSPENDED',
        reason: 'Investigation opened',
      }),
    );
  });

  it('starts checks for a role without asking for a reason (B1)', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    const section = await screen.findByRole('region', { name: 'Start checks for a role' });
    expect(within(section).queryByLabelText('Reason (required)')).toBeNull();
    await userEvent.selectOptions(within(section).getByLabelText('Role'), 'TECHNICIAN');
    await userEvent.click(within(section).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/staff/${STAFF}/role-checks`, ORG, {
        role: 'TECHNICIAN',
      }),
    );
  });

  it('says which items still need verifying when a role approval is refused (B1)', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    send.mockRejectedValueOnce(
      new ApiError(
        422,
        'VALIDATION_FAILED',
        'Not every requirement for this role is verified: BLS.',
      ),
    );
    const section = await screen.findByRole('region', { name: 'Approve for a role' });
    await userEvent.type(within(section).getByLabelText('Reason (required)'), 'Ready now');
    await userEvent.click(within(section).getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Not every requirement for this role is verified: BLS.'),
    ).toBeInTheDocument();
  });

  it('dispatchers see the clearance view only, with no tabs', async () => {
    renderAt(`/staff/${STAFF}`, ['staff.profile.view_clearance'], async () => ({
      id: STAFF,
      staffNo: 'ST-0042',
      displayName: 'Synthetic Crew',
      lifecycleState: 'ACTIVE',
      roles: ['DRIVER'],
      activeRestrictions: [],
    }));
    expect(await screen.findByRole('note')).toHaveTextContent(
      'approved roles and restrictions only',
    );
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('record forms are generated from the API contract', () => {
  it('licence form has a category list and the check-method choices', () => {
    const f = fieldsOf('LICENCE');
    expect(f.find((x) => x.name === 'categories')).toMatchObject({ kind: 'list', required: true });
    expect(f.find((x) => x.name === 'checkMethod')).toMatchObject({
      kind: 'enum',
      options: ['DVLA_SHARE_CODE', 'DVLA_API', 'MANUAL'],
    });
    expect(f.find((x) => x.name === 'photocardExpiry')).toMatchObject({
      kind: 'date',
      required: true,
    });
    expect(f.find((x) => x.name === 'penaltyPoints')).toMatchObject({
      kind: 'number',
      required: false,
    });
  });
  it('skips nested objects and treats booleans as checkboxes', () => {
    expect(fieldsOf('PERSONAL').some((x) => x.name === 'nextOfKin')).toBe(false);
    expect(fieldsOf('DBS').find((x) => x.name === 'barredListChecked')).toMatchObject({
      kind: 'bool',
    });
  });
});

describe('buttons say what they act on, with the words spaced', () => {
  it('upload, add record and lift name their item for screen readers', async () => {
    const withRestriction = {
      ...detail,
      restrictions: [
        {
          id: 'r1',
          type: 'NO_NIGHT_SHIFTS',
          reason: 'Return from leave',
          validFrom: '2026-10-01T00:00:00Z',
          validTo: null,
          active: true,
        },
      ],
    };
    renderAt(`/staff/${STAFF}`, [...MANAGER, 'compliance.requirement.view'], async (p) =>
      p === `/api/v1/staff/${STAFF}` ? withRestriction : { data: [] },
    );
    await screen.findByRole('table', { name: 'Requirements' }, { timeout: 5000 });
    expect(
      screen.getByRole('button', { name: 'Upload evidence for Driving licence' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Recruitment' }));
    expect(
      await screen.findByRole('button', { name: 'Add record – References' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByRole('button', { name: 'Lift No night shifts' })).toBeInTheDocument();
  });
});

describe('documents behind a requirement', () => {
  const evidencePath = (id: string) => `/api/v1/requirements/instances/${id}/evidence`;
  const version = (o: Record<string, unknown>) => ({
    title: 'Driving licence check',
    mime: 'application/pdf',
    scanStatus: 'CLEAN',
    ...o,
  });
  function withDocuments(versions: Record<string, unknown>[]) {
    const first = (detail.requirements as { id: string; templateTitle: string }[])[0]!;
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(url);
        return new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
      }),
    );
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/doc-1');
    URL.revokeObjectURL = vi.fn();
    renderAt(`/staff/${STAFF}`, [...MANAGER, 'compliance.requirement.view'], async (p) =>
      p === `/api/v1/staff/${STAFF}`
        ? detail
        : p === evidencePath(first.id)
          ? { data: versions }
          : p.endsWith('/download')
            ? { url: `http://api.test/blob/${p.split('/')[4]}` }
            : { data: [] },
    );
    return { first, opened, fetched };
  }
  const view = async (title: string) => {
    await screen.findByRole('table', { name: 'Requirements' }, { timeout: 5000 });
    await userEvent.click(screen.getByRole('button', { name: `View document for ${title}` }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it('shows the latest verified document on screen, without downloading it or opening a tab', async () => {
    const { first, opened, fetched } = withDocuments([
      version({ id: 'newer-pending', state: 'PENDING_VERIFICATION' }),
      version({ id: 'verified', state: 'VERIFIED' }),
      version({ id: 'older', state: 'VERIFIED' }),
    ]);
    await view(first.templateTitle);
    const viewer = await screen.findByRole('dialog', { name: 'Driving licence check' });
    expect(viewer.querySelector('iframe')).toHaveAttribute('src', 'blob:http://localhost/doc-1');
    expect(fetched).toEqual(['http://api.test/blob/verified']);
    expect(opened).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/doc-1');
  });

  it('shows a document awaiting review when nothing is verified yet, so it can be checked', async () => {
    const { first, fetched } = withDocuments([
      version({ id: 'quarantined', state: 'PENDING_VERIFICATION', scanStatus: 'PENDING' }),
      version({ id: 'awaiting', state: 'PENDING_VERIFICATION', mime: 'image/png', title: 'Scan' }),
    ]);
    await view(first.templateTitle);
    const viewer = await screen.findByRole('dialog', { name: 'Scan' });
    expect(viewer.querySelector('img')).toHaveAttribute('src', 'blob:http://localhost/doc-1');
    expect(fetched).toEqual(['http://api.test/blob/awaiting']);
  });

  it('offers a download for files that cannot be shown on screen', async () => {
    const { first } = withDocuments([
      version({ id: 'sheet', state: 'VERIFIED', mime: 'text/csv', title: 'Training export' }),
    ]);
    await view(first.templateTitle);
    const viewer = await screen.findByRole('dialog', { name: 'Training export' });
    expect(viewer).toHaveTextContent(/cannot be shown here/);
    expect(viewer.querySelector('iframe, img')).toBeNull();
  });

  it('says so when there is no document on file, and opens nothing', async () => {
    const { first, fetched } = withDocuments([]);
    await view(first.templateTitle);
    expect(await screen.findByText(/No document on file yet/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetched).toEqual([]);
  });
});

describe('record summaries', () => {
  it('names the colleague instead of showing an id', async () => {
    const { summarise } = await import('../src/pages/staff/StaffProfile.js');
    expect(
      summarise(
        { completedOn: '2025-10-24', signedOffByUserId: 'u1', checkerUserId: 'u2' },
        { u1: 'Hana Rowe' },
      ),
    ).toEqual([
      ['Completed on', '2025-10-24'],
      ['Signed off by', 'Hana Rowe'],
      ['Checker', 'a former colleague'],
    ]);
  });

  it('labels each field, writes codes in words with acronyms kept, and drops empty fields', async () => {
    const { summarise } = await import('../src/pages/staff/StaffProfile.js');
    expect(
      summarise({
        outcome: 'SATISFACTORY',
        checkMethod: 'DVLA_SHARE_CODE',
        categories: ['B', 'C1'],
        restrictionCodes: [],
        penaltyPoints: 0,
        updateServiceConsent: true,
      }),
    ).toEqual([
      ['Outcome', 'Satisfactory'],
      ['Check method', 'DVLA share code'],
      ['Categories', 'B, C1'],
      ['Penalty points', '0'],
      ['Update service consent', 'Yes'],
    ]);
  });

  it('writes the valid period in words, with no placeholder for a missing start', async () => {
    const { validity } = await import('../src/pages/staff/StaffProfile.js');
    expect(validity(null, '2029-04-21')).toBe('Until 2029-04-21');
    expect(validity('2025-09-01', null)).toBe('From 2025-09-01, no end date');
    expect(validity('2025-09-01', '2027-09-01')).toBe('2025-09-01 to 2027-09-01');
    expect(validity(null, null)).toBe('—');
  });
});
