import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuditController } from '../src/modules/audit/audit.controller.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import { MeController } from '../src/modules/identity/me.controller.js';
import { OpenApiController } from '../src/modules/openapi.controller.js';
import { AUTH_ONLY_KEY, PERMISSION_KEY, PUBLIC_KEY } from '../src/common/decorators.js';
import { createLogger } from '../src/logger.js';
import { SEED_IDS, makeApp, sign } from './harness.js';

const urls = inject('urls');
let app: NestFastifyApplication;
let close: () => Promise<void>;

const MANAGER = 'dev|manager';
const OTHER = 'dev|other-manager';
const j = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function get(
  path: string,
  opts: { sub?: string; org?: string; amr?: string[]; token?: string } = {},
) {
  const token = opts.token ?? (opts.sub ? await sign({ sub: opts.sub, amr: opts.amr }) : undefined);
  return app.inject({
    method: 'GET',
    url: path,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.org ? { 'x-org-id': opts.org } : {}),
    },
  });
}
async function post(path: string, opts: { sub: string; org?: string; amr?: string[] }) {
  const token = await sign({ sub: opts.sub, amr: opts.amr });
  return app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${token}`, ...(opts.org ? { 'x-org-id': opts.org } : {}) },
  });
}

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  close = async () => {
    await app.close();
    await made.db.close();
  };
});
afterAll(async () => close());

describe('public probes', () => {
  it('liveness and readiness need no token', async () => {
    expect((await get('/healthz')).statusCode).toBe(200);
    const ready = await get('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(j(ready)).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });
  it('publishes OpenAPI', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(j(res).paths)).toContain('/api/v1/me');
  });
});

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    const res = await get('/api/v1/me');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(j(res).code).toBe('UNAUTHENTICATED');
  });
  it.each([
    ['garbage', async () => 'not-a-jwt'],
    ['wrong issuer', () => sign({ sub: MANAGER, iss: 'https://evil.example' })],
    ['wrong audience', () => sign({ sub: MANAGER, aud: 'someone-else' })],
    ['expired', () => sign({ sub: MANAGER, expiresIn: Math.floor(Date.now() / 1000) - 60 })],
    ['signed with another key', () => sign({ sub: MANAGER, wrongKey: true })],
  ])('rejects a token that is %s', async (_n, make) => {
    const res = await get('/api/v1/me', { token: await make() });
    expect(res.statusCode).toBe(401);
  });
  it('rejects a valid token for an unknown subject', async () => {
    expect((await get('/api/v1/me', { sub: 'dev|ghost' })).statusCode).toBe(401);
  });
});

describe('leavers and suspended users', () => {
  it('returns 401 USER_INACTIVE on the next call after a user is suspended', async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    await su.query(
      `INSERT INTO app_user (idp_subject, email, display_name, status)
       VALUES ('dev|leaver','leaver@example.test','Ex Staff','LEAVER')`,
    );
    await su.end();
    const res = await get('/api/v1/me', { sub: 'dev|leaver' });
    expect(res.statusCode).toBe(401);
    expect(j(res).code).toBe('USER_INACTIVE');
  });
});

describe('/me and organisation selection', () => {
  it('lists memberships and permissions for the selected organisation', async () => {
    const res = await get('/api/v1/me', { sub: MANAGER, org: SEED_IDS.orgExample });
    expect(res.statusCode).toBe(200);
    const body = j(res);
    expect(body.memberships).toEqual([
      expect.objectContaining({
        organisationId: SEED_IDS.orgExample,
        organisationName: 'Example organisation',
        roleKey: 'REGISTERED_MANAGER',
      }),
    ]);
    expect(body.permissions).toEqual(
      expect.arrayContaining(['admin.audit.verify', 'admin.audit.view', 'dashboard.view']),
    );
    expect(body.permissions).not.toContain('support.access.read');
    expect(body.mfa).toEqual({ required: true, satisfied: true });
  });
  it('works with no organisation selected (empty permissions)', async () => {
    const body = j(await get('/api/v1/me', { sub: MANAGER }));
    expect(body.permissions).toEqual([]);
    expect(body.activeOrganisationId).toBeNull();
  });
  it('answers 404 (not 403) for an organisation the user does not belong to', async () => {
    const res = await get('/api/v1/me', { sub: MANAGER, org: SEED_IDS.orgOther });
    expect(res.statusCode).toBe(404);
    expect(j(res).code).toBe('NOT_FOUND');
  });
  it('does not reveal the other organisation in memberships', async () => {
    const body = j(await get('/api/v1/me', { sub: MANAGER }));
    expect(JSON.stringify(body)).not.toContain('Other organisation');
  });
  it('404s on a malformed X-Org-Id', async () => {
    expect((await get('/api/v1/me', { sub: MANAGER, org: 'not-a-uuid' })).statusCode).toBe(404);
  });
});

describe('authorisation', () => {
  it('requires an organisation for permissioned routes (400 ORG_REQUIRED)', async () => {
    const res = await get('/api/v1/audit-log', { sub: MANAGER });
    expect(res.statusCode).toBe(400);
    expect(j(res).code).toBe('ORG_REQUIRED');
  });
  it('enforces MFA for privileged roles (403 MFA_REQUIRED)', async () => {
    const res = await get('/api/v1/audit-log', {
      sub: MANAGER,
      org: SEED_IDS.orgExample,
      amr: ['pwd'],
    });
    expect(res.statusCode).toBe(403);
    expect(j(res).code).toBe('MFA_REQUIRED');
  });
  it('allows a permitted user with MFA', async () => {
    const res = await get('/api/v1/audit-log', { sub: MANAGER, org: SEED_IDS.orgExample });
    expect(res.statusCode).toBe(200);
    expect(j(res)).toHaveProperty('data');
  });
  it('denies a member who lacks the permission (403 FORBIDDEN)', async () => {
    // A crew member of the other organisation has no audit permissions.
    const res = await get('/api/v1/audit-log', { sub: 'dev|other-crew', org: SEED_IDS.orgOther });
    expect(res.statusCode).toBe(403);
    expect(j(res).code).toBe('FORBIDDEN');
  });
  it("cannot use one organisation's permissions in another", async () => {
    const res = await get('/api/v1/audit-log', { sub: OTHER, org: SEED_IDS.orgExample });
    expect(res.statusCode).toBe(404);
  });
});

describe('audit log API', () => {
  it('verifies the chain and records the verification itself', async () => {
    const res = await post('/api/v1/audit-log/verify-chain', {
      sub: MANAGER,
      org: SEED_IDS.orgExample,
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).intact).toBe(true);
    const list = j(
      await get('/api/v1/audit-log?entity=audit_log', { sub: MANAGER, org: SEED_IDS.orgExample }),
    );
    expect(list.data[0]).toMatchObject({
      action: 'admin.audit.verify',
      entity: 'audit_log',
      actorType: 'USER',
    });
    const again = await post('/api/v1/audit-log/verify-chain', {
      sub: MANAGER,
      org: SEED_IDS.orgExample,
    });
    expect(j(again).intact).toBe(true);
  });
  it('paginates newest first with a cursor', async () => {
    const first = j(
      await get('/api/v1/audit-log?limit=1', { sub: MANAGER, org: SEED_IDS.orgExample }),
    );
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = j(
      await get(`/api/v1/audit-log?limit=1&cursor=${first.nextCursor}`, {
        sub: MANAGER,
        org: SEED_IDS.orgExample,
      }),
    );
    expect(BigInt(second.data[0].seq)).toBeLessThan(BigInt(first.data[0].seq));
  });
});

describe('error responses', () => {
  it('returns problem+json for validation errors without echoing input', async () => {
    const res = await get('/api/v1/audit-log?limit=abc&entity=SECRET-VALUE-123', {
      sub: MANAGER,
      org: SEED_IDS.orgExample,
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(j(res).code).toBe('VALIDATION_FAILED');
    expect(res.body).not.toContain('SECRET-VALUE-123');
    expect(res.body).not.toContain('abc');
  });
  it('returns 404 problem+json for unknown routes', async () => {
    const res = await get('/api/v1/nope', { sub: MANAGER });
    expect(res.statusCode).toBe(404);
  });
});

describe('route declarations (deny by default)', () => {
  it('every controller route is Public, AuthenticatedOnly or declares a permission', () => {
    const reflector = new Reflector();
    const missing: string[] = [];
    for (const C of [HealthController, OpenApiController, MeController, AuditController]) {
      for (const name of Object.getOwnPropertyNames(C.prototype)) {
        const fn = (C.prototype as unknown as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof fn !== 'function') continue;
        if (Reflect.getMetadata('path', fn) === undefined) continue; // not a route handler
        const ok =
          reflector.get(PUBLIC_KEY, fn) ||
          reflector.get(AUTH_ONLY_KEY, fn) ||
          (reflector.get(PERMISSION_KEY, fn) as string[] | undefined)?.length;
        if (!ok) missing.push(`${C.name}.${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('logging redaction (no PII in logs)', () => {
  it('redacts personal data, tokens and query strings', () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(c, _e, cb) {
        chunks.push(String(c));
        cb();
      },
    });
    const log = createLogger('info', sink);
    log.info(
      {
        user: { email: 'alex@example.test', displayName: 'Alex Morgan' },
        req: {
          id: 'r1',
          method: 'GET',
          url: '/api/v1/jobs?patient=Jane+Doe',
          headers: { authorization: 'Bearer abc.def.ghi' },
        },
        job: { patientRef: 'PX-1', address: '1 High St', phone: '07000' },
      },
      'test',
    );
    const out = chunks.join('');
    for (const secret of [
      'alex@example.test',
      'Alex Morgan',
      'abc.def.ghi',
      'Jane',
      'PX-1',
      '1 High St',
      '07000',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('/api/v1/jobs');
  });
});
