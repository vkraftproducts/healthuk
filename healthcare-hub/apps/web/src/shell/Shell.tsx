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

function NavIcon({ to }: { to: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {ICON_PATHS[to] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
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
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-hub-card-2 focus:p-3 focus:text-hub-ink"
      >
        Skip to main content
      </a>

      <aside className="on-dark relative flex shrink-0 flex-col border-b border-hub-line bg-hub-navy/95 text-white md:sticky md:top-0 md:h-screen md:w-64 md:overflow-y-auto md:border-b-0">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-px bg-gradient-to-b from-transparent via-hub-teal/50 to-transparent md:block"
        />
        <div className="px-5 pb-4 pt-6">
          <BrandMark compact />
        </div>
        <div aria-hidden="true" className="neon-rule mx-5 mb-3" />
        <nav aria-label="Primary" className="px-3">
          <ul className="flex flex-wrap gap-1 md:block md:space-y-1">
            {NAV_ITEMS.filter((item) => canSee(item, me.permissions, scope.packs)).map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  className="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm"
                  inactiveProps={{
                    className: 'text-slate-100 hover:bg-hub-navy-2 hover:text-white',
                  }}
                  activeProps={{
                    'aria-current': 'page',
                    className:
                      'bg-hub-teal/10 font-semibold text-white shadow-[inset_0_0_0_1px_rgb(52_211_153/0.35),0_0_22px_-8px_rgb(34_229_138/0.6)]',
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute -left-3 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-hub-teal opacity-0 shadow-[0_0_10px_rgb(34_229_138)] group-aria-[current=page]:opacity-100"
                  />
                  <span className="text-hub-muted transition-colors group-hover:text-hub-teal group-aria-[current=page]:text-hub-teal">
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

        <div className="mt-auto space-y-3 px-5 pb-5 pt-6 text-xs text-slate-200">
          <div className="flex flex-col gap-1">
            <label htmlFor="org-switcher" className="text-hub-muted">
              Organisation
            </label>
            <select
              id="org-switcher"
              className="field bg-hub-navy-2 px-2 py-1.5 text-sm text-white"
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
          <div className="neon-rule" aria-hidden="true" />
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-hub-teal/60 bg-hub-navy-2 font-display text-sm font-semibold text-hub-teal shadow-glow-sm"
            >
              {initials(me.user.displayName)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{me.user.displayName}</div>
              {scope.role && <div className="truncate text-hub-muted">{scope.role}</div>}
            </div>
          </div>
          {signOut && (
            <button type="button" onClick={signOut} className="btn-ghost w-full">
              Sign out
            </button>
          )}
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-5 p-4 md:p-6">
        <header className="hud glass sticky top-3 z-20 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-hub-line px-5 py-3.5 shadow-panel">
          <nav aria-label="Breadcrumb">
            <button
              type="button"
              onClick={goBack}
              title="Go back"
              aria-label={`Go back: ${crumbs.join(' / ')}`}
              className="flex flex-wrap gap-x-3 text-left font-display font-semibold text-hub-ink underline-offset-2 hover:underline"
            >
              {crumbs.map((crumb, i) => (
                <span key={crumb} className="flex gap-x-3">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-hub-teal">
                      /
                    </span>
                  )}
                  {crumb}
                </span>
              ))}
            </button>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-hub-muted">
            {typeof alerts.data?.open === 'number' && (
              <>
                <Link
                  to="/alerts"
                  className="font-medium text-hub-ink underline-offset-2 hover:underline"
                  aria-label={
                    `Alerts: ${alerts.data.open} open` +
                    (alerts.data.critical ? `, ${alerts.data.critical} critical` : '')
                  }
                >
                  Alerts {alerts.data.open}
                  {alerts.data.critical > 0 && ` (${alerts.data.critical} critical)`}
                </Link>
                <span aria-hidden="true">|</span>
              </>
            )}
            <time dateTime={new Date().toISOString()} className="font-mono text-xs">
              {londonDate.format(new Date())}
            </time>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              onClick={refresh}
              className="font-medium text-hub-ink underline-offset-2 hover:text-hub-teal-dark hover:underline"
            >
              Refresh
            </button>
            <span aria-hidden="true">|</span>
            <span>
              Last updated{' '}
              <span className="font-mono text-xs">
                {lastUpdated ? londonTime.format(lastUpdated) : '—'}
              </span>
            </span>
            {live && (
              <>
                <span aria-hidden="true">|</span>
                <span data-testid="live-state" className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="relative flex h-2 w-2">
                    {live === 'live' && (
                      <span className="absolute inline-flex h-full w-full animate-beacon rounded-full bg-green-700" />
                    )}
                    <span
                      className={`relative h-2 w-2 rounded-full ${live === 'live' ? 'bg-green-700' : 'bg-amber-600'}`}
                    />
                  </span>
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
        {support && (
          <div
            role="status"
            className="rounded-xl border border-amber-700 bg-amber-50 px-5 py-3 text-sm text-amber-950"
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
  );
}
