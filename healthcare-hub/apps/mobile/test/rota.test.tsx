import { fireEvent, render, screen } from '@testing-library/react-native';
import { Main } from '../src/app/Main';
import { ServicesProvider } from '../src/app/services';
import { harness, type Harness, NOW } from './fakes';

// v36 (17 Nov 2026): clock in and out, open shifts and swaps on the crew phone. Online only.
const A1 = '01900000-0000-7000-8000-0000000000f1';
const OS = '01900000-0000-7000-8000-0000000000f2';
const SW = '01900000-0000-7000-8000-0000000000f3';
const iso = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

function routes(h: Harness) {
  const posts: { path: string; body: unknown }[] = [];
  let clockedIn = false;
  h.server.st.extra = (method, path, body) => {
    if (method === 'POST') posts.push({ path, body });
    if (method === 'GET' && path === '/api/v1/shift-time/mine')
      return [
        200,
        {
          data: [
            {
              assignmentId: A1,
              shiftId: A1,
              vehicleLabel: 'AMB-01',
              plannedStart: iso(-0.25),
              plannedEnd: iso(8),
              entry: clockedIn
                ? { id: A1, clockIn: iso(0), clockOut: null, breakMinutes: 0, source: 'CREW_APP', corrected: false }
                : null,
            },
          ],
        },
      ];
    if (method === 'GET' && path === '/api/v1/open-shifts')
      return [
        200,
        {
          data: [
            {
              id: OS,
              code: 'OS-4',
              role: 'CARE_ASSISTANT',
              vehicleLabel: 'AMB-02',
              startsAt: iso(48),
              endsAt: iso(56),
              note: 'Sickness cover',
              offeredByMe: false,
            },
          ],
        },
      ];
    if (method === 'GET' && path === '/api/v1/shift-swaps')
      return [
        200,
        {
          data: [
            {
              id: SW,
              code: 'SWP-2',
              status: 'REQUESTED',
              reason: 'Family event',
              from: { staffName: 'Synthetic Assistant', vehicleLabel: 'AMB-02', startsAt: iso(72), endsAt: iso(80) },
              to: { staffName: 'Synthetic Driver', vehicleLabel: 'AMB-01', startsAt: iso(96), endsAt: iso(104) },
              canAgree: true,
              canWithdraw: false,
            },
          ],
        },
      ];
    if (method === 'POST' && path === '/api/v1/shift-time/clock-in') {
      clockedIn = true;
      return [201, {}];
    }
    if (method === 'POST') return [201, {}];
    return undefined;
  };
  return posts;
}

async function open(h: Harness, online = true) {
  h.online.value = online;
  h.server.st.offline = !online;
  await render(
    <ServicesProvider services={h.services} online={online}>
      <Main />
    </ServicesProvider>,
  );
  fireEvent.press(await screen.findByLabelText('Clock in, open shifts and swaps'));
}

describe('Shifts and hours on the crew phone (v36)', () => {
  it('clocks in, offers to cover an open shift and agrees to a swap', async () => {
    const h = await harness();
    const posts = routes(h);
    await open(h);
    fireEvent.press(await screen.findByLabelText('Clock in'));
    expect(await screen.findByText('✓ Clocked in.')).toBeOnTheScreen();
    expect(await screen.findByLabelText('Clock out')).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Offer to cover OS-4'));
    expect(await screen.findByText('✓ Offer sent to control.')).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Agree to swap SWP-2'));
    expect(await screen.findByText('✓ Agreed – control will approve.')).toBeOnTheScreen();

    expect(posts.map((p) => p.path)).toEqual([
      '/api/v1/shift-time/clock-in',
      `/api/v1/open-shifts/${OS}/offer`,
      `/api/v1/shift-swaps/${SW}/agree`,
    ]);
    expect(posts[0]!.body).toEqual({ assignmentId: A1 });
  });

  it('says plainly that these need a connection when offline', async () => {
    const h = await harness();
    routes(h);
    await open(h, false);
    expect(await screen.findByText(/Offline – clocking in, open shifts and swaps need a connection/)).toBeOnTheScreen();
    expect(screen.getByLabelText('Ask to swap a shift')).toBeDisabled();
  });
});
