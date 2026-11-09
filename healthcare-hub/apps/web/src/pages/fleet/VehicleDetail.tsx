import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  Tabs,
  button,
  fmtDate,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { EvidenceDialog, UploadDialog } from '../evidence/Evidence.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { Defects } from './Defects.js';
import { VehicleBadge } from './Fleet.js';
import {
  EN1789,
  OWNERSHIP,
  VEHICLE_TYPE,
  VehicleEditDialog,
  licenceText,
  odometerText,
} from './FleetRegisters.js';
import {
  MaintenanceAdd,
  MaintenanceDoneDialog,
  MoveBase,
  ReadinessCheck,
  VehicleStatusPanel,
} from './VehicleOperations.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MAINT: Record<string, StatusKind> = { OK: 'GREEN', DUE_SOON: 'AMBER', OVERDUE: 'RED' };
const miles = (n: number) => `${Number(n).toLocaleString('en-GB')} mi`;
/** D1: the header says whether the vehicle can be used now, and why not. */
const HEADLINE: Record<string, { kind: StatusKind; text: string }> = {
  AVAILABLE: { kind: 'GREEN', text: 'Available' },
  BLOCKED: { kind: 'RED', text: 'Blocked' },
  QUARANTINED: { kind: 'RED', text: 'Quarantined' },
  OFF_ROAD: { kind: 'GREY', text: 'Off road' },
};

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
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-hub-line bg-hub-card p-4">
        <div>
          <h1 className="text-2xl font-bold">
            {v.callsign} <span className="text-slate-600">/ {v.registration}</span>
          </h1>
          <p className="text-sm">
            {VEHICLE_TYPE[v.type] ?? words(v.type)} · {v.seats} seats ·{' '}
            {v.capability.wheelchairCapacity} wheelchair ·{' '}
            {v.capability.stretcher ? 'stretcher' : 'no stretcher'} · licence {v.licenceCategory}
          </p>
          <p className="text-sm">Latest odometer reading: {odometerText(v)}</p>
          {v.capability.lost.length > 0 && (
            <p className="mt-1 text-sm text-red-900">
              Capability reduced: {v.capability.lost.join('; ')}
            </p>
          )}
        </div>
        {v.headline ? (
          <StatusBadge
            status={HEADLINE[v.headline.status]?.kind ?? 'GREY'}
            reason={
              v.headline.reason
                ? `${HEADLINE[v.headline.status]?.text ?? words(v.headline.status)} – ` +
                  v.headline.reason
                : (HEADLINE[v.headline.status]?.text ?? words(v.headline.status))
            }
          />
        ) : (
          <VehicleBadge v={v} />
        )}
      </header>
      <Tabs
        label="Vehicle sections"
        current={tab}
        onChange={setTab}
        tabs={[
          { id: 'register', label: 'Register details' },
          { id: 'overview', label: 'Maintenance and odometer' },
          { id: 'status', label: 'Status and readiness' },
          { id: 'defects', label: 'Defects' },
          { id: 'inspections', label: 'Inspections', show: can('fleet.vdi.view') },
          {
            id: 'documents',
            label: 'Documents',
            show: can('compliance.requirement.view'),
          },
        ]}
      >
        {tab === 'register' && <Register v={v} />}
        {tab === 'overview' && <Overview v={v} />}
        {tab === 'status' && (
          <>
            <VehicleStatusPanel v={v} />
            {can('fleet.vehicle.manage') && <MoveBase v={v} />}
            <ReadinessCheck v={v} />
          </>
        )}
        {tab === 'defects' && <Defects vehicleId={v.id} />}
        {tab === 'inspections' && <Inspections vehicleId={v.id} />}
        {tab === 'documents' && can('compliance.requirement.view') && (
          <Documents vehicleId={v.id} />
        )}
      </Tabs>
    </div>
  );
}

