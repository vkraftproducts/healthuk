import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootstrap, migrate, seed } from '@hub/db/admin';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Call } from '../scripts/crew-demo-lib.js';
import { loadDemoData, type PutFile } from '../scripts/demo-data-lib.js';
import { completeDemoRecords, ROLE_REQUIREMENTS } from '../scripts/demo-records-lib.js';
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
  await seed(admin, { singleOrganisation: true });
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
  it('starts from a database with one organisation, Exora', async () => {
    const su = new pg.Client({ connectionString: rename(urls.superuser, dbName) });
    await su.connect();
    const { rows } = await su.query<{ name: string }>('SELECT name FROM organisation');
    await su.end();
    expect(rows.map((r) => r.name)).toEqual(['Exora']);
  });

  it('loads a working day through the real API, with nothing refused', async () => {
    const r = await loadDemoData(call, { locationId: SEED_IDS.locWatford }, putFile);
    expect(r.problems).toEqual([]);
    expect(r.alreadyLoaded).toBe(false);
    expect(r.created).toEqual({
      staff: 10,
      vehicles: 6,
      defects: 2,
      requirements: 15,
      evidence: 11,
      shifts: 2,
      jobs: 8,
      risks: 3,
      events: 3,
    });
    expect(r.jobsRefused).toEqual([]);
    expect(r.jobsAllocated).toBe(5);
  });

  it('gives the dashboard real figures, worked out by the real rules', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (await call('GET', '/api/v1/dashboard/summary', 'dev|manager')).body as any;
    expect(s.tiles.overdue).toBeGreaterThan(0);
    expect(s.tiles.dueSoon).toBeGreaterThan(0);
    expect(s.tiles.blockedVehicles).toBeGreaterThan(0);
    expect(s.tiles.unverified).toBeGreaterThan(0);
    expect(s.tiles.jobsToday).toBeGreaterThan(0);
    expect(s.operations.jobsAwaitingAllocation).toBe(3);
    expect(s.coverage.numerator).toBeGreaterThan(0);
    const fleet = (await call('GET', '/api/v1/vehicles', 'dev|manager')).body.data as {
      callsign: string;
      status: string;
    }[];
    // Safety gates hold in the demo data too: the stop-use defect blocks its vehicle.
    expect(fleet.find((v) => v.callsign === 'AMB-05')?.status).toBe('BLOCKED');
  });

  it('backs every green with a record and a verified document, and leaves real gaps', async () => {
    const r = await completeDemoRecords(call, putFile);
    expect(r.problems).toEqual([]);
    expect(r.verified).toBeGreaterThan(50);
    type S = {
      id: string;
      staffNo: string;
      overallStatus: string;
      counts: { red: number; amber: number; grey: number; green: number };
    };
    type I = { id: string; templateCode: string; status: string; currentlyVerified: boolean };
    const staff = (await call('GET', '/api/v1/staff?limit=100', 'dev|manager')).body.data as S[];
    const byNo = (no: string) => staff.find((s) => s.staffNo === no)!;
    const instancesOf = async (id: string) =>
      (await call('GET', `/api/v1/requirements/instances?subjectId=${id}&limit=100`, 'dev|manager'))
        .body.data as I[];

    // A care assistant's full file: every role requirement present, each green on its own document.
    const aisha = byNo('ST-1003');
    const hers = await instancesOf(aisha.id);
    expect(hers.map((i) => i.templateCode).sort()).toEqual(
      [...ROLE_REQUIREMENTS.CARE_ASSISTANT!].sort(),
    );
    expect(aisha.overallStatus).toBe('GREEN');

    // Nobody is green while anything their roles need is missing or unverified.
    for (const s of staff)
      if (s.overallStatus === 'GREEN')
        expect(s.counts.grey + s.counts.red + s.counts.amber, s.staffNo).toBe(0);

    // Every verified requirement, for staff and vehicles, rests on a proper current document.
    const vehicles = (await call('GET', '/api/v1/vehicles', 'dev|manager')).body.data as {
      id: string;
    }[];
    let checked = 0;
    for (const subject of [...staff, ...vehicles])
      for (const i of await instancesOf(subject.id)) {
        if (!i.currentlyVerified) continue;
        const ev = (
          await call('GET', `/api/v1/requirements/instances/${i.id}/evidence`, 'dev|manager')
        ).body.data as { title: string; state: string; sizeBytes: number }[];
        // Newest first: the latest verified document is the one the status rests on. An older
        // stand-in may stay linked as history.
        const latest = ev.find((v) => v.state === 'VERIFIED');
        expect(latest, i.templateCode).toBeDefined();
        expect(latest!.title, i.templateCode).not.toMatch(/^Certificate for /);
        expect(latest!.sizeBytes).toBeGreaterThan(400);
        checked += 1;
      }
    expect(checked).toBeGreaterThan(50);

    // The deliberate gaps are still there.
    // References awaited: that requirement stays grey, so he is not green overall.
    const callum = byNo('ST-1006');
    expect(callum.overallStatus).not.toBe('GREEN');
    expect(
      (await instancesOf(callum.id)).find((i) => i.templateCode === 'AMB-STF-04')?.status,
    ).toBe('GREY');
    expect(byNo('ST-1007').overallStatus).toBe('RED'); // overdue training
    expect(byNo('ST-1004').overallStatus).toBe('AMBER'); // moving and handling due soon
    const amb06 = (
      (await call('GET', '/api/v1/vehicles', 'dev|manager')).body.data as {
        id: string;
        callsign: string;
      }[]
    ).find((v) => v.callsign === 'AMB-06')!;
    expect((await instancesOf(amb06.id)).find((i) => i.templateCode === 'AMB-VEH-01')?.status).toBe(
      'RED',
    );
  }, 300_000);

  it('adds nothing when the records step is run again', async () => {
    const again = await completeDemoRecords(call, putFile);
    expect(again.added).toEqual([]);
    expect(again).toMatchObject({
      roleRequirementsAdded: 0,
      records: 0,
      documents: 0,
      problems: [],
    });
  }, 300_000);

  it('does nothing when it is run again', async () => {
    const before = ((await call('GET', '/api/v1/staff', 'dev|manager')).body.data as unknown[])
      .length;
    const r = await loadDemoData(call, { locationId: SEED_IDS.locWatford }, putFile);
    expect(r.alreadyLoaded).toBe(true);
    expect(r.created).toEqual({});
    const after = ((await call('GET', '/api/v1/staff', 'dev|manager')).body.data as unknown[])
      .length;
    expect(after).toBe(before);
  });
});
