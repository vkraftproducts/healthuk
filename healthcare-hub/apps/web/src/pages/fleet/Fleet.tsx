import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  Field,
  Section,
  Tabs,
  button,
  input,
  pounds,
  saveBlob,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Vehicle status mapped onto the shared RAG badge: text + icon + colour, never colour alone. */
export const VEHICLE_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  AVAILABLE: { kind: 'GREEN', text: 'Available' },
  BLOCKED: { kind: 'RED', text: 'Blocked' },
  QUARANTINED: { kind: 'RED', text: 'Quarantined' },
  OFF_ROAD: { kind: 'GREY', text: 'Off road' },
};
export function VehicleBadge({ v }: { v: Row }) {
  const s = VEHICLE_STATUS[v.status] ?? { kind: 'GREY' as StatusKind, text: v.status };
  return (
    <StatusBadge
      status={s.kind}
      reason={v.statusReason ? `${s.text} – ${v.statusReason}` : s.text}
    />
  );
}

export function Fleet() {
  const can = useCan();
  const { orgId } = useApp();
  const [tab, setTab] = useState('vehicles');
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  if (!can('fleet.vehicle.view') && !can('fleet.expense.submit'))
    return (
      <p role="alert" className="rounded-lg border border-hub-line bg-white p-3">
        You do not have access to vehicles and assets.
      </p>
    );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vehicles and assets</h1>
      <Tabs
        label="Fleet sections"
        current={tab}
        onChange={setTab}
        tabs={[
          { id: 'vehicles', label: 'Vehicles', show: can('fleet.vehicle.view') },
          { id: 'equipment', label: 'Equipment', show: can('fleet.vehicle.view') },
          { id: 'defects', label: 'Defects', show: can('fleet.vehicle.view') },
          { id: 'expenses', label: 'Fuel and expenses' },
        ]}
      >
        {tab === 'vehicles' && <Vehicles />}
        {tab === 'equipment' && <Equipment />}
        {tab === 'defects' && <Defects />}
        {tab === 'expenses' && <Expenses />}
      </Tabs>
    </div>
  );
}

function Vehicles() {
  const can = useCan();
  const [status, setStatus] = useState('');
  const res = useOne<{ data: Row[] }>(`/api/v1/vehicles${status ? `?status=${status}` : ''}`);
  return (
    <>
      <Field label="Status">
        <select
          className={`${input} w-56`}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All</option>
          {Object.entries(VEHICLE_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.text}
            </option>
          ))}
        </select>
      </Field>
      <DataTable<Row>
        caption="Vehicles"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load vehicles.' : null}
        emptyMessage="No vehicles."
        columns={[
          {
            key: 'cs',
            header: 'Callsign',
            cell: (r) => (
              <Link
                to="/vehicles/$id"
                params={{ id: r.id }}
                className="font-medium text-hub-teal-dark underline"
              >
                {r.callsign}
              </Link>
            ),
          },
          { key: 'reg', header: 'Registration', cell: (r) => r.registration },
          { key: 'type', header: 'Type', cell: (r) => words(r.type) },
          {
            key: 'cap',
            header: 'Capability',
            cell: (r) =>
              `${r.seats} seats, ${r.wheelchairCapacity} wheelchair, ${r.stretcher ? 'stretcher' : 'no stretcher'}`,
          },
          {
            key: 'odo',
            header: 'Odometer',
            cell: (r) =>
              r.currentOdometer === null ? '—' : `${r.currentOdometer.toLocaleString('en-GB')} mi`,
          },
          { key: 'def', header: 'Open defects', cell: (r) => String(r.openDefects) },
          { key: 'st', header: 'Status', cell: (r) => <VehicleBadge v={r} /> },
        ]}
      />
      {can('fleet.vehicle.manage') && <AddVehicle />}
    </>
  );
}

