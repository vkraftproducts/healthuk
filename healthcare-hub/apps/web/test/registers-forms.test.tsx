import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

/** Task 15 (registers and forms) and task 26 fleet follow-ups. Synthetic data only. */
const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const OTHER = '01900000-0000-7000-8000-000000000102';
const VEH = '01900000-0000-7000-8000-000000000301';
const LOC = '01900000-0000-7000-8000-000000000011';
const JOB = '01900000-0000-7000-8000-000000000917';
const S1 = '01900000-0000-7000-8000-000000000501';

const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'r@example.test', displayName: 'Dev' },
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
  path: string,
  permissions: string[],
  get: (p: string) => unknown,
  send: ReturnType<typeof vi.fn> = vi.fn(async () => ({})),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send: send as unknown as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: [path] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

const vehicle = {
  id: VEH,
  callsign: 'AMB-03',
  registration: 'AB12CDE',
  vin: 'WDB9066331S123456',
  type: 'PTS_VEHICLE',
  ownership: 'LEASED',
  baseLocationId: LOC,
  seats: 4,
  wheelchairCapacity: 1,
  stretcher: false,
  permittedLoads: ['Bariatric'],
  licenceCategory: 'C1',
  grossWeightKg: 4250,
  status: 'AVAILABLE',
  statusReason: null,
  currentOdometer: 42000,
  latestReading: { reading: 42000, readOn: '2026-10-30' },
  openDefects: 0,
  version: 3,
};
const FLEET = ['fleet.vehicle.view', 'fleet.vehicle.manage'];
const capability = { stretcher: false, wheelchairCapacity: 1, clinicalKit: false, lost: [] };

