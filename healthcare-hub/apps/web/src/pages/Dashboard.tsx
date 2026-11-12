import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { fmtDate, fmtDateTime, saveBlob, useCan, useRun, words } from '../components.js';
import { Icon, type IconName } from '../icons.js';
import { useApp } from '../shell/AppContext.js';
import { useList, useOne, usePeople } from './settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tiles are counted separately and never merged; each opens its exact drill-down (PRD §4.2, UAT-08). */
/** Tiles that count requirement deadlines (meaningless until requirements apply). */
const REQUIREMENT_TILES = new Set<string>(['overdue', 'dueSoon']);

const TILES = [
  { key: 'overdue', label: 'Overdue tasks', kind: 'RED' as StatusKind },
  { key: 'dueSoon', label: 'Due in 30 days', kind: 'AMBER' as StatusKind },
  { key: 'blockedVehicles', label: 'Blocked vehicles', kind: 'RED' as StatusKind },
  { key: 'jobsToday', label: 'Jobs today', kind: 'GREY' as StatusKind },
  { key: 'unverified', label: 'Staff unverified', kind: 'AMBER' as StatusKind },
  { key: 'auditsOverdue', label: 'Audits overdue', kind: 'RED' as StatusKind },
] as const;
/** Dental and care-home tiles (WORKFLOWS M): shown only when the server lists them. */
const SECTOR_TILES = new Set<string>(['unverified', 'auditsOverdue']);
/** Each tile's icon and the words after its figure ("3 items overdue"). */
const TILE_META: Record<string, { icon: IconName; unit: string }> = {
  overdue: { icon: 'alert', unit: 'items overdue' },
  dueSoon: { icon: 'clock', unit: 'items due' },
  blockedVehicles: { icon: 'vehicle', unit: 'vehicles blocked' },
  jobsToday: { icon: 'clipboard', unit: 'jobs booked' },
  unverified: { icon: 'people', unit: 'awaiting verification' },
  auditsOverdue: { icon: 'shield', unit: 'audits overdue' },
};
/** Tile accent (top rule, label, icon chip); the badge in each tile carries the words. */
type Tone = 'RED' | 'AMBER' | 'GREEN' | 'COUNT' | 'OFF';
const TONE: Record<Tone, { bar: string; label: string; chip: string }> = {
  RED: { bar: 'border-t-red-600', label: 'text-red-700', chip: 'bg-red-50 text-red-700' },
  AMBER: { bar: 'border-t-amber-500', label: 'text-amber-800', chip: 'bg-amber-50 text-amber-700' },
  GREEN: { bar: 'border-t-green-600', label: 'text-green-800', chip: 'bg-green-50 text-green-700' },
  COUNT: { bar: 'border-t-hub-teal', label: 'text-hub-teal', chip: 'bg-hub-sky text-hub-teal' },
  OFF: { bar: 'border-t-slate-300', label: 'text-slate-600', chip: 'bg-slate-50 text-slate-500' },
};
const MODULE_ICON: Record<string, IconName> = {
  STAFF: 'people',
  FLEET: 'vehicle',
  COMPLIANCE: 'shield',
  PREMISES: 'building',
  EVENTS: 'event',
  JOBS: 'clipboard',
};
/** Urgent rows stand out (tint and a red edge); the State badge still says why. */
const urgentRow = (r: Row) =>
  r.status === 'RED' ? 'bg-red-50/60 [&>td:first-child]:shadow-[inset_3px_0_0_#dc2626]' : '';
/** Rows shown before "View all" (most urgent first, as returned by the API). */
const PREVIEW = 8;
const textAction = 'font-semibold text-hub-teal underline-offset-2 hover:underline';
const field = 'field h-9 py-1 text-sm';
const MODULE_LABEL: Record<string, string> = {
  STAFF: 'Staff',
  FLEET: 'Fleet',
  COMPLIANCE: 'Compliance',
  PREMISES: 'Premises',
  EVENTS: 'Events',
  JOBS: 'Jobs',
};
/** Where a row goes when it has no record page of its own. */
const MODULE_PAGE: Record<string, { to: string; search?: { tab: string } }> = {
  STAFF: { to: '/staff' },
  FLEET: { to: '/vehicles' },
  COMPLIANCE: { to: '/compliance' },
  PREMISES: { to: '/premises' },
  EVENTS: { to: '/compliance', search: { tab: 'events' } },
  JOBS: { to: '/planner' },
};

