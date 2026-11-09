import { EQUIPMENT_CATEGORIES as EQUIPMENT_CATEGORY_LIST } from '@hub/contracts';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  Tabs,
  button,
  fmtDate,
  input,
  pounds,
  saveBlob,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';
import { Defects } from './Defects.js';
import {
  AddVehicle,
  EquipmentDetail,
  EquipmentEditDialog,
  ReceiptPicker,
  VdiChecklists,
  VEHICLE_TYPE,
  odometerText,
} from './FleetRegisters.js';

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

const EQUIPMENT_CATEGORIES = [
  ...EQUIPMENT_CATEGORY_LIST.filter((c) => c !== 'OTHER'),
  'WHEELCHAIR',
  'HOIST',
  'OTHER',
];
const REGIMES: Record<string, string> = {
  LOLER_THOROUGH: 'LOLER thorough examination',
  SERVICE: 'Service',
  CALIBRATION: 'Calibration',
  PRE_USE: 'Pre-use check',
  PAT: 'Portable appliance test',
};
const CAPABILITY: Record<string, string> = {
  STRETCHER: 'Stretcher',
  WHEELCHAIR: 'Wheelchair',
  CLINICAL: 'Clinical',
  BARIATRIC: 'Bariatric',
};
const EXPENSE_CATEGORY: Record<string, string> = {
  FUEL: 'Fuel',
  CHARGING: 'Charging',
  PARKING: 'Parking',
  TOLL: 'Toll',
  WASH: 'Vehicle wash',
  OTHER: 'Other',
};
export const EXPENSE_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  SUBMITTED: { kind: 'AMBER', text: 'Awaiting approval' },
  APPROVED: { kind: 'GREEN', text: 'Approved' },
  REJECTED: { kind: 'RED', text: 'Rejected' },
};
const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

export function Fleet() {
  const can = useCan();
  const { orgId } = useApp();
  const [tab, setTab] = useState('vehicles');
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  // Finding 21: the expenses tab (and its fetch) only for people who submit or approve claims.
  const expenses = can('fleet.expense.submit') || can('fleet.expense.approve');
  if (!can('fleet.vehicle.view') && !expenses)
    return (
      <p role="alert" className="rounded-lg border border-hub-line bg-hub-card p-3">
        You do not have access to vehicles and assets.
      </p>
    );
  const current = !can('fleet.vehicle.view')
    ? 'expenses'
    : tab === 'expenses' && !expenses
      ? 'vehicles'
      : tab;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vehicles and assets</h1>
      <Tabs
        label="Fleet sections"
        current={current}
        onChange={setTab}
        tabs={[
          { id: 'vehicles', label: 'Vehicles', show: can('fleet.vehicle.view') },
          { id: 'equipment', label: 'Equipment', show: can('fleet.vehicle.view') },
          { id: 'defects', label: 'Defects', show: can('fleet.vehicle.view') },
          { id: 'checklists', label: 'Inspection checklists', show: can('fleet.vehicle.view') },
          { id: 'expenses', label: 'Fuel and expenses', show: expenses },
        ]}
      >
        {current === 'vehicles' && <Vehicles />}
        {current === 'equipment' && <Equipment />}
        {current === 'defects' && <Defects />}
        {current === 'checklists' && <VdiChecklists />}
        {current === 'expenses' && <Expenses />}
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
          { key: 'type', header: 'Type', cell: (r) => VEHICLE_TYPE[r.type] ?? words(r.type) },
          {
            key: 'cap',
            header: 'Capability',
            cell: (r) =>
              `${r.seats} seats, ${r.wheelchairCapacity} wheelchair, ${r.stretcher ? 'stretcher' : 'no stretcher'}`,
          },
          { key: 'odo', header: 'Latest odometer reading', cell: odometerText },
          { key: 'def', header: 'Open defects', cell: (r) => String(r.openDefects) },
          { key: 'st', header: 'Status', cell: (r) => <VehicleBadge v={r} /> },
        ]}
      />
      {can('fleet.vehicle.manage') && <AddVehicle />}
    </>
  );
}

