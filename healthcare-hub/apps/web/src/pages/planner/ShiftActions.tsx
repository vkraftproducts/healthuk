import { DataTable } from '@hub/ui';
import { londonDate, londonDateTime, londonTime } from '@hub/rules';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  button,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { CrewReadiness } from './CrewReadiness.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type JobChange = { job: Row; to: 'REASSIGNED' | 'CANCELLED' };

const NOT_STARTED = ['ALLOCATED', 'OFFERED', 'ACKNOWLEDGED'];
const ROLES = ['DRIVER', 'CARE_ASSISTANT', 'EMERGENCY_CARE_ASSISTANT', 'TECHNICIAN', 'PARAMEDIC'];
const span = (a: string, b: string) => `${londonTime(new Date(a))}–${londonTime(new Date(b))}`;

/** Change a planned or running shift: crew, vehicle, its jobs, or cancel it outright. */
export function ShiftActions({
  shift,
  otherShifts = [],
  onClose,
}: {
  shift: Row;
  otherShifts?: Row[];
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const [standDown, setStandDown] = useState<Row | null>(null);
  const [swap, setSwap] = useState<Row | null>(null);
  const [swapTo, setSwapTo] = useState('');
  const [addId, setAddId] = useState('');
  const [addRole, setAddRole] = useState(ROLES[0]!);
  const [moving, setMoving] = useState<Row | null>(null);
  const [toShift, setToShift] = useState('');
  const targets = otherShifts.filter(
    (s) => s.id !== shift.id && ['PLANNED', 'STARTED'].includes(s.state),
  );
  const rest = { from: shift.startsAt as string, to: shift.endsAt as string };
  const [jobChange, setJobChange] = useState<JobChange | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?lifecycle=ACTIVE');
  const crew = (shift.crew as Row[]).filter((c) => c.active);
  const free = (staff.data?.data ?? []).filter((p) => !crew.some((c) => c.staffId === p.id));
  const nameOf = (id: string) =>
    (staff.data?.data ?? []).find((p) => p.id === id)?.displayName ?? 'This person';
  const jobs = shift.jobs as Row[];
  const base = `/api/v1/shifts/${shift.id}`;
  const label = `${shift.vehicleCallsign} ${span(shift.startsAt, shift.endsAt)}`;

  async function addCrew(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const day = londonDate(new Date(shift.startsAt));
    const at = (k: string) =>
      f.get(k) ? londonDateTime(day, String(f.get(k))).toISOString() : undefined;
    if (
      await run(
        () =>
          api.send('POST', `${base}/crew`, orgId, {
            staffId: addId,
            role: addRole,
            ...(at('from') ? { startsAt: at('from') } : {}),
            ...(at('to') ? { endsAt: at('to') } : {}),
          }),
        'Crew member added. They have been told about the shift.',
      )
    ) {
      form.reset();
      setAddId('');
    }
  }

  return (
    <Section
      title={`Manage shift ${label}`}
      actions={
        <button className={smallButton} onClick={onClose}>
          Close
        </button>
      }
    >
      {msg}
      <DataTable<Row>
        caption={`Crew on ${shift.vehicleCallsign}`}
        rows={crew}
        rowKey={(r) => r.id}
        emptyMessage="No crew on this shift."
        columns={[
          { key: 'n', header: 'Name', cell: (r) => `${r.displayName} (${r.staffNo})` },
          { key: 'r', header: 'Role', cell: (r) => words(r.role) },
          { key: 't', header: 'Time', cell: (r) => span(r.startsAt, r.endsAt) },
          {
            key: 'a',
            header: 'Action',
            cell: (r) => (
              <span className="flex flex-wrap gap-1">
                <button
                  className={smallButton}
                  aria-label={`Swap ${r.displayName}`}
                  onClick={() => {
                    setSwapTo('');
                    setSwap(r);
                  }}
                >
                  Swap
                </button>
                <button
                  className={smallButton}
                  aria-label={`Stand down ${r.displayName}`}
                  onClick={() => setStandDown(r)}
                >
                  Stand down
                </button>
              </span>
            ),
          },
        ]}
      />
      <form
        onSubmit={addCrew}
        aria-label={`Add crew to ${shift.vehicleCallsign}`}
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Crew member">
          <select
            name="staffId"
            required
            className={input}
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
          >
            <option value="">Choose a person</option>
            {free.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.staffNo})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role on the shift">
          <select
            name="role"
            className={input}
            value={addRole}
            onChange={(e) => setAddRole(e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {words(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From (optional)">
          <input name="from" type="time" className={input} />
        </Field>
        <Field label="To (optional)">
          <input name="to" type="time" className={input} />
        </Field>
        <button className={button}>Add to shift</button>
      </form>
      {addId && (
        <CrewReadiness
          staffId={addId}
          name={nameOf(addId)}
          role={addRole}
          window={rest}
          vehicleId={addRole === 'DRIVER' ? shift.vehicleId : undefined}
        />
      )}

      <DataTable<Row>
        caption={`Jobs on ${shift.vehicleCallsign}`}
        rows={jobs}
        rowKey={(r) => r.jobId}
        emptyMessage="No jobs on this shift."
        columns={[
          { key: 'c', header: 'Job', cell: (r) => r.code },
          { key: 's', header: 'State', cell: (r) => words(r.state) },
          { key: 't', header: 'Time', cell: (r) => span(r.startsAt, r.endsAt) },
          {
            key: 'a',
            header: 'Action',
            cell: (r) =>
              NOT_STARTED.includes(r.state) ? (
                <span className="flex flex-wrap gap-1">
                  {targets.length > 0 && (
                    <button
                      className={smallButton}
                      aria-label={`Move ${r.code} to another shift`}
                      onClick={() => {
                        setToShift('');
                        setMoving(r);
                      }}
                    >
                      Move to another shift
                    </button>
                  )}
                  <button
                    className={smallButton}
                    aria-label={`Take ${r.code} off this shift`}
                    onClick={() => setJobChange({ job: r, to: 'REASSIGNED' })}
                  >
                    Take off shift
                  </button>
                  <button
                    className={smallButton}
                    aria-label={`Cancel ${r.code}`}
                    onClick={() => setJobChange({ job: r, to: 'CANCELLED' })}
                  >
                    Cancel job
                  </button>
                </span>
              ) : (
                'Under way – change it from the job record'
              ),
          },
        ]}
      />

      <div className="flex flex-wrap gap-2">
        <button className={smallButton} onClick={() => setSwapOpen(true)}>
          Change vehicle on {shift.vehicleCallsign}
        </button>
        {shift.state === 'PLANNED' && (
          <button className={smallButton} onClick={() => setCancelOpen(true)}>
            Cancel shift on {shift.vehicleCallsign}
          </button>
        )}
      </div>

      <ActionDialog
        open={standDown !== null}
        title={`Stand down ${standDown?.displayName ?? ''}`}
        confirmLabel="Stand down"
        reasonLabel="Reason"
        danger
        onCancel={() => setStandDown(null)}
        onConfirm={(reason) =>
          api.send('POST', `${base}/crew/${standDown!.id}/end`, orgId, { reason })
        }
      >
        <p>
          Before the shift starts the assignment is withdrawn; once it is running it ends now. The
          crew member is told.
        </p>
      </ActionDialog>

      <ActionDialog
        open={swap !== null}
        title={`Swap ${swap?.displayName ?? ''}`}
        confirmLabel="Swap crew member"
        reasonLabel="Reason for the swap"
        confirmDisabled={!swapTo}
        onCancel={() => setSwap(null)}
        onConfirm={(reason) =>
          api.send('POST', `${base}/crew/${swap!.id}/swap`, orgId, { staffId: swapTo, reason })
        }
        fields={
          <>
            <Field label="Replacement">
              <select className={input} value={swapTo} onChange={(e) => setSwapTo(e.target.value)}>
                <option value="">Choose a person</option>
                {free.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.staffNo})
                  </option>
                ))}
              </select>
            </Field>
            {swap && swapTo && (
              <CrewReadiness
                staffId={swapTo}
                name={nameOf(swapTo)}
                role={swap.role}
                window={{ from: swap.startsAt, to: swap.endsAt }}
                vehicleId={swap.role === 'DRIVER' ? shift.vehicleId : undefined}
              />
            )}
          </>
        }
      >
        <p>
          The replacement takes the same role for the rest of the assignment and is checked by the
          server first. Both people are told.
        </p>
      </ActionDialog>

      <ActionDialog
        open={moving !== null}
        title={`Move ${moving?.code ?? ''} to another shift`}
        confirmLabel="Move job"
        reasonLabel="Reason"
        confirmDisabled={!toShift}
        onCancel={() => setMoving(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/jobs/${moving!.jobId}/reassign`, orgId, {
            shiftId: toShift,
            reason,
          })
        }
        fields={
          <Field label="New shift">
            <select className={input} value={toShift} onChange={(e) => setToShift(e.target.value)}>
              <option value="">Choose a shift</option>
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.vehicleCallsign} {span(s.startsAt, s.endsAt)}
                </option>
              ))}
            </select>
          </Field>
        }
      >
        <p>
          Every allocation check runs again on the new shift. If anything fails the job stays where
          it is; nothing is overridden. The old allocation is ended with your reason.
        </p>
      </ActionDialog>

      <ActionDialog
        open={jobChange !== null}
        title={
          jobChange?.to === 'CANCELLED'
            ? `Cancel ${jobChange.job.code}`
            : `Take ${jobChange?.job.code ?? ''} off this shift`
        }
        confirmLabel={jobChange?.to === 'CANCELLED' ? 'Cancel job' : 'Take off shift'}
        reasonLabel="Reason"
        danger={jobChange?.to === 'CANCELLED'}
        onCancel={() => setJobChange(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/jobs/${jobChange!.job.jobId}/status`, orgId, {
            state: jobChange!.to,
            capturedAt: new Date().toISOString(),
            reason,
            clientSubmissionId: crypto.randomUUID(),
          })
        }
      >
        <p>
          {jobChange?.to === 'CANCELLED'
            ? 'The job is cancelled and the crew are told. This cannot be undone.'
            : 'The job goes back to the unallocated list and the crew are told.'}
        </p>
      </ActionDialog>

      <ActionDialog
        open={swapOpen}
        title={`Change vehicle on ${shift.vehicleCallsign}`}
        confirmLabel="Change vehicle"
        reasonLabel="Reason"
        confirmDisabled={!vehicleId}
        onCancel={() => {
          setSwapOpen(false);
          setVehicleId('');
        }}
        onConfirm={(reason) => api.send('POST', `${base}/vehicle`, orgId, { vehicleId, reason })}
        fields={
          <Field label="Replacement vehicle">
            <select
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              className={input}
            >
              <option value="">Choose a vehicle</option>
              {(vehicles.data?.data ?? [])
                .filter((v) => v.id !== shift.vehicleId)
                .map((v) => (
                  <option key={v.id} value={v.id} disabled={v.status !== 'AVAILABLE'}>
                    {v.callsign}
                    {v.status !== 'AVAILABLE'
                      ? ` – ${words(v.status).toLowerCase()}, cannot be used`
                      : ''}
                  </option>
                ))}
            </select>
          </Field>
        }
      >
        <p>The replacement needs its own daily inspection and cleaning before the shift can run.</p>
        <p>Only available vehicles can be chosen. A blocked or off-road vehicle has no override.</p>
      </ActionDialog>

      <ActionDialog
        open={cancelOpen}
        title={`Cancel shift on ${shift.vehicleCallsign}`}
        confirmLabel="Cancel shift"
        reasonLabel="Reason"
        danger
        onCancel={() => setCancelOpen(false)}
        onConfirm={(reason) => api.send('POST', `${base}/cancel`, orgId, { reason })}
      >
        <p>
          The crew are stood down and told. {jobs.length} job{jobs.length === 1 ? '' : 's'} on this
          shift go{jobs.length === 1 ? 'es' : ''} back to the planner for a new crew.
        </p>
      </ActionDialog>
    </Section>
  );
}
