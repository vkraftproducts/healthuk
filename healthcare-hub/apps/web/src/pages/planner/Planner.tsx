import { StatusBadge, type StatusKind } from '@hub/ui';
import { addDays, formatDate, londonDate, londonDateTime, londonTime } from '@hub/rules';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import {
  Field,
  Section,
  button,
  errText,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const IN_PROGRESS = [
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
  'HANDOVER_COMPLETE',
];
const UNAVAILABLE = ['BLOCKED', 'QUARANTINED', 'OFF_ROAD'];
const CHECK_STATUS: Record<string, StatusKind> = { PASS: 'GREEN', FAIL: 'RED', PENDING: 'AMBER' };
const CHECK_WORD: Record<string, string> = { PASS: 'Pass', FAIL: 'Fail', PENDING: 'Pending' };
const CHECK_LABEL: Record<string, string> = {
  STAFF_CLEARANCE: 'Staff clearance',
  LICENCE: 'Driving licence',
  COMPETENCE: 'Competence',
  VEHICLE_ROADWORTHY: 'Vehicle roadworthy',
  VEHICLE_SUITABILITY: 'Vehicle suitable for the patient',
  EQUIPMENT: 'Equipment',
  TIME_CONFLICT: 'Time conflict',
  SHIFT_GATE: 'Shift gate (VDI and cleaning)',
};

const jobWord = (state: string) =>
  IN_PROGRESS.includes(state) ? 'in progress' : words(state).toLowerCase();
const span = (a: string, b: string) => `${londonTime(new Date(a))}–${londonTime(new Date(b))}`;

/** Work planner (wireframe 04, JOB-02/03): the server decides; the screen explains. */
export function Planner() {
  const { me, orgId } = useApp();
  const can = useCan();
  const canView = me.permissions.includes('jobs.job.view');
  const [date, setDate] = useState(() => londonDate(new Date()));
  const [locationId, setLocationId] = useState('');
  const [view, setView] = useState<'day' | 'week'>('day');
  const [jobId, setJobId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const planner = useOne<{ date: string; shifts: Row[]; unallocated: Row[] }>(
    canView ? `/api/v1/planner?date=${date}${locationId ? `&locationId=${locationId}` : ''}` : null,
  );
  const shifts = planner.data?.shifts ?? [];
  const unallocated = planner.data?.unallocated ?? [];
  const job = unallocated.find((j) => j.id === jobId) ?? null;
  const shift = shifts.find((s) => s.id === shiftId) ?? null;

  // Hour columns span the day's shifts (06:00–22:00 when there are none).
  const hours = shifts.flatMap((s) => [
    Number(londonTime(new Date(s.startsAt)).slice(0, 2)),
    Number(londonTime(new Date(s.endsAt)).slice(0, 2)) + 1,
  ]);
  const first = Math.min(6, ...hours);
  const last = Math.min(24, Math.max(22, ...hours));
  const dayStart = londonDateTime(date, `${String(first).padStart(2, '0')}:00`).getTime();
  const width = (last - first) * 3_600_000;
  const pos = (from: string, to: string) => {
    const l = Math.max(0, (new Date(from).getTime() - dayStart) / width);
    const r = Math.min(1, (new Date(to).getTime() - dayStart) / width);
    return { left: `${l * 100}%`, width: `${Math.max(0.02, r - l) * 100}%` };
  };

  const choose = (sid: string) => setShiftId(sid);
  const onDrop = (e: DragEvent, sid: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (id) {
      setJobId(id);
      choose(sid);
    }
  };

  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  if (!canView) return <p role="alert">You do not have permission to view the work planner.</p>;
  return (
    <div className="space-y-6">
      {can('allocation.exception.approve') && <ExceptionRequests />}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Work planner</h1>
          <p className="text-slate-700">
            Allocate journeys to vehicles and crews. Every assignment is checked by the server
            before it is saved.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label="View" className="flex gap-1">
            {(['day', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`${smallButton} ${view === v ? '!bg-hub-navy !text-white' : ''}`}
              >
                {v === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                setJobId(null);
                setShiftId(null);
              }}
              className={input}
            />
          </Field>
          <Field label="Location">
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className={input}
            >
              <option value="">All locations</option>
              {(locations.data?.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      {view === 'week' ? (
        <WeekView
          from={date}
          locationId={locationId}
          onPick={(d) => {
            setDate(d);
            setView('day');
          }}
        />
      ) : planner.isError ? (
        <div role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
          <strong>Source unavailable.</strong> The planner could not be loaded.
        </div>
      ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          <section
            aria-labelledby="grid-h"
            aria-busy={planner.isLoading}
            className="rounded-lg border border-hub-line bg-white p-4 xl:col-span-2"
          >
            <h2 id="grid-h" className="mb-2 text-lg font-bold">
              Vehicles and crews
            </h2>
            {!planner.isLoading && shifts.length === 0 && (
              <p role="status">No shifts planned for this day.</p>
            )}
            {shifts.length > 0 && (
              <div className="ml-[14.75rem] flex text-xs text-slate-700" aria-hidden="true">
                {Array.from({ length: last - first }, (_, i) => (
                  <span key={i} className="flex-1 border-l border-hub-line pl-0.5">
                    {String(first + i).padStart(2, '0')}
                  </span>
                ))}
              </div>
            )}
            <ul className="space-y-2">
              {shifts.map((s) => {
                const blocked = UNAVAILABLE.includes(s.vehicleStatus);
                const crew = (s.crew as Row[]).filter((c) => c.active);
                const label = `${s.vehicleCallsign} / ${crew.map((c) => c.displayName).join(' + ') || 'no crew'}`;
                return (
                  <li
                    key={s.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => onDrop(e, s.id)}
                    className={`flex items-stretch gap-2 rounded border p-1 ${shiftId === s.id ? 'border-hub-teal ring-2 ring-hub-teal' : 'border-slate-200'}`}
                  >
                    <div className="w-56 shrink-0 text-sm">
                      <div className="font-semibold">{label}</div>
                      <div className="text-slate-700">
                        {span(s.startsAt, s.endsAt)} · {words(s.state)}
                      </div>
                      {job && can('jobs.allocate') && (
                        <button
                          className={`${smallButton} mt-1`}
                          aria-label={`Check ${job.code} on ${s.vehicleCallsign}`}
                          onClick={() => choose(s.id)}
                        >
                          Assign here
                        </button>
                      )}
                    </div>
                    <div
                      className={`relative min-h-12 flex-1 rounded ${blocked ? 'bg-[repeating-linear-gradient(45deg,#fee2e2,#fee2e2_6px,#fff_6px,#fff_12px)]' : 'bg-slate-50'}`}
                    >
                      <div
                        className="absolute inset-y-0 rounded bg-green-50"
                        style={pos(s.startsAt, s.endsAt)}
                        aria-hidden="true"
                      />
                      {blocked && (
                        <span className="absolute top-1 right-1 rounded bg-white px-1 text-sm font-semibold text-red-900">
                          BLOCKED – {words(s.vehicleStatus)}
                        </span>
                      )}
                      {(s.jobs as Row[]).map((j) => (
                        <span
                          key={j.jobId}
                          className="absolute top-5 truncate rounded border border-slate-500 bg-white px-1 text-xs"
                          style={pos(j.startsAt, j.endsAt)}
                          title={`${j.code} ${jobWord(j.state)} ${span(j.startsAt, j.endsAt)}`}
                        >
                          {j.code} {jobWord(j.state)}
                        </span>
                      ))}
                      <ul className="sr-only">
                        {(s.jobs as Row[]).map((j) => (
                          <li key={j.jobId}>
                            {j.code} {jobWord(j.state)} {span(j.startsAt, j.endsAt)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-sm text-slate-700">
              Drag an unallocated job onto a row, or select the job and choose “Assign here”.
            </p>
          </section>

          <div className="space-y-6">
            <section
              aria-labelledby="unalloc-h"
              className="rounded-lg border border-hub-line bg-white p-4"
            >
              <h2 id="unalloc-h" className="mb-2 text-lg font-bold">
                Unallocated jobs ({unallocated.length})
              </h2>
              {unallocated.length === 0 && <p>Every job for this day has a crew.</p>}
              <ul className="flex flex-wrap gap-2">
                {unallocated.map((j) => (
                  <li key={j.id}>
                    <button
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', j.id)}
                      aria-pressed={jobId === j.id}
                      onClick={() => {
                        setJobId(jobId === j.id ? null : j.id);
                        setShiftId(null);
                      }}
                      className={`rounded border px-2 py-1 text-sm ${jobId === j.id ? 'border-hub-navy bg-hub-navy text-white' : 'border-slate-500'}`}
                    >
                      {j.code} {londonTime(new Date(j.pickupFrom))} · {words(j.state)}
                    </button>
                  </li>
                ))}
              </ul>
              {job && <JobCard job={job} />}
            </section>
            {job && shift && (
              <ValidatePanel
                key={`${job.id}:${shift.id}`}
                job={job}
                shift={shift}
                onDone={() => {
                  setJobId(null);
                  setShiftId(null);
                }}
              />
            )}
          </div>
        </div>
      )}
      {can('jobs.booking.manage') && <BookJourney date={date} locations={locations.data?.data} />}
      {can('jobs.allocate') && <PlanShift date={date} locations={locations.data?.data} />}
    </div>
  );
}

/** Seven days from the chosen date: one row per vehicle, each cell its shift, jobs and blocks. */
function WeekView(p: { from: string; locationId: string; onPick: (d: string) => void }) {
  const { api, orgId } = useApp();
  const days = Array.from({ length: 7 }, (_, i) => addDays(p.from, i));
  const results = useQueries({
    queries: days.map((d) => {
      const path = `/api/v1/planner?date=${d}${p.locationId ? `&locationId=${p.locationId}` : ''}`;
      return {
        queryKey: ['one', orgId, path],
        queryFn: async () => (await api.get(path, orgId)) as { shifts: Row[]; unallocated: Row[] },
        enabled: !!orgId,
        retry: false,
      };
    }),
  });
  if (results.some((r) => r.isError))
    return (
      <div role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
        <strong>Source unavailable.</strong> The week could not be loaded.
      </div>
    );
  const loading = results.some((r) => r.isLoading);
  const vehicles = [
    ...new Set(results.flatMap((r) => (r.data?.shifts ?? []).map((s) => s.vehicleCallsign))),
  ].sort();
  return (
    <section aria-labelledby="week-h" aria-busy={loading} className="overflow-x-auto">
      <h2 id="week-h" className="mb-2 text-lg font-bold">
        Week from {formatDate(p.from)}
      </h2>
      <table className="w-full border-collapse bg-white text-sm">
        <caption className="sr-only">Shifts and jobs by vehicle and day</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="border border-hub-line bg-hub-navy p-1.5 text-left text-white"
            >
              Vehicle
            </th>
            {days.map((d, i) => (
              <th
                key={d}
                scope="col"
                className="border border-hub-line bg-hub-navy p-1.5 text-left text-white"
              >
                <button className="text-white underline" onClick={() => p.onPick(d)}>
                  {formatDate(d)}
                </button>
                <div className="font-normal text-slate-200">
                  {results[i]?.data?.unallocated.length ?? '…'} unallocated
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {vehicles.length === 0 && !loading && (
            <tr>
              <td colSpan={8} className="p-2">
                No shifts planned this week.
              </td>
            </tr>
          )}
          {vehicles.map((v) => (
            <tr key={v}>
              <th
                scope="row"
                className="border border-hub-line bg-hub-row p-1.5 text-left text-hub-navy"
              >
                {v}
              </th>
              {days.map((d, i) => {
                const ss = (results[i]?.data?.shifts ?? []).filter((s) => s.vehicleCallsign === v);
                return (
                  <td key={d} className="border border-hub-line bg-white p-1 align-top">
                    {ss.length === 0
                      ? '—'
                      : ss.map((s) => (
                          <div key={s.id}>
                            {span(s.startsAt, s.endsAt)} · {(s.jobs as Row[]).length} jobs
                            {UNAVAILABLE.includes(s.vehicleStatus) && (
                              <div className="font-semibold text-red-900">
                                BLOCKED – {words(s.vehicleStatus)}
                              </div>
                            )}
                          </div>
                        ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function JobCard({ job }: { job: Row }) {
  const yes = (b: boolean) => (b ? 'Yes' : 'No');
  return (
    <dl
      aria-label={`Job ${job.code}`}
      className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-slate-200 pt-3 text-sm"
    >
      <dt className="font-semibold">Pickup window</dt>
      <dd>{span(job.pickupFrom, job.pickupTo)}</dd>
      <dt className="font-semibold">Journey</dt>
      <dd>
        {job.pickupAddress} → {job.destinationAddress}
      </dd>
      <dt className="font-semibold">Mobility</dt>
      <dd>
        {words(job.mobility)}
        {job.stairs ? ', stairs' : ''}
        {job.infectionPrecautions ? ', infection precautions' : ''}
      </dd>
      <dt className="font-semibold">Escorts</dt>
      <dd>{job.escorts}</dd>
      <dt className="font-semibold">Crew needs</dt>
      <dd>
        {job.crewSize} crew
        {job.requiredSkills.length ? ` · ${job.requiredSkills.map(words).join(', ')}` : ''}
      </dd>
      <dt className="font-semibold">Access plan reviewed</dt>
      <dd>{yes(job.accessPlanReviewed)}</dd>
      <dt className="font-semibold">Required equipment</dt>
      <dd>{job.requiredEquipment.length ? job.requiredEquipment.map(words).join(', ') : 'None'}</dd>
    </dl>
  );
}

function ValidatePanel({ job, shift, onDone }: { job: Row; shift: Row; onDone: () => void }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const v = useValidation(job.id, shift.id);
  const [excepting, setExcepting] = useState<string | null>(null);
  const checks = (v.data?.checks ?? []) as Row[];
  const failing = checks.some((c) => c.result === 'FAIL' && !c.excepted);
  const allowed = !!v.data?.allowed && !failing;
  const crew = (shift.crew as Row[]).filter((c) => c.active);

  async function allocate() {
    const ok = await run(async () => {
      await api.send('POST', `/api/v1/jobs/${job.id}/allocate`, orgId, { shiftId: shift.id });
      await api.send('POST', `/api/v1/jobs/${job.id}/offer`, orgId, {});
    }, `${job.code} allocated to ${shift.vehicleCallsign}; the crew has been notified.`);
    if (ok) onDone();
    else void v.reload();
  }

  return (
    <section aria-labelledby="val-h" className="rounded-lg border border-hub-line bg-white p-4">
      <h2 id="val-h" className="text-lg font-bold">
        Validate assignment
      </h2>
      <p className="text-sm text-slate-700">
        {job.code} on {shift.vehicleCallsign} with{' '}
        {crew.map((c) => `${c.displayName} (${words(c.role)})`).join(', ') || 'no crew'}
      </p>
      {v.error && (
        <p role="alert" className="mt-2 text-red-900">
          {v.error}
        </p>
      )}
      {v.loading && <p role="status">Checking…</p>}
      <ul className="mt-2 space-y-2" aria-label="Checks">
        {checks.map((c) => (
          <li key={c.code} className="text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{CHECK_LABEL[c.code] ?? words(c.code)}</span>
              <StatusBadge
                status={c.excepted ? 'AMBER' : CHECK_STATUS[c.result]!}
                reason={c.excepted ? 'Exception approved' : CHECK_WORD[c.result]}
              />
            </div>
            {c.result !== 'PASS' && <p className="text-slate-800">{c.reasonText}</p>}
            {(c.details as string[]).length > 0 && c.result !== 'PASS' && (
              <ul className="ml-4 list-disc text-slate-700">
                {(c.details as string[]).map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
            {c.result === 'FAIL' && !c.excepted && !c.overridable && (
              <p className="text-slate-700">
                Safety or statutory check: this cannot be overridden. Choose another vehicle or
                crew.
              </p>
            )}
            {c.result === 'FAIL' && !c.excepted && c.overridable && can('jobs.allocate') && (
              <button className={`${smallButton} mt-1`} onClick={() => setExcepting(c.code)}>
                Request exception
              </button>
            )}
            {excepting === c.code && (
              <ExceptionForm
                jobId={job.id}
                shiftId={shift.id}
                checkCode={c.code}
                onClose={() => {
                  setExcepting(null);
                  void v.reload();
                }}
              />
            )}
          </li>
        ))}
      </ul>
      <button
        className={`${button} mt-3`}
        disabled={!allowed || v.loading}
        aria-describedby={!allowed ? 'alloc-why' : undefined}
        onClick={() => void allocate()}
      >
        Allocate and notify crew
      </button>
      {!allowed && !v.loading && (
        <p id="alloc-why" className="mt-1 text-sm text-slate-700">
          Unavailable until every failed check is resolved.
        </p>
      )}
      <div className="mt-2">{msg}</div>
    </section>
  );
}

function useValidation(jobId: string, shiftId: string) {
  const { api, orgId } = useApp();
  const [state, setState] = useState<{ data: Row | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = (await api.send('POST', `/api/v1/jobs/${jobId}/validate`, orgId, {
        shiftId,
      })) as Row;
      setState({ data, loading: false, error: null });
    } catch (e) {
      setState({ data: null, loading: false, error: errText(e) });
    }
  }, [api, orgId, jobId, shiftId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

/** E3: requests addressed to me, approved or declined with a reason (no browser pop-ups). */
function ExceptionRequests() {
  const { api, orgId, me } = useApp();
  const res = useOne<{ data: Row[] }>('/api/v1/allocation-exceptions');
  const { run, msg } = useRun();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const waiting = (res.data?.data ?? []).filter(
    (r) => r.state === 'REQUESTED' && r.approverId === me.user.id,
  );
  if (waiting.length === 0) return null;
  const decide = (r: Row, decision: 'APPROVED' | 'DECLINED') => {
    const reason = (reasons[r.id] ?? '').trim();
    void run(
      () =>
        api.send('POST', `/api/v1/allocation-exceptions/${r.id}/decide`, orgId, {
          decision,
          reason,
        }),
      decision === 'APPROVED'
        ? `Exception approved for ${r.jobCode}. It can now be allocated.`
        : `Declined. ${r.requestedByName} has been told why.`,
    );
  };
  return (
    <section
      aria-labelledby="exc-req-h"
      className="space-y-3 rounded-lg border border-amber-600 bg-amber-50 p-4"
    >
      <h2 id="exc-req-h" className="text-lg font-bold">
        Exception requests waiting for you
      </h2>
      {msg}
      <ul className="space-y-3">
        {waiting.map((r) => (
          <li
            key={r.id}
            className="space-y-2 rounded-md border border-hub-line bg-white p-3 text-sm"
          >
            <p>
              <b>{r.jobCode}</b> · {words(r.checkCode)} · asked by {r.requestedByName} · until{' '}
              {formatDate(londonDate(new Date(r.expiresAt)))}
            </p>
            <p className="text-slate-700">“{r.reason}”</p>
            <label className="block">
              <span className="text-slate-700">Reason for your decision</span>
              <input
                className={input}
                value={reasons[r.id] ?? ''}
                minLength={3}
                maxLength={1000}
                onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <button
                className={button}
                disabled={(reasons[r.id] ?? '').trim().length < 3}
                aria-label={`Approve ${r.jobCode}`}
                onClick={() => decide(r, 'APPROVED')}
              >
                Approve
              </button>
              <button
                className={smallButton}
                disabled={(reasons[r.id] ?? '').trim().length < 3}
                aria-label={`Decline ${r.jobCode}`}
                onClick={() => decide(r, 'DECLINED')}
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** E3: asks a named approver; nothing is excepted until that person approves. */
function ExceptionForm(p: {
  jobId: string;
  shiftId: string;
  checkCode: string;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const approvers = useOne<{ data: { id: string; name: string }[] }>(
    '/api/v1/allocation-exceptions/approvers',
  );
  const max = londonDate(new Date(Date.now() + 7 * 86_400_000));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const approverId = String(f.get('approver'));
    const name = approvers.data?.data.find((x) => x.id === approverId)?.name ?? 'the approver';
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/allocation-exceptions', orgId, {
          jobId: p.jobId,
          shiftId: p.shiftId,
          checkCode: p.checkCode,
          approverId,
          reason: String(f.get('reason')),
          expiresAt: londonDateTime(String(f.get('until')), '23:59').toISOString(),
        }),
      `Request sent to ${name}. Allocation stays unavailable until they approve.`,
    );
    if (ok) p.onClose();
  }
  const people = approvers.data?.data ?? [];
  return (
    <form
      onSubmit={submit}
      className="mt-2 space-y-2 rounded-lg border border-hub-line bg-white p-2"
    >
      <Field label="Ask">
        <select name="approver" required defaultValue="" className={input}>
          <option value="" disabled>
            {approvers.isLoading
              ? 'Loading…'
              : people.length
                ? 'Choose an approver'
                : 'Nobody can approve'}
          </option>
          {people.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reason (recorded in the audit trail)">
        <textarea name="reason" required minLength={10} maxLength={1000} className={input} />
      </Field>
      <Field label="Valid until (at most 7 days)">
        <input
          name="until"
          type="date"
          required
          min={londonDate(new Date())}
          max={max}
          defaultValue={londonDate(new Date())}
          className={input}
        />
      </Field>
      <div className="flex gap-2">
        <button className={button}>Send request</button>
        <button type="button" className={smallButton} onClick={p.onClose}>
          Cancel
        </button>
      </div>
      {msg}
    </form>
  );
}

function BookJourney({ date, locations }: { date: string; locations?: Row[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const at = (name: string) => londonDateTime(String(f.get('date')), String(f.get(name)));
    const from = at('from');
    const minutes = Number(f.get('duration') || 60);
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/bookings', orgId, {
          customer: String(f.get('customer')),
          job: {
            locationId: String(f.get('location')),
            pickupFrom: from.toISOString(),
            pickupTo: at('to').toISOString(),
            plannedStart: from.toISOString(),
            plannedEnd: new Date(from.getTime() + minutes * 60_000).toISOString(),
            pickupAddress: String(f.get('pickup')),
            destinationAddress: String(f.get('destination')),
            patientRef: String(f.get('ref')),
            mobility: String(f.get('mobility')),
            crewSize: Number(f.get('crew') || 2),
            accessPlanReviewed: f.get('access') === 'on',
          },
        }),
      'Journey booked. It is now waiting for allocation.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="Book a journey">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Customer">
          <input name="customer" required minLength={2} className={input} />
        </Field>
        <Field label="Booking reference (not a name)">
          <input name="ref" required pattern="[A-Za-z0-9\-]{2,30}" className={input} />
        </Field>
        <Field label="Location">
          <select name="location" required className={input}>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Journey date">
          <input name="date" type="date" required defaultValue={date} className={input} />
        </Field>
        <Field label="Pickup from">
          <input name="from" type="time" required className={input} />
        </Field>
        <Field label="Pickup by">
          <input name="to" type="time" required className={input} />
        </Field>
        <Field label="Minutes">
          <input
            name="duration"
            type="number"
            min={10}
            max={720}
            defaultValue={60}
            className={`${input} w-20`}
          />
        </Field>
        <Field label="Pickup address">
          <input name="pickup" required minLength={3} className={input} />
        </Field>
        <Field label="Destination">
          <input name="destination" required minLength={3} className={input} />
        </Field>
        <Field label="Mobility">
          <select name="mobility" className={input}>
            {['WALKING', 'WHEELCHAIR', 'CARRY_CHAIR', 'STRETCHER'].map((m) => (
              <option key={m} value={m}>
                {words(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Crew">
          <input
            name="crew"
            type="number"
            min={1}
            max={4}
            defaultValue={2}
            className={`${input} w-16`}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="access" /> Access plan reviewed
        </label>
        <button className={button}>Book</button>
      </form>
      {msg}
    </Section>
  );
}

function PlanShift({ date, locations }: { date: string; locations?: Row[] }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?lifecycle=ACTIVE');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const day = String(f.get('date'));
    const crew = [
      { staffId: String(f.get('driver')), role: 'DRIVER' },
      ...(f.get('second')
        ? [{ staffId: String(f.get('second')), role: String(f.get('secondRole')) }]
        : []),
    ];
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/shifts', orgId, {
          locationId: String(f.get('location')),
          vehicleId: String(f.get('vehicle')),
          startsAt: londonDateTime(day, String(f.get('start'))).toISOString(),
          endsAt: londonDateTime(day, String(f.get('end'))).toISOString(),
          crew,
        }),
      'Shift planned.',
    );
    if (ok) form.reset();
  }
  const people = staff.data?.data ?? [];
  return (
    <Section title="Plan a shift">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <Field label="Location">
          <select name="location" required className={input}>
            {(locations ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Vehicle">
          <select name="vehicle" required className={input}>
            {(vehicles.data?.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.callsign}
                {v.status !== 'AVAILABLE' ? ` (${words(v.status)})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Shift date">
          <input name="date" type="date" required defaultValue={date} className={input} />
        </Field>
        <Field label="Start">
          <input name="start" type="time" required defaultValue="07:00" className={input} />
        </Field>
        <Field label="End">
          <input name="end" type="time" required defaultValue="19:00" className={input} />
        </Field>
        <Field label="Driver">
          <select name="driver" required className={input}>
            {people
              .filter((p) => (p.roles as string[]).includes('DRIVER'))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.staffNo})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Second crew member">
          <select name="second" className={input}>
            <option value="">None</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.staffNo})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Second crew role">
          <select name="secondRole" className={input}>
            {['CARE_ASSISTANT', 'EMERGENCY_CARE_ASSISTANT', 'TECHNICIAN', 'PARAMEDIC'].map((r) => (
              <option key={r} value={r}>
                {words(r)}
              </option>
            ))}
          </select>
        </Field>
        <button className={button}>Plan shift</button>
      </form>
      {msg}
    </Section>
  );
}