function Equipment() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [proof, setProof] = useState<File | null>(null);
  const res = useOne<{ data: Row[] }>('/api/v1/equipment');
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles');
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const [acting, setActing] = useState<{ r: Row; kind: 'quarantine' | 'release' } | null>(null);
  const [regimeFor, setRegimeFor] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const vehicleName = new Map((vehicles.data?.data ?? []).map((v) => [v.id, v.callsign]));
  const locationName = new Map((locations.data?.data ?? []).map((l) => [l.id, l.name]));
  const where = (r: Row) =>
    r.vehicleId
      ? `On ${vehicleName.get(r.vehicleId) ?? 'a vehicle'}`
      : r.locationId
        ? `At ${locationName.get(r.locationId) ?? 'a base'}`
        : 'Not assigned';
  return (
    <>
      <DataTable<Row>
        caption="Equipment"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load equipment.' : null}
        emptyMessage="No equipment."
        columns={[
          {
            key: 'tag',
            header: 'Asset',
            cell: (r) => (
              <>
                <span className="font-medium">{r.assetTag}</span>
                {(r.manufacturer || r.model) && (
                  <span className="block text-xs">
                    {[r.manufacturer, r.model].filter(Boolean).join(' ')}
                    {r.serial ? ` · serial ${r.serial}` : ''}
                  </span>
                )}
              </>
            ),
          },
          { key: 'cat', header: 'Category', cell: (r) => words(r.category) },
          { key: 'where', header: 'Where', cell: where },
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
                <StatusBadge status="GREY" reason="No inspection regime set up" />
              ) : (
                <ul className="space-y-1">
                  {r.regimes.map((g: Row) => (
                    <li key={g.regime}>
                      {REGIMES[g.regime] ?? words(g.regime)}:{' '}
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
                status={
                  r.status === 'AVAILABLE' ? 'GREEN' : r.status === 'RETIRED' ? 'GREY' : 'RED'
                }
                reason={
                  r.status === 'AVAILABLE'
                    ? 'In service'
                    : r.status === 'RETIRED'
                      ? 'Retired'
                      : `Quarantined – ${r.quarantineReason ?? ''}`
                }
              />
            ),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                <button
                  className={smallButton}
                  aria-label={`${viewing === r.id ? 'Hide' : 'Show'} details of ${r.assetTag}`}
                  aria-expanded={viewing === r.id}
                  onClick={() => setViewing(viewing === r.id ? null : r.id)}
                >
                  {viewing === r.id ? 'Hide details' : 'Details'}
                </button>
                {r.status !== 'RETIRED' && can('fleet.vehicle.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`Edit ${r.assetTag}`}
                    onClick={() => setEditing(r)}
                  >
                    Edit
                  </button>
                )}
                {r.status !== 'RETIRED' && can('fleet.vehicle.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`Add inspection regime to ${r.assetTag}`}
                    onClick={() => setRegimeFor(r)}
                  >
                    Add inspection regime
                  </button>
                )}
                {r.status === 'AVAILABLE' && can('fleet.vehicle.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`Quarantine ${r.assetTag}`}
                    onClick={() => setActing({ r, kind: 'quarantine' })}
                  >
                    Quarantine
                  </button>
                )}
                {r.status === 'QUARANTINED' &&
                  can('fleet.return_to_service') &&
                  (r.quarantinedBy === me.user.id ? (
                    <span className="text-xs">
                      You quarantined {r.assetTag}: someone else must release it.
                    </span>
                  ) : (
                    <button
                      className={smallButton}
                      aria-label={`Release ${r.assetTag}`}
                      onClick={() => setActing({ r, kind: 'release' })}
                    >
                      Release
                    </button>
                  ))}
              </div>
            ),
          },
        ]}
      />
      {(res.data?.data ?? [])
        .filter((r) => r.id === viewing)
        .map((r) => (
          <EquipmentDetail key={r.id} asset={r} where={where(r)} />
        ))}
      {can('fleet.vehicle.manage') && (
        <AddEquipment vehicles={vehicles.data?.data ?? []} locations={locations.data?.data ?? []} />
      )}
      <EquipmentEditDialog
        asset={editing}
        vehicles={vehicles.data?.data ?? []}
        locations={locations.data?.data ?? []}
        onClose={() => setEditing(null)}
      />
      <ActionDialog
        open={acting !== null}
        title={
          acting?.kind === 'quarantine'
            ? `Quarantine ${acting.r.assetTag}`
            : `Release ${acting?.r.assetTag ?? ''} to service`
        }
        confirmLabel={acting?.kind === 'quarantine' ? 'Quarantine' : 'Release to service'}
        danger={acting?.kind === 'quarantine'}
        reasonLabel={
          acting?.kind === 'quarantine'
            ? 'Why is this asset being quarantined?'
            : 'Why is it safe to release? (what was checked)'
        }
        confirmDisabled={acting?.kind === 'release' && !proof}
        onCancel={() => {
          setActing(null);
          setProof(null);
        }}
        onConfirm={async (reason) => {
          const a = acting!;
          if (a.kind === 'quarantine')
            return api.send('POST', `/api/v1/equipment/${a.r.id}/quarantine`, orgId, { reason });
          // D3: release needs evidence (repair or inspection record), uploaded first.
          const up = await uploadFile(api, orgId, proof!, {
            title: `Release evidence ${a.r.assetTag}`,
          });
          const out = await api.send('POST', `/api/v1/equipment/${a.r.id}/release`, orgId, {
            reason,
            evidenceItemId: up.itemId,
          });
          setProof(null);
          return out;
        }}
        fields={
          acting?.kind === 'release' ? (
            <Field label="Repair or inspection evidence">
              <input
                type="file"
                className={input}
                onChange={(e) => setProof(e.target.files?.[0] ?? null)}
              />
            </Field>
          ) : undefined
        }
      >
        <p>
          {acting?.kind === 'quarantine'
            ? 'The asset cannot be used, and any vehicle it is fitted to is re-checked for what it can still do.'
            : 'The asset goes back into service. Someone other than the person who quarantined it releases it, with evidence. Your name, reason and evidence are recorded.'}
        </p>
      </ActionDialog>
      <RegimeDialog asset={regimeFor} onClose={() => setRegimeFor(null)} />
    </>
  );
}

