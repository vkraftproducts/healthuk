// v36 step 2, FLEET stream: S.cl, S.checks, S.def, S.veh load from and save to the real tables.
// Runs in its own organisation (people named as in v36) so nothing here changes the shared seed.
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The v36 prototype's own records (S.json, 17 Nov 2026), as the import receives them. */
const S36: J = {"cl": [{"v": 3, "state": "Published", "by": "Dave Evans", "pub": "Dr. Helen Price", "on": "2026-09-27", "items": [["Tyres – tread and pressure", 1], ["Lights and indicators", 1], ["Brakes and handbrake", 1], ["Fluid levels, no leaks", 0], ["Tail-lift / ramp operates and locks", 1], ["Stretcher and carry chair secured", 1], ["Oxygen – cylinders at least half full and secured", 1], ["Suction unit charged and working", 1], ["Defibrillator self-test passed", 1], ["Saloon cleaned – pre-shift IPC clean", 1], ["Fuel at least a quarter tank", 0], ["Bodywork and mirrors", 0]]}, {"v": 4, "state": "Draft", "by": "Dave Evans", "on": "2026-11-16", "items": [["Tyres – tread and pressure", 1], ["Lights and indicators", 1], ["Brakes and handbrake", 1], ["Fluid levels, no leaks", 0], ["Tail-lift / ramp operates and locks", 1], ["Stretcher and carry chair secured", 1], ["Oxygen – cylinders at least half full and secured", 1], ["Suction unit charged and working", 1], ["Defibrillator self-test passed", 1], ["Saloon cleaned – pre-shift IPC clean", 1], ["Fuel at least a quarter tank", 0], ["Bodywork and mirrors", 0], ["Sharps bin secured and below fill line", 1]], "add": [["Sharps bin secured and below fill line", 1]]}], "veh": {"AMB-01": {"id": "AMB-01", "reg": "SY21 ABC", "type": "Emergency ambulance (Type B)", "base": "Watford", "odo": 48210, "docs": {"MOT": {"exp": "2027-04-09", "s": "ok", "vby": "Dr. A. Vance"}, "INS": {"exp": "2027-02-26", "s": "ok", "vby": "Dr. A. Vance"}, "VED": {"exp": "2027-03-26", "s": "ok", "vby": "Dr. A. Vance"}, "LOLER": {"exp": "2027-04-27", "s": "ok", "vby": "Dr. Helen Price"}}, "svc": {"due": "2026-12-28", "dueMi": 52000, "last": "2026-06-28", "lastMi": 40000}, "status": []}, "AMB-02": {"id": "AMB-02", "reg": "SY21 ABD", "type": "Patient transport vehicle", "base": "Watford", "odo": 41020, "docs": {"MOT": {"exp": "2026-12-01", "s": "ok", "vby": "Dr. A. Vance"}, "INS": {"exp": "2027-02-26", "s": "ok", "vby": "Dr. A. Vance"}, "VED": {"exp": "2027-03-26", "s": "ok", "vby": "Dr. A. Vance"}, "LOLER": {"exp": "2027-03-08", "s": "ok", "vby": "Dr. Helen Price"}}, "svc": {"due": "2026-12-14", "dueMi": 42000, "last": "2026-06-13", "lastMi": 30000}, "status": []}, "AMB-03": {"id": "AMB-03", "reg": "SY22 XYZ", "type": "Wheelchair accessible vehicle", "base": "Watford", "odo": 39877, "docs": {"MOT": {"exp": "2027-06-15", "s": "ok", "vby": "Dr. A. Vance"}, "INS": {"exp": "2027-02-26", "s": "ok", "vby": "Dr. A. Vance"}, "VED": {"exp": "2027-06-26", "s": "ok", "vby": "Dr. A. Vance"}, "LOLER": {"exp": "2026-12-27", "s": "ok", "vby": "Dr. Helen Price"}}, "svc": {"due": "2027-02-05", "dueMi": 45000, "last": "2026-08-05", "lastMi": 35000}, "status": []}, "AMB-05": {"id": "AMB-05", "reg": "SY23 KLM", "type": "Patient transport vehicle", "base": "Watford", "odo": 12044, "docs": {"MOT": {"exp": "2027-07-26", "s": "na", "note": "Not due – first MOT at 3 years"}, "INS": {"exp": "2027-11-16", "s": "rcv", "by": "Dave Evans", "file": "Insurance_Renewal_AMB05.pdf", "prevExp": "2026-11-26"}, "VED": {"exp": "2027-07-26", "s": "ok", "vby": "Dr. A. Vance"}, "LOLER": {"exp": "2027-04-10", "s": "ok", "vby": "Dr. Helen Price"}}, "svc": {"due": "2026-11-15", "dueMi": 15000, "last": "2026-05-16", "lastMi": 3000}, "status": []}, "RRV-01": {"id": "RRV-01", "reg": "SY20 RRV", "type": "Rapid response car", "base": "Watford", "odo": 61002, "docs": {"MOT": {"exp": "2027-02-28", "s": "ok", "vby": "Dr. A. Vance"}, "INS": {"exp": "2027-02-26", "s": "ok", "vby": "Dr. A. Vance"}, "VED": {"exp": "2027-03-26", "s": "ok", "vby": "Dr. A. Vance"}}, "svc": {"due": "2027-01-31", "dueMi": 70000, "last": "2026-07-31", "lastMi": 58000}, "status": []}}, "checks": [{"id": "VDI-5342", "veh": "AMB-03", "date": "2026-11-15", "time": "06:14", "by": "Lee Davies", "v": 3, "odo": 39697, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "hist": 1}, {"id": "VDI-5344", "veh": "RRV-01", "date": "2026-11-15", "time": "06:46", "by": "Dr. A. Vance", "v": 3, "odo": 60822, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "hist": 1}, {"id": "VDI-5340", "veh": "AMB-01", "date": "2026-11-15", "time": "07:32", "by": "Alex Morgan", "v": 3, "odo": 48030, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "hist": 1}, {"id": "VDI-5341", "veh": "AMB-02", "date": "2026-11-15", "time": "07:53", "by": "Lee Davies", "v": 3, "odo": 40840, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "hist": 1}, {"id": "VDI-5343", "veh": "AMB-05", "date": "2026-11-15", "time": "08:05", "by": "Tom Hughes", "v": 3, "odo": 11864, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "hist": 1}, {"id": "VDI-5501", "veh": "AMB-03", "date": "2026-11-16", "time": "06:10", "by": "Lee Davies", "v": 3, "odo": 39877, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Fail", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Fail – critical", "notes": {"4": "Platform drifts down under load; pressure gauge drops > 35%."}, "def": "DEF-082"}, {"id": "VDI-5488", "veh": "AMB-01", "date": "2026-11-16", "time": "07:40", "by": "Alex Morgan", "v": 3, "odo": 48102, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass"}, {"id": "VDI-5490", "veh": "AMB-02", "date": "2026-11-16", "time": "07:58", "by": "Lee Davies", "v": 3, "odo": 41002, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass", "amend": [{"on": "2026-11-16 08:20", "by": "Lee Davies", "t": "Odometer corrected 41,002 → 41,020 (typing error). Original kept."}]}, {"id": "VDI-5520", "veh": "RRV-01", "date": "2026-11-17", "time": "06:50", "by": "Dr. A. Vance", "v": 3, "odo": 61002, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass"}, {"id": "VDI-5521", "veh": "AMB-01", "date": "2026-11-17", "time": "07:45", "by": "Alex Morgan", "v": 3, "odo": 48210, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass"}, {"id": "VDI-5522", "veh": "AMB-02", "date": "2026-11-17", "time": "08:00", "by": "Lee Davies", "v": 3, "odo": 41020, "res": {"0": "Pass", "1": "Pass", "2": "Pass", "3": "Pass", "4": "Pass", "5": "Pass", "6": "Pass", "7": "Pass", "8": "Pass", "9": "Pass", "10": "Pass", "11": "Pass"}, "out": "Pass"}], "def": {"DEF-079": {"id": "DEF-079", "veh": "AMB-01", "sev": "Minor", "desc": "Saloon light cover cracked (light still works)", "by": "Alex Morgan", "on": "2026-11-13 19:12", "stage": "Reported", "owner": "Dave Evans", "review": "2026-11-27", "stop": false, "photos": 1}, "DEF-080": {"id": "DEF-080", "veh": "AMB-02", "sev": "Major", "desc": "Suction unit battery not holding charge – spare unit fitted", "by": "Alex Morgan", "on": "2026-11-14 18:02", "stage": "Signed off", "owner": "Dave Evans", "review": "2026-11-21", "stop": false, "photos": 2, "repair": {"plan": "Replacement battery pack ordered (SU-BAT-7)", "by": "Dave Evans", "on": "2026-11-15 08:30"}, "sign": {"work": "Battery pack replaced (part SU-BAT-7). Load-tested for 45 minutes, holds charge.", "by": "Dave Evans", "on": "2026-11-16 15:40", "sheet": "JS-2231"}}, "DEF-082": {"id": "DEF-082", "veh": "AMB-03", "sev": "Critical", "desc": "Tail-lift hydraulic pressure loss over 35% – platform drifts under load", "by": "Dave Evans", "on": "2026-11-16 06:15", "from": "VDI-5501", "stage": "In repair", "owner": "Dave Evans", "review": "2026-11-19", "stop": true, "photos": 2, "repair": {"plan": "Workshop ticket WS-441 – Watford Commercial Garage. Seal kit ordered, fitting booked 18 Nov.", "by": "Dave Evans", "on": "2026-11-16 09:30"}}}};

