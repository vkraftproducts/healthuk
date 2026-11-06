import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';
import { fieldsOf } from '../src/pages/staff/RecordForm.js';
import { licenceSummary, readinessBadge } from '../src/pages/staff/StaffProfile.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const STAFF = '01900000-0000-7000-8000-000000000201';

const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'm@example.test', displayName: 'Dev' },
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not give access to this page.',
    );
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
      'Expiry: 1 Dec 2026',
    );
    expect(within(table).getByRole('row', { name: /DBS suitability/ })).toHaveTextContent(
      'Policy review date: 1 Mar 2029',
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

  it('lifecycle changes open a dialog, need a reason and go to the API', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : { data: [] },
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Change lifecycle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change lifecycle' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Move to'), 'SUSPENDED');
    const confirm = within(dialog).getByRole('button', { name: 'Move to Suspended' });
    expect(confirm).toBeDisabled(); // reason required
    await userEvent.type(
      within(dialog).getByLabelText('Reason (required)'),
      'Investigation opened',
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/staff/${STAFF}/transition`, ORG, {
        to: 'SUSPENDED',
        reason: 'Investigation opened',
      }),
    );
  });

  it('shows what a role still needs and only allows approval when every check is verified', async () => {
    const checks = {
      role: 'DRIVER',
      setUp: true,
      items: [
        {
          instanceId: 'i1',
          code: 'AMB-STF-02',
          title: 'DBS suitability review',
          status: 'GREY',
          reasonText: 'No verified evidence on record',
          verified: false,
        },
        {
          instanceId: 'i2',
          code: 'AMB-STF-03',
          title: 'Identity and right to work',
          status: 'GREEN',
          reasonText: 'Verified',
          verified: true,
        },
      ],
      blockers: [
        {
          instanceId: 'i1',
          code: 'AMB-STF-02',
          title: 'DBS suitability review',
          status: 'GREY',
          reasonText: 'No verified evidence on record',
          verified: false,
        },
      ],
    };
    renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? detail : p.includes('/role-checks/') ? checks : { data: [] },
    );
    const section = await screen.findByRole('region', { name: 'Checks for a role' });
    expect(
      await within(section).findByText('1 of 2 checks still need verified evidence.'),
    ).toBeInTheDocument();
    expect(within(section).getByText('DBS suitability review')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /Approve for/ })).toBeDisabled();
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
  it('employment history asks about care roles and the reason for leaving [task 18]', () => {
    const f = fieldsOf('EMPLOYMENT_HISTORY');
    expect(f.find((x) => x.name === 'careRole')).toMatchObject({ kind: 'bool' });
    expect(f.find((x) => x.name === 'reasonForLeaving')).toMatchObject({ kind: 'text' });
  });
});

describe('Schedule 3 and driver eligibility [task 18]', () => {
  const s3 = {
    staffId: STAFF,
    asOf: '2026-11-06',
    complete: false,
    items: [
      {
        item: 'DBS',
        title: 'Criminal record (DBS) check at the right level',
        state: 'COMPLETE',
        status: 'GREEN',
        reasonText: 'Enhanced DBS issued 2026-01-05',
        evidenceTitle: 'Enhanced DBS',
      },
      {
        item: 'CONDUCT_REFERENCES',
        title: 'Evidence of conduct in previous employment (references)',
        state: 'ATTENTION',
        status: 'RED',
        reasonText: '1 of 2 satisfactory references',
        evidenceTitle: null,
      },
    ],
  };
  const elig = {
    staffId: STAFF,
    category: 'B',
    asOf: '2026-11-06',
    eligible: false,
    checks: [
      { code: 'ROLE_APPROVED', result: 'PASS', reasonText: 'Approved for the Driver role' },
      { code: 'PHOTOCARD_IN_DATE', result: 'FAIL', reasonText: 'Photocard expired 2026-01-01' },
    ],
  };
  const get = vi.fn(async (p: string) =>
    p === `/api/v1/staff/${STAFF}`
      ? detail
      : p.endsWith('/schedule-3')
        ? s3
        : p.includes('/driver-eligibility')
          ? { ...elig, category: p.split('category=')[1] }
          : { data: [] },
  );

  it('HR sees each Schedule 3 item in words, and the driver checks with reasons', async () => {
    renderAt(`/staff/${STAFF}`, [...MANAGER, 'staff.sensitive.view'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Recruitment' }));
    const row = await screen.findByRole('row', { name: /references/ });
    expect(row).toHaveTextContent('Red – Needs attention');
    expect(row).toHaveTextContent('No requirement covers this yet');
    expect(screen.getByText(/1 item\(s\) not complete/)).toBeInTheDocument();
    expect(await screen.findByText(/Not eligible to drive category B/)).toBeInTheDocument();
    expect(screen.getByText(/Photocard: Photocard expired/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Vehicle needs licence category'), 'C1');
    expect(await screen.findByText(/Not eligible to drive category C1/)).toBeInTheDocument();
  });

  it('without sensitive access the Schedule 3 checklist is not requested', async () => {
    get.mockClear();
    renderAt(`/staff/${STAFF}`, MANAGER, get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Recruitment' }));
    expect(await screen.findByRole('heading', { name: 'Driver eligibility' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Schedule 3 checks' })).toBeNull();
    expect(get.mock.calls.some(([p]) => p.endsWith('/schedule-3'))).toBe(false);
  });
});

describe('record summaries', () => {
  it('humanise codes and drop empty fields', async () => {
    const { summarise } = await import('../src/pages/staff/StaffProfile.js');
    expect(
      summarise({
        outcome: 'SATISFACTORY',
        checkMethod: 'DVLA_SHARE_CODE',
        categories: ['B', 'C1'],
        restrictionCodes: [],
        updateServiceConsent: true,
      }),
    ).toBe(
      'outcome: satisfactory; check method: dvla share code; categories: B, C1; update service consent: yes',
    );
  });
});

describe('training matrix [task 19]', () => {
  const T1 = '01900000-0000-7000-8000-000000000901';
  const T2 = '01900000-0000-7000-8000-000000000902';
  const matrix = {
    columns: [
      {
        templateId: T1,
        code: 'STF-10',
        title: 'Manual handling',
        roles: ['DRIVER'],
        summary: { required: 2, met: 1, dueSoon: 0, overdue: 1, missing: 0, percentMet: 50 },
      },
      {
        templateId: T2,
        code: 'STF-11',
        title: 'Safeguarding level 2',
        roles: ['CARE_ASSISTANT'],
        summary: { required: 0, met: 0, dueSoon: 0, overdue: 0, missing: 0, percentMet: null },
      },
    ],
    rows: [
      {
        staffId: STAFF,
        staffNo: 'ST-0042',
        displayName: 'Synthetic Crew',
        roles: ['DRIVER'],
        hasGap: true,
        cells: [
          {
            templateId: T1,
            required: true,
            instanceId: 'i1',
            status: 'RED',
            state: 'OVERDUE',
            reasonText: 'expired',
            nextDate: '2026-10-01',
          },
          {
            templateId: T2,
            required: false,
            instanceId: null,
            status: null,
            state: 'NOT_REQUIRED',
            reasonText: null,
            nextDate: null,
          },
        ],
      },
    ],
    truncated: false,
  };

  it('shows totals and each cell in words, and filters to people with gaps', async () => {
    const get = vi.fn(async (p: string) =>
      p.startsWith('/api/v1/staff/training-matrix')
        ? matrix
        : p.startsWith('/api/v1/staff?')
          ? { data: [listRow], nextCursor: null }
          : { data: [] },
    );
    renderAt('/staff', MANAGER, get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Training matrix' }));
    const table = await screen.findByRole('table', { name: 'Totals by requirement' });
    const totals = await within(table).findByRole('row', { name: /Manual handling/ });
    expect(totals).toHaveTextContent('1 of 2 (50%)');
    expect(within(table).getByRole('row', { name: /Safeguarding level 2/ })).toHaveTextContent(
      'Nobody needs this',
    );
    const person = screen.getByRole('row', { name: /Synthetic Crew/ });
    expect(person).toHaveTextContent('Red – Overdue (next 1 Oct 2026)');
    expect(person).toHaveTextContent('N/A – Not required');
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Only people with something overdue or missing' }),
    );
    await waitFor(() =>
      expect(get.mock.calls.some(([p]) => p.includes('gapsOnly=true'))).toBe(true),
    );
    await userEvent.selectOptions(screen.getByLabelText('Requirement'), T1);
    await waitFor(() =>
      expect(get.mock.calls.some(([p]) => p.includes(`templateId=${T1}`))).toBe(true),
    );
  });

  it('dispatchers do not get the matrix tab', async () => {
    renderAt('/staff', ['staff.profile.view_clearance'], async () => ({
      data: [],
      nextCursor: null,
    }));
    expect(await screen.findByRole('note')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Training matrix' })).toBeNull();
  });
});

describe('profile header, requests and licence [task 25, findings 15, 48, 50, 51]', () => {
  const full = {
    ...detail,
    locationName: 'Watford station',
    managerName: 'Sam Manager',
    startDate: '2025-04-01',
    contractType: 'BANK',
  };
  const at = (p: string) => (p === `/api/v1/staff/${STAFF}` ? full : { data: [] });

  it('shows location, manager, start date, contract and a readiness badge in words', async () => {
    renderAt(`/staff/${STAFF}`, MANAGER, async (p) => at(p));
    const header = (await screen.findByRole('heading', { name: /Synthetic Crew/ })).closest(
      'header',
    )!;
    expect(header).toHaveTextContent('Watford station');
    expect(header).toHaveTextContent('Sam Manager');
    expect(header).toHaveTextContent('1 Apr 2025');
    expect(header).toHaveTextContent('Bank');
    expect(header).toHaveTextContent(/verified, something due soon/);
    expect(header).not.toHaveTextContent('N/A');
  });

  it('never shows N/A for someone with no approved role', async () => {
    renderAt(`/staff/${STAFF}`, MANAGER, async (p) =>
      p === `/api/v1/staff/${STAFF}` ? { ...full, roles: [], checksSetUp: false } : { data: [] },
    );
    const header = (await screen.findByRole('heading', { name: /Synthetic Crew/ })).closest(
      'header',
    )!;
    expect(header).toHaveTextContent('No approved role yet');
    expect(header).toHaveTextContent(/no approved role yet/);
    expect(header).not.toHaveTextContent('N/A');
  });

  it('offers renewal for verified evidence and sends a review request with a reason', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) => at(p));
    expect(
      await screen.findByRole('button', {
        name: 'Upload renewal evidence for DBS suitability review',
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Request review of DBS suitability review' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Request a review of DBS suitability review',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Send request' });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText('What should be reviewed (required)'),
      'Date looks wrong',
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        `/api/v1/staff/${STAFF}/requests`,
        ORG,
        expect.objectContaining({ kind: 'REVIEW', reason: 'Date looks wrong' }),
      ),
    );
  });

  it('books supervision through a dialog, with a date', async () => {
    const { send } = renderAt(`/staff/${STAFF}`, MANAGER, async (p) => at(p));
    await userEvent.click(await screen.findByRole('button', { name: 'Book supervision' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Book supervision for Synthetic Crew',
    });
    const confirm = within(dialog).getByRole('button', { name: 'Send booking request' });
    await userEvent.type(
      within(dialog).getByLabelText('What the session is for (required)'),
      'Quarterly supervision',
    );
    expect(confirm).toBeDisabled(); // a date is needed
    fireEvent.change(within(dialog).getByLabelText('Proposed date'), {
      target: { value: '2027-02-01' },
    });
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/staff/${STAFF}/requests`, ORG, {
        kind: 'SUPERVISION',
        proposedDate: '2027-02-01',
        reason: 'Quarterly supervision',
      }),
    );
    expect(
      await screen.findByRole('table', { name: 'Review and supervision requests' }),
    ).toBeInTheDocument();
  });

  it('describes a licence in words, with the driver number and how it was checked', () => {
    expect(
      licenceSummary({
        categories: ['B', 'C1'],
        licenceNumber: '••••M9IJ',
        photocardExpiry: '2030-01-31',
        lastCheckedOn: '2026-10-01',
        checkMethod: 'DVLA_SHARE_CODE',
      }),
    ).toBe(
      'Categories B, C1; driver number ••••M9IJ; photocard valid until 31 Jan 2030; ' +
        'checked 1 Oct 2026 by DVLA share code',
    );
  });

  it('readiness badge is never "not applicable"', () => {
    expect(readinessBadge({ checksSetUp: false, roles: [] }).status).toBe('GREY');
    expect(readinessBadge({ overallStatus: 'NOT_APPLICABLE', roles: ['DRIVER'] })).toEqual({
      status: 'GREY',
      reason: 'awaiting evidence or verification',
    });
  });
});