describe('vehicle register (findings 39, 41, 42, 43)', () => {
  it('shows the latest reading with its date, or says there are none', async () => {
    const none = { ...vehicle, id: 'v2', callsign: 'AMB-09', latestReading: null };
    renderAt('/vehicles', ['fleet.vehicle.view'], (p) =>
      p.startsWith('/api/v1/vehicles') ? { data: [vehicle, none], nextCursor: null } : { data: [] },
    );
    const row = await screen.findByRole('row', { name: /AMB-03/ });
    expect(row).toHaveTextContent('42,000 mi (30 Oct 2026)');
    expect(row).toHaveTextContent('Patient transport vehicle');
    expect(screen.getByRole('row', { name: /AMB-09/ })).toHaveTextContent('No readings');
  });

  it('add vehicle names each field that needs fixing and sends nothing', async () => {
    const { send } = renderAt('/vehicles', FLEET, (p) =>
      p.includes('/locations') ? { data: [{ id: LOC, name: 'Watford' }] } : { data: [] },
    );
    const form = await screen.findByRole('form', { name: 'Add a vehicle' });
    await userEvent.type(within(form).getByLabelText('Registration (required)'), 'A!');
    await userEvent.type(within(form).getByLabelText('VIN (optional)'), 'SHORT');
    await userEvent.click(within(form).getByRole('button', { name: 'Add vehicle' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Registration: Registration must be a UK format such as SY21 ABC',
    );
    expect(alert).toHaveTextContent('Callsign: Use 2 to 16 letters');
    expect(alert).toHaveTextContent('VIN: A VIN has 17 letters');
    expect(send).not.toHaveBeenCalled();
  });

  it('add vehicle sends the register fields, including weight and licence category', async () => {
    const { send } = renderAt('/vehicles', FLEET, (p) =>
      p.includes('/locations') ? { data: [{ id: LOC, name: 'Watford' }] } : { data: [] },
    );
    const form = await screen.findByRole('form', { name: 'Add a vehicle' });
    await userEvent.type(within(form).getByLabelText('Registration (required)'), 'ab12 cde');
    await userEvent.type(within(form).getByLabelText('Callsign (required)'), 'PTS-04');
    await userEvent.selectOptions(
      within(form).getByLabelText('Licence category needed to drive it'),
      'C1',
    );
    await userEvent.type(within(form).getByLabelText(/Gross vehicle weight/), '4250');
    expect(within(form).getByText('Needs C1')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Add vehicle' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/vehicles',
        ORG,
        expect.objectContaining({
          registration: 'ab12 cde',
          callsign: 'PTS-04',
          baseLocationId: LOC,
          licenceCategory: 'C1',
          grossWeightKg: 4250,
        }),
      ),
    );
    expect(await screen.findByText(/MOT once it is three years old/)).toBeInTheDocument();
  });

  it('D1: a leased vehicle needs its end date; over 3,500 kg needs C1', async () => {
    const { send } = renderAt('/vehicles', FLEET, (p) =>
      p.includes('/locations') ? { data: [{ id: LOC, name: 'Watford' }] } : { data: [] },
    );
    const form = await screen.findByRole('form', { name: 'Add a vehicle' });
    await userEvent.type(within(form).getByLabelText('Registration (required)'), 'SY21 ABC');
    await userEvent.type(within(form).getByLabelText('Callsign (required)'), 'AMB-21');
    await userEvent.type(within(form).getByLabelText(/Gross vehicle weight/), '3900');
    expect(within(form).getByText('Needs C1')).toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText('Ownership'), 'LEASED');
    await userEvent.click(within(form).getByRole('button', { name: 'Add vehicle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Lease or hire end date: Give the lease or hire end date',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('vehicle page shows the register and edits it with the record version', async () => {
    const { send } = renderAt(`/vehicles/${VEH}`, [...FLEET, 'compliance.requirement.view'], (p) =>
      p === `/api/v1/vehicles/${VEH}`
        ? {
            ...vehicle,
            maintenance: [],
            readings: [],
            locations: [],
            capability,
          }
        : p.includes('/locations')
          ? { data: [{ id: LOC, name: 'Watford' }] }
          : p.startsWith('/api/v1/requirements/instances')
            ? {
                data: [
                  {
                    id: 'i1',
                    templateId: 't1',
                    templateTitle: 'MOT certificate',
                    status: 'RED',
                    reasonText: 'No verified evidence on record',
                  },
                ],
              }
            : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Register details' }));
    const section = await screen.findByRole('region', { name: 'Vehicle register' });
    expect(section).toHaveTextContent('WDB9066331S123456');
    expect(section).toHaveTextContent('Leased');
    expect(section).toHaveTextContent('4,250 kg');
    expect(section).toHaveTextContent('C1 – medium vehicle');
    expect(await within(section).findByText(/MOT certificate/)).toBeInTheDocument();
    await userEvent.click(
      within(section).getByRole('button', { name: 'Edit register details for AMB-03' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit register details for AMB-03' });
    const gvw = within(dialog).getByLabelText(/Gross vehicle weight/);
    await userEvent.clear(gvw);
    await userEvent.type(gvw, '3500');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save details' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        `/api/v1/vehicles/${VEH}`,
        ORG,
        expect.objectContaining({ grossWeightKg: 3500, ownership: 'LEASED' }),
        3,
      ),
    );
  });

  it('documents tab offers only published organisation vehicle requirements', async () => {
    const tpl = (id: string, title: string, isLibrary: boolean, subjectType = 'VEHICLE') => ({
      id,
      title,
      isLibrary,
      versions: [{ status: 'EFFECTIVE', subjectType, deadlineKind: 'EXPIRY' }],
    });
    const { send } = renderAt(
      `/vehicles/${VEH}`,
      [...FLEET, 'compliance.requirement.view', 'compliance.requirement.manage'],
      (p) =>
        p === `/api/v1/vehicles/${VEH}`
          ? {
              ...vehicle,
              maintenance: [],
              readings: [],
              locations: [],
              capability,
            }
          : p.startsWith('/api/v1/requirements/templates')
            ? {
                data: [
                  tpl('t-ins', 'Motor insurance', false),
                  tpl('t-lib', 'MOT (library)', true),
                  tpl('t-staff', 'Manual handling', false, 'STAFF'),
                ],
              }
            : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Documents' }));
    const form = await screen.findByRole('form', { name: 'Add a document requirement' });
    const select = within(form).getByLabelText('Requirement');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('Motor insurance');
    expect(options).not.toContain('MOT (library)');
    expect(options).not.toContain('Manual handling');
    await userEvent.selectOptions(select, 't-ins');
    await userEvent.type(within(form).getByLabelText(/Current expiry date/), '2027-03-01');
    await userEvent.click(within(form).getByRole('button', { name: 'Add requirement' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/requirements/instances', ORG, {
        templateId: 't-ins',
        subjectType: 'VEHICLE',
        subjectId: VEH,
        expiryDate: '2027-03-01',
      }),
    );
  });
});

describe('inspection checklists and equipment (findings 7, 44)', () => {
  it('drafts a checklist with critical items (D6: published by a second person)', async () => {
    const { send } = renderAt('/vehicles', FLEET, () => ({ data: [] }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Inspection checklists' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Draft a new checklist' }));
    const dialog = screen.getByRole('dialog', { name: 'Draft a new checklist' });
    await userEvent.type(within(dialog).getByLabelText('Checklist name'), 'Daily vehicle check');
    await userEvent.type(within(dialog).getByLabelText('Item 1'), 'Tyres');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/vdi-templates', ORG, {
        name: 'Daily vehicle check',
        items: [{ code: 'TYRES_1', label: 'Tyres', critical: true }],
      }),
    );
  });

  it('D6: the drafter cannot publish; someone else can', async () => {
    const tpl = (id: string, createdBy: string) => ({
      id,
      name: `Daily check ${id}`,
      vehicleType: null,
      version: 2,
      items: [{ code: 'TYRES_1', label: 'Tyres', critical: true }],
      active: false,
      status: 'DRAFT',
      createdBy,
      createdByName: createdBy === ME ? 'Dev' : 'Sam Other',
      publishedBy: null,
      publishedByName: null,
      publishedAt: null,
    });
    const { send } = renderAt('/vehicles', FLEET, (p) =>
      p === '/api/v1/vdi-templates?all=true'
        ? { data: [tpl('t1', ME), tpl('t2', OTHER)] }
        : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Inspection checklists' }));
    const mine = await screen.findByRole('row', { name: /Daily check t1/ });
    expect(mine).toHaveTextContent('someone else must publish it');
    expect(within(mine).queryByRole('button', { name: /^Publish/ })).toBeNull();
    const theirs = screen.getByRole('row', { name: /Daily check t2/ });
    expect(theirs).toHaveTextContent('Draft – awaiting a second person to publish');
    await userEvent.click(
      within(theirs).getByRole('button', { name: 'Publish Daily check t2 version 2' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish checklist' }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/vdi-templates/t2/publish', ORG, {}),
    );
  });

  it('edits an asset and moves it to a base', async () => {
    const asset = {
      id: 'e1',
      assetTag: 'STR-04',
      category: 'STRETCHER',
      model: null,
      serial: null,
      manufacturer: null,
      swlKg: 227,
      vehicleId: VEH,
      locationId: null,
      status: 'AVAILABLE',
      quarantineReason: null,
      regimes: [
        {
          regime: 'LOLER_THOROUGH',
          status: 'RED',
          reasonText: 'Overdue',
          requirementInstanceId: 'r',
        },
      ],
      version: 5,
    };
    const { send } = renderAt('/vehicles', FLEET, (p) =>
      p.startsWith('/api/v1/equipment')
        ? { data: [asset] }
        : p.includes('/locations')
          ? { data: [{ id: LOC, name: 'Watford' }] }
          : p.startsWith('/api/v1/vehicles')
            ? { data: [vehicle] }
            : { data: [] },
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Equipment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show details of STR-04' }));
    expect(screen.getByRole('heading', { name: 'STR-04' })).toBeInTheDocument();
    expect(screen.getAllByText(/LOLER thorough examination/).length).toBeGreaterThan(1);
    await userEvent.click(screen.getByRole('button', { name: 'Edit STR-04' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit STR-04' });
    await userEvent.type(within(dialog).getByLabelText('Serial number (optional)'), 'SN-1');
    await userEvent.selectOptions(within(dialog).getByLabelText('Kept'), 'location');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save asset' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/equipment/e1',
        ORG,
        expect.objectContaining({ serial: 'SN-1', vehicleId: null, locationId: LOC }),
        5,
      ),
    );
  });
});

describe('premises register (findings 64, 65)', () => {
  const PREM = ['premises.item.view', 'premises.item.manage', 'compliance.requirement.view'];
  const item = {
    id: '1',
    locationId: LOC,
    controlArea: 'FIRE',
    title: 'Fire risk assessment',
    responsibleUserId: OTHER,
    responsibleName: 'Pat Premises',
    actionOwnerUserId: OTHER,
    actionOwnerName: 'Pat Premises',
    contractorName: null,
    assessmentRef: null,
    assessedOn: null,
    frequencySource: 'Competent person advice',
    requirementInstanceId: null,
    scheduleTitle: null,
    deadlineKind: null,
    evidenceCount: 0,
    applicable: true,
    status: 'GREY',
    reasonText: 'No schedule linked yet',
    nextDue: null,
    version: 2,
  };
  const templates = {
    data: [
      {
        id: 't-org',
        title: 'Fire risk assessment (annual)',
        isLibrary: false,
        versions: [{ status: 'EFFECTIVE', subjectType: 'PREMISES' }],
      },
      {
        id: 't-lib',
        title: 'Library fire item',
        isLibrary: true,
        versions: [{ status: 'EFFECTIVE', subjectType: 'PREMISES' }],
      },
    ],
  };
  const get = (p: string) =>
    p.includes('premises-items')
      ? { data: [item] }
      : p.includes('/locations')
        ? { data: [{ id: LOC, name: 'Watford', type: 'OPERATIONAL' }] }
        : p.startsWith('/api/v1/requirements/templates')
          ? templates
          : { data: [] };

  it('names the responsible person and offers only adopted schedules', async () => {
    renderAt('/premises', PREM, get);
    const row = await screen.findByRole('row', { name: /Fire risk assessment/ });
    expect(row).toHaveTextContent('Pat Premises');
    expect(row).not.toHaveTextContent('Assigned');
    expect(row).toHaveTextContent('No schedule linked');
    await userEvent.click(screen.getByRole('button', { name: 'Add premises item' }));
    const schedule = await screen.findByLabelText('Schedule (optional)');
    const options = within(schedule)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toContain('Fire risk assessment (annual)');
    expect(options).not.toContain('Library fire item');
  });

  it('links a schedule later with a first due date', async () => {
    const { send } = renderAt('/premises', PREM, get);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Link a schedule to Fire risk assessment' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Link a schedule to Fire risk assessment' });
    await userEvent.selectOptions(within(dialog).getByLabelText('Schedule'), 't-org');
    await userEvent.type(within(dialog).getByLabelText('First due date (optional)'), '2027-01-15');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Link schedule' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/premises-items/1/schedule', ORG, {
        templateId: 't-org',
        dueDate: '2027-01-15',
      }),
    );
  });

  it('edits the item with its version', async () => {
    const { send } = renderAt('/premises', PREM, get);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Fire risk assessment' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Fire risk assessment' });
    await userEvent.type(within(dialog).getByLabelText('Contractor (optional)'), 'Synthetic Fire');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'PATCH',
        '/api/v1/premises-items/1',
        ORG,
        expect.objectContaining({ contractorName: 'Synthetic Fire', responsibleUserId: OTHER }),
        2,
      ),
    );
  });
});