const ORG = randomUUID();
const LOC = randomUUID();
const ROLE_OF: Record<string, string> = {
  rm: 'REGISTERED_MANAGER',
  dir: 'DIRECTOR',
  fleet: 'FLEET_LEAD',
  gov: 'GOVERNANCE_LEAD',
  disp: 'DISPATCHER',
  crew: 'CREW',
  crew2: 'CREW',
  crew3: 'CREW',
  hr: 'HR_LEAD',
  aud: 'AUDITOR',
};
const NAME_OF: Record<string, string> = {
  rm: 'Dr. A. Vance',
  dir: 'Rachel Hughes',
  fleet: 'Dave Evans',
  gov: 'Dr. Helen Price',
  disp: 'Priya Nair',
  crew: 'Alex Morgan',
  crew2: 'Lee Davies',
  crew3: 'Tom Hughes',
  hr: 'Sarah Jenkins',
  aud: 'J. Whitmore',
};
const tag = ORG.slice(0, 8);
const sub = (k: string) => `v36f-${tag}|${k}`;
const londonToday = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 10);
const TODAY = londonToday();

async function call(method: string, url: string, who: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: sub(who) })}`,
      'x-org-id': ORG,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}
async function state(who = 'rm', today = TODAY): Promise<J> {
  const r = await call('GET', `/api/v1/v36/state?today=${today}`, who);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}
interface Ch {
  key: string;
  id: string;
  before: J | null;
  after: J | null;
}
async function sync(who: string, act: string, changes: Ch[]) {
  return call('POST', '/api/v1/v36/sync', who, { act, today: TODAY, changes });
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const nowT = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(11, 16);
const addM = (d: string, m: number) => {
  const [y, mo, dd] = d.split('-').map(Number) as [number, number, number];
  const t = y * 12 + mo - 1 + m;
  const last = new Date(Date.UTC(Math.floor(t / 12), (t % 12) + 1, 0)).getUTCDate();
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
};
const stamp = () => `${TODAY} ${nowT()}`;
const addD = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/** Same field names and value types as the v36 sample record (optional fields may be absent). */
function expectShape(rec: J, sample: J, path = '') {
  for (const k of Object.keys(sample)) {
    if (!(k in rec)) continue;
    const a = rec[k];
    const b = sample[k];
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== 'null' && tb !== 'null') expect(ta, `${path}${k}`).toBe(tb);
    if (ta === 'object' && tb === 'object') expectShape(a, b, `${path}${k}.`);
  }
  for (const k of Object.keys(rec))
    expect(Object.keys(sample).concat(OPTIONAL), `unexpected field ${path}${k}`).toContain(k);
}
const OPTIONAL = ['from', 'note', 'repair', 'sign', 'rts', 'back', 'off', 'notes', 'def', 'amend', 'pub', 'LOLER', 'prevExp', 'file', 'by', 'on', 'vby', 'von', 'rej', 'due', 'dueMi', 'last', 'lastMi'];

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
  const c = new pg.Client({ connectionString: urls.superuser });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    await c.query(`INSERT INTO organisation (id, name, sector_packs) VALUES ($1, $2, '{ambulance}')`, [
      ORG,
      `v36 fleet test ${tag}`,
    ]);
    await c.query(`INSERT INTO location (id, organisation_id, name, registered) VALUES ($1, $2, 'Watford', true)`, [
      LOC,
      ORG,
    ]);
    for (const k of Object.keys(ROLE_OF)) {
      const u = randomUUID();
      await c.query(
        `INSERT INTO app_user (id, idp_subject, email, display_name, status) VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [u, sub(k), `${k}.${tag}@example.test`, NAME_OF[k]],
      );
      await c.query(
        `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
         SELECT $1, $2, id, now() - interval '1 day' FROM role WHERE organisation_id IS NULL AND key = $3`,
        [ORG, u, ROLE_OF[k]],
      );
    }
    // The organisation has adopted the vehicle document requirements (MOT, insurance, tax).
    await c.query(`CREATE TEMP TABLE tm AS SELECT id AS old, uuid_generate_v7() AS new
                     FROM requirement_template WHERE organisation_id = $1 AND code LIKE 'AMB-VEH-%'`, [
      SEED_IDS.orgExample,
    ]);
    await c.query(
      `INSERT INTO requirement_template
       SELECT (jsonb_populate_record(NULL::requirement_template,
                 to_jsonb(t) || jsonb_build_object('id', tm.new, 'organisation_id', $1::uuid))).*
         FROM requirement_template t JOIN tm ON tm.old = t.id`,
      [ORG],
    );
    await c.query(
      `INSERT INTO requirement_template_version
       SELECT (jsonb_populate_record(NULL::requirement_template_version,
                 to_jsonb(v) || jsonb_build_object('id', uuid_generate_v7(), 'organisation_id', $1::uuid,
                                                   'template_id', tm.new))).*
         FROM requirement_template_version v JOIN tm ON tm.old = v.template_id
        WHERE v.status = 'EFFECTIVE'`,
      [ORG],
    );
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});
async function sql<T>(q: string, p: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: urls.superuser });
  await c.connect();
  try {
    return (await c.query(q, p)).rows as T[];
  } finally {
    await c.end();
  }
}
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('v36 fleet: import of the saved copy', () => {
  it('says which fleet collections still need importing, then moves them in without loss', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'rm');
    for (const k of ['cl', 'checks', 'def', 'veh']) expect(st.body.needsImport).toContain(k);
    expect(st.body.connected.map((x: J) => x.key)).toEqual(expect.arrayContaining(['cl', 'checks', 'def', 'veh']));
    // The read-only auditor never imports.
    expect((await call('POST', '/api/v1/v36/import', 'aud', { today: '2026-11-17', data: S36 })).status).toBe(403);
    const r = await call('POST', '/api/v1/v36/import', 'rm', { today: '2026-11-17', data: S36 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.imported).toEqual(expect.arrayContaining(['cl', 'checks', 'def', 'veh']));
    // Second time: nothing left to import.
    const again = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'rm');
    for (const k of ['cl', 'checks', 'def', 'veh']) expect(again.body.needsImport).not.toContain(k);
  });

  it('cl loads exactly as v36 saved it', async () => {
    const d = await state('rm', '2026-11-17');
    expect(d.cl.map((c: J) => ({ ...c }))).toEqual(
      S36.cl.map(({ add: _a, ...c }: J) => c), // `add` is a note v36 never reads
    );
  });

  it('veh loads in v36 shape with the same values', async () => {
    const d = await state('rm', '2026-11-17');
    expect(Object.keys(d.veh).sort()).toEqual(Object.keys(S36.veh).sort());
    for (const [k, v] of Object.entries(S36.veh as Record<string, J>)) {
      const got = d.veh[k];
      expectShape(got, v);
      expect({ id: got.id, reg: got.reg, type: got.type, base: got.base, odo: got.odo, status: got.status }).toEqual({
        id: v.id,
        reg: v.reg,
        type: v.type,
        base: v.base,
        odo: v.odo,
        status: v.status,
      });
      expect(got.svc).toEqual(v.svc);
      for (const dk of ['MOT', 'INS', 'VED']) {
        const want = v.docs[dk];
        if (!want || want.s === 'na') continue; // N/A decisions are not imported (see open issues)
        expect(got.docs[dk], `${k} ${dk}`).toMatchObject(
          want.s === 'rcv'
            ? { s: 'rcv', exp: want.exp, by: want.by, file: want.file, prevExp: want.prevExp }
            : { s: 'ok', exp: want.exp, vby: want.vby },
        );
      }
    }
  });

  it('checks load in v36 shape with the same values', async () => {
    const d = await state('rm', '2026-11-17');
    const byId = new Map((d.checks as J[]).map((c) => [c.id, c]));
    for (const c of S36.checks as J[]) {
      const got = byId.get(c.id);
      expect(got, c.id).toBeTruthy();
      const { hist: _h, ...want } = c; // v36's own marker for its generated sample history
      expectShape(got!, want);
      expect(got).toEqual(want);
    }
  });

  it('def loads in v36 shape with the same values', async () => {
    const d = await state('rm', '2026-11-17');
    expect(Object.keys(d.def).sort()).toEqual(Object.keys(S36.def).sort());
    for (const [k, v] of Object.entries(S36.def as Record<string, J>)) {
      expectShape(d.def[k], v);
      expect(d.def[k]).toEqual(v);
    }
  });
});

