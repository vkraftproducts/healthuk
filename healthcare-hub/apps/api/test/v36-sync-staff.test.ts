// v36 staff area connected to the real tables (step 2): every connected collection loads in v36's
// shape, moves in from a saved copy, and every v36 button that changes it is applied through the
// rules (with the refusals v36's people would meet).
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, completeChecks, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addD = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const S36 = JSON.parse(readFileSync('/tmp/v36run/S.json', 'utf8')) as J;

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: { sub?: string; org?: string; body?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': o.org ?? SEED_IDS.orgExample,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}
async function state(sub = 'dev|manager', org?: string) {
  const r = await call('GET', `/api/v1/v36/state?today=${TODAY}`, { sub, org });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data as J;
}
async function sync(sub: string, act: string, key: string, id: string, before: J | null, after: J | null) {
  return call('POST', '/api/v1/v36/sync', {
    sub,
    body: { act, today: TODAY, changes: [{ key, id, before, after }] },
  });
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
async function staffId(no: string): Promise<string> {
  const r = await db.withTenant({ orgId: SEED_IDS.orgExample, userId: SEED_IDS.orgExample } as never, (tx) =>
    tx.staff.findFirst({ where: { staffNo: no }, select: { id: true } }),
  );
  return r!.id;
}
/** Field names and types of a v36 record (shape compare with S.json). */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function expectShape(rec: J, sample: J, ignore: string[] = []) {
  for (const [k, v] of Object.entries(sample)) {
    if (ignore.includes(k) || v === undefined) continue;
    expect(k in rec, `missing ${k} in ${JSON.stringify(rec).slice(0, 200)}`).toBe(true);
    if (v !== null && rec[k] !== null) expect(typeOf(rec[k]), k).toBe(typeOf(v));
  }
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

// ================================================================================================
describe('people', () => {
  it('loads every person in v36 shape; read access follows the role', async () => {
    const s = await state();
    const p = s.people['ST-0042'];
    expectShape(p, S36.people['ST-0042'], ['approved', 'items']);
    expect(p).toMatchObject({ id: 'ST-0042', name: 'Alex Morgan', stage: 'Active' });
    expect(Array.isArray(p.restr)).toBe(true);
    expect(typeof p.items).toBe('object');
    expect(s.people['ST-0051'].stage).toBe('Checks in progress');
    // Crew see names only, except their own file.
    const crew = await state('dev|crew2');
    expect(crew.people['ST-0042'].items).toEqual({});
    expect(crew.people['ST-0042'].restr).toEqual([]);
    expect(crew.people['ST-0043'].name).toBe('Sam Taylor');
  });

  let p: J;
  const ID = 'ST-0300';
  it('newStarter adds a candidate (HR); crew and auditor are refused', async () => {
    const after = {
      id: ID,
      name: 'Casey Newman',
      job: 'Care assistant',
      stage: 'Candidate',
      start: addD(TODAY, 21),
      contract: 'Permanent',
      lm: 'Hana Rowe',
      restr: [],
      items: {},
    };
    expect((await sync('dev|crew', 'newStarter', 'people', ID, null, after)).status).toBe(403);
    expect((await sync('dev|auditor', 'newStarter', 'people', ID, null, after)).status).toBe(403);
    const r = await sync('dev|hr', 'newStarter', 'people', ID, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p).toMatchObject({
      id: ID,
      name: 'Casey Newman',
      job: 'Care assistant',
      stage: 'Candidate',
      start: after.start,
      contract: 'Permanent',
      lm: 'Hana Rowe',
      restr: [],
      items: {},
    });
  });

  it('startChecks creates the role checks and sends the portal requests', async () => {
    const after = clone(p);
    after.stage = 'Checks in progress';
    after.stageOn = TODAY;
    after.lm = 'Manager';
    after.items = {
      ID: { s: 'req', req: TODAY, due: addD(TODAY, 5), chase: [], note: 'Candidate portal link sent' },
    };
    const r = await sync('dev|hr', 'startChecks', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Checks in progress');
    expect(p.stageOn).toBe(TODAY);
    expect(p.lm).toBe('Manager');
    expect(p.items.ID).toEqual({
      s: 'req',
      req: TODAY,
      due: addD(TODAY, 5),
      chase: [],
      note: 'Candidate portal link sent',
    });
    expect(p.items.BLS).toEqual({ s: 'none' });
  });

  it('itChase, itUp, itRej, itUp, itVer and itCom on one check', async () => {
    let after = clone(p);
    after.items.ID = { ...after.items.ID, chase: [TODAY], due: addD(TODAY, 3), note: 'Phoned' };
    let r = await sync('dev|hr', 'itChase', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.ID).toMatchObject({ s: 'req', chase: [TODAY], due: addD(TODAY, 3), note: 'Phoned' });
    // Crew cannot record a document for someone else.
    after = clone(p);
    after.items.ID = { s: 'rcv', by: 'Alex Morgan', rcv: TODAY, file: 'Passport.pdf', exp: '2031-01-01', note: '' };
    expect((await sync('dev|crew', 'itUp', 'people', ID, p, after)).status).toBe(403);
    r = await sync('dev|hr', 'itUp', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.ID).toMatchObject({ s: 'rcv', by: 'Hana Rowe', rcv: TODAY, file: 'Passport.pdf', exp: '2031-01-01' });
    // HR uploaded it, so HR cannot verify it.
    after = clone(p);
    after.items.ID = { ...after.items.ID, s: 'ok', vby: 'Hana Rowe', von: TODAY };
    expect((await sync('dev|hr', 'itVer', 'people', ID, p, after)).status).toBe(403);
    // Reject, with a re-upload date.
    after = clone(p);
    after.items.ID = { ...after.items.ID, s: 'rej', rej: { why: 'Copy unreadable', by: 'Manager', on: TODAY }, due: addD(TODAY, 5) };
    r = await sync('dev|manager', 'itRej', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.ID).toMatchObject({ s: 'rej', rej: { why: 'Copy unreadable', by: 'Manager', on: TODAY }, due: addD(TODAY, 5) });
    after = clone(p);
    after.items.ID = { s: 'rcv', by: 'Hana Rowe', rcv: TODAY, file: 'Passport_v2.pdf', exp: '2031-01-01', note: 'Clear copy' };
    r = await sync('dev|hr', 'itUp', 'people', ID, p, after);
    p = r.body.data.people[ID];
    expect(p.items.ID).toMatchObject({ s: 'rcv', file: 'Passport_v2.pdf', note: 'Clear copy' });
    after = clone(p);
    after.items.ID = { ...after.items.ID, s: 'ok', vby: 'Manager', von: TODAY, exp: '2031-01-01', vnote: 'Seen original' };
    r = await sync('dev|manager', 'itVer', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.ID).toMatchObject({ s: 'ok', by: 'Hana Rowe', vby: 'Manager', von: TODAY, exp: '2031-01-01', vnote: 'Seen original', file: 'Passport_v2.pdf' });
    // Comment (anyone who works on the file).
    after = clone(p);
    after.items.ID.com = [{ by: 'Manager', on: `${TODAY} 10:00`, t: 'Checked against DVLA too' }];
    r = await sync('dev|manager', 'itCom', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.ID.com).toHaveLength(1);
    expect(p.items.ID.com[0]).toMatchObject({ by: 'Manager', t: 'Checked against DVLA too' });
    // The auditor reads, never writes.
    expect((await sync('dev|auditor', 'itCom', 'people', ID, p, after)).status).toBe(403);
  });

  it('itReq on a fresh check', async () => {
    const after = clone(p);
    after.items.BLS = { s: 'req', req: TODAY, due: addD(TODAY, 7), chase: [], note: 'Booked on course' };
    const r = await sync('dev|hr', 'itReq', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.items.BLS).toEqual({ s: 'req', req: TODAY, due: addD(TODAY, 7), chase: [], note: 'Booked on course' });
  });

  it('submitFile is refused while checks are open; then submit, return, submit, approve, markActive', async () => {
    let after = clone(p);
    after.stage = 'Ready for review';
    after.submitted = { by: 'Hana Rowe', on: `${TODAY} 10:00`, note: 'All good' };
    let r = await sync('dev|hr', 'submitFile', 'people', ID, p, after);
    expect(r.status).toBe(422);
    await completeChecks(app as never, SEED_IDS.orgExample, await staffId(ID), ['CARE_ASSISTANT']);
    p = (await state()).people[ID];
    after = clone(p);
    after.stage = 'Ready for review';
    after.submitted = { by: 'Hana Rowe', on: `${TODAY} 10:00`, note: 'All good' };
    r = await sync('dev|hr', 'submitFile', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Ready for review');
    expect(p.submitted).toMatchObject({ by: 'Hana Rowe', note: 'All good' });
    // returnFile (manager).
    after = clone(p);
    after.stage = 'Checks in progress';
    after.returned = { by: 'Manager', on: `${TODAY} 11:00`, why: 'Second reference please' };
    r = await sync('dev|manager', 'returnFile', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Checks in progress');
    expect(p.returned).toMatchObject({ by: 'Manager', why: 'Second reference please' });
    after = clone(p);
    after.stage = 'Ready for review';
    after.submitted = { by: 'Hana Rowe', on: `${TODAY} 12:00`, note: 'Reference added' };
    delete after.returned;
    r = await sync('dev|hr', 'submitFile', 'people', ID, p, after);
    p = r.body.data.people[ID];
    expect(p.returned).toBeUndefined();
    // approve: the manager verified every check, so the director approves.
    after = clone(p);
    after.stage = 'Approved for role';
    after.approved = { by: 'Manager', on: `${TODAY} 13:00`, role: 'Care assistant', note: 'File complete', restr: 'Observed practice only' };
    after.restr = [{ id: 'R-1', t: 'Observed practice only', by: 'Manager', on: `${TODAY} 13:00`, until: addD(TODAY, 90), reason: 'Set at approval' }];
    r = await sync('dev|manager', 'approve', 'people', ID, p, after);
    expect(r.status).toBe(422);
    after.approved.by = 'Dee Rector';
    r = await sync('dev|director', 'approve', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Approved for role');
    expect(p.approved).toMatchObject({ by: 'Dee Rector', role: 'Care assistant', note: 'File complete', restr: 'Observed practice only' });
    expect(p.restr[0]).toMatchObject({ t: 'Observed practice only', until: addD(TODAY, 90), reason: 'Set at approval', by: 'Dee Rector' });
    after = clone(p);
    after.stage = 'Active';
    r = await sync('dev|hr', 'markActive', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Active');
  });

  it('restrict, endRestr, suspend and unsuspend', async () => {
    let after = clone(p);
    after.restr.push({ id: 'R-101', t: 'No lone working', until: addD(TODAY, 14), reason: 'Concern raised', by: 'Hana Rowe', on: `${TODAY} 09:00` });
    expect((await sync('dev|crew', 'restrict', 'people', ID, p, after)).status).toBe(403);
    let r = await sync('dev|hr', 'restrict', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    const nl = p.restr.find((x: J) => x.t === 'No lone working');
    expect(nl).toMatchObject({ until: addD(TODAY, 14), reason: 'Concern raised', by: 'Hana Rowe' });
    after = clone(p);
    after.restr.find((x: J) => x.id === nl.id).ended = { by: 'Hana Rowe', on: `${TODAY} 10:00` };
    r = await sync('dev|hr', 'endRestr', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.restr.find((x: J) => x.id === nl.id).ended).toMatchObject({ by: 'Hana Rowe' });
    after = clone(p);
    after.stage = 'Suspended';
    after.susp = { by: 'Manager', on: `${TODAY} 11:00`, why: 'Investigation' };
    r = await sync('dev|manager', 'suspend', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    p = r.body.data.people[ID];
    expect(p.stage).toBe('Suspended');
    expect(p.susp).toMatchObject({ by: 'Manager', why: 'Investigation' });
    after = clone(p);
    after.stage = 'Active';
    r = await sync('dev|manager', 'unsuspend', 'people', ID, p, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.people[ID].stage).toBe('Active');
    p = r.body.data.people[ID];
  });

  it('removing a person is refused', async () => {
    expect((await sync('dev|hr', 'impUndo', 'people', ID, p, null)).status).toBe(422);
  });
});

// ================================================================================================
const byId = (list: J[], id: string) => list.find((r) => r.id === id);
const newest = (list: J[], before: J[]) => list.find((r) => !before.some((b) => b.id === r.id));

describe('registers', () => {
  it('every staff collection is in the state, empty for people who may not read it', async () => {
    const s = await state();
    for (const k of ['people', 'acct', 'rev', 'sick', 'leave', 'agency', 'lic', 'corr', 'sup', 'tplan', 'sg', 'optOut', 'supRule', 'stageT'])
      expect(k in s, k).toBe(true);
    expect(s.supRule).toEqual(S36.supRule);
    expect(s.stageT).toEqual(S36.stageT);
    const crew = await state('dev|crew');
    expect(crew.acct).toEqual([]);
    expect(crew.agency).toEqual([]);
    expect(crew.sg).toEqual([]);
  });

  it('rev: revNew, then revRec (the next review is scheduled by the server, not duplicated)', async () => {
    const s0 = (await state()).rev as J[];
    const after = { id: 'REV-99', pid: 'ST-0043', type: 'Probation – 3 months', due: addD(TODAY, 30), state: 'Due' };
    expect((await sync('dev|crew', 'revNew', 'rev', after.id, null, after)).status).toBe(403);
    let r = await sync('dev|hr', 'revNew', 'rev', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const made = newest(r.body.data.rev, s0)!;
    expectShape(made, S36.rev[0]);
    expect(made).toMatchObject({ pid: 'ST-0043', type: 'Probation – 3 months', due: addD(TODAY, 30), state: 'Due' });
    expect(made.id).toMatch(/^REV-\d+$/);
    const done = { ...made, state: 'Done', on: TODAY, by: 'Manager', out: 'Passed' };
    const follow = { id: 'REV-120', pid: 'ST-0043', type: 'Probation – 6 months', due: addD(TODAY, 91), state: 'Not started' };
    r = await call('POST', '/api/v1/v36/sync', {
      sub: 'dev|hr',
      body: { act: 'revRec', today: TODAY, changes: [
        { key: 'rev', id: made.id, before: made, after: done },
        { key: 'rev', id: follow.id, before: null, after: follow },
      ] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = r.body.data.rev as J[];
    expect(byId(list, made.id)).toMatchObject({ state: 'Done', on: TODAY, by: 'Manager', out: 'Passed' });
    const sixes = list.filter((x) => x.pid === 'ST-0043' && x.type === 'Probation – 6 months');
    expect(sixes).toHaveLength(1);
    expect(byId(list, 'REV-120')).toBeUndefined();
  });

  it('sick: absNew (off-sick restriction made once) and absRtw with a phased return', async () => {
    const s0 = (await state()).sick as J[];
    const after = { id: 'ABS-90', pid: 'ST-0043', from: addD(TODAY, -2), to: null, cat: 'Respiratory', rtw: null };
    expect((await sync('dev|crew', 'absNew', 'sick', after.id, null, after)).status).toBe(403);
    let r = await call('POST', '/api/v1/v36/sync', {
      sub: 'dev|hr',
      body: { act: 'absNew', today: TODAY, changes: [{ key: 'sick', id: after.id, before: null, after }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = newest(r.body.data.sick, s0)!;
    expectShape(a, S36.sick[1]);
    expect(a).toMatchObject({ pid: 'ST-0043', from: addD(TODAY, -2), to: null, cat: 'Respiratory', rtw: null });
    let p = (await state()).people['ST-0043'];
    expect(p.restr.filter((x: J) => x.abs === a.id)).toHaveLength(1);
    const back = { ...a, to: TODAY, rtw: { on: TODAY, by: 'Manager', phased: true, note: 'No lifting over 25 kg for 2 weeks' } };
    r = await sync('dev|hr', 'absRtw', 'sick', a.id, a, back);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(byId(r.body.data.sick, a.id)).toMatchObject({
      to: addD(TODAY, -1),
      rtw: { on: TODAY, by: 'Manager', phased: true, note: 'No lifting over 25 kg for 2 weeks' },
    });
    p = (await state()).people['ST-0043'];
    expect(p.restr.find((x: J) => x.abs === a.id).ended).toBeTruthy();
    expect(p.restr.some((x: J) => x.t === 'Phased return: No lifting over 25 kg for 2 weeks')).toBe(true);
  });

  it('agency: agNew, agVer (someone else), agInd, agId', async () => {
    const s0 = (await state()).agency as J[];
    const after = { id: 'AG-09', name: 'Kofi Test', agency: 'Swift Medical Staffing', job: 'Driver', conf: { on: TODAY, by: 'Hana Rowe', exp: addD(TODAY, 180), items: 'DBS, right to work' }, ind: false, idOnArrival: false };
    let r = await sync('dev|hr', 'agNew', 'agency', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    let a = newest(r.body.data.agency, s0)!;
    expectShape(a, S36.agency[1]);
    expect(a.id).toMatch(/^AG-\d{2}$/);
    expect(a).toMatchObject({ name: 'Kofi Test', job: 'Driver', state: 'Agency confirmation awaiting verification' });
    const ver = { ...a, conf: { ...a.conf, vby: 'Hana Rowe' } };
    expect((await sync('dev|hr', 'agVer', 'agency', a.id, a, ver)).status).toBe(409);
    r = await sync('dev|manager', 'agVer', 'agency', a.id, a, ver);
    a = byId(r.body.data.agency, a.id)!;
    expect(a.conf.vby).toBe('Manager');
    r = await sync('dev|hr', 'agInd', 'agency', a.id, a, { ...a, ind: true });
    a = byId(r.body.data.agency, a.id)!;
    r = await sync('dev|hr', 'agId', 'agency', a.id, a, { ...a, idOnArrival: true });
    a = byId(r.body.data.agency, a.id)!;
    expect(a).toMatchObject({ ind: true, idOnArrival: true, state: 'Cleared' });
  });

  it('lic: dvRec records a DVLA check; HCPC registration', async () => {
    const after = { dvla: { code: 'Ab 1c De 2f', on: TODAY, points: 3, cats: 'B, C1', next: addD(TODAY, 182) } };
    expect((await sync('dev|crew', 'dvRec', 'lic', 'ST-0042', null, after)).status).toBe(403);
    let r = await sync('dev|hr', 'dvRec', 'lic', 'ST-0042', null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.lic['ST-0042']).toEqual(after);
    expectShape(r.body.data.lic['ST-0042'].dvla, S36.lic['ST-0042'].dvla);
    const withH = { ...after, hcpc: { no: 'PA123456', on: TODAY, exp: addD(TODAY, 700) } };
    r = await sync('dev|hr', 'dvRec', 'lic', 'ST-0042', after, withH);
    expect(r.body.data.lic['ST-0042']).toEqual(withH);
  });

  it('corr: myCorr (crew), corrOk and corrNo (HR)', async () => {
    const after = { id: 'COR-50', who: 'ST-0042', what: 'Phone number', should: '07700 900 999', why: 'New phone', state: 'Waiting for HR', on: `${TODAY} 09:00` };
    expect((await sync('dev|hr', 'myCorr', 'corr', after.id, null, after)).status).toBe(404);
    let r = await sync('dev|crew', 'myCorr', 'corr', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = (r.body.data.corr as J[]).find((x) => x.should === '07700 900 999')!;
    expectShape(c, S36.corr[0]);
    expect(c.id).toMatch(/^COR-\d{2}$/);
    expect(c).toMatchObject({ who: 'ST-0042', what: 'Phone number', state: 'Waiting for HR' });
    expect((await sync('dev|crew', 'corrOk', 'corr', c.id, c, { ...c, state: 'Accepted' })).status).toBe(403);
    r = await sync('dev|hr', 'corrOk', 'corr', c.id, c, { ...c, state: 'Accepted', by: 'Hana Rowe' });
    expect(byId(r.body.data.corr, c.id)).toMatchObject({ state: 'Accepted', by: 'Hana Rowe' });
    r = await sync('dev|crew', 'myCorr', 'corr', 'COR-51', null, { ...after, id: 'COR-51', should: 'Flat 2', what: 'Address' });
    const d = (r.body.data.corr as J[]).find((x) => x.should === 'Flat 2')!;
    r = await sync('dev|hr', 'corrNo', 'corr', d.id, d, { ...d, state: 'Declined', note: 'Send proof', by: 'Hana Rowe' });
    expect(byId(r.body.data.corr, d.id)).toMatchObject({ state: 'Declined', note: 'Send proof' });
  });

  it('sup: supBook, supHeld (governance lead), myReqSup, supConfirm, supMissed', async () => {
    let s0 = (await state()).sup as J[];
    const book = { id: 'SUP-999', who: 'ST-0043', sup: 'Manager', type: 'Clinical supervision', date: addD(TODAY, 7), state: 'Booked', topics: 'Quarterly review' };
    expect((await sync('dev|crew', 'supBook', 'sup', book.id, null, book)).status).toBe(403);
    let r = await sync('dev|hr', 'supBook', 'sup', book.id, null, book);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    let b = newest(r.body.data.sup, s0)!;
    expectShape(b, S36.sup[1]);
    expect(b.id).toMatch(/^SUP-\d+$/);
    expect(b).toMatchObject({ who: 'ST-0043', sup: 'Manager', type: 'Clinical supervision', date: addD(TODAY, 7), state: 'Booked' });
    r = await sync('dev|governance', 'supHeld', 'sup', b.id, b, { ...b, state: 'Held', outcome: 'Discussed workload', rec: 'Gina Ode' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(byId(r.body.data.sup, b.id)).toMatchObject({ state: 'Held', outcome: 'Discussed workload', rec: 'Gina Ode' });
    // Crew request, HR confirms, the manager marks it missed.
    s0 = (await state('dev|crew')).sup;
    const req = { id: 'SUP-998', who: 'ST-0042', sup: '', type: 'One to one', date: addD(TODAY, 10), state: 'Requested', topics: 'Career plans', reqBy: 'Alex Morgan' };
    r = await sync('dev|crew', 'myReqSup', 'sup', req.id, null, req);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    b = newest(r.body.data.sup, s0)!;
    expect(b).toMatchObject({ who: 'ST-0042', sup: '', state: 'Requested', reqBy: 'Alex Morgan', topics: 'Career plans' });
    r = await sync('dev|hr', 'supConfirm', 'sup', b.id, b, { ...b, state: 'Booked', sup: 'Manager', date: addD(TODAY, 12) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    b = byId(r.body.data.sup, b.id)!;
    expect(b).toMatchObject({ state: 'Booked', sup: 'Manager', date: addD(TODAY, 12) });
    expect((await sync('dev|auditor', 'supMissed', 'sup', b.id, b, { ...b, state: 'Missed' })).status).toBe(403);
    r = await sync('dev|manager', 'supMissed', 'sup', b.id, b, { ...b, state: 'Missed' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(byId(r.body.data.sup, b.id)!.state).toBe('Missed');
  });

  it('tplan: tpNew and tpInv', async () => {
    const s0 = (await state()).tplan as J[];
    const after = { id: 'TP-09', course: 'BLS', date: addD(TODAY, 14), cap: 8, inv: [], state: 'Planned', by: 'Hana Rowe' };
    let r = await sync('dev|hr', 'tpNew', 'tplan', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = newest(r.body.data.tplan, s0)!;
    expectShape(t, S36.tplan[0]);
    expect(t.id).toMatch(/^TP-\d{2}$/);
    expect(t).toMatchObject({ course: 'BLS', date: addD(TODAY, 14), cap: 8, state: 'Planned', by: 'Hana Rowe' });
    r = await sync('dev|hr', 'tpInv', 'tplan', t.id, t, { ...t, inv: ['ST-0042'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('sg: sgNew and sgEnd (managers only)', async () => {
    const after = { id: 'SG-50', who: 'support@example.test', why: 'Investigate a slow report', hours: 2, from: `${TODAY} 10:00`, until: `${TODAY} 12:00`, by: 'Manager', state: 'Active' };
    expect((await sync('dev|hr', 'sgNew', 'sg', after.id, null, after)).status).toBe(403);
    let r = await sync('dev|manager', 'sgNew', 'sg', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const g = (r.body.data.sg as J[]).find((x) => x.state === 'Active')!;
    expectShape(g, S36.sg[0]);
    expect(g).toMatchObject({ who: 'support@example.test', hours: 2, by: 'Manager' });
    r = await sync('dev|manager', 'sgEnd', 'sg', g.id, g, { ...g, state: 'Ended early' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(byId(r.body.data.sg, g.id)!.state).toBe('Ended early');
  });

  it('optOut: set and cleared by HR', async () => {
    let r = await sync('dev|hr', 'optOut', 'optOut', 'ST-0043', null, true as never);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.optOut).toEqual({ 'ST-0043': true });
    r = await sync('dev|hr', 'optOut', 'optOut', 'ST-0043', true as never, null);
    expect(r.body.data.optOut).toEqual({});
  });

  it('acct: acOff and acOn (managers); acInv needs the hub screen', async () => {
    let list = (await state()).acct as J[];
    const a = list.find((x) => x.n === 'Sam Taylor')!;
    expectShape(a, S36.acct[0]);
    expect(a).toMatchObject({ role: 'Crew – Paramedic / Driver', state: 'Active', pid: 'ST-0043' });
    expect((await sync('dev|hr', 'acOff', 'acct', a.id, a, { ...a, state: 'Deactivated' })).status).toBe(403);
    let r = await sync('dev|manager', 'acOff', 'acct', a.id, a, { ...a, state: 'Deactivated' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const off = byId(r.body.data.acct, a.id)!;
    expect(off.state).toBe('Deactivated');
    r = await sync('dev|manager', 'acOn', 'acct', a.id, off, { ...off, state: 'Active' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(byId(r.body.data.acct, a.id)!.state).toBe('Active');
    list = r.body.data.acct;
    r = await sync('dev|manager', 'acInv', 'acct', 'USR-200', null, { id: 'USR-200', n: 'New Person', role: 'HR Lead', loc: 'Watford', state: 'Invited', mfa: true });
    expect(r.status).toBe(422);
  });

  it('leave: lvNew, lvTick (each item, access ends via move to leaver), lvDone', async () => {
    const s0 = (await state()).leave as J[];
    const after = { id: 'LV-09', pid: 'ST-0300', last: TODAY, why: 'Resigned – relocating', by: 'Hana Rowe', on: TODAY, ck: { acc: false, badge: false, kit: false, pay: false, exit: false } };
    expect((await sync('dev|crew', 'lvNew', 'leave', after.id, null, after)).status).toBe(403);
    let r = await sync('dev|hr', 'lvNew', 'leave', after.id, null, after);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    let l = newest(r.body.data.leave, s0)!;
    expectShape(l, S36.leave[0]);
    expect(l.id).toMatch(/^LV-\d{2}$/);
    expect(l).toMatchObject({ pid: 'ST-0300', last: TODAY, why: 'Resigned – relocating', by: 'Hana Rowe', on: TODAY });
    for (const k of ['pay', 'badge', 'kit', 'exit', 'acc']) {
      r = await sync('dev|hr', 'lvTick', 'leave', l.id, l, { ...l, ck: { ...l.ck, [k]: true } });
      expect(r.status, `${k} ${JSON.stringify(r.body)}`).toBe(201);
      l = byId(r.body.data.leave, l.id)!;
      expect(l.ck[k]).toBe(true);
    }
    r = await sync('dev|hr', 'lvDone', 'leave', l.id, l, { ...l, done: TODAY, keep: '2032-12-01' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    l = byId(r.body.data.leave, l.id)!;
    expect(l.done).toBe(TODAY);
    expect(l.keep).toBeTruthy();
    const p = (await state()).people['ST-0300'];
    expect(p).toMatchObject({ stage: 'Left', left: TODAY });
  });
});

// ================================================================================================
describe('import of a saved v36 copy', () => {
  const ORG = SEED_IDS.orgOther;
  it('moves the staff collections into an empty organisation and loads them back the same', async () => {
    // The other organisation has two of the checks set up (copied from the example organisation).
    const c = new pg.Client({ connectionString: urls.admin });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [SEED_IDS.orgExample]);
      const t = await c.query(`SELECT to_jsonb(t) AS t, to_jsonb(v) AS v FROM requirement_template t
        JOIN requirement_template_version v ON v.template_id = t.id
        WHERE t.organisation_id = $1 AND t.code IN ('AMB-STF-06', 'AMB-STF-05') AND v.status = 'EFFECTIVE'`, [SEED_IDS.orgExample]);
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
      for (const row of t.rows) {
        const tt = { ...row.t, id: undefined, organisation_id: ORG };
        const [tid] = (await c.query(`INSERT INTO requirement_template SELECT * FROM jsonb_populate_record(NULL::requirement_template, $1::jsonb || jsonb_build_object('id', uuid_generate_v7())) RETURNING id`, [JSON.stringify(tt)])).rows;
        await c.query(`INSERT INTO requirement_template_version SELECT * FROM jsonb_populate_record(NULL::requirement_template_version, $1::jsonb || jsonb_build_object('id', uuid_generate_v7()))`, [JSON.stringify({ ...row.v, id: undefined, organisation_id: ORG, template_id: tid.id, approved_by: null, created_by: null })]);
      }
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    const keys = ['people', 'rev', 'sick', 'leave', 'agency', 'lic', 'corr', 'sup', 'tplan', 'optOut'];
    const pre = await call('GET', `/api/v1/v36/state?today=${TODAY}`, { sub: 'dev|other-manager', org: ORG });
    for (const k of keys) expect(pre.body.needsImport, k).toContain(k);
    const data = Object.fromEntries(keys.map((k) => [k, S36[k]]));
    expect((await call('POST', '/api/v1/v36/import', { sub: 'dev|other-crew', org: ORG, body: { today: TODAY, data } })).status).toBe(403);
    const r = await call('POST', '/api/v1/v36/import', { sub: 'dev|other-manager', org: ORG, body: { today: TODAY, data } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.imported).toEqual(expect.arrayContaining(keys));
    const got = r.body.data as J;
    // People: everything v36 keeps, apart from names of people who are not members here (the
    // importing manager stands in for them as author/verifier) and checks the organisation lacks.
    const NOT_MEMBERS = new Set(['by', 'vby', 'rec']);
    const strip = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(strip);
      if (x && typeof x === 'object')
        return Object.fromEntries(Object.entries(x).filter(([k]) => !NOT_MEMBERS.has(k)).map(([k, v]) => [k, strip(v)]));
      return x;
    };
    for (const [id, p] of Object.entries(S36.people as Record<string, J>)) {
      const g = got.people[id];
      expect(g, id).toBeTruthy();
      // Segregation of duties (the database refuses a verification by the uploader): none of v36's
      // people is a member here, so the importing manager stands in for both uploader and verifier
      // and a verified document can only come back awaiting verification by someone else.
      const awaiting = (it: J) => {
        if (it.s !== 'ok') return it;
        const { von: _v, ...rest } = it; // eslint-disable-line @typescript-eslint/no-unused-vars
        return { ...rest, s: 'rcv' };
      };
      const want = strip({ ...p, items: Object.fromEntries(Object.entries(p.items as Record<string, J>).filter(([k]) => ['BLS', 'MH'].includes(k)).map(([k, it]) => [k, awaiting(it)])) }) as J;
      delete want.big;
      delete want.loc;
      expect(strip(g), id).toEqual(want);
    }
    expect(strip(got.rev)).toEqual(strip(S36.rev.map((x: J) => ({ ...x, state: x.state === 'Done' ? 'Done' : 'Due' }))));
    expect(strip(got.sick)).toEqual(expect.arrayContaining(strip(S36.sick) as J[]));
    expect(got.leave.map((x: J) => strip({ ...x, ck: { ...x.ck, acc: false } }))).toEqual(strip(S36.leave));
    // Recorded and verified by two non-members: the importer stands in for one of them only
    // (the verifier must be someone else), so the confirmation awaits verification again.
    expect(strip(got.agency)).toEqual(
      strip(S36.agency.map((x: J) => (x.conf?.vby ? { ...x, state: 'Agency confirmation awaiting verification' } : x))),
    );
    expect(got.lic).toEqual(S36.lic);
    expect(strip(got.corr)).toEqual(strip(S36.corr));
    expect(strip(got.tplan)).toEqual(strip(S36.tplan));
    expect(got.optOut).toEqual(S36.optOut);
    const sup = strip(S36.sup.filter((x: J) => x.state === 'Requested' || x.sup)) as J[];
    expect((strip(got.sup) as J[]).map((x) => x.id).sort()).toEqual(sup.map((x) => x.id).sort());
    // Nothing more to move in.
    const post = await call('GET', `/api/v1/v36/state?today=${TODAY}`, { sub: 'dev|other-manager', org: ORG });
    for (const k of keys.filter((k) => k !== 'optOut' || !Object.keys(S36.optOut).length)) expect(post.body.needsImport).not.toContain(k);
  });
});

// ---- shifts, swaps, exceptions, group sessions and rules (part 2) ------------------------------
describe('rota, swaps, rotaEx, sessions, rules, ruleProp', () => {
  const KEYS = ['rota', 'swaps', 'rotaEx', 'sessions', 'rules', 'ruleProp'];
  const many = (sub: string, act: string, changes: J[]) =>
    call('POST', '/api/v1/v36/sync', { sub, body: { act, today: TODAY, changes } });
  const byId = (l: J[]) => [...l].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ok = (r: { status: number; body: J }) => expect(r.status, JSON.stringify(r.body)).toBe(201);
  const no = (r: { status: number; body: J }, re: RegExp) => {
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(String(r.body.detail)).toMatch(re);
  };

  it('moves the saved copy in and loads it back the same', async () => {
    const pre = await call('GET', `/api/v1/v36/state?today=${TODAY}`);
    for (const k of KEYS) expect(pre.body.needsImport).toContain(k);
    const data = Object.fromEntries(KEYS.map((k) => [k, S36[k]]));
    const r = await call('POST', '/api/v1/v36/import', { body: { today: TODAY, data } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const got = r.body.data as J;
    expect(byId(got.rota)).toEqual(byId(S36.rota));
    expect(JSON.stringify(got.swaps)).toBe(JSON.stringify(S36.swaps));
    expect(JSON.stringify(got.sessions)).toBe(JSON.stringify(S36.sessions));
    expect(got.rules).toEqual(S36.rules);
    expect(got.rotaEx).toEqual([]);
    expect(got.ruleProp).toEqual([]);
    expectShape(got.rota[0], S36.rota[0]);
  });

  it('rota: shNew, shVeh, shCover, shDel with v36 roles; phStart, phBrk, phEnd from the crew phone', async () => {
    let s = (await state()).rota as J[];
    // The saved copy has shifts for these two people today; clear them first (shDel).
    for (const x of s.filter((x) => ['ST-0042', 'ST-0043'].includes(x.pid) && x.date >= TODAY && x.state === 'Planned'))
      ok(await sync('dev|hr', 'shDel', 'rota', x.id, x, null));
    const mk = (id: string, pid: string, date: string, veh: string | null) => ({
      id, pid, date, start: '07:00', end: '19:00', drive: 6, veh, pat: 'D', state: 'Planned', brk: 60,
    });
    const X = mk('SH-3900', 'ST-0042', TODAY, null);
    no(await sync('dev|crew', 'shNew', 'rota', X.id, null, X), /only HR, the dispatcher or a manager/);
    expect((await sync('dev|auditor', 'shNew', 'rota', X.id, null, X)).status).toBe(403);
    let r = await sync('dev|hr', 'shNew', 'rota', X.id, null, X);
    ok(r);
    expect(r.body.data.rota.find((x: J) => x.id === 'SH-3900')).toEqual(X);
    no(await sync('dev|hr', 'shNew', 'rota', 'SH-3901', null, { ...X, id: 'SH-3901' }), /already has a shift that day/);
    // Change vehicle, then give the shift to someone else, then back.
    r = await sync('dev|dispatcher', 'shVeh', 'rota', X.id, X, { ...X, veh: 'AMB-02' });
    ok(r);
    r = await sync('dev|hr', 'shVeh', 'rota', X.id, { ...X, veh: 'AMB-02' }, X);
    ok(r);
    no(await sync('dev|hr', 'shNew', 'rota', X.id, X, { ...X, start: '06:00' }), /Only the person or the vehicle/);
    // Crew start: only the person themselves, from the phone.
    const started = { ...X, state: 'Started', act: { in: '07:02', brks: 0 } };
    no(await sync('dev|hr', 'phStart', 'rota', X.id, X, started), /only crew can submit/);
    no(await sync('dev|crew2', 'phStart', 'rota', X.id, X, started), /not your shift/);
    ok(await sync('dev|crew', 'phStart', 'rota', X.id, X, started));
    const brk = { ...started, state: 'On break', act: { ...started.act, bs: '10:00' } };
    ok(await sync('dev|crew', 'phBrk', 'rota', X.id, started, brk));
    const back = { ...brk, state: 'Started', act: { ...brk.act, brks: 20 } };
    ok(await sync('dev|crew', 'phBrk', 'rota', X.id, brk, back));
    no(await sync('dev|crew', 'phEnd', 'rota', X.id, back, { ...back, state: 'Ended', act: { ...back.act, out: '19:00' } }), /handover/);
    const ended = { ...back, state: 'Ended', act: { ...back.act, out: '19:00', hand: 'Fuel full' } };
    r = await sync('dev|crew', 'phEnd', 'rota', X.id, back, ended);
    ok(r);
    expect(r.body.data.rota.find((x: J) => x.id === X.id)).toEqual(ended);
    no(await sync('dev|hr', 'shDel', 'rota', X.id, ended, null), /has started cannot be removed/);
    // A stale copy is refused.
    no(await sync('dev|hr', 'shVeh', 'rota', X.id, X, { ...X, veh: 'AMB-03' }), /changed by someone else/);
    // Gates: a shift on a vehicle with no daily check today cannot start.
    const V = mk('SH-3902', 'ST-0043', TODAY, 'AMB-03');
    ok(await sync('dev|hr', 'shNew', 'rota', V.id, null, V));
    no(await sync('dev|crew2', 'phStart', 'rota', V.id, V, { ...V, state: 'Started', act: { in: '07:00', brks: 0 } }), /shift start blocked – AMB-03/);
    ok(await sync('dev|hr', 'shDel', 'rota', V.id, V, null));
    s = (await state()).rota as J[];
    expect(s.some((x) => x.id === V.id)).toBe(false);
  });

  it('swaps: swNew (crew), swAgree (the colleague), swOk (dispatch) moves both shifts; swNo', async () => {
    const mk = (id: string, pid: string, date: string) => ({
      id, pid, date, start: '07:00', end: '19:00', drive: 6, veh: null, pat: 'D', state: 'Planned', brk: 60,
    });
    const A = mk('SH-3910', 'ST-0042', addD(TODAY, 10));
    const B = mk('SH-3911', 'ST-0043', addD(TODAY, 11));
    ok(await sync('dev|hr', 'shNew', 'rota', A.id, null, A));
    ok(await sync('dev|hr', 'shNew', 'rota', B.id, null, B));
    const w = { id: 'SW-05', from: 'ST-0042', to: 'ST-0043', shA: A.id, shB: B.id, on: TODAY, why: 'Wedding', state: 'Requested' };
    no(await sync('dev|hr', 'swNew', 'swaps', w.id, null, w), /crew phone/);
    no(await sync('dev|crew2', 'swNew', 'swaps', w.id, null, w), /your own shift/);
    let r = await sync('dev|crew', 'swNew', 'swaps', w.id, null, w);
    ok(r);
    expect(r.body.data.swaps.find((x: J) => x.id === 'SW-05')).toEqual(w);
    no(await sync('dev|dispatcher', 'swOk', 'swaps', w.id, w, { ...w, state: 'Approved' }), /colleague must agree first/);
    const agreed = { ...w, state: 'Colleague agreed', note: 'In the real app Sam Taylor agrees on their phone' };
    no(await sync('dev|crew', 'swAgree', 'swaps', w.id, w, agreed), /only the colleague/);
    ok(await sync('dev|crew2', 'swAgree', 'swaps', w.id, w, agreed));
    const appr = { ...agreed, state: 'Approved', note: 'Rules checked for both people' };
    no(await sync('dev|hr', 'swOk', 'swaps', w.id, agreed, appr), /only the dispatcher or a manager/);
    r = await many('dev|dispatcher', 'swOk', [
      { key: 'swaps', id: w.id, before: agreed, after: appr },
      { key: 'rota', id: A.id, before: A, after: { ...A, pid: 'ST-0043' } },
      { key: 'rota', id: B.id, before: B, after: { ...B, pid: 'ST-0042' } },
    ]);
    ok(r);
    expect(r.body.data.rota.find((x: J) => x.id === A.id).pid).toBe('ST-0043');
    expect(r.body.data.swaps.find((x: J) => x.id === w.id).state).toBe('Approved');
    // swNo
    const C = mk('SH-3912', 'ST-0042', addD(TODAY, 12));
    const D = mk('SH-3913', 'ST-0043', addD(TODAY, 13));
    ok(await sync('dev|hr', 'shNew', 'rota', C.id, null, C));
    ok(await sync('dev|hr', 'shNew', 'rota', D.id, null, D));
    const w2 = { ...w, id: 'SW-06', shA: C.id, shB: D.id };
    ok(await sync('dev|crew', 'swNew', 'swaps', w2.id, null, w2));
    const a2 = { ...w2, state: 'Colleague agreed' };
    ok(await sync('dev|dispatcher', 'swAgree', 'swaps', w2.id, w2, a2));
    ok(await sync('dev|manager', 'swNo', 'swaps', w2.id, a2, { ...a2, state: 'Refused' }));
  });

  it('rotaEx: shOpen exception by the Registered Manager or Director only', async () => {
    const e = { sh: 'SH-3910', by: 'Hana Rowe', why: 'Short-staffed', until: addD(TODAY, 10), on: TODAY };
    no(await sync('dev|hr', 'shOpen', 'rotaEx', 'undefined', null, e), /Only the Registered Manager or Director/);
    const m = { ...e, by: 'Manager' };
    const r = await sync('dev|manager', 'shOpen', 'rotaEx', 'undefined', null, m);
    ok(r);
    const got = r.body.data.rotaEx[0] as J;
    expect(got).toEqual({ id: expect.stringMatching(/^WTX-\d+$/), ...m });
  });

  it('sessions: sesNew (HR), sesVer by someone else, sesRej', async () => {
    const t = { id: 'TS-032', course: 'BLS', date: TODAY, prov: 'In-house – Hana Rowe', reg: 'REG-1', att: ['ST-0042', 'ST-0043'], by: 'Hana Rowe', on: `${TODAY} 10:00`, state: 'Awaiting verification' };
    no(await sync('dev|crew', 'sesNew', 'sessions', t.id, null, t), /only HR or the Registered Manager/);
    let r = await sync('dev|hr', 'sesNew', 'sessions', t.id, null, t);
    ok(r);
    expect(r.body.data.sessions.find((x: J) => x.id === 'TS-032')).toEqual(t);
    const v = { ...t, state: 'Verified', vby: 'Hana Rowe', von: `${TODAY} 11:00` };
    no(await sync('dev|hr', 'sesVer', 'sessions', t.id, t, v), /you recorded this session/);
    no(await sync('dev|dispatcher', 'sesVer', 'sessions', t.id, t, { ...v, vby: 'Dispatcher' }), /only HR, governance/);
    r = await sync('dev|governance', 'sesVer', 'sessions', t.id, t, { ...v, vby: 'Gina Ode' });
    ok(r);
    const t2 = { ...t, id: 'TS-033' };
    ok(await sync('dev|hr', 'tpAtt', 'sessions', t2.id, null, t2));
    no(await sync('dev|manager', 'sesRej', 'sessions', t2.id, t2, { ...t2, state: 'Rejected', why: '' }), /reason/);
    ok(await sync('dev|manager', 'sesRej', 'sessions', t2.id, t2, { ...t2, state: 'Rejected', why: 'Register unsigned' }));
  });

  it('rules: ruleCh proposes, ruleOk by a second person, ruleNo', async () => {
    const s0 = await state();
    const p = { k: 'restMode', old: 'warn', v: 'block', why: 'Fatigue incidents', by: 'Manager', on: TODAY, state: 'Proposed' };
    no(await sync('dev|hr', 'ruleCh', 'ruleProp', 'undefined', null, { ...p, by: 'Hana Rowe' }), /only the Registered Manager or Director/);
    let r = await sync('dev|manager', 'ruleCh', 'ruleProp', 'undefined', null, p);
    ok(r);
    const prop = r.body.data.ruleProp.find((x: J) => x.k === 'restMode') as J;
    expect(prop).toEqual({ id: expect.any(String), ...p });
    const rule = s0.rules.restMode as J;
    // The proposer cannot approve; a rule cannot change without a proposal.
    no(await many('dev|manager', 'ruleOk', [{ key: 'rules', id: 'restMode', before: rule, after: { v: 'block', by: 'Manager', on: TODAY } }]), /someone else must approve/);
    no(await many('dev|director', 'ruleOk', [{ key: 'rules', id: 'shiftH', before: s0.rules.shiftH, after: { v: 14, by: 'Dee Rector', on: TODAY } }]), /second person approves/);
    r = await many('dev|director', 'ruleOk', [
      { key: 'rules', id: 'restMode', before: rule, after: { v: 'block', by: 'Dee Rector', on: TODAY } },
      { key: 'ruleProp', id: prop.id, before: prop, after: { ...prop, state: 'Approved', dby: 'Dee Rector' } },
    ]);
    ok(r);
    expect(r.body.data.rules.restMode).toEqual({ v: 'block', by: 'Dee Rector', on: TODAY });
    // ruleNo
    const q = { k: 'weekH', old: 48, v: 50, why: 'Winter', by: 'Dee Rector', on: TODAY, state: 'Proposed' };
    r = await sync('dev|director', 'ruleCh', 'ruleProp', 'undefined', null, q);
    ok(r);
    const qq = r.body.data.ruleProp.find((x: J) => x.k === 'weekH') as J;
    ok(await sync('dev|manager', 'ruleNo', 'ruleProp', qq.id, qq, { ...qq, state: 'Rejected', dby: 'Manager' }));
    // In block mode a swap that breaks a rest rule is refused (v36 swOk).
    const mk = (id: string, pid: string, date: string, start: string, end: string) => ({
      id, pid, date, start, end, drive: 6, veh: null, pat: 'Custom', state: 'Planned', brk: 30,
    });
    const A = mk('SH-3920', 'ST-0042', addD(TODAY, 20), '19:00', '23:00');
    const B = mk('SH-3921', 'ST-0043', addD(TODAY, 21), '05:00', '09:00');
    const C = mk('SH-3922', 'ST-0043', addD(TODAY, 20), '07:00', '12:00');
    for (const x of [A, B, C]) ok(await sync('dev|hr', 'shNew', 'rota', x.id, null, x));
    const w = { id: 'SW-07', from: 'ST-0042', to: 'ST-0043', shA: A.id, shB: B.id, on: TODAY, why: 'x', state: 'Requested' };
    ok(await sync('dev|crew', 'swNew', 'swaps', w.id, null, w));
    const ag = { ...w, state: 'Colleague agreed' };
    ok(await sync('dev|crew2', 'swAgree', 'swaps', w.id, w, ag));
    no(await sync('dev|manager', 'swOk', 'swaps', w.id, ag, { ...ag, state: 'Approved' }), /would break a rest or hours rule: Only \dh rest/);
  });
});
