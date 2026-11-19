import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootstrap, migrate, seed } from '@hub/db/admin';
import { londonDate } from '@hub/rules';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Call } from '../scripts/crew-demo-lib.js';
import { loadDemoData, type PutFile } from '../scripts/demo-data-lib.js';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
/** A database of its own: adopting library templates would change what the other test files see. */
const dbName = `hub_demo_${process.pid}_${Date.now()}`;
const rename = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const server = rename(urls.superuser, 'postgres');
let app: NestFastifyApplication;
let close: () => Promise<void>;

const call: Call = async (method, url, sub, body) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': SEED_IDS.orgExample,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, body: res.json() };
};

const putFile: PutFile = async (uploadUrl, bytes, mime) =>
  (
    await app.inject({
      method: 'PUT',
      url: new URL(uploadUrl).pathname,
      headers: { 'content-type': mime },
      payload: Buffer.from(bytes),
    })
  ).statusCode;

beforeAll(async () => {
  const app_ = rename(urls.app, dbName);
  const admin = rename(urls.admin, dbName);
  await bootstrap({ superuserUrl: server, adminUrl: admin, appUrl: app_ });
  await migrate(admin);
  await seed(admin);
  const made = await makeApp({ app: app_ });
  app = made.app;
  close = () => made.db.close();
});
afterAll(async () => {
  await app.close();
  await close();
  const su = new pg.Client({ connectionString: server });
  await su.connect();
  await su.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await su.end();
});

describe('demo data', () => {
  it('loads a working day through the real API, with nothing refused', async () => {
    const r = await loadDemoData(call, { locationId: SEED_IDS.locWatford }, putFile);
    expect(r.problems, JSON.stringify(r.problems, null, 1)).toEqual([]);
    expect(r.alreadyLoaded).toBe(false);
    expect(r.created, JSON.stringify(r.created)).toEqual({
      staff: 10,
      vehicles: 6,
      defects: 2,
      requirements: 19,
      premises: 3,
      // 66 role checks (the starter configuration's role maps, verified by a second person)
      // + 2 joiner uploads + 13 deadlines
      evidence: 81,
      shifts: 2,
      jobs: 8,
      risks: 3,
      events: 3,
    });
    expect(r.jobsRefused).toEqual([]);
    expect(r.jobsAllocated, JSON.stringify(r.jobsRefused)).toBe(5);
  });

  it('gives the dashboard real figures, worked out by the real rules', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await call('GET', '/api/v1/dashboard/summary', 'dev|manager')).body as any;
    expect(s.tiles.overdue).toBeGreaterThan(0);
    expect(s.tiles.dueSoon).toBeGreaterThan(0);
    expect(s.tiles.blockedVehicles).toBeGreaterThan(0);
    expect(s.tiles.unverified).toBeGreaterThan(0);
    expect(s.tiles.jobsToday).toBeGreaterThan(0);
    // Three jobs are left for the dispatcher (5, 6 and 7 hours from now); late in the evening some
    // fall on tomorrow and leave today's count.
    const today = londonDate(new Date());
    const leftToday = [5, 6, 7].filter(
      (h) => londonDate(new Date(Date.now() + h * 3_600_000)) === today,
    ).length;
    expect(s.operations.jobsAwaitingAllocation).toBe(leftToday);
    expect(s.coverage.numerator).toBeGreaterThan(0);
    const fleet = (await call('GET', '/api/v1/vehicles', 'dev|manager')).body.data as {
      callsign: string;
      status: string;
      licenceCategory: string;
      grossWeightKg: number | null;
    }[];
    // Safety gates hold in the demo data too: the stop-use defect blocks its vehicle.
    expect(fleet.find((v) => v.callsign === 'AMB-05')?.status).toBe('BLOCKED');
    // Ambulances are over 3,500 kg, so they need C1, not B (finding 89).
    expect(fleet.find((v) => v.callsign === 'AMB-04')).toMatchObject({
      licenceCategory: 'C1',
      grossWeightKg: 4250,
    });
    const premises = (await call('GET', '/api/v1/premises-items', 'dev|manager')).body.data as {
      title: string;
    }[];
    expect(premises.some((p) => p.title.startsWith('Legionella flushing'))).toBe(true);
  });

  it('does nothing when it is run again', async () => {
    const before = ((await call('GET', '/api/v1/staff', 'dev|manager')).body.data as unknown[])
      .length;
    const r = await loadDemoData(call, { locationId: SEED_IDS.locWatford }, putFile);
    expect(r.alreadyLoaded).toBe(true);
    expect(r.created, JSON.stringify(r.created)).toEqual({});
    const after = ((await call('GET', '/api/v1/staff', 'dev|manager')).body.data as unknown[])
      .length;
    expect(after).toBe(before);
  });
});