function AddEquipment({ vehicles, locations }: { vehicles: Row[]; locations: Row[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [place, setPlace] = useState<'vehicle' | 'location' | 'none'>('vehicle');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const swl = text('swlKg');
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/equipment', orgId, {
          assetTag: text('assetTag'),
          category: text('category'),
          ...(text('manufacturer') ? { manufacturer: text('manufacturer') } : {}),
          ...(text('model') ? { model: text('model') } : {}),
          ...(text('serial') ? { serial: text('serial') } : {}),
          ...(swl ? { swlKg: Number(swl) } : {}),
          ...(text('capability') ? { capability: text('capability') } : {}),
          ...(text('instructions') ? { instructions: text('instructions') } : {}),
          ...(place === 'vehicle' && text('vehicleId') ? { vehicleId: text('vehicleId') } : {}),
          ...(place === 'location' && text('locationId') ? { locationId: text('locationId') } : {}),
        }),
      'Equipment added. Add its inspection regimes so it is checked on time; until then it shows as not set up.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="Add equipment">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-3" aria-label="Add equipment">
        <Field label="Asset tag">
          <input
            name="assetTag"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,23}"
            placeholder="STR-04"
            className={input}
          />
        </Field>
        <Field label="Category">
          <select name="category" className={input}>
            {EQUIPMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {words(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manufacturer (optional)">
          <input name="manufacturer" maxLength={120} className={input} />
        </Field>
        <Field label="Model (optional)">
          <input name="model" maxLength={120} className={input} />
        </Field>
        <Field label="Serial number (optional)">
          <input name="serial" maxLength={60} className={input} />
        </Field>
        <Field label="Safe working load in kg (optional)">
          <input name="swlKg" type="number" min={1} max={100000} className={input} />
        </Field>
        <Field label="Gives the vehicle (optional)">
          <select name="capability" className={input} defaultValue="">
            <option value="">Nothing extra</option>
            {Object.entries(CAPABILITY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kept">
          <select
            className={input}
            value={place}
            onChange={(e) => setPlace(e.target.value as typeof place)}
          >
            <option value="vehicle">On a vehicle</option>
            <option value="location">At a base</option>
            <option value="none">Not assigned yet</option>
          </select>
        </Field>
        {place === 'vehicle' && (
          <Field label="Vehicle">
            <select name="vehicleId" required className={input}>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.callsign} ({v.registration})
                </option>
              ))}
            </select>
          </Field>
        )}
        {place === 'location' && (
          <Field label="Base">
            <select name="locationId" required className={input}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="md:col-span-3">
          <Field label="Instructions for use (optional)">
            <textarea name="instructions" maxLength={2000} rows={2} className={input} />
          </Field>
        </div>
        <div className="md:col-span-3">
          <button className={button}>Add equipment</button>
        </div>
      </form>
      {msg}
    </Section>
  );
}

function RegimeDialog({ asset, onClose }: { asset: Row | null; onClose: () => void }) {
  const { api, orgId } = useApp();
  const templates = useOne<{ data: Row[] }>('/api/v1/requirements/templates', asset !== null);
  const [regime, setRegime] = useState('SERVICE');
  const [templateId, setTemplateId] = useState('');
  const [source, setSource] = useState('');
  const usable = (templates.data?.data ?? []).filter(
    (t) =>
      !t.isLibrary &&
      (t.versions as Row[]).some((v) => v.status === 'EFFECTIVE' && v.subjectType === 'EQUIPMENT'),
  );
  const taken = new Set(((asset?.regimes ?? []) as Row[]).map((g) => g.regime));
  return (
    <ActionDialog
      open={asset !== null}
      title={`Add inspection regime to ${asset?.assetTag ?? ''}`}
      confirmLabel="Add regime"
      confirmDisabled={!templateId || taken.has(regime)}
      onCancel={() => {
        setTemplateId('');
        setSource('');
        onClose();
      }}
      onConfirm={() =>
        api.send('POST', `/api/v1/equipment/${asset!.id}/regimes`, orgId, {
          regime,
          templateId,
          ...(source.trim() ? { source: source.trim() } : {}),
        })
      }
      fields={
        <div className="grid gap-3">
          <Field label="Regime">
            <select className={input} value={regime} onChange={(e) => setRegime(e.target.value)}>
              {Object.entries(REGIMES).map(([k, v]) => (
                <option key={k} value={k} disabled={taken.has(k)}>
                  {v}
                  {taken.has(k) ? ' (already set up)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Requirement it follows">
            <select
              className={input}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Choose a published equipment requirement</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Where the schedule comes from (optional)">
            <input
              className={input}
              maxLength={300}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
        </div>
      }
    >
      <p>
        Each regime has its own requirement and deadline. It starts as awaiting evidence: it only
        turns green once a certificate is uploaded and verified by someone else.
      </p>
      {templates.data && usable.length === 0 && (
        <p role="status">
          No equipment requirement is published yet. Publish one in Settings, Requirement library.
        </p>
      )}
    </ActionDialog>
  );
}

function Expenses() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const res = useOne<{ data: Row[] }>(`/api/v1/fuel-expenses${status ? `?status=${status}` : ''}`);
  const [deciding, setDeciding] = useState<{ r: Row; d: 'APPROVED' | 'REJECTED' } | null>(null);
  const name = (r: Row) =>
    `${EXPENSE_CATEGORY[r.category] ?? words(r.category)} ${pounds(r.amountPence)} on ${fmtDate(r.spentOn)}`;
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show">
          <select
            className={`${input} w-56`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All claims</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.text}
              </option>
            ))}
          </select>
        </Field>
        {can('fleet.expense.approve') && (
          <>
            <Field label="Approved from">
              <input
                type="date"
                className={input}
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Approved to">
              <input
                type="date"
                className={input}
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <button
              className={smallButton}
              onClick={() =>
                void run(async () => {
                  // D7: the export is approved claims for the chosen period.
                  const q = new URLSearchParams({ status: 'APPROVED' });
                  if (from) q.set('from', from);
                  if (to) q.set('to', to);
                  saveBlob(
                    await api.download!(`/api/v1/fuel-expenses/export?${q.toString()}`, orgId),
                    `approved-expenses${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.csv`,
                  );
                }, 'Export of approved claims downloaded.')
              }
            >
              Export approved claims (CSV)
            </button>
          </>
        )}
      </div>
      {msg}
      <DataTable<Row>
        caption="Fuel and expenses"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load expenses.' : null}
        emptyMessage="No expenses."
        columns={[
          { key: 'd', header: 'Date', cell: (r) => fmtDate(r.spentOn) },
          { key: 'v', header: 'Vehicle', cell: (r) => r.vehicleLabel ?? 'Vehicle' },
          {
            key: 'c',
            header: 'Claim',
            cell: (r) => (
              <>
                {EXPENSE_CATEGORY[r.category] ?? words(r.category)}
                {r.quantity !== null && (
                  <span className="block text-xs">
                    {r.quantity} {r.unit === 'KWH' ? 'kWh' : 'litres'}
                  </span>
                )}
                {r.supplier && <span className="block text-xs">{r.supplier}</span>}
              </>
            ),
          },
          { key: 'a', header: 'Amount', cell: (r) => pounds(r.amountPence) },
          {
            key: 'rc',
            header: 'Receipt',
            cell: (r) => (r.receiptEvidenceItemId ? 'Receipt attached' : 'No receipt'),
          },
          {
            key: 'by',
            header: 'Submitted by',
            cell: (r) =>
              r.submittedBy === me.user.id
                ? `${r.submittedByName ?? 'You'} (you)`
                : (r.submittedByName ?? 'Unknown'),
          },
          {
            key: 'dup',
            header: 'Check',
            cell: (r) =>
              r.duplicateOf ? (
                <StatusBadge status="AMBER" reason="Possible duplicate of another claim" />
              ) : (
                ''
              ),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <>
                <StatusBadge
                  status={EXPENSE_STATUS[r.status]?.kind ?? 'GREY'}
                  reason={EXPENSE_STATUS[r.status]?.text ?? words(r.status)}
                />
                {r.status !== 'SUBMITTED' && (
                  <span className="block text-xs">
                    By {r.decidedByName ?? 'unknown'}
                    {r.decisionNote ? ` – ${r.decisionNote}` : ''}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              can('fleet.expense.approve') && r.status === 'SUBMITTED' ? (
                r.submittedBy === me.user.id ? (
                  <span className="text-xs">Someone else must approve your claim.</span>
                ) : (
                  <div className="flex gap-2">
                    <button
                      className={smallButton}
                      aria-label={`Approve: ${name(r)}`}
                      onClick={() => setDeciding({ r, d: 'APPROVED' })}
                    >
                      Approve
                    </button>
                    <button
                      className={smallButton}
                      aria-label={`Reject: ${name(r)}`}
                      onClick={() => setDeciding({ r, d: 'REJECTED' })}
                    >
                      Reject
                    </button>
                  </div>
                )
              ) : null,
          },
        ]}
      />
      {can('fleet.expense.submit') && <SubmitExpense />}
      <ActionDialog
        open={deciding !== null}
        title={`${deciding?.d === 'APPROVED' ? 'Approve' : 'Reject'}: ${deciding ? name(deciding.r) : ''}`}
        confirmLabel={deciding?.d === 'APPROVED' ? 'Approve claim' : 'Reject claim'}
        danger={deciding?.d === 'REJECTED'}
        reasonLabel={
          deciding?.d === 'APPROVED'
            ? 'Note (optional)'
            : 'Why is it rejected? The claimant sees this'
        }
        reasonRequired={deciding?.d === 'REJECTED'}
        onCancel={() => setDeciding(null)}
        onConfirm={(note) =>
          api.send('POST', `/api/v1/fuel-expenses/${deciding!.r.id}/approve`, orgId, {
            decision: deciding!.d,
            ...(note ? { note } : {}),
          })
        }
      >
        <p>
          {deciding?.r.duplicateOf
            ? 'This claim looks like a duplicate of another one: check before deciding. '
            : ''}
          Your name is recorded with the decision.
        </p>
      </ActionDialog>
    </>
  );
}

function SubmitExpense() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const [category, setCategory] = useState('FUEL');
  const [receipt, setReceipt] = useState<File | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const pence = Math.round(Number(text('amount')) * 100);
    const qty = text('quantity');
    const odo = text('odometer');
    const ok = await run(async () => {
      // The receipt is uploaded first as the claimant's own evidence, then linked to the claim.
      const up = receipt
        ? await uploadFile(api, orgId, receipt, { title: `Receipt ${text('spentOn')}` })
        : null;
      return api.send('POST', '/api/v1/fuel-expenses', orgId, {
        vehicleId: text('vehicleId'),
        spentOn: text('spentOn'),
        category,
        amountPence: pence,
        ...(qty ? { quantity: Number(qty), unit: category === 'CHARGING' ? 'KWH' : 'LITRES' } : {}),
        ...(odo ? { odometer: Number(odo) } : {}),
        ...(text('supplier') ? { supplier: text('supplier') } : {}),
        ...(up ? { receiptEvidenceItemId: up.itemId } : {}),
      });
    }, 'Claim submitted. Someone else approves it.');
    if (ok) {
      form.reset();
      setReceipt(null);
    }
  }
  if (!can('fleet.vehicle.view'))
    return <p className="text-sm">Submit fuel and expenses from the crew app during your shift.</p>;
  return (
    <Section title="Submit a claim">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-3" aria-label="Submit a claim">
        <Field label="Vehicle">
          <select name="vehicleId" required className={input}>
            {(vehicles.data?.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.callsign} ({v.registration})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            name="spentOn"
            required
            max={londonToday()}
            defaultValue={londonToday()}
            className={input}
          />
        </Field>
        <Field label="Category">
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(EXPENSE_CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount in pounds">
          <input
            name="amount"
            type="number"
            step="0.01"
            min={0.01}
            max={100000}
            required
            className={input}
          />
        </Field>
        {(category === 'FUEL' || category === 'CHARGING') && (
          <Field label={category === 'FUEL' ? 'Litres' : 'kWh (optional)'}>
            <input
              name="quantity"
              type="number"
              step="0.01"
              min={0.01}
              required={category === 'FUEL'}
              className={input}
            />
          </Field>
        )}
        <Field label={category === 'FUEL' ? 'Odometer in miles' : 'Odometer in miles (optional)'}>
          <input
            name="odometer"
            type="number"
            min={0}
            required={category === 'FUEL'}
            className={input}
          />
        </Field>
        <Field label="Supplier (optional)">
          <input name="supplier" maxLength={120} className={input} />
        </Field>
        <ReceiptPicker file={receipt} onChange={setReceipt} />
        <div className="md:col-span-3">
          <button className={button}>Submit claim</button>
        </div>
      </form>
      {msg}
    </Section>
  );
}
