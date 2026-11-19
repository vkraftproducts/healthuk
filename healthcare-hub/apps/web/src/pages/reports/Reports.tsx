import { DataTable } from '@hub/ui';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Typography,
} from 'antd';
import { useState, type FormEvent } from 'react';
import {
  Tabs,
  Field,
  fmtDateTime,
  saveBlob,
  Section,
  useCan,
  useRun,
  words,
  PageHeader,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { Ms } from '../../v36/ui.js';
import { useList, useOne } from '../settings/hooks.js';
import { Inspection } from '../inspection/Inspection.js';
import { AuditPanel } from '../settings/Settings.js';
import { RecordsByDate } from './RecordsByDate.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOTICE = 'Internal measure — not a CQC rating';

const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** Reports module (v36): standard reports, inspection view, audit trail. */
export function Reports() {
  const can = useCan();
  const tabs = [
    { id: 'standard', label: 'Standard reports', show: can('reports.view') },
    { id: 'inspection', label: 'Inspection view', show: can('inspection.view') },
    { id: 'audit', label: 'Audit trail', show: can('admin.audit.view') },
  ];
  const { tab: linked } = useSearch({ strict: false }) as { tab?: string };
  const tab = tabs.find((t) => t.id === linked && t.show)?.id ?? tabs.find((t) => t.show)?.id ?? '';
  const navigate = useNavigate();
  const setTab = (id: string) => void navigate({ to: '/reports', search: { tab: id } });
  const [pack, setPack] = useState(false);

  if (!tabs.some((t) => t.show))
    return (
      <Alert
        type="warning"
        showIcon
        role="alert"
        message="You do not have permission to view reports for this organisation."
      />
    );

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <PageHeader
        title="Reports"
        description={
          <>Standard reports, the inspection overview and the organisation audit trail. {NOTICE}.</>
        }
        extra={
          can('reports.export') ? (
            <Button type="primary" onClick={() => setPack(true)}>
              <Ms i="inventory_2" /> Monthly management pack
            </Button>
          ) : undefined
        }
      />
      <Modal
        open={pack}
        title="Monthly management pack"
        onCancel={() => setPack(false)}
        footer={null}
        width={760}
        className="hh-modal"
        destroyOnHidden
      >
        <ManagementPack />
      </Modal>
      <Tabs
        label="Reports sections"
        current={tab === 'audit' ? 'audit' : 'reports'}
        onChange={(g) =>
          setTab(
            g === 'audit'
              ? 'audit'
              : (tabs.find((t) => t.id !== 'audit' && t.show)?.id ?? 'standard'),
          )
        }
        tabs={[
          {
            id: 'reports',
            label: 'Reports & inspection',
            show: tabs.some((t) => t.id !== 'audit' && t.show),
          },
          { id: 'audit', label: 'Audit trail', show: tabs[2]!.show },
        ]}
      >
        {tab !== 'audit' && tabs[0]!.show && tabs[1]!.show ? (
          <Tabs
            label="Reports view"
            current={tab}
            onChange={setTab}
            tabs={tabs.filter((t) => t.id !== 'audit')}
          >
            {tab === 'standard' && <StandardReports />}
            {tab === 'inspection' && <Inspection />}
          </Tabs>
        ) : (
          <>
            {tab === 'standard' && <StandardReports />}
            {tab === 'inspection' && <Inspection />}
          </>
        )}
        {tab === 'audit' && <AuditPanel />}
      </Tabs>
    </Space>
  );
}

const REPORT_ICON: Record<string, string> = {
  WORKFORCE_READINESS: 'badge',
  SUPERVISION: 'supervisor_account',
  FLEET: 'ambulance',
  AUDITS_ACTIONS: 'rule',
  EVENTS: 'report',
  POLICY_ACK: 'policy',
  PREMISES: 'domain',
  JOURNEYS: 'route',
  NHS_KPI: 'verified',
};

