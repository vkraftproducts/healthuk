import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bookCrewDay, type Call, type DemoIds } from '../scripts/crew-demo-lib.js';
import { SEED_IDS, activateStaff, addVerifiedLicence, makeApp, sign } from './harness.js';

// Other test files change the seeded crew (ST-0042) in the shared test database, so this test
// runs the demo against its own fresh crew and vehicle; the script's steps are the same.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const call: Call = async (method, url, sub, body) => {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': SEED_IDS.orgExample,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
};

async function crew(tag: string, roles: string[]): Promise<{ staffId: string; sub: string }> {
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  const sub = `dev|demo-${tag.toLowerCase()}`;
  try {
    const u = await su.query(
      `INSERT INTO app_user (idp_subject, email, display_name, status) VALUES ($1, $2, 'Synthetic Demo Crew', 'ACTIVE') RETURNING id`,
      [sub, `demo-${tag.toLowerCase()}@example.test`],
    );
    await su.query(
      `INSERT INTO membership (organisation_id, user_id, role_id) SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = 'CREW'`,
      [SEED_IDS.orgExample, u.rows[0].id],
    );
    const s = await call('POST', '/api/v1/staff', 'dev|manager', {
      staffNo: `ST-${7000 + (Number.parseInt(tag, 36) % 2999)}`,
      displayName: `Synthetic Demo ${tag}`,
      primaryLocationId: SEED_IDS.locWatford,
      userId: u.rows[0].id,
    });
    const id = s.body.id as string;
    await move(id, 'CHECKS_IN_PROGRESS');
    await activateStaff(app, SEED_IDS.orgExample, id, roles);
    if (roles.includes('DRIVER')) await addVerifiedLicence(app, SEED_IDS.orgExample, id);
    return { staffId: id, sub };
  } finally {
    await su.end();
  }
}
const move = (id: string, to: string) =>
  call('POST', `/api/v1/staff/${id}/transition`, 'dev|hr', { to, reason: `To ${to}` });

describe('dev crew demo script', () => {
  it('books a crewed shift with one offered job through the normal API, and never double-books', async () => {
    const tag = Date.now().toString(36).slice(-5).toUpperCase();
    const driver = await crew(`${tag}1`, ['DRIVER', 'CARE_ASSISTANT']);
    const assistant = await crew(`${tag}2`, ['CARE_ASSISTANT']);
    const v = await call('POST', '/api/v1/vehicles', 'dev|fleet', {
      // D1: a current-format UK registration (two letters, two digits, three letters).
      registration: `DM${(Date.now() % 90) + 10}XYZ`,
      callsign: `DEMO-${tag}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
    });
    expect(v.status).toBe(201);
    const ids: DemoIds = {
      orgId: SEED_IDS.orgExample,
      locationId: SEED_IDS.locWatford,
      vehicleId: v.body.id as string,
      driverStaffId: driver.staffId,
      assistantStaffId: assistant.staffId,
    };
    const r = await bookCrewDay(call, ids);
    // The demo records the driver's licence check first; without it allocation is blocked on LICENCE.
    expect(r).toMatchObject({ allocated: true, blockers: [] });
    expect(r.jobCode).toMatch(/^J-\d+$/);
    const today = await call('GET', '/api/v1/crew/today', driver.sub);
    const shift = today.body.shift as { id: string; jobs: { id: string; state: string }[] };
    expect(shift.id).toBe(r.shiftId);
    expect(shift.jobs).toEqual([expect.objectContaining({ id: r.jobId, state: 'OFFERED' })]);
    // Running it again is refused rather than double-booking the crew or the vehicle.
    expect(await bookCrewDay(call, ids)).toMatchObject({ shiftId: null, allocated: false });
  });
});
