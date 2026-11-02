import type { CrewJobDto, CrewShiftDto, CrewTodayDto, SyncItem } from '@hub/contracts';
import { Api, type RevokedCode } from '../src/core/api';
import { CrewCache } from '../src/core/cache';
import { uuidv7 } from '../src/core/ids';
import { Outbox, type OutboxItem } from '../src/core/outbox';
import type { AuthProvider, Biometrics, FileStore, LocalStore, SecureKv } from '../src/core/ports';
import { Session, wipeDevice } from '../src/core/session';
import { SyncEngine } from '../src/core/sync';
import type { Services } from '../src/app/services';

export const ORG = '01900000-0000-7000-8000-000000000001';
export const SHIFT = '01900000-0000-7000-8000-0000000000a1';
export const VEHICLE = '01900000-0000-7000-8000-0000000000b1';
export const TEMPLATE = '01900000-0000-7000-8000-0000000000c1';
export const JOB = '01900000-0000-7000-8000-0000000000d1';
export const POLICY_V = '01900000-0000-7000-8000-0000000000e1';
export const NOW = new Date('2026-10-30T07:00:00Z');

export class MemoryStore implements LocalStore {
  outbox = new Map<string, OutboxItem>();
  cache = new Map<string, { value: string; until: string }>();
  wiped = 0;
  async putOutbox(i: OutboxItem) {
    this.outbox.set(i.clientSubmissionId, structuredClone(i));
  }
  async listOutbox() {
    return [...this.outbox.values()].map((i) => structuredClone(i));
  }
  async deleteOutbox(id: string) {
    this.outbox.delete(id);
  }
  async getCache(k: string) {
    return this.cache.get(k) ?? null;
  }
  async setCache(k: string, value: string, until: string) {
    this.cache.set(k, { value, until });
  }
  async deleteCache(k: string) {
    this.cache.delete(k);
  }
  async wipe() {
    this.outbox.clear();
    this.cache.clear();
    this.wiped += 1;
  }
}

export class MemoryKv implements SecureKv {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
}

export class FakeFiles implements FileStore {
  kept: string[] = [];
  removed: string[] = [];
  async keep(uri: string) {
    const u = `file:///private/${this.kept.length}.jpg`;
    this.kept.push(uri);
    return { uri: u, sizeBytes: 2048 };
  }
  async read(uri: string) {
    return { uri } as unknown as Blob;
  }
  async remove(uri: string) {
    this.removed.push(uri);
  }
  async removeAll() {
    this.removed.push('*');
  }
}

export function clockAt(d: Date) {
  const c = { now: new Date(d) };
  return { c, clock: () => new Date(c.now) };
}

export function ids() {
  let n = 0;
  return () =>
    uuidv7(NOW.getTime() + (n += 1), () => new Uint8Array(16).map((_, i) => (i * 7 + n) % 256));
}

// ---- fixtures ---------------------------------------------------------------------------------
export function shiftDto(o: Partial<CrewShiftDto> = {}): CrewShiftDto {
  return {
    id: SHIFT,
    state: 'PLANNED',
    startsAt: '2026-10-30T07:30:00Z',
    endsAt: '2026-10-30T19:30:00Z',
    myRole: 'DRIVER',
    vehicle: {
      id: VEHICLE,
      callsign: 'AMB-01',
      registration: 'SY26 ABC',
      type: 'PTS_VEHICLE',
      status: 'AVAILABLE',
      statusReason: null,
    },
    crew: [
      { displayName: 'Synthetic Driver', role: 'DRIVER', me: true },
      { displayName: 'Synthetic Assistant', role: 'CARE_ASSISTANT', me: false },
    ],
    gate: {
      canStart: false,
      checks: [],
      cards: [
        {
          code: 'DRIVING_CLEARANCE',
          label: 'Driving clearance',
          state: 'APPROVED',
          reasonText: 'Licence checked',
        },
        {
          code: 'VDI',
          label: 'Vehicle daily inspection',
          state: 'REQUIRED',
          reasonText: 'Not done for this shift',
        },
        {
          code: 'CLEANING',
          label: 'Pre-shift cleaning',
          state: 'REQUIRED',
          reasonText: 'Not done for this shift',
        },
      ],
    },
    vdiTemplate: {
      id: TEMPLATE,
      version: 1,
      items: [
        { code: 'TYRES', label: 'Tyres', critical: true },
        { code: 'LIGHTS', label: 'Lights', critical: true },
        { code: 'INTERIOR', label: 'Interior clean', critical: false },
      ],
    },
    jobs: [
      {
        id: JOB,
        code: 'J-101',
        state: 'OFFERED',
        plannedStart: '2026-10-30T09:00:00Z',
        plannedEnd: '2026-10-30T10:00:00Z',
        pickupFrom: '2026-10-30T09:00:00Z',
        pickupTo: '2026-10-30T09:30:00Z',
        mobility: 'WHEELCHAIR',
        nextStates: ['ACKNOWLEDGED', 'REFUSED'],
      },
    ],
    ...o,
  };
}