function StandardReports() {
  const { orgId, api } = useApp();
  const can = useCan();
  const catalogue = useOne<{ data: Row[] }>('/api/v1/reports');
  const locations = useList(`/api/v1/organisations/${orgId}/locations`, !!orgId);
  const today = londonToday();
  const [q, setQ] = useState<{ id: string | null; from: string; to: string; locationId: string }>({
    id: null,
    from: `${today.slice(0, 7)}-01`,
    to: today,
    locationId: '',
  });
  const [draft, setDraft] = useState({
    from: `${today.slice(0, 7)}-01`,
    to: today,
    locationId: '',
    id: '' as string,
  });
  const available = catalogue.data?.data ?? [];
  const id = q.id ?? (available[0]?.id as string | undefined) ?? null;
  const qs = `from=${q.from}&to=${q.to}${q.locationId ? `&locationId=${q.locationId}` : ''}`;
  const report = useOne<Row>(orgId && id ? `/api/v1/reports/${id}?${qs}` : null);
  const { run, msg } = useRun();
  const [open, setOpen] = useState(false);

  if (catalogue.data && available.length === 0)
    return (
      <Alert
        type="info"
        showIcon
        role="status"
        message="Your role has no reports in this organisation. Reports cover staff, vehicles, audits, events, policies, premises or journeys, and each needs access to that area."
      />
    );

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setQ({
      id: draft.id || id,
      from: draft.from,
      to: draft.to,
      locationId: draft.locationId,
    });
  }
  const r = report.data;
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div className="wf-rep" role="group" aria-label="Choose a report">
        {available.map((c) => {
          const cid = String(c.id);
          return (
            <button
              key={cid}
              type="button"
              className={`wf-rc${cid === id ? ' on' : ''}`}
              aria-pressed={cid === id}
              onClick={() => {
                setDraft({ ...draft, id: cid });
                setQ({ ...q, id: cid });
                setOpen(true);
              }}
            >
              <span className="ic">
                <Ms i={REPORT_ICON[cid] ?? 'analytics'} />
              </span>
              <b>{String(c.title)}</b>
              {c.summary ? <small>{String(c.summary)}</small> : null}
            </button>
          );
        })}
      </div>
      <RecordsByDate />
      <Modal
        open={open}
        title={r?.title ?? available.find((c) => String(c.id) === id)?.title ?? 'Report'}
        onCancel={() => setOpen(false)}
        footer={null}
        width={1000}
        className="hh-modal"
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <form
            onSubmit={apply}
            aria-label="Report options"
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}
          >
            <Field label="Report">
              <Select
                key={id ?? ''}
                value={(draft.id || id) ?? undefined}
                onChange={(v) => setDraft({ ...draft, id: v })}
                style={{ minWidth: 200 }}
                options={available.map((c) => ({ value: String(c.id), label: String(c.title) }))}
              />
            </Field>
            <Field label="From">
              <Input
                type="date"
                value={draft.from}
                required
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={draft.to}
                required
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
              />
            </Field>
            <Field label="Location">
              <Select
                value={draft.locationId || undefined}
                allowClear
                placeholder="All locations"
                onChange={(v) => setDraft({ ...draft, locationId: v ?? '' })}
                style={{ minWidth: 160 }}
                options={(locations.data ?? []).map((l) => ({
                  value: String(l.id),
                  label: String(l.name),
                }))}
              />
            </Field>
            <Button type="primary" htmlType="submit" style={{ marginBottom: 12 }}>
              Run report
            </Button>
            {can('reports.export') && id && (
              <Button
                type="default"
                style={{ marginBottom: 12 }}
                onClick={() =>
                  void run(
                    async () =>
                      saveBlob(
                        await api.download!(`/api/v1/reports/${id}/export?${qs}`, orgId),
                        `${id.toLowerCase()}.csv`,
                      ),
                    'CSV downloaded (logged).',
                  )
                }
              >
                Export CSV
              </Button>
            )}
          </form>
          {!can('reports.export') && (
            <Typography.Paragraph type="secondary" role="note" style={{ marginBottom: 0 }}>
              You can run and read these reports. Exporting to CSV and requesting the monthly
              management pack need the export permission, which your role does not have: ask your
              registered manager or governance lead for a copy.
            </Typography.Paragraph>
          )}
          {msg}
          {report.isLoading && (
            <Spin aria-label="Running the report">
              <Typography.Paragraph role="status">Running the report…</Typography.Paragraph>
            </Spin>
          )}
          {report.isError && (
            <Alert
              type="error"
              showIcon
              role="alert"
              message="The report could not be run. Check the dates (at most 366 days)."
            />
          )}
          {r && (
            <section aria-labelledby="rep-h">
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div>
                  <Typography.Title id="rep-h" level={4} style={{ margin: 0 }}>
                    {r.title}
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    {r.summary} Period {r.period.from} to {r.period.to}. {r.notice}.
                  </Typography.Paragraph>
                </div>
                <Row gutter={[16, 16]}>
                  {r.measures.map((m: Row) => (
                    <Col key={m.key} xs={24} md={12} lg={8}>
                      <Card size="small" aria-label={m.label}>
                        <Typography.Text type="secondary">{m.label}</Typography.Text>
                        <Typography.Title level={2} style={{ margin: '4px 0' }}>
                          {m.value === null
                            ? 'No data'
                            : m.unit === 'PERCENT'
                              ? `${m.value}%`
                              : m.value}
                        </Typography.Title>
                        {m.unit === 'PERCENT' && m.value !== null && (
                          <Typography.Text>
                            {m.numerator} of {m.denominator}
                          </Typography.Text>
                        )}
                        <Descriptions
                          size="small"
                          column={1}
                          style={{ marginTop: 8 }}
                          items={[
                            ...(m.definition.numerator
                              ? [{ key: 'n', label: 'Counted', children: m.definition.numerator }]
                              : []),
                            { key: 'd', label: 'Out of', children: m.definition.denominator },
                            { key: 'p', label: 'Period', children: m.definition.period },
                            { key: 'i', label: 'Includes', children: m.definition.inclusion },
                          ]}
                        />
                      </Card>
                    </Col>
                  ))}
                </Row>
                {r.tables.map((t: Row) => (
                  <DataTable<Row>
                    key={t.key}
                    caption={t.title}
                    rows={t.rows.map((cells: unknown[], i: number) => ({ i, cells }))}
                    rowKey={(x) => String(x.i)}
                    emptyMessage="Nothing to show for this period."
                    columns={t.columns.map((c: string, ci: number) => ({
                      key: String(ci),
                      header: c,
                      cell: (x: Row) => {
                        const v = x.cells[ci];
                        return v === null || v === undefined
                          ? '—'
                          : typeof v === 'string' && /^[A-Z_]+$/.test(v)
                            ? words(v)
                            : String(v);
                      },
                    }))}
                  />
                ))}
              </Space>
            </section>
          )}
        </Space>
      </Modal>
    </Space>
  );
}

