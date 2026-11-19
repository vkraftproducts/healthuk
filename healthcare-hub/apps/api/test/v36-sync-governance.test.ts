// v36 ↔ real tables, governance area: incidents, RIDDOR, audits, templates, programme, actions,
// policies, risks. A fresh organisation with v36's own people moves in v36's sample data (S.json
// shape), loads it back unchanged, then every v36 button in the area is replayed exactly as v36's
// ACTS function changes the record, with the refusals v36 shows.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

const V36_FIXTURE = JSON.parse(
  readFileSync(new URL('./v36-sync-governance.fixture.json', import.meta.url), 'utf8'),
) as J;
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORG = '01900000-0000-7000-8000-0000000a3601';
const LOC = '01900000-0000-7000-8000-0000000a3602';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
/** A London day before today: a time on it is always in the past, whatever the clock says now. */
const YESTERDAY = new Date(Date.parse(`${TODAY}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
const KEYS = ['tpl', 'prog', 'aud', 'inc', 'riddor', 'risk', 'pol', 'act'] as const;
/** v36's people (names as v36 hard-codes them in its pickers) with a login each. */
const PEOPLE: [string, string, string][] = [
  ['gv|rm', 'Dr. Helen Price', 'REGISTERED_MANAGER'],
  ['gv|dir', 'Dr. A. Vance', 'DIRECTOR'],
  ['gv|gov', 'Rachel Hughes', 'GOVERNANCE_LEAD'],
  ['gv|hr', 'Sarah Jenkins', 'HR_LEAD'],
  ['gv|fleet', 'Dave Evans', 'FLEET_LEAD'],
  ['gv|prem', 'Priya Nair', 'PREMISES_LEAD'],
  ['gv|disp', 'Dispatcher', 'DISPATCHER'],
  ['gv|crew', 'Alex Morgan', 'CREW'],
  ['gv|crew2', 'Lee Davies', 'CREW'],
  ['gv|aud', 'Audrey Inspector', 'AUDITOR'],
];
const STAFF_USER: Record<string, string> = { 'ST-0042': 'gv|crew', 'ST-0043': 'gv|crew2' };

async function call(method: 'GET' | 'POST', url: string, sub: string, body?: unknown, org = ORG) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': org,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}
const state = async (sub = 'gv|rm') => {
  const r = await call('GET', `/api/v1/v36/state?today=${TODAY}`, sub);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data as J;
};
/** One v36 button: the changed records, as the browser link sends them. */
async function press(sub: string, act: string, changes: { key: string; id: string; before: J | null; after: J | null }[]) {
  return call('POST', '/api/v1/v36/sync', sub, { act, today: TODAY, changes });
}
const ok = (r: { status: number; body: J }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as J;
};
const refused = (r: { status: number; body: J }, text: RegExp, status = 403) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  expect(String(r.body.detail)).toMatch(text);
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const byId = (list: J[], id: string) => list.find((x) => x.id === id)!;

/** v36 leaves unset fields out, or sets them to null or '': all three mean "not set". */
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o: J = {};
    for (const [k, x] of Object.entries(v as J)) {
      if (x === null || x === undefined || x === '') continue;
      o[k] = norm(x);
    }
    return o;
  }
  return v;
}
/** v36 records `risk` (still at risk) only when ticked on some samples; unset means false. */
const normInc = (m: J) =>
  Object.fromEntries(Object.entries(m).map(([k, e]) => [k, norm({ risk: false, jobs: '', ...e })]));

async function setupOrg() {
  const c = new pg.Client({ connectionString: urls.admin });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [ORG]);
    await c.query(`INSERT INTO organisation (id, name, sector_packs) VALUES ($1, 'v36 governance test', '{ambulance}')`, [ORG]);
    await c.query(`INSERT INTO location (id, organisation_id, name, registered) VALUES ($1, $2, 'Watford station', true)`, [LOC, ORG]);
    const ids: Record<string, string> = {};
    for (const [sub, name, role] of PEOPLE) {
      const u = await c.query(
        `INSERT INTO app_user (idp_subject, email, display_name, status)
         VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
        [sub, `${sub.replace('|', '.')}@v36.test`, name],
      );
      ids[sub] = u.rows[0].id as string;
      await c.query(
        `INSERT INTO membership (organisation_id, user_id, role_id, valid_from)
         SELECT $1, $2, id, now() - interval '1 day' FROM role WHERE organisation_id IS NULL AND key = $3`,
        [ORG, ids[sub], role],
      );
    }
    const people = V36_FIXTURE.people as Record<string, J>;
    for (const [code, p] of Object.entries(people))
      await c.query(
        `INSERT INTO staff (organisation_id, staff_no, display_name, lifecycle_state, primary_location_id, user_id)
         VALUES ($1, $2, $3, 'ACTIVE', $4, $5)`,
        [ORG, code, p.n, LOC, STAFF_USER[code] ? ids[STAFF_USER[code]] : null],
      );
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
  await setupOrg();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('v36 governance: the saved copy moves in and loads back in v36 shape', () => {
  it('lists the collections as needing import, imports them, and loads them back unchanged', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'gv|rm');
    expect(st.status).toBe(200);
    for (const k of KEYS) expect(st.body.needsImport).toContain(k);
    const shapes = Object.fromEntries(st.body.connected.map((c: J) => [c.key, c]));
    expect(shapes.inc).toMatchObject({ shape: 'map', writable: true });
    expect(shapes.pol).toMatchObject({ shape: 'list', idField: 'id', writable: true });
    expect(shapes.prog).toMatchObject({ shape: 'list', writable: false });

    const data = Object.fromEntries(KEYS.map((k) => [k, V36_FIXTURE[k]]));
    const imp = await call('POST', '/api/v1/v36/import', 'gv|rm', { today: TODAY, data });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    for (const k of KEYS) expect(imp.body.imported).toContain(k);

    const d = await state('gv|rm');
    expect(normInc(d.inc)).toEqual(normInc(V36_FIXTURE.inc));
    for (const k of ['tpl', 'prog', 'aud', 'riddor', 'risk', 'pol', 'act'] as const)
      expect(norm(d[k]), k).toEqual(norm(V36_FIXTURE[k]));
    // Nothing is left to import, and a second import changes nothing.
    const again = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'gv|rm');
    for (const k of KEYS) expect(again.body.needsImport).not.toContain(k);
    const twice = await call('POST', '/api/v1/v36/import', 'gv|rm', { today: TODAY, data });
    expect(twice.body.imported).toEqual([]);
  });

  it('shows the incident register to governance, managers and auditors; others see their own', async () => {
    const aud = await state('gv|aud');
    expect(Object.keys(aud.inc).sort()).toEqual(Object.keys(V36_FIXTURE.inc).sort());
    expect(Object.keys(aud.riddor)).toEqual(['EVT-2026-043']);
    const crew = await state('gv|crew');
    expect(Object.keys(crew.inc).sort()).toEqual(['EVT-2026-044', 'EVT-2026-045']);
    expect(crew.riddor).toEqual({});
    const hr = await state('gv|hr');
    expect(Object.keys(hr.inc)).toEqual([]);
  });

  it('refuses every change from the read-only auditor', async () => {
    const d = await state('gv|aud');
    const r = clone(byId(d.risk, 'RSK-02'));
    r.l1 = 1;
    refused(await press('gv|aud', 'rkRev', [{ key: 'risk', id: 'RSK-02', before: byId(d.risk, 'RSK-02'), after: r }]), /read-only/);
  });

  it('the demo organisation loads every governance collection in v36 shape', async () => {
    const r = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'dev|governance', undefined, SEED_IDS.orgExample);
    expect(r.status).toBe(200);
    for (const k of KEYS) expect(r.body.data).toHaveProperty(k);
    expect(Array.isArray(r.body.data.pol)).toBe(true);
    expect(Array.isArray(r.body.data.risk)).toBe(true);
    expect(typeof r.body.data.inc).toBe('object');
  });
});

