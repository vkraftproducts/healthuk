import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { addDays, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 batch 1 (17 Nov 2026): safeguarding referrals, vehicle accidents, vehicle medicines and
// gases, controlled drug balance checks.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'GET' | 'POST',
  url: string,
  o: { sub?: string; body?: unknown; org?: string } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|manager' })}`,
      'x-org-id': o.org ?? ORG,
      ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

beforeAll(async () => {
  ({ app, db } = await makeApp(urls));
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const today = () => londonDate(new Date());
const tag = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const letters = (k: number) =>
  Array.from({ length: k }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const userIdOf = async (sub: string) =>
  (await call('GET', '/api/v1/me', { sub })).body.user.id as string;

async function vehicle() {
  const r = await call('POST', '/api/v1/vehicles', {
    sub: 'dev|fleet',
    body: {
      registration: `VX${10 + Math.floor(Math.random() * 90)}${letters(3)}`,
      callsign: `V36-${tag()}`,
      type: 'PTS_VEHICLE',
      baseLocationId: SEED_IDS.locWatford,
      seats: 4,
      wheelchairCapacity: 1,
    },
  });
  expect(r.status).toBe(201);
  return r.body as J;
}

describe('safeguarding referrals register (v36 screen 37)', () => {
  it('is restricted to people who may see safeguarding cases', async () => {
    for (const sub of ['dev|crew', 'dev|dispatcher', 'dev|fleet']) {
      expect((await call('GET', '/api/v1/safeguarding-referrals', { sub })).status).toBe(403);
    }
    expect(
      (await call('GET', '/api/v1/safeguarding-referrals', { sub: 'dev|governance' })).status,
    ).toBe(200);
  });

  it('records a concern, refers it with the local authority reference, then closes with the outcome', async () => {
    const crew = await userIdOf('dev|crew');
    const r = await call('POST', '/api/v1/safeguarding-referrals', {
      sub: 'dev|governance',
      body: {
        about: 'ADULT',
        category: 'SELF_NEGLECT',
        patientRef: 'PT-4390',
        details: 'Home found without heating or food on collection; patient agreed to referral.',
        raisedByUserId: crew,
        raisedOn: today(),
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^SGR-\d+$/);
    expect(r.body.status).toBe('RAISED');
    expect(r.body.cqcNotificationId).toBeNull();

    // Outcome before a referral decision is refused.
    const early = await call('POST', `/api/v1/safeguarding-referrals/${r.body.id}/outcome`, {
      sub: 'dev|governance',
      body: { outcome: 'Support plan in place', outcomeOn: today() },
    });
    expect(early.status).toBe(422);

    const ref = await call('POST', `/api/v1/safeguarding-referrals/${r.body.id}/refer`, {
      sub: 'dev|governance',
      body: {
        referredOn: today(),
        agency: 'Synthetic County Council adult safeguarding',
        agencyReference: 'SCC-ASC-1001',
      },
    });
    expect(ref.status).toBe(201);
    expect(ref.body.status).toBe('REFERRED');
    expect(ref.body.decidedByName).toBeTruthy();

    const again = await call('POST', `/api/v1/safeguarding-referrals/${r.body.id}/refer`, {
      sub: 'dev|governance',
      body: { referredOn: today(), agency: 'Another team', agencyReference: 'X-2' },
    });
    expect(again.status).toBe(409);

    const out = await call('POST', `/api/v1/safeguarding-referrals/${r.body.id}/outcome`, {
      sub: 'dev|governance',
      body: { outcome: 'Care package arranged by the council', outcomeOn: today() },
    });
    expect(out.status).toBe(201);
    expect(out.body.status).toBe('CLOSED');

    const list = await call('GET', '/api/v1/safeguarding-referrals', { sub: 'dev|governance' });
    expect((list.body.data as J[]).some((x) => x.id === r.body.id)).toBe(true);
    expect(typeof list.body.summary.open).toBe('number');
  });

  it('an abuse allegation drafts a CQC notification and cannot be left unreferred', async () => {
    const crew = await userIdOf('dev|crew');
    const r = await call('POST', '/api/v1/safeguarding-referrals', {
      sub: 'dev|governance',
      body: {
        about: 'ADULT',
        category: 'FINANCIAL',
        patientRef: 'PT-4462',
        details: 'Patient said a relative is taking their pension; crew reported it the same day.',
        raisedByUserId: crew,
        raisedOn: today(),
        abuseAllegation: true,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.cqcNotificationId).toBeTruthy();
    expect(r.body.cqcNotificationCode).toMatch(/^NTF-/);
    const no = await call('POST', `/api/v1/safeguarding-referrals/${r.body.id}/not-referred`, {
      sub: 'dev|governance',
      body: { reason: 'We think this is a family matter and not for the council.' },
    });
    expect(no.status).toBe(422);
  });

  it('refuses names in place of a patient reference and dates in the future', async () => {
    const crew = await userIdOf('dev|crew');
    const bad = await call('POST', '/api/v1/safeguarding-referrals', {
      sub: 'dev|governance',
      body: {
        about: 'CHILD',
        category: 'NEGLECT',
        patientRef: 'John Smith',
        details: 'Child left alone at the address on arrival for the outpatient journey.',
        raisedByUserId: crew,
        raisedOn: today(),
      },
    });
    expect(bad.status).toBe(400);
    const future = await call('POST', '/api/v1/safeguarding-referrals', {
      sub: 'dev|governance',
      body: {
        about: 'CHILD',
        category: 'NEGLECT',
        patientRef: 'PT-4201',
        details: 'Child left alone at the address on arrival for the outpatient journey.',
        raisedByUserId: crew,
        raisedOn: addDays(today(), 3),
      },
    });
    expect(future.status).toBe(400);
  });
});

describe('vehicle accidents and damage (v36 screen 42)', () => {
  it('a vehicle not safe to drive gets a critical stop-use defect and the accident closes only after release', async () => {
    const v = await vehicle();
    const a = await call('POST', '/api/v1/vehicle-accidents', {
      sub: 'dev|crew',
      body: {
        vehicleId: v.id,
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        description: 'Reversed into a bollard in the hospital bay; rear step bent.',
        thirdParty: 'None',
        roadworthy: false,
      },
    });
    expect(a.status).toBe(201);
    expect(a.body.code).toMatch(/^ACC-\d+$/);
    expect(a.body.defectId).toBeTruthy();
    expect(a.body.stateText).toMatch(/Off the road/);

    const d = await call('GET', `/api/v1/defects/${a.body.defectId}`, { sub: 'dev|fleet' });
    expect(d.status).toBe(200);
    expect(d.body.severity).toBe('CRITICAL');
    expect(d.body.stopUse).toBe(true);

    const veh = await call('GET', `/api/v1/vehicles/${v.id}`, { sub: 'dev|fleet' });
    expect(veh.body.status).not.toBe('AVAILABLE');

    const close = await call('POST', `/api/v1/vehicle-accidents/${a.body.id}/close`, {
      sub: 'dev|fleet',
      body: { note: 'Claim settled' },
    });
    expect(close.status).toBe(422);

    // Crew cannot record the insurer claim.
    const crewIns = await call('POST', `/api/v1/vehicle-accidents/${a.body.id}/insurer`, {
      sub: 'dev|crew',
      body: { insurerRef: 'INS-CLM-1', insurerNotifiedOn: today() },
    });
    expect(crewIns.status).toBe(403);
    const ins = await call('POST', `/api/v1/vehicle-accidents/${a.body.id}/insurer`, {
      sub: 'dev|fleet',
      body: { insurerRef: 'INS-CLM-44120', insurerNotifiedOn: today() },
    });
    expect(ins.status).toBe(201);
    expect(ins.body.insurerRef).toBe('INS-CLM-44120');
  });

  it('a safe-to-drive accident raises no defect; an injury needs the incident linked before closing', async () => {
    const v = await vehicle();
    const a = await call('POST', '/api/v1/vehicle-accidents', {
      sub: 'dev|fleet',
      body: {
        vehicleId: v.id,
        occurredAt: new Date(Date.now() - 7_200_000).toISOString(),
        description: 'Wing mirror clipped by a passing van while parked at the station.',
        thirdParty: 'Van, registration noted, driver details exchanged',
        injuries: true,
        roadworthy: true,
      },
    });
    expect(a.status).toBe(201);
    expect(a.body.defectId).toBeNull();
    const close = await call('POST', `/api/v1/vehicle-accidents/${a.body.id}/close`, {
      sub: 'dev|fleet',
      body: { note: 'Mirror replaced' },
    });
    expect(close.status).toBe(422);
    const list = await call('GET', `/api/v1/vehicle-accidents?vehicleId=${v.id}`, {
      sub: 'dev|fleet',
    });
    expect(list.body.data).toHaveLength(1);
  });

  it('refuses an accident time in the future', async () => {
    const v = await vehicle();
    const a = await call('POST', '/api/v1/vehicle-accidents', {
      sub: 'dev|fleet',
      body: {
        vehicleId: v.id,
        occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
        description: 'This has not happened yet and must be refused.',
        thirdParty: 'None',
        roadworthy: true,
      },
    });
    expect(a.status).toBe(400);
  });
});

describe('vehicle medicines and gases (v36 screen 42)', () => {
  it('the fleet lead lists items, crew check every item, shortages and expiry show', async () => {
    const v = await vehicle();
    const crewAdd = await call('POST', '/api/v1/vehicle-stock/items', {
      sub: 'dev|crew',
      body: { vehicleId: v.id, kind: 'MEDICAL_GAS', name: 'Oxygen D cylinder', expectedQty: 2 },
    });
    expect(crewAdd.status).toBe(403);
    const o2 = await call('POST', '/api/v1/vehicle-stock/items', {
      sub: 'dev|fleet',
      body: { vehicleId: v.id, kind: 'MEDICAL_GAS', name: 'Oxygen D cylinder', expectedQty: 2 },
    });
    expect(o2.status).toBe(201);
    const gel = await call('POST', '/api/v1/vehicle-stock/items', {
      sub: 'dev|fleet',
      body: { vehicleId: v.id, kind: 'MEDICINE', name: 'Glucose gel', expectedQty: 4 },
    });
    expect(gel.status).toBe(201);
    const dup = await call('POST', '/api/v1/vehicle-stock/items', {
      sub: 'dev|fleet',
      body: { vehicleId: v.id, kind: 'MEDICINE', name: 'glucose GEL', expectedQty: 1 },
    });
    expect(dup.status).toBe(409);

    // Every listed item must be counted.
    const partial = await call('POST', '/api/v1/vehicle-stock/checks', {
      sub: 'dev|crew',
      body: {
        vehicleId: v.id,
        lines: [{ itemId: o2.body.id, found: 2, expiresOn: addDays(today(), 300) }],
      },
    });
    expect(partial.status).toBe(400);

    const check = await call('POST', '/api/v1/vehicle-stock/checks', {
      sub: 'dev|crew',
      body: {
        vehicleId: v.id,
        lines: [
          { itemId: o2.body.id, found: 1, expiresOn: addDays(today(), 300), sealIntact: true },
          { itemId: gel.body.id, found: 4, expiresOn: addDays(today(), -2) },
        ],
      },
    });
    expect(check.status).toBe(201);
    expect(check.body.shortCount).toBe(1);
    expect(check.body.expiredCount).toBe(1);

    const stock = await call('GET', '/api/v1/vehicle-stock', { sub: 'dev|crew' });
    const mine = (stock.body.data as J[]).find((x) => x.vehicleId === v.id)!;
    const byName = new Map((mine.items as J[]).map((i) => [i.name, i]));
    expect(byName.get('Oxygen D cylinder')!.state).toBe('SHORT');
    expect(byName.get('Glucose gel')!.state).toBe('EXPIRED');
    expect(mine.lastCheck.shortCount).toBe(1);
  });
});

describe('controlled drug balance checks (v36 screen 42)', () => {
  it('needs a different, named witness who signs as themselves; a difference needs an incident', async () => {
    const crew2 = await userIdOf('dev|crew2');
    const me = await userIdOf('dev|crew');
    const self = await call('POST', '/api/v1/controlled-drug-checks', {
      sub: 'dev|crew',
      body: {
        drug: 'Synthetic CD ampoules 10 mg/ml',
        store: 'Station safe',
        registerBalance: 10,
        countedBalance: 10,
        witnessUserId: me,
      },
    });
    expect(self.status).toBe(422);

    const c = await call('POST', '/api/v1/controlled-drug-checks', {
      sub: 'dev|crew',
      body: {
        drug: 'Synthetic CD ampoules 10 mg/ml',
        store: 'Station safe',
        registerBalance: 10,
        countedBalance: 9,
        witnessUserId: crew2,
      },
    });
    expect(c.status).toBe(201);
    expect(c.body.code).toMatch(/^CDR-\d+$/);
    expect(c.body.discrepancy).toBe(true);
    expect(c.body.status).toBe('AWAITING_WITNESS');

    const wrong = await call('POST', `/api/v1/controlled-drug-checks/${c.body.id}/witness`, {
      sub: 'dev|crew',
      body: { agree: true },
    });
    expect(wrong.status).toBe(403);
    const ok = await call('POST', `/api/v1/controlled-drug-checks/${c.body.id}/witness`, {
      sub: 'dev|crew2',
      body: { agree: true },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('WITNESSED');
    expect(ok.body.needsIncident).toBe(true);
    const twice = await call('POST', `/api/v1/controlled-drug-checks/${c.body.id}/witness`, {
      sub: 'dev|crew2',
      body: { agree: true },
    });
    expect(twice.status).toBe(409);

    // Crew cannot link the incident; governance can.
    const crewLink = await call('POST', `/api/v1/controlled-drug-checks/${c.body.id}/link-event`, {
      sub: 'dev|crew',
      body: { eventId: c.body.id },
    });
    expect(crewLink.status).toBe(403);
  });
});

describe('other organisations', () => {
  it('see none of these records', async () => {
    for (const path of [
      '/api/v1/vehicle-accidents',
      '/api/v1/vehicle-stock',
      '/api/v1/controlled-drug-checks',
    ]) {
      const r = await call('GET', path, { sub: 'dev|other-manager', org: SEED_IDS.orgOther });
      expect(r.status).toBe(200);
      expect(
        (r.body.data as J[]).every(
          (x) =>
            !String(x.vehicleLabel ?? '').startsWith('V36-') &&
            !String(x.drug ?? '').startsWith('Synthetic CD'),
        ),
      ).toBe(true);
    }
    const s = await call('GET', '/api/v1/safeguarding-referrals', {
      sub: 'dev|other-manager',
      org: SEED_IDS.orgOther,
    });
    expect(s.status).toBe(200);
    expect((s.body.data as J[]).some((x) => x.patientRef === 'PT-4390')).toBe(false);
  });
});
