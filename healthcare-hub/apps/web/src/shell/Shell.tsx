import { Link, Outlet } from '@tanstack/react-router';
import { StatusBadge } from '@hub/ui';
import { NAV_ITEMS } from '../nav.js';
import { useApp } from './AppContext.js';

export function Shell() {
  const { me, orgId, setOrgId, refresh, sourceOk, live, signOut } = useApp();
  const orgs = [
    ...new Map(me.memberships.map((m) => [m.organisationId, m.organisationName])).entries(),
  ];
  const activeOrg = orgs.find(([id]) => id === orgId)?.[1];
  const role = me.memberships.find((m) => m.organisationId === orgId)?.roleName ?? null;
  const reconnecting = live === 'reconnecting';

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
          {orgs.length > 1 ? (
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
          ) : (
            activeOrg && <div className="text-sm font-semibold text-white">{activeOrg}</div>
          )}
          <div className="border-t border-hub-navy-2 pt-3">
            <div className="text-sm font-semibold text-white">{me.user.displayName}</div>
            {role && <div>{role}</div>}
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
        {/* Shown only when the figures on screen may be out of date; nothing when all is well. */}
        {(!sourceOk || reconnecting) && (
          <div
            role="alert"
            data-testid="connection-warning"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-red-700 bg-red-50 px-4 py-3 text-sm text-red-900"
          >
            <StatusBadge
              status="RED"
              reason={sourceOk ? 'live updates disconnected' : 'source unavailable'}
            />
            <span>
              {sourceOk
                ? 'Reconnecting… figures may be out of date.'
                : 'The service cannot be reached. Figures on screen may be out of date.'}
            </span>
            <button
              type="button"
              onClick={refresh}
              className="font-semibold underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
