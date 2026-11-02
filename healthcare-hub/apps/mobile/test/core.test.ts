import { pushPayload, syncBackoffMs } from '@hub/rules';
import { ApiError, NetworkError } from '../src/core/api';
import { uuidv7, UUID_RE } from '../src/core/ids';
import { withFileIds } from '../src/core/outbox';
import { routeForPush } from '../src/core/push';
import { KEYS, MAX_UNLOCK_FAILURES, wipeDevice } from '../src/core/session';
import {
  crewNextStates,
  DOWNTIME_TEXT,
  gateWithPending,
  offlineBlocked,
  startDecision,
  stateWithPending,
} from '../src/core/shift';
import { harness, JOB, jobDto, MemoryKv, NOW, ORG, SHIFT, shiftDto, todayDto } from './fakes';

const MIN = 60_000;

describe('client submission ids', () => {
  it('are RFC 9562 version 7 and sort in capture order', () => {
    const r = () => new Uint8Array(16).fill(0xab);
    const a = uuidv7(NOW.getTime(), r);
    const b = uuidv7(NOW.getTime() + 1, r);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(a < b).toBe(true);
    expect(() => uuidv7(0, () => new Uint8Array(4))).toThrow();
  });
});

describe('outbox [APP-01]', () => {
  it('keeps items oldest first and removes them once the server has them', async () => {
    const h = await harness();
    const { outbox } = h.services;
    const a = await outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    h.time.now = new Date(NOW.getTime() + 1000);
    await outbox.enqueue({
      type: 'VDI',
      payload: {},
      label: 'VDI',
      capturedAt: new Date(NOW.getTime() - MIN),
    });
    expect((await outbox.list()).map((i) => i.type)).toEqual(['VDI', 'CLEANING']);
    expect(await outbox.pendingCount()).toBe(2);
    await outbox.applyResult(a, { ...result(a.clientSubmissionId), outcome: 'DUPLICATE' });
    expect((await outbox.list()).map((i) => i.type)).toEqual(['VDI']);
  });

  it('backs off on temporary failures and gives up for review after 12 attempts', async () => {
    const h = await harness();
    const { outbox } = h.services;
    let item = await outbox.enqueue({ type: 'DEFECT', payload: {}, label: 'Defect' });
    await outbox.retryLater(item, { code: 'OFFLINE', detail: null });
    item = (await outbox.list())[0]!;
    expect(item.attempts).toBe(1);
    expect(new Date(item.nextAttemptAt).getTime() - NOW.getTime()).toBe(syncBackoffMs(0));
    expect(await outbox.due(NOW)).toHaveLength(0);
    expect(await outbox.due(new Date(NOW.getTime() + 15_000))).toHaveLength(1);
    for (let i = 0; i < 11; i += 1) await outbox.retryLater((await outbox.list())[0]!, null);
    const last = (await outbox.list())[0]!;
    expect(last.state).toBe('REJECTED');
    expect(last.error?.detail).toMatch(/Check with control/);
    await outbox.retryNow(last.clientSubmissionId);
    expect((await outbox.list())[0]).toMatchObject({ state: 'PENDING', attempts: 0 });
  });

  it('keeps conflicts with the server state until the person dismisses them', async () => {
    const h = await harness();
    const { outbox } = h.services;
    const item = await outbox.enqueue({
      type: 'JOB_STATUS',
      ref: JOB,
      payload: { state: 'EN_ROUTE' },
      label: 'J-101',
    });
    await outbox.applyResult(item, {
      ...result(item.clientSubmissionId),
      outcome: 'CONFLICT',
      code: 'NOT_FOUND',
      serverState: { state: 'REASSIGNED' },
    });
    const [c] = await outbox.list();
    expect(c).toMatchObject({ state: 'CONFLICT', serverState: { state: 'REASSIGNED' } });
    expect(await outbox.due()).toHaveLength(0);
    await outbox.dismiss(item.clientSubmissionId);
    expect(await outbox.list()).toHaveLength(0);
  });

  it('puts uploaded photo evidence ids where the server expects them', () => {
    const file = (target: never, id?: string) => ({
      uri: 'file:///x.jpg',
      mime: 'image/jpeg' as const,
      sizeBytes: 1,
      title: 'Photo',
      target,
      ...(id ? { evidenceItemId: id } : {}),
    });
    const out = withFileIds(
      {
        results: [
          { code: 'TYRES', result: 'FAIL' },
          { code: 'LIGHTS', result: 'PASS' },
        ],
      },
      [
        file({ kind: 'vdiItem', code: 'TYRES' } as never, 'e1'),
        file({ kind: 'append', key: 'photoEvidenceItemIds' } as never, 'e2'),
        file({ kind: 'append', key: 'photoEvidenceItemIds' } as never, 'e3'),
        file({ kind: 'set', key: 'receiptEvidenceItemId' } as never, 'e4'),
        file({ kind: 'set', key: 'ignored' } as never),
      ],
    );
    expect(out).toEqual({
      results: [
        { code: 'TYRES', result: 'FAIL', photoEvidenceItemId: 'e1' },
        { code: 'LIGHTS', result: 'PASS' },
      ],
      photoEvidenceItemIds: ['e2', 'e3'],
      receiptEvidenceItemId: 'e4',
    });
  });
});