/** The register entry for the vehicle, with its statutory documents at a glance (finding 39). */
function Register({ v }: { v: Row }) {
  const { orgId } = useApp();
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const docs = useOne<{ data: Row[] }>(
    `/api/v1/requirements/instances?subjectId=${v.id}&limit=100`,
    can('compliance.requirement.view'),
  );
  const base = (locations.data?.data ?? []).find((l) => l.id === v.baseLocationId)?.name;
  const loads = (v.permittedLoads ?? []) as string[];
  return (
    <Section
      title="Vehicle register"
      actions={
        can('fleet.vehicle.manage') ? (
          <button
            className={smallButton}
            aria-label={`Edit register details for ${v.callsign}`}
            onClick={() => setEditing(true)}
          >
            Edit details
          </button>
        ) : null
      }
    >
      <dl
        className={
          'grid gap-x-6 gap-y-1 rounded-lg border border-hub-line bg-hub-card p-4 text-sm ' +
          'md:grid-cols-2'
        }
      >
        <dt className="font-medium">Registration</dt>
        <dd>{v.registration}</dd>
        <dt className="font-medium">VIN</dt>
        <dd>{v.vin ?? 'Not recorded'}</dd>
        <dt className="font-medium">Type</dt>
        <dd>{VEHICLE_TYPE[v.type] ?? words(v.type)}</dd>
        <dt className="font-medium">Ownership</dt>
        <dd>{OWNERSHIP[v.ownership] ?? words(v.ownership)}</dd>
        <dt className="font-medium">Base</dt>
        <dd>{base ?? 'Loading…'}</dd>
        <dt className="font-medium">Licence category needed</dt>
        <dd>{licenceText(v.licenceCategory)}</dd>
        <dt className="font-medium">Gross vehicle weight</dt>
        <dd>
          {v.grossWeightKg
            ? `${Number(v.grossWeightKg).toLocaleString('en-GB')} kg`
            : 'Not recorded'}
        </dd>
        <dt className="font-medium">Permitted loads</dt>
        <dd>{loads.length ? loads.join(', ') : 'None recorded'}</dd>
        <dt className="font-medium">Driving licence</dt>
        <dd>{v.licenceNeeded ?? licenceText(v.licenceCategory)}</dd>
        <dt className="font-medium">Make, model and year</dt>
        <dd>{[v.make, v.model, v.year].filter(Boolean).join(' ') || 'Not recorded'}</dd>
        <dt className="font-medium">First registered</dt>
        <dd>{v.firstRegisteredOn ? fmtDate(v.firstRegisteredOn) : 'Not recorded'}</dd>
        <dt className="font-medium">BS EN 1789 type</dt>
        <dd>{v.en1789Type ? (EN1789[v.en1789Type] ?? v.en1789Type) : 'Not recorded'}</dd>
        <dt className="font-medium">Conversion</dt>
        <dd>
          {v.conversionCompany
            ? `${v.conversionCompany}${
                v.conversionCertificateRef ? `, certificate ${v.conversionCertificateRef}` : ''
              }`
            : 'Not recorded'}
        </dd>
        {v.ownership !== 'OWNED' && (
          <>
            <dt className="font-medium">Lease or hire ends</dt>
            <dd>{v.ownershipEndsOn ? fmtDate(v.ownershipEndsOn) : 'Not recorded'}</dd>
          </>
        )}
        <dt className="font-medium">Blue-light driving</dt>
        <dd>{v.blueLightAuthorised ? 'Authorised' : 'Not authorised'}</dd>
        <dt className="font-medium">Bariatric limit</dt>
        <dd>{v.bariatricLimitKg ? `${v.bariatricLimitKg} kg` : 'Not recorded'}</dd>
        <dt className="font-medium">Latest odometer reading</dt>
        <dd>{odometerText(v)}</dd>
      </dl>
      {can('compliance.requirement.view') && (
        <>
          <h3 className="font-semibold">Statutory documents</h3>
          {(docs.data?.data ?? []).length === 0 ? (
            <p className="text-sm">
              No document requirements yet. Add MOT, insurance and road tax on the Documents tab.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {(docs.data?.data ?? []).map((d) => (
                <li key={d.id}>
                  {d.templateTitle}:{' '}
                  <StatusBadge status={d.status as StatusKind} reason={d.reasonText} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <VehicleEditDialog v={editing ? v : null} onClose={() => setEditing(false)} />
    </Section>
  );
}

function Overview({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const [donePlan, setDonePlan] = useState<Row | null>(null);
  const [reviewing, setReviewing] = useState<Row | null>(null);
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
                [
                  r.dueDate && fmtDate(r.dueDate),
                  r.dueOdometer && `${r.dueOdometer.toLocaleString('en-GB')} mi`,
                ]
                  .filter(Boolean)
                  .join(' or ') || '—',
            },
            {
              key: 'f',
              header: 'Which limit comes first',
              cell: (r) => r.firstLimitText ?? '—',
            },
            {
              key: 's',
              header: 'Status',
              cell: (r) => <StatusBadge status={MAINT[r.state] ?? 'GREY'} reason={r.text} />,
            },
            ...(can('fleet.vehicle.manage')
              ? [
                  {
                    key: 'a',
                    header: 'Action',
                    cell: (r: Row) => (
                      <button
                        className={smallButton}
                        aria-label={`Record service done for ${r.title}`}
                        onClick={() => setDonePlan(r)}
                      >
                        Record service done
                      </button>
                    ),
                  },
                ]
              : []),
          ]}
        />
        {can('fleet.vehicle.manage') && <MaintenanceAdd v={v} />}
        <MaintenanceDoneDialog v={v} plan={donePlan} onClose={() => setDonePlan(null)} />
      </Section>
      <Section title="Odometer">
        <DataTable<Row>
          caption="Recent odometer readings"
          rows={v.readings}
          rowKey={(r) => r.id}
          emptyMessage="No readings."
          columns={[
            { key: 'd', header: 'Date', cell: (r) => fmtDate(r.readOn) },
            { key: 'r', header: 'Reading', cell: (r) => `${r.reading.toLocaleString('en-GB')} mi` },
            { key: 's', header: 'Source', cell: (r) => words(r.source) },
            {
              key: 'f',
              header: 'Flags',
              cell: (r) =>
                r.flags.length === 0 ? (
                  'None'
                ) : r.review ? (
                  <>
                    {r.flags.map(words).join(', ')}
                    <span className="block text-xs">
                      {r.review.decision === 'CONFIRMED'
                        ? 'Confirmed as right'
                        : `Corrected to ${miles(r.review.correctedReading)}`}{' '}
                      by {r.review.reviewedByName ?? 'unknown'}: {r.review.reason}
                    </span>
                  </>
                ) : (
                  <StatusBadge
                    status="AMBER"
                    reason={`${r.flags.map(words).join(', ')} – needs a fleet review`}
                  />
                ),
            },
            ...(can('fleet.vehicle.manage')
              ? [
                  {
                    key: 'a',
                    header: 'Action',
                    cell: (r: Row) =>
                      r.flags.length && !r.review ? (
                        <button
                          className={smallButton}
                          aria-label={`Review the ${fmtDate(r.readOn)} reading of ${v.callsign}`}
                          onClick={() => setReviewing(r)}
                        >
                          Confirm or correct
                        </button>
                      ) : null,
                  },
                ]
              : []),
          ]}
        />
        <OdometerReview v={v} reading={reviewing} onClose={() => setReviewing(null)} />
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

/** D2: the Fleet lead confirms a flagged reading or corrects it, with a reason. */
function OdometerReview({
  v,
  reading,
  onClose,
}: {
  v: Row;
  reading: Row | null;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [decision, setDecision] = useState<'CONFIRMED' | 'CORRECTED'>('CONFIRMED');
  const [corrected, setCorrected] = useState('');
  const bad = decision === 'CORRECTED' && !(Number.isInteger(+corrected) && +corrected >= 0);
  return (
    <ActionDialog
      open={reading !== null}
      title={`Review the ${reading ? fmtDate(reading.readOn) : ''} reading of ${v.callsign}`}
      confirmLabel={decision === 'CONFIRMED' ? 'Confirm reading' : 'Save correction'}
      confirmDisabled={bad || (decision === 'CORRECTED' && corrected === '')}
      reasonLabel="Why? (what you checked)"
      onCancel={() => {
        setDecision('CONFIRMED');
        setCorrected('');
        onClose();
      }}
      onConfirm={(reason) =>
        api.send('POST', `/api/v1/vehicles/${v.id}/odometer/${reading!.id}/review`, orgId, {
          decision,
          ...(decision === 'CORRECTED' ? { correctedReading: Number(corrected) } : {}),
          reason,
        })
      }
      fields={
        <div className="grid gap-3">
          <Field label="Decision">
            <select
              className={input}
              value={decision}
              onChange={(e) => setDecision(e.target.value as typeof decision)}
            >
              <option value="CONFIRMED">The reading is right</option>
              <option value="CORRECTED">The reading is wrong: correct it</option>
            </select>
          </Field>
          {decision === 'CORRECTED' && (
            <Field label="Correct reading (miles)">
              <input
                className={input}
                inputMode="numeric"
                value={corrected}
                onChange={(e) => setCorrected(e.target.value)}
              />
            </Field>
          )}
        </div>
      }
    >
      <p>
        {reading
          ? `${Number(reading.reading).toLocaleString('en-GB')} mi was flagged: ` +
            `${(reading.flags as string[]).map(words).join(', ')}.`
          : ''}{' '}
        Your name and reason are kept with the reading; the original is not changed.
      </p>
    </ActionDialog>
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
  const can = useCan();
  const [docsFor, setDocsFor] = useState<Row | null>(null);
  const [uploadFor, setUploadFor] = useState<Row | null>(null);
  const target = (r: Row | null) =>
    r ? { instanceId: r.id, title: r.templateTitle, deadlineKind: r.deadlineKind } : null;
  return (
    <>
      <DataTable<Row>
        caption="Vehicle documents and requirements"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'You do not have access to vehicle requirements.' : null}
        emptyMessage="No document requirements yet. Add MOT, insurance or road tax below."
        columns={[
          { key: 't', header: 'Requirement', cell: (r) => r.templateTitle },
          {
            key: 'd',
            header: 'Next date',
            cell: (r) =>
              r.expiryDate
                ? `Expiry: ${fmtDate(r.expiryDate)}`
                : r.dueDate
                  ? `Due: ${fmtDate(r.dueDate)}`
                  : 'Not set',
          },
          {
            key: 'v',
            header: 'Verified',
            cell: (r) => (r.currentlyVerified ? 'Yes – verified evidence on file' : 'No'),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />,
          },
          {
            key: 'a',
            header: 'Action',
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                <button
                  className={smallButton}
                  aria-label={`Documents for ${r.templateTitle}`}
                  onClick={() => setDocsFor(r)}
                >
                  Documents
                </button>
                {can('compliance.evidence.upload') && (
                  <button
                    className={smallButton}
                    aria-label={`Upload evidence for ${r.templateTitle}`}
                    onClick={() => setUploadFor(r)}
                  >
                    Upload evidence
                  </button>
                )}
              </span>
            ),
          },
        ]}
      />
      {can('compliance.requirement.manage') && (
        <AddDocumentRequirement
          vehicleId={vehicleId}
          applied={(res.data?.data ?? []).map((r) => r.templateId as string)}
        />
      )}
      <p className="text-sm">
        An upload is checked by someone else before the requirement turns green.
      </p>
      <UploadDialog target={target(uploadFor)} onClose={() => setUploadFor(null)} />
      <EvidenceDialog target={target(docsFor)} onClose={() => setDocsFor(null)} />
    </>
  );
}

/**
 * Adds a statutory document requirement (MOT, insurance, road tax) to this vehicle from the
 * organisation's published vehicle requirements (finding 39).
 */
function AddDocumentRequirement({ vehicleId, applied }: { vehicleId: string; applied: string[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const templates = useOne<{ data: Row[] }>('/api/v1/requirements/templates');
  const [templateId, setTemplateId] = useState('');
  const [date, setDate] = useState('');
  const effective = (t: Row) =>
    (t.versions as Row[]).find((x) => x.status === 'EFFECTIVE' && x.subjectType === 'VEHICLE');
  const usable = (templates.data?.data ?? []).filter(
    (t) => !t.isLibrary && effective(t) && !applied.includes(t.id),
  );
  const chosen = usable.find((t) => t.id === templateId);
  const expiry = chosen ? effective(chosen)?.deadlineKind === 'EXPIRY' : false;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!templateId) return;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/requirements/instances', orgId, {
          templateId,
          subjectType: 'VEHICLE',
          subjectId: vehicleId,
          ...(date ? (expiry ? { expiryDate: date } : { dueDate: date }) : {}),
        }),
      'Requirement added. Upload the document; someone else verifies it.',
    );
    if (ok) {
      setTemplateId('');
      setDate('');
    }
  }
  return (
    <Section title="Add a document requirement">
      {templates.data && usable.length === 0 ? (
        <p className="text-sm">
          Every published vehicle requirement is already on this vehicle. To add MOT, insurance or
          road tax, adopt and publish them in Settings, Requirement library.
        </p>
      ) : (
        <form
          onSubmit={submit}
          className="flex flex-wrap items-end gap-3"
          aria-label="Add a document requirement"
        >
          <Field label="Requirement">
            <select
              className={input}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Choose MOT, insurance, road tax…</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={expiry ? 'Current expiry date (optional)' : 'Next due date (optional)'}>
            <input
              type="date"
              className={input}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          <button className={button} disabled={!templateId}>
            Add requirement
          </button>
        </form>
      )}
      {msg}
    </Section>
  );
}
