import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const JOB = '01900000-0000-7000-8000-000000000917';
const S1 = '01900000-0000-7000-8000-000000000501';
const S3 = '01900000-0000-7000-8000-000000000503';
const me = (permissions: string[]): MeResponse => ({
  user: { id: '01900000-0000-7000-8000-000000000101', email: 'd@example.test', displayName: 'Dev' },
  memberships: [
    {
      organisationId: ORG,
      organisationName: 'Exora',
      locationId: null,
      roleKey: 'DISPATCHER',
      roleName: 'Dispatcher',
    },
  ],
  permissions,
  activeOrganisationId: ORG,
  mfa: { required: true, satisfied: true },
});
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
const shift = (id: string, callsign: string, vehicleStatus: string, jobs: object[] = []) => ({
  id,
  locationId: ORG,
  vehicleId: id,
  vehicleCallsign: callsign,
  vehicleStatus,
  startsAt: '2026-10-30T07:00:00Z',
  endsAt: '2026-10-30T19:00:00Z',
  state: 'PLANNED',
  crew: [crew(`${id}a`, 'Alex Driver', 'DRIVER'), crew(`${id}b`, 'Sam Carer', 'CARE_ASSISTANT')],
  jobs,
  changes: [],
  version: 1,
});
const planner = {
  date: '2026-10-30',
  shifts: [
    shift(S1, 'AMB-01', 'AVAILABLE', [
      {
        jobId: 'j104',
        code: 'J-104',
        state: 'ALLOCATED',
        startsAt: '2026-10-30T09:00:00Z',
        endsAt: '2026-10-30T10:30:00Z',
      },
      {
        jobId: 'j105',
        code: 'J-105',
        state: 'EN_ROUTE',
        startsAt: '2026-10-30T11:00:00Z',
        endsAt: '2026-10-30T12:00:00Z',
      },
    ]),
    shift(S3, 'AMB-03', 'BLOCKED'),
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
      mobility: 'WHEELCHAIR',
      stairs: false,
      infectionPrecautions: false,
      escorts: 1,
      crewSize: 2,
      requiredSkills: ['BARIATRIC'],
      requiredEquipment: ['WHEELCHAIR_RAMP'],
      accessPlanReviewed: true,
    },
  ],
};
const check = (code: string, result: string, overridable = false, reasonText = 'OK') => ({
  code,
  result,
  reasonText,
  overridable,
  excepted: false,
  details: [],
});

function renderPlanner(permissions: string[], validation: object) {
  const send = vi.fn(async (_m: string, path: string) =>
    path.endsWith('/validate') ? validation : {},
  );
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => (p.startsWith('/api/v1/planner') ? planner : { data: [] }),
    send: send as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/planner'] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

const DISPATCH = ['jobs.job.view', 'jobs.allocate', 'fleet.vehicle.view'];

describe('work planner [JOB-02, JOB-03, UAT-04]', () => {
  it('shows crews, job chips, blocked vehicles in words and the unallocated job card', async () => {
    renderPlanner(DISPATCH, {});
    expect(await screen.findByText('AMB-01 / Alex Driver + Sam Carer')).toBeInTheDocument();
    expect(screen.getByText('BLOCKED – Blocked')).toBeInTheDocument();
    expect(screen.getAllByText(/J-104 allocated/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/J-105 in progress/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /J-117/ }));
    const card = screen.getByLabelText('Job J-117');
    expect(card).toHaveTextContent('Wheelchair');
    expect(card).toHaveTextContent('Wheelchair ramp');
    expect(card).toHaveTextContent('Access plan reviewedYes');
  });

  it('a safety failure keeps "Allocate" disabled and offers no exception', async () => {
    const { send } = renderPlanner([...DISPATCH, 'allocation.exception.approve'], {
      allowed: false,
      checks: [
        check('STAFF_CLEARANCE', 'PASS'),
        check('VEHICLE_ROADWORTHY', 'FAIL', false, 'Open stop-use defect'),
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: /J-117/ }));
    // Keyboard alternative to drag-and-drop: select the job, then choose the row.
    await userEvent.click(screen.getByRole('button', { name: 'Check J-117 on AMB-03' }));
    const checks = await screen.findByRole('list', { name: 'Checks' });
    await waitFor(() => expect(checks).toHaveTextContent('Open stop-use defect'));
    expect(within(checks).getByText(/cannot be overridden/)).toBeInTheDocument();
    expect(within(checks).queryByRole('button', { name: 'Request exception' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allocate and notify crew' })).toBeDisabled();
    expect(send).toHaveBeenCalledWith('POST', `/api/v1/jobs/${JOB}/validate`, ORG, {
      shiftId: S3,
    });
  });

  it('a policy failure offers an exception only to approvers', async () => {
    const v = {
      allowed: false,
      checks: [check('COMPETENCE', 'FAIL', true, 'Bariatric competence missing')],
    };
    renderPlanner(DISPATCH, v);
    await userEvent.click(await screen.findByRole('button', { name: /J-117/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Check J-117 on AMB-01' }));
    await screen.findByText('Bariatric competence missing');
    expect(screen.queryByRole('button', { name: 'Request exception' })).toBeNull();
  });

  it('when every check passes, allocates then notifies the crew', async () => {
    const { send } = renderPlanner(DISPATCH, {
      allowed: true,
      checks: [check('STAFF_CLEARANCE', 'PASS'), check('SHIFT_GATE', 'PASS')],
    });
    await userEvent.click(await screen.findByRole('button', { name: /J-117/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Check J-117 on AMB-01' }));
    const go = screen.getByRole('button', { name: 'Allocate and notify crew' });
    await waitFor(() => expect(go).toBeEnabled());
    await userEvent.click(go);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/jobs/${JOB}/offer`, ORG, {}),
    );
    expect(send).toHaveBeenCalledWith('POST', `/api/v1/jobs/${JOB}/allocate`, ORG, {
      shiftId: S1,
    });
  });

  it('week view lists each vehicle by day and opens a day', async () => {
    renderPlanner(DISPATCH, {});
    await userEvent.click(await screen.findByRole('button', { name: 'Week' }));
    const table = await screen.findByRole('table', { name: /by vehicle and day/ });
    const row = await within(table).findByRole('row', { name: /AMB-03/ });
    expect(row).toHaveTextContent('BLOCKED – Blocked');
    expect(within(table).getByRole('row', { name: /AMB-01/ })).toHaveTextContent('2 jobs');
    await userEvent.click(within(table).getAllByRole('button')[0]!);
    expect(await screen.findByText('AMB-01 / Alex Driver + Sam Carer')).toBeInTheDocument();
  });

  it('people without job access are told so', async () => {
    renderPlanner(['dashboard.view'], {});
    expect(
      await screen.findByText('You do not have permission to view the work planner.'),
    ).toBeInTheDocument();
  });
});
