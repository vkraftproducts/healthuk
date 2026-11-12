import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { supportBannerText } from '@hub/contracts';
import { StatusBadge } from '@hub/ui';
import { BrandMark } from '../brand.js';
import { fmtDateTime } from '../components.js';
import { NAV_ITEMS, canSee } from '../nav.js';
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
  care_home: 'Care home',
};

const ICON_PATHS: Record<string, ReactNode> = {
  '/': (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  '/inspection': (
    <>
      <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z" />
      <path d="M8 6H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2" />
      <path d="m9 14 2 2 4-4" />
    </>
  ),
  '/me': (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </>
  ),
  '/report': (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  '/alerts': (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </>
  ),
  '/staff': (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.5 2.9-5.5 6.5-5.5s6.5 2 6.5 5.5" />
      <circle cx="17" cy="9" r="2.8" />
      <path d="M17 14.5c2.8 0 4.5 1.6 4.5 4.5" />
    </>
  ),
  '/vehicles': (
    <>
      <path d="M3 17V8a1 1 0 0 1 1-1h9v10" />
      <path d="M13 10h4l3 3.5V17h-1.5M13 17h-3" />
      <circle cx="7.5" cy="17.5" r="2" />
      <circle cx="16.5" cy="17.5" r="2" />
      <path d="M8 9.5v3.5M6.25 11.25h3.5" />
    </>
  ),
  '/compliance': (
    <>
      <path d="M12 3 20 6v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  '/premises': (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M9 21v-5h6v5M8 10h.01M12 10h.01M16 10h.01M8 13h.01M12 13h.01M16 13h.01" />
    </>
  ),
  '/planner': (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      <path d="m9 15 2 2 4-4" />
    </>
  ),
  '/reports': <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  '/speak-up': (
    <>
      <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.2-4.4A8 8 0 1 1 21 12z" />
      <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
    </>
  ),
  '/settings': (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
};

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

function NavIcon({ to }: { to: string }) {
  return <Icon>{ICON_PATHS[to] ?? <circle cx="12" cy="12" r="8" />}</Icon>;
}

const CalendarIcon = () => (
  <Icon size={16}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
);
const RefreshIcon = () => (
  <Icon size={16}>
    <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12A8 8 0 0 1 18.3 7.1" />
    <path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2" />
  </Icon>
);
const BellIcon = () => <Icon size={18}>{ICON_PATHS['/alerts']}</Icon>;

/** One "Label: value" item in the top bar's scope line. */
function ScopeItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="text-xs text-slate-500">{label}:</span>
      <span className="truncate font-semibold text-slate-900">{value}</span>
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** "Exora International Ltd / London / Ambulance service" from the user's scope. */
function useScope(orgId: string | null) {
  const { me } = useApp();
  const mine = me.memberships.filter((m) => m.organisationId === orgId);
  const known = mine.find((m) => Array.isArray(m.sectorPacks))?.sectorPacks;
  const org = useOne<{ sectorPacks?: string[] }>(
    orgId && !known ? `/api/v1/organisations/${orgId}` : null,
  );
  const locs = useList(orgId ? `/api/v1/organisations/${orgId}/locations` : '', !!orgId);
  const list = Array.isArray(locs.data) ? (locs.data as { id: string; name: string }[]) : [];
  const allLocations = mine.some((m) => m.locationId === null);
  const visible = allLocations ? list : list.filter((l) => mine.some((m) => m.locationId === l.id));
  const location = visible.length === 1 ? visible[0]!.name : 'All locations';
  const packs = known ?? (Array.isArray(org.data?.sectorPacks) ? org.data.sectorPacks : []);
  const service = packs.length === 1 ? (SERVICE_NAME[packs[0]!] ?? 'All services') : 'All services';
  return { location, service, role: mine[0]?.roleName ?? null, packs: known ?? null };
}

export function Shell() {
  const { me, orgId, setOrgId, refresh, lastUpdated, sourceOk, live, signOut } = useApp();
  const orgs = [
    ...new Map(me.memberships.map((m) => [m.organisationId, m.organisationName])).entries(),
  ];
  const activeOrg = orgs.find(([id]) => id === orgId)?.[1];
  const scope = useScope(orgId);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const page = NAV_ITEMS.filter((n) => n.to !== '/').find(
    (n) => path === n.to || path.startsWith(`${n.to}/`),
  );
  const crumbs = [activeOrg ?? 'No organisation', scope.location, scope.service];
  if (page) crumbs.push(page.label);
  const support = me.support ?? null;
  const alerts = useOne<{ open: number; critical: number }>(
    orgId && !support ? '/api/v1/alerts/count' : null,
  );
  const router = useRouter();
  // Opened directly (nothing to go back to): the dashboard is the way out.
  const goBack = () =>
    router.history.canGoBack() ? router.history.back() : void router.navigate({ to: '/' });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-white focus:p-3 focus:text-hub-ink"
      >
        Skip to main content
      </a>

      <aside className="relative flex shrink-0 flex-col border-b border-hub-line bg-white md:sticky md:top-0 md:h-screen md:w-64 md:overflow-y-auto md:border-b-0 md:border-r">
        <div className="flex h-16 items-center border-b border-hub-line px-5">
          <BrandMark compact />
        </div>
        <nav aria-label="Primary" className="px-3 py-4">
          <ul className="flex flex-wrap gap-1 md:block md:space-y-0.5">
            {NAV_ITEMS.filter((item) => canSee(item, me.permissions, scope.packs)).map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  className="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold"
                  inactiveProps={{
                    className: 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                  }}
                  activeProps={{
                    'aria-current': 'page',
                    className: 'bg-hub-sky text-hub-teal',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute -left-3 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r bg-hub-teal opacity-0 group-aria-[current=page]:opacity-100"
                  />
                  <span className="text-slate-400 transition-colors group-hover:text-slate-600 group-aria-[current=page]:text-hub-teal">
                    <NavIcon to={item.to} />
                  </span>
                  <span>
                    {item.to === '/' && !me.permissions.includes('dashboard.view')
                      ? 'Home'
                      : item.label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto space-y-3 border-t border-hub-line px-5 pb-5 pt-4 text-xs text-slate-600">
          <div className="flex flex-col gap-1">
            <label htmlFor="org-switcher" className="font-semibold text-slate-500">
              Organisation
            </label>
            <select
              id="org-switcher"
              className="field px-2 py-1.5 text-sm font-semibold"
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
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-hub-sky font-display text-sm font-bold text-hub-teal"
            >
              {initials(me.user.displayName)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{me.user.displayName}</div>
              {scope.role && <div className="truncate text-slate-500">{scope.role}</div>}
            </div>
          </div>
          {signOut && (
            <button type="button" onClick={signOut} className="btn-ghost w-full">
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 border-b border-hub-line bg-white px-4 py-2.5 md:px-6">
          <nav aria-label="Breadcrumb" className="min-w-0">
            <button
              type="button"
              onClick={goBack}
              title="Go back"
              aria-label={`Go back: ${crumbs.join(' / ')}`}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded-md text-left text-sm hover:bg-slate-50"
            >
              <ScopeItem label="Organisation" value={crumbs[0]!} />
              <span aria-hidden="true" className="text-slate-300">
                /
              </span>
              <ScopeItem label="Location" value={crumbs[1]!} />
              <span aria-hidden="true" className="text-slate-300">
                /
              </span>
              <ScopeItem label="Service" value={crumbs[2]!} />
              {crumbs[3] && (
                <>
                  <span aria-hidden="true" className="text-slate-300">
                    /
                  </span>
                  <span className="font-bold text-hub-teal">{crumbs[3]}</span>
                </>
              )}
            </button>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span className="inline-flex items-center gap-1.5 px-1">
              <CalendarIcon />
              <time dateTime={new Date().toISOString()} className="font-semibold text-slate-700">
                {londonDate.format(new Date())}
              </time>
            </span>
            {sourceOk ? (
              <span
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                  live && live !== 'live'
                    ? 'border-amber-300 bg-amber-50 text-amber-900'
                    : 'border-green-200 bg-green-50 text-green-900'
                }`}
              >
                <span>
                  Last updated{' '}
                  <span className="tabular-nums">
                    {lastUpdated ? londonTime.format(lastUpdated) : '—'}
                  </span>
                </span>
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                {live ? (
                  <span data-testid="live-state" className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="relative flex h-2 w-2">
                      {live === 'live' && (
                        <span className="absolute inline-flex h-full w-full animate-beacon rounded-full bg-green-600" />
                      )}
                      <span
                        className={`relative h-2 w-2 rounded-full ${live === 'live' ? 'bg-green-600' : 'bg-amber-600'}`}
                      />
                    </span>
                    {live === 'live'
                      ? 'Live'
                      : live === 'connecting'
                        ? 'Connecting…'
                        : 'Reconnecting… figures may be out of date'}
                  </span>
                ) : null}
                <span aria-hidden="true" className="opacity-50">
                  ·
                </span>
                <span>All sources available</span>
              </span>
            ) : (
              <>
                <span className="text-xs">
                  Last updated{' '}
                  <span className="tabular-nums">
                    {lastUpdated ? londonTime.format(lastUpdated) : '—'}
                  </span>
                </span>
                {live && (
                  <span data-testid="live-state" className="text-xs">
                    {live === 'live'
                      ? 'Live'
                      : live === 'connecting'
                        ? 'Connecting…'
                        : 'Reconnecting… figures may be out of date'}
                  </span>
                )}
                <StatusBadge status="RED" reason="source unavailable" />
              </>
            )}
            <button type="button" onClick={refresh} className="btn-ghost h-9 gap-1.5 px-3">
              <RefreshIcon />
              Refresh
            </button>
            {typeof alerts.data?.open === 'number' && (
              <Link
                to="/alerts"
                className="relative grid h-9 w-9 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                aria-label={
                  `Alerts: ${alerts.data.open} open` +
                  (alerts.data.critical ? `, ${alerts.data.critical} critical` : '')
                }
              >
                <BellIcon />
                {alerts.data.open > 0 && (
                  <span
                    aria-hidden="true"
                    className={`absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full px-1 text-center text-[10px] font-bold leading-[18px] text-white ${
                      alerts.data.critical > 0 ? 'bg-red-700' : 'bg-hub-teal'
                    }`}
                  >
                    {alerts.data.open}
                  </span>
                )}
              </Link>
            )}
          </div>
        </header>
        <div className="flex-1 space-y-5 p-4 md:p-6 lg:px-8">
          {support && (
            <div
              role="status"
              className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-950"
            >
              <strong>Support access, read-only.</strong>{' '}
              {supportBannerText(fmtDateTime(support.endsAt))}
            </div>
          )}
          <main id="main" tabIndex={-1} className="rise-in">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