describe('planner (findings 68, 69, 70)', () => {
  const crew = (id: string, name: string, role: string) => ({
    id,
    staffId: id,
    staffNo: 'ST-0001',
    displayName: name,
    role,
    startsAt: '2026-10-30T07:00:00Z',
    endsAt: '2026-10-30T19:00:00Z',
    active: true,
  });
  const planner = {
    date: '2026-10-30',
    shifts: [
      {
        id: S1,
        locationId: LOC,
        vehicleId: VEH,
        vehicleCallsign: 'AMB-01',
        vehicleStatus: 'AVAILABLE',
        startsAt: '2026-10-30T07:00:00Z',
        endsAt: '2026-10-30T19:00:00Z',
        state: 'PLANNED',
        crew: [crew('c1', 'Alex Driver', 'DRIVER')],
        jobs: [],
        changes: [],
        version: 1,
      },
    ],
    unallocated: [
      {
        id: JOB,
        code: 'J-117',
        state: 'BOOKED',
        pickupFrom: '2026-10-30T13:00:00Z',
        pickupTo: '2026-10-30T13:30:00Z',
        plannedStart: '2026-10-30T13:00:00Z',
        plannedEnd: '2026-10-30T14:00:00Z',
        pickupAddress: '1 Example Road',
        destinationAddress: 'Example General Hospital',
        mobility: 'WALKING',
        stairs: false,
        infectionPrecautions: false,
        escorts: 0,
        crewSize: 2,
        requiredSkills: ['BARIATRIC'],
        requiredEquipment: [],
        accessPlanReviewed: true,
      },
    ],
  };
  const policyFail = {
    allowed: false,
    checks: [
      {
        code: 'COMPETENCE',
        result: 'FAIL',
        reasonText: 'Bariatric competence missing',
        overridable: true,
        excepted: false,
        details: ['Alex Driver: Bariatric competence missing'],
      },
    ],
  };
  const DISPATCH = ['jobs.job.view', 'jobs.allocate', 'fleet.vehicle.view'];

  it('a dispatcher asks for a policy exception; plain details show names, not codes', async () => {
    const send = vi.fn(async (_m: unknown, path: unknown) =>
      String(path).endsWith('/validate') ? policyFail : {},
    );
    renderAt(
      '/planner',
      DISPATCH,
      (p) => (p.startsWith('/api/v1/planner') ? planner : { data: [] }),
      send,
    );
    await userEvent.click(await screen.findByRole('button', { name: /J-117/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Check J-117 on AMB-01' }));
    const checks = await screen.findByRole('list', { name: 'Checks' });
    await within(checks).findByText('Alex Driver: Bariatric competence missing');
    expect(checks).not.toHaveTextContent('COMPETENCE');
    await userEvent.click(
      within(checks).getByRole('button', { name: 'Ask for an exception for Competence' }),
    );
    await userEvent.type(
      screen.getByLabelText('Reason (recorded in the audit trail)'),
      'Bariatric-trained supervisor attending',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/allocation-exception-requests',
        ORG,
        expect.objectContaining({ jobId: JOB, shiftId: S1, checkCode: 'COMPETENCE' }),
      ),
    );
    expect(send).not.toHaveBeenCalledWith(
      'POST',
      '/api/v1/allocation-exceptions',
      expect.anything(),
      expect.anything(),
    );
  });

  it('an approver decides requests from others but not their own', async () => {
    const request = (id: string, by: string, byName: string) => ({
      id,
      jobId: JOB,
      jobCode: 'J-117',
      shiftId: S1,
      vehicleCallsign: 'AMB-01',
      checkCode: 'COMPETENCE',
      reason: 'Bariatric-trained supervisor attending',
      expiresAt: '2026-11-01T23:59:00Z',
      requestedBy: by,
      requestedByName: byName,
      requestedAt: '2026-10-30T09:00:00Z',
      status: 'REQUESTED',
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      decisionNote: null,
    });
    const { send } = renderAt('/planner', [...DISPATCH, 'allocation.exception.approve'], (p) =>
      p.startsWith('/api/v1/planner')
        ? planner
        : p.startsWith('/api/v1/allocation-exception-requests?status=REQUESTED')
          ? { data: [request('q1', OTHER, 'Sam Dispatcher'), request('q2', ME, 'Dev')] }
          : { data: [] },
    );
    const section = await screen.findByRole('region', {
      name: 'Exceptions waiting for a decision',
    });
    await within(section).findByText(/Asked by Sam Dispatcher/);
    expect(within(section).getByText(/You asked for this: someone else must decide/)).toBeVisible();
    expect(within(section).getAllByRole('button', { name: /^Approve exception/ })).toHaveLength(1);
    await userEvent.click(
      within(section).getByRole('button', { name: /^Refuse exception for J-117/ }),
    );
    const dialog = screen.getByRole('dialog', { name: /Refuse exception/ });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Supervisor not available');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refuse exception' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/allocation-exception-requests/q1/decide',
        ORG,
        { decision: 'REJECTED', note: 'Supervisor not available' },
      ),
    );
  });

  it('the second crew member list leaves out the chosen driver', async () => {
    const staff = [
      { id: 's1', displayName: 'Alex Driver', staffNo: 'ST-1', roles: ['DRIVER'] },
      { id: 's2', displayName: 'Sam Carer', staffNo: 'ST-2', roles: ['CARE_ASSISTANT'] },
    ];
    renderAt('/planner', DISPATCH, (p) =>
      p.startsWith('/api/v1/planner')
        ? planner
        : p.startsWith('/api/v1/staff')
          ? { data: staff }
          : p.startsWith('/api/v1/vehicles')
            ? {
                data: [
                  { id: 'v1', callsign: 'AMB-01', status: 'AVAILABLE' },
                  { id: 'v3', callsign: 'AMB-03', status: 'BLOCKED', statusReason: '1 defect' },
                ],
              }
            : { data: [] },
    );
    const form = await screen.findByRole('form', { name: 'Plan a shift' });
    await waitFor(() => expect(within(form).getByLabelText('Driver')).toHaveValue('s1'));
    const second = within(within(form).getByLabelText('Second crew member'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(second).not.toContain('Alex Driver (ST-1)');
    expect(second).toContain('Sam Carer (ST-2)');
    const blocked = within(within(form).getByLabelText('Vehicle')).getByRole('option', {
      name: /AMB-03 – blocked: 1 defect/,
    });
    expect(blocked).toBeDisabled();
  });

  it('booking sends journey needs and keeps patient contact separate', async () => {
    const { send } = renderAt('/planner', [...DISPATCH, 'jobs.booking.manage'], (p) =>
      p.startsWith('/api/v1/planner')
        ? planner
        : p.includes('/locations')
          ? { data: [{ id: LOC, name: 'Watford' }] }
          : { data: [] },
    );
    const form = await screen.findByRole('form', { name: 'Book a journey' });
    await userEvent.type(within(form).getByLabelText('Customer'), 'Synthetic NHS Trust');
    await userEvent.type(
      within(form).getByLabelText('Booking reference (never a patient name)'),
      'PX-1',
    );
    await userEvent.type(within(form).getByLabelText('Pickup from'), '09:00');
    await userEvent.type(within(form).getByLabelText('Pickup by'), '09:30');
    await userEvent.type(within(form).getByLabelText('Appointment time (optional)'), '10:15');
    await userEvent.type(within(form).getByLabelText('Pickup address'), '1 Synthetic Road');
    await userEvent.type(within(form).getByLabelText('Destination'), 'Synthetic Hospital');
    await userEvent.click(within(form).getByLabelText('Stairs at pickup or destination'));
    await userEvent.click(within(form).getByLabelText('Bariatric handling'));
    await userEvent.type(
      within(form).getByLabelText('Contact name (optional)'),
      'Synthetic Person',
    );
    await userEvent.selectOptions(within(form).getByLabelText('Repeats'), 'WEEKLY');
    await userEvent.type(within(form).getByLabelText('Until'), '2026-11-27');
    await userEvent.click(within(form).getByRole('button', { name: 'Book' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/bookings', ORG, expect.anything()),
    );
    const call = send.mock.calls.find((c) => c[1] === '/api/v1/bookings');
    expect(call).toBeDefined();
    const body = call![3];
    expect(body.patientContact).toEqual({ name: 'Synthetic Person' });
    expect(body.recurrence).toEqual({ freq: 'WEEKLY', interval: 1, until: '2026-11-27' });
    expect(body.job).toMatchObject({ stairs: true, requiredSkills: ['BARIATRIC'] });
    expect(body.job.appointmentAt).toBeTruthy();
    expect(JSON.stringify(body.job)).not.toContain('Synthetic Person');
  });

  it('E1: NHS booking with a return journey shows the weight warning', async () => {
    const send = vi.fn(async () => ({
      jobs: [],
      warnings: ['The recorded weight (300 kg) is above the permitted load of every vehicle'],
    }));
    renderAt(
      '/planner',
      [...DISPATCH, 'jobs.booking.manage'],
      (p) =>
        p.startsWith('/api/v1/planner')
          ? planner
          : p.includes('/locations')
            ? { data: [{ id: LOC, name: 'Watford' }] }
            : { data: [] },
      send,
    );
    const form = await screen.findByRole('form', { name: 'Book a journey' });
    await userEvent.type(within(form).getByLabelText('Customer'), 'Synthetic NHS Trust');
    await userEvent.type(
      within(form).getByLabelText('Booking reference (never a patient name)'),
      'BK-77',
    );
    await userEvent.selectOptions(within(form).getByLabelText('Contract'), 'NHS');
    await userEvent.click(within(form).getByLabelText('Eligibility criteria met'));
    await userEvent.type(within(form).getByLabelText('Criteria applied'), 'Medical need');
    await userEvent.type(within(form).getByLabelText('Assessed by'), 'Synthetic Assessor');
    await userEvent.type(within(form).getByLabelText('Pickup from'), '09:00');
    await userEvent.type(within(form).getByLabelText('Pickup by'), '09:30');
    await userEvent.type(within(form).getByLabelText('Pickup address'), '1 Synthetic Road');
    await userEvent.type(within(form).getByLabelText('Destination'), 'Synthetic Hospital');
    await userEvent.type(within(form).getByLabelText(/Patient weight/), '300');
    await userEvent.click(within(form).getByLabelText(/Book a return journey/));
    await userEvent.type(within(form).getByLabelText('Return pickup from'), '14:00');
    await userEvent.type(within(form).getByLabelText('Return pickup by'), '14:30');
    await userEvent.click(within(form).getByRole('button', { name: 'Book' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', '/api/v1/bookings', ORG, expect.anything()),
    );
    type Body = {
      contractType: string;
      nhsEligibility: unknown;
      returnJourney: { pickupFrom: string };
    };
    const body = (send.mock.calls[0] as unknown[])[3] as Body;
    expect(body.contractType).toBe('NHS');
    expect(body.nhsEligibility).toEqual({
      met: true,
      criteria: 'Medical need',
      assessedBy: 'Synthetic Assessor',
    });
    expect(body.returnJourney.pickupFrom).toBeTruthy();
    expect(await screen.findByText(/above the permitted load of every vehicle/)).toBeVisible();
  });
});