/** The page that deals with an action row, from the API's link. Access is still checked there. */
function destination(r: Row): { to: string; params?: { id: string }; search?: { tab: string } } {
  const { type, id, subjectType, subjectId } = r.link;
  if (type === 'VEHICLE') return { to: '/vehicles/$id', params: { id } };
  if (type === 'AUDIT_RUN') return { to: '/compliance/audits/$id', params: { id } };
  if (type === 'ACTION') return { to: '/compliance', search: { tab: 'actions' } };
  if (type === 'POLICY') return { to: '/compliance', search: { tab: 'policies' } };
  if (type === 'CORRESPONDENCE') return { to: '/compliance', search: { tab: 'registration' } };
  if (subjectType === 'STAFF') return { to: '/staff/$id', params: { id: subjectId } };
  if (subjectType === 'VEHICLE') return { to: '/vehicles/$id', params: { id: subjectId } };
  return MODULE_PAGE[r.module] ?? { to: '/' };
}

export function Dashboard() {
  const { me, orgId, api } = useApp();
  const can = useCan();
  const canView = me.permissions.includes('dashboard.view');
  const [tile, setTile] = useState<string>('all');
  const [module, setModule] = useState<string>('');
  const [expanded, setExpanded] = useState(false);
  // DASH-01 filters. Organisation is the switcher in the shell; the rest are here.
  const [locationId, setLocationId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const badRange = dateFrom !== '' && dateTo !== '' && dateTo < dateFrom;
  const locations = useList(orgId ? `/api/v1/organisations/${orgId}/locations` : '', canView);
  const services = useList(orgId ? `/api/v1/organisations/${orgId}/services` : '', canView);
  const people = usePeople();
  const params = new URLSearchParams();
  if (locationId) params.set('locationId', locationId);
  if (serviceId) params.set('serviceId', serviceId);
  if (ownerUserId) params.set('ownerUserId', ownerUserId);
  if (dateFrom && !badRange) params.set('dateFrom', dateFrom);
  if (dateTo && !badRange) params.set('dateTo', dateTo);
  // The module choice narrows the action list only: the summary keeps every module's status, so
  // choosing one module never makes the others look empty.
  const sq = params.toString();
  if (module) params.set('module', module);
  const q = params.toString();
  const filtered = locationId || serviceId || ownerUserId || dateFrom || dateTo || module;
  const orgCount = new Set(me.memberships.map((m) => m.organisationId)).size;
  const summary = useOne<Row>(canView ? `/api/v1/dashboard/summary${sq ? `?${sq}` : ''}` : null);
  const rows = useOne<{ data: Row[] }>(
    canView ? `/api/v1/dashboard/actions?tile=${tile}${q ? `&${q}` : ''}` : null,
  );
  const ownerText = (r: Row) =>
    !r.ownerUserId
      ? 'Unassigned'
      : r.ownerUserId === me.user.id
        ? `${r.ownerName ?? me.user.displayName} (you)`
        : (r.ownerName ?? 'Not a current member');
  const { run, msg } = useRun();
  const s = summary.data;
  // Finding 97: an organisation with no applicable requirements must not read as "all green".
  const notSetUp = !!s && s.coverage.denominator === 0 && s.coverage.exclusions === 0;
  const actions = rows.data?.data ?? [];
  // The server says which modules and tiles this role may see; older servers send neither.
  const visibleModules: string[] | null = Array.isArray(s?.visibleModules)
    ? s.visibleModules
    : null;
  const visibleTiles: string[] | null = Array.isArray(s?.visibleTiles) ? s.visibleTiles : null;
  const tiles = TILES.filter((t) =>
    visibleTiles ? visibleTiles.includes(t.key) : !SECTOR_TILES.has(t.key),
  );
  const moduleNotSetUp = new Set<string>(Array.isArray(s?.notSetUp) ? s.notSetUp : []);
  const shows = (m: string) => !visibleModules || visibleModules.includes(m);
  const roleName = me.memberships.find((m) => m.organisationId === orgId)?.roleName;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl">Home dashboard</h1>
        <p className="mt-1 text-slate-600">
          What needs action in the areas your role covers
          {roleName ? ` (${roleName})` : ''}. Other areas are not shown here.
        </p>
      </div>
      {!orgId ? (
        <p role="status">Select an organisation to continue.</p>
      ) : !canView ? (
        <p role="alert">You do not have permission to view the dashboard for this organisation.</p>
      ) : summary.isError ? (
        <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-red-900">
          <strong>Source unavailable.</strong> The dashboard could not be loaded. Figures are not
          shown rather than shown out of date.
        </div>
      ) : (
        <>
          <form
            aria-label="Dashboard filters"
            className="card flex flex-wrap items-end gap-3 px-4 py-3 text-sm"
            onSubmit={(e) => e.preventDefault()}
          >
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Location
              <select
                className={field}
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">All locations</option>
                {(locations.data ?? []).map((l) => (
                  <option key={String(l.id)} value={String(l.id)}>
                    {String(l.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Service
              <select
                className={field}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">All services</option>
                {(services.data ?? []).map((s) => (
                  <option key={String(s.id)} value={String(s.id)}>
                    {String(s.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Owner
              <select
                className={field}
                value={ownerUserId}
                onChange={(e) => setOwnerUserId(e.target.value)}
              >
                <option value="">Any owner</option>
                <option value={me.user.id}>Me</option>
                {people
                  .filter((u) => u.id && u.id !== me.user.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                      {u.roleNames?.length ? ` (${u.roleNames.join(', ')})` : ''}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Deadline from
              <input
                type="date"
                className={field}
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
              Deadline to
              <input
                type="date"
                className={field}
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>
            {filtered && (
              <button
                type="button"
                className={textAction}
                onClick={() => {
                  setLocationId('');
                  setServiceId('');
                  setOwnerUserId('');
                  setDateFrom('');
                  setDateTo('');
                  setModule('');
                }}
              >
                Clear filters
              </button>
            )}
            {badRange && (
              <p role="alert" className="w-full text-red-800">
                The end date is before the start date, so the date range is not applied.
              </p>
            )}
          </form>
          {visibleModules?.length === 0 && (
            <p role="status" className="rounded-lg border border-hub-line bg-hub-card p-3 text-sm">
              Your role has no dashboard figures in this organisation. Use the navigation for the
              pages you can open.
            </p>
          )}
          {notSetUp && (
            <p
              role="note"
              className="rounded-lg border border-amber-700 bg-amber-50 p-3 text-sm text-amber-900"
            >
              Nothing is set up yet: no requirements apply to any person, vehicle or premises item,
              so zero overdue does not mean compliant. Publish and map requirements in Settings,
              Requirement library.
            </p>
          )}
          <section
            aria-label="Key figures"
            className="grid grid-cols-2 gap-4 lg:grid-cols-4"
            aria-busy={summary.isLoading}
          >
            {tiles.map((t) => {
              const value = s ? (s.tiles[t.key] as number | null) : undefined;
              const connected = value !== null && value !== undefined;
              const selected = tile === t.key;
              const unset = connected && notSetUp && value === 0 && REQUIREMENT_TILES.has(t.key);
              const tone: Tone =
                !connected || unset
                  ? 'OFF'
                  : value === 0
                    ? 'GREEN'
                    : t.kind === 'GREY'
                      ? 'COUNT'
                      : t.kind === 'RED'
                        ? 'RED'
                        : 'AMBER';
              const meta = TILE_META[t.key] ?? { icon: 'alert' as IconName, unit: '' };
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={!connected}
                  aria-pressed={selected}
                  onClick={() => setTile(selected ? 'all' : t.key)}
                  className={`card flex flex-col border-t-4 px-5 pb-4 pt-4 text-left hover:border-slate-300 hover:shadow-md ${TONE[tone].bar} ${selected ? 'ring-2 ring-hub-teal ring-offset-2' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={`eyebrow ${TONE[tone].label}`}>{t.label}</span>
                    <span
                      className={`grid h-8 w-8 place-items-center rounded-lg ${TONE[tone].chip}`}
                    >
                      <Icon name={meta.icon} size={17} />
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span
                      className="font-display text-4xl font-extrabold leading-tight text-slate-900"
                      aria-label={
                        connected ? `${t.label}: ${value}` : `${t.label}: not connected yet`
                      }
                    >
                      {summary.isLoading ? '…' : connected ? value : '—'}
                    </span>
                    {connected && <span className="text-sm text-slate-600">{meta.unit}</span>}
                  </div>
                  <div className="mt-3 flex w-full flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    {unset ? (
                      <StatusBadge status="GREY" reason="not set up" />
                    ) : connected ? (
                      <StatusBadge
                        status={value === 0 ? 'GREEN' : t.kind}
                        reason={
                          value === 0 ? 'none' : selected ? 'showing below' : 'select to list'
                        }
                      />
                    ) : (
                      <StatusBadge status="GREY" reason="not connected yet" />
                    )}
                    {connected && value !== 0 && !unset && (
                      <span aria-hidden="true" className="text-hub-teal">
                        <Icon name="arrow" size={16} />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </section>

          <div className="grid items-start gap-5 xl:grid-cols-3">
            <section aria-labelledby="actions-h" className="card overflow-hidden xl:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hub-line px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <span className="text-hub-teal">
                    <Icon name="gavel" />
                  </span>
                  <h2 id="actions-h" className="text-lg font-bold">
                    Action required
                    {tile !== 'all'
                      ? ` – ${TILES.find((t) => t.key === tile)?.label ?? words(tile)}`
                      : ''}
                    {module ? ` – ${MODULE_LABEL[module] ?? words(module)} only` : ''}
                  </h2>
                  {!rows.isLoading && actions.length > 0 && (
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700">
                      {actions.length} {actions.length === 1 ? 'item' : 'items'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {(tile !== 'all' || module) && (
                    <>
                      <button
                        className={textAction}
                        onClick={() => {
                          setTile('all');
                          setModule('');
                        }}
                      >
                        Clear filter
                      </button>
                      {(actions.length > PREVIEW || can('reports.export')) && (
                        <span aria-hidden="true">|</span>
                      )}
                    </>
                  )}
                  {can('reports.export') && (
                    <button
                      className="btn-ghost h-9 px-3"
                      onClick={() =>
                        void run(
                          async () =>
                            saveBlob(
                              await api.download!(
                                `/api/v1/dashboard/actions/export?tile=${tile}${q ? `&${q}` : ''}`,
                                orgId,
                              ),
                              'action-required.csv',
                            ),
                          'Export downloaded (logged).',
                        )
                      }
                    >
                      <Icon name="download" size={16} />
                      Export
                    </button>
                  )}
                </div>
              </div>
              {msg}
              <DataTable<Row>
                caption="Action required"
                framed={false}
                rows={expanded ? actions : actions.slice(0, PREVIEW)}
                rowKey={(r) => r.key}
                rowClassName={urgentRow}
                loading={rows.isLoading}
                error={rows.isError ? 'Could not load the action list.' : null}
                emptyMessage="Nothing needs action."
                columns={[
                  {
                    key: 'item',
                    header: 'Item',
                    cell: (r) => (
                      <span className="flex items-start gap-2.5">
                        <span className="mt-0.5 text-slate-400">
                          <Icon name={MODULE_ICON[r.module] ?? 'alert'} size={17} />
                        </span>
                        <Link
                          {...destination(r)}
                          aria-label={`${MODULE_LABEL[r.module] ?? r.module}: ${r.item}`}
                          className="group/link block"
                        >
                          <span className="eyebrow block text-slate-600">
                            {MODULE_LABEL[r.module] ?? r.module}
                          </span>
                          <span className="font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 group-hover/link:decoration-hub-teal">
                            {r.item}
                          </span>
                        </Link>
                      </span>
                    ),
                  },
                  {
                    key: 'owner',
                    header: 'Owner',
                    cell: ownerText,
                  },
                  {
                    key: 'deadline',
                    header: 'Deadline',
                    cell: (r) => (
                      <span className="whitespace-nowrap">
                        {r.deadline ? fmtDate(r.deadline) : '—'}
                      </span>
                    ),
                  },
                  {
                    key: 'state',
                    header: 'State',
                    cell: (r) => (
                      <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />
                    ),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hub-line px-5 py-3 text-sm">
                <span className="text-slate-600">
                  {rows.isLoading
                    ? 'Loading…'
                    : actions.length > PREVIEW && !expanded
                      ? `Showing the ${PREVIEW} most urgent of ${actions.length}.`
                      : 'Most urgent first.'}
                </span>
                {actions.length > PREVIEW && (
                  <button
                    className="btn-ghost h-9 px-3"
                    aria-expanded={expanded}
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? 'Show fewer' : `View all (${actions.length})`}
                    {!expanded && <Icon name="arrow" size={16} />}
                  </button>
                )}
              </div>
            </section>

            <div className="space-y-5">
              <section aria-labelledby="modules-h" className="card p-5">
                <div className="mb-1 flex items-center gap-2.5">
                  <span className="text-hub-teal">
                    <Icon name="modules" />
                  </span>
                  <h2 id="modules-h" className="text-lg font-bold">
                    Module status
                  </h2>
                </div>
                <p className="mb-3 text-sm text-slate-600">
                  {module
                    ? `Action required shows ${MODULE_LABEL[module] ?? words(module)} only. Select it again to show all modules.`
                    : 'Select a module to list only its items under Action required.'}
                </p>
                <ul className="space-y-2">
                  {(s?.modules ?? []).map((m: Row) => {
                    const unset = moduleNotSetUp.has(m.module);
                    const tint =
                      !unset && m.status === 'RED'
                        ? 'border-red-200 bg-red-50/60'
                        : 'border-hub-line bg-white';
                    return (
                      <li key={m.module}>
                        <button
                          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left hover:border-slate-300 ${tint} ${module === m.module ? 'ring-2 ring-hub-teal' : ''}`}
                          aria-pressed={module === m.module}
                          onClick={() => setModule(module === m.module ? '' : m.module)}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <span className="text-slate-500">
                              <Icon name={MODULE_ICON[m.module] ?? 'modules'} />
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-bold text-slate-900">
                                {MODULE_LABEL[m.module]}
                              </span>{' '}
                              {!unset && (
                                <span className="block text-xs text-slate-600">
                                  <span className="sr-only">(</span>
                                  {m.count} {m.label}
                                  <span className="sr-only">)</span>
                                </span>
                              )}
                            </span>
                          </span>
                          {unset ? (
                            <StatusBadge status="GREY" reason="Not set up" />
                          ) : (
                            <StatusBadge status={m.status as StatusKind} />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {module && (
                  <p className="mt-3 flex items-center gap-2 text-sm">
                    <span className="rounded-md border border-hub-teal/40 bg-hub-sky px-2 py-0.5 font-semibold text-hub-teal">
                      Filter: {MODULE_LABEL[module] ?? words(module)}
                    </span>
                    <button
                      className={textAction}
                      aria-label="Clear module filter"
                      onClick={() => setModule('')}
                    >
                      Clear filter
                    </button>
                  </p>
                )}
              </section>
              <section aria-labelledby="ops-h" className="card p-5">
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="text-hub-teal">
                    <Icon name="pulse" />
                  </span>
                  <h2 id="ops-h" className="text-lg font-bold">
                    Today in operations
                  </h2>
                </div>
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
                  {shows('JOBS') && (
                    <>
                      <dt className="text-slate-700">Jobs awaiting allocation</dt>
                      <dd className="text-right font-bold text-slate-900">
                        {s?.operations.jobsAwaitingAllocation ?? 'not connected yet'}
                      </dd>
                      <dt className="text-slate-700">Crew acknowledgements due</dt>
                      <dd className="text-right font-bold text-slate-900">
                        {s?.operations.acknowledgementsDue ?? 'not connected yet'}
                      </dd>
                    </>
                  )}
                  <dt className="text-slate-700">Critical findings open</dt>
                  <dd className="text-right font-bold text-slate-900">{s?.criticalOpen ?? '—'}</dd>
                </dl>
                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Critical findings remain visible until verified closed.
                </p>
              </section>
              {s && (
                <section aria-labelledby="cov-h" className="card p-5 text-sm">
                  <div className="mb-2 flex items-center gap-2.5">
                    <span className="text-hub-teal">
                      <Icon name="check" />
                    </span>
                    <h2 id="cov-h" className="text-lg font-bold">
                      Evidence coverage
                    </h2>
                  </div>
                  <p className="font-display text-3xl font-extrabold text-slate-900">
                    {s.coverage.percent === null
                      ? 'No applicable requirements.'
                      : `${s.coverage.percent}%`}
                  </p>
                  {s.coverage.percent !== null && (
                    <div
                      aria-hidden="true"
                      className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
                    >
                      <div
                        className="h-full rounded-full bg-hub-teal"
                        style={{ width: `${Math.min(100, Math.max(0, s.coverage.percent))}%` }}
                      />
                    </div>
                  )}
                  <p className="mt-2 text-slate-700">
                    {s.coverage.numerator} verified and current of {s.coverage.denominator}{' '}
                    applicable; {s.coverage.exclusions} not applicable excluded.
                  </p>
                  <p className="mt-1 text-xs font-semibold text-slate-600">{s.coverage.label}</p>
                </section>
              )}
            </div>
          </div>
          {orgCount > 1 && <GroupPanel />}
          {s && (
            <p className="text-xs text-slate-600">
              Last refreshed {fmtDateTime(s.lastRefreshedAt)}.{' '}
              {s.sources
                .filter((x: Row) => !x.ok)
                .map((x: Row) => `${words(x.name)} source not connected yet.`)
                .join(' ')}{' '}
              Internal measures on this dashboard are not CQC ratings.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Group dashboard: counts per authorised organisation. No records cross organisations. */
function GroupPanel() {
  const group = useOne<Row>('/api/v1/dashboard/group');
  const g = group.data;
  return (
    <section
      aria-labelledby="group-h"
      className="rounded-lg border border-hub-line bg-hub-card p-5"
      aria-busy={group.isLoading}
    >
      <h2 id="group-h" className="mb-1 text-lg font-bold">
        All my organisations
      </h2>
      <p className="mb-2 text-sm text-hub-muted">
        Counts only. Open an organisation from the switcher to see its records.
      </p>
      {group.isError ? (
        <p role="alert" className="text-red-900">
          <strong>Group figures unavailable.</strong> They could not be loaded, so none are shown.
        </p>
      ) : (
        <DataTable<Row>
          caption="Organisations"
          rows={g?.organisations ?? []}
          rowKey={(r) => r.organisationId}
          loading={group.isLoading}
          error={null}
          emptyMessage="No organisations with dashboard access."
          columns={[
            { key: 'o', header: 'Organisation', cell: (r) => r.organisationName },
            {
              key: 's',
              header: 'State',
              cell: (r) =>
                r.ok ? (
                  <StatusBadge
                    status={(r.worstStatus ?? 'GREY') as StatusKind}
                    reason={r.criticalOpen > 0 ? `${r.criticalOpen} critical open` : 'worst module'}
                  />
                ) : (
                  <StatusBadge status="GREY" reason={r.unavailableReason ?? 'unavailable'} />
                ),
            },
            { key: 'od', header: 'Overdue', cell: (r) => (r.tiles ? r.tiles.overdue : '—') },
            { key: 'ds', header: 'Due soon', cell: (r) => (r.tiles ? r.tiles.dueSoon : '—') },
            {
              key: 'bv',
              header: 'Blocked vehicles',
              cell: (r) => (r.tiles ? r.tiles.blockedVehicles : '—'),
            },
            { key: 'un', header: 'Unverified', cell: (r) => (r.tiles ? r.tiles.unverified : '—') },
            { key: 'jt', header: 'Jobs today', cell: (r) => (r.tiles ? r.tiles.jobsToday : '—') },
          ]}
        />
      )}
      {g?.totals && (
        <p className="mt-2 text-sm text-slate-700">
          Total across available organisations: {g.totals.overdue} overdue, {g.totals.dueSoon} due
          soon, {g.totals.blockedVehicles} blocked vehicles, {g.totals.unverified} unverified,{' '}
          {g.totals.criticalOpen} critical findings open.
        </p>
      )}
    </section>
  );
}
