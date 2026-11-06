import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MeResponse } from '@hub/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/api.js';
import { App } from '../src/App.js';

const ORG = '01900000-0000-7000-8000-000000000001';
const ME = '01900000-0000-7000-8000-000000000101';
const MY_STAFF = '01900000-0000-7000-8000-000000000200';
const ALEX = '01900000-0000-7000-8000-000000000201';
const JO = '01900000-0000-7000-8000-000000000202';
const T1 = '01900000-0000-7000-8000-000000000901';
const T2 = '01900000-0000-7000-8000-000000000902';

const me = (permissions: string[]): MeResponse => ({
  user: { id: ME, email: 'hr@example.test', displayName: 'Hana' },
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
  permissions: string[],
  get: (p: string) => unknown,
  send = vi.fn(async (..._a: unknown[]) => ({}) as unknown),
) {
  const api: ApiClient = {
    me: async () => me(permissions),
    readyz: async () => ({ status: 'ready' }),
    get: async (p) => get(p),
    send: send as ApiClient['send'],
  };
  render(<App api={api} history={createMemoryHistory({ initialEntries: ['/staff'] })} />);
  return { send };
}
beforeEach(() => sessionStorage.clear());

const staffRow = (id: string, displayName: string, o: Record<string, unknown> = {}) => ({
  id,
  staffNo: `ST-${id.slice(-3)}`,
  displayName,
  roles: ['DRIVER'],
  lifecycleState: 'ACTIVE',
  activeRestrictions: [],
  overallStatus: 'GREEN',
  counts: { red: 0, amber: 0, grey: 0, green: 1 },
  ...o,
});
const staffList = {
  data: [
    staffRow(ALEX, 'Alex Morgan'),
    staffRow(MY_STAFF, 'Hana Hr'),
    staffRow(JO, 'Jo Leaver', { lifecycleState: 'LEAVER' }),
  ],
  nextCursor: null,
};
const common = (p: string): unknown => {
  if (p === '/api/v1/staff/me')
    return { profile: { id: MY_STAFF }, requirements: [], corrections: [] };
  if (p.startsWith('/api/v1/staff?')) return staffList;
  if (p === '/api/v1/admin/people')
    return {
      data: [
        { id: ME, displayName: 'Hana', roleKeys: [], roleNames: ['HR'], locationIds: [] },
        {
          id: 'u-sam',
          displayName: 'Sam Supervisor',
          roleKeys: [],
          roleNames: ['Manager'],
          locationIds: [],
        },
      ],
    };
  return { data: [] };
};

describe('training matrix drill-down [C1]', () => {
  const cell = (templateId: string, o: Record<string, unknown>) => ({
    templateId,
    required: true,
    instanceId: null,
    status: null,
    state: 'MISSING',
    reasonText: null,
    nextDate: null,
    ...o,
  });
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
        staffId: ALEX,
        staffNo: 'ST-201',
        displayName: 'Alex Morgan',
        roles: ['DRIVER'],
        hasGap: true,
        cells: [
          cell(T1, {
            instanceId: 'i1',
            status: 'RED',
            state: 'OVERDUE',
            reasonText: 'Expired on 1 Oct 2026',
            nextDate: '2026-10-01',
          }),
          cell(T2, { required: false, state: 'NOT_REQUIRED' }),
        ],
      },
      {
        staffId: MY_STAFF,
        staffNo: 'ST-200',
        displayName: 'Hana Hr',
        roles: ['DRIVER'],
        hasGap: false,
        cells: [
          cell(T1, { instanceId: 'i2', status: 'GREEN', state: 'MET', nextDate: '2027-03-12' }),
          cell(T2, { required: false, state: 'NOT_REQUIRED' }),
        ],
      },
    ],
    truncated: false,
  };
  const get = (p: string) =>
    p.startsWith('/api/v1/staff/training-matrix')
      ? matrix
      : p === '/api/v1/requirements/instances/i1/evidence'
        ? { data: [] }
        : common(p);

  it('opens the people behind a requirement, worst first, and the record behind a cell', async () => {
    renderAt(['staff.profile.view_basic'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Training matrix' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show people: Manual handling' }),
    );
    const people = await screen.findByRole('table', { name: 'People who need Manual handling' });
    const rows = within(people).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Alex Morgan');
    expect(rows[0]).toHaveTextContent('Red – Overdue (next 1 Oct 2026)');
    expect(rows[1]).toHaveTextContent('Green – Met (next 12 Mar 2027)');

    await userEvent.click(
      within(rows[0]!).getByRole('button', { name: 'Open Manual handling for Alex Morgan' }),
    );
    const detail = await screen.findByRole('region', { name: 'Manual handling: Alex Morgan' });
    expect(detail).toHaveTextContent('Expired on 1 Oct 2026');
    expect(detail).toHaveTextContent('Required for their rolesYes');
    await userEvent.click(
      within(detail).getByRole('button', { name: 'Documents for Manual handling: Alex Morgan' }),
    );
    expect(await screen.findByRole('dialog')).toHaveTextContent('Documents for Manual handling');
  });

  it('a matrix cell is a button named for the person and requirement', async () => {
    renderAt(['staff.profile.view_basic'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Training matrix' }));
    const btn = await screen.findByRole('button', {
      name: 'Open Safeguarding level 2 for Alex Morgan: Not required',
    });
    await userEvent.click(btn);
    const detail = await screen.findByRole('region', { name: 'Safeguarding level 2: Alex Morgan' });
    expect(detail).toHaveTextContent('There is no record for this yet');
    expect(within(detail).queryByRole('button', { name: /Documents/ })).toBeNull();
  });
});