function AddVehicle() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/vehicles', orgId, {
          registration: String(f.get('registration')),
          callsign: String(f.get('callsign')),
          type: String(f.get('type')),
          baseLocationId: String(f.get('location')),
          seats: Number(f.get('seats') || 0),
          wheelchairCapacity: Number(f.get('wheelchairs') || 0),
          stretcher: f.get('stretcher') === 'on',
        }),
      'Vehicle added. Vehicle requirements (MOT, insurance, tax) were applied automatically where configured.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="Add a vehicle">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Registration">
          <input name="registration" required className={input} />
        </Field>
        <Field label="Callsign">
          <input name="callsign" required placeholder="AMB-03" className={input} />
        </Field>
        <Field label="Type">
          <select name="type" className={input}>
            {['AMBULANCE', 'PTS_VEHICLE', 'WAV', 'CAR', 'MINIBUS', 'OTHER'].map((t) => (
              <option key={t} value={t}>
                {words(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Base">
          <select name="location" required className={input}>
            {(locations.data?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Seats">
          <input name="seats" type="number" min={0} max={60} className={`${input} w-20`} />
        </Field>
        <Field label="Wheelchair spaces">
          <input name="wheelchairs" type="number" min={0} max={10} className={`${input} w-20`} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="stretcher" /> Stretcher
        </label>
        <button className={button}>Add</button>
      </form>
      {msg}
    </Section>
  );
}

function Equipment() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>('/api/v1/equipment');
  const act = (id: string, kind: 'quarantine' | 'release') => {
    const reason = window.prompt(
      kind === 'quarantine' ? 'Why is this asset being quarantined?' : 'Why is it safe to release?',
    );
    if (!reason || reason.trim().length < 3) return;
    void run(
      () => api.send('POST', `/api/v1/equipment/${id}/${kind}`, orgId, { reason: reason.trim() }),
      kind === 'quarantine'
        ? 'Quarantined. Vehicle capability recalculated.'
        : 'Released to service.',
    );
  };
  return (
    <>
      {msg}
      <DataTable<Row>
        caption="Equipment"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load equipment.' : null}
        emptyMessage="No equipment."
        columns={[
          { key: 'tag', header: 'Asset', cell: (r) => r.assetTag },
          { key: 'cat', header: 'Category', cell: (r) => words(r.category) },
          {
            key: 'swl',
            header: 'Safe working load',
            cell: (r) => (r.swlKg ? `${r.swlKg} kg` : '—'),
          },
          {
            key: 'reg',
            header: 'Inspection regimes',
            cell: (r) =>
              r.regimes.length === 0 ? (
                'None'
              ) : (
                <ul className="space-y-1">
                  {r.regimes.map((g: Row) => (
                    <li key={g.regime}>
                      {words(g.regime)}:{' '}
                      <StatusBadge status={g.status as StatusKind} reason={g.reasonText} />
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            key: 'st',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={r.status === 'AVAILABLE' ? 'GREEN' : 'RED'}
                reason={
                  r.status === 'AVAILABLE'
                    ? 'In service'
                    : `Quarantined – ${r.quarantineReason ?? ''}`
                }
              />
            ),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              r.status === 'AVAILABLE' && can('fleet.vehicle.manage') ? (
                <button className={smallButton} onClick={() => act(r.id, 'quarantine')}>
                  Quarantine<span className="sr-only"> {r.assetTag}</span>
                </button>
              ) : r.status === 'QUARANTINED' && can('fleet.return_to_service') ? (
                <button className={smallButton} onClick={() => act(r.id, 'release')}>
                  Release<span className="sr-only"> {r.assetTag}</span>
                </button>
              ) : null,
          },
        ]}
      />
    </>
  );
}

export function Defects({ vehicleId }: { vehicleId?: string }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>(
    `/api/v1/defects${vehicleId ? `?vehicleId=${vehicleId}` : ''}`,
  );
  const release = (d: Row) => {
    const reason = window.prompt('Return to service: what was checked after the repair?');
    if (!reason || reason.trim().length < 3) return;
    void run(
      () => api.send('POST', `/api/v1/defects/${d.id}/release`, orgId, { reason: reason.trim() }),
      'Released to service.',
    );
  };
  return (
    <>
      {msg}
      <DataTable<Row>
        caption="Open defects"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load defects.' : null}
        emptyMessage="No open defects."
        columns={[
          {
            key: 'sev',
            header: 'Severity',
            cell: (r) => (
              <StatusBadge
                status={r.stopUse ? 'RED' : r.severity === 'MAJOR' ? 'AMBER' : 'GREY'}
                reason={`${words(r.severity)}${r.stopUse ? ' – stop use' : ''}`}
              />
            ),
          },
          { key: 'desc', header: 'Description', cell: (r) => r.description },
          {
            key: 'when',
            header: 'Reported',
            cell: (r) =>
              new Date(r.discoveredAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          { key: 'status', header: 'Progress', cell: (r) => words(r.status) },
          {
            key: 'act',
            header: 'Action',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                {can('fleet.defect.manage') && r.status !== 'REPAIRED' && (
                  <button
                    className={smallButton}
                    onClick={() =>
                      void run(
                        () =>
                          api.send(
                            'PATCH',
                            `/api/v1/defects/${r.id}`,
                            orgId,
                            { status: 'REPAIRED' },
                            r.version,
                          ),
                        'Marked repaired. Release to service is a separate step.',
                      )
                    }
                  >
                    Mark repaired
                  </button>
                )}
                {can('fleet.return_to_service') && r.status === 'REPAIRED' && (
                  <button className={smallButton} onClick={() => release(r)}>
                    Return to service
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

function Expenses() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>('/api/v1/fuel-expenses');
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const name = (id: string) => vehicles.data?.data.find((v) => v.id === id)?.callsign ?? 'Vehicle';
  return (
    <>
      {msg}
      {can('fleet.expense.approve') && (
        <button
          className={smallButton}
          onClick={() =>
            void run(
              async () =>
                saveBlob(
                  await api.download!('/api/v1/fuel-expenses/export', orgId),
                  'fuel-expenses.csv',
                ),
              'Export downloaded.',
            )
          }
        >
          Export CSV
        </button>
      )}
      <DataTable<Row>
        caption="Fuel and expenses"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load expenses.' : null}
        emptyMessage="No expenses."
        columns={[
          { key: 'd', header: 'Date', cell: (r) => r.spentOn },
          { key: 'v', header: 'Vehicle', cell: (r) => name(r.vehicleId) },
          { key: 'c', header: 'Category', cell: (r) => words(r.category) },
          { key: 'a', header: 'Amount', cell: (r) => pounds(r.amountPence) },
          { key: 'dup', header: 'Check', cell: (r) => (r.duplicateOf ? 'Possible duplicate' : '') },
          { key: 's', header: 'Status', cell: (r) => words(r.status) },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              can('fleet.expense.approve') && r.status === 'SUBMITTED' ? (
                <div className="flex gap-2">
                  {(['APPROVED', 'REJECTED'] as const).map((d) => (
                    <button
                      key={d}
                      className={smallButton}
                      onClick={() =>
                        void run(
                          () =>
                            api.send('POST', `/api/v1/fuel-expenses/${r.id}/approve`, orgId, {
                              decision: d,
                            }),
                          `Expense ${d.toLowerCase()}.`,
                        )
                      }
                    >
                      {d === 'APPROVED' ? 'Approve' : 'Reject'}
                    </button>
                  ))}
                </div>
              ) : null,
          },
        ]}
      />
    </>
  );
}
