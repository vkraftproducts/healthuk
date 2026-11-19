import { supportBannerText } from '@hub/contracts';
import { StatusBadge } from '@hub/ui';
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router';
import { Dropdown, type MenuProps } from 'antd';
import { useCallback, useState } from 'react';
import { BRAND } from '../brand.js';
import { fmtDateTime } from '../components.js';
import { NAV_MODULES, canSee, modulePathFor, navItemFor } from '../nav.js';
import { HeadSlotsCtx, Ms, type HeadSlots } from '../v36/ui.js';
import { useList, useOne } from '../pages/settings/hooks.js';
import { useApp } from './AppContext.js';
import { readTheme, toggleTheme, type ThemeMode } from './theme.js';

/** Sector pack -> service name shown in the in-page breadcrumb. */
const SERVICE_NAME: Record<string, string> = {
  ambulance: 'Ambulance service',
  dental: 'Dental practice',
  care_home: 'Care home',
};

/** v36 module icons (Material Symbols names, as in the v36 side nav). */
const MODULE_ICON: Record<string, string> = {
  '/': 'space_dashboard',
  '/staff': 'group',
  '/vehicles': 'ambulance',
  '/compliance': 'verified_user',
  '/premises': 'domain',
  '/planner': 'calendar_month',
  '/reports': 'analytics',
  '/settings': 'settings',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

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

/**
 * App chrome matching Healthcare Hub UK v36 HTML exactly: the light side nav (brand, eight modules
 * with counts), the top bar (search, alerts, the signed-in person) and the content area whose head
 * band holds each page's title and tabs (see PageHeader and Tabs in components.tsx).
 */
export function Shell() {
  const { me, orgId, setOrgId, refresh, sourceOk, live, signOut } = useApp();
  const [mode, setMode] = useState<ThemeMode>(() => readTheme());
  const [navOpen, setNavOpen] = useState(false);
  const [slots, setSlots] = useState<HeadSlots>({ top: null, tabs: null });
  const topRef = useCallback(
    (el: HTMLDivElement | null) => setSlots((s) => (s.top === el ? s : { ...s, top: el })),
    [],
  );
  const tabsRef = useCallback(
    (el: HTMLDivElement | null) => setSlots((s) => (s.tabs === el ? s : { ...s, tabs: el })),
    [],
  );
  const orgs = [
    ...new Map(me.memberships.map((m) => [m.organisationId, m.organisationName])).entries(),
  ];
  const activeOrg = orgs.find(([id]) => id === orgId)?.[1];
  const scope = useScope(orgId);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const modulePath = modulePathFor(path);
  const support = me.support ?? null;
  const alerts = useOne<{ open: number; critical: number }>(
    orgId && !support ? '/api/v1/alerts/count' : null,
  );

  const brandSubtitle = [activeOrg, scope.location !== 'All locations' ? scope.location : null]
    .filter(Boolean)
    .join(' · ');
  const items = NAV_MODULES.filter((item) => canSee(item, me.permissions, scope.packs));

  // v36 breadcrumb: organisation / location / service / page; the last crumb goes back.
  const page = navItemFor(path);
  const router = useRouter();
  const goBack = () =>
    router.history.canGoBack() ? router.history.back() : void router.navigate({ to: '/' });
  const pageLabel =
    page && page.to !== '/'
      ? page.label
      : modulePath === '/' && !me.permissions.includes('dashboard.view')
        ? 'Home'
        : (NAV_MODULES.find((m) => m.to === modulePath)?.label ?? 'Dashboard');
  const crumbs = [activeOrg ?? 'No organisation', scope.location, scope.service];
  if (modulePath !== '/' || pageLabel === 'Home' || (page && page.to !== '/'))
    crumbs.push(pageLabel);

  const meMenu: MenuProps = {
    items: [
      { key: 'theme', label: mode === 'dark' ? 'Light mode' : 'Dark mode' },
      { key: 'refresh', label: 'Refresh data' },
      ...(signOut ? [{ type: 'divider' as const }, { key: 'signout', label: 'Sign out' }] : []),
    ],
    onClick: ({ key }) => {
      if (key === 'theme') setMode(toggleTheme());
      else if (key === 'refresh') refresh();
      else if (key === 'signout') signOut?.();
    },
  };

  const banner = support ? (
    <>
      <strong>Support access, read-only.</strong> {supportBannerText(fmtDateTime(support.endsAt))}
    </>
  ) : !sourceOk ? (
    <>
      <StatusBadge status="RED" reason="source unavailable" /> A data source is unavailable – some
      figures may be out of date.
    </>
  ) : null;

  return (
    <div className={`ant-layout ant-layout-has-sider hh-shell${navOpen ? ' navopen' : ''}`}>
      <a className="skip" href="#hh-wf">
        Skip to content
      </a>
      <aside className="side ant-layout-sider ant-layout-sider-light" aria-label="Main navigation">
        <div className="brand">
          <span className="logo">
            <Ms i="health_and_safety" />
          </span>
          <div>
            <b>{BRAND.product}</b>
            <small>{brandSubtitle || 'No organisation'}</small>
          </div>
        </div>
        <nav
          id="nav"
          aria-label="Primary"
          className="ant-menu ant-menu-root ant-menu-inline ant-menu-light"
        >
          {items.map((item) => {
            const on = modulePath === item.to;
            const label =
              item.to === '/' && !me.permissions.includes('dashboard.view') ? 'Home' : item.label;
            const count = item.to === '/' ? alerts.data?.open : undefined;
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setNavOpen(false)}
                className={`ant-menu-item${on ? ' on ant-menu-item-selected' : ''}`}
                aria-current={on ? 'page' : undefined}
              >
                <Ms i={MODULE_ICON[item.to] ?? 'circle'} className="ant-menu-item-icon" />
                <span className="lb ant-menu-title-content">{label}</span>
                {typeof count === 'number' && count > 0 && (
                  <span className="nb ant-badge-count" aria-label={`${count} waiting`}>
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {orgs.length > 1 && (
          <div className="hh-org">
            <label htmlFor="org-switcher">Organisation</label>
            <select
              id="org-switcher"
              className="ant-sel"
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
        )}
      </aside>

      <div className="mainwrap ant-layout">
        <header className="top ant-layout-header">
          <button
            type="button"
            className="ib only-sm"
            aria-label="Menu"
            aria-controls="nav"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            <Ms i="menu" />
          </button>
          <div className="sp" />
          {live && (
            <span
              data-testid="live-state"
              className={`hh-live${live === 'live' ? ' ok' : ''}`}
              title={live === 'live' ? 'Figures update as records change' : undefined}
            >
              <span className="dot" aria-hidden="true" />
              {live === 'live'
                ? 'Live'
                : live === 'connecting'
                  ? 'Connecting…'
                  : 'Reconnecting — figures may be out of date'}
            </span>
          )}
          <button type="button" className="ib srch" title="Search (Ctrl+K)" aria-label="Search">
            <Ms i="search" />
            <span className="lbl">Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <Link
            to="/alerts"
            className="ib ant-btn ant-btn-text ant-btn-color-default ant-btn-variant-text ant-btn-icon-only"
            id="bellB"
            aria-label={`Alerts${alerts.data ? `: ${alerts.data.open} open` : ''}`}
          >
            <span className="ant-badge">
              <Ms i="notifications" />
              {!!alerts.data?.open && (
                <span className="dotn ant-badge-count">
                  {alerts.data.open > 99 ? '99+' : alerts.data.open}
                </span>
              )}
            </span>
          </Link>
          <Dropdown menu={meMenu} trigger={['click']} placement="bottomRight">
            <button type="button" className="me" aria-haspopup="menu" aria-label="Your account">
              <span className="av ant-avatar ant-avatar-circle">
                {initials(me.user.displayName)}
              </span>
              <div>
                <b>{me.user.displayName}</b>
                <small>{scope.role ?? ''}</small>
              </div>
            </button>
          </Dropdown>
        </header>
        {banner && (
          <div className="banner ant-alert ant-alert-warning ant-alert-banner" role="status">
            {banner}
          </div>
        )}
        <div className="scroller ant-layout-content">
          <main id="hh-wf" tabIndex={-1}>
            <div className="wf">
              <div className="pc">
                <div className="pc-head wf-h">
                  <nav className="ant-breadcrumb pc-bc" aria-label="Breadcrumb">
                    <ol>
                      {crumbs.map((c, i) => (
                        <li key={`${i}-${c}`} className="ant-breadcrumb-item">
                          {i > 0 && (
                            <span className="ant-breadcrumb-separator" aria-hidden="true">
                              /
                            </span>
                          )}
                          {i === crumbs.length - 1 ? (
                            <button
                              type="button"
                              className="ant-breadcrumb-link hh-crumb"
                              onClick={goBack}
                              title="Go back"
                              aria-label={`Go back: ${crumbs.join(' / ')}`}
                            >
                              {c}
                            </button>
                          ) : (
                            <span className="ant-breadcrumb-link">{c}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </nav>
                  <div className="hh-slot-top" ref={topRef} />
                  <div className="hh-slot-tabs" ref={tabsRef} />
                </div>
                <div className="pc-body">
                  <HeadSlotsCtx.Provider value={slots}>
                    <Outlet />
                  </HeadSlotsCtx.Provider>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
