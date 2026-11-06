import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { addDays, londonDate, londonDateTime } from '@hub/rules';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  button,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  useRun,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Flag = 'OFF_ROAD' | 'QUARANTINE';

const FLAG_WORD: Record<Flag, string> = { OFF_ROAD: 'Off the road', QUARANTINE: 'Quarantine' };
/** D5: why a vehicle is off the road. */
const OFF_ROAD_REASON: Record<string, string> = {
  ACCIDENT: 'Accident',
  AWAITING_PARTS: 'Awaiting parts',
  REPAIR: 'Under repair',
  SERVICE: 'In for service',
  SOLD: 'Sold',
  OTHER: 'Other',
};
const READY: Record<string, { status: StatusKind; word: string }> = {
  READY: { status: 'GREEN', word: 'Ready' },
  RESTRICTED: { status: 'AMBER', word: 'Restricted' },
  BLOCKED: { status: 'RED', word: 'Blocked' },
};
const CHECK: Record<string, StatusKind> = { PASS: 'GREEN', FAIL: 'RED', PENDING: 'AMBER' };
const CHECK_WORD: Record<string, string> = { PASS: 'Pass', FAIL: 'Fail', PENDING: 'Pending' };

/** Off-road and quarantine switches with a reason, and the history of each change. */
export function VehicleStatusPanel({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const [change, setChange] = useState<{ flag: Flag; on: boolean } | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [backOn, setBackOn] = useState('');
  const offRoadOn = change?.flag === 'OFF_ROAD' && change.on;
  const history = useOne<{ data: Row[] }>(`/api/v1/vehicles/${v.id}/status-history`);
  const manage = can('fleet.vehicle.manage');
  const release = can('fleet.return_to_service');
  const path = (flag: Flag) => (flag === 'OFF_ROAD' ? 'off-road' : 'quarantine');
  const title = !change
    ? ''
    : change.on
      ? change.flag === 'OFF_ROAD'
        ? `Take ${v.callsign} off the road`
        : `Quarantine ${v.callsign}`
      : change.flag === 'OFF_ROAD'
        ? `Put ${v.callsign} back on the road`
        : `Lift quarantine on ${v.callsign}`;
  return (
    <Section title="Vehicle status">
      <p>
        Off the road: <strong>{v.offRoad ? 'Yes' : 'No'}</strong> · Quarantined:{' '}
        <strong>{v.quarantined ? 'Yes' : 'No'}</strong>
      </p>
      <div className="flex flex-wrap gap-2">
        {manage && !v.offRoad && (
          <button className={smallButton} onClick={() => setChange({ flag: 'OFF_ROAD', on: true })}>
            Take {v.callsign} off the road
          </button>
        )}
        {manage && !v.quarantined && (
          <button
            className={smallButton}
            onClick={() => setChange({ flag: 'QUARANTINE', on: true })}
          >
            Quarantine {v.callsign}
          </button>
        )}
        {manage && release && v.offRoad && (
          <button
            className={smallButton}
            onClick={() => setChange({ flag: 'OFF_ROAD', on: false })}
          >
            Put {v.callsign} back on the road
          </button>
        )}
        {manage && release && v.quarantined && (
          <button
            className={smallButton}
            onClick={() => setChange({ flag: 'QUARANTINE', on: false })}
          >
            Lift quarantine on {v.callsign}
          </button>
        )}
      </div>
      {manage && !release && (v.offRoad || v.quarantined) && (
        <p className="text-sm text-slate-700">
          Returning a vehicle to service needs a fleet lead or manager.
        </p>
      )}
      <DataTable<Row>
        caption="Status history"
        rows={history.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={history.isLoading}
        emptyMessage="The vehicle has not been taken off the road or quarantined."
        columns={[
          { key: 'w', header: 'When', cell: (r) => fmtDateTime(r.changedAt) },
          {
            key: 'c',
            header: 'Change',
            cell: (r) => `${FLAG_WORD[r.flag as Flag]} ${r.on ? 'started' : 'ended'}`,
          },
          {
            key: 'r',
            header: 'Reason',
            cell: (r) => (
              <>
                {r.reasonCode ? `${OFF_ROAD_REASON[r.reasonCode] ?? 'Other'}: ` : ''}
                {r.reason}
                {r.expectedReturnOn && (
                  <span className="block text-xs">Expected back {fmtDate(r.expectedReturnOn)}</span>
                )}
              </>
            ),
          },
          {
            key: 'j',
            header: 'Jobs moved off',
            cell: (r) => (r.jobsReleased ? String(r.jobsReleased) : 'None'),
          },
          { key: 'b', header: 'By', cell: (r) => r.changedByName ?? 'Unknown' },
        ]}
      />
      <ActionDialog
        open={change !== null}
        title={title}
        confirmLabel={change?.on ? 'Confirm' : 'Return to service'}
        danger={change?.on}
        reasonLabel={offRoadOn ? 'Details' : 'Reason'}
        confirmDisabled={offRoadOn && !reasonCode}
        onCancel={() => {
          setChange(null);
          setReasonCode('');
          setBackOn('');
        }}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/vehicles/${v.id}/${path(change!.flag)}`, orgId, {
            on: change!.on,
            reason,
            ...(offRoadOn ? { reasonCode } : {}),
            ...(offRoadOn && backOn ? { expectedReturnOn: backOn } : {}),
          })
        }
        fields={
          offRoadOn ? (
            <>
              <Field label="Why is it off the road?">
                <select
                  className={input}
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                >
                  <option value="">Choose a reason</option>
                  {Object.entries(OFF_ROAD_REASON).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Expected back (optional)">
                <input
                  type="date"
                  className={input}
                  value={backOn}
                  min={londonDate(new Date())}
                  onChange={(e) => setBackOn(e.target.value)}
                />
              </Field>
            </>
          ) : undefined
        }
      >
        {change?.on ? (
          <p>
            Jobs on this vehicle that have not started go back to the planner and control is
            alerted. Jobs already under way are flagged to control.
          </p>
        ) : (
          <p>The vehicle can be used again once nothing else blocks it.</p>
        )}
      </ActionDialog>
    </Section>
  );
}

/** Move the vehicle's base; the move is kept in its location history. */
export function MoveBase({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState('');
  const today = londonDate(new Date());
  const [effectiveOn, setEffectiveOn] = useState(today);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const all = locations.data?.data ?? [];
  const current = all.find((l) => l.id === v.baseLocationId);
  const moves = (v.locations ?? []) as Row[];
  return (
    <Section title="Base location">
      <p>
        Based at: <strong>{current?.name ?? 'Unknown location'}</strong>
      </p>
      <button className={smallButton} onClick={() => setOpen(true)}>
        Move {v.callsign} to another base
      </button>
      <ActionDialog
        open={open}
        title={`Move ${v.callsign} to another base`}
        confirmLabel="Move vehicle"
        reasonLabel="Reason for the move"
        confirmDisabled={!locationId || !effectiveOn || effectiveOn > today}
        onCancel={() => {
          setOpen(false);
          setLocationId('');
          setEffectiveOn(today);
        }}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/vehicles/${v.id}/move`, orgId, {
            locationId,
            reason,
            ...(effectiveOn !== today ? { effectiveOn } : {}),
          })
        }
        fields={
          <>
            <Field label="New base">
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className={input}
              >
                <option value="">Choose a location</option>
                {all
                  .filter((l) => l.id !== v.baseLocationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Takes effect on">
              <input
                type="date"
                className={input}
                value={effectiveOn}
                max={today}
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
            </Field>
          </>
        }
      />
      {moves.length > 0 && (
        <DataTable<Row>
          caption="Base history"
          rows={moves}
          rowKey={(r) => `${r.locationId}-${r.at}`}
          emptyMessage="No moves."
          columns={[
            {
              key: 'e',
              header: 'Effective',
              cell: (r) => (r.effectiveOn ? fmtDate(r.effectiveOn) : fmtDateTime(r.at)),
            },
            {
              key: 'l',
              header: 'Base',
              cell: (r) => all.find((l) => l.id === r.locationId)?.name ?? 'Unknown location',
            },
            { key: 'r', header: 'Reason', cell: (r) => r.reason },
          ]}
        />
      )}
    </Section>
  );
}

/** Check whether the vehicle could take a journey in a time window. */
export function ReadinessCheck({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function check(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const day = String(f.get('day'));
    const from = londonDateTime(day, String(f.get('from')));
    const to = londonDateTime(day, String(f.get('to')));
    if (to <= from) {
      setResult(null);
      setError('The end time must be after the start time.');
      return;
    }
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (f.get('stretcher')) q.set('stretcher', 'true');
    if (Number(f.get('wheelchairs'))) q.set('wheelchairs', String(f.get('wheelchairs')));
    if (Number(f.get('seats'))) q.set('seats', String(f.get('seats')));
    setError(null);
    try {
      setResult((await api.get(`/api/v1/vehicles/${v.id}/readiness?${q}`, orgId)) as Row);
    } catch {
      setResult(null);
      setError('The readiness check could not be run.');
    }
  }
  const today = londonDate(new Date());
  const state = result ? (READY[result.state] ?? { status: 'GREY', word: 'Unknown' }) : null;
  return (
    <Section title="Readiness for a journey">
      <form
        onSubmit={check}
        aria-label={`Check readiness of ${v.callsign}`}
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Day">
          <input
            name="day"
            type="date"
            required
            defaultValue={today}
            min={today}
            max={addDays(today, 60)}
            className={input}
          />
        </Field>
        <Field label="From">
          <input name="from" type="time" required defaultValue="09:00" className={input} />
        </Field>
        <Field label="To">
          <input name="to" type="time" required defaultValue="12:00" className={input} />
        </Field>
        <Field label="Seats needed">
          <input name="seats" type="number" min={0} max={60} className={input} />
        </Field>
        <Field label="Wheelchairs">
          <input name="wheelchairs" type="number" min={0} max={10} className={input} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input name="stretcher" type="checkbox" /> Stretcher needed
        </label>
        <button className={button}>Check readiness</button>
      </form>
      {error && (
        <p role="alert" className="text-red-900">
          {error}
        </p>
      )}
      {result && state && (
        <>
          <p role="status">
            Result: <StatusBadge status={state.status} reason={state.word} />
          </p>
          <DataTable<Row>
            caption="Vehicle readiness checks"
            rows={result.checks}
            rowKey={(r) => r.code}
            emptyMessage="No checks apply."
            columns={[
              { key: 'r', header: 'Check', cell: (r) => r.reasonText },
              {
                key: 's',
                header: 'Result',
                cell: (r) => (
                  <StatusBadge
                    status={CHECK[r.result] ?? 'GREY'}
                    reason={CHECK_WORD[r.result] ?? 'Unknown'}
                  />
                ),
              },
            ]}
          />
        </>
      )}
    </Section>
  );
}

/** Add a maintenance plan (date or mileage interval, whichever comes first). */
export function MaintenanceAdd({ v }: { v: Row }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    const str = (k: string) => (f.get(k) ? String(f.get(k)) : undefined);
    if (
      await run(
        () =>
          api.send('POST', `/api/v1/vehicles/${v.id}/maintenance`, orgId, {
            title: String(f.get('title')),
            intervalDays: num('intervalDays'),
            intervalMiles: num('intervalMiles'),
            lastDoneOn: str('lastDoneOn'),
            lastDoneOdometer: num('lastDoneOdometer'),
          }),
        'Maintenance plan added.',
      )
    )
      form.reset();
  }
  return (
    <>
      {msg}
      <form
        onSubmit={add}
        aria-label="Add maintenance plan"
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Plan name">
          <input name="title" required minLength={2} maxLength={120} className={input} />
        </Field>
        <Field label="Every (days)">
          <input name="intervalDays" type="number" min={1} max={1100} className={input} />
        </Field>
        <Field label="Every (miles)">
          <input name="intervalMiles" type="number" min={100} max={100000} className={input} />
        </Field>
        <Field label="Last done on">
          <input name="lastDoneOn" type="date" className={input} />
        </Field>
        <Field label="Odometer at last service">
          <input name="lastDoneOdometer" type="number" min={0} className={input} />
        </Field>
        <button className={button}>Add plan</button>
      </form>
    </>
  );
}

/** Record that a planned service was done. */
export function MaintenanceDoneDialog(p: { v: Row; plan: Row | null; onClose: () => void }) {
  const { api, orgId } = useApp();
  const today = londonDate(new Date());
  const [doneOn, setDoneOn] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [garage, setGarage] = useState('');
  const [sheet, setSheet] = useState<File | null>(null);
  return (
    <ActionDialog
      open={p.plan !== null}
      title={`Record service done for ${p.plan?.title ?? ''}`}
      confirmLabel="Record service"
      reasonLabel="Notes"
      reasonRequired={false}
      confirmDisabled={!doneOn || doneOn > today}
      onCancel={() => {
        setDoneOn(today);
        setOdometer('');
        setGarage('');
        setSheet(null);
        p.onClose();
      }}
      onConfirm={async (notes) => {
        // D2: the garage's job sheet is uploaded as evidence first, then linked to the record.
        const title = `Job sheet ${p.plan!.title} ${doneOn}`;
        const up = sheet ? await uploadFile(api, orgId, sheet, { title }) : null;
        return api.send(
          'POST',
          `/api/v1/vehicles/${p.v.id}/maintenance/${p.plan!.id}/done`,
          orgId,
          {
            doneOn,
            odometer: odometer ? Number(odometer) : undefined,
            notes: notes || undefined,
            garage: garage.trim() || undefined,
            jobSheetEvidenceItemId: up?.itemId,
          },
        );
      }}
      fields={
        <>
          <Field label="Garage (optional)">
            <input
              className={input}
              maxLength={120}
              value={garage}
              onChange={(e) => setGarage(e.target.value)}
            />
          </Field>
          <Field label="Job sheet (optional)">
            <input
              type="file"
              accept="image/*,application/pdf"
              className={input}
              onChange={(e) => setSheet(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label="Done on">
            <input
              type="date"
              value={doneOn}
              max={today}
              onChange={(e) => setDoneOn(e.target.value)}
              className={input}
            />
          </Field>
          <Field label="Odometer (miles)">
            <input
              type="number"
              min={0}
              value={odometer}
              onChange={(e) => setOdometer(e.target.value)}
              className={input}
            />
          </Field>
        </>
      }
    />
  );
}
