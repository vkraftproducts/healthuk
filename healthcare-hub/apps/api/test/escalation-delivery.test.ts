import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { SYSTEM_USER_ID, type Db } from '@hub/db';
import {
  EmailSender,
  ESCALATION_SUBJECT,
  OutboxEmailTransport,
  OutboxPushTransport,
  PushSender,
  WebPushTransport,
  drainNotificationOutbox,
  escalationMessage,
  outboxKey,
  planEscalationDeliveries,
  type DeliveryDevice,
  type EmailTransport,
  type PushTransport,
} from '@hub/domain';
import { formatDate, londonDate, retryDelayMinutes, MAX_DELIVERY_ATTEMPTS } from '@hub/rules';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeApp, sign } from './harness.js';

/**
 * Email and push delivery of escalations. Runs in its own synthetic organisation so the open
 * alerts and settings of other suites cannot change what is planned here.
 */
const urls = inject('urls');
let app: NestFastifyApplication;
let db: Db;
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DAY = 86_400_000;
const APP_URL = 'https://hub.example.test';
// Synthetic only: text a careless implementation might leak into a message.
const PATIENT_TEXT = 'Synthetic Patient Jo Bloggs 943 476 5919, 1 Example Road';

async function sql<T = J>(text: string, params: unknown[] = []): Promise<T[]> {
  const su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
  try {
    return (await su.query(text, params)).rows as T[];
  } finally {
    await su.end();
  }
}

let ORG = '';
// `deputy` is an ordinary crew member used as "someone else" in the self-scoped route tests.
const people: Record<'hr' | 'manager' | 'owner' | 'deputy' | 'fleet', { id: string; sub: string }> =
  {} as never;

async function person(key: keyof typeof people, role: string) {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
  const [u] = await sql(
    `INSERT INTO app_user (idp_subject, email, display_name, status)
     VALUES ($1, $2, 'Synthetic Person', 'ACTIVE') RETURNING id`,
    [`dev|esc-${key}-${tag}`, `esc-${key}-${tag}@example.test`],
  );
  await sql(
    `INSERT INTO membership (organisation_id, user_id, role_id)
     SELECT $1, $2, id FROM role WHERE organisation_id IS NULL AND key = $3`,
    [ORG, u!.id, role],
  );
  people[key] = { id: u!.id as string, sub: `dev|esc-${key}-${tag}` };
}

async function alert(o: { daysAgo: number; sourceType?: string; owner?: string | null }) {
  const [a] = await sql(
    `INSERT INTO alert (organisation_id, source_type, source_id, severity, reason_code, reason_text,
                        owner_user_id, raised_at)
     VALUES ($1, $2, $3, 'HIGH', 'OVERDUE', $4, $5, now() - make_interval(days => $6)) RETURNING id, source_id`,
    [ORG, o.sourceType ?? 'STAFF', randomUUID(), PATIENT_TEXT, o.owner ?? null, o.daysAgo],
  );
  return { id: a!.id as string, sourceId: a!.source_id as string };
}

const sys = () => ({ orgId: ORG, userId: SYSTEM_USER_ID });
const plan = (now = new Date()) =>
  db.withTenant(sys(), (tx) => planEscalationDeliveries(tx, ORG, now));
const drain = (senders: Parameters<typeof drainNotificationOutbox>[3], now = new Date()) =>
  db.withTenant(sys(), (tx) => drainNotificationOutbox(tx, ORG, now, senders, APP_URL));
