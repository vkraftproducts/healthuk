import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { saveBlob, useCan, useRun, words } from '../components.js';
import { useApp } from '../shell/AppContext.js';
import { useOne } from './settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tiles are counted separately and never merged; each opens its exact drill-down (PRD §4.2, UAT-08). */
const TILES = [
  { key: 'overdue', label: 'Overdue tasks', kind: 'RED' as StatusKind },
  { key: 'dueSoon', label: 'Due in 30 days', kind: 'AMBER' as StatusKind },
  { key: 'blockedVehicles', label: 'Blocked vehicles', kind: 'RED' as StatusKind },
  { key: 'jobsToday', label: 'Jobs today', kind: 'GREY' as StatusKind },
] as const;
/** Large tile figures in the wireframe colours; the badge beside each carries the words. */
const TILE_COLOUR: Partial<Record<StatusKind, string>> = {
  RED: 'text-red-700',
  AMBER: 'text-amber-700',
  GREY: 'text-hub-teal',
};
/** Rows shown before "View all" (most urgent first, as returned by the API). */
const PREVIEW = 8;
const textAction = 'font-medium text-hub-navy underline-offset-2 hover:underline';
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
  const q = module ? `module=${module}` : '';
  const summary = useOne<Row>(canView ? `/api/v1/dashboard/summary${q ? `?${q}` : ''}` : null);
  const rows = useOne<{ data: Row[] }>(
    canView ? `/api/v1/dashboard/actions?tile=${tile}${q ? `&${q}` : ''}` : null,
  );
  const { run, msg } = useRun();
  const s = summary.data;
  const actions = rows.data?.data ?? [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Home dashboard</h1>
        <p className="text-slate-700">
          An action-led overview for the registered manager and operations team.
        </p>
      </div>
      {!orgId ? (
        <p role="status">Select an organisation to continue.</p>
      ) : !canView ? (
        <p role="alert">You do not have permission to view the dashboard for this organisation.</p>
      ) : summary.isError ? (
        <div role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
          <strong>Source unavailable.</strong> The dashboard could not be loaded. Figures are not
          shown rather than shown out of date.
        </div>
      ) : (
        <>
          <section
            aria-label="Key figures"
            className="grid grid-cols-2 gap-4 lg:grid-cols-4"
            aria-busy={summary.isLoading}
          >
            {TILES.map((t) => {
              const value = s ? (s.tiles[t.key] as number | null) : undefined;
              const connected = value !== null && value !== undefined;
              const selected = tile === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={!connected}
                  aria-pressed={selected}
                  onClick={() => setTile(selected ? 'all' : t.key)}
                  className={`rounded-lg border bg-white px-5 py-4 text-left hover:border-hub-teal ${selected ? 'border-hub-teal ring-2 ring-hub-teal' : 'border-hub-line'}`}
                >
                  <div
                    className={`text-4xl font-bold leading-tight ${connected && value !== 0 ? TILE_COLOUR[t.kind] : 'text-hub-navy'}`}
                    aria-label={
                      connected ? `${t.label}: ${value}` : `${t.label}: not connected yet`
                    }
                  >
                    {summary.isLoading ? '…' : connected ? value : '—'}
                  </div>
                  <div className="mt-1 text-sm text-hub-navy">{t.label}</div>
                  <div className="mt-3">
                    {connected ? (
                      <StatusBadge
                        status={value === 0 ? 'GREEN' : t.kind}
                        reason={
                          value === 0 ? 'none' : selected ? 'showing below' : 'select to list'
                        }
                      />
                    ) : (
                      <StatusBadge status="GREY" reason="not connected yet" />
                    )}
                  </div>
                </button>
              );
            })}
          </section>

          <div className="space-y-5">
            <section
              aria-labelledby="actions-h"
              className="rounded-lg border border-hub-line bg-white p-5"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 id="actions-h" className="text-lg font-bold">
                  Action required
                  {tile !== 'all'
                    ? ` – ${TILES.find((t) => t.key === tile)?.label ?? words(tile)}`
                    : ''}
                </h2>
                <div className="flex items-center gap-3 text-sm">
                  {tile !== 'all' && (
                    <>
                      <button className={textAction} onClick={() => setTile('all')}>
                        Clear filter
                      </button>
                      {(actions.length > PREVIEW || can('reports.export')) && (
                        <span aria-hidden="true">|</span>
                      )}
                    </>
                  )}
                  {actions.length > PREVIEW && (
                    <>
                      <button
                        className={textAction}
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                      >
                        {expanded ? 'Show fewer' : `View all (${actions.length})`}
                      </button>
                      {can('reports.export') && <span aria-hidden="true">|</span>}
                    </>
                  )}
                  {can('reports.export') && (
                    <button
                      className={textAction}
                      onClick={() =>
                        void run(
                          async () =>
                            saveBlob(
                              await api.download!(
                                `/api/v1/dashboard/actions/export?tile=${tile}`,
                                orgId,
                              ),
                              'action-required.csv',
                            ),
                          'Export downloaded (logged).',
                        )
                      }
                    >
                      Export
                    </button>
                  )}
                </div>
              </div>
              {msg}
              <DataTable<Row>
                caption="Action required"
                rows={expanded ? actions : actions.slice(0, PREVIEW)}
                rowKey={(r) => r.key}
                loading={rows.isLoading}
                error={rows.isError ? 'Could not load the action list.' : null}
                emptyMessage="Nothing needs action."
                columns={[
                  {
                    key: 'item',
                    header: 'Item',
                    cell: (r) => (
                      <Link
                        {...destination(r)}
                        className="font-medium text-hub-teal-dark underline"
                      >
                        {`${MODULE_LABEL[r.module] ?? r.module}: ${r.item}`}
                      </Link>
                    ),
                  },
                  {
                    key: 'owner',
                    header: 'Owner',
                    cell: (r) => (r.ownerUserId ? 'Assigned' : 'Unassigned'),
                  },
                  { key: 'deadline', header: 'Deadline', cell: (r) => r.deadline ?? '—' },
                  {
                    key: 'state',
                    header: 'State',
                    cell: (r) => (
                      <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />
                    ),
                  },
                ]}
              />
              {!expanded && actions.length > PREVIEW && (
                <p className="mt-1 text-sm text-hub-muted">
                  Showing the {PREVIEW} most urgent of {actions.length}.
                </p>
              )}
            </section>

            <div className="grid gap-5 lg:grid-cols-3">
              <section
                aria-labelledby="modules-h"
                className="rounded-lg border border-hub-line bg-white p-4"
              >
                <h2 id="modules-h" className="mb-2 text-lg font-bold">
                  Module status
                </h2>
                <ul className="space-y-2">
                  {(s?.modules ?? []).map((m: Row) => (
                    <li key={m.module}>
                      <button
                        className="flex w-full items-center justify-between gap-2 text-left"
                        aria-pressed={module === m.module}
                        onClick={() => setModule(module === m.module ? '' : m.module)}
                      >
                        <span>
                          {MODULE_LABEL[m.module]} ({m.count} {m.label})
                        </span>
                        <StatusBadge status={m.status as StatusKind} />
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-slate-700">
                  Click a module to see the exact requirements.
                </p>
              </section>
              <section
                aria-labelledby="ops-h"
                className="rounded-lg border border-hub-line bg-white p-4"
              >
                <h2 id="ops-h" className="mb-2 text-lg font-bold">
                  Today in operations
                </h2>
                <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                  <dt>Jobs awaiting allocation</dt>
                  <dd>{s?.operations.jobsAwaitingAllocation ?? 'not connected yet'}</dd>
                  <dt>Crew acknowledgements due</dt>
                  <dd>{s?.operations.acknowledgementsDue ?? 'not connected yet'}</dd>
                  <dt>Critical findings open</dt>
                  <dd>{s?.criticalOpen ?? '—'}</dd>
                </dl>
                <p className="mt-2 text-sm text-slate-700">
                  Critical findings remain visible until verified closed.
                </p>
              </section>
              {s && (
                <section
                  aria-labelledby="cov-h"
                  className="rounded-lg border border-hub-line bg-white p-4 text-sm"
                >
                  <h2 id="cov-h" className="mb-1 text-lg font-bold">
                    Evidence coverage
                  </h2>
                  <p>
                    {s.coverage.percent === null
                      ? 'No applicable requirements.'
                      : `${s.coverage.percent}%`}{' '}
                    ({s.coverage.numerator} verified and current of {s.coverage.denominator}{' '}
                    applicable; {s.coverage.exclusions} not applicable excluded)
                  </p>
                  <p className="mt-1 font-semibold">{s.coverage.label}</p>
                </section>
              )}
            </div>
          </div>
          {s && (
            <p className="text-sm text-slate-700">
              Last refreshed{' '}
              {new Date(s.lastRefreshedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })}.{' '}
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
