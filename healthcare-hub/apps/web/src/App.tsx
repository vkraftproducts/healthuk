import {
  Link,
  Navigate,
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AUTH_MESSAGES } from '@hub/contracts';
import { homePathFor } from '@hub/rules';
import { ApiError, type ApiClient } from './api.js';
import { UNKNOWN_ACCOUNT, type AuthClient } from './auth.js';
import { fmtDateTime } from './components.js';
import { SignIn } from './pages/SignIn.js';
import { NAV_ITEMS, canSee, navItemFor, type NavItem } from './nav.js';
import { ComingSoon } from './pages/ComingSoon.js';
import { Dashboard } from './pages/Dashboard.js';
import { Settings } from './pages/settings/Settings.js';
import { StaffList } from './pages/staff/StaffList.js';
import { StaffProfile } from './pages/staff/StaffProfile.js';
import { Fleet } from './pages/fleet/Fleet.js';
import { VehicleDetail } from './pages/fleet/VehicleDetail.js';
import { Compliance } from './pages/compliance/Compliance.js';
import { AuditRun } from './pages/compliance/AuditRun.js';
import { EventDetail } from './pages/compliance/EventDetail.js';
import { ReportIncident } from './pages/compliance/ReportIncident.js';
import { Inspection } from './pages/inspection/Inspection.js';
import { Premises } from './pages/premises/Premises.js';
import { Planner } from './pages/planner/Planner.js';
import { Reports } from './pages/reports/Reports.js';
import { SpeakUp } from './pages/speakup/SpeakUp.js';
import { Alerts } from './pages/alerts/Alerts.js';
import { MyRecord } from './pages/me/MyRecord.js';
import { AppContext, useApp } from './shell/AppContext.js';
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
  '/speak-up': SpeakUp,
  '/alerts': Alerts,
  '/me': MyRecord,
  '/report': ReportIncident,
  '/inspection': Inspection,
};

/** Pages are only rendered for roles that can use them; the server still checks every call. */
function guarded(item: NavItem, Page: () => JSX.Element) {
  return function Guarded() {
    const { me, orgId } = useApp();
    const packs = me.memberships.find((m) => m.organisationId === orgId)?.sectorPacks;
    return canSee(item, me.permissions, packs) ? <Page /> : <NoAccess title={item.label} />;
  };
}

function NoAccess({ title }: { title: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-hub-line bg-hub-card p-4">
      <h1 className="text-xl font-bold">{title}</h1>
      <p role="alert">Your role does not give access to this page.</p>
      <Link to="/" className="font-medium text-hub-teal-dark underline">
        Go to your home page
      </Link>
    </div>
  );
}

/**
 * Home page by role (WORKFLOWS A1): auditors land on the inspection view and dispatchers on the
 * work planner; managers and leads get the dashboard; everyone else a page of what they can use.
 */
