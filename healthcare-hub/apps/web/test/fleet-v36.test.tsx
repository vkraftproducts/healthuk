// v36 Vehicles: fleet cards built from vehicles, today's checks, documents, service and jobs.
import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import { defaultGet, testApi } from './test-api.js';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const plus = (days: number) =>
  new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const V1 = '01900000-0000-7000-8000-000000000301';
const V2 = '01900000-0000-7000-8000-000000000302';
const vehicle = (o: Record<string, unknown>) => ({
  id: V1,
  callsign: 'AMB-01',
  registration: 'SY21ABC',
  type: 'AMBULANCE',
  status: 'AVAILABLE',
  statusReason: null,
  openDefects: 0,
  latestReading: { reading: 48210, readOn: today },
  currentOdometer: 48210,
  ...o,
});
const get = defaultGet((p) => {
  if (p.startsWith('/api/v1/vehicles?') || p === '/api/v1/vehicles')
    return {
      data: [
        vehicle({}),
        vehicle({
          id: V2,
          callsign: 'AMB-03',
          status: 'BLOCKED',
          statusReason: '1 open stop-use defect',
          openDefects: 1,
        }),
      ],
    };
  if (p === `/api/v1/vehicles/${V1}`)
    return { maintenance: [{ id: 'm', dueDate: plus(41), state: 'OK' }] };
  if (p.startsWith('/api/v1/vehicles/')) return { maintenance: [] };
  if (p === '/api/v1/vdis')
    return {
      data: [
        {
          id: 'c1',
          vehicleId: V1,
          outcome: 'PASS',
          odometer: 48210,
          capturedAt: `${today}T07:45:00Z`,
          results: [],
        },
      ],
    };
  if (p.startsWith('/api/v1/requirements/instances'))
    return {
      data: [
        {
          subjectId: V1,
          templateTitle: 'MOT test certificate',
          expiryDate: plus(143),
          status: 'GREEN',
          reasonText: 'Verified',
        },
        {
          subjectId: V1,
          templateTitle: 'Motor insurance',
          expiryDate: null,
          status: 'GREY',
          reasonText: 'No verified evidence on record',
        },
      ],
    };
  if (p.startsWith('/api/v1/planner'))
    // Fleet cards count only jobs that start today (London).
    return {
      shifts: [{ vehicleId: V1, jobs: [1, 2, 3].map(() => ({ startsAt: new Date().toISOString() })) }],
      unallocated: [],
    };
  return undefined;
});

describe('Vehicles / Fleet cards (v36)', () => {
  it('shows status, today’s check, jobs, odometer and documents as days left, in words', async () => {
    render(
      <App
        api={testApi(['fleet.vehicle.view', 'fleet.defect.create'], get)}
        history={createMemoryHistory({ initialEntries: ['/vehicles'] })}
      />,
    );
    const card = await screen.findByLabelText(/AMB-01, Available/);
    await waitFor(() => expect(card).toHaveTextContent('Passed'));
    expect(card).toHaveTextContent('48,210 mi');
    await waitFor(() => expect(card).toHaveTextContent('143d'));
    expect(card).toHaveTextContent('No verified evidence on record');
    await waitFor(() => expect(card).toHaveTextContent('41d'));
    await waitFor(() => expect(card).toHaveTextContent(/Jobs today\s*3/));
    const blocked = screen.getByLabelText(/AMB-03, Blocked/);
    expect(blocked).toHaveTextContent('Blocked – 1 open stop-use defect');
    expect(blocked).toHaveTextContent('Not needed');
    expect(blocked).toHaveTextContent('1 open');
  });
});
