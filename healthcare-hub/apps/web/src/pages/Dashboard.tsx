import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  PageHeader,
  Tabs,
  fmtDate,
  fmtDateTime,
  saveBlob,
  useCan,
  useRun,
  words,
} from '../components.js';
import { useApp } from '../shell/AppContext.js';
import { useList, useOne, usePeople } from './settings/hooks.js';
import { MyWork } from './work/MyWork.js';
import { OverviewV36 } from './dashboard/OverviewV36.js';
import { Ms } from '../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tiles are counted separately and never merged; each opens its exact drill-down (PRD Â§4.2, UAT-08). */
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
const TILE_VALUE_STYLE: Partial<Record<StatusKind, { color?: string }>> = {
  RED: { color: '#b42318' },
  AMBER: { color: '#b54708' },
  GREY: { color: '#1667d9' },
};
/** Rows shown before "View all" (most urgent first, as returned by the API). */
const PREVIEW = 8;
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
  const { tab: linked, view: linkedView } = useSearch({ strict: false }) as {
    tab?: string;
    view?: string;
  };
  // v36 Dashboard tabs: Overview | My work (Alerts live in the header bell).
  const tabs = [
    { id: 'overview', label: 'Overview', show: canView },
    { id: 'work', label: 'My work', show: true },
  ];
  const tab =
    tabs.find((t) => t.id === linked && t.show)?.id ??
    (linked === 'alerts' ? 'work' : null) ??
    (tabs.find((t) => t.id === 'work' && t.show) ?? tabs.find((t) => t.show))?.id ??
    'work';
  const navigate = useNavigate();
  const setTab = (id: string) => void navigate({ to: '/', search: { tab: id } });
  const [tile, setTile] = useState<string>('all');
  const [module, setModule] = useState<string>('');
  const [expanded, setExpanded] = useState(false);
  const [detailed, setDetailed] = useState(linkedView === 'detailed');
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
  const notSetUp = !!s && s.coverage.denominator === 0 && s.coverage.exclusions === 0;
  const actions = rows.data?.data ?? [];
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

  const ownerOptions = [
    { value: '', label: 'Any owner' },
    { value: me.user.id, label: 'Me' },
    ...people
      .filter((u) => u.id && u.id !== me.user.id)
      .map((u) => ({
        value: u.id,
        label: `${u.displayName}${u.roleNames?.length ? ` (${u.roleNames.join(', ')})` : ''}`,
      })),
  ];

  return (
    <Space direction="vertical" size="large" className="w-full">
      <PageHeader
        extra={
          tab === 'overview' && canView ? (
            <Space wrap>
              <Button onClick={() => setDetailed((d) => !d)} aria-pressed={detailed}>
                <Ms i="insights" /> {detailed ? 'Summary view' : 'Detailed view'}
              </Button>
              <Button type="primary" onClick={() => setTab('work')}>
                <Ms i="inbox" /> Open my work
              </Button>
            </Space>
          ) : undefined
        }
        title="Dashboard"
        description={
          tab === 'work'
            ? 'The jobs waiting for you, most urgent first.'
            : `Organisation overview for the areas your role covers${
                roleName ? ` (${roleName})` : ''
              }.`
        }
      />
      <Tabs label="Dashboard" current={tab} onChange={setTab} tabs={tabs}>
        {tab === 'work' && <MyWork />}
        {tab === 'overview' && (
          <>
            {!orgId ? (
              <Typography.Text role="status">Select an organisation to continue.</Typography.Text>
            ) : !canView ? (
              <Alert
                type="error"
                showIcon
                role="alert"
                message="You do not have permission to view the overview for this organisation."
              />
            ) : !detailed ? (
              <OverviewV36 />
            ) : summary.isError ? (
              <Alert
                type="error"
                showIcon
                role="alert"
                message="Source unavailable."
                description="The dashboard could not be loaded. Figures are not shown rather than shown out of date."
              />
            ) : (
              <>
                <Card size="small">
                  <form
                    aria-label="Dashboard filters"
                    className="flex flex-wrap items-end gap-3 text-sm"
                    onSubmit={(e) => e.preventDefault()}
                  >
                    <label className="flex flex-col gap-1">
                      Location
                      <select
                        aria-label="Location"
                        className="field"
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
                    <label className="flex flex-col gap-1">
                      Service
                      <select
                        aria-label="Service"
                        className="field"
                        value={serviceId}
                        onChange={(e) => setServiceId(e.target.value)}
                      >
                        <option value="">All services</option>
                        {(services.data ?? []).map((svc) => (
                          <option key={String(svc.id)} value={String(svc.id)}>
                            {String(svc.name)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      Owner
                      <select
                        aria-label="Owner"
                        className="field"
                        value={ownerUserId}
                        onChange={(e) => setOwnerUserId(e.target.value)}
                      >
                        {ownerOptions.map((o) => (
                          <option key={o.value || 'any'} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1">
                      Deadline from
                      <input
                        type="date"
                        aria-label="Deadline from"
                        className="field"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      Deadline to
                      <input
                        type="date"
                        aria-label="Deadline to"
                        className="field"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                      />
                    </label>
                    {filtered && (
                      <Button
                        type="link"
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
                      </Button>
                    )}
                    {badRange && (
                      <Alert
                        type="error"
                        role="alert"
                        showIcon
                        className="w-full"
                        message="The end date is before the start date, so the date range is not applied."
                      />
                    )}
                  </form>
                </Card>
                {visibleModules?.length === 0 && (
                  <Alert
                    type="info"
                    role="status"
                    showIcon
                    message="Your role has no dashboard figures in this organisation. Use the navigation for the pages you can open."
                  />
                )}
                {notSetUp && (
                  <Alert
                    type="warning"
                    role="note"
                    showIcon
                    message="Nothing is set up yet: no requirements apply to any person, vehicle or premises item, so zero overdue does not mean compliant. Publish and map requirements in Settings, Requirement library."
                  />
                )}
                <section aria-label="Key figures" aria-busy={summary.isLoading}>
                  <Row gutter={[16, 16]}>
                    {tiles.map((t) => {
                      const value = s ? (s.tiles[t.key] as number | null) : undefined;
                      const connected = value !== null && value !== undefined;
                      const selected = tile === t.key;
                      const showColour = connected && value !== 0;
                      return (
                        <Col key={t.key} xs={12} lg={6}>
                          <Card
                            size="small"
                            className={`v36-kpi${selected ? ' v36-kpi-on' : ''}`}
                            {...(connected ? { 'data-act': 'tile' } : {})}
                            tabIndex={connected ? 0 : undefined}
                            role={connected ? 'button' : undefined}
                            aria-pressed={connected ? selected : undefined}
                            aria-label={
                              connected ? `${t.label}: ${value}` : `${t.label}: not connected yet`
                            }
                            onClick={() => connected && setTile(selected ? 'all' : t.key)}
                            onKeyDown={(e) => {
                              if (!connected) return;
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setTile(selected ? 'all' : t.key);
                              }
                            }}
                          >
                            <Statistic
                              loading={summary.isLoading}
                              title={t.label}
                              value={connected ? value : '\u2014'}
                              valueStyle={
                                showColour
                                  ? { ...TILE_VALUE_STYLE[t.kind], fontSize: 24, fontWeight: 600 }
                                  : { fontSize: 24, fontWeight: 600 }
                              }
                              formatter={(v) => (summary.isLoading ? '\u2026' : v)}
                            />
                            <div>
                              {connected &&
                              notSetUp &&
                              value === 0 &&
                              REQUIREMENT_TILES.has(t.key) ? (
                                <StatusBadge status="GREY" reason="not set up" />
                              ) : connected ? (
                                <StatusBadge
                                  status={value === 0 ? 'GREEN' : t.kind}
                                  reason={
                                    value === 0
                                      ? 'none'
                                      : selected
                                        ? 'showing below'
                                        : 'select to list'
                                  }
                                />
                              ) : (
                                <StatusBadge status="GREY" reason="not connected yet" />
                              )}
                            </div>
                          </Card>
                        </Col>
                      );
                    })}
                  </Row>
                </section>

                <Space direction="vertical" size="middle" className="w-full">
                  <Card
                    size="small"
                    title={
                      <Typography.Title level={4} id="actions-h" className="!mb-0 !text-lg">
                        Action required
                        {tile !== 'all'
                          ? ` â€“ ${TILES.find((t) => t.key === tile)?.label ?? words(tile)}`
                          : ''}
                        {module ? ` â€“ ${MODULE_LABEL[module] ?? words(module)} only` : ''}
                      </Typography.Title>
                    }
                    extra={
                      <Flex wrap="wrap" gap="small" align="center">
                        {(tile !== 'all' || module) && (
                          <>
                            <Button
                              type="link"
                              size="small"
                              onClick={() => {
                                setTile('all');
                                setModule('');
                              }}
                            >
                              Clear filter
                            </Button>
                            {(actions.length > PREVIEW || can('reports.export')) && (
                              <Typography.Text type="secondary" aria-hidden>
                                |
                              </Typography.Text>
                            )}
                          </>
                        )}
                        {actions.length > PREVIEW && (
                          <>
                            <Button
                              type="link"
                              size="small"
                              aria-expanded={expanded}
                              onClick={() => setExpanded(!expanded)}
                            >
                              {expanded ? 'Show fewer' : `View all (${actions.length})`}
                            </Button>
                            {can('reports.export') && (
                              <Typography.Text type="secondary" aria-hidden>
                                |
                              </Typography.Text>
                            )}
                          </>
                        )}
                        {can('reports.export') && (
                          <Button
                            type="link"
                            size="small"
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
                            Export
                          </Button>
                        )}
                      </Flex>
                    }
                  >
                    {msg}
                    <DataTable<Row>
                      caption="Action required"
                      rows={expanded ? actions : actions.slice(0, PREVIEW)}
                      rowKey={(r) => r.key}
                      rowName={(r) => `${MODULE_LABEL[r.module] ?? r.module}: ${r.item}`}
                      loading={rows.isLoading}
                      error={rows.isError ? 'Could not load the action list.' : null}
                      emptyMessage="Nothing needs action."
                      columns={[
                        {
                          key: 'item',
                          header: 'Item',
                          cell: (r) => (
                            <Link {...destination(r)}>
                              <Button type="link" size="small" className="!h-auto !p-0">
                                {`${MODULE_LABEL[r.module] ?? r.module}: ${r.item}`}
                              </Button>
                            </Link>
                          ),
                        },
                        { key: 'owner', header: 'Owner', cell: ownerText },
                        {
                          key: 'deadline',
                          header: 'Deadline',
                          cell: (r) => (r.deadline ? fmtDate(r.deadline) : 'â€”'),
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
                    {!expanded && actions.length > PREVIEW && (
                      <Typography.Text type="secondary" className="text-sm">
                        Showing the {PREVIEW} most urgent of {actions.length}.
                      </Typography.Text>
                    )}
                  </Card>

                  <Row gutter={[16, 16]}>
                    <Col xs={24} lg={8}>
                      <Card
                        size="small"
                        title={
                          <Typography.Title level={4} id="modules-h" className="!mb-0 !text-lg">
                            Module status
                          </Typography.Title>
                        }
                      >
                        <Space direction="vertical" className="w-full" size="small">
                          {(s?.modules ?? []).map((m: Row) => (
                            <Button
                              key={m.module}
                              type="text"
                              block
                              className="!h-auto !justify-between !text-left"
                              aria-pressed={module === m.module}
                              onClick={() => setModule(module === m.module ? '' : m.module)}
                            >
                              <span>
                                {MODULE_LABEL[m.module]}
                                {moduleNotSetUp.has(m.module) ? '' : ` (${m.count} ${m.label})`}
                              </span>
                              {moduleNotSetUp.has(m.module) ? (
                                <StatusBadge status="GREY" reason="Not set up" />
                              ) : (
                                <StatusBadge status={m.status as StatusKind} />
                              )}
                            </Button>
                          ))}
                        </Space>
                        {module && (
                          <Flex align="center" gap="small" className="mt-2">
                            <Tag color="processing">
                              Filter: {MODULE_LABEL[module] ?? words(module)}
                            </Tag>
                            <Button
                              type="link"
                              size="small"
                              aria-label="Clear module filter"
                              onClick={() => setModule('')}
                            >
                              Clear filter
                            </Button>
                          </Flex>
                        )}
                        <Typography.Paragraph className="!mb-0 mt-2 text-sm text-slate-700">
                          {module
                            ? `Action required shows ${MODULE_LABEL[module] ?? words(module)} only. Select it again to show all modules.`
                            : 'Select a module to list only its items under Action required.'}
                        </Typography.Paragraph>
                      </Card>
                    </Col>
                    <Col xs={24} lg={8}>
                      <Card
                        size="small"
                        title={
                          <Typography.Title level={4} id="ops-h" className="!mb-0 !text-lg">
                            Today in operations
                          </Typography.Title>
                        }
                      >
                        <Descriptions column={1} size="small" colon={false}>
                          {shows('JOBS') && (
                            <>
                              <Descriptions.Item label="Jobs awaiting allocation">
                                {s?.operations.jobsAwaitingAllocation ?? 'not connected yet'}
                              </Descriptions.Item>
                              <Descriptions.Item label="Crew acknowledgements due">
                                {s?.operations.acknowledgementsDue ?? 'not connected yet'}
                              </Descriptions.Item>
                            </>
                          )}
                          <Descriptions.Item label="Critical findings open">
                            {s?.criticalOpen ?? 'â€”'}
                          </Descriptions.Item>
                        </Descriptions>
                        <Typography.Paragraph className="!mb-0 mt-2 text-sm text-slate-700">
                          Critical findings remain visible until verified closed.
                        </Typography.Paragraph>
                      </Card>
                    </Col>
                    {s && (
                      <Col xs={24} lg={8}>
                        <Card
                          size="small"
                          title={
                            <Typography.Title level={4} id="cov-h" className="!mb-0 !text-lg">
                              Evidence coverage
                            </Typography.Title>
                          }
                        >
                          <Typography.Paragraph className="!mb-1 text-sm">
                            {s.coverage.percent === null
                              ? 'No applicable requirements.'
                              : `${s.coverage.percent}%`}{' '}
                            ({s.coverage.numerator} verified and current of {s.coverage.denominator}{' '}
                            applicable; {s.coverage.exclusions} not applicable excluded)
                          </Typography.Paragraph>
                          <Typography.Text strong>{s.coverage.label}</Typography.Text>
                        </Card>
                      </Col>
                    )}
                  </Row>
                </Space>
                {orgCount > 1 && <GroupPanel />}
                {s && (
                  <Typography.Paragraph className="!mb-0 text-sm text-slate-700">
                    Last refreshed {fmtDateTime(s.lastRefreshedAt)}.{' '}
                    {s.sources
                      .filter((x: Row) => !x.ok)
                      .map((x: Row) => `${words(x.name)} source not connected yet.`)
                      .join(' ')}{' '}
                    Internal measures on this dashboard are not CQC ratings.
                  </Typography.Paragraph>
                )}
              </>
            )}
          </>
        )}
      </Tabs>
    </Space>
  );
}

/** Group dashboard: counts per authorised organisation. No records cross organisations. */
function GroupPanel() {
  const group = useOne<Row>('/api/v1/dashboard/group');
  const g = group.data;
  return (
    <section aria-labelledby="group-h" aria-busy={group.isLoading}>
      <Card
        size="small"
        title={
          <Typography.Title level={4} id="group-h" className="!mb-0 !text-lg">
            All my organisations
          </Typography.Title>
        }
      >
        <Typography.Paragraph type="secondary" className="!mb-3 text-sm">
          Counts only. Open an organisation from the switcher to see its records.
        </Typography.Paragraph>
        {group.isError ? (
          <Alert
            type="error"
            role="alert"
            showIcon
            message="Group figures unavailable."
            description="They could not be loaded, so none are shown."
          />
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
                      reason={
                        r.criticalOpen > 0 ? `${r.criticalOpen} critical open` : 'worst module'
                      }
                    />
                  ) : (
                    <StatusBadge status="GREY" reason={r.unavailableReason ?? 'unavailable'} />
                  ),
              },
              { key: 'od', header: 'Overdue', cell: (r) => (r.tiles ? r.tiles.overdue : 'â€”') },
              { key: 'ds', header: 'Due soon', cell: (r) => (r.tiles ? r.tiles.dueSoon : 'â€”') },
              {
                key: 'bv',
                header: 'Blocked vehicles',
                cell: (r) => (r.tiles ? r.tiles.blockedVehicles : 'â€”'),
              },
              {
                key: 'un',
                header: 'Unverified',
                cell: (r) => (r.tiles ? r.tiles.unverified : 'â€”'),
              },
              {
                key: 'jt',
                header: 'Jobs today',
                cell: (r) => (r.tiles ? r.tiles.jobsToday : 'â€”'),
              },
            ]}
          />
        )}
        {g?.totals && (
          <Typography.Paragraph className="!mb-0 mt-2 text-sm text-slate-700">
            Total across available organisations: {g.totals.overdue} overdue, {g.totals.dueSoon} due
            soon, {g.totals.blockedVehicles} blocked vehicles, {g.totals.unverified} unverified,{' '}
            {g.totals.criticalOpen} critical findings open.
          </Typography.Paragraph>
        )}
      </Card>
    </section>
  );
}