describe('sync engine [APP-01, UAT-06]', () => {
  it('does nothing while offline', async () => {
    const h = await harness();
    h.online.value = false;
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    expect((await h.services.sync.run()).attempted).toBe(0);
    expect(h.server.st.requests).toHaveLength(0);
  });

  it('a lost response is retried and the server still ends up with exactly one record', async () => {
    const h = await harness();
    const { outbox, sync } = h.services;
    await outbox.enqueue({ type: 'CLEANING', payload: { type: 'PRE_SHIFT' }, label: 'Cleaning' });
    await outbox.enqueue({
      type: 'JOB_STATUS',
      ref: JOB,
      payload: { state: 'ACKNOWLEDGED' },
      label: 'J-101',
    });
    h.server.st.dropNextSyncResponse = true;
    const first = await sync.run();
    expect(first).toMatchObject({ retrying: 2, reachedServer: false });
    expect(h.server.st.records.size).toBe(2); // the server did get them
    h.time.now = new Date(NOW.getTime() + 20_000);
    const second = await sync.run();
    expect(second).toMatchObject({ duplicates: 2, accepted: 0 });
    expect(h.server.st.records.size).toBe(2);
    expect(await outbox.list()).toHaveLength(0);
    expect(await sync.lastSyncedAt()).toEqual(h.time.now);
  });

  it('sends the device, organisation and bearer headers; the server decides', async () => {
    const h = await harness();
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    await h.services.sync.run();
    const r = h.server.st.requests.find((x) => x.url.endsWith('/crew/sync'))!;
    expect(r.headers).toMatchObject({
      authorization: 'Bearer synthetic-token',
      'x-org-id': ORG,
      'x-device-id': 'device-synthetic-0001',
    });
  });

  it('uploads photos once, even when the sync after the upload fails', async () => {
    const h = await harness();
    await h.services.outbox.enqueue({
      type: 'DEFECT',
      payload: { severity: 'MINOR', description: 'Mirror cracked' },
      label: 'Defect',
      files: [
        {
          uri: 'file:///p/1.jpg',
          mime: 'image/jpeg',
          sizeBytes: 10,
          title: 'Defect photo',
          target: { kind: 'append', key: 'photoEvidenceItemIds' },
        },
      ],
    });
    h.server.st.dropNextSyncResponse = true;
    await h.services.sync.run();
    expect(h.server.st.uploads).toBe(1);
    expect(h.files.removed).toContain('file:///p/1.jpg');
    h.time.now = new Date(NOW.getTime() + 20_000);
    await h.services.sync.run();
    expect(h.server.st.uploads).toBe(1);
    const sent = [...h.server.st.records.values()][0]!;
    expect((sent.payload.photoEvidenceItemIds as string[])[0]).toMatch(/9000-/);
    // Blob uploads go to the signed link without the bearer token.
    const put = h.server.st.requests.find((x) => x.method === 'PUT')!;
    expect(put.headers.authorization).toBeUndefined();
  });

  it('a malformed batch is retried one by one so one bad item does not hold up the rest', async () => {
    const h = await harness();
    h.server.st.badRequestForBatches = true;
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'A' });
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'B' });
    const r = await h.services.sync.run();
    expect(r.accepted).toBe(2);
  });

  it('a job reassigned while offline becomes a conflict to reconcile, never overwritten', async () => {
    const h = await harness();
    h.server.st.conflictRefs.add(JOB);
    await h.services.outbox.enqueue({
      type: 'JOB_STATUS',
      ref: JOB,
      payload: { state: 'EN_ROUTE' },
      label: 'J-101',
    });
    expect((await h.services.sync.run()).conflicts).toBe(1);
    expect((await h.services.outbox.list())[0]).toMatchObject({
      state: 'CONFLICT',
      serverState: { state: 'REASSIGNED' },
    });
  });

  it('a revoked device is wiped on its next contact (MOBILE_APP "Cache TTL")', async () => {
    const h = await harness();
    await h.services.cache.saveToday(todayDto());
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    h.server.st.revoked = 'DEVICE_REVOKED';
    await h.services.sync.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.revokedWith).toEqual(['DEVICE_REVOKED']);
    expect(h.services.session.state).toBe('SIGNED_OUT');
    expect(h.store.outbox.size).toBe(0);
    expect(h.store.cache.size).toBe(0);
    expect(h.kv.m.size).toBe(0);
    expect(h.files.removed).toContain('*');
  });
});

