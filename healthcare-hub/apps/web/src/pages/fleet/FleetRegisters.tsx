import { UK_REGISTRATION, UK_REGISTRATION_MESSAGE } from '@hub/contracts';
import { licenceNeededText } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Button, Checkbox, Input, Modal, Select } from 'antd';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { ActionDialog, Field, Section, errText, fmtDate, input, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne } from '../settings/hooks.js';
import { Ms, RowActions, WfCard, WfTag } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const VEHICLE_TYPE: Record<string, string> = {
  AMBULANCE: 'Ambulance',
  HIGH_DEPENDENCY: 'High dependency unit',
  PTS_VEHICLE: 'Patient transport vehicle',
  WAV: 'Wheelchair accessible vehicle',
  CAR: 'Car',
  MINIBUS: 'Minibus',
  OTHER: 'Other',
};
export const OWNERSHIP: Record<string, string> = {
  OWNED: 'Owned',
  LEASED: 'Leased',
  HIRED: 'Hired',
};
export const LICENCE_CATEGORIES = ['B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE'];
const LICENCE_HINT: Record<string, string> = {
  B: 'B – car, up to 3,500 kg',
  C1: 'C1 – medium vehicle, 3,500 to 7,500 kg',
  D1: 'D1 – minibus, up to 16 passengers',
};
export const licenceText = (c: string) => LICENCE_HINT[c] ?? c;
export const EN1789: Record<string, string> = {
  A1: 'Type A1 – patient transport, one patient',
  A2: 'Type A2 – patient transport, one or more patients',
  B: 'Type B – emergency ambulance',
  C: 'Type C – mobile intensive care unit',
};

/** The odometer is only shown with the reading behind it (finding 41). */
export const odometerText = (v: Row) => {
  const r = v.latestReading;
  return r
    ? `${Number(r.reading).toLocaleString('en-GB')} mi (${fmtDate(r.readOn)})`
    : 'No readings';
};

interface Problem {
  field: string;
  label: string;
  message: string;
}
const CALLSIGN = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Checks run in the browser first so each problem names its field (findings 42, 43). */
export function vehicleProblems(v: {
  registration?: string;
  callsign?: string;
  vin?: string;
  baseLocationId?: string;
  seats?: string;
  wheelchairs?: string;
  grossWeightKg?: string;
  ownership?: string;
  ownershipEndsOn?: string;
  year?: string;
}): Problem[] {
  const out: Problem[] = [];
  const reg = (v.registration ?? '').replace(/\s+/g, '').toUpperCase();
  if (v.registration !== undefined && !UK_REGISTRATION.test(reg))
    out.push({ field: 'registration', label: 'Registration', message: UK_REGISTRATION_MESSAGE });
  if (v.ownership && v.ownership !== 'OWNED' && !v.ownershipEndsOn)
    out.push({
      field: 'ownershipEndsOn',
      label: 'Lease or hire end date',
      message: 'Give the lease or hire end date',
    });
  if (v.year && !(Number.isInteger(+v.year) && +v.year >= 1980 && +v.year <= 2100))
    out.push({ field: 'year', label: 'Year', message: 'Enter the model year, for example 2021' });
  if (v.callsign !== undefined && !CALLSIGN.test((v.callsign ?? '').trim().toUpperCase()))
    out.push({
      field: 'callsign',
      label: 'Callsign',
      message: 'Use 2 to 16 letters, numbers or hyphens, for example AMB-03',
    });
  if (v.vin && !VIN.test(v.vin.trim().toUpperCase()))
    out.push({
      field: 'vin',
      label: 'VIN',
      message: 'A VIN has 17 letters and numbers (no I, O or Q)',
    });
  if (v.baseLocationId !== undefined && !v.baseLocationId)
    out.push({ field: 'location', label: 'Base', message: 'Choose the base it works from' });
  const num = (s: string | undefined, max: number) =>
    s === undefined || s === '' || (Number.isInteger(Number(s)) && +s >= 0 && +s <= max);
  if (!num(v.seats, 60))
    out.push({ field: 'seats', label: 'Seats', message: 'Enter a whole number from 0 to 60' });
  if (!num(v.wheelchairs, 10))
    out.push({
      field: 'wheelchairs',
      label: 'Wheelchair spaces',
      message: 'Enter a whole number from 0 to 10',
    });
  if (
    v.grossWeightKg &&
    !(Number.isInteger(+v.grossWeightKg) && +v.grossWeightKg >= 500 && +v.grossWeightKg <= 44000)
  )
    out.push({
      field: 'grossWeightKg',
      label: 'Gross vehicle weight',
      message: 'Enter the plated weight in kg, from 500 to 44,000',
    });
  return out;
}