describe('v36 fleet: S.cl check list versions', () => {
  it('clNew drafts the next version (Fleet Lead), one draft at a time; crew and auditor refused', async () => {
    let d = await state('fleet');
    // The imported v4 draft is waiting: a second draft is refused.
    const nv = Math.max(...d.cl.map((c: J) => c.v)) + 1;
    const cur = d.cl.filter((c: J) => c.state === 'Published').sort((a: J, b: J) => b.v - a.v)[0];
    const draft = { v: nv, state: 'Draft', by: 'Dave Evans', on: TODAY, items: [...cur.items, ['Spare fuses', 0]] };
    const twice = await sync('fleet', 'clNew', [{ key: 'cl', id: String(nv), before: null, after: draft }]);
    expect([twice.status, twice.body.detail]).toEqual([422, 'a draft is already waiting to be published']);
    // Publish the waiting v4 (governance may publish; the drafter may not).
    const v4 = d.cl.find((c: J) => c.state === 'Draft');
    const pubAfter = { ...clone(v4), state: 'Published', pub: 'Dr. Helen Price', on: TODAY };
    const retire = { ...clone(cur), state: 'Retired' };
    const changes = [
      { key: 'cl', id: String(cur.v), before: cur, after: retire },
      { key: 'cl', id: String(v4.v), before: v4, after: pubAfter },
    ];
    const self = await sync('fleet', 'clPub', changes);
    expect([self.status, self.body.detail]).toEqual([403, 'you drafted this version, so a second person must publish it']);
    expect((await sync('crew', 'clPub', changes)).status).toBe(403);
    expect((await sync('aud', 'clPub', changes)).status).toBe(403);
    const ok = await sync('gov', 'clPub', changes);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.cl.find((c: J) => c.v === v4.v)).toMatchObject({ state: 'Published', pub: 'Dr. Helen Price', on: TODAY });
    expect(ok.body.data.cl.find((c: J) => c.v === cur.v).state).toBe('Retired');
    // Now a new draft is possible; crew may not draft.
    d = await state('fleet');
    const nv2 = Math.max(...d.cl.map((c: J) => c.v)) + 1;
    const pub = d.cl.find((c: J) => c.state === 'Published');
    const draft2 = { v: nv2, state: 'Draft', by: 'Dave Evans', on: TODAY, items: [...pub.items, ['Spare fuses', 0]] };
    const ch = [{ key: 'cl', id: String(nv2), before: null, after: draft2 }];
    expect((await sync('crew', 'clNew', ch)).status).toBe(403);
    const made = await sync('fleet', 'clNew', ch);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.cl.find((c: J) => c.v === nv2)).toEqual(draft2);
    // Item codes are kept for unchanged items, so results stay comparable across versions.
    const items = await sql<{ version: number; items: J[] }>(
      `SELECT version, items FROM vdi_template WHERE organisation_id = $1 AND version = ANY($2) ORDER BY version`,
      [ORG, [pub.v, nv2]],
    );
    const [x, y] = items.map((t) => t.items.map((i) => i.code));
    expect(y!.slice(0, x!.length)).toEqual(x);
  });
});

