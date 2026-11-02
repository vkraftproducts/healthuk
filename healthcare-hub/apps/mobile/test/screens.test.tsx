import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppRoot } from '../src/app/AppRoot';
import { Main } from '../src/app/Main';
import { ServicesProvider } from '../src/app/services';
import { toPence } from '../src/screens/Fuel';
import { harness, type Harness, JOB, jobDto, NOW, POLICY_V, shiftDto, todayDto } from './fakes';

async function open(h: Harness, online = true) {
  h.online.value = online;
  h.server.st.offline = !online;
  const ui = (o: boolean) => (
    <ServicesProvider services={h.services} online={o}>
      <Main />
    </ServicesProvider>
  );
  const r = await render(ui(online));
  return {
    ...r,
    setOnline: (o: boolean) => {
      h.online.value = o;
      h.server.st.offline = !o;
      return r.rerender(ui(o));
    },
  };
}
const press = async (label: string | RegExp) =>
  fireEvent.press(await screen.findByLabelText(label));
const type = async (label: string, text: string) =>
  fireEvent.changeText(await screen.findByLabelText(label), text);

describe('My shift (wireframe 05) [APP-01]', () => {
  it('shows vehicle, crew and the three gate cards with words, and blocks the start', async () => {
    const h = await harness();
    await open(h);
    expect(await screen.findByText('AMB-01 · SY26 ABC')).toBeOnTheScreen();
    expect(screen.getByText('Synthetic Driver (you)')).toBeOnTheScreen();
    expect(screen.getByText('Synthetic Assistant')).toBeOnTheScreen();
    for (const t of ['Driving clearance', 'Vehicle daily inspection', 'Pre-shift cleaning'])
      expect(screen.getByText(t)).toBeOnTheScreen();
    // Colour is never the only signal: every status has an icon and words.
    expect(screen.getAllByLabelText('Status: Required')).toHaveLength(2);
    expect(screen.getByText('✓ Approved')).toBeOnTheScreen();
    expect(screen.getByText('✕ Shift start blocked until complete.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Start shift')).toBeDisabled();
    expect(screen.getByText(/Synced \d\d:\d\d|Not synced yet/)).toBeOnTheScreen();
  });

  it('offline: VDI and cleaning count as pending; the shift starts on the device and syncs once back online', async () => {
    const h = await harness();
    await h.services.cache.saveToday(todayDto());
    const r = await open(h, false);
    expect(
      await screen.findByText(/Offline – showing what this device last received/),
    ).toBeOnTheScreen();

    await press('Start vehicle check');
    await press('Submit vehicle check');
    expect(await screen.findByText('✕ Some answers are missing.')).toBeOnTheScreen();
    for (const i of ['Tyres', 'Lights', 'Interior clean']) await press(`${i}: Pass`);
    await type('Odometer (miles)', '45210');
    await press('Submit vehicle check');
    expect(await screen.findByText(/Vehicle check saved/)).toBeOnTheScreen();
    await press('Back to my shift');

    await press('Complete cleaning confirmation');
    expect(screen.getByLabelText('Confirm cleaning')).toBeDisabled();
    await press('Method: Detergent wipe');
    await fireEvent(
      screen.getByLabelText('I confirm the vehicle has been cleaned to the required standard'),
      'valueChange',
      true,
    );
    await press('Confirm cleaning');
    await press('Back to my shift');

    expect(await screen.findAllByText('Done on this device – pending sync')).toHaveLength(2);
    expect(screen.getByLabelText('2 waiting to send')).toBeOnTheScreen();
    await press('Start shift');
    expect(
      await screen.findByText('✓ Shift started on this device – pending sync.'),
    ).toBeOnTheScreen();
    // Nothing reached the server while offline.
    expect(h.server.st.records.size).toBe(0);

    await r.setOnline(true);
    await act(() => h.services.sync.run());
    const types = [...h.server.st.records.values()].map((i) => i.type);
    expect(types).toEqual(['VDI', 'CLEANING', 'SHIFT_START']);
    const vdi = [...h.server.st.records.values()][0]!;
    expect(vdi.payload).toMatchObject({
      odometer: 45210,
      shiftId: shiftDto().id,
      capturedAt: NOW.toISOString(),
    });
  });

  it('offline with an eligibility check older than 30 minutes: follow downtime procedure', async () => {
    const h = await harness();
    const ready = shiftDto();
    ready.gate.cards = ready.gate.cards.map((c) => ({
      ...c,
      state: c.code === 'DRIVING_CLEARANCE' ? 'APPROVED' : 'COMPLETE',
    }));
    await h.services.cache.saveToday(todayDto({ shift: ready }));
    h.time.now = new Date(NOW.getTime() + 31 * 60_000);
    await open(h, false);
    expect(
      await screen.findByText('✕ Follow downtime procedure – call control.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Start shift')).toBeDisabled();
    await press('Call control');
    expect(h.calls).toContain('call-control');
  });

  it('online, the server has the last word: a refused start lists its checks', async () => {
    const h = await harness();
    const ready = shiftDto();
    ready.gate.cards = ready.gate.cards.map((c) => ({
      ...c,
      state: c.code === 'DRIVING_CLEARANCE' ? 'APPROVED' : 'COMPLETE',
    }));
    h.server.st.today = todayDto({ shift: ready });
    h.server.st.startStatus = 422;
    await open(h);
    await press('Start shift');
    expect(await screen.findByText('✕ Vehicle check not done')).toBeOnTheScreen();
    expect(screen.getByText('✕ The shift cannot start yet')).toBeOnTheScreen();
  });
});