const rowsFor = (alertId: string) =>
  sql(
    `SELECT * FROM notification_outbox WHERE organisation_id = $1 AND alert_id = $2
     ORDER BY escalation_stage, channel, recipient_user_id`,
    [ORG, alertId],
  );

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  sub: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${await sign({ sub })}`,
      'x-org-id': ORG,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as J };
}

const expoToken = () => `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`;

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  db = made.db;
  const [o] = await sql(
    `INSERT INTO organisation (name) VALUES ('Synthetic Escalation Delivery Org') RETURNING id`,
  );
  ORG = o!.id as string;
  await person('hr', 'HR_LEAD');
  await person('manager', 'REGISTERED_MANAGER');
  await person('owner', 'HR_LEAD');
  await person('deputy', 'CREW');
  await person('fleet', 'FLEET_LEAD');
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('escalation message content (non-negotiable 7)', () => {
  it('is generic: no patient data, no codes, no CQC rating, a UK date and an opaque link', () => {
    const now = new Date('2026-11-06T23:30:00Z'); // still 6 Nov in London (GMT)
    const sourceId = randomUUID();
    const m = escalationMessage({
      stage: 'LEAD',
      severity: 'HIGH',
      sourceType: 'STAFF',
      sourceId,
      now,
    });
    expect(m.subject).toBe(ESCALATION_SUBJECT);
    expect(m.body).toContain(`Date: ${formatDate(londonDate(now))} (UK time).`);
    expect(m.body).toContain('6 Nov 2026');
    expect(m.linkPath).toBe(`/staff/${sourceId}`);
    const text = `${m.subject}\n${m.body}`;
    expect(text).not.toMatch(/\d{3}\s?\d{3}\s?\d{4}/); // NHS-number-like
    expect(text).not.toMatch(/patient|rating/i);
    expect(m.linkPath).not.toContain('?');
  });

  it('requirement alerts link to the alerts page, never a query string', () => {
    const m = escalationMessage({
      stage: 'MANAGER',
      severity: 'CRITICAL',
      sourceType: 'REQUIREMENT',
      sourceId: randomUUID(),
      now: new Date(),
    });
    expect(m.linkPath).toBe('/alerts');
    expect(m.body).toContain('registered manager');
  });
});

describe('outbox creation and idempotency', () => {
  it('queues email for the lead at the lead stage, not for the manager or the owner', async () => {
    const a = await alert({ daysAgo: 2, owner: people.owner.id });
    await plan();
    const rows = await rowsFor(a.id);
    const emailTo = rows.filter((r) => r.channel === 'EMAIL').map((r) => r.recipient_user_id);
    expect(emailTo).toContain(people.hr.id);
    expect(emailTo).not.toContain(people.manager.id);
    expect(emailTo).not.toContain(people.owner.id); // the owner already has it
    expect(emailTo).not.toContain(people.fleet.id); // a staff item is not fleet's
    const hr = rows.find((r) => r.recipient_user_id === people.hr.id && r.channel === 'EMAIL')!;
    expect(hr.status).toBe('PENDING');
    expect(hr.escalation_stage).toBe('LEAD');
    expect(hr.idempotency_key).toBe(outboxKey(a.id, 'LEAD', people.hr.id, 'EMAIL'));
    expect(`${hr.subject} ${hr.body} ${hr.link_path}`).not.toContain('Bloggs');
    expect(hr.link_path).toBe(`/staff/${a.sourceId}`);
  });

  it('is idempotent per (escalation, recipient, channel)', async () => {
    const a = await alert({ daysAgo: 2 });
    await plan();
    const first = await rowsFor(a.id);
    await plan();
    await plan();
    expect(await rowsFor(a.id)).toHaveLength(first.length);
    await expect(
      sql(
        `INSERT INTO notification_outbox (organisation_id, alert_id, escalation_stage, recipient_user_id,
           channel, idempotency_key, subject, body, link_path)
         VALUES ($1, $2, 'LEAD', $3, 'EMAIL', $4, 's', 'b', '/alerts')`,
        [ORG, a.id, people.hr.id, outboxKey(a.id, 'LEAD', people.hr.id, 'EMAIL')],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('at the manager stage tells the registered manager, and the lead once', async () => {
    const a = await alert({ daysAgo: 8 });
    await plan();
    const rows = (await rowsFor(a.id)).filter((r) => r.channel === 'EMAIL');
    expect(
      rows.filter((r) => r.recipient_user_id === people.manager.id).map((r) => r.escalation_stage),
    ).toEqual(['MANAGER']);
    expect(
      rows.filter((r) => r.recipient_user_id === people.hr.id).map((r) => r.escalation_stage),
    ).toEqual(['LEAD']);
  });

  it('does not announce stages reached long ago, new alerts or snoozed alerts', async () => {
    const old = await alert({ daysAgo: 40 });
    const fresh = await alert({ daysAgo: 0 });
    const snoozed = await alert({ daysAgo: 3 });
    await sql(`UPDATE alert SET snoozed_until = now() + interval '2 days' WHERE id = $1`, [
      snoozed.id,
    ]);
    await plan();
    expect(await rowsFor(old.id)).toHaveLength(0);
    expect(await rowsFor(fresh.id)).toHaveLength(0);
    expect(await rowsFor(snoozed.id)).toHaveLength(0);
  });

  it('queues push only for people with a registered device, and honours their switches', async () => {
    const reg = await call('POST', '/api/v1/me/push-devices', people.hr.sub, {
      kind: 'EXPO',
      token: expoToken(),
    });
    expect(reg.status).toBe(201);
    const off = await call('PUT', '/api/v1/me/notification-preferences', people.manager.sub, {
      email: false,
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ email: false, push: true });
    const a = await alert({ daysAgo: 8 });
    await plan();
    const rows = await rowsFor(a.id);
    const pushTo = rows.filter((r) => r.channel === 'PUSH').map((r) => r.recipient_user_id);
    expect(pushTo).toEqual([people.hr.id]);
    const managerRows = rows.filter((r) => r.recipient_user_id === people.manager.id);
    expect(managerRows).toHaveLength(0); // email off, and no push device
    await call('PUT', '/api/v1/me/notification-preferences', people.manager.sub, { email: true });
  });
});

describe('draining the outbox', () => {
  it('sends generic email with an opaque link and marks it SENT', async () => {
    const a = await alert({ daysAgo: 2 });
    await plan();
    const transport = new OutboxEmailTransport();
    await drain({ email: new EmailSender(transport), push: new PushSender({}) });
    const row = (await rowsFor(a.id)).find(
      (r) => r.recipient_user_id === people.hr.id && r.channel === 'EMAIL',
    )!;
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1);
    const mail = transport.sent.find((m) => m.text.includes(`${APP_URL}/staff/${a.sourceId}`))!;
    expect(mail).toBeDefined();
    expect(mail.subject).toBe(ESCALATION_SUBJECT);
    expect(`${mail.subject}\n${mail.text}`).not.toContain('Bloggs');
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(/943 ?476 ?5919|Example Road|OVERDUE/);
  });

  it('retries with exponential backoff, then FAILED after the maximum attempts', async () => {
    const a = await alert({ daysAgo: 2 });
    let t = new Date();
    await plan(t);
    const failing: EmailTransport = {
      send: async () => {
        throw Object.assign(new Error('smtp said no to someone@example.test'), {
          code: 'ECONNECTION',
        });
      },
    };
    const senders = { email: new EmailSender(failing), push: new PushSender({}) };
    const key = outboxKey(a.id, 'LEAD', people.hr.id, 'EMAIL');
    const get = async () =>
      (
        await sql(
          `SELECT * FROM notification_outbox WHERE organisation_id = $1 AND idempotency_key = $2`,
          [ORG, key],
        )
      )[0]!;

    await drain(senders, t);
    let row = await get();
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('ECONNECTION');
    expect(row.last_error).not.toContain('@');
    expect(new Date(row.next_attempt_at).getTime()).toBe(
      t.getTime() + retryDelayMinutes(1) * 60_000,
    );

    // Not due yet: nothing happens.
    await drain(senders, new Date(t.getTime() + 30_000));
    expect((await get()).attempts).toBe(1);

    for (let n = 2; n <= MAX_DELIVERY_ATTEMPTS; n++) {
      t = new Date(new Date(row.next_attempt_at).getTime());
      await drain(senders, t);
      row = await get();
      expect(row.attempts).toBe(n);
      if (n < MAX_DELIVERY_ATTEMPTS) {
        expect(row.status).toBe('PENDING');
        expect(new Date(row.next_attempt_at).getTime()).toBe(
          t.getTime() + retryDelayMinutes(n) * 60_000,
        );
      }
    }
    expect(row.status).toBe('FAILED');
    await drain(senders, new Date(t.getTime() + DAY));
    expect((await get()).attempts).toBe(MAX_DELIVERY_ATTEMPTS);
  });

  it('cancels rows whose alert is no longer open', async () => {
    const a = await alert({ daysAgo: 2 });
    await plan();
    await sql(`UPDATE alert SET state = 'RESOLVED', resolved_at = now() WHERE id = $1`, [a.id]);
    const transport = new OutboxEmailTransport();
    await drain({ email: new EmailSender(transport), push: new PushSender({}) });
    const rows = await rowsFor(a.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'CANCELLED' && r.last_error === 'NO_LONGER_OPEN')).toBe(
      true,
    );
    expect(transport.sent.some((m) => m.text.includes(a.sourceId))).toBe(false);
  });

  it('pushes fixed text with the alert id only, and revokes tokens the service rejects', async () => {
    const good = expoToken();
    const bad = expoToken();
    const r1 = await call('POST', '/api/v1/me/push-devices', people.fleet.sub, {
      kind: 'EXPO',
      token: good,
    });
    const r2 = await call('POST', '/api/v1/me/push-devices', people.fleet.sub, {
      kind: 'EXPO',
      token: bad,
    });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const a = await alert({ daysAgo: 2, sourceType: 'DEFECT' });
    await plan();
    const outbox = new OutboxPushTransport();
    const picky: PushTransport = {
      send: async (devices: readonly DeliveryDevice[], content) => {
        const results = await outbox.send(
          devices.filter((d) => d.token !== bad),
          content,
        );
        return devices.map((d) =>
          d.token === bad
            ? { ok: false, invalidToken: true, error: 'DeviceNotRegistered' }
            : results.shift()!,
        );
      },
    };
    await drain({
      email: new EmailSender(new OutboxEmailTransport()),
      push: new PushSender({ EXPO: picky }),
    });
    const row = (await rowsFor(a.id)).find(
      (r) => r.channel === 'PUSH' && r.recipient_user_id === people.fleet.id,
    )!;
    expect(row.status).toBe('SENT');
    const sent = outbox.sent.find((s) => s.content.data.id === a.id)!;
    expect(sent.content).toEqual({
      title: 'Healthcare Hub',
      body: ESCALATION_SUBJECT,
      data: { type: 'ESCALATION', id: a.id, path: '/vehicles' },
    });
    const [revoked] = await sql(`SELECT revoked_at FROM push_device WHERE id = $1`, [r2.body.id]);
    expect(revoked!.revoked_at).not.toBeNull();
    const [kept] = await sql(`SELECT revoked_at FROM push_device WHERE id = $1`, [r1.body.id]);
    expect(kept!.revoked_at).toBeNull();
  });
});

describe('push device registration (self-scoped)', () => {
  it('registers, lists without the token, re-registers idempotently and removes', async () => {
    const token = expoToken();
    const r = await call('POST', '/api/v1/me/push-devices', people.deputy.sub, {
      kind: 'EXPO',
      token,
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: 'EXPO', revokedAt: null });
    expect(JSON.stringify(r.body)).not.toContain(token);
    const again = await call('POST', '/api/v1/me/push-devices', people.deputy.sub, {
      kind: 'EXPO',
      token,
    });
    expect(again.body.id).toBe(r.body.id);
    const list = await call('GET', '/api/v1/me/push-devices', people.deputy.sub);
    expect(list.body.data.map((d: J) => d.id)).toEqual([r.body.id]);
    expect(JSON.stringify(list.body)).not.toContain(token);
    const [a] = await sql(
      `SELECT count(*)::int AS n FROM audit_log WHERE organisation_id = $1
         AND action = 'notifications.push_device.register' AND entity_id = $2`,
      [ORG, r.body.id],
    );
    expect(a!.n).toBe(1);

    // Someone else cannot see or remove it.
    expect(
      (await call('DELETE', `/api/v1/me/push-devices/${r.body.id}`, people.hr.sub)).status,
    ).toBe(404);
    const del = await call('DELETE', `/api/v1/me/push-devices/${r.body.id}`, people.deputy.sub);
    expect(del.status).toBe(200);
    expect(del.body.revokedAt).not.toBeNull();
    expect((await call('GET', '/api/v1/me/push-devices', people.deputy.sub)).body.data).toEqual([]);
  });

  it('moves a shared device to whoever registers it now', async () => {
    const token = expoToken();
    const first = await call('POST', '/api/v1/me/push-devices', people.deputy.sub, {
      kind: 'EXPO',
      token,
    });
    const second = await call('POST', '/api/v1/me/push-devices', people.owner.sub, {
      kind: 'EXPO',
      token,
    });
    expect(second.body.id).not.toBe(first.body.id);
    const [old] = await sql(`SELECT revoked_at FROM push_device WHERE id = $1`, [first.body.id]);
    expect(old!.revoked_at).not.toBeNull();
  });

  it('accepts a Web Push subscription and refuses bad input', async () => {
    const web = await call('POST', '/api/v1/me/push-devices', people.deputy.sub, {
      kind: 'WEB_PUSH',
      endpoint: `https://push.example.test/send/${randomUUID()}`,
      keys: { p256dh: 'BExampleSyntheticKey000000000', auth: 'authsecret00' },
    });
    expect(web.status).toBe(201);
    expect(web.body.kind).toBe('WEB_PUSH');
    for (const bad of [
      { kind: 'EXPO', token: 'not-a-token' },
      { kind: 'WEB_PUSH', endpoint: 'http://push.example.test/insecure' },
      { kind: 'SMS', token: 'x' },
      { kind: 'EXPO', token: expoToken(), extra: 'field' },
    ])
      expect((await call('POST', '/api/v1/me/push-devices', people.deputy.sub, bad)).status).toBe(
        400,
      );
  });

  it('keeps preferences per person, defaulting both on', async () => {
    const d = await call('GET', '/api/v1/me/notification-preferences', people.fleet.sub);
    expect(d.body).toEqual({ email: true, push: true, organisation: { email: true, push: true } });
    expect(
      (await call('PUT', '/api/v1/me/notification-preferences', people.fleet.sub, {})).status,
    ).toBe(400);
    const u = await call('PUT', '/api/v1/me/notification-preferences', people.fleet.sub, {
      push: false,
    });
    expect(u.body).toMatchObject({ email: true, push: false });
    expect(
      (await call('GET', '/api/v1/me/notification-preferences', people.hr.sub)).body.push,
    ).toBe(true);
    await call('PUT', '/api/v1/me/notification-preferences', people.fleet.sub, { push: true });
  });
});

describe('Web Push transport (VAPID, no payload)', () => {
  it('signs a VAPID JWT for the push service origin and treats 410 as a gone subscription', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x as string, 'base64url'),
      Buffer.from(jwk.y as string, 'base64url'),
    ]).toString('base64url');
    const d = privateKey.export({ format: 'jwk' }).d as string;
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: url.includes('gone') ? 410 : 201 });
    }) as unknown as typeof fetch;
    const t = new WebPushTransport(
      { subject: 'mailto:ops@example.test', publicKey: pub, privateKey: d },
      fetchFn,
    );
    const res = await t.send([
      { id: '1', kind: 'WEB_PUSH', token: 'https://push.example.test/ok/abc' },
      { id: '2', kind: 'WEB_PUSH', token: 'https://push.example.test/gone/def' },
    ]);
    expect(res).toEqual([{ ok: true }, { ok: false, invalidToken: true, error: 'HTTP_410' }]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.body).toBeUndefined();
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization!)!;
    expect(m[2]).toBe(pub);
    const [h, p, s] = m[1]!.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(claims.aud).toBe('https://push.example.test');
    expect(claims.sub).toBe('mailto:ops@example.test');
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
  });
});