function Home() {
  const { me, orgId } = useApp();
  const packs = me.memberships.find((m) => m.organisationId === orgId)?.sectorPacks;
  const home = homePathFor(me.permissions, packs);
  if (home === '/inspection' || home === '/planner') return <Navigate to={home} replace />;
  if (me.permissions.includes('dashboard.view')) return <Dashboard />;
  if (me.permissions.includes('staff.self.view')) return <Navigate to="/me" replace />;
  const mine = NAV_ITEMS.filter((n) => n.to !== '/' && canSee(n, me.permissions, packs));
  const crew = me.permissions.includes('crew.today.view');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Welcome, {me.user.displayName}</h1>
      {crew && (
        <section
          aria-label="Crew app"
          className="space-y-1 rounded-lg border border-hub-line bg-hub-card p-4"
        >
          <h2 className="font-semibold">Your shifts are in the crew app</h2>
          <p>
            Today&apos;s jobs, vehicle checks, defects and incident reports are done in the
            Healthcare Hub crew app on your work phone. Here on the web you can see your own record,
            upload certificates, acknowledge policies and raise a concern.
          </p>
        </section>
      )}
      {mine.length === 0 ? (
        <p role="status">
          Your role has no pages on the web yet. Use the crew app, or ask your administrator.
        </p>
      ) : (
        <ul aria-label="Your pages" className="grid gap-3 sm:grid-cols-2">
          {mine.map((n) => (
            <li key={n.to}>
              <Link
                to={n.to}
                className="block rounded-lg border border-hub-line bg-hub-card p-4 font-semibold text-hub-teal-dark underline"
              >
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function buildRouter(history?: RouterHistory) {
  const root = createRootRoute({ component: Shell });
  const index = createRoute({ getParentRoute: () => root, path: '/', component: Home });
  const others = NAV_ITEMS.filter((n) => n.to !== '/').map((n) =>
    createRoute({
      getParentRoute: () => root,
      path: n.to,
      component: guarded(
        n,
        PAGES[n.to] ?? (() => <ComingSoon title={n.label} milestone="later" />),
      ),
    }),
  );
  const detail = (path: string, Page: () => JSX.Element) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: guarded(navItemFor(path)!, Page),
    });
  const staffProfile = detail('/staff/$id', StaffProfile);
  const vehicleDetail = detail('/vehicles/$id', VehicleDetail);
  const auditRun = detail('/compliance/audits/$id', AuditRun);
  const eventDetail = detail('/compliance/events/$id', EventDetail);
  return createRouter({
    routeTree: root.addChildren([
      index,
      ...others,
      staffProfile,
      vehicleDetail,
      auditRun,
      eventDetail,
    ]),
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
  const clearOrgId = useCallback(() => {
    setOrgIdState(null);
    try {
      sessionStorage.removeItem('hub.orgId');
    } catch {
      /* storage unavailable */
    }
  }, []);

  const meQ = useQuery({
    queryKey: ['me', orgId],
    queryFn: () => api.me(orgId),
    // A busy moment (rate limit, restart) should not strand the user on the error screen.
    retry: (count, err) =>
      count < 3 && err instanceof ApiError && (err.status === 429 || err.status >= 500),
    retryDelay: (attempt) => 500 * 2 ** attempt,
    placeholderData: keepPreviousData,
  });
  const readyQ = useQuery({
    queryKey: ['readyz'],
    queryFn: () => api.readyz(),
    retry: false,
    refetchInterval: 60_000,
  });
  const router = useMemo(() => buildRouter(history), [history]);

  // Default to the first membership; drop a stale selection the server no longer accepts. A stored
  // organisation is stale when it is not among the memberships and the server did not accept it
  // as the active organisation (support access is accepted without a membership).
  const me = meQ.data;
  const stale =
    !!me &&
    !!orgId &&
    !me.memberships.some((m) => m.organisationId === orgId) &&
    me.activeOrganisationId !== orgId;
  const effectiveOrg = (stale ? null : orgId) ?? me?.memberships[0]?.organisationId ?? null;
  const live = useLiveUpdates(api, me ? effectiveOrg : null);
  if (me && (!orgId || stale)) {
    if (effectiveOrg) queueMicrotask(() => setOrgId(effectiveOrg));
    else if (orgId) queueMicrotask(clearOrgId);
  }
  // The server refusing the stored organisation must not lock the person out: forget it and ask
  // again without one.
  const refusedStored =
    meQ.isError &&
    !!orgId &&
    meQ.error instanceof ApiError &&
    [400, 403, 404].includes(meQ.error.status);
  if (refusedStored) queueMicrotask(clearOrgId);

  if (meQ.isError && !refusedStored) {
    const err = meQ.error;
    const unknown =
      (err instanceof ApiError &&
        err.status === 401 &&
        err.code === 'UNAUTHENTICATED' &&
        err.detail === AUTH_MESSAGES.unknownAccount) ||
      (!(err instanceof ApiError) && err.message === UNKNOWN_ACCOUNT);
    const inactive = err instanceof ApiError && err.status === 401;
    const unreachable = !(err instanceof ApiError) && !unknown;
    return (
      <div className="m-6 max-w-xl space-y-3 rounded-lg border border-red-700 bg-red-50 p-4 text-red-900">
        <p role="alert">
          {unknown ? (
            <strong>{AUTH_MESSAGES.unknownAccount}</strong>
          ) : inactive ? (
            <strong>{AUTH_MESSAGES.ended}</strong>
          ) : unreachable ? (
            <>
              <strong>We cannot reach the server. Try again.</strong>
              {meQ.dataUpdatedAt > 0 &&
                ` Last successful refresh ${fmtDateTime(new Date(meQ.dataUpdatedAt).toISOString())}.`}
            </>
          ) : (
            <>
              <strong>Your account could not be loaded.</strong> Try again, or sign in as someone
              else.
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-red-700 bg-hub-card px-3 py-1.5 text-sm"
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
  // Until the server has answered for the chosen organisation, the answer has no permissions:
  // showing it would flash "no pages" and an empty menu.
  const settling = !!me && !!effectiveOrg && me.activeOrganisationId !== effectiveOrg;
  if (!me || settling)
    return (
      <p role="status" className="m-6">
        Loading…
      </p>
    );

  const lastUpdated = meQ.dataUpdatedAt ? new Date(meQ.dataUpdatedAt) : null;
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
        lastUpdated,
        sourceOk: readyQ.data?.status === 'ready',
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
  // Local sign-in: a reload resumes the session from the refresh cookie before asking again.
  const [restoring, setRestoring] = useState(() => !!auth?.restore && !auth.isSignedIn());
  useEffect(() => {
    if (!restoring || !auth?.restore) return;
    let current = true;
    const done = (ok: boolean) => {
      if (!current) return;
      if (ok) setSignedIn(true);
      setRestoring(false);
    };
    auth.restore().then(done, () => done(false));
    return () => {
      current = false;
    };
  }, [auth, restoring]);
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
      setNotice(why ?? null);
      setSignedIn(false);
    },
    [auth, client],
  );
  if (auth && !signedIn && restoring)
    return (
      <p role="status" className="m-6">
        Checking your sign-in…
      </p>
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
