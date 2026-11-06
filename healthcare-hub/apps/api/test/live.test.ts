import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LiveChanges } from '../src/modules/live/live.service.js';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
const ORG = SEED_IDS.orgExample;
const OTHER_ORG = SEED_IDS.orgOther;
const LOCATION = SEED_IDS.locWatford;
const PATH = '/api/v1/live/changes';

let app: NestFastifyApplication;
let close: () => Promise<void>;
let base: string;

async function listen(a: NestFastifyApplication): Promise<string> {
  await a.listen(0, '127.0.0.1');
  const { port } = a.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A consumer reading the stream the way the web app does: fetch, because tokens stay out of URLs. */
async function watch(sub: string, org: string, from = base) {
  const controller = new AbortController();
  const res = await fetch(`${from}${PATH}`, {
    headers: { authorization: `Bearer ${await sign({ sub })}`, 'x-org-id': org },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  let text = '';
  let ended = false;
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    ended = true;
  })().catch(() => undefined);
  const until = async (test: () => boolean, ms = 5000) => {
    const start = Date.now();
    while (!test() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
    return test();
  };
  await until(() => text.includes('event: ready'));
  return {
    text: () => text,
    ended: () => ended,
    changes: () => text.split('event: change').length - 1,
    until,
    stop: async () => {
      controller.abort();
      await pump;
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 900));

async function call(
  method: 'GET' | 'POST',
  url: string,
  sub = 'dev|manager',
  org = ORG,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': org,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, body: res.json() };
}
let staffNo = 8800;
const addStaff = (displayName: string) =>
  call('POST', '/api/v1/staff', 'dev|manager', ORG, {
    staffNo: `ST-${staffNo++}`,
    displayName,
    primaryLocationId: LOCATION,
  });

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  close = () => made.db.close();
  base = await listen(app);
});
afterAll(async () => {
  await app.close();
  await close();
});

describe('live changes stream', () => {
  it('needs a signed-in member of the organisation', async () => {
    expect((await app.inject({ method: 'GET', url: PATH })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'GET',
      url: PATH,
      headers: {
        authorization: `Bearer ${await sign({ sub: 'dev|other-manager' })}`,
        'x-org-id': ORG,
      },
    });
    expect(res.statusCode).toBe(404); // never reveal that the organisation exists
  });

  it('signals a change, with no record data in the stream', async () => {
    const s = await watch('dev|dispatcher', ORG);
    expect((await addStaff('Synthetic Private Name')).status).toBe(201);
    expect(await s.until(() => s.changes() > 0)).toBe(true);
    expect(s.text()).not.toContain('Synthetic Private Name');
    expect(s.text()).not.toContain(ORG);
    await s.stop();
  });

  it('never tells one organisation about another', async () => {
    const mine = await watch('dev|dispatcher', ORG);
    const theirs = await watch('dev|other-manager', OTHER_ORG);
    expect((await addStaff('Synthetic Isolated')).status).toBe(201);
    expect(await mine.until(() => mine.changes() > 0)).toBe(true);
    await settle();
    expect(theirs.changes()).toBe(0);
    await mine.stop();
    await theirs.stop();
  });

  it('does not signal on reads, which would make every screen refresh for ever', async () => {
    const s = await watch('dev|dispatcher', ORG);
    await settle();
    const before = s.changes();
    for (const url of [
      '/api/v1/me',
      '/api/v1/dashboard/summary',
      '/api/v1/dashboard/actions',
      '/api/v1/staff',
      '/api/v1/vehicles',
      '/api/v1/actions',
      '/api/v1/audit-runs',
      '/api/v1/alerts',
      `/api/v1/organisations/${ORG}/locations`,
    ])
      expect((await call('GET', url)).status, url).toBe(200);
    await settle();
    expect(s.changes()).toBe(before);
    await s.stop();
  });

  it('coalesces a burst of changes into few signals', async () => {
    const s = await watch('dev|dispatcher', ORG);
    await settle();
    const before = s.changes();
    await Promise.all(Array.from({ length: 8 }, (_, i) => addStaff(`Synthetic Burst ${i}`)));
    await settle();
    const signals = s.changes() - before;
    expect(signals).toBeGreaterThan(0);
    expect(signals).toBeLessThan(8);
    await s.stop();
  });

  it('forgets a stream as soon as the screen closes it', async () => {
    const live = app.get(LiveChanges) as unknown as { listeners: Map<string, Set<unknown>> };
    const s = await watch('dev|dispatcher', ORG);
    expect(live.listeners.get(ORG)?.size).toBe(1);
    await s.stop();
    await s.until(() => !live.listeners.get(ORG));
    expect(live.listeners.get(ORG)).toBeUndefined();
  });

  it('ends after its maximum life, so a reconnect passes the access checks again', async () => {
    const short = await makeApp(urls, [], { LIVE_STREAM_MAX_SECONDS: '1' });
    const from = await listen(short.app);
    const s = await watch('dev|dispatcher', ORG, from);
    expect(await s.until(() => s.ended(), 4000)).toBe(true);
    await short.app.close();
    await short.db.close();
  });

  it('every organisation table signals, apart from the ones with no screen', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    const { rows } = await su.query<{ table_name: string }>(`
      SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND c.column_name = 'organisation_id'
         AND t.table_type = 'BASE TABLE'
         AND NOT EXISTS (
           SELECT 1 FROM pg_trigger g
            WHERE g.tgrelid = ('public.' || quote_ident(c.table_name))::regclass
              AND g.tgname = 'live_change')
       ORDER BY 1`);
    await su.end();
    expect(rows.map((r) => r.table_name)).toEqual([
      'audit_log',
      'idempotency_key',
      'notification_delivery',
      'notification_outbox',
      'org_counter',
      'push_message',
      'retention_log',
    ]);
  });
});