describe('v36 fleet: S.checks daily checks and the defects they raise', () => {
  it('chkStart: a passed check (Fleet Lead), odometer kept; lower odometer and blocked vehicle refused', async () => {
    const d = await state('fleet');
    const cl = d.cl.filter((c: J) => c.state === 'Published').sort((a: J, b: J) => b.v - a.v)[0];
    const V = d.veh['AMB-01'];
    const res: J = {};
    cl.items.forEach((_: unknown, i: number) => (res[i] = 'Pass'));
    const check = { id: 'VDI-5523', veh: 'AMB-01', date: TODAY, time: nowT(), by: 'Dave Evans', v: cl.v, odo: V.odo + 40, res, out: 'Pass', notes: {} };
    const veh = { ...clone(V), odo: V.odo + 40 };
    const low = await sync('fleet', 'chkStart', [
      { key: 'checks', id: 'VDI-5523', before: null, after: { ...check, odo: V.odo - 1 } },
    ]);
    expect([low.status, low.body.detail]).toEqual([400, `Check the odometer – it is lower than the last reading (${V.odo.toLocaleString('en-GB')})`]);
    expect((await sync('disp', 'chkStart', [{ key: 'checks', id: 'VDI-5523', before: null, after: check }])).status).toBe(403);
    const blocked = await sync('fleet', 'chkStart', [
      { key: 'checks', id: 'VDI-5523', before: null, after: { ...check, veh: 'AMB-03' } },
    ]);
    expect([blocked.status, blocked.body.detail]).toEqual([422, 'AMB-03 is blocked; it cannot be checked into use']);
    const r = await sync('fleet', 'chkStart', [
      { key: 'veh', id: 'AMB-01', before: V, after: veh },
      { key: 'checks', id: 'VDI-5523', before: null, after: check },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = (r.body.data.checks as J[]).find((c) => c.veh === 'AMB-01' && c.date === TODAY);
    expect(got).toMatchObject({ by: 'Dave Evans', v: cl.v, odo: V.odo + 40, out: 'Pass', res });
    expect(got!.id).toBe('VDI-5523'); // numbering continues after the imported VDI-5522
    expect(r.body.data.veh['AMB-01'].odo).toBe(V.odo + 40);
  });

  it('phSubmit: a failed critical item raises a Critical stop-use defect, a non-critical one a Major', async () => {
    const d = await state('crew');
    const cl = d.cl.filter((c: J) => c.state === 'Published').sort((a: J, b: J) => b.v - a.v)[0];
    const V = d.veh['AMB-02'];
    const crit = cl.items.findIndex((i: J) => i[1] === 1);
    const minor = cl.items.findIndex((i: J) => i[1] === 0);
    const res: J = {};
    cl.items.forEach((_: unknown, i: number) => (res[i] = 'Pass'));
    res[crit] = 'Fail';
    res[minor] = 'Fail';
    const notes = { [crit]: 'Does not lock', [minor]: 'Small leak' };
    const id = 'VDI-5524';
    const check = { id, veh: 'AMB-02', date: TODAY, time: nowT(), by: 'Alex Morgan', v: cl.v, odo: V.odo + 5, res, out: 'Fail – critical', notes, def: 'DEF-083, DEF-084' };
    const defs = [crit, minor].map((i, n) => ({
      id: `DEF-08${3 + n}`,
      veh: 'AMB-02',
      sev: i === crit ? 'Critical' : 'Major',
      desc: `${cl.items[i][0]} – ${notes[i]}`,
      by: 'Alex Morgan',
      on: stamp(),
      from: id,
      stage: 'Reported',
      owner: 'Dave Evans',
      review: addD(TODAY, i === crit ? 2 : 7),
      stop: i === crit,
      photos: 0,
      note: '',
    }));
    const noNote = await sync('crew', 'phSubmit', [
      { key: 'checks', id, before: null, after: { ...check, notes: {} } },
    ]);
    expect([noNote.status, noNote.body.detail]).toEqual([400, 'Add a note for each failed item']);
    const r = await sync('crew', 'phSubmit', [
      { key: 'veh', id: 'AMB-02', before: V, after: { ...clone(V), odo: V.odo + 5 } },
      { key: 'checks', id, before: null, after: check },
      ...defs.map((x) => ({ key: 'def', id: x.id, before: null, after: x })),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = (r.body.data.checks as J[]).find((c) => c.veh === 'AMB-02' && c.date === TODAY)!;
    expect(got).toMatchObject({ out: 'Fail – critical', notes, res });
    const made = got.def.split(', ');
    expect(made).toHaveLength(2);
    for (const [n, code] of made.entries()) {
      const x = r.body.data.def[code];
      const { id: _i, on: _o, ...want } = defs[n]!;
      const { note: _n, ...rest } = want;
      expect(x).toMatchObject({ ...rest, from: got.id });
    }
    // A defect claiming to come from a check that was not just submitted is refused.
    const fake = { ...defs[0]!, id: 'DEF-099', from: 'VDI-1' };
    expect((await sync('crew', 'phDefect', [{ key: 'def', id: 'DEF-099', before: null, after: fake }])).status).toBe(422);
  });

  it('chkView: only the checker adds an amendment; the record itself never changes', async () => {
    const d = await state('crew');
    const c = (d.checks as J[]).find((x) => x.veh === 'AMB-02' && x.date === TODAY)!;
    const after = { ...clone(c), amend: [...(c.amend ?? []), { on: stamp(), by: 'Alex Morgan', t: 'Leak was coolant, not oil.' }] };
    const other = await sync('crew2', 'chkView', [{ key: 'checks', id: c.id, before: c, after }]);
    expect([other.status, other.body.detail]).toEqual([403, 'Only Alex Morgan can amend their own check.']);
    const edit = await sync('crew', 'chkView', [{ key: 'checks', id: c.id, before: c, after: { ...clone(c), odo: 1 } }]);
    expect(edit.status).toBe(422);
    const r = await sync('crew', 'chkView', [{ key: 'checks', id: c.id, before: c, after }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = (r.body.data.checks as J[]).find((x) => x.id === c.id)!;
    expect(got.amend.at(-1)).toMatchObject({ by: 'Alex Morgan', t: 'Leak was coolant, not oil.' });
    expect(got.odo).toBe(c.odo);
    // Imported amendments keep their text (VDI-5490).
    const old = (await state('rm', '2026-11-17')).checks.find((x: J) => x.id === 'VDI-5490');
    expect(old.amend).toEqual(S36.checks.find((x: J) => x.id === 'VDI-5490').amend);
  });
});

describe('v36 fleet: S.def defect board', () => {
  const raise = (veh: string, by: string, o: J = {}) => ({
    id: 'DEF-0NEW',
    veh,
    sev: 'Major',
    desc: 'Nearside mirror cracked',
    by,
    on: stamp(),
    from: null,
    stage: 'Reported',
    owner: 'Dave Evans',
    review: addD(TODAY, 7),
    stop: false,
    photos: 2,
    note: 'Glass loose',
    ...o,
  });
  let code = '';

  it('defNew: governance reports a defect with v36 owner, review date, photos and note; dispatcher refused', async () => {
    const x = raise('AMB-05', 'Dr. Helen Price');
    expect((await sync('disp', 'defNew', [{ key: 'def', id: x.id, before: null, after: x }])).status).toBe(403);
    expect((await sync('aud', 'defNew', [{ key: 'def', id: x.id, before: null, after: x }])).status).toBe(403);
    const r = await sync('gov', 'defNew', [{ key: 'def', id: x.id, before: null, after: x }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const made = Object.values(r.body.data.def as Record<string, J>).find((d) => d.desc === x.desc)!;
    code = made.id;
    expect(code).toMatch(/^DEF-\d{3}$/);
    const { id: _i, on: _o, from: _f, ...want } = x;
    expect(made).toMatchObject(want);
    expect(made.on.slice(0, 10)).toBe(TODAY);
  });

  it('phDefect: crew reports a Critical defect, which stops use', async () => {
    const x = raise('AMB-05', 'Alex Morgan', { sev: 'Critical', desc: 'Brake warning light on', stop: true, photos: 1, note: '', review: addD(TODAY, 2) });
    const r = await sync('crew', 'phDefect', [{ key: 'def', id: x.id, before: null, after: x }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const made = Object.values(r.body.data.def as Record<string, J>).find((d) => d.desc === x.desc)!;
    expect(made).toMatchObject({ sev: 'Critical', stop: true, stage: 'Reported', review: addD(TODAY, 2), photos: 1 });
    expect(made.note).toBeUndefined();
  });

  it('defStart → defSign → defBack → defSign → defRts, with v36 role and second-person rules', async () => {
    let d = (await state('fleet')).def[code];
    // defStart
    const s1 = { ...clone(d), stage: 'In repair', repair: { plan: 'Mirror glass ordered', by: 'Dave Evans', on: stamp() }, review: addD(TODAY, 3) };
    expect((await sync('crew', 'defStart', [{ key: 'def', id: code, before: d, after: s1 }])).status).toBe(403);
    let r = await sync('fleet', 'defStart', [{ key: 'def', id: code, before: d, after: s1 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def[code]).toMatchObject({ stage: 'In repair', review: addD(TODAY, 3), repair: { plan: 'Mirror glass ordered', by: 'Dave Evans' } });
    // defSign
    d = r.body.data.def[code];
    const s2 = { ...clone(d), stage: 'Signed off', sign: { work: 'Glass replaced and aligned', sheet: 'JS-9', by: 'Dave Evans', on: stamp() }, review: addD(TODAY, 1) };
    r = await sync('fleet', 'defSign', [{ key: 'def', id: code, before: d, after: s2 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def[code]).toMatchObject({ stage: 'Signed off', review: addD(TODAY, 1), sign: { work: 'Glass replaced and aligned', sheet: 'JS-9', by: 'Dave Evans' } });
    // defBack: managers only
    d = r.body.data.def[code];
    const s3 = clone(d);
    s3.stage = 'In repair';
    s3.back = { by: 'Dr. A. Vance', on: stamp(), why: 'Mirror still loose' };
    delete s3.sign;
    const fb = await sync('fleet', 'defBack', [{ key: 'def', id: code, before: d, after: s3 }]);
    expect([fb.status, fb.body.detail]).toEqual([403, 'only the Registered Manager or Director can reject a sign-off']);
    r = await sync('rm', 'defBack', [{ key: 'def', id: code, before: d, after: s3 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def[code].stage).toBe('In repair');
    expect(r.body.data.def[code].sign).toBeUndefined();
    expect(r.body.data.def[code].back).toMatchObject({ by: 'Dr. A. Vance', why: 'Mirror still loose' });
    // sign again (the director this time), then return to service
    d = r.body.data.def[code];
    const s4 = { ...clone(d), stage: 'Signed off', sign: { work: 'Bracket tightened', sheet: '', by: 'Rachel Hughes', on: stamp() }, review: addD(TODAY, 1) };
    r = await sync('dir', 'defSign', [{ key: 'def', id: code, before: d, after: s4 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def[code].sign).toMatchObject({ work: 'Bracket tightened', sheet: '', by: 'Rachel Hughes' });
    d = r.body.data.def[code];
    const s5 = { ...clone(d), stage: 'Returned to service', rts: { by: 'Rachel Hughes', on: stamp(), note: '' } };
    const own = await sync('dir', 'defRts', [{ key: 'def', id: code, before: d, after: s5 }]);
    expect([own.status, own.body.detail]).toEqual([403, 'you signed off this repair, so someone else must return it to service']);
    const fl = await sync('fleet', 'defRts', [{ key: 'def', id: code, before: d, after: s5 }]);
    expect([fl.status, fl.body.detail]).toEqual([403, 'only the Registered Manager or the Director (deputy) can return a vehicle to service']);
    r = await sync('rm', 'defRts', [{ key: 'def', id: code, before: d, after: { ...s5, rts: { by: 'Dr. A. Vance', on: stamp(), note: '' } } }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def[code]).toMatchObject({ stage: 'Returned to service', rts: { by: 'Dr. A. Vance', note: '' } });
  });

  it('defOwner: owner and review date change (Fleet Lead or manager); unknown owner refused', async () => {
    const d = (await state('fleet')).def['DEF-079'];
    const a = { ...clone(d), owner: 'Dr. A. Vance', review: addD(TODAY, 9) };
    expect((await sync('gov', 'defOwner', [{ key: 'def', id: 'DEF-079', before: d, after: a }])).status).toBe(403);
    const bad = await sync('fleet', 'defOwner', [{ key: 'def', id: 'DEF-079', before: d, after: { ...a, owner: 'Nobody Here' } }]);
    expect(bad.status).toBe(400);
    const r = await sync('fleet', 'defOwner', [{ key: 'def', id: 'DEF-079', before: d, after: a }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.def['DEF-079']).toMatchObject({ owner: 'Dr. A. Vance', review: addD(TODAY, 9) });
    // A reported defect's description is a record.
    const edit = await sync('fleet', 'defOwner', [{ key: 'def', id: 'DEF-079', before: r.body.data.def['DEF-079'], after: { ...r.body.data.def['DEF-079'], desc: 'changed' } }]);
    expect(edit.status).toBe(422);
  });
});

describe('v36 fleet: S.veh documents, service, odometer, off the road', () => {
  it('docUp → docVer (a second person) and docUp → docRej', async () => {
    let V = (await state('fleet')).veh['AMB-01'];
    const exp = addD(TODAY, 365);
    const up = (x: J) => ({ ...clone(x), docs: { ...clone(x.docs), MOT: { ...x.docs.MOT, prevExp: x.docs.MOT.exp, s: 'rcv', file: 'MOT_Renewal_AMB-01.pdf', exp, by: 'Dave Evans', on: TODAY } } });
    expect((await sync('gov', 'docUp', [{ key: 'veh', id: 'AMB-01', before: V, after: up(V) }])).status).toBe(403);
    let r = await sync('fleet', 'docUp', [{ key: 'veh', id: 'AMB-01', before: V, after: up(V) }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['AMB-01'].docs.MOT).toMatchObject({ s: 'rcv', exp, by: 'Dave Evans', file: 'MOT_Renewal_AMB-01.pdf', prevExp: V.docs.MOT.exp, on: TODAY });
    V = r.body.data.veh['AMB-01'];
    const ver = { ...clone(V), docs: { ...clone(V.docs), MOT: { ...V.docs.MOT, s: 'ok', vby: 'Dr. Helen Price', von: TODAY } } };
    delete ver.docs.MOT.prevExp;
    const self = await sync('fleet', 'docVer', [{ key: 'veh', id: 'AMB-01', before: V, after: ver }]);
    expect([self.status, self.body.detail]).toEqual([403, 'you uploaded this, so someone else must verify it']);
    expect((await sync('crew', 'docVer', [{ key: 'veh', id: 'AMB-01', before: V, after: ver }])).status).toBe(403);
    r = await sync('gov', 'docVer', [{ key: 'veh', id: 'AMB-01', before: V, after: ver }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['AMB-01'].docs.MOT).toMatchObject({ s: 'ok', exp, vby: 'Dr. Helen Price' });
    // docRej: back to the still-valid copy
    V = r.body.data.veh['AMB-01'];
    r = await sync('fleet', 'docUp', [{ key: 'veh', id: 'AMB-01', before: V, after: { ...clone(V), docs: { ...clone(V.docs), INS: { ...V.docs.INS, prevExp: V.docs.INS.exp, s: 'rcv', file: 'INS.pdf', exp, by: 'Dave Evans', on: TODAY } } } }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    V = r.body.data.veh['AMB-01'];
    const rej = { ...clone(V), docs: { ...clone(V.docs), INS: { ...V.docs.INS, s: 'ok', exp: V.docs.INS.prevExp, rej: 'Wrong policy number' } } };
    r = await sync('rm', 'docRej', [{ key: 'veh', id: 'AMB-01', before: V, after: rej }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['AMB-01'].docs.INS).toMatchObject({ s: 'ok', exp: V.docs.INS.prevExp, rej: 'Wrong policy number' });
  });

  it('svcRec, odoRec (crew too) and miRec; a lower reading is refused', async () => {
    let V = (await state('fleet')).veh['RRV-01'];
    const after = { ...clone(V), svc: { last: TODAY, lastMi: V.odo + 100, due: addM(TODAY, 6), dueMi: V.odo + 12100 }, odo: V.odo + 100 };
    expect((await sync('crew', 'svcRec', [{ key: 'veh', id: 'RRV-01', before: V, after }])).status).toBe(403);
    let r = await sync('fleet', 'svcRec', [{ key: 'veh', id: 'RRV-01', before: V, after }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const svc = r.body.data.veh['RRV-01'].svc;
    expect({ ...svc, due: undefined }).toEqual({ ...after.svc, due: undefined });
    // The next due date follows the plan's interval (6 months, give or take a day).
    expect(Math.abs(Date.parse(svc.due) - Date.parse(after.svc.due))).toBeLessThanOrEqual(86_400_000);
    expect(r.body.data.veh['RRV-01'].odo).toBe(V.odo + 100);
    V = r.body.data.veh['RRV-01'];
    r = await sync('crew', 'odoRec', [{ key: 'veh', id: 'RRV-01', before: V, after: { ...clone(V), odo: V.odo + 20 } }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['RRV-01'].odo).toBe(V.odo + 20);
    V = r.body.data.veh['RRV-01'];
    expect((await sync('crew', 'miRec', [{ key: 'veh', id: 'RRV-01', before: V, after: { ...clone(V), odo: V.odo + 5 } }])).status).toBe(403);
    const low = await sync('fleet', 'miRec', [{ key: 'veh', id: 'RRV-01', before: V, after: { ...clone(V), odo: V.odo - 5 } }]);
    expect(low.status).toBe(400);
    r = await sync('fleet', 'miRec', [{ key: 'veh', id: 'RRV-01', before: V, after: { ...clone(V), odo: V.odo + 5 } }]);
    expect(r.status).toBe(201);
    expect(r.body.data.veh['RRV-01'].odo).toBe(V.odo + 5);
  });

  it('offStart and offEnd: the Fleet Lead who took it off cannot return it; a manager can', async () => {
    let V = (await state('fleet')).veh['AMB-05'];
    const on = stamp();
    const off = { ...clone(V), off: { on, by: 'Dave Evans', reason: 'Clutch slipping' }, status: [...V.status, { on, by: 'Dave Evans', t: 'Taken off the road', why: 'Clutch slipping' }] };
    expect((await sync('disp', 'offStart', [{ key: 'veh', id: 'AMB-05', before: V, after: off }])).status).toBe(403);
    let r = await sync('fleet', 'offStart', [{ key: 'veh', id: 'AMB-05', before: V, after: off }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['AMB-05'].off).toMatchObject({ by: 'Dave Evans', reason: 'Clutch slipping' });
    expect(r.body.data.veh['AMB-05'].status.at(-1)).toMatchObject({ by: 'Dave Evans', t: 'Taken off the road', why: 'Clutch slipping' });
    V = r.body.data.veh['AMB-05'];
    const back = clone(V);
    back.status = [...V.status, { on: stamp(), by: 'Dave Evans', t: 'Returned to the road', why: '' }];
    delete back.off;
    const own = await sync('fleet', 'offEnd', [{ key: 'veh', id: 'AMB-05', before: V, after: back }]);
    expect([own.status, own.body.detail]).toEqual([403, 'you took it off the road, so a manager must return it']);
    back.status.at(-1).by = 'Dr. A. Vance';
    r = await sync('rm', 'offEnd', [{ key: 'veh', id: 'AMB-05', before: V, after: back }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.veh['AMB-05'].off).toBeUndefined();
    expect(r.body.data.veh['AMB-05'].status.at(-1)).toMatchObject({ by: 'Dr. A. Vance', t: 'Returned to the road', why: '' });
  });

  it('the read-only auditor sees every collection but changes nothing', async () => {
    const d = await state('aud');
    expect(Object.keys(d.veh).length).toBeGreaterThan(0);
    const V = d.veh['AMB-01'];
    expect((await sync('aud', 'odoRec', [{ key: 'veh', id: 'AMB-01', before: V, after: { ...V, odo: V.odo + 1 } }])).status).toBe(403);
  });
});

describe('v36 fleet: the shared demo organisation loads in v36 shape', () => {
  it('state for the seeded organisation has cl, checks, def and veh shaped like S.json', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/v36/state?today=${TODAY}`,
      headers: { authorization: `Bearer ${await sign({ sub: 'dev|crew' })}`, 'x-org-id': SEED_IDS.orgExample },
    });
    expect(res.statusCode).toBe(200);
    const d = JSON.parse(res.body).data as J;
    for (const v of Object.values(d.veh as Record<string, J>)) expectShape(v, S36.veh['AMB-01']);
    for (const c of d.cl as J[]) expectShape(c, S36.cl[0]);
    for (const c of d.checks as J[]) expectShape(c, S36.checks[0]);
    for (const x of Object.values(d.def as Record<string, J>)) expectShape(x, S36.def['DEF-082']);
  });
});

// ---- journeys, accidents, equipment, premises, oxygen, controlled drugs (part 2) ---------------
describe('v36 fleet: jobs, acc, eq, prem, o2, cd', () => {
  const FULL = JSON.parse(readFileSync('/tmp/v36run/S.json', 'utf8')) as J;
  const KEYS = ['jobs', 'acc', 'eq', 'prem', 'o2', 'cd'];
  const one = (who: string, act: string, key: string, id: string, before: J | null, after: J | null) =>
    sync(who, act, [{ key, id, before, after }]);
  const ok = (r: { status: number; body: J }) => expect(r.status, JSON.stringify(r.body)).toBe(201);
  const no = (r: { status: number; body: J }, re: RegExp) => {
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(String(r.body.detail)).toMatch(re);
  };

  it('moves the saved copy in and loads it back the same', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'rm');
    for (const k of KEYS) expect(st.body.needsImport).toContain(k);
    const data = Object.fromEntries(KEYS.map((k) => [k, FULL[k]]));
    const r = await call('POST', '/api/v1/v36/import', 'rm', { today: TODAY, data });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = r.body.data as J;
    const byId = (l: J[]) => [...l].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(byId(got.jobs)).toEqual(byId(FULL.jobs));
    for (const k of ['acc', 'eq', 'prem', 'cd']) expect(got[k], k).toEqual(FULL[k]);
    // o2 readings have no v36 id: each gets one so they can be told apart.
    expect(got.o2.map((x: J) => { const { id, ...rest } = x; expect(id).toMatch(/^O2-\d+$/); return rest; })).toEqual(FULL.o2);
    // Another day shows that day's journeys only.
    expect((await state('rm', addD(TODAY, 1))).jobs).toEqual([]);
  });

  it('jobs: jobNew (dispatch), allocation gates, jobMove (fleet), flag (offStart)', async () => {
    const j = { id: 'J-450', veh: null, time: '15:00', dur: 60, crew: null, pt: 'PT-4520', mob: 'Walking' };
    no(await one('crew', 'jobNew', 'jobs', j.id, null, j), /only the dispatcher or a manager can book journeys/);
    no(await one('disp', 'jobNew', 'jobs', j.id, null, { ...j, pt: 'Mrs Smith' }), /patient reference/);
    let r = await one('disp', 'jobNew', 'jobs', j.id, null, j);
    ok(r);
    expect(r.body.data.jobs.find((x: J) => x.id === 'J-450')).toEqual(j);
    // A vehicle off the road blocks the allocation; no override exists.
    await sql(`UPDATE vehicle SET off_road = true, off_road_reason = 'Test' WHERE organisation_id = $1 AND callsign = 'RRV-01'`, [ORG]);
    no(await one('disp', 'jobOpen', 'jobs', j.id, j, { ...j, veh: 'RRV-01', crew: 'ST-0042' }), /allocation refused – Vehicle off the road; no override exists/);
    await sql(`UPDATE vehicle SET off_road = false, off_road_reason = NULL WHERE organisation_id = $1 AND callsign = 'RRV-01'`, [ORG]);
    const free = (await sql<{ c: string }>(`SELECT callsign AS c FROM vehicle v WHERE organisation_id = $1 AND NOT off_road
      AND NOT EXISTS (SELECT 1 FROM defect d WHERE d.vehicle_id = v.id AND d.status IN ('OPEN', 'REPAIRING')
      AND (d.stop_use OR d.severity = 'CRITICAL')) ORDER BY callsign`, [ORG])).map((x) => x.c);
    expect(free.length).toBeGreaterThan(1);
    const a = { ...j, veh: free[0], crew: 'ST-0042', crew2: 'ST-0102' };
    no(await one('fleet', 'jobOpen', 'jobs', j.id, j, a), /only the dispatcher or a manager/);
    ok(await one('disp', 'jobOpen', 'jobs', j.id, j, a));
    // jobMove: the Fleet Lead may move a journey to another vehicle (and clear the flag).
    const flagged = { ...a, flag: 1 };
    no(await one('crew', 'offStart', 'jobs', j.id, a, flagged), /only the Fleet Lead or a manager/);
    ok(await one('fleet', 'offStart', 'jobs', j.id, a, flagged));
    const moved = { ...a, veh: free[1] };
    r = await one('fleet', 'jobMove', 'jobs', j.id, flagged, moved);
    ok(r);
    expect(r.body.data.jobs.find((x: J) => x.id === 'J-450')).toEqual(moved);
    no(await one('disp', 'jobOpen', 'jobs', j.id, moved, { ...moved, time: '16:00' }), /Only the allocation/);
    no(await one('disp', 'jobOpen', 'jobs', j.id, moved, null), /cannot be removed/);
  });

  it('acc: accNew (anyone not read-only), accRel by someone other than the reporting Fleet Lead', async () => {
    const x = { id: 'ACC-08', veh: 'AMB-01', on: TODAY, what: 'Wing mirror clipped', tp: 'None', police: '', photos: 3, ins: '', road: true, state: 'Awaiting repair', by: 'Dave Evans' };
    expect((await one('aud', 'accNew', 'acc', x.id, null, x)).status).toBe(403);
    let r = await one('fleet', 'accNew', 'acc', x.id, null, x);
    ok(r);
    expect(r.body.data.acc.find((y: J) => y.id === 'ACC-08')).toEqual(x);
    const rel = (by: string) => ({ ...x, ins: 'INS-CLM-1', road: true, state: 'Repaired', rep: { on: TODAY, by: 'Watford Fleet Repairs', rel: by } });
    no(await one('fleet', 'accRel', 'acc', x.id, x, rel('Dave Evans')), /you reported this accident/);
    no(await one('disp', 'accRel', 'acc', x.id, x, rel('Priya Nair')), /not allowed/);
    r = await one('rm', 'accRel', 'acc', x.id, x, rel('Dr. A. Vance'));
    ok(r);
  });

  it('eq: eqQ / eqRel, eqIns / eqVer (second person), eqBook', async () => {
    const e0 = ((await state()).eq as J[])[0]!;
    const q = { ...clone(e0), q: { why: 'Frayed strap', by: 'Dave Evans', on: TODAY } };
    no(await one('disp', 'eqQ', 'eq', e0.id, e0, q), /not allowed/);
    ok(await one('fleet', 'eqQ', 'eq', e0.id, e0, q));
    no(await one('fleet', 'eqRel', 'eq', e0.id, q, e0), /you quarantined it/);
    ok(await one('rm', 'eqRel', 'eq', e0.id, q, e0));
    const ins = clone(e0);
    ins.reg[0] = { ...ins.reg[0], prevDue: e0.reg[0].due, last: TODAY, due: addM(TODAY, ins.reg[0].mo), ev: { s: 'rcv', by: 'Dave Evans', file: 'cert.pdf' } };
    ok(await one('fleet', 'eqIns', 'eq', e0.id, e0, ins));
    const ver = clone(ins);
    ver.reg[0].ev = { ...ver.reg[0].ev, s: 'ok', vby: 'Dave Evans' };
    no(await one('fleet', 'eqVer', 'eq', e0.id, ins, ver), /you uploaded this certificate/);
    ver.reg[0].ev.vby = 'Dr. Helen Price';
    ok(await one('gov', 'eqVer', 'eq', e0.id, ins, ver));
    const book = clone(ver);
    book.reg[0].book = { ctr: 'LiftSafe Engineering Ltd', on: addD(TODAY, 7) };
    const r = await one('fleet', 'eqBook', 'eq', e0.id, ver, book);
    ok(r);
    expect(r.body.data.eq.find((y: J) => y.id === e0.id)).toEqual(book);
  });

  it('prem: prNew, prChk, prUp, prVer (governance or managers; verifier is someone else)', async () => {
    const p = { id: 'PR-09', area: 'Fire safety', item: 'Extinguisher check', freq: 30, last: TODAY, owner: 'Dr. Helen Price', ev: {} };
    no(await one('fleet', 'prNew', 'prem', p.id, null, p), /not allowed/);
    ok(await one('gov', 'prNew', 'prem', p.id, null, p));
    ok(await one('gov', 'prChk', 'prem', p.id, p, { ...p, last: addD(TODAY, -1) }));
    const p1 = { ...p, last: addD(TODAY, -1) };
    const up = { ...p1, ev: { s: 'rcv', by: 'Dr. Helen Price', file: 'PR-09_certificate.pdf' } };
    ok(await one('gov', 'prUp', 'prem', p.id, p1, up));
    no(await one('gov', 'prVer', 'prem', p.id, up, { ...up, ev: { ...up.ev, s: 'ok', vby: 'Dr. Helen Price' } }), /you uploaded this/);
    ok(await one('rm', 'prVer', 'prem', p.id, up, { ...up, ev: { ...up.ev, s: 'ok', vby: 'Dr. A. Vance' } }));
  });

  it('o2: o2Rec (governance or managers) for today; cd: cdChk witnessed by someone else', async () => {
    const o = { d: TODAY, temp: 14, full: 11, inuse: 4, empty: 3, sign: true, vent: true, by: 'Dr. Helen Price' };
    no(await one('crew', 'o2Rec', 'o2', 'undefined', null, { ...o, by: 'Alex Morgan' }), /not allowed/);
    const r = await one('gov', 'o2Rec', 'o2', 'undefined', null, o);
    ok(r);
    const got = (r.body.data.o2 as J[]).at(-1)!;
    expect(got).toEqual({ id: expect.stringMatching(/^O2-/), ...o });
    no(await one('gov', 'o2Rec', 'o2', got.id, got, { ...got, temp: 20 }), /cannot be changed/);
    const last = FULL.cd.at(-1) as J;
    const c = { id: 'CDR-90', on: TODAY, drug: last.drug, where: 'Station safe', bal: 10, exp: last.exp, by: 'Alex Morgan', wit: 'Alex Morgan' };
    no(await one('crew', 'cdChk', 'cd', c.id, null, c), /witness must be a different person/);
    no(await one('fleet', 'cdChk', 'cd', c.id, null, { ...c, by: 'Dave Evans' }), /not allowed/);
    ok(await one('crew', 'cdChk', 'cd', c.id, null, { ...c, wit: 'Dr. Helen Price' }));
  });
});

describe('v36 fleet: fjobs, med, dcEvery', () => {
  const FULL = JSON.parse(readFileSync('/tmp/v36run/S.json', 'utf8')) as J;
  const one = (who: string, act: string, key: string, id: string, before: unknown, after: unknown) =>
    sync(who, act, [{ key, id, before, after } as never]);
  const ok = (r: { status: number; body: J }) => expect(r.status, JSON.stringify(r.body)).toBe(201);
  const no = (r: { status: number; body: J }, re: RegExp) => {
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(String(r.body.detail)).toMatch(re);
  };

  it('moves the saved copy in and loads it back the same (later days, stock lists, deep clean interval)', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'rm');
    for (const k of ['fjobs', 'med', 'dcEvery']) expect(st.body.needsImport).toContain(k);
    expect(st.body.data.dcEvery).toBe(28);
    const data = { fjobs: FULL.fjobs, med: FULL.med, dcEvery: FULL.dcEvery };
    const r = await call('POST', '/api/v1/v36/import', 'rm', { today: TODAY, data });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = r.body.data as J;
    const later = Object.fromEntries(Object.entries(FULL.fjobs as J).filter(([d]) => d > TODAY));
    const byId = (l: J[]) => [...l].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(Object.keys(got.fjobs).sort()).toEqual(Object.keys(later).sort());
    for (const d of Object.keys(later)) expect(byId(got.fjobs[d]), d).toEqual(byId(later[d]));
    expect(got.med).toEqual(FULL.med);
    expect(got.dcEvery).toBe(FULL.dcEvery);
    // A saved day that is today now is today's journeys (as v36's time machine rolls it in).
    const todays = (FULL.fjobs as J)[TODAY] as J[] | undefined;
    if (todays) for (const j of todays) expect(got.jobs.map((x: J) => x.id)).toContain(j.id);
  });

  it('fjobs: jobNew for a later day (dispatch); wkMove (dispatch or manager), blocked vehicle refused for tomorrow', async () => {
    const d1 = addD(TODAY, 1);
    const d3 = addD(TODAY, 3);
    const book = async (day: string, id: string) => {
      const before = clone(((await state()).fjobs[day] ?? []) as J[]);
      const j = { id, veh: null, time: '15:00', dur: 60, crew: null, pt: 'PT-4590', mob: 'Walking' };
      no(await one('crew', 'jobNew', 'fjobs', day, before.length ? before : null, [...before, j]), /only the dispatcher or a manager can book journeys/);
      const r = await one('disp', 'jobNew', 'fjobs', day, before.length ? before : null, [...before, j]);
      ok(r);
      const got = (r.body.data.fjobs[day] as J[]).find((x) => x.pt === 'PT-4590' && x.time === '15:00')!;
      expect(got).toMatchObject({ veh: null, dur: 60, crew: null, mob: 'Walking' });
      expect(got.id).toMatch(/^J-\d+$/);
      return got;
    };
    const a = await book(d1, 'J-777');
    const b = await book(d3, 'J-778');
    const free = (await sql<{ c: string }>(`SELECT callsign AS c FROM vehicle v WHERE organisation_id = $1 AND NOT off_road
      AND NOT EXISTS (SELECT 1 FROM defect d WHERE d.vehicle_id = v.id AND d.status IN ('OPEN', 'REPAIRING')
      AND (d.stop_use OR d.severity = 'CRITICAL')) ORDER BY callsign`, [ORG])).map((x) => x.c);
    const move = async (who: string, day: string, j: J, to: string, extra: J = {}) => {
      const list = clone((await state()).fjobs[day] as J[]);
      const after = list.map((x) => (x.id === j.id ? { ...x, veh: to, ...extra } : x));
      return one(who, 'wkMove', 'fjobs', day, list, after);
    };
    no(await move('fleet', d1, a, free[0]!), /only the dispatcher or a manager/);
    no(await move('disp', d1, a, free[0]!, { time: '16:00' }), /Only the vehicle/);
    // Off the road: refused for tomorrow, allowed for a later day (v36 checks today and tomorrow only).
    await sql(`UPDATE vehicle SET off_road = true, off_road_reason = 'Test' WHERE organisation_id = $1 AND callsign = $2`, [ORG, free[0]]);
    no(await move('disp', d1, a, free[0]!), /is blocked – Vehicle off the road/);
    ok(await move('disp', d3, b, free[0]!));
    await sql(`UPDATE vehicle SET off_road = false, off_road_reason = NULL WHERE organisation_id = $1 AND callsign = $2`, [ORG, free[0]]);
    const r = await move('rm', d1, a, free[1]!);
    ok(r);
    expect((r.body.data.fjobs[d1] as J[]).find((x) => x.id === a.id)!.veh).toBe(free[1]);
    // A planned journey is not removed from v36; the auditor changes nothing.
    const list = clone((await state()).fjobs[d3] as J[]);
    no(await one('disp', 'jobNew', 'fjobs', d3, list, list.filter((x) => x.id !== b.id)), /cannot be removed/);
    expect((await one('aud', 'wkMove', 'fjobs', d3, list, list.map((x) => ({ ...x, veh: free[1] })))).status).toBe(403);
    // A day that has come (time machine) is today's journeys already: nothing to do.
    ok(await one('disp', 'tmMove', 'fjobs', TODAY, [], null));
  });

  it('med: medChk (Fleet Lead or manager) records found = expected; anything else refused', async () => {
    const med = (await state()).med as Record<string, [string, number, number, string][]>;
    const [v, items] = Object.entries(med).find(([, l]) => l.some((m) => m[2] < m[1]))!;
    const after = items.map((m) => [m[0], m[1], m[1], m[3]]);
    no(await one('disp', 'medChk', 'med', v, items, after), /not allowed/);
    expect((await one('aud', 'medChk', 'med', v, items, after)).status).toBe(403);
    no(await one('fleet', 'medChk', 'med', v, items, items.map((m) => [m[0], m[1] + 1, m[2], m[3]])), /found = expected/);
    const r = await one('fleet', 'medChk', 'med', v, items, after);
    ok(r);
    expect(r.body.data.med[v]).toEqual(after);
    no(await one('rm', 'medChk', 'med', v, items, after), /changed by someone else/);
  });

  it('dcEvery: a fixed value no button changes', async () => {
    expect((await state()).dcEvery).toBe(28);
    expect((await one('rm', 'x', 'dcEvery', '_', 28, 14)).status).toBe(403);
  });
});
