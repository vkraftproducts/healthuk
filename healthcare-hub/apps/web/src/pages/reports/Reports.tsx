import { DataTable } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  button,
  Field,
  input,
  saveBlob,
  Section,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useList, useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NOTICE = 'Internal measure — not a CQC rating';

const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** Reports (PRD 4.10): every figure is shown with its numerator, denominator, period and rule. */
export function Reports() {
  const { orgId, api } = useApp();
  const can = useCan();
  const catalogue = useOne<{ data: Row[] }>('/api/v1/reports');
  const locations = useList(`/api/v1/organisations/${orgId}/locations`, !!orgId);
  const today = londonToday();
  const [q, setQ] = useState({
    id: 'WORKFORCE_READINESS',
    from: `${today.slice(0, 7)}-01`,
    to: today,
    locationId: '',
  });
  const qs = `from=${q.from}&to=${q.to}${q.locationId ? `&locationId=${q.locationId}` : ''}`;
  const report = useOne<Row>(orgId ? `/api/v1/reports/${q.id}?${qs}` : null);
  const { run, msg } = useRun();

  if (!can('reports.view'))
    return <p role="alert">You do not have permission to view reports for this organisation.</p>;

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setQ({
      id: String(f.get('id')),
      from: String(f.get('from')),
      to: String(f.get('to')),
      locationId: String(f.get('locationId') ?? ''),
    });
  }
  const r = report.data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-slate-700">
          Each figure states what is counted, over what period, and what is included. {NOTICE}.
        </p>
      </div>
      <form onSubmit={apply} className="flex flex-wrap items-end gap-3" aria-label="Report options">
        <Field label="Report">
          <select name="id" defaultValue={q.id} className={input}>
            {(catalogue.data?.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" name="from" defaultValue={q.from} required className={input} />
        </Field>
        <Field label="To">
          <input type="date" name="to" defaultValue={q.to} required className={input} />
        </Field>
        <Field label="Location">
          <select name="locationId" defaultValue={q.locationId} className={input}>
            <option value="">All locations</option>
            {(locations.data ?? []).map((l) => (
              <option key={String(l.id)} value={String(l.id)}>
                {String(l.name)}
              </option>
            ))}
          </select>
        </Field>
        <button className={button}>Run report</button>
        {can('reports.export') && (
          <button
            type="button"
            className={smallButton}
            onClick={() =>
              void run(
                async () =>
                  saveBlob(
                    await api.download!(`/api/v1/reports/${q.id}/export?${qs}`, orgId),
                    `${q.id.toLowerCase()}.csv`,
                  ),
                'CSV downloaded (logged).',
              )
            }
          >
            Export CSV
          </button>
        )}
      </form>
      {msg}
      {report.isLoading && <p role="status">Running the report…</p>}
      {report.isError && (
        <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
          The report could not be run. Check the dates (at most 366 days).
        </p>
      )}
      {r && (
        <section aria-labelledby="rep-h" className="space-y-4">
          <div>
            <h2 id="rep-h" className="text-xl font-semibold">
              {r.title}
            </h2>
            <p className="text-sm text-slate-700">
              {r.summary} Period {r.period.from} to {r.period.to}. {r.notice}.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {r.measures.map((m: Row) => (
              <article
                key={m.key}
                className="rounded-lg border border-hub-line bg-white p-4"
                aria-label={m.label}
              >
                <h3 className="text-sm text-slate-700">{m.label}</h3>
                <p className="mt-1 text-3xl font-bold">
                  {m.value === null ? 'No data' : m.unit === 'PERCENT' ? `${m.value}%` : m.value}
                </p>
                {m.unit === 'PERCENT' && m.value !== null && (
                  <p className="text-sm">
                    {m.numerator} of {m.denominator}
                  </p>
                )}
                <dl className="mt-2 space-y-1 text-xs text-slate-700">
                  {m.definition.numerator && (
                    <div>
                      <dt className="inline font-semibold">Counted: </dt>
                      <dd className="inline">{m.definition.numerator}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="inline font-semibold">Out of: </dt>
                    <dd className="inline">{m.definition.denominator}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">Period: </dt>
                    <dd className="inline">{m.definition.period}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold">Includes: </dt>
                    <dd className="inline">{m.definition.inclusion}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
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
        </section>
      )}
      {can('reports.export') && <ManagementPack />}
    </div>
  );
}

function ManagementPack() {
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
      <p className="text-sm">
        A PDF of every report for one month, with each measure’s definition. {NOTICE}.
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Month">
          <input type="month" name="month" defaultValue={lastMonth} required className={input} />
        </Field>
        <button className={button}>Request pack</button>
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
            cell: (x) =>
              new Date(x.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          { key: 's', header: 'Status', cell: (x) => words(x.status) },
          {
            key: 'd',
            header: 'Download',
            cell: (x) =>
              x.status === 'DONE' ? (
                <button
                  className={smallButton}
                  onClick={() =>
                    void run(async () => {
                      const j = (await api.get(`/api/v1/exports/${x.id}`, orgId)) as Row;
                      if (j.download) window.location.assign(j.download.url);
                    }, 'Download started (logged).')
                  }
                >
                  Download PDF
                </button>
              ) : null,
          },
        ]}
      />
    </Section>
  );
}
