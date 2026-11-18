// v36 registers added 17 Nov 2026: each screen loads its own API and shows records in words.
import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.js';
import { defaultGet, testApi } from './test-api.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const ID = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const get = defaultGet((p) => {
  if (p.startsWith('/api/v1/safeguarding-referrals'))
    return {
      data: [
        {
          id: ID(901),
          code: 'SGR-1',
          about: 'ADULT',
          category: 'SELF_NEGLECT',
          patientRef: 'PT-4390',
          details: 'Home without heating',
          raisedByUserId: ID(101),
          raisedByName: 'Dev',
          raisedOn: today,
          status: 'RAISED',
          agency: null,
          abuseAllegation: false,
          cqcNotificationCode: null,
        },
      ],
      summary: { open: 1, undecided: 1 },
    };
  if (p.startsWith('/api/v1/vehicle-accidents'))
    return {
      data: [
        {
          id: ID(902),
          code: 'ACC-1',
          vehicleLabel: 'AMB-01',
          occurredAt: `${today}T08:00:00Z`,
          description: 'Reversed into a bollard',
          thirdParty: 'None',
          roadworthy: false,
          defectId: ID(903),
          defectStatus: 'OPEN',
          status: 'OPEN',
          stateText: 'Off the road – awaiting repair',
          photoCount: 0,
          injuries: false,
        },
      ],
    };
  if (p.startsWith('/api/v1/staff-absences'))
    return {
      data: [
        {
          id: ID(904),
          code: 'ABS-1',
          staffId: ID(905),
          staffName: 'Sam Patel',
          firstDay: today,
          lastDay: null,
          stillOff: true,
          category: 'RESPIRATORY',
          days: 1,
          rtwOn: null,
          rtwMissing: false,
          phased: false,
        },
      ],
      triggers: [
        { staffId: ID(905), staffName: 'Sam Patel', episodes6m: 3, bradford12m: 54, reached: true },
      ],
    };
  if (p.startsWith('/api/v1/shift-swaps'))
    return {
      data: [
        {
          id: ID(906),
          code: 'SWP-1',
          status: 'AGREED',
          reason: 'Family event',
          from: { staffName: 'Sam Patel', vehicleLabel: 'AMB-01', startsAt: `${today}T07:00:00Z`, endsAt: `${today}T15:00:00Z` },
          to: { staffName: 'Jo Lee', vehicleLabel: 'AMB-02', startsAt: `${today}T15:00:00Z`, endsAt: `${today}T23:00:00Z` },
          warnings: [],
          canAgree: false,
          canDecide: true,
          canWithdraw: false,
        },
      ],
    };
  if (p.startsWith('/api/v1/dspt'))
    return {
      data: [
        {
          id: ID(907),
          year: '2026-27',
          dueOn: '2027-06-30',
          status: 'IN_PROGRESS',
          inPlace: 1,
          total: 2,
          items: [
            { id: ID(908), position: 1, title: 'Data protection officer named', status: 'IN_PLACE', evidenceNote: 'Org chart', markedByName: 'Dev', hint: null },
            { id: ID(909), position: 2, title: 'Backups tested by restore', status: 'NOT_YET', hint: null },
          ],
        },
      ],
    };
  return undefined;
});

const open = (perms: string[], url: string) =>
  render(<App api={testApi(perms, get)} history={createMemoryHistory({ initialEntries: [url] })} />);

describe('v36 registers', () => {
  it('safeguarding referrals show the decision still needed', async () => {
    open(['events.event.view', 'events.safeguarding.view', 'events.event.manage'], '/compliance?tab=safeguarding');
    expect(await screen.findByText(/SGR-1 · Adult – Self-neglect/)).toBeInTheDocument();
    expect(screen.getByText('Raised – referral decision needed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refer' })).toBeInTheDocument();
  });

  it('accidents show a vehicle off the road until it is released', async () => {
    open(['fleet.vehicle.view', 'fleet.defect.create', 'fleet.defect.manage'], '/vehicles?tab=equipment&view=accidents');
    expect(await screen.findByText('Off the road – awaiting repair')).toBeInTheDocument();
    expect(screen.getByText('No – off the road')).toBeInTheDocument();
  });

  it('absence shows the review trigger and who is still off', async () => {
    open(
      ['staff.profile.view_basic', 'staff.sensitive.view', 'staff.profile.manage'],
      '/staff?tab=training&view=absence',
    );
    expect(await screen.findByText(/3 absences in 6 months/)).toBeInTheDocument();
    expect(screen.getByText('Still off')).toBeInTheDocument();
  });

  it('an agreed swap can be approved by control', async () => {
    open(['staff.profile.view_basic', 'jobs.job.view', 'jobs.allocate'], '/staff?tab=shifts&view=swaps');
    expect(await screen.findByText('Colleague agreed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve – SWP-1' })).toBeInTheDocument();
  });

  it('the DSP Toolkit lists evidence items in words', async () => {
    open(['privacy.manage'], '/compliance?tab=dspt');
    expect(await screen.findByText('Evidence in place')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('applying a pattern creates each working day through the planner and reports refusals', async () => {
    const P = ID(910);
    const V = ID(911);
    const L = ID(912);
    const g = defaultGet((p) => {
      if (p === '/api/v1/shift-patterns')
        return {
          data: [
            { id: P, code: 'D12', name: 'Days', startTime: '07:00', endTime: '19:00', paidBreakMinutes: 30, onDays: 2, offDays: 2, lengthHours: 12, overnight: false, active: true, restWarning: null },
          ],
        };
      if (p.startsWith(`/api/v1/shift-patterns/${P}/dates`))
        return {
          patternId: P,
          dates: [
            { date: '2026-12-01', startsAt: '2026-12-01T07:00:00Z', endsAt: '2026-12-01T19:00:00Z' },
            { date: '2026-12-02', startsAt: '2026-12-02T07:00:00Z', endsAt: '2026-12-02T19:00:00Z' },
          ],
        };
      if (p === '/api/v1/vehicles') return { data: [{ id: V, callsign: 'AMB-09', baseLocationId: L }] };
      return undefined;
    });
    let n = 0;
    const send = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error('clash');
      return {};
    });
    render(
      <App
        api={testApi(['staff.profile.view_basic', 'jobs.job.view', 'jobs.allocate'], g, { send })}
        history={createMemoryHistory({ initialEntries: ['/staff?tab=shifts&view=patterns'] })}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'More actions – Days' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Apply to a vehicle/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(dialog).getByLabelText('Vehicle'));
    fireEvent.click(await screen.findByTitle('AMB-09'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the shifts' }));
    expect(await screen.findByText(/Pattern applied: 1 created, 1 refused/)).toBeInTheDocument();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledWith(
      'POST',
      '/api/v1/shifts',
      expect.anything(),
      expect.objectContaining({ vehicleId: V, locationId: L, startsAt: '2026-12-01T07:00:00Z', crew: [] }),
    );
  });
});