export function todayDto(o: Partial<CrewTodayDto> = {}): CrewTodayDto {
  return {
    serverTime: NOW.toISOString(),
    eligibilityCheckedAt: NOW.toISOString(),
    cacheUntil: '2026-10-31T07:30:00Z',
    staff: { staffNo: 'ST-0042', displayName: 'Synthetic Driver' },
    shift: shiftDto(),
    upcoming: [],
    policiesPending: 1,
    ...o,
  };
}

export function jobDto(o: Partial<CrewJobDto> = {}): CrewJobDto {
  const { jobs } = shiftDto();
  return {
    ...jobs[0]!,
    shiftId: SHIFT,
    pickupAddress: '1 Synthetic Road, Watford',
    destinationAddress: 'Synthetic General Hospital',
    appointmentAt: '2026-10-30T10:00:00Z',
    accessNotes: 'Key safe at side door',
    accessPlanReviewed: true,
    escorts: 0,
    stairs: false,
    infectionPrecautions: false,
    commsNeeds: null,
    requiredEquipment: ['WHEELCHAIR_RESTRAINTS'],
    crewSize: 2,
    patientContact: { name: 'Synthetic Patient', phone: '07700 900123' },
    events: [],
    version: 1,
    ...o,
  };
}

// ---- fake API ---------------------------------------------------------------------------------
interface Req {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Mimics the API's behaviour the app depends on, including idempotency on clientSubmissionId. */
export function fakeServer() {
  const st = {
    offline: false,
    revoked: null as null | RevokedCode,
    /** The server processes the batch but the response is lost on the way back. */
    dropNextSyncResponse: false,
    badRequestForBatches: false,
    today: todayDto() as CrewTodayDto,
    job: jobDto() as CrewJobDto | null,
    policies: [] as unknown[],
    conflictRefs: new Set<string>(),
    startStatus: 201,
    records: new Map<string, SyncItem>(),
    uploads: 0,
    completed: 0,
    requests: [] as Req[],
  };
  const res = (status: number, body?: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    }) as unknown as Response;
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    st.requests.push({ method, url, headers, body });
    if (st.offline) throw new TypeError('Network request failed');
    if (url.startsWith('https://blob.test/')) return res(200, { received: 2048 });
    if (st.revoked) return res(401, { code: st.revoked });
    const path = url.replace('https://api.test', '');
    if (method === 'GET' && path === '/api/v1/crew/today') return res(200, st.today);
    if (method === 'GET' && path.startsWith('/api/v1/crew/jobs/'))
      return st.job ? res(200, st.job) : res(404, { code: 'NOT_FOUND' });
    if (method === 'GET' && path === '/api/v1/crew/policies/pending') return res(200, st.policies);
    if (method === 'GET' && path === '/api/v1/me')
      return res(200, { memberships: [{ organisationId: ORG, roleKey: 'CREW' }] });
    if (method === 'POST' && path === '/api/v1/devices/register-push') return res(201, {});
    if (method === 'POST' && /\/api\/v1\/shifts\/.+\/start$/.test(path))
      return st.startStatus === 201
        ? res(201, { state: 'STARTED' })
        : res(st.startStatus, {
            code: 'SHIFT_GATE_BLOCKED',
            detail: 'The shift cannot start yet',
            checks: [{ code: 'VDI', result: 'FAIL', reasonText: 'Vehicle check not done' }],
          });
    if (method === 'POST' && path === '/api/v1/evidence/uploads') {
      st.uploads += 1;
      const v = `01900000-0000-7000-8000-${String(st.uploads).padStart(12, '0')}`;
      return res(201, {
        evidenceItemId: v.replace('8000-', '9000-'),
        evidenceVersionId: v,
        uploadUrl: `https://blob.test/put/${v}`,
      });
    }
    if (method === 'POST' && /\/api\/v1\/evidence\/.+\/complete$/.test(path)) {
      st.completed += 1;
      return res(201, {});
    }
    if (method === 'POST' && path === '/api/v1/crew/sync') {
      const items = (body as { items: SyncItem[] }).items;
      if (st.badRequestForBatches && items.length > 1)
        return res(400, { code: 'VALIDATION_FAILED' });
      const results = items.map((i) => {
        const base = {
          clientSubmissionId: i.clientSubmissionId,
          type: i.type,
          code: null,
          detail: null,
          serverState: null,
        };
        if (i.ref && st.conflictRefs.has(i.ref))
          return {
            ...base,
            outcome: 'CONFLICT',
            status: 404,
            code: 'NOT_FOUND',
            detail: 'This job is no longer assigned to you',
            entityId: null,
            serverState: { code: 'J-101', state: 'REASSIGNED' },
          };
        const dup = st.records.has(i.clientSubmissionId);
        st.records.set(i.clientSubmissionId, i);
        return { ...base, outcome: dup ? 'DUPLICATE' : 'ACCEPTED', status: 201, entityId: null };
      });
      if (st.dropNextSyncResponse) {
        st.dropNextSyncResponse = false;
        throw new TypeError('Network request failed');
      }
      return res(201, { results });
    }
    return res(404, { code: 'NOT_FOUND' });
  };
  return { st, fetch: f as typeof fetch };
}