describe('vehicle check [FLT-03, APP-01]', () => {
  it('a failed critical item needs a reason and a photo is attached; the crew are told not to use the vehicle', async () => {
    const h = await harness();
    await open(h);
    await press('Start vehicle check');
    await press('Tyres: Fail');
    await press('Lights: Pass');
    await press('Interior clean: N/A');
    await type('Odometer (miles)', '1200');
    await press('Submit vehicle check');
    expect(await screen.findByText('✕ Give a reason')).toBeOnTheScreen();
    await type('What is wrong – Tyres', 'Nearside front tread below limit');
    await press('Add photo');
    await screen.findByText('Photo attached.');
    await press('Submit vehicle check');
    expect(
      await screen.findByText(/A critical item failed. Do not use this vehicle/),
    ).toBeOnTheScreen();
    await waitFor(() => expect(h.server.st.records.size).toBe(1));
    const sent = [...h.server.st.records.values()][0]!;
    expect(sent.payload.results).toEqual([
      {
        code: 'TYRES',
        result: 'FAIL',
        reason: 'Nearside front tread below limit',
        photoEvidenceItemId: expect.stringMatching(/9000-/),
      },
      { code: 'LIGHTS', result: 'PASS' },
      { code: 'INTERIOR', result: 'NA' },
    ]);
  });
});

describe('job detail [APP-01, APP-02]', () => {
  it('shows the assigned job on a protected screen with one large button per step', async () => {
    const h = await harness();
    await open(h);
    await press(/J-101 · pick up/);
    expect(await screen.findByText('Synthetic Patient')).toBeOnTheScreen();
    expect(h.calls).toContain('secure-screen');
    expect(
      screen.getByText('Read the current approved plan before moving the patient.'),
    ).toBeOnTheScreen();
    expect(screen.getByText('Key safe at side door')).toBeOnTheScreen();
    expect(
      screen.getByText('Only update the status when the vehicle is stationary.'),
    ).toBeOnTheScreen();
    await press('Open pickup in maps');
    expect(h.calls).toContain('maps:1 Synthetic Road, Watford');

    await press('Cannot take this job');
    expect(screen.getByLabelText('Confirm')).toBeDisabled();
    await press('Cancel');
    await press('Acknowledge job');
    await waitFor(() => expect(h.server.st.records.size).toBe(1));
    const sent = [...h.server.st.records.values()][0]!;
    expect(sent).toMatchObject({
      type: 'JOB_STATUS',
      ref: JOB,
      payload: { state: 'ACKNOWLEDGED', capturedAt: NOW.toISOString() },
    });
    // No patient detail in the outbox label or anything else sent apart from the payload itself.
    expect(JSON.stringify(h.server.st.requests.map((r) => r.url))).not.toMatch(/Synthetic|Road/);
  });

  it('offline the crew cannot accept a new job: downtime procedure', async () => {
    const h = await harness();
    await h.services.cache.saveToday(todayDto());
    await h.services.cache.saveJob(jobDto(), shiftDto().endsAt);
    await open(h, false);
    await press(/J-101 · pick up/);
    await press('Acknowledge job');
    expect(
      await screen.findByText('✕ Follow downtime procedure – call control.'),
    ).toBeOnTheScreen();
    expect(await h.services.outbox.list()).toHaveLength(0);
  });
});