describe('group training [C1]', () => {
  const get = (p: string) =>
    p === '/api/v1/training-courses'
      ? {
          data: [
            {
              id: 'c1',
              code: 'MH',
              title: 'Moving and handling',
              intervalMonths: 12,
              retired: false,
            },
            { id: 'c2', code: 'OLD', title: 'Old fire course', intervalMonths: 12, retired: true },
          ],
        }
      : common(p);

  it('records one entry for everyone ticked; the recorder and leavers cannot be ticked', async () => {
    const send = vi.fn(async (..._a: unknown[]) => ({ created: 1, recordIds: ['r1'] }) as unknown);
    renderAt(['staff.profile.view_basic', 'staff.profile.manage'], get, send);
    await userEvent.click(await screen.findByRole('tab', { name: 'Group training' }));
    const form = await screen.findByRole('form', { name: 'Record group training' });
    const course = within(form).getByLabelText('Course');
    await waitFor(() => expect(within(course).getAllByRole('option')).toHaveLength(2));
    expect(course).not.toHaveTextContent('Old fire course');
    await userEvent.selectOptions(course, 'c1');
    expect(form).toHaveTextContent('every 12 months');
    await userEvent.type(within(form).getByLabelText('Register reference'), 'REG-2026-11');
    const attendees = within(form).getByRole('list', { name: 'Attendees' });
    expect(attendees).toHaveTextContent('Hana Hr (you – someone else records your training)');
    expect(within(attendees).queryByRole('checkbox', { name: /Hana Hr/ })).toBeNull();
    expect(attendees).not.toHaveTextContent('Jo Leaver');
    const submit = within(form).getByRole('button', { name: /Record training for 0 people/ });
    expect(submit).toBeDisabled();
    await userEvent.click(within(attendees).getByRole('checkbox', { name: /Alex Morgan/ }));
    await userEvent.click(
      within(form).getByRole('button', { name: 'Record training for 1 person' }),
    );
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/training-records/bulk',
        ORG,
        expect.objectContaining({ courseId: 'c1', sessionRef: 'REG-2026-11', staffIds: [ALEX] }),
      ),
    );
    expect(await screen.findByText(/awaits verification by HR/)).toBeInTheDocument();
  });

  it('is not offered without permission to manage staff records', async () => {
    renderAt(['staff.profile.view_basic'], get);
    expect(await screen.findByRole('tab', { name: 'Supervision bookings' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Group training' })).toBeNull();
  });
});

describe('supervision bookings [C2]', () => {
  const booking = (o: Record<string, unknown>) => ({
    id: 'b1',
    staffId: ALEX,
    staffName: 'Alex Morgan',
    supervisorUserId: ME,
    supervisorName: 'Hana',
    scheduledAt: '2026-11-03T10:00:00.000Z',
    kind: 'ONE_TO_ONE',
    topics: 'Return from leave',
    status: 'BOOKED',
    statusReason: null,
    recordId: null,
    rebookedAs: null,
    version: 2,
    ...o,
  });
  const bookings = [
    booking({}),
    booking({
      id: 'b2',
      staffId: MY_STAFF,
      staffName: 'Hana Hr',
      supervisorUserId: 'u-sam',
      supervisorName: 'Sam Supervisor',
      scheduledAt: '2099-01-10T09:00:00.000Z',
      kind: 'CLINICAL',
    }),
    booking({
      id: 'b3',
      staffName: 'Chris Other',
      staffId: JO,
      supervisorUserId: 'u-sam',
      status: 'CANCELLED',
      statusReason: 'Sickness',
      rebookedAs: 'b4',
    }),
  ];
  const get = (p: string) =>
    p.startsWith('/api/v1/supervision-bookings') ? { data: bookings } : common(p);

  it('shows bookings in words and lets the supervisor record a missed session with a reason', async () => {
    const { send } = renderAt(['staff.profile.view_basic'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Supervision bookings' }));
    const table = await screen.findByRole('table', { name: 'Supervision bookings' });
    const alex = await within(table).findByRole('row', { name: /Alex Morgan/ });
    expect(alex).toHaveTextContent('3 Nov 2026, 10:00');
    expect(alex).toHaveTextContent('One to one');
    expect(alex).toHaveTextContent('Booked, date has passed: record what happened');
    expect(alex).not.toHaveTextContent('ONE_TO_ONE');
    const mine = within(table).getByRole('row', { name: /Hana Hr/ });
    expect(mine).toHaveTextContent('Clinical supervision');
    expect(mine).toHaveTextContent('Your supervisor records this.');
    expect(within(mine).queryByRole('button')).toBeNull();
    const cancelled = within(table).getByRole('row', { name: /Chris Other/ });
    expect(cancelled).toHaveTextContent('Cancelled: Sickness (rebooked)');
    expect(screen.queryByRole('form', { name: 'Book a supervision' })).toBeNull();

    await userEvent.click(
      within(alex).getByRole('button', { name: 'Record outcome: Alex Morgan' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('What happened?'), 'MISSED');
    const save = within(dialog).getByRole('button', { name: 'Save outcome' });
    expect(save).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText(/Why it did not go ahead/),
      'Called away to an emergency',
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/supervision-bookings/b1/close',
        ORG,
        { status: 'MISSED', reason: 'Called away to an emergency' },
        2,
      ),
    );
  });

  it('records a held supervision with the wellbeing check', async () => {
    const { send } = renderAt(['staff.profile.view_basic'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Supervision bookings' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Record outcome: Alex Morgan' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Wellbeing check done' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save outcome' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'POST',
        '/api/v1/supervision-bookings/b1/close',
        ORG,
        { status: 'HELD', attended: true, wellbeingChecked: true },
        2,
      ),
    );
  });

  it('HR books a supervision for someone else', async () => {
    const { send } = renderAt(['staff.profile.view_basic', 'staff.profile.manage'], get);
    await userEvent.click(await screen.findByRole('tab', { name: 'Supervision bookings' }));
    const form = await screen.findByRole('form', { name: 'Book a supervision' });
    const person = within(form).getByLabelText('Person');
    await waitFor(() =>
      expect(within(person).getByRole('option', { name: 'Alex Morgan' })).toBeInTheDocument(),
    );
    expect(within(person).queryByRole('option', { name: 'Hana Hr' })).toBeNull();
    await userEvent.selectOptions(person, ALEX);
    await userEvent.selectOptions(within(form).getByLabelText('Supervisor'), 'u-sam');
    fireEvent.change(within(form).getByLabelText('Date and time'), {
      target: { value: '2026-11-20T10:00' },
    });
    await userEvent.selectOptions(within(form).getByLabelText('Type'), 'PROBATION_REVIEW');
    await userEvent.click(within(form).getByRole('button', { name: 'Book supervision' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('POST', `/api/v1/staff/${ALEX}/supervision-bookings`, ORG, {
        supervisorUserId: 'u-sam',
        scheduledAt: '2026-11-20T10:00:00.000Z',
        kind: 'PROBATION_REVIEW',
      }),
    );
  });
});
