import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Db } from '@hub/db';
import { addDays, addMonths, londonDate } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SEED_IDS, makeApp, sign } from './harness.js';

// v36 batch 4 (17 Nov 2026): business continuity, statement of purpose, DSP Toolkit.
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
const ORG = SEED_IDS.orgExample;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST', url: string, o: { sub?: string; body?: unknown } = {}) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub: o.sub ?? 'dev|governance' })}`,
      'x-org-id': ORG,
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
const userIdOf = async (sub: string) =>
  (await call('GET', '/api/v1/me', { sub })).body.user.id as string;

describe('business continuity (v36 screen 43)', () => {
  it('a new plan is due a test; a result short of a pass needs a follow-up; a pass sets the next due date', async () => {
    const owner = await userIdOf('dev|fleet');
    const p = await call('POST', '/api/v1/continuity-plans', {
      body: {
        title: 'Two vehicles off the road at once',
        steps: 'Move journeys by priority; call mutual aid; tell commissioners of delays.',
        ownerUserId: owner,
      },
    });
    expect(p.status).toBe(201);
    expect(p.body.code).toMatch(/^BCP-\d+$/);
    expect(p.body.testOverdue).toBe(true);

    const noFollow = await call('POST', `/api/v1/continuity-plans/${p.body.id}/tests`, {
      sub: 'dev|fleet',
      body: { testedOn: today(), method: 'TABLETOP', result: 'ACTIONS_RAISED' },
    });
    expect(noFollow.status).toBe(400);
    const t = await call('POST', `/api/v1/continuity-plans/${p.body.id}/tests`, {
      sub: 'dev|fleet',
      body: { testedOn: today(), method: 'TABLETOP', result: 'PASSED', notes: 'Two journeys late' },
    });
    expect(t.status).toBe(201);
    expect(t.body.testOverdue).toBe(false);
    expect(t.body.testDue).toBe(addMonths(today(), 12));
    expect(t.body.tests).toHaveLength(1);
    expect(t.body.tests[0].actionId).toBeNull();

    // "Actions raised" needs an owner and a date, and raises a tracked action.
    const noOwner = await call('POST', `/api/v1/continuity-plans/${p.body.id}/tests`, {
      sub: 'dev|fleet',
      body: { testedOn: today(), method: 'LIVE', result: 'ACTIONS_RAISED', followUp: 'Add a spare key safe at base' },
    });
    expect(noOwner.status).toBe(400);
    const raised = await call('POST', `/api/v1/continuity-plans/${p.body.id}/tests`, {
      sub: 'dev|fleet',
      body: {
        testedOn: today(),
        method: 'LIVE',
        result: 'ACTIONS_RAISED',
        followUp: 'Add a spare key safe at base',
        actionOwnerUserId: owner,
        actionDeadline: addDays(today(), 30),
      },
    });
    expect(raised.status).toBe(201);
    const withAction = (raised.body.tests as J[]).find((x) => x.result === 'ACTIONS_RAISED')!;
    expect(withAction.actionCode).toMatch(/^ACT-/);
    expect(withAction.actionStatus).toBe('OPEN');
    const actions = await call('GET', '/api/v1/actions', { sub: 'dev|manager' });
    const a = (actions.body.data as J[]).find((x) => x.id === withAction.actionId)!;
    expect(a.sourceType).toBe('CONTINUITY');
    expect(a.title).toMatch(/spare key safe/);

    const crew = await call('POST', `/api/v1/continuity-plans/${p.body.id}/tests`, {
      sub: 'dev|crew',
      body: { testedOn: today(), method: 'TABLETOP', result: 'PASSED' },
    });
    expect(crew.status).toBe(403);
  });
});

describe('statement of purpose (v36 screen 40)', () => {
  it('a second person publishes; publishing supersedes the old version and drafts the CQC notification', async () => {
    const d1 = await call('POST', '/api/v1/statement-of-purpose', {
      body: { summary: 'Added the Watford base and transport services.' },
    });
    expect(d1.status).toBe(201);
    const dup = await call('POST', '/api/v1/statement-of-purpose', {
      body: { summary: 'Another draft' },
    });
    expect(dup.status).toBe(409);
    const self = await call('POST', `/api/v1/statement-of-purpose/${d1.body.id}/publish`);
    expect(self.status).toBe(422);
    const pub = await call('POST', `/api/v1/statement-of-purpose/${d1.body.id}/publish`, {
      sub: 'dev|manager',
    });
    expect(pub.status).toBe(201);
    expect(pub.body.status).toBe('PUBLISHED');
    expect(pub.body.notificationCode).toMatch(/^NTF-/);

    const d2 = await call('POST', '/api/v1/statement-of-purpose', {
      body: { summary: 'New registered manager.' },
    });
    expect(d2.body.versionNo).toBe(d1.body.versionNo + 1);
    await call('POST', `/api/v1/statement-of-purpose/${d2.body.id}/publish`, {
      sub: 'dev|manager',
    });
    const list = await call('GET', '/api/v1/statement-of-purpose');
    const v1 = (list.body.data as J[]).find((x) => x.id === d1.body.id)!;
    expect(v1.status).toBe('SUPERSEDED');
    expect((list.body.data as J[]).filter((x) => x.status === 'PUBLISHED')).toHaveLength(1);
  });
});

describe('DSP Toolkit (v36 screen 39)', () => {
  it('starts a year with the standard items, marks one in place with evidence, then records the submission', async () => {
    const year = `20${30 + Math.floor(Math.random() * 60)}-${String(Math.floor(Math.random() * 90) + 10)}`;
    const a = await call('POST', '/api/v1/dspt', { body: { year, dueOn: addDays(today(), 200) } });
    expect(a.status).toBe(201);
    expect(a.body.total).toBe(8);
    expect(a.body.inPlace).toBe(0);
    const dup = await call('POST', '/api/v1/dspt', {
      body: { year, dueOn: addDays(today(), 200) },
    });
    expect(dup.status).toBe(409);

    const item = (a.body.items as J[])[1]!;
    const m = await call('POST', `/api/v1/dspt/items/${item.id}/in-place`, {
      body: { evidenceNote: 'DPO named in the privacy notice and the org chart' },
    });
    expect(m.status).toBe(201);
    expect(m.body.inPlace).toBe(1);

    const crew = await call('POST', `/api/v1/dspt/items/${(a.body.items as J[])[2]!.id}/in-place`, {
      sub: 'dev|crew',
      body: { evidenceNote: 'Not allowed' },
    });
    expect(crew.status).toBe(403);

    const s = await call('POST', `/api/v1/dspt/${a.body.id}/submit`, {
      body: { submittedOn: today(), outcome: 'APPROACHING_STANDARDS', reference: 'DSPT-ODS-X1' },
    });
    expect(s.status).toBe(201);
    expect(s.body.status).toBe('SUBMITTED');
    const late = await call('POST', `/api/v1/dspt/items/${(a.body.items as J[])[3]!.id}/in-place`, {
      body: { evidenceNote: 'Too late now' },
    });
    expect(late.status).toBe(409);
  });
});