describe('defects during a journey [APP-02]', () => {
  it('a critical defect while under way says contact control now and never to leave the patient', async () => {
    const h = await harness();
    const s = shiftDto({ state: 'STARTED' });
    s.jobs = s.jobs.map((j) => ({ ...j, state: 'EN_ROUTE', nextStates: ['ARRIVED', 'ABORTED'] }));
    h.server.st.today = todayDto({ shift: s });
    await open(h);
    await press('Report defect');
    await press('Severity: Critical');
    expect(
      await screen.findByText(/Contact control now. Stay with your patient/),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/leave|abandon/i)).toBeNull();
    await press('Call control now');
    expect(h.calls).toContain('call-control');
    await type('What is wrong', 'Brake warning light on');
    await press('Send defect report');
    await waitFor(() => expect(h.server.st.records.size).toBe(1));
    expect([...h.server.st.records.values()][0]!.payload).toMatchObject({
      severity: 'CRITICAL',
      stopUse: true,
      vehicleId: s.vehicle.id,
    });
  });
});

describe('policies and messages', () => {
  it('a critical instruction needs explicit confirmation before it can be acknowledged', async () => {
    const h = await harness();
    h.server.st.policies = [
      {
        documentId: POLICY_V,
        versionId: POLICY_V,
        code: 'CI-01',
        title: 'Oxygen cylinder handling',
        category: 'CRITICAL_INSTRUCTION',
        version: 2,
        summary: 'Secure cylinders upright.',
        critical: true,
        publishedAt: null,
        documentEvidenceVersionId: null,
      },
    ];
    await open(h);
    await press('Policies');
    expect(await screen.findByText('CI-01 Oxygen cylinder handling')).toBeOnTheScreen();
    expect(screen.getByLabelText('Acknowledge')).toBeDisabled();
    await fireEvent(
      screen.getByLabelText('I have read and understood this critical instruction'),
      'valueChange',
      true,
    );
    await press('Acknowledge');
    await waitFor(() => expect(h.server.st.records.size).toBe(1));
    expect([...h.server.st.records.values()][0]).toMatchObject({
      type: 'POLICY_ACK',
      ref: POLICY_V,
      payload: { confirmCritical: true },
    });
  });

  it('a conflict shows the server state and stays until the person has dealt with it', async () => {
    const h = await harness();
    h.server.st.conflictRefs.add(JOB);
    await h.services.outbox.enqueue({
      type: 'JOB_STATUS',
      ref: JOB,
      payload: { state: 'EN_ROUTE' },
      label: 'J-101 – En route',
    });
    await h.services.sync.run();
    await open(h);
    expect(await screen.findByLabelText('Messages (1)')).toBeOnTheScreen();
    await press('Messages (1)');
    expect(await screen.findByText('This job is no longer assigned to you')).toBeOnTheScreen();
    expect(screen.getByText('reassigned')).toBeOnTheScreen();
    await press('I have dealt with this – remove');
    expect(await screen.findByText('Everything has been sent.')).toBeOnTheScreen();
  });
});

describe('fuel receipt [FLT-08]', () => {
  it('parses pounds into pence and queues the expense with the receipt photo', async () => {
    expect([
      toPence('61.23'),
      toPence('£5'),
      toPence('5.5'),
      toPence('abc'),
      toPence('1.234'),
    ]).toEqual([6123, 500, 550, null, null]);
    const h = await harness();
    await open(h);
    await press('Fuel receipt');
    await press('Photograph receipt');
    await type('Litres', '40.5');
    await type('Amount (£)', '61.23');
    await press('Save receipt');
    await waitFor(() => expect(h.server.st.records.size).toBe(1));
    expect([...h.server.st.records.values()][0]!.payload).toMatchObject({
      category: 'FUEL',
      unit: 'LITRES',
      quantity: 40.5,
      amountPence: 6123,
      spentOn: '2026-10-30',
      receiptEvidenceItemId: expect.stringMatching(/9000-/),
    });
  });
});

describe('session screens [MOBILE_APP sign in, device security]', () => {
  it('a returning session asks to unlock and warns before the wipe', async () => {
    const h = await harness();
    await h.services.session.restore();
    h.bio.ok = false;
    await render(<AppRoot services={h.services} online />);
    await press('Unlock');
    expect(await screen.findByText(/4 attempts left before data is removed/)).toBeOnTheScreen();
    h.bio.ok = true;
    await press('Unlock');
    expect(await screen.findByText('AMB-01 · SY26 ABC')).toBeOnTheScreen();
  });

  it('a revoked device lands on sign-in with nothing left on it', async () => {
    const h = await harness();
    h.server.st.revoked = 'DEVICE_REVOKED';
    await render(<AppRoot services={h.services} online />);
    expect(await screen.findByText(/signed out by your organisation/)).toBeOnTheScreen();
    expect(h.store.wiped).toBeGreaterThan(0);
    expect(h.kv.m.size).toBe(0);
  });
});
