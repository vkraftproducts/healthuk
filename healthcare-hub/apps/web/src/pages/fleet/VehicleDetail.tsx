import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Field, Section, Tabs, button, input, useCan, useRun, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { Defects, VehicleBadge } from './Fleet.js';
import { ViewDocument } from '../ViewDocument.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MAINT: Record<string, StatusKind> = { OK: 'GREEN', DUE_SOON: 'AMBER', OVERDUE: 'RED' };

export function VehicleDetail() {
  const { id } = useParams({ strict: false }) as { id: string };
  const can = useCan();
  const [tab, setTab] = useState('overview');
  const res = useOne<Row>(`/api/v1/vehicles/${id}`);
  if (res.isLoading) return <p role="status">Loading…</p>;
  if (res.isError || !res.data)
    return (
      <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
        This vehicle is not available.
      </p>
    );
  const v = res.data;
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/vehicles" className="font-medium text-hub-teal-dark underline">
          Vehicles and assets
        </Link>{' '}
        / {v.callsign}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-hub-line bg-white p-4">
        <div>
          <h1 className="text-2xl font-bold">
            {v.callsign} <span className="text-slate-600">/ {v.registration}</span>
          </h1>
          <p className="text-sm">
            {words(v.type)} · {v.seats} seats · {v.capability.wheelchairCapacity} wheelchair ·{' '}
            {v.capability.stretcher ? 'stretcher' : 'no stretcher'} · licence {v.licenceCategory}
          </p>
          {v.capability.lost.length > 0 && (
            <p className="mt-1 text-sm text-red-900">
              Capability reduced: {v.capability.lost.join('; ')}
            </p>
          )}
        </div>
        <VehicleBadge v={v} />
      </header>
      <Tabs
        label="Vehicle sections"
        current={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Maintenance and odometer' },
          { id: 'defects', label: 'Defects' },
          { id: 'inspections', label: 'Inspections', show: can('fleet.vdi.view') },
          { id: 'documents', label: 'Documents' },
        ]}
      >
        {tab === 'overview' && <Overview v={v} />}
        {tab === 'defects' && <Defects vehicleId={v.id} />}
        {tab === 'inspections' && <Inspections vehicleId={v.id} />}
        {tab === 'documents' && <Documents vehicleId={v.id} />}
      </Tabs>
    </div>
  );
}

function Overview({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  async function odometer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      await run(
        () =>
          api.send('POST', `/api/v1/vehicles/${v.id}/odometer`, orgId, {
            reading: Number(f.get('reading')),
            readOn: String(f.get('readOn')),
          }),
        'Reading recorded.',
      )
    )
      form.reset();
  }
  return (
    <>
      {msg}
      <Section title="Maintenance (date or mileage, whichever first)">
        <DataTable<Row>
          caption="Maintenance plans"
          rows={v.maintenance}
          rowKey={(r) => r.id}
          emptyMessage="No maintenance plans."
          columns={[
            { key: 't', header: 'Plan', cell: (r) => r.title },
            {
              key: 'i',
              header: 'Interval',
              cell: (r) =>
                [
                  r.intervalDays && `${r.intervalDays} days`,
                  r.intervalMiles && `${r.intervalMiles.toLocaleString('en-GB')} miles`,
                ]
                  .filter(Boolean)
                  .join(' or '),
            },
            {
              key: 'd',
              header: 'Due',
              cell: (r) =>
                [r.dueDate, r.dueOdometer && `${r.dueOdometer.toLocaleString('en-GB')} mi`]
                  .filter(Boolean)
                  .join(' or ') || '—',
            },
            {
              key: 's',
              header: 'Status',
              cell: (r) => <StatusBadge status={MAINT[r.state] ?? 'GREY'} reason={r.text} />,
            },
          ]}
        />
      </Section>
      <Section title="Odometer">
        <DataTable<Row>
          caption="Recent odometer readings"
          rows={v.readings}
          rowKey={(r) => r.id}
          emptyMessage="No readings."
          columns={[
            { key: 'd', header: 'Date', cell: (r) => r.readOn },
            { key: 'r', header: 'Reading', cell: (r) => `${r.reading.toLocaleString('en-GB')} mi` },
            { key: 's', header: 'Source', cell: (r) => words(r.source) },
            {
              key: 'f',
              header: 'Flags',
              cell: (r) => (r.flags.length ? r.flags.map(words).join(', ') : 'None'),
            },
          ]}
        />
        {can('fleet.vehicle.manage') && (
          <form
            onSubmit={odometer}
            className="flex flex-wrap items-end gap-3"
            aria-label="Record odometer reading"
          >
            <Field label="Reading (miles)">
              <input name="reading" type="number" min={0} required className={input} />
            </Field>
            <Field label="Date">
              <input name="readOn" type="date" required className={input} />
            </Field>
            <button className={button}>Record</button>
          </form>
        )}
      </Section>
    </>
  );
}

function Inspections({ vehicleId }: { vehicleId: string }) {
  const vdis = useOne<{ data: Row[] }>(`/api/v1/vdis?vehicleId=${vehicleId}`);
  const cleaning = useOne<{ data: Row[] }>(`/api/v1/cleaning-records?vehicleId=${vehicleId}`);
  return (
    <>
      <DataTable<Row>
        caption="Daily inspections"
        rows={vdis.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={vdis.isLoading}
        emptyMessage="No inspections."
        columns={[
          {
            key: 'c',
            header: 'Captured',
            cell: (r) =>
              new Date(r.capturedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          {
            key: 'r',
            header: 'Received',
            cell: (r) =>
              new Date(r.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          {
            key: 'o',
            header: 'Outcome',
            cell: (r) => (
              <StatusBadge
                status={r.outcome === 'PASS' ? 'GREEN' : 'RED'}
                reason={
                  r.outcome === 'PASS'
                    ? 'Pass'
                    : `Fail – ${r.results
                        .filter((x: Row) => x.result === 'FAIL')
                        .map((x: Row) => words(x.code))
                        .join(', ')}`
                }
              />
            ),
          },
          { key: 'a', header: 'Amendments', cell: (r) => String(r.amendments.length) },
        ]}
      />
      <DataTable<Row>
        caption="Cleaning records"
        rows={cleaning.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={cleaning.isLoading}
        emptyMessage="No cleaning records."
        columns={[
          { key: 't', header: 'Type', cell: (r) => words(r.type) },
          {
            key: 'c',
            header: 'Captured',
            cell: (r) =>
              new Date(r.capturedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
        ]}
      />
    </>
  );
}

function Documents({ vehicleId }: { vehicleId: string }) {
  const res = useOne<{ data: Row[] }>(
    `/api/v1/requirements/instances?subjectId=${vehicleId}&limit=100`,
  );
  return (
    <DataTable<Row>
      caption="Vehicle documents and requirements"
      rows={res.data?.data ?? []}
      rowKey={(r) => r.id}
      loading={res.isLoading}
      error={res.isError ? 'You do not have access to vehicle requirements.' : null}
      emptyMessage="No requirements. Publish vehicle templates (MOT, insurance, tax) with auto-apply."
      columns={[
        { key: 't', header: 'Requirement', cell: (r) => r.templateTitle },
        { key: 'd', header: 'Expiry', cell: (r) => r.expiryDate ?? r.dueDate ?? '—' },
        {
          key: 's',
          header: 'Status',
          cell: (r) => <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />,
        },
        {
          key: 'doc',
          header: 'Document',
          cell: (r) => <ViewDocument instanceId={r.id} label={r.templateTitle} />,
        },
      ]}
    />
  );
}
