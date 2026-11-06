import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQuery,
} from '@tanstack/react-query';
import { useCallback, useMemo, useState, useEffect } from 'react';
import { ApiError, type ApiClient } from './api.js';
import type { AuthClient } from './auth.js';
import { NotSignedInError } from './auth.js';
import { SignIn } from './pages/SignIn.js';
import { NAV_ITEMS } from './nav.js';
import { ComingSoon } from './pages/ComingSoon.js';
import { Dashboard } from './pages/Dashboard.js';
import { Settings } from './pages/settings/Settings.js';
import { StaffList } from './pages/staff/StaffList.js';
import { StaffProfile } from './pages/staff/StaffProfile.js';
import { Fleet } from './pages/fleet/Fleet.js';
import { VehicleDetail } from './pages/fleet/VehicleDetail.js';
import { Compliance } from './pages/compliance/Compliance.js';
import { AuditRun } from './pages/compliance/AuditRun.js';
import { Premises } from './pages/premises/Premises.js';
import { Planner } from './pages/planner/Planner.js';
import { Reports } from './pages/reports/Reports.js';
import { AppContext } from './shell/AppContext.js';
import { Shell } from './shell/Shell.js';
import { useLiveUpdates } from './shell/useLiveUpdates.js';

/** Page for each top-level navigation item; anything not listed shows a "coming later" page. */
const PAGES: Record<string, () => JSX.Element> = {
  '/settings': Settings,
  '/staff': StaffList,
  '/vehicles': Fleet,
  '/compliance': Compliance,
  '/premises': Premises,
  '/planner': Planner,
  '/reports': Reports,
};

function buildRouter(history?: RouterHistory) {
  const root = createRootRoute({ component: Shell });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: Dashboard });
  const others = NAV_ITEMS.filter((n) => n.to !== '/').map((n) =>
    createRoute({
      getParentRoute: () => root,
      path: n.to,
      component: PAGES[n.to] ?? (() => <ComingSoon title={n.label} milestone="later" />),
    }),
  );
  const staffProfile = createRoute({
    getParentRoute: () => root,
    path: '/staff/$id',
    component: StaffProfile,
  });
  const vehicleDetail = createRoute({
    getParentRoute: () => root,
    path: '/vehicles/$id',
    component: VehicleDetail,
  });
  const auditRun = createRoute({
    getParentRoute: () => root,
    path: '/compliance/audits/$id',
    component: AuditRun,
  });
  return createRouter({
    routeTree: root.addChildren([index, ...others, staffProfile, vehicleDetail, auditRun]),
    history,
  });
}

function Authenticated({
  api,
  history,
  signOut,
}: {
  api: ApiClient;
  history?: RouterHistory;
  signOut?: (notice?: string) => void;
}) {
  const [orgId, setOrgIdState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('hub.orgId');
    } catch {
      return null;
    }
  });
  const setOrgId = useCallback((id: string) => {
    setOrgIdState(id);
    try {
      sessionStorage.setItem('hub.orgId', id);
    } catch {
      /* storage unavailable: selection lives in memory only */
    }
  }, []);

  const meQ = useQuery({
    queryKey: ['me', orgId],
    queryFn: () => api.me(orgId),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const readyQ = useQuery({
    queryKey: ['readyz'],
    queryFn: () => api.readyz(),
    retry: false,
    refetchInterval: 60_000,
  });
  const router = useMemo(() => buildRouter(history), [history]);

  // Default to the first membership; drop a stale selection the server no longer accepts.
  const me = meQ.data;
  const effectiveOrg = orgId ?? me?.memberships[0]?.organisationId ?? null;
  const live = useLiveUpdates(api, me ? effectiveOrg : null);
  if (me && !orgId && effectiveOrg) queueMicrotask(() => setOrgId(effectiveOrg));

  // A stored development session the sign-in server no longer accepts: back to the sign-in page.
  const sessionEnded = meQ.error instanceof NotSignedInError;
  useEffect(() => {
    if (sessionEnded) signOut?.('Your session has ended. Sign in again.');
  }, [sessionEnded, signOut]);

  if (meQ.isError) {
    const inactive = meQ.error instanceof ApiError && meQ.error.status === 401;
    return (
      <div className="m-6 max-w-xl space-y-3 rounded-lg border border-red-700 bg-red-50 p-4 text-red-900">
        <p role="alert">
          {inactive ? (
            <>
              <strong>Your account is not active here.</strong> Your sign-in was refused or your
              access has ended. Ask your organisation administrator, or sign in as someone else.
            </>
          ) : (
            <>
              <strong>Source unavailable.</strong> Could not load your account. Check your
              connection and try again.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-red-700 bg-white px-3 py-1.5 text-sm"
            onClick={() => void meQ.refetch()}
          >
            Try again
          </button>
          {signOut && (
            <button
              type="button"
              className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white"
              onClick={() => signOut()}
            >
              Sign in again
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!me)
    return (
      <p role="status" className="m-6">
        Loading…
      </p>
    );

  return (
    <AppContext.Provider
      value={{
        api,
        me,
        orgId: effectiveOrg,
        setOrgId,
        refresh: () => {
          void meQ.refetch();
          void readyQ.refetch();
        },
        sourceOk: !readyQ.isError && (!readyQ.data || readyQ.data.status === 'ready'),
        live,
        signOut: signOut ? () => signOut('You have signed out.') : undefined,
      }}
    >
      <RouterProvider router={router} />
    </AppContext.Provider>
  );
}

export function App({
  api,
  auth,
  history = createMemoryHistoryIfNeeded(),
}: {
  api: ApiClient;
  /** Omitted in component tests: the app then behaves as already signed in. */
  auth?: AuthClient;
  history?: RouterHistory;
}) {
  const [client] = useState(() => new QueryClient());
  const [signedIn, setSignedIn] = useState(() => !auth || auth.isSignedIn());
  const [notice, setNotice] = useState<string | null>(null);
  const signOut = useCallback(
    (why?: string) => {
      auth?.signOut();
      client.clear(); // nothing from the previous session stays on screen or in memory
      try {
        sessionStorage.removeItem('hub.orgId');
      } catch {
        /* storage unavailable */
      }
      // The next sign-in starts on the dashboard, not on the page the last person left open.
      if (history) history.replace('/');
      else window.history.replaceState(null, '', '/');
      setNotice(why ?? null);
      setSignedIn(false);
    },
    [auth, client, history],
  );
  if (auth && !signedIn) {
    return (
      <SignIn
        auth={auth}
        notice={notice}
        onSignedIn={() => {
          setNotice(null);
          setSignedIn(true);
        }}
      />
    );
  }
  return (
    <QueryClientProvider client={client}>
      <Authenticated api={api} history={history} signOut={auth ? signOut : undefined} />
    </QueryClientProvider>
  );
}

function createMemoryHistoryIfNeeded(): RouterHistory | undefined {
  return typeof window === 'undefined' ? createMemoryHistory({ initialEntries: ['/'] }) : undefined;
}