describe('v36 governance: incidents (incNew … incClose, docStep, cqcSub, rdAss)', () => {
  let id = 'EVT-2026-046';
  const now = () => `${TODAY} 09:00`;

  it('incNew: any non read-only role reports; the server keeps v36 numbering', async () => {
    const e = {
      id,
      type: ['Incident', 'Accident'],
      title: 'Patient fell when stepping from the tail-lift',
      when: `${YESTERDAY} 08:10`,
      place: 'Lister Hospital – ambulance bay',
      what: 'Patient lost balance at the bottom of the tail-lift; suspected hip fracture, taken to A&E.',
      jobs: 'J-140',
      imm: 'First aid; patient conveyed to A&E; family told.',
      risk: true,
      nhs: true,
      by: 'Alex Morgan',
      on: now(),
      harm: null,
      lead: null,
      stage: 'Reported',
      acts: [],
      stamps: { Reported: now() },
    };
    refused(await press('gv|aud', 'incNew', [{ key: 'inc', id, before: null, after: e }]), /read-only/);
    const d = ok(await press('gv|crew', 'incNew', [{ key: 'inc', id, before: null, after: e }]));
    const got = d.inc[id];
    expect(got).toMatchObject({
      type: ['Incident', 'Accident'],
      title: e.title,
      by: 'Alex Morgan',
      stage: 'Reported',
      harm: null,
      lead: null,
      risk: true,
      nhs: true,
      jobs: 'J-140',
    });
    expect(Object.keys(got.stamps)).toEqual(['Reported']);
    // The at-risk alert went to the Registered Manager and the governance lead.
    const alerts = await db.withTenant(
      { orgId: ORG, userId: SEED_IDS.orgExample, permissions: [], locationIds: null } as never,
      (tx) => tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM notification_delivery n JOIN alert a ON a.id = n.alert_id
         WHERE a.reason_code = 'INCIDENT_STILL_AT_RISK'`,
    );
    expect(alerts[0]!.n).toBe(2);
    // A second report with the same proposed number gets the next one.
    const dup = ok(await press('gv|crew2', 'incNew', [{ key: 'inc', id, before: null, after: { ...e, by: 'Lee Davies', risk: false, title: 'Second report, same number' } }]));
    expect(Object.keys(dup.inc)).toContain('EVT-2026-047');
  });

  it('incTriage: governance or a manager only; harm, lead, candour steps and CQC draft', async () => {
    const d = await state('gv|gov');
    const before = d.inc[id];
    const e = clone(before);
    e.harm = 'Severe harm';
    e.lead = 'Dr. Helen Price';
    e.stamps.Triaged = now();
    e.stage = 'Triaged';
    e.doc = {
      need: true,
      steps: [
        { k: 'Tell the patient / family in person', due: '2026-12-01' },
        { k: 'Apology given', due: '2026-12-01' },
        { k: 'Written follow-up within 10 working days', due: '2026-12-05' },
        { k: 'Investigation findings shared', due: '' },
      ],
    };
    e.cqc = { need: true, type: 'Serious injury', state: 'Draft', by: 'Rachel Hughes', on: now() };
    refused(await press('gv|crew', 'incTriage', [{ key: 'inc', id, before, after: e }]), /only governance or a manager can triage/);
    const got = ok(await press('gv|gov', 'incTriage', [{ key: 'inc', id, before, after: e }])).inc[id];
    expect(got).toMatchObject({ harm: 'Severe harm', lead: 'Dr. Helen Price', stage: 'Triaged' });
    expect(got.doc).toEqual(e.doc);
    expect(got.cqc).toMatchObject({ need: true, type: 'Serious injury', state: 'Draft', by: 'Rachel Hughes' });
  });

  it('incInv, incFind, incAct, incToAct', async () => {
    let d = await state('gv|gov');
    let b = d.inc[id];
    let e = clone(b);
    e.tor = 'Tail-lift handover and footwear check';
    e.inv_due = '2026-12-20';
    e.stamps.Investigating = now();
    e.stage = 'Investigating';
    let got = ok(await press('gv|gov', 'incInv', [{ key: 'inc', id, before: b, after: e }])).inc[id];
    expect(got).toMatchObject({ stage: 'Investigating', tor: e.tor, inv_due: '2026-12-20' });

    b = got;
    e = clone(b);
    e.rca = { m: 'whys', whys: ['Patient stepped off early', 'No hand-hold'], fish: {} };
    e.findings = 'Crew did not hold the patient at the bottom step.';
    e.root = 'No two-person hold at the tail-lift step.';
    e.learning = 'Two-person hold at the tail-lift step, every transfer.';
    e.share = true;
    e.learnOn = TODAY;
    e.stamps['Findings & learning'] = now();
    e.stage = 'Findings & learning';
    e.doc.steps[3].due = '2026-12-10';
    got = ok(await press('gv|gov', 'incFind', [{ key: 'inc', id, before: b, after: e }])).inc[id];
    expect(got).toMatchObject({ stage: 'Findings & learning', root: e.root, share: true, learnOn: TODAY, rca: e.rca });
    expect(got.doc.steps[3].due).toBe('2026-12-10');

    // incAct: newAction() then e.acts.push(id), in one save.
    d = await state('gv|gov');
    const act = { id: 'ACT-222', t: 'Tail-lift two-person hold briefing', src: `Event ${id}`, owner: 'Dave Evans', due: '2026-12-03', state: 'Open', next: 'Upload evidence when done' };
    b = d.inc[id];
    e = clone(b);
    e.acts = ['ACT-222'];
    refused(await press('gv|hr', 'incAct', [{ key: 'act', id: 'ACT-222', before: null, after: act }, { key: 'inc', id, before: b, after: e }]), /only governance or a manager/);
    const d2 = ok(await press('gv|gov', 'incAct', [{ key: 'act', id: 'ACT-222', before: null, after: act }, { key: 'inc', id, before: b, after: e }]));
    expect(d2.act['ACT-222']).toEqual(act);
    expect(d2.inc[id].acts).toEqual(['ACT-222']);

    b = d2.inc[id];
    e = clone(b);
    e.stamps['Actions in progress'] = now();
    e.stage = 'Actions in progress';
    got = ok(await press('gv|gov', 'incToAct', [{ key: 'inc', id, before: b, after: e }])).inc[id];
    expect(got.stage).toBe('Actions in progress');
  });

  it('incReqClose waits for verified actions; actEv by the owner, actVer by someone else', async () => {
    let d = await state('gv|gov');
    let b = d.inc[id];
    let e = clone(b);
    e.stamps['Awaiting closure'] = now();
    e.stage = 'Awaiting closure';
    refused(await press('gv|gov', 'incReqClose', [{ key: 'inc', id, before: b, after: e }]), /1 action\(s\) not verified yet: ACT-222/);

    const ab = d.act['ACT-222'];
    const ev = clone(ab);
    ev.ev = { file: 'ACT-222_evidence.pdf', by: 'Dave Evans', on: now(), note: 'Briefing held with all crews.' };
    ev.state = 'Ready for verification';
    refused(await press('gv|gov', 'actEv', [{ key: 'act', id: 'ACT-222', before: ab, after: ev }]), /only the action owner \(Dave Evans\) uploads evidence/);
    const a1 = ok(await press('gv|fleet', 'actEv', [{ key: 'act', id: 'ACT-222', before: ab, after: ev }])).act['ACT-222'];
    expect(a1).toMatchObject({ state: 'Ready for verification', ev: { file: 'ACT-222_evidence.pdf', by: 'Dave Evans', note: 'Briefing held with all crews.' } });
    const vr = clone(a1);
    vr.state = 'Verified';
    vr.ver = { by: 'Rachel Hughes', on: now() };
    refused(await press('gv|fleet', 'actVer', [{ key: 'act', id: 'ACT-222', before: a1, after: vr }]), /only governance or a manager can verify/);
    const a2 = ok(await press('gv|gov', 'actVer', [{ key: 'act', id: 'ACT-222', before: a1, after: vr }])).act['ACT-222'];
    expect(a2).toMatchObject({ state: 'Verified', ver: { by: 'Rachel Hughes' } });

    d = await state('gv|gov');
    b = d.inc[id];
    e = clone(b);
    e.stamps['Awaiting closure'] = now();
    e.stage = 'Awaiting closure';
    expect(ok(await press('gv|gov', 'incReqClose', [{ key: 'inc', id, before: b, after: e }])).inc[id].stage).toBe('Awaiting closure');
  });

  it('incClose: RM or Director, not the lead, candour steps done, CQC submitted', async () => {
    let d = await state('gv|dir');
    const close = (b: J) => {
      const e = clone(b);
      e.stamps.Closed = now();
      e.stage = 'Closed';
      e.closed = { by: 'Dr. A. Vance', on: now(), note: 'Learning embedded; family updated.' };
      e.fb = 'Thank you – we changed how crews hold patients at the tail-lift.';
      return e;
    };
    refused(await press('gv|gov', 'incClose', [{ key: 'inc', id, before: d.inc[id], after: close(d.inc[id]) }]), /only the Registered Manager or Director can close/);
    refused(await press('gv|rm', 'incClose', [{ key: 'inc', id, before: d.inc[id], after: close(d.inc[id]) }]), /you led this investigation/);
    refused(await press('gv|dir', 'incClose', [{ key: 'inc', id, before: d.inc[id], after: close(d.inc[id]) }]), /duty of candour steps are still open/);

    // docStep ×4 (one save each, as v36).
    for (let i = 0; i < 4; i++) {
      d = await state('gv|gov');
      const b = d.inc[id];
      const e = clone(b);
      e.doc.steps[i].done = now();
      e.doc.steps[i].by = 'Rachel Hughes';
      if (i === 0) refused(await press('gv|crew', 'docStep', [{ key: 'inc', id, before: b, after: e }]), /only governance or a manager/);
      const got = ok(await press('gv|gov', 'docStep', [{ key: 'inc', id, before: b, after: e }])).inc[id];
      expect(got.doc.steps[i]).toMatchObject({ k: e.doc.steps[i].k, by: 'Rachel Hughes' });
      expect(got.doc.steps[i].done).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
    d = await state('gv|dir');
    refused(await press('gv|dir', 'incClose', [{ key: 'inc', id, before: d.inc[id], after: close(d.inc[id]) }]), /CQC notification has not been recorded as submitted/);

    // cqcSub: RM or Director records the portal submission.
    const b = d.inc[id];
    const e = clone(b);
    e.cqc.state = 'Submitted';
    e.cqc.ref = 'CQC-NOT-55021';
    e.cqc.sub = TODAY;
    e.cqc.subBy = 'Dr. A. Vance';
    refused(await press('gv|gov', 'cqcSub', [{ key: 'inc', id, before: b, after: e }]), /only the Registered Manager or Director records submissions/);
    const got = ok(await press('gv|dir', 'cqcSub', [{ key: 'inc', id, before: b, after: e }])).inc[id];
    expect(got.cqc).toMatchObject({ state: 'Submitted', ref: 'CQC-NOT-55021', sub: TODAY, subBy: 'Dr. A. Vance' });

    const closed = ok(await press('gv|dir', 'incClose', [{ key: 'inc', id, before: got, after: close(got) }])).inc[id];
    expect(closed).toMatchObject({ stage: 'Closed', fb: close(got).fb, closed: { by: 'Dr. A. Vance', note: 'Learning embedded; family updated.' } });
  });

  it('incBack: only the RM or Director sends an incident back to the lead', async () => {
    const d = await state('gv|rm');
    const b = d.inc['EVT-2026-043'];
    const e = clone(b);
    e.stamps.Investigating = now();
    e.stage = 'Investigating';
    refused(await press('gv|gov', 'incBack', [{ key: 'inc', id: 'EVT-2026-043', before: b, after: e }]), /only the Registered Manager or Director/);
    const got = ok(await press('gv|rm', 'incBack', [{ key: 'inc', id: 'EVT-2026-043', before: b, after: e }])).inc['EVT-2026-043'];
    expect(got.stage).toBe('Investigating');
    expect(got.stamps.Investigating).not.toBe(b.stamps.Investigating);
    // A stage jump v36 does not offer is refused.
    const j = clone(got);
    j.stage = 'Closed';
    refused(await press('gv|rm', 'incClose', [{ key: 'inc', id: 'EVT-2026-043', before: got, after: j }]), /not allowed/);
  });

  it('rdAss: governance or a manager records the RIDDOR assessment', async () => {
    const d = await state('gv|gov');
    const r = { cls: 'Specified injury to a worker', why: 'Fracture other than fingers or toes', due: '2026-11-25', ref: '', by: 'Rachel Hughes', on: TODAY };
    refused(await press('gv|hr', 'rdAss', [{ key: 'riddor', id, before: null, after: r }]), /not allowed/);
    const got = ok(await press('gv|gov', 'rdAss', [{ key: 'riddor', id, before: null, after: r }])).riddor;
    expect(got[id]).toMatchObject({ cls: r.cls, why: r.why, by: 'Rachel Hughes', on: TODAY });
    expect(got[id].due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const r2 = { ...got[id], ref: 'F2508-001' };
    expect(ok(await press('gv|gov', 'rdAss', [{ key: 'riddor', id, before: got[id], after: r2 }])).riddor[id].ref).toBe('F2508-001');
    expect(Object.keys(d.riddor)).toEqual(['EVT-2026-043']);
  });
});

describe('v36 governance: templates, audits and actions', () => {
  it('tplPub: a second person publishes a drafted template', async () => {
    const d = await state('gv|rm');
    const b = d.tpl['AC-03'];
    const e = { ...clone(b), state: 'Published', pub: 'Dr. Helen Price' };
    refused(await press('gv|rm', 'tplPub', [{ key: 'tpl', id: 'AC-03', before: b, after: e }]), /you drafted this template/);
    refused(await press('gv|hr', 'tplPub', [{ key: 'tpl', id: 'AC-03', before: b, after: e }]), /only governance or a manager can publish/);
    const got = ok(await press('gv|gov', 'tplPub', [{ key: 'tpl', id: 'AC-03', before: b, after: { ...e, pub: 'Rachel Hughes' } }])).tpl['AC-03'];
    expect(got).toEqual({ ...b, state: 'Published', pub: 'Rachel Hughes' });
  });

  it('audNew: the auditor cannot own the area; governance or a manager schedules', async () => {
    const a = { id: 'AUD-105', tpl: 'AC-03', t: 'Supervision audit', auditor: 'Rachel Hughes', owner: 'Rachel Hughes', due: '2026-12-10', stage: 'Scheduled' };
    refused(await press('gv|gov', 'audNew', [{ key: 'aud', id: a.id, before: null, after: a }]), /auditor cannot be the owner/);
    refused(await press('gv|fleet', 'audNew', [{ key: 'aud', id: a.id, before: null, after: { ...a, owner: 'Sarah Jenkins' } }]), /only governance or a manager can schedule/);
    const got = ok(await press('gv|gov', 'audNew', [{ key: 'aud', id: a.id, before: null, after: { ...a, owner: 'Sarah Jenkins' } }])).aud['AUD-105'];
    expect(got).toEqual({ ...a, owner: 'Sarah Jenkins' });
  });

  it('audRun by the named auditor, actions raised; audReturn / audAccept by the area owner only', async () => {
    let d = await state('gv|rm');
    const b = d.aud['AUD-104'];
    const run = (who: string) => {
      const a = clone(b);
      a.res = { 0: 'Pass', 1: 'Fail', 2: 'Pass', 3: 'N/A', 4: 'Pass' };
      a.notes = { 0: '', 1: 'Approval missing on ST-0051 file', 2: '', 3: '', 4: '' };
      a.method = 'Records, sample 5';
      a.stage = 'Submitted – awaiting owner';
      a.sub = { by: who, on: `${TODAY} 10:00` };
      a.acts = ['ACT-223'];
      return a;
    };
    const act = { id: 'ACT-223', t: 'Fix: Approval for role signed by the Registered Manager – Approval missing on ST-0051 file', src: 'Audit AUD-104', owner: 'Sarah Jenkins', due: '2026-12-03', state: 'Open', next: 'Upload evidence when done' };
    refused(
      await press('gv|gov', 'audRun', [{ key: 'aud', id: 'AUD-104', before: b, after: run('Rachel Hughes') }, { key: 'act', id: act.id, before: null, after: act }]),
      /only the named auditor \(Dr\. Helen Price\) can conduct this audit/,
    );
    d = ok(await press('gv|rm', 'audRun', [{ key: 'aud', id: 'AUD-104', before: b, after: run('Dr. Helen Price') }, { key: 'act', id: act.id, before: null, after: act }]));
    const sub = d.aud['AUD-104'];
    expect(sub).toMatchObject({
      stage: 'Submitted – awaiting owner',
      res: { 0: 'Pass', 1: 'Fail', 2: 'Pass', 3: 'N/A', 4: 'Pass' },
      notes: { 1: 'Approval missing on ST-0051 file' },
      method: 'Records, sample 5',
      sub: { by: 'Dr. Helen Price' },
      acts: ['ACT-223'],
    });
    expect(d.act['ACT-223']).toEqual(act);

    // audReturn, then the auditor runs it again, then audAccept.
    const ret = { ...clone(sub), stage: 'Returned to auditor', dec: { k: 'Returned', by: 'Sarah Jenkins', on: `${TODAY} 11:00`, why: 'Note the sample chosen' } };
    refused(await press('gv|rm', 'audReturn', [{ key: 'aud', id: 'AUD-104', before: sub, after: ret }]), /only the area owner \(Sarah Jenkins\)/);
    const r1 = ok(await press('gv|hr', 'audReturn', [{ key: 'aud', id: 'AUD-104', before: sub, after: ret }])).aud['AUD-104'];
    expect(r1).toMatchObject({ stage: 'Returned to auditor', dec: { k: 'Returned', by: 'Sarah Jenkins', why: 'Note the sample chosen' } });
    const again = { ...run('Dr. Helen Price'), dec: r1.dec, method: 'Records, random sample of 5 files' };
    const r2 = ok(await press('gv|rm', 'audRun', [{ key: 'aud', id: 'AUD-104', before: r1, after: again }])).aud['AUD-104'];
    expect(r2).toMatchObject({ stage: 'Submitted – awaiting owner', method: 'Records, random sample of 5 files' });
    const acc = { ...clone(r2), stage: 'Submitted – actions open', dec: { k: 'Accepted', by: 'Sarah Jenkins', on: `${TODAY} 12:00` } };
    const r3 = ok(await press('gv|hr', 'audAccept', [{ key: 'aud', id: 'AUD-104', before: r2, after: acc }])).aud['AUD-104'];
    expect(r3).toMatchObject({ stage: 'Submitted – actions open', dec: { k: 'Accepted', by: 'Sarah Jenkins' } });
    expect(r3.dec.why).toBeUndefined();
  });

  it('actEv, actRej, actEv, actVer: the audit closes when its last action is verified', async () => {
    let d = await state('gv|hr');
    let b = d.act['ACT-223'];
    const ev = (x: J, file: string) => ({ ...clone(x), ev: { file, by: 'Sarah Jenkins', on: `${TODAY} 13:00`, note: 'Approval now signed.' }, state: 'Ready for verification' });
    const a1 = ok(await press('gv|hr', 'actEv', [{ key: 'act', id: 'ACT-223', before: b, after: ev(b, 'approval.pdf') }])).act['ACT-223'];
    const rej = { ...clone(a1), state: 'Evidence rejected', rej: 'Signature date missing' };
    refused(await press('gv|hr', 'actRej', [{ key: 'act', id: 'ACT-223', before: a1, after: rej }]), /only governance or a manager/);
    const a2 = ok(await press('gv|gov', 'actRej', [{ key: 'act', id: 'ACT-223', before: a1, after: rej }])).act['ACT-223'];
    expect(a2).toMatchObject({ state: 'Evidence rejected', rej: 'Signature date missing', ev: { file: 'approval.pdf' } });
    const re = ev(a2, 'approval-dated.pdf');
    delete (re as J).rej;
    const a3 = ok(await press('gv|hr', 'actEv', [{ key: 'act', id: 'ACT-223', before: a2, after: re }])).act['ACT-223'];
    expect(a3.rej).toBeUndefined();
    expect(a3.ev.file).toBe('approval-dated.pdf');
    // v36 actVer also closes the audit in the same save.
    d = await state('gv|gov');
    const ver = { ...clone(a3), state: 'Verified', ver: { by: 'Rachel Hughes', on: `${TODAY} 14:00` } };
    const audB = d.aud['AUD-104'];
    const audA = { ...clone(audB), stage: 'Closed' };
    const out = ok(await press('gv|gov', 'actVer', [{ key: 'aud', id: 'AUD-104', before: audB, after: audA }, { key: 'act', id: 'ACT-223', before: a3, after: ver }]));
    expect(out.act['ACT-223'].state).toBe('Verified');
    expect(out.aud['AUD-104'].stage).toBe('Closed');
    // The owner (or whoever sent the evidence) cannot verify their own action.
    b = (await state('gv|rm')).act['ACT-219'];
    const mine = { ...clone(b), ev: { file: 'reaudit.pdf', by: 'Dr. Helen Price', on: `${TODAY} 15:00`, note: 'Re-audit done.' }, state: 'Ready for verification' };
    const m1 = ok(await press('gv|rm', 'actEv', [{ key: 'act', id: 'ACT-219', before: b, after: mine }])).act['ACT-219'];
    refused(await press('gv|rm', 'actVer', [{ key: 'act', id: 'ACT-219', before: m1, after: { ...clone(m1), state: 'Verified', ver: { by: 'Dr. Helen Price', on: `${TODAY} 15:05` } } }]), /you own this action/);
  });

  it('actOwner and actNew: governance or a manager', async () => {
    const d = await state('gv|gov');
    const b = d.act['ACT-215'];
    const e = { ...clone(b), owner: 'Priya Nair', due: '2026-12-15' };
    refused(await press('gv|hr', 'actOwner', [{ key: 'act', id: 'ACT-215', before: b, after: e }]), /only governance or a manager/);
    expect(ok(await press('gv|gov', 'actOwner', [{ key: 'act', id: 'ACT-215', before: b, after: e }])).act['ACT-215']).toMatchObject({ owner: 'Priya Nair', due: '2026-12-15' });
    const n = { id: 'ACT-224', t: 'Chase the oxygen supplier contract', src: 'Governance meeting', owner: 'Dave Evans', due: '2026-12-02', state: 'Open', next: 'Upload evidence when done' };
    refused(await press('gv|disp', 'actNew', [{ key: 'act', id: n.id, before: null, after: n }]), /only governance or a manager/);
    expect(ok(await press('gv|gov', 'actNew', [{ key: 'act', id: n.id, before: null, after: n }])).act['ACT-224']).toEqual(n);
    // An unknown owner name is refused.
    refused(await press('gv|gov', 'actNew', [{ key: 'act', id: 'ACT-225', before: null, after: { ...n, id: 'ACT-225', owner: 'Nobody Here' } }]), /Nobody Here/, 400);
  });
});

describe('v36 governance: policies and risks', () => {
  it('polCreate and polNew: governance, managers and HR; polPub by a second person', async () => {
    let d = await state('gv|hr');
    const n = { id: 'POL-07', code: 'LW-01', t: 'Lone working', type: 'Policy', owner: 'Sarah Jenkins', v: 1, state: 'Draft', roles: 'Paramedic,Technician', drafted: 'Sarah Jenkins', summary: 'How crews stay safe working alone.', ack: {} };
    refused(await press('gv|fleet', 'polCreate', [{ key: 'pol', id: n.id, before: null, after: n }]), /not allowed/);
    d = ok(await press('gv|hr', 'polCreate', [{ key: 'pol', id: n.id, before: null, after: n }]));
    expect(byId(d.pol, 'POL-07')).toEqual(n);

    const b = byId(d.pol, 'POL-02');
    const nv = { ...clone(b), v: 3, state: 'Draft', drafted: 'Sarah Jenkins', summary: 'Adds the stair-chair check.' };
    d = ok(await press('gv|hr', 'polNew', [{ key: 'pol', id: 'POL-02', before: b, after: nv }]));
    // v36 keeps the published version's details and acknowledgements until the new one is live.
    expect(byId(d.pol, 'POL-02')).toEqual(nv);

    const pb = byId(d.pol, 'POL-02');
    const pub = { ...clone(pb), state: 'Published', pub: 'Rachel Hughes', on: TODAY, review: `${Number(TODAY.slice(0, 4)) + 1}${TODAY.slice(4)}`, ack: {} };
    delete (pub as J).drafted;
    refused(await press('gv|hr', 'polPub', [{ key: 'pol', id: 'POL-02', before: pb, after: pub }]), /only governance or a manager can publish/);
    d = ok(await press('gv|gov', 'polPub', [{ key: 'pol', id: 'POL-02', before: pb, after: pub }]));
    expect(byId(d.pol, 'POL-02')).toEqual(pub);
    // The drafter cannot publish their own version.
    const p3 = byId(d.pol, 'POL-03');
    const d3 = { ...clone(p3), v: 5, state: 'Draft', drafted: 'Rachel Hughes', summary: 'Adds ATP swab limits.' };
    d = ok(await press('gv|gov', 'polNew', [{ key: 'pol', id: 'POL-03', before: p3, after: d3 }]));
    const own = byId(d.pol, 'POL-03');
    const pub3 = { ...clone(own), state: 'Published', pub: 'Rachel Hughes', on: TODAY, ack: {} };
    refused(await press('gv|gov', 'polPub', [{ key: 'pol', id: 'POL-03', before: own, after: pub3 }]), /you drafted this version/);
  });

  it('polAck: staff acknowledge for themselves only', async () => {
    const d = await state('gv|crew');
    const b = byId(d.pol, 'POL-06');
    const e = { ...clone(b), ack: { ...b.ack, 'ST-0042': TODAY } };
    refused(await press('gv|gov', 'polAck', [{ key: 'pol', id: 'POL-06', before: b, after: e }]), /only staff acknowledge policies/);
    refused(await press('gv|crew', 'polAck', [{ key: 'pol', id: 'POL-06', before: b, after: { ...clone(b), ack: { ...b.ack, 'ST-0089': TODAY } } }]), /only acknowledge for yourself/);
    const got = byId(ok(await press('gv|crew', 'polAck', [{ key: 'pol', id: 'POL-06', before: b, after: e }])).pol, 'POL-06');
    expect(got.ack).toEqual(e.ack);
  });

  it('rkNew, rkRev (adds a history point), rkAct', async () => {
    let d = await state('gv|gov');
    const n = { id: 'RSK-07', h: 'Patient falls at the tail-lift step', who: 'Patients', l0: 3, i0: 4, ctl: 'Two-person hold; tail-lift check', l1: 2, i1: 3, owner: 'Dave Evans', review: '2027-02-19', acts: [], state: 'Open' };
    refused(await press('gv|hr', 'rkNew', [{ key: 'risk', id: n.id, before: null, after: n }]), /only governance or a manager/);
    d = ok(await press('gv|gov', 'rkNew', [{ key: 'risk', id: n.id, before: null, after: n }]));
    expect(byId(d.risk, 'RSK-07')).toEqual(n);

    const b = byId(d.risk, 'RSK-01');
    const e = { ...clone(b), ctl: `${b.ctl}; stair-chair check`, l1: 1, review: '2027-02-19', hist: [...b.hist, { on: TODAY, s: 3 }] };
    const got = byId(ok(await press('gv|gov', 'rkRev', [{ key: 'risk', id: 'RSK-01', before: b, after: e }])).risk, 'RSK-01');
    expect(got).toEqual(e);

    const act = { id: 'ACT-225', t: 'Buy tail-lift hand rails', src: 'Risk RSK-07', owner: 'Dave Evans', due: '2026-12-10', state: 'Open', next: 'Upload evidence when done' };
    const rb = byId(d.risk, 'RSK-07');
    const ra = { ...clone(rb), acts: ['ACT-225'] };
    const out = ok(await press('gv|gov', 'rkAct', [{ key: 'risk', id: 'RSK-07', before: rb, after: ra }, { key: 'act', id: act.id, before: null, after: act }]));
    expect(byId(out.risk, 'RSK-07').acts).toEqual(['ACT-225']);
    expect(out.act['ACT-225']).toEqual(act);
  });
});

// ---- the governance registers (part 2) -----------------------------------------------------------
describe('v36 governance: registers (cmp su meet fpp ntf brc sar bcp bcpLog loc sop ctr vis ret esc esclog dep compl sgr)', () => {
  const FULL = JSON.parse(readFileSync('/tmp/v36run/S.json', 'utf8')) as J;
  const G = ['cmp', 'su', 'meet', 'fpp', 'ntf', 'brc', 'sar', 'bcp', 'bcpLog', 'loc', 'sop', 'ctr', 'vis', 'ret', 'esc', 'esclog', 'dep', 'compl', 'sgr'];
  const one = (sub: string, act: string, key: string, id: string, before: J | null, after: J | null) =>
    press(sub, act, [{ key, id, before, after }]);
  const no = (r: { status: number; body: J }, re: RegExp) => {
    expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
    expect(String(r.body.detail)).toMatch(re);
  };
  const plus = (d: string, n: number) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  it('moves the saved copy in and loads it back the same', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'gv|rm');
    for (const k of G) expect(st.body.needsImport).toContain(k);
    const data = Object.fromEntries(G.map((k) => [k, FULL[k]]));
    const imp = await call('POST', '/api/v1/v36/import', 'gv|rm', { today: TODAY, data });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const d = imp.body.data as J;
    for (const k of G.filter((k) => k !== 'bcpLog')) expect(d[k], k).toEqual(FULL[k]);
    expect(d.bcpLog.map(({ id, ...r }: J) => (expect(id).toMatch(/^BT-\d+$/), r))).toEqual(FULL.bcpLog);
    // Confidential registers stay with governance and managers; a named concern with its author.
    const crew = await state('gv|crew');
    for (const k of ['cmp', 'fpp', 'brc', 'sar', 'sgr']) expect(crew[k], k).toEqual([]);
    expect(crew.su.every((x: J) => x.by === 'Alex Morgan')).toBe(true);
    expect((await state('gv|hr')).su).toEqual(FULL.su);
  });

  it('cmp: cmpNew, cmpAck (lead is you), cmpResp, cmpClose', async () => {
    const c = { id: 'CMP-036', on: TODAY, via: 'Phone', pt: 'PT-4401', cat: 'Timeliness', sum: 'Late pickup', state: 'Received', pref: 'Letter', consent: false };
    no(await one('gv|fleet', 'cmpNew', 'cmp', c.id, null, c), /not allowed/);
    no(await one('gv|gov', 'cmpNew', 'cmp', c.id, null, { ...c, pt: 'Mrs Smith' }), /patient reference/);
    let d = ok(await one('gv|gov', 'cmpNew', 'cmp', c.id, null, c));
    expect(byId(d.cmp, c.id)).toEqual(c);
    const ack = { ...c, state: 'Investigating', ack: TODAY, lead: 'Rachel Hughes' };
    no(await one('gv|rm', 'cmpAck', 'cmp', c.id, c, ack), /your own name/);
    ok(await one('gv|gov', 'cmpAck', 'cmp', c.id, c, ack));
    no(await one('gv|gov', 'cmpClose', 'cmp', c.id, ack, { ...ack, state: 'Closed' }), /cannot move from Investigating to Closed/);
    const resp = { ...ack, out: 'Upheld', found: 'Crew late', learning: 'Plan buffers', share: true, resp: TODAY, state: 'Response sent' };
    no(await one('gv|gov', 'cmpResp', 'cmp', c.id, ack, { ...resp, found: '' }), /found/);
    ok(await one('gv|gov', 'cmpResp', 'cmp', c.id, ack, resp));
    d = ok(await one('gv|rm', 'cmpClose', 'cmp', c.id, resp, { ...resp, state: 'Closed' }));
    expect(byId(d.cmp, c.id).state).toBe('Closed');
  });

  it('su: suNew (anyone; anonymous has no name), suAck/suLook/suClose by the guardian or a manager', async () => {
    const s = { id: 'SU-14', cat: 'Bullying', text: 'Comments on nights', anon: false, code: null, by: 'Alex Morgan', on: TODAY, state: 'Waiting to be acknowledged', notes: [], about3p: false };
    no(await one('gv|crew', 'suNew', 'su', s.id, null, { ...s, by: 'Lee Davies' }), /own name/);
    no(await one('gv|aud', 'suNew', 'su', s.id, null, s), /read-only/);
    let d = ok(await one('gv|crew', 'suNew', 'su', s.id, null, s));
    expect(byId(d.su, s.id)).toEqual(s);
    const anon = { ...s, id: 'SU-15', anon: true, code: 'ABC-123', by: null };
    d = ok(await one('gv|crew2', 'suNew', 'su', anon.id, null, anon));
    expect(d.su.some((x: J) => x.id === 'SU-15')).toBe(false); // nobody's name on it, so not on the crew list
    const ack = { ...s, state: 'Acknowledged', ack: TODAY, handler: 'Rachel Hughes' };
    no(await one('gv|gov', 'suAck', 'su', s.id, s, ack), /only the guardian or a manager/);
    const ack2 = { ...ack, handler: 'Sarah Jenkins' };
    ok(await one('gv|hr', 'suAck', 'su', s.id, s, ack2));
    const look = { ...ack2, state: 'Being looked into' };
    ok(await one('gv|hr', 'suLook', 'su', s.id, ack2, look));
    no(await one('gv|hr', 'suClose', 'su', s.id, look, { ...look, state: 'Closed', fb: '', det: true }), /fb/);
    ok(await one('gv|rm', 'suClose', 'su', s.id, look, { ...look, state: 'Closed', fb: 'Spoken to the colleague', det: true }));
  });

  it('meet, fpp, ntf, compl: recorded by governance or managers, with v36 rules', async () => {
    const m = { id: 'GM-11', type: 'Clinical governance', t: 'Clinical governance – November', held: TODAY, chair: 'Dr. A. Vance', att: 'All', apol: '', quorate: true, minutes: '', dec: [] };
    no(await one('gv|crew', 'mtNew', 'meet', m.id, null, m), /not allowed/);
    ok(await one('gv|gov', 'mtNew', 'meet', m.id, null, m));
    const f = { id: 'FPP-06', who: 'Rachel Hughes', role: 'Director', on: TODAY, by: 'Rachel Hughes', checks: 9, out: 'Fit and proper', next: plus(TODAY, 365), ev: {} };
    no(await one('gv|gov', 'fppNew', 'fpp', f.id, null, f), /your own fit and proper check/);
    const f2 = { ...f, who: 'Dr. A. Vance', role: 'Registered Manager', checks: 8, ev: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [String(i), `e${i}.pdf`])) };
    no(await one('gv|gov', 'fppNew', 'fpp', f.id, null, f2), /All 9 items with evidence/);
    ok(await one('gv|gov', 'fppNew', 'fpp', f.id, null, { ...f2, checks: 9, ev: { ...f2.ev, 8: 'e8.pdf' } }));
    const n = { id: 'NTF-11', type: 'Allegation of abuse', reg: 'Reg 18', on: TODAY, about: 'SGR-19', state: 'Draft', due: TODAY, by: 'Rachel Hughes' };
    ok(await one('gv|gov', 'ntfAdd', 'ntf', n.id, null, n));
    no(await one('gv|gov', 'ntfSub', 'ntf', n.id, n, { ...n, state: 'Submitted', sub: TODAY, ref: 'CQC-NTF-' }), /CQC reference/);
    ok(await one('gv|gov', 'ntfSub', 'ntf', n.id, n, { ...n, state: 'Submitted', sub: TODAY, ref: 'CQC-NTF-1' }));
    ok(await one('gv|rm', 'cplNew', 'compl', 'CPL-16', null, { id: 'CPL-16', on: TODAY, about: 'Crew', text: 'Very kind', theme: 'Kindness' }));
  });

  it('brc and sar: logged, assessed and closed by governance or managers', async () => {
    const b = { id: 'BR-07', aware: TODAY, at: '09:00', what: 'Email to wrong trust', n: 1, risk: 'Not yet assessed', state: 'Being assessed', by: 'Rachel Hughes' };
    ok(await one('gv|gov', 'brNew', 'brc', b.id, null, b));
    no(await one('gv|gov', 'brAss', 'brc', b.id, b, { ...b, risk: 'High', state: 'Reported to ICO', decision: 'Reportable' }), /ICO reference/);
    ok(await one('gv|gov', 'brAss', 'brc', b.id, b, { ...b, risk: 'High', state: 'Reported to ICO', decision: 'Reportable', ico: 'ICO-1' }));
    const s = { id: 'SAR-11', on: TODAY, who: 'Patient', idv: false, state: 'Waiting for ID', due: plus(TODAY, 30) };
    ok(await one('gv|gov', 'sarNew', 'sar', s.id, null, s));
    const s1 = { ...s, idv: true, state: 'Collecting records' };
    ok(await one('gv|gov', 'sarId', 'sar', s.id, s, s1));
    no(await one('gv|gov', 'sarExt', 'sar', s.id, s1, { ...s1, due: plus(TODAY, 90) }), /ext/);
    const s2 = { ...s1, ext: 'Complex request', due: plus(TODAY, 90) };
    ok(await one('gv|gov', 'sarExt', 'sar', s.id, s1, s2));
    no(await one('gv|disp', 'sarDone', 'sar', s.id, s2, { ...s2, state: 'Responded', done: TODAY }), /not allowed/);
    ok(await one('gv|gov', 'sarDone', 'sar', s.id, s2, { ...s2, state: 'Responded', done: TODAY }));
  });

  it('bcp/bcpLog (bcpTest), loc (locNew), sop (sopNew/sopPub by someone else), ret (retCh/retOk)', async () => {
    const d0 = await state('gv|rm');
    const p = d0.bcp[0] as J;
    const tested = { ...p, last: TODAY, out: 'Passed' };
    const log = { on: TODAY, p: p.id, how: 'Tabletop exercise', out: 'Passed', by: 'Dispatcher' };
    no(await press('gv|crew', 'bcpTest', [{ key: 'bcp', id: p.id, before: p, after: tested }]), /not allowed/);
    const d = ok(await press('gv|disp', 'bcpTest', [
      { key: 'bcp', id: p.id, before: p, after: tested },
      { key: 'bcpLog', id: 'undefined', before: null, after: log },
    ]));
    expect(d.bcpLog.at(-1)).toEqual({ id: expect.stringMatching(/^BT-/), ...log });
    no(await one('gv|gov', 'locNew', 'loc', 'LOC-2', null, { id: 'LOC-2', n: 'Luton', addr: 'x', reg: 'PTS', rm: 'Dr. Helen Price' }), /not allowed/);
    ok(await one('gv|rm', 'locNew', 'loc', 'LOC-2', null, { id: 'LOC-2', n: 'Luton', addr: 'x', reg: 'PTS', rm: 'Dr. Helen Price' }));
    const v = (d0.sop as J[]).at(-1)!.v + 1;
    const draft = { v, on: TODAY, by: 'Dr. A. Vance', state: 'Draft', sum: 'New location' };
    no(await one('gv|dir', 'sopNew', 'sop', String(v + 1), null, { ...draft, v: v + 1 }), /follows the latest one/);
    ok(await one('gv|dir', 'sopNew', 'sop', String(v), null, draft));
    const pub = (who: string) => ({ ...draft, state: 'Published', pub: who, ntf: 'NTF-12' });
    no(await one('gv|dir', 'sopPub', 'sop', String(v), draft, pub('Dr. A. Vance')), /you drafted this version/);
    const sp = ok(await one('gv|rm', 'sopPub', 'sop', String(v), draft, pub('Dr. Helen Price')));
    expect((sp.sop as J[]).at(-1)).toEqual(pub('Dr. Helen Price'));
    const r = d0.ret.find((x: J) => x.state === 'Approved') as J;
    const pend = { ...r, state: 'Change pending', pend: '10 years', why: 'Insurer asks', by: 'Dr. Helen Price' };
    ok(await one('gv|rm', 'retCh', 'ret', r.id, r, pend));
    const appr = (who: string) => { const x = { ...pend, keep: '10 years', state: 'Approved', appr: who } as J; delete x.pend; return x; };
    no(await one('gv|rm', 'retOk', 'ret', r.id, pend, appr('Dr. Helen Price')), /someone else must approve/);
    ok(await one('gv|dir', 'retOk', 'ret', r.id, pend, appr('Dr. A. Vance')));
  });

  it('ctr, vis, esc, dep, sgr', async () => {
    const c = { id: 'CTR-04', n: 'Gas Safe Co', work: 'Boiler', ins: plus(TODAY, 200), comp: 'Gas Safe card', by: 'Dave Evans', state: 'Approved' };
    no(await one('gv|crew', 'ctrNew', 'ctr', c.id, null, c), /not allowed/);
    ok(await one('gv|fleet', 'ctrNew', 'ctr', c.id, null, c));
    no(await one('gv|fleet', 'ctrVer', 'ctr', c.id, c, { ...c, vby: 'Dave Evans' }), /you added this contractor/);
    const cv = { ...c, vby: 'Rachel Hughes' };
    ok(await one('gv|gov', 'ctrVer', 'ctr', c.id, c, cv));
    const ren = { ...c, ins: plus(TODAY, 500), by: 'Dr. Helen Price' };
    ok(await one('gv|rm', 'ctrIns', 'ctr', c.id, cv, ren));
    const v = { id: 'VIS-805', n: 'A. Visitor', from: 'NHS', why: 'Audit', host: 'Dr. Helen Price', in: '09:00', out: '', on: TODAY };
    ok(await one('gv|crew', 'visIn', 'vis', v.id, null, v));
    ok(await one('gv|crew', 'visOut', 'vis', v.id, v, { ...v, out: '10:00' }));
    const k = 'Action';
    const e = (await state('gv|rm')).esc[k] as J;
    no(await one('gv|gov', 'escEdit', 'esc', k, e, { ...e, warn: 5 }), /only the Registered Manager or Director/);
    no(await one('gv|rm', 'escEdit', 'esc', k, e, { ...e, lead: 9, rm: 2 }), /after the lead/);
    const de = ok(await one('gv|rm', 'escEdit', 'esc', k, e, { ...e, warn: 5 }));
    expect(de.esc[k]).toEqual({ ...e, warn: 5 });
    const dp = { id: 'DP-4', lead: 'gov', dep: 'gov', from: TODAY, to: plus(TODAY, 3), covers: 'All', by: 'Dr. Helen Price', on: `${TODAY} 10:00` };
    no(await one('gv|rm', 'depNew', 'dep', dp.id, null, dp), /deputy must be someone else/);
    const dp2 = { ...dp, dep: 'rm' };
    ok(await one('gv|rm', 'depNew', 'dep', dp.id, null, dp2));
    ok(await one('gv|dir', 'depEnd', 'dep', dp.id, dp2, { ...dp2, ended: { by: 'Dr. A. Vance', on: `${TODAY} 11:00` } }));
    const s = { id: 'SGR-19', on: TODAY, who: 'Adult', cat: 'Neglect', pt: 'PT-4500', by: 'Alex Morgan', to: '', ref: '', state: 'Raised internally' };
    no(await one('gv|gov', 'sgrNew', 'sgr', s.id, null, { ...s, pt: 'Bob' }), /patient reference/);
    ok(await one('gv|gov', 'sgrNew', 'sgr', s.id, null, s));
    const rf = { ...s, to: 'HCC', ref: 'HCC-1', state: 'Referred – awaiting outcome', refOn: TODAY };
    ok(await one('gv|gov', 'sgrRef', 'sgr', s.id, s, rf));
    ok(await one('gv|rm', 'sgrOut', 'sgr', s.id, rf, { ...rf, out: 'Care plan', state: 'Closed – outcome received' }));
    no(await one('gv|rm', 'x', 'esclog', 'EL-9', null, { t: 'x' }), /not added here/);
  });
});

describe('v36 governance: cqA, cqSub, dspt, fft, kpi, kpiT, guardian, cmpT', () => {
  const FULL = JSON.parse(readFileSync('/tmp/v36run/S.json', 'utf8')) as J;
  const G = ['cqA', 'cqSub', 'dspt', 'fft', 'kpi', 'kpiT', 'guardian'];
  const one = (sub: string, act: string, key: string, id: string, before: unknown, after: unknown) =>
    press(sub, act, [{ key, id, before, after } as never]);

  it('moves the saved copy in and loads it back the same', async () => {
    const st = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'gv|rm');
    for (const k of G) expect(st.body.needsImport).toContain(k);
    const imp = await call('POST', '/api/v1/v36/import', 'gv|rm', { today: TODAY, data: Object.fromEntries(G.map((k) => [k, FULL[k]])) });
    expect(imp.status, JSON.stringify(imp.body)).toBe(201);
    const d = imp.body.data as J;
    for (const k of G) expect(d[k], k).toEqual(FULL[k]);
    expect(Object.keys(d.cqA)).toEqual(Object.keys(FULL.cqA));
    expect(d.cmpT).toEqual(FULL.cmpT);
    const again = await call('GET', `/api/v1/v36/state?today=${TODAY}`, 'gv|crew');
    for (const k of G) expect(again.body.needsImport).not.toContain(k);
    expect(again.body.data.dspt).toEqual(FULL.dspt);
  });

  it('cqSet (governance or a manager) and cqSub once every question is answered', async () => {
    let cq = (await state()).cqA as Record<string, string>;
    const open = Object.keys(cq).filter((k) => cq[k] === '');
    expect(open.length).toBeGreaterThan(1);
    refused(await one('gv|crew', 'cqSet', 'cqA', open[0]!, '', 'P'), /only governance or a manager/);
    refused(await one('gv|aud', 'cqSet', 'cqA', open[0]!, '', 'P'), /read-only/);
    refused(await one('gv|gov', 'cqSet', 'cqA', open[0]!, '', 'Maybe'), /Pass, Partial, Fail or N\/A/, 400);
    cq = ok(await one('gv|gov', 'cqSet', 'cqA', open[0]!, '', 'F')).cqA;
    expect(cq[open[0]!]).toBe('F');
    const sub = { by: 'Rachel Hughes', on: `${TODAY} 09:00` };
    const n = open.length - 1;
    refused(await one('gv|gov', 'cqSub', 'cqSub', '_', null, sub), new RegExp(`${n} questions? (are|is) still unanswered`));
    ok(await press('gv|rm', 'cqSet', open.slice(1).map((k) => ({ key: 'cqA', id: k, before: '' as never, after: 'N' as never }))));
    refused(await one('gv|crew', 'cqSub', 'cqSub', '_', null, { ...sub, by: 'Alex Morgan' }), /not allowed/);
    refused(await one('gv|gov', 'cqSub', 'cqSub', '_', null, { ...sub, by: 'Dr. Helen Price' }), /your own name/, 400);
    const d = ok(await one('gv|gov', 'cqSub', 'cqSub', '_', null, sub));
    expect(d.cqSub).toEqual(sub);
    refused(await one('gv|gov', 'cqSub', 'cqSub', '_', sub, null), /stays submitted/);
  });

  it('dsptOk: an assertion marked in place (governance or a manager); nothing else changes', async () => {
    const b = (await state()).dspt as J;
    const i = (b.assert as [string, boolean][]).findIndex((a) => !a[1]);
    const a = JSON.parse(JSON.stringify(b)) as J;
    a.assert[i][1] = true;
    refused(await one('gv|fleet', 'dsptOk', 'dspt', '_', b, a), /not allowed/);
    refused(await one('gv|gov', 'dsptOk', 'dspt', '_', b, { ...a, due: '2030-01-01' }), /Only marking/, 400);
    const d = ok(await one('gv|gov', 'dsptOk', 'dspt', '_', b, a));
    expect(d.dspt).toEqual(a);
    const back = JSON.parse(JSON.stringify(a)) as J;
    back.assert[i][1] = false;
    refused(await one('gv|rm', 'dsptOk', 'dspt', '_', a, back), /Only marking/, 400);
    refused(await one('gv|rm', 'dsptOk', 'dspt', '_', b, a), /changed by someone else/, 409);
  });

  it('fftNew adds or replaces a month (governance or a manager)', async () => {
    const f = (await state()).fft as [string, number, number][];
    const last = f.at(-1)!;
    refused(await one('gv|fleet', 'fftNew', 'fft', last[0], last, [last[0], 80, 92]), /not allowed/);
    refused(await one('gv|gov', 'fftNew', 'fft', last[0], last, [last[0], 80, 120]), /between 0 and 100/, 400);
    let d = ok(await one('gv|gov', 'fftNew', 'fft', last[0], last, [last[0], 80, 92]));
    expect(d.fft.at(-1)).toEqual([last[0], 80, 92]);
    d = ok(await one('gv|rm', 'fftNew', 'fft', '2027-01', null, ['2027-01', 70, 95.5]));
    expect(d.fft.at(-1)).toEqual(['2027-01', 70, 95.5]);
    expect(d.fft.length).toBe(f.length + 1);
  });

  it('kpi, kpiT and guardian are read-only; cmpT follows the complaint rules (ruleOk: RM or Director)', async () => {
    const s = await state();
    expect((await one('gv|rm', 'x', 'kpi', s.kpi[0][0], s.kpi[0], [s.kpi[0][0], 1, 1, 1, 1])).status).toBe(403);
    expect((await one('gv|rm', 'x', 'kpiT', '_', s.kpiT, { ...s.kpiT, wait: 10 })).status).toBe(403);
    expect((await one('gv|rm', 'x', 'guardian', '_', s.guardian, 'Someone')).status).toBe(403);
    refused(await one('gv|gov', 'ruleOk', 'cmpT', '_', s.cmpT, { ack: 2, resp: 20 }), /not allowed/);
    const d = ok(await one('gv|rm', 'ruleOk', 'cmpT', '_', s.cmpT, { ack: 2, resp: 20 }));
    expect(d.cmpT).toEqual({ ack: 3, resp: 20 }); // read back from the rules, which did not change here
  });
});