export interface Harness {
  services: Services;
  server: ReturnType<typeof fakeServer>;
  store: MemoryStore;
  kv: MemoryKv;
  files: FileStore & FakeFiles;
  calls: string[];
  online: { value: boolean };
  time: { now: Date };
  bio: { ok: boolean; available: boolean };
  revokedWith: RevokedCode[];
}

/** Real core services over in-memory adapters and the fake server. */
export async function harness(o: { signedIn?: boolean } = {}): Promise<Harness> {
  const server = fakeServer();
  const store = new MemoryStore();
  const kv = new MemoryKv();
  const files = new FakeFiles();
  const { c: time, clock } = clockAt(NOW);
  const online = { value: true };
  const bio = { ok: true, available: true };
  const calls: string[] = [];
  const revokedWith: RevokedCode[] = [];
  const biometrics: Biometrics = {
    available: async () => bio.available,
    authenticate: async () => bio.ok,
  };
  const auth: AuthProvider = {
    signIn: async () => ({
      accessToken: 'synthetic-token',
      refreshToken: 'r',
      expiresAt: time.now.getTime() + 3_600_000,
    }),
    refresh: async () => ({
      accessToken: 'synthetic-token-2',
      refreshToken: 'r',
      expiresAt: time.now.getTime() + 3_600_000,
    }),
  };
  const session = new Session({
    kv,
    auth,
    bio: biometrics,
    clock,
    wipe: () =>
      wipeDevice({ kv, clearStore: () => store.wipe(), clearFiles: () => files.removeAll() }),
  });
  const api = new Api({
    baseUrl: 'https://api.test',
    fetch: server.fetch,
    getToken: () => session.token(),
    getOrgId: () => session.getOrgId(),
    getDeviceId: async () => 'device-synthetic-0001',
    onRevoked: (code) => {
      revokedWith.push(code);
      void session.wipe(code);
    },
  });
  const outbox = new Outbox(store, ids(), clock);
  const services: Services = {
    api,
    outbox,
    sync: new SyncEngine({ api, outbox, files, store, clock, isOnline: () => online.value }),
    cache: new CrewCache(store, clock),
    session,
    files,
    clock,
    controlPhone: '01632960000',
    takePhoto: async () => ({ uri: 'file:///camera/1.jpg', mime: 'image/jpeg' }),
    callControl: () => calls.push('call-control'),
    openMaps: (a) => calls.push(`maps:${a}`),
    useSecureScreen: () => {
      calls.push('secure-screen');
    },
    registerDevice: async () => {
      calls.push('register-device');
    },
    deviceId: async () => 'device-synthetic-0001',
  };
  if (o.signedIn !== false) {
    await session.signIn();
    await session.setOrgId(ORG);
  }
  return { services, server, store, kv, files, calls, online, time, bio, revokedWith };
}