describe('API client', () => {
  it('maps problem details and connection failures', async () => {
    const h = await harness();
    await expect(h.services.api.get('/api/v1/nowhere')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    h.server.st.offline = true;
    await expect(h.services.api.get('/api/v1/crew/today')).rejects.toBeInstanceOf(NetworkError);
    expect(new ApiError(503, 'X', null, null).transient).toBe(true);
    expect(new ApiError(422, 'X', null, null).transient).toBe(false);
  });
});

describe('cache [MOBILE_APP "Cache TTL", "only assigned patient details"]', () => {
  it('discards shift data after end of shift + 12 h and patient details at shift end', async () => {
    const h = await harness();
    const { cache } = h.services;
    await cache.saveToday(todayDto());
    await cache.saveJob(jobDto(), shiftDto().endsAt);
    expect((await cache.loadToday())?.savedAt).toEqual(NOW);
    expect((await cache.loadJob(JOB))?.patientContact?.name).toBe('Synthetic Patient');
    h.time.now = new Date('2026-10-30T19:31:00Z');
    expect(await cache.loadJob(JOB)).toBeNull();
    expect(await cache.loadToday()).not.toBeNull();
    h.time.now = new Date('2026-10-31T07:31:00Z');
    expect(await cache.loadToday()).toBeNull();
    expect(h.store.cache.size).toBe(0);
  });
});

describe('session and device security [MOBILE_APP "Device security"]', () => {
  it('refuses sign-in on a device without a screen lock', async () => {
    const h = await harness({ signedIn: false });
    h.bio.available = false;
    await expect(h.services.session.signIn()).rejects.toThrow(/screen lock/);
    expect(h.kv.m.has(KEYS.tokens)).toBe(false);
  });

  it('a returning session must be unlocked; five failed unlocks wipe the device', async () => {
    const h = await harness();
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    expect(await h.services.session.restore()).toBe('LOCKED');
    expect(await h.services.session.token()).toBeNull();
    h.bio.ok = false;
    for (let i = 1; i < MAX_UNLOCK_FAILURES; i += 1)
      expect(await h.services.session.unlock()).toBe('FAILED');
    expect(await h.services.session.unlockFailures()).toBe(4);
    expect(await h.services.session.unlock()).toBe('WIPED');
    expect(h.services.session.state).toBe('SIGNED_OUT');
    expect(h.store.outbox.size).toBe(0);
    expect(h.kv.m.size).toBe(0);
  });

  it('refreshes tokens before expiry; a failed refresh signs out but keeps unsent work', async () => {
    const h = await harness();
    h.time.now = new Date(NOW.getTime() + 3_590_000);
    expect(await h.services.session.token()).toBe('synthetic-token-2');
    await h.services.outbox.enqueue({ type: 'CLEANING', payload: {}, label: 'Cleaning' });
    (
      h.services.session as unknown as { d: { auth: { refresh: () => Promise<null> } } }
    ).d.auth.refresh = async () => null;
    h.time.now = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(await h.services.session.token()).toBeNull();
    expect(h.services.session.state).toBe('SIGNED_OUT');
    expect(h.store.outbox.size).toBe(1);
  });

  it('wiping keeps going when one step fails, then reports it', async () => {
    const kv = new MemoryKv();
    await kv.set(KEYS.dbKey, 'k');
    await expect(
      wipeDevice({
        kv,
        clearStore: async () => Promise.reject(new Error('busy')),
        clearFiles: async () => undefined,
      }),
    ).rejects.toThrow('busy');
    expect(kv.m.size).toBe(0);
  });
});

describe('shift gate on the device [JOB-03, MOBILE_APP "Offline"]', () => {
  const cards = (s = shiftDto()) => s.gate.cards;
  it('shows work done offline as complete – pending sync, but never a failed critical check', async () => {
    const h = await harness();
    const vdi = await h.services.outbox.enqueue({
      type: 'VDI',
      label: 'VDI',
      payload: { shiftId: SHIFT, results: [{ code: 'TYRES', result: 'FAIL' }] },
    });
    expect(gateWithPending(shiftDto(), await h.services.outbox.list())[1]!.state).toBe('REQUIRED');
    await h.services.outbox.dismiss(vdi.clientSubmissionId);
    await h.services.outbox.enqueue({
      type: 'VDI',
      label: 'VDI',
      payload: { shiftId: SHIFT, results: [{ code: 'INTERIOR', result: 'FAIL' }] },
    });
    await h.services.outbox.enqueue({
      type: 'CLEANING',
      label: 'C',
      payload: { shiftId: SHIFT, type: 'PRE_SHIFT' },
    });
    const g = gateWithPending(shiftDto(), await h.services.outbox.list());
    expect(g.map((c) => c.state)).toEqual(['APPROVED', 'COMPLETE', 'COMPLETE']);
    expect(g[1]!.reasonText).toMatch(/pending sync/);
  });

  it('offline start only within 30 minutes of the last server check; otherwise downtime', () => {
    const ok = cards().map((c) => ({
      ...c,
      state: c.state === 'REQUIRED' ? ('COMPLETE' as const) : c.state,
    }));
    const base = { today: todayDto(), savedAt: NOW, cards: ok };
    expect(startDecision({ ...base, online: true, now: NOW })).toEqual({ kind: 'ONLINE' });
    expect(
      startDecision({ ...base, online: false, now: new Date(NOW.getTime() + 29 * MIN) }),
    ).toEqual({ kind: 'OFFLINE_OK' });
    expect(
      startDecision({ ...base, online: false, now: new Date(NOW.getTime() + 31 * MIN) }),
    ).toEqual({
      kind: 'DOWNTIME',
      text: DOWNTIME_TEXT,
    });
    expect(startDecision({ ...base, cards: cards(), online: true, now: NOW }).kind).toBe('BLOCKED');
    const blocked = cards().map((c) =>
      c.code === 'DRIVING_CLEARANCE' ? { ...c, state: 'BLOCKED' as const } : c,
    );
    expect(startDecision({ ...base, cards: blocked, online: true, now: NOW }).kind).toBe('BLOCKED');
    expect(
      startDecision({
        ...base,
        today: todayDto({ shift: shiftDto({ state: 'STARTED' }) }),
        online: false,
        now: NOW,
      }),
    ).toEqual({ kind: 'STARTED' });
    expect(
      startDecision({ ...base, today: todayDto({ shift: null }), online: true, now: NOW }).kind,
    ).toBe('BLOCKED');
  });

  it('crew actions follow the server rules; accepting a job needs the server', async () => {
    expect(crewNextStates('OFFERED')).toEqual(['ACKNOWLEDGED', 'REFUSED']);
    expect(crewNextStates('ACKNOWLEDGED')).toEqual(['EN_ROUTE']);
    expect(crewNextStates('ALLOCATED')).toEqual([]);
    expect(offlineBlocked('ACKNOWLEDGED', false)).toBe(true);
    expect(offlineBlocked('EN_ROUTE', false)).toBe(false);
    const h = await harness();
    await h.services.outbox.enqueue({
      type: 'JOB_STATUS',
      ref: JOB,
      label: 'J',
      payload: { state: 'EN_ROUTE' },
    });
    expect(stateWithPending(JOB, 'ACKNOWLEDGED', await h.services.outbox.list())).toEqual({
      state: 'EN_ROUTE',
      pending: true,
    });
    expect(stateWithPending('other', 'OFFERED', await h.services.outbox.list())).toEqual({
      state: 'OFFERED',
      pending: false,
    });
  });
});

describe('push [non-negotiable 7]', () => {
  it('payloads are generic and a tap only routes by type and opaque id', () => {
    const p = pushPayload('JOB_OFFERED', JOB);
    expect(JSON.stringify(p)).not.toMatch(/Synthetic|Road|Hospital/);
    expect(routeForPush(p.data)).toEqual({ screen: 'job', id: JOB });
    expect(routeForPush({ type: 'POLICY_ACK', id: JOB })).toEqual({ screen: 'policies' });
    expect(routeForPush({ type: 'SHIFT_CHANGED', id: JOB })).toEqual({ screen: 'shift' });
    expect(routeForPush({ type: 'JOB_OFFERED', id: '../../etc' })).toBeNull();
    expect(routeForPush({ type: 'OTHER', id: JOB })).toBeNull();
    expect(routeForPush(null)).toBeNull();
  });
});

function result(id: string) {
  return {
    clientSubmissionId: id,
    type: 'CLEANING' as const,
    outcome: 'ACCEPTED' as const,
    status: 201,
    code: null,
    detail: null,
    entityId: null,
    serverState: null,
  };
}
