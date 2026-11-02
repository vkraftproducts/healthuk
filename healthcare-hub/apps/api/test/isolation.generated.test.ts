import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SYSTEM_ROLES } from '@hub/contracts';
import { discoverRoutes, type Route } from './route-discovery.js';
import { SEED_IDS, makeApp, sign } from './harness.js';

/**
 * TEST_PLAN §4: generated isolation suite. For EVERY non-public route (discovered from controller
 * metadata, so new endpoints are covered automatically) assert:
 *   - no token                         -> 401
 *   - member of ANOTHER organisation   -> 404 (never reveals the record or organisation exists)
 *   - member without the permission    -> 403
 */
const urls = inject('urls');
let app: NestFastifyApplication;
let closeAll: () => Promise<void>;

// The probe user holds the CREW role in the other organisation; skip routes crew is entitled to call.
const crewPermissions = new Set<string>(
  SYSTEM_ROLES.find((x) => x.key === 'CREW')?.permissions ?? [],
);
const routes = discoverRoutes().filter((r) => !r.isPublic);

beforeAll(async () => {
  const made = await makeApp(urls);
  app = made.app;
  closeAll = async () => {
    await app.close();
    await made.db.close();
  };
});
afterAll(async () => closeAll());

const call = async (r: Route, headers: Record<string, string>) =>
  (await app.inject({ method: r.method, url: r.url, headers })).statusCode;

describe('generated isolation suite [UAT-05]', () => {
  it('discovers the protected routes', () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  describe.each(routes)('$method $url ($name)', (r) => {
    it('rejects an unauthenticated call (401)', async () => {
      expect(await call(r, {})).toBe(401);
    });

    it('answers 404 to a member of another organisation using this organisation id', async () => {
      const token = await sign({ sub: 'dev|other-manager' });
      const status = await call(r, {
        authorization: `Bearer ${token}`,
        'x-org-id': SEED_IDS.orgExample,
      });
      expect(status).toBe(404);
    });

    it.runIf(r.needsPermission && !r.permissions.some((p) => crewPermissions.has(p)))(
      'answers 403 to a member without the permission',
      async () => {
        const token = await sign({ sub: 'dev|other-crew' });
        const status = await call(r, {
          authorization: `Bearer ${token}`,
          'x-org-id': SEED_IDS.orgOther,
        });
        expect(status).toBe(403);
      },
    );
  });
});
