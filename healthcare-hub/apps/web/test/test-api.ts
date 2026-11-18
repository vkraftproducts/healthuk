import type { MeResponse } from '@hub/contracts';
import type { ApiClient } from '../src/api.js';

export const TEST_ORG = '01900000-0000-7000-8000-000000000001';

/** Stable /me for component tests — avoids org-settling stuck on "Loading…". */
export function testMe(permissions: string[], overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: {
      id: '01900000-0000-7000-8000-000000000101',
      email: 'm@example.test',
      displayName: 'Dev',
    },
    memberships: [
      {
        organisationId: TEST_ORG,
        organisationName: 'Meadowbank Patient Transport',
        locationId: null,
        roleKey: 'X',
        roleName: 'X',
      },
    ],
    permissions,
    activeOrganisationId: TEST_ORG,
    mfa: { required: true, satisfied: true },
    ...overrides,
  };
}

type GetFn = (path: string, orgId: string | null) => Promise<unknown>;

/** Default GET stub: empty lists; layer route-specific payloads in the test. */
export function defaultGet(
  stubs: Record<string, unknown> | ((path: string) => unknown | undefined),
): GetFn {
  return async (path) => {
    if (typeof stubs === 'function') {
      const hit = stubs(path);
      if (hit !== undefined) return hit;
    } else if (path in stubs) return stubs[path];
    if (path.includes('/locations')) return { data: [] };
    if (path.includes('/organisations/') && !path.includes('/locations')) {
      return { sectorPacks: ['ambulance'] };
    }
    if (path.startsWith('/api/v1/alerts/count')) return { open: 0, critical: 0 };
    return { data: [] };
  };
}

export function testApi(
  permissions: string[],
  get: GetFn,
  extra: Partial<ApiClient> = {},
): ApiClient {
  return {
    me: async () => testMe(permissions),
    readyz: async () => ({ status: 'ready' }),
    get,
    send: async () => ({}),
    ...extra,
  };
}