import { Link, Outlet, useRouter } from '@tanstack/react-router';
import { StatusBadge } from '@hub/ui';
import { NAV_ITEMS } from '../nav.js';
import { useList, useOne } from '../pages/settings/hooks.js';
import { useApp } from './AppContext.js';

const londonDate = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: 'Europe/London',
});
const londonTime = new Intl.DateTimeFormat('en-GB', {
  timeStyle: 'short',
  timeZone: 'Europe/London',
});

/** Sector pack -> service name shown in the breadcrumb (wireframe 01). */
const SERVICE_NAME: Record<string, string> = {
  ambulance: 'Ambulance service',
  dental: 'Dental practice',
  'care-home': 'Care home',
};

/** "Meadowbank Patient Transport / Watford / Ambulance service" from the user's scope. */
function useScope(orgId: string | null) {
  const { me } = useApp();
  const org = useOne<{ sectorPacks?: string[] }>(orgId ? `/api/v1/organisations/${orgId}` : null);
  const locs = useList(orgId ? `/api/v1/organisations/${orgId}/locations` : '', !!orgId);
  const mine = me.memberships.filter((m) => m.organisationId === orgId);
  const list = Array.isArray(locs.data) ? (locs.data as { id: string; name: string }[]) : [];
  const allLocations = mine.some((m) => m.locationId === null);
  const visible = allLocations ? list : list.filter((l) => mine.some((m) => m.locationId === l.id));
  const location = visible.length === 1 ? visible[0]!.name : 'All locations';
  const packs = Array.isArray(org.data?.sectorPacks) ? org.data.sectorPacks : [];
  const service = packs.length === 1 ? (SERVICE_NAME[packs[0]!] ?? 'All services') : 'All services';
  return { location, service, role: mine[0]?.roleName ?? null };
}

export function Shell() {
  const { me, orgId, setOrgId, refresh, lastUpdated, sourceOk, live, signOut } = useApp();
  const orgs = [
    ...new Map(me.memberships.map((m) => [m.organisationId, m.organisationName])).entries(),
  ];
  const activeOrg = orgs.find(([id]) => id === orgId)?.[1];
  const scope = useScope(orgId);
  const crumbs = [activeOrg ?? 'No organisation', scope.location, scope.service];
  const router = useRouter();
  // Opened directly (nothing to go back to): the dashboard is the way out.
  const goBack = () =>
    router.history.canGoBack() ? router.history.back() : void router.navigate({ to: '/' });

  return (
    <div className="flex min-h-screen flex-col bg-hub-bg md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-white focus:p-2"
      >
        Skip to main content
      </a>

      <aside className="on-dark flex shrink-0 flex-col bg-hub-navy text-white md:sticky md:top-0 md:h-screen md:w-60">
        <div className="px-5 pb-3 pt-6 text-[15px] font-bold tracking-wide">HEALTHCARE HUB</div>
        <nav aria-label="Primary" className="px-3">
          <ul className="flex flex-wrap gap-1 md:block md:space-y-1.5">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  className="block rounded-md px-3 py-2.5 text-sm"
                  inactiveProps={{ className: 'text-slate-100 hover:bg-hub-navy-2' }}
                  activeProps={{
                    'aria-current': 'page',
                    className: 'bg-hub-teal font-semibold text-white',
                  }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto space-y-3 px-5 pb-5 pt-6 text-xs text-slate-200">
          <div className="flex flex-col gap-1">
            <label htmlFor="org-switcher" className="text-slate-300">
              Organisation
            </label>
            <select
              id="org-switcher"
              className="rounded-md border border-slate-400 bg-hub-navy-2 px-2 py-1.5 text-sm text-white"
              value={orgId ?? ''}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {orgs.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="border-t border-hub-navy-2 pt-3">
            <div className="text-sm font-semibold text-white">{me.user.displayName}</div>
            {scope.role && <div>{scope.role}</div>}
            {signOut && (
              <button
                type="button"
                onClick={signOut}
                className="mt-2 rounded-md border border-slate-300 px-3 py-1 text-sm text-white hover:bg-hub-navy-2"
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-5 p-4 md:p-6">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-hub-line bg-white px-5 py-3.5">
          <nav aria-label="Breadcrumb">
            <button
              type="button"
              onClick={goBack}
              title="Go back"
              aria-label={`Go back: ${crumbs.join(' / ')}`}
              className="flex flex-wrap gap-x-3 text-left font-semibold text-hub-navy underline-offset-2 hover:underline"
            >
              {crumbs.map((crumb, i) => (
                <span key={crumb} className="flex gap-x-3">
                  {i > 0 && <span aria-hidden="true">/</span>}
                  {crumb}
                </span>
              ))}
            </button>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-hub-muted">
            <time dateTime={new Date().toISOString()}>{londonDate.format(new Date())}</time>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              onClick={refresh}
              className="font-medium text-hub-navy underline-offset-2 hover:underline"
            >
              Refresh
            </button>
            <span aria-hidden="true">|</span>
            <span>Last updated {lastUpdated ? londonTime.format(lastUpdated) : '—'}</span>
            {live && (
              <>
                <span aria-hidden="true">|</span>
                <span data-testid="live-state" className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-green-700' : 'bg-amber-600'}`}
                  />
                  {live === 'live'
                    ? 'Live'
                    : live === 'connecting'
                      ? 'Connecting…'
                      : 'Reconnecting… figures may be out of date'}
                </span>
              </>
            )}
            {sourceOk ? (
              <StatusBadge status="GREEN" reason="all sources available" />
            ) : (
              <StatusBadge status="RED" reason="source unavailable" />
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
