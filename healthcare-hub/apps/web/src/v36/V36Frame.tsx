import { useEffect, useMemo } from 'react';
import { ApiError } from '../api.js';
import { useApp } from '../shell/AppContext.js';

/** Our system roles → the v36 "View as" person. The first match wins. */
const ROLE_MAP: [string, string][] = [
  ['REGISTERED_MANAGER', 'rm'],
  ['ORG_ADMIN', 'rm'],
  ['DIRECTOR', 'dir'],
  ['GOVERNANCE_LEAD', 'gov'],
  ['HR_LEAD', 'hr'],
  ['FLEET_LEAD', 'fleet'],
  ['PREMISES_LEAD', 'fleet'],
  ['DISPATCHER', 'disp'],
  ['CREW', 'crew'],
  ['AUDITOR', 'aud'],
];

export interface V36Bridge {
  get(path: string): Promise<{ exists: boolean; data: unknown }>;
  put(path: string, data: unknown): Promise<void>;
  /** Step 2: connected collections built from the real tables. */
  state(today: string): Promise<{
    connected: {
      key: string;
      shape: 'map' | 'list' | 'value';
      idField: string;
      writable: boolean;
    }[];
    needsImport: string[];
    me: { name: string; initials: string; staffNo: string | null };
    data: Record<string, unknown>;
  }>;
  /** Step 2: one-time move of the saved copy into empty tables. */
  importData(body: unknown): Promise<{ data: Record<string, unknown> }>;
  /** Step 2: the records one v36 button changed; returns those collections as now stored. */
  sync(body: unknown): Promise<{ data: Record<string, unknown> }>;
  role: string;
  /** "View as" stays available (local demo only). */
  viewAs: boolean;
  signOut?: () => void;
}

declare global {
  interface Window {
    __hhV36?: V36Bridge;
  }
}

/**
 * The web app is the v36 front end itself (decision 18 Nov 2026), so every screen, font, colour,
 * transition and click is v36's. v36 runs in a same-origin frame; its data is the organisation's
 * copy on the server (v36_workspace_doc), reached through v36's own shared-copy seam.
 */
export function V36Frame() {
  const { api, me, orgId, signOut } = useApp();
  const roleKey = me.memberships.find((m) => m.organisationId === orgId)?.roleKey ?? '';
  const role = ROLE_MAP.find(([k]) => k === roleKey)?.[1] ?? 'aud';
  const viewAs = import.meta.env.DEV;

  const bridge = useMemo<V36Bridge>(
    () => ({
      role,
      viewAs,
      signOut,
      get: async (path) =>
        (await api.get(`/api/v1/v36/workspace/docs/${path}`, orgId)) as {
          exists: boolean;
          data: unknown;
        },
      state: async (today) =>
        (await api.get(`/api/v1/v36/state?today=${today}`, orgId)) as Awaited<
          ReturnType<V36Bridge['state']>
        >,
      importData: async (b) =>
        (await api.send('POST', '/api/v1/v36/import', orgId, b)) as {
          data: Record<string, unknown>;
        },
      sync: async (b) => {
        try {
          return (await api.send('POST', '/api/v1/v36/sync', orgId, b)) as {
            data: Record<string, unknown>;
          };
        } catch (e) {
          throw { detail: e instanceof ApiError ? e.detail : null };
        }
      },
      put: async (path, data) => {
        try {
          await api.send('PUT', `/api/v1/v36/workspace/docs/${path}`, orgId, { data });
        } catch (e) {
          // v36 reads this code as "you can view the shared copy but not change it".
          throw { code: e instanceof ApiError && e.status === 403 ? 'invalid_argument' : 'error' };
        }
      },
    }),
    [api, orgId, role, viewAs, signOut],
  );

  window.__hhV36 = bridge;
  // Nothing from another person or organisation may linger in this browser's v36 keys.
  useMemo(() => {
    try {
      for (const k of ['hh_wf_v36', 'hh_ledger_v36', 'hh_snap_v36', 'hh_tour_v36'])
        localStorage.removeItem(k);
      localStorage.setItem('hh_role_v36', role);
      localStorage.setItem('hh_shared_v36', '1');
    } catch {
      /* storage blocked: v36 falls back to memory */
    }
  }, [orgId, me.user.id, role]);
  useEffect(() => {
    window.__hhV36 = bridge;
    return () => {
      if (window.__hhV36 === bridge) delete window.__hhV36;
    };
  }, [bridge]);

  return (
    <iframe
      key={`${orgId}:${me.user.id}`}
      title="Healthcare Hub"
      src="/v36/app.html"
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', border: 0 }}
    />
  );
}