describe('add staff [findings 53, 96]', () => {
  const LOC = '01900000-0000-7000-8000-000000000301';
  const get = async (p: string) =>
    p === `/api/v1/organisations/${ORG}/locations`
      ? { data: [{ id: LOC, name: 'Watford station' }] }
      : p.startsWith('/api/v1/staff?')
        ? { data: [listRow], nextCursor: null }
        : { data: [] };

  it('records work email, start date, contract and manager, then starts role checks', async () => {
    const send = vi.fn(async (_m: string, path: string): Promise<object> =>
      path === '/api/v1/staff' ? { id: 'new-staff' } : {},
    );
    renderAt('/staff', MANAGER, get, send as never);
    const form = (await screen.findByRole('heading', { name: 'Add a staff member' }))
      .closest('section')!
      .querySelector('form')!;
    const f = within(form);
    await userEvent.type(f.getByLabelText('Staff number'), 'st-0100');
    await userEvent.type(f.getByLabelText('Name'), 'New Synthetic');
    await userEvent.type(f.getByLabelText('Work email'), 'new@example.test');
    fireEvent.change(f.getByLabelText('Start date'), { target: { value: '2026-12-01' } });
    await userEvent.selectOptions(f.getByLabelText('Contract type'), 'FIXED_TERM');
    await userEvent.selectOptions(f.getByLabelText('Line manager'), STAFF);
    await userEvent.selectOptions(f.getByLabelText('Role to check for'), 'CARE_ASSISTANT');
    fireEvent.submit(form);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/staff', ORG, {
        staffNo: 'ST-0100',
        displayName: 'New Synthetic',
        primaryLocationId: LOC,
        workEmail: 'new@example.test',
        startDate: '2026-12-01',
        contractType: 'FIXED_TERM',
        managerStaffId: STAFF,
      }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/staff/new-staff/role-checks', ORG, {
        role: 'CARE_ASSISTANT',
      }),
    );
  });

  it('offers a dental practice dental roles only', async () => {
    const dentalMe: MeResponse = {
      ...me(MANAGER),
      memberships: [{ ...me(MANAGER).memberships[0]!, sectorPacks: ['dental'] }],
    };
    const api: ApiClient = {
      me: async () => dentalMe,
      readyz: async () => ({ status: 'ready' }),
      get: async (p) => get(p),
      send: vi.fn(async () => ({})),
    };
    render(<App api={api} history={createMemoryHistory({ initialEntries: ['/staff'] })} />);
    const select = await screen.findByLabelText('Role to check for');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Dentist', 'Dental nurse', 'Receptionist']));
    expect(options).not.toContain('Paramedic');
    expect(options).not.toContain('Driver');
  });
});