/** Server field errors in the same shape, so one summary lists everything to fix. */
function serverProblems(e: unknown): Problem[] {
  if (!(e instanceof ApiError) || e.errors.length === 0) return [];
  const names: Record<string, string> = {
    registration: 'Registration',
    callsign: 'Callsign',
    vin: 'VIN',
    baseLocationId: 'Base',
    seats: 'Seats',
    wheelchairCapacity: 'Wheelchair spaces',
    grossWeightKg: 'Gross vehicle weight',
    licenceCategory: 'Licence category',
    permittedLoads: 'Permitted loads',
    ownershipEndsOn: 'Lease or hire end date',
    year: 'Year',
    bariatricLimitKg: 'Bariatric limit',
  };
  return e.errors.map((x) => ({
    field: x.path,
    label: names[x.path] ?? 'A field',
    message: x.message,
  }));
}

function ProblemSummary({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <div role="alert" className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-900">
      <p className="font-semibold">Fix these before saving:</p>
      <ul className="list-disc pl-5">
        {problems.map((p) => (
          <li key={p.field}>
            {p.label}: {p.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

const loadsOf = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function AddVehicle() {
  const { api, orgId } = useApp();
  const invalidate = useInvalidate();
  const [problems, setProblems] = useState<Problem[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const services = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/services` : null,
  );
  const [ownership, setOwnership] = useState('OWNED');
  const [licence, setLicence] = useState('B');
  const [gvw, setGvw] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const opt = (k: string) => (text(k) ? { [k]: text(k) } : {});
    const num = (k: string) => (text(k) ? { [k]: Number(text(k)) } : {});
    setDone(null);
    setFailed(null);
    const found = vehicleProblems({
      registration: text('registration'),
      callsign: text('callsign'),
      vin: text('vin'),
      baseLocationId: text('location'),
      seats: text('seats'),
      wheelchairs: text('wheelchairs'),
      grossWeightKg: text('grossWeightKg'),
      ownership,
      ownershipEndsOn: text('ownershipEndsOn'),
      year: text('year'),
    });
    setProblems(found);
    if (found.length) return;
    try {
      await api.send('POST', '/api/v1/vehicles', orgId, {
        registration: text('registration'),
        callsign: text('callsign'),
        type: text('type'),
        ownership,
        baseLocationId: text('location'),
        seats: Number(text('seats') || 0),
        wheelchairCapacity: Number(text('wheelchairs') || 0),
        stretcher: f.get('stretcher') === 'on',
        licenceCategory: licence,
        permittedLoads: loadsOf(text('permittedLoads')),
        ...(text('vin') ? { vin: text('vin') } : {}),
        ...(text('grossWeightKg') ? { grossWeightKg: Number(text('grossWeightKg')) } : {}),
        ...opt('make'),
        ...opt('model'),
        ...num('year'),
        ...opt('firstRegisteredOn'),
        ...opt('en1789Type'),
        ...opt('conversionCompany'),
        ...opt('conversionCertificateRef'),
        ...(ownership !== 'OWNED' ? opt('ownershipEndsOn') : {}),
        ...num('bariatricLimitKg'),
        serviceIds: f.getAll('serviceIds').map(String),
        blueLightAuthorised: f.get('blueLightAuthorised') === 'on',
      });
      form.reset();
      setOwnership('OWNED');
      setLicence('B');
      setGvw('');
      setDone(
        'Vehicle added. Its insurance, tax, conversion and service requirements (and MOT once ' +
          'it is three years old) start as awaiting evidence: add the documents on the vehicle ' +
          'page, Documents tab. Someone else verifies each upload.',
      );
      await invalidate();
    } catch (err) {
      const fields = serverProblems(err);
      setProblems(fields);
      if (!fields.length) setFailed(errText(err));
    }
  }
  return (
    <Section title="Add a vehicle">
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 md:grid-cols-3"
        aria-label="Add a vehicle"
      >
        <Field label="Registration (required)">
          <input name="registration" placeholder="SY21 ABC" className={input} />
        </Field>
        <Field label="Callsign (required)">
          <input name="callsign" placeholder="AMB-03" className={input} />
        </Field>
        <Field label="VIN (optional)">
          <input name="vin" maxLength={17} className={input} />
        </Field>
        <Field label="Type">
          <select name="type" className={input}>
            {Object.entries(VEHICLE_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ownership">
          <select
            name="ownership"
            className={input}
            value={ownership}
            onChange={(e) => setOwnership(e.target.value)}
          >
            {Object.entries(OWNERSHIP).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {ownership !== 'OWNED' && (
          <Field label="Lease or hire end date (required)">
            <input type="date" name="ownershipEndsOn" className={input} />
          </Field>
        )}
        <Field label="Make (optional)">
          <input name="make" maxLength={60} placeholder="Mercedes-Benz" className={input} />
        </Field>
        <Field label="Model (optional)">
          <input name="model" maxLength={60} placeholder="Sprinter 519" className={input} />
        </Field>
        <Field label="Model year (optional)">
          <input name="year" inputMode="numeric" className={`${input} w-24`} />
        </Field>
        <Field label="First registered (optional, decides when an MOT is due)">
          <input type="date" name="firstRegisteredOn" className={input} />
        </Field>
        <Field label="BS EN 1789 type (optional)">
          <select name="en1789Type" className={input} defaultValue="">
            <option value="">Not an EN 1789 ambulance</option>
            {Object.entries(EN1789).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conversion company (optional)">
          <input name="conversionCompany" maxLength={120} className={input} />
        </Field>
        <Field label="Conversion certificate reference (optional)">
          <input name="conversionCertificateRef" maxLength={120} className={input} />
        </Field>
        <Field label="Bariatric limit in kg (optional)">
          <input name="bariatricLimitKg" inputMode="numeric" className={`${input} w-28`} />
        </Field>
        <Field label="Services it can run (optional)">
          <select name="serviceIds" multiple className={input}>
            {(services.data?.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="blueLightAuthorised" /> Authorised for blue-light driving
        </label>
        <Field label="Base (required)">
          <select name="location" className={input}>
            {(locations.data?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Licence category needed to drive it">
          <select
            name="licenceCategory"
            className={input}
            value={licence}
            onChange={(e) => setLicence(e.target.value)}
          >
            {LICENCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {licenceText(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Gross vehicle weight in kg (optional)">
          <input
            name="grossWeightKg"
            inputMode="numeric"
            className={input}
            value={gvw}
            onChange={(e) => setGvw(e.target.value)}
          />
          {/* D1: the licence needed follows the plated weight (over 3,500 kg needs C1). */}
          <span role="status" className="text-xs">
            {licenceNeededText(licence, Number.isFinite(+gvw) && gvw ? +gvw : null)}
          </span>
        </Field>
        <Field label="Permitted loads (optional, comma separated)">
          <input name="permittedLoads" placeholder="Bariatric, Oxygen" className={input} />
        </Field>
        <Field label="Seats">
          <input name="seats" inputMode="numeric" className={`${input} w-20`} />
        </Field>
        <Field label="Wheelchair spaces">
          <input name="wheelchairs" inputMode="numeric" className={`${input} w-20`} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="stretcher" /> Stretcher fitted
        </label>
        <div className="md:col-span-3">
          <Button htmlType="submit" type="primary">
            Add vehicle
          </Button>
        </div>
      </form>
      <ProblemSummary problems={problems} />
      {failed && (
        <p
          role="alert"
          className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-900"
        >
          {failed}
        </p>
      )}
      {done && (
        <p role="status" className="rounded border border-green-700 bg-green-50 p-2 text-sm">
          {done}
        </p>
      )}
    </Section>
  );
}

/** Edits the register details behind a vehicle (finding 39). Uses the version as If-Match. */
export function VehicleEditDialog({ v, onClose }: { v: Row | null; onClose: () => void }) {
  const { api, orgId } = useApp();
  const [vin, setVin] = useState('');
  const [ownership, setOwnership] = useState('');
  const [licence, setLicence] = useState('');
  const [gvw, setGvw] = useState('');
  const [loads, setLoads] = useState('');
  const [seats, setSeats] = useState('');
  const [wheelchairs, setWheelchairs] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (v && loadedFor !== `${v.id}:${v.version}`) {
    setLoadedFor(`${v.id}:${v.version}`);
    setVin(v.vin ?? '');
    setOwnership(v.ownership ?? 'OWNED');
    setLicence(v.licenceCategory ?? 'B');
    setGvw(v.grossWeightKg ? String(v.grossWeightKg) : '');
    setLoads(((v.permittedLoads ?? []) as string[]).join(', '));
    setSeats(String(v.seats ?? 0));
    setWheelchairs(String(v.wheelchairCapacity ?? 0));
  }
  const problems = vehicleProblems({ vin, seats, wheelchairs, grossWeightKg: gvw });
  return (
    <ActionDialog
      open={v !== null}
      title={`Edit register details for ${v?.callsign ?? ''}`}
      confirmLabel="Save details"
      confirmDisabled={problems.length > 0}
      onCancel={() => {
        setLoadedFor(null);
        onClose();
      }}
      onConfirm={() =>
        api.send(
          'PATCH',
          `/api/v1/vehicles/${v!.id}`,
          orgId,
          {
            vin: vin.trim() ? vin.trim() : null,
            ownership,
            licenceCategory: licence,
            grossWeightKg: gvw ? Number(gvw) : null,
            permittedLoads: loadsOf(loads),
            seats: Number(seats || 0),
            wheelchairCapacity: Number(wheelchairs || 0),
          },
          v!.version,
        )
      }
      fields={
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="VIN (optional)">
            <Input value={vin} onChange={(e) => setVin(e.target.value)} />
          </Field>
          <Field label="Ownership">
            <Select
              value={ownership}
              onChange={setOwnership}
              style={{ width: '100%' }}
              options={Object.entries(OWNERSHIP).map(([k, t]) => ({ value: k, label: t }))}
            />
          </Field>
          <Field label="Licence category needed to drive it">
            <Select
              value={licence}
              onChange={setLicence}
              style={{ width: '100%' }}
              options={LICENCE_CATEGORIES.map((c) => ({ value: c, label: licenceText(c) }))}
            />
          </Field>
          <Field label="Gross vehicle weight in kg (optional)">
            <Input value={gvw} onChange={(e) => setGvw(e.target.value)} />
          </Field>
          <Field label="Permitted loads (optional, comma separated)">
            <Input value={loads} onChange={(e) => setLoads(e.target.value)} />
          </Field>
          <Field label="Seats">
            <Input value={seats} onChange={(e) => setSeats(e.target.value)} />
          </Field>
          <Field label="Wheelchair spaces">
            <Input value={wheelchairs} onChange={(e) => setWheelchairs(e.target.value)} />
          </Field>
        </div>
      }
    >
      <ProblemSummary problems={problems} />
      <p>Registration and callsign cannot be changed here. Your name is recorded with the edit.</p>
    </ActionDialog>
  );
}

/** Inspection checklist templates (finding 7): publish a new version or retire one. */
export function VdiChecklists() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('fleet.vehicle.manage');
  const res = useOne<{ data: Row[] }>(`/api/v1/vdi-templates${manage ? '?all=true' : ''}`);
  const [retiring, setRetiring] = useState<Row | null>(null);
  const [publishing, setPublishing] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [viewing, setViewing] = useState<Row | null>(null);
  return (
    <>
      <WfCard
        title="Check list versions"
        table
        extra={
          manage && (
            <Button type="primary" icon={<Ms i="note_add" />} onClick={() => setEditing('new')}>
              Draft a new version
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Check list versions"
          rows={(res.data?.data ?? []).filter((r) => r.status !== 'RETIRED')}
          rowKey={(r) => r.id}
          loading={res.isLoading}
          error={res.isError ? 'Could not load checklists.' : null}
          emptyMessage="No active checklists. Publish one so crews can check vehicles."
          rowTone={(r) => (r.status === 'DRAFT' ? 'amber' : null)}
          columns={[
            {
              key: 'n',
              header: 'Version',
              cell: (r) => {
                const critical = (r.items as Row[]).filter((i) => i.critical).length;
                return (
                  <>
                    <b>
                      {r.name} v{r.version}
                    </b>
                    <span className="sub">
                      {r.items.length} items, {critical} critical
                      {r.vehicleType ? ` · ${VEHICLE_TYPE[r.vehicleType]}` : ''}
                    </span>
                  </>
                );
              },
            },
            {
              key: 'd',
              header: 'Drafted by',
              cell: (r) => (
                <>
                  {r.createdByName ?? 'Unknown'}
                  {r.createdAt && <span className="sub">{fmtDate(r.createdAt)}</span>}
                </>
              ),
            },
            { key: 'p', header: 'Published by', cell: (r) => r.publishedByName ?? '—' },
            {
              key: 's',
              header: 'Status',
              cell: (r) =>
                r.status === 'DRAFT' ? (
                  <WfTag tone="amber" icon="schedule">
                    Draft – awaiting a second person to publish
                  </WfTag>
                ) : (
                  <WfTag tone="green" icon="check_circle">
                    Published – crews use this
                  </WfTag>
                ),
            },
            {
              key: 'a',
              header: '',
              cell: (r) => {
                const view = { label: 'View items', icon: 'list', onClick: () => setViewing(r) };
                const more = manage
                  ? [
                      { label: 'New version', icon: 'note_add', onClick: () => setEditing(r) },
                      { label: 'Retire', icon: 'block', onClick: () => setRetiring(r) },
                    ]
                  : [];
                if (manage && r.status === 'DRAFT' && r.createdBy !== me.user.id)
                  return (
                    <RowActions
                      name={`${r.name} v${r.version}`}
                      primary={{
                        label: 'Publish',
                        icon: 'publish',
                        onClick: () => setPublishing(r),
                      }}
                      more={[view, ...more]}
                    />
                  );
                return (
                  <RowActions name={`${r.name} v${r.version}`} ghost primary={view} more={more} />
                );
              },
            },
          ]}
        />
      </WfCard>
      <Modal
        open={viewing !== null}
        title={viewing ? `${viewing.name as string} v${viewing.version as number}` : ''}
        footer={null}
        onCancel={() => setViewing(null)}
      >
        <ol>
          {((viewing?.items as Row[]) ?? []).map((i) => (
            <li key={i.code}>
              {i.label}
              {i.critical ? ' – critical (a fail stops the vehicle)' : ''}
            </li>
          ))}
        </ol>
      </Modal>
      <ActionDialog
        open={publishing !== null}
        title={`Publish ${publishing?.name ?? ''} version ${publishing?.version ?? ''}`}
        confirmLabel="Publish checklist"
        onCancel={() => setPublishing(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/vdi-templates/${publishing!.id}/publish`, orgId, {})
        }
      >
        <p>
          Crews get this version from their next check. The version it replaces for the same vehicle
          type is retired; inspections already done keep the list they used.
        </p>
      </ActionDialog>
      <ChecklistDialog
        from={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
      />
      <ActionDialog
        open={retiring !== null}
        title={`Retire ${retiring?.name ?? ''}`}
        confirmLabel="Retire checklist"
        danger
        onCancel={() => setRetiring(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/vdi-templates/${retiring!.id}/retire`, orgId, {})
        }
      >
        <p>
          Crews can no longer start this checklist. Inspections already done keep the version they
          used.
        </p>
      </ActionDialog>
    </>
  );
}

interface Item {
  label: string;
  critical: boolean;
}
const codeOf = (label: string, i: number) =>
  (label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34) || 'ITEM') + `_${i + 1}`;

function ChecklistDialog({
  from,
  open,
  onClose,
}: {
  from: Row | null;
  open: boolean;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = open ? (from?.id ?? 'new') : null;
  if (key !== loadedFor) {
    setLoadedFor(key);
    setName(from?.name ?? '');
    setType(from?.vehicleType ?? '');
    setItems(
      from
        ? (from.items as Row[]).map((i) => ({ label: i.label, critical: !!i.critical }))
        : [{ label: '', critical: true }],
    );
  }
  const clean = items.filter((i) => i.label.trim().length >= 2);
  const set = (n: number, p: Partial<Item>) =>
    setItems(items.map((it, i) => (i === n ? { ...it, ...p } : it)));
  return (
    <ActionDialog
      open={open}
      title={from ? `New version of ${from.name}` : 'Draft a new checklist'}
      confirmLabel="Save draft"
      confirmDisabled={name.trim().length < 2 || clean.length === 0}
      onCancel={onClose}
      onConfirm={() =>
        api.send('POST', '/api/v1/vdi-templates', orgId, {
          name: name.trim(),
          ...(type ? { vehicleType: type } : {}),
          items: clean.map((i, n) => ({
            code: codeOf(i.label, n),
            label: i.label.trim(),
            critical: i.critical,
          })),
        })
      }
      fields={
        <div className="grid gap-3">
          <Field label="Checklist name">
            <Input value={name} readOnly={!!from} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Vehicle type">
            <Select
              value={type || undefined}
              placeholder="All vehicles"
              onChange={setType}
              style={{ width: '100%' }}
              allowClear
              options={Object.entries(VEHICLE_TYPE).map(([k, v]) => ({ value: k, label: v }))}
            />
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Items</legend>
            {items.map((it, n) => (
              <div key={n} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={`Item ${n + 1}`}
                  className="flex-1"
                  value={it.label}
                  onChange={(e) => set(n, { label: e.target.value })}
                />
                <Checkbox
                  checked={it.critical}
                  onChange={(e) => set(n, { critical: e.target.checked })}
                >
                  Critical (failing stops use)
                </Checkbox>
                <Button
                  size="small"
                  aria-label={`Remove item ${n + 1}`}
                  onClick={() => setItems(items.filter((_, i) => i !== n))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              size="small"
              onClick={() => setItems([...items, { label: '', critical: false }])}
            >
              Add an item
            </Button>
          </fieldset>
        </div>
      }
    >
      <p>
        The checklist is saved as a draft. A second person publishes it, which retires the version
        crews use now. Mark each item that stops the vehicle being used as critical.
      </p>
    </ActionDialog>
  );
}

/** Edit an equipment asset's details and where it is kept (finding 44). */
export function EquipmentEditDialog({
  asset,
  vehicles,
  locations,
  onClose,
}: {
  asset: Row | null;
  vehicles: Row[];
  locations: Row[];
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [serial, setSerial] = useState('');
  const [model, setModel] = useState('');
  const [maker, setMaker] = useState('');
  const [swl, setSwl] = useState('');
  const [place, setPlace] = useState<'vehicle' | 'location' | 'none'>('none');
  const [vehicleId, setVehicleId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (asset && loadedFor !== `${asset.id}:${asset.version}`) {
    setLoadedFor(`${asset.id}:${asset.version}`);
    setSerial(asset.serial ?? '');
    setModel(asset.model ?? '');
    setMaker(asset.manufacturer ?? '');
    setSwl(asset.swlKg ? String(asset.swlKg) : '');
    setPlace(asset.vehicleId ? 'vehicle' : asset.locationId ? 'location' : 'none');
    setVehicleId(asset.vehicleId ?? vehicles[0]?.id ?? '');
    setLocationId(asset.locationId ?? locations[0]?.id ?? '');
  }
  const swlBad = swl !== '' && !(Number(swl) > 0 && Number(swl) <= 100000);
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  return (
    <ActionDialog
      open={asset !== null}
      title={`Edit ${asset?.assetTag ?? ''}`}
      confirmLabel="Save asset"
      confirmDisabled={
        swlBad || (place === 'vehicle' && !vehicleId) || (place === 'location' && !locationId)
      }
      onCancel={() => {
        setLoadedFor(null);
        onClose();
      }}
      onConfirm={() =>
        api.send(
          'PATCH',
          `/api/v1/equipment/${asset!.id}`,
          orgId,
          {
            serial: opt(serial),
            model: opt(model),
            manufacturer: opt(maker),
            swlKg: swl ? Number(swl) : null,
            vehicleId: place === 'vehicle' ? vehicleId : null,
            locationId: place === 'location' ? locationId : null,
          },
          asset!.version,
        )
      }
      fields={
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Serial number (optional)">
            <Input value={serial} onChange={(e) => setSerial(e.target.value)} />
          </Field>
          <Field label="Manufacturer (optional)">
            <Input value={maker} onChange={(e) => setMaker(e.target.value)} />
          </Field>
          <Field label="Model (optional)">
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Safe working load in kg (optional)">
            <Input value={swl} onChange={(e) => setSwl(e.target.value)} />
          </Field>
          <Field label="Kept">
            <Select
              value={place}
              onChange={(v) => setPlace(v as typeof place)}
              style={{ width: '100%' }}
              options={[
                { value: 'vehicle', label: 'On a vehicle' },
                { value: 'location', label: 'At a base' },
                { value: 'none', label: 'Not assigned' },
              ]}
            />
          </Field>
          {place === 'vehicle' && (
            <Field label="Vehicle">
              <Select
                value={vehicleId}
                onChange={setVehicleId}
                style={{ width: '100%' }}
                options={vehicles.map((v) => ({
                  value: v.id,
                  label: `${v.callsign} (${v.registration})`,
                }))}
              />
            </Field>
          )}
          {place === 'location' && (
            <Field label="Base">
              <Select
                value={locationId}
                onChange={setLocationId}
                style={{ width: '100%' }}
                options={locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            </Field>
          )}
        </div>
      }
    >
      {swlBad && (
        <p role="alert" className="text-red-800">
          Safe working load: enter a number of kg above 0.
        </p>
      )}
      <p>
        Moving the asset changes what its vehicle can do. Inspection regimes stay with the asset.
      </p>
    </ActionDialog>
  );
}

const REGIME_WORDS: Record<string, string> = {
  LOLER_THOROUGH: 'LOLER thorough examination',
  SERVICE: 'Service',
  CALIBRATION: 'Calibration',
  PRE_USE: 'Pre-use check',
  PAT: 'Portable appliance test',
};

/** One asset's details and each inspection regime on its own line (finding 44). */
export function EquipmentDetail({ asset, where }: { asset: Row; where: string }) {
  const regimes = (asset.regimes ?? []) as Row[];
  return (
    <div className="space-y-2 rounded-lg border border-hub-line bg-hub-card p-3 text-sm">
      <h3 className="font-semibold">{asset.assetTag}</h3>
      <dl className="grid gap-x-4 gap-y-1 md:grid-cols-2">
        <dt className="font-medium">Serial number</dt>
        <dd>{asset.serial ?? 'Not recorded'}</dd>
        <dt className="font-medium">Manufacturer and model</dt>
        <dd>{[asset.manufacturer, asset.model].filter(Boolean).join(' ') || 'Not recorded'}</dd>
        <dt className="font-medium">Safe working load</dt>
        <dd>{asset.swlKg ? `${asset.swlKg} kg` : 'Not recorded'}</dd>
        <dt className="font-medium">Kept</dt>
        <dd>{where}</dd>
        <dt className="font-medium">Instructions for use</dt>
        <dd className="whitespace-pre-line">{asset.instructions ?? 'Not recorded'}</dd>
      </dl>
      <h4 className="font-medium">Inspection regimes</h4>
      {regimes.length === 0 ? (
        <StatusBadge status="GREY" reason="No inspection regime set up" />
      ) : (
        <ul className="space-y-1">
          {regimes.map((g) => (
            <li key={g.regime}>
              {REGIME_WORDS[g.regime] ?? 'Inspection'}:{' '}
              <StatusBadge status={g.status as StatusKind} reason={g.reasonText} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Receipt picker for the claim form: uploaded as evidence before the claim (finding 45). */
export function ReceiptPicker({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  return (
    <Field label="Receipt (photo or PDF, optional)">
      <input
        type="file"
        accept="image/*,application/pdf"
        className={input}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      {file && <span className="text-xs">Attached: {file.name}</span>}
    </Field>
  );
}