export function ManagementPack() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const exports = useOne<{ data: Row[] }>('/api/v1/exports');
  const lastMonth = (() => {
    const [y, m] = londonToday().split('-').map(Number) as [number, number];
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  })();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      () => api.send('POST', '/api/v1/management-packs', orgId, { month: String(f.get('month')) }),
      'Requested. The pack is built in the background; refresh to see when it is ready.',
    );
    void exports.refetch();
  }
  const packs = (exports.data?.data ?? []).filter((x) => x.kind === 'MANAGEMENT_PACK');
  return (
    <Section title="Monthly management pack">
      <Typography.Paragraph type="secondary">
        A PDF of every report for one month, with each measure’s definition. {NOTICE}.
      </Typography.Paragraph>
      <form
        onSubmit={submit}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}
      >
        <Field label="Month">
          <Input type="month" name="month" defaultValue={lastMonth} required />
        </Field>
        <Button type="primary" htmlType="submit" style={{ marginBottom: 12 }}>
          Request pack
        </Button>
      </form>
      {msg}
      <DataTable<Row>
        caption="Your management packs"
        rows={packs}
        rowKey={(x) => x.id}
        emptyMessage="No management packs yet."
        columns={[
          {
            key: 'c',
            header: 'Requested',
            cell: (x) => fmtDateTime(x.createdAt),
          },
          { key: 's', header: 'Status', cell: (x) => words(x.status) },
          {
            key: 'd',
            header: 'Download',
            cell: (x) =>
              x.status === 'DONE' ? (
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    void run(async () => {
                      const j = (await api.get(`/api/v1/exports/${x.id}`, orgId)) as Row;
                      if (j.download) window.location.assign(j.download.url);
                    }, 'Download started (logged).')
                  }
                >
                  Download PDF
                </Button>
              ) : null,
          },
        ]}
      />
    </Section>
  );
}
