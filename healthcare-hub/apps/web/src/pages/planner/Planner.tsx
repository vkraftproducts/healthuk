import { StatusBadge, type StatusKind } from '@hub/ui';
import { addDays, formatDate, londonDate, londonDateTime, londonTime } from '@hub/rules';
import { useQueries } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space } from 'antd';
import {
  useCallback,
  useEffect,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  ActionDialog,
  Field,
  Section,
  Tabs,
  errText,
  fmtDate,
  fmtDateTime,
  useCan,
  useRun,
  words,
  PageHeader,
} from '../../components.js';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useApp } from '../../shell/AppContext.js';
import { NhsContracts } from '../compliance/Regulatory.js';
import { useOne } from '../settings/hooks.js';
import { CrewReadiness } from './CrewReadiness.js';
import { ShiftActions } from './ShiftActions.js';
import { BusinessContinuity } from '../registers/GovernanceRecords.js';
import { Ms } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const IN_PROGRESS = [
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
  'HANDOVER_COMPLETE',
];
const UNAVAILABLE = ['BLOCKED', 'QUARANTINED', 'OFF_ROAD'];
const VEHICLE_WORD: Record<string, string> = {
  BLOCKED: 'blocked',
  QUARANTINED: 'quarantined',
  OFF_ROAD: 'off road',
};
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
function PlannerDay({ nav }: { nav?: ReactNode }) {
  const [dialog, setDialog] = useState<'shift' | 'journey' | null>(null);
  const { me, orgId } = useApp();
  const can = useCan();
  const canView = me.permissions.includes('jobs.job.view');
  const [date, setDate] = useState(() => londonDate(new Date()));
  const [locationId, setLocationId] = useState('');
  const [view, setView] = useState<'day' | 'week'>('day');
  const [jobId, setJobId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);
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
  const managed = shifts.find((s) => s.id === manageId) ?? null;

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

  if (!orgId)
    return (
      <Alert type="info" showIcon role="status" message="Select an organisation to continue." />
    );
  if (!canView)
    return (
      <Alert
        type="warning"
        showIcon
        role="alert"
        message="You do not have permission to view the work planner."
      />
    );
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader
          title="Work planner"
          description="Allocate journeys to vehicles and crews. Every assignment is checked by the server before it is saved."
          extra={
            <Space wrap>
              {can('jobs.allocate') && (
                <Button onClick={() => setDialog('shift')}>
                  <Ms i="event_available" /> Plan a shift
                </Button>
              )}
              {can('jobs.booking.manage') && (
                <Button type="primary" onClick={() => setDialog('journey')}>
                  <Ms i="add" /> Book a journey
                </Button>
              )}
            </Space>
          }
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="wf-seg2" role="group" aria-label="View">
            {(['day', 'week'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? 'on' : ''}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                <Ms i={v === 'day' ? 'view_day' : 'view_week'} />
                {v === 'day' ? 'Day' : 'Week'}
              </button>
            ))}
          </div>
          <Field label="Date">
            <Input
              type="date"
              value={date}
              onChange={(e) => {
                if (e.target.value) setDate(e.target.value);
                setJobId(null);
                setShiftId(null);
                setManageId(null);
              }}
            />
          </Field>
          <Field label="Location">
            <Select
              value={locationId || undefined}
              allowClear
              placeholder="All locations"
              onChange={(v) => setLocationId(v ?? '')}
              style={{ minWidth: 160 }}
              options={(locations.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))}
            />
          </Field>
        </div>
      </div>
      {nav}

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
        <div className="wf-stack">
          <section
            aria-labelledby="grid-h"
            aria-busy={planner.isLoading}
            className="wf-card ant-card ant-card-bordered"
          >
            <div className="wf-ch ant-card-head">
              <div className="ant-card-head-wrapper">
                <div className="ant-card-head-title">
                  <h2 id="grid-h">Timeline – {fmtDate(date)}</h2>
                </div>
                <div className="ant-card-extra">
                  <span className="wf-mini">Drag a journey onto a vehicle’s row to assign it</span>
                </div>
              </div>
            </div>
            <div className="ant-card-body">
              {!planner.isLoading && shifts.length === 0 && (
                <p role="status">No shifts planned for this day.</p>
              )}
              {shifts.length > 0 && (
                <div className="pl">
                  <div className="pl-h" aria-hidden="true">
                    <div className="pl-v" />
                    <div className="pl-track">
                      {Array.from({ length: Math.floor((last - first) / 2) + 1 }, (_, i) => (
                        <span key={i} style={{ left: `${((i * 2) / (last - first)) * 100}%` }}>
                          {String(first + i * 2).padStart(2, '0')}:00
                        </span>
                      ))}
                    </div>
                  </div>
                  {shifts.map((s) => {
                    const blocked = UNAVAILABLE.includes(s.vehicleStatus) || !!s.vehicleBlockReason;
                    const blockLabel = s.vehicleBlockReason
                      ? s.vehicleBlockReason
                      : words(s.vehicleStatus);
                    const crew = (s.crew as Row[]).filter((c) => c.active);
                    const crewText = crew.map((c) => c.displayName).join(' + ') || 'No crew';
                    return (
                      <div
                        key={s.id}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => onDrop(e, s.id)}
                        className={`pl-row${blocked ? ' blocked' : ''}${shiftId === s.id ? ' on' : ''}`}
                      >
                        <div className="pl-v">
                          <Ms i="ambulance" />
                          <div>
                            <b>{s.vehicleCallsign}</b>
                            <small>
                              {blocked ? (
                                <span style={{ color: 'var(--rd)' }}>Blocked – {blockLabel}</span>
                              ) : (
                                `${crewText} · ${span(s.startsAt, s.endsAt)}`
                              )}
                            </small>
                            <span className="pl-act">
                              {job && can('jobs.allocate') && (
                                <Button
                                  size="small"
                                  aria-label={`Check ${job.code} on ${s.vehicleCallsign}`}
                                  onClick={() => choose(s.id)}
                                >
                                  Assign here
                                </Button>
                              )}
                              {can('jobs.allocate') && ['PLANNED', 'STARTED'].includes(s.state) && (
                                <Button
                                  size="small"
                                  type="text"
                                  aria-label={`Manage shift for ${s.vehicleCallsign}`}
                                  aria-pressed={manageId === s.id}
                                  onClick={() => setManageId(manageId === s.id ? null : s.id)}
                                >
                                  <Ms i="more_horiz" />
                                </Button>
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="pl-track">
                          <i
                            className="pl-shift"
                            style={pos(s.startsAt, s.endsAt)}
                            aria-hidden="true"
                          />
                          {(s.jobs as Row[]).map((j) => (
                            <span
                              key={j.jobId}
                              className={`pl-job${blocked ? ' bad' : ''}`}
                              style={pos(j.startsAt, j.endsAt)}
                              title={`${j.code} ${jobWord(j.state)} ${span(j.startsAt, j.endsAt)} · ${crewText}`}
                            >
                              <b>{j.code}</b>
                              <small>
                                {londonTime(new Date(j.startsAt))} · {jobWord(j.state)}
                              </small>
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
                      </div>
                    );
                  })}
                </div>
              )}
              {managed && (
                <div className="mt-4 border-t pt-4">
                  <ShiftActions
                    shift={managed}
                    otherShifts={shifts}
                    onClose={() => setManageId(null)}
                  />
                </div>
              )}
            </div>
          </section>

          <div className="wf-stack">
            <section aria-labelledby="unalloc-h" className="wf-card ant-card ant-card-bordered">
              <div className="wf-ch ant-card-head">
                <div className="ant-card-head-wrapper">
                  <div className="ant-card-head-title">
                    <h2 id="unalloc-h">Needs a vehicle ({unallocated.length})</h2>
                  </div>
                  <div className="ant-card-extra">
                    <span className="wf-mini">
                      Select a journey, then “Assign here” on a vehicle
                    </span>
                  </div>
                </div>
              </div>
              <div className="ant-card-body">
                {unallocated.length === 0 && <p>Every job for this day has a crew.</p>}
                <ul className="flex flex-wrap gap-2">
                  {unallocated.map((j) => (
                    <li key={j.id}>
                      <Button
                        draggable
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', j.id)}
                        aria-pressed={jobId === j.id}
                        onClick={() => {
                          setJobId(jobId === j.id ? null : j.id);
                          setShiftId(null);
                        }}
                        className={`rounded border px-2 py-1 text-sm ${jobId === j.id ? 'var(--ant-color-primary) var(--ant-color-primary) text-white' : 'border-slate-500'}`}
                      >
                        {j.code} {londonTime(new Date(j.pickupFrom))} · {words(j.state)}
                      </Button>
                    </li>
                  ))}
                </ul>
                {job && <JobCard job={job} />}
              </div>
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
                onManage={setManageId}
              />
            )}
          </div>
        </div>
      )}
      {can('allocation.exception.approve') && <ExceptionRequests />}
      <Modal
        open={dialog !== null}
        title={dialog === 'shift' ? 'Plan a shift' : 'Book a journey'}
        onCancel={() => setDialog(null)}
        footer={null}
        width={860}
        className="hh-modal"
        destroyOnHidden
      >
        {dialog === 'journey' && can('jobs.booking.manage') && (
          <BookJourney date={date} locations={locations.data?.data} />
        )}
        {dialog === 'shift' && can('jobs.allocate') && (
          <PlanShift date={date} locations={locations.data?.data} />
        )}
      </Modal>
    </Space>
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
      <table className="w-full border-collapse var(--ant-color-bg-container) text-sm">
        <caption className="sr-only">Shifts and jobs by vehicle and day</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="border var(--ant-color-border) var(--ant-color-primary) p-1.5 text-left text-white"
            >
              Vehicle
            </th>
            {days.map((d, i) => (
              <th
                key={d}
                scope="col"
                className="border var(--ant-color-border) var(--ant-color-primary) p-1.5 text-left text-white"
              >
                <Button className="text-white underline" onClick={() => p.onPick(d)}>
                  {formatDate(d)}
                </Button>
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
                className="border var(--ant-color-border) bg-hub-row p-1.5 text-left text-hub-ink"
              >
                {v}
              </th>
              {days.map((d, i) => {
                const ss = (results[i]?.data?.shifts ?? []).filter((s) => s.vehicleCallsign === v);
                return (
                  <td
                    key={d}
                    className="border var(--ant-color-border) var(--ant-color-bg-container) p-1 align-top"
                  >
                    {ss.length === 0
                      ? '—'
                      : ss.map((s) => (
                          <div key={s.id}>
                            {span(s.startsAt, s.endsAt)} · {(s.jobs as Row[]).length} jobs
                            {(UNAVAILABLE.includes(s.vehicleStatus) || s.vehicleBlockReason) && (
                              <div className="font-semibold text-red-900">
                                BLOCKED – {s.vehicleBlockReason ?? words(s.vehicleStatus)}
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
      className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t var(--ant-color-border) pt-3 text-sm"
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

function ValidatePanel({
  job,
  shift,
  onDone,
  onManage,
}: {
  job: Row;
  shift: Row;
  onDone: () => void;
  onManage: (shiftId: string) => void;
}) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const v = useValidation(job.id, shift.id);
  const [excepting, setExcepting] = useState<string | null>(null);
  const approver = can('allocation.exception.approve');
  const requests = useOne<{ data: Row[] }>(`/api/v1/allocation-exception-requests?jobId=${job.id}`);
  const latest = (code: string) =>
    (requests.data?.data ?? []).find((r) => r.checkCode === code && r.shiftId === shift.id);
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
    <section
      aria-labelledby="val-h"
      className="rounded-lg border var(--ant-color-border) var(--ant-color-bg-container) p-4"
    >
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
            {c.fix && c.fix.action !== 'EXCEPTION' && (
              <p className="mt-1 text-slate-800">
                How to fix: {c.fix.text}{' '}
                {c.fix.action === 'SHIFT_ACTIONS' ? (
                  <Button
                    type="link"
                    size="small"
                    aria-label={`Open shift ${shift.vehicleCallsign} to fix ${
                      CHECK_LABEL[c.code] ?? 'this check'
                    }`}
                    onClick={() => onManage(shift.id)}
                  >
                    Manage shift
                  </Button>
                ) : c.fix.action === 'VEHICLE' ? (
                  <a className="underline" href={`/vehicles/${shift.vehicleId}`}>
                    Open {shift.vehicleCallsign}
                  </a>
                ) : (
                  <a className="underline" href="/staff">
                    Open staff records
                  </a>
                )}
              </p>
            )}
            {c.result === 'FAIL' && !c.excepted && !c.overridable && (
              <p className="text-slate-700">
                Safety or statutory check: this cannot be overridden. Choose another vehicle or
                crew.
              </p>
            )}
            {c.result === 'FAIL' && !c.excepted && c.overridable && (
              <RequestState request={latest(c.code)} />
            )}
            {c.result === 'FAIL' &&
              !c.excepted &&
              c.overridable &&
              latest(c.code)?.status !== 'REQUESTED' &&
              (can('allocation.exception.approve') || can('jobs.allocate')) && (
                <Button
                  className={`mt-1`}
                  aria-label={`${approver ? 'Approve an exception' : 'Ask for an exception'} for ${
                    CHECK_LABEL[c.code] ?? 'this check'
                  }`}
                  onClick={() => setExcepting(c.code)}
                >
                  {approver ? 'Approve exception' : 'Ask for an exception'}
                </Button>
              )}
            {excepting === c.code && (
              <ExceptionForm
                jobId={job.id}
                shiftId={shift.id}
                checkCode={c.code}
                mode={approver ? 'approve' : 'request'}
                onClose={() => {
                  setExcepting(null);
                  void v.reload();
                  void requests.refetch();
                }}
              />
            )}
          </li>
        ))}
      </ul>
      <Button
        className={`mt-3`}
        disabled={!allowed || v.loading}
        aria-describedby={!allowed ? 'alloc-why' : undefined}
        onClick={() => void allocate()}
      >
        Allocate and notify crew
      </Button>
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

/**
 * Exception requests waiting for a decision (finding 69). Only policy-level checks can be asked
 * about; the person who asked can never decide their own request.
 */
function ExceptionRequests() {
  const { api, orgId, me } = useApp();
  const res = useOne<{ data: Row[] }>('/api/v1/allocation-exception-requests?status=REQUESTED');
  const [deciding, setDeciding] = useState<{ r: Row; d: 'APPROVED' | 'REJECTED' } | null>(null);
  const rows = res.data?.data ?? [];
  const name = (r: Row) =>
    `${r.jobCode} on ${r.vehicleCallsign ?? 'the shift'} (${CHECK_LABEL[r.checkCode] ?? 'check'})`;
  return (
    <Section title="Exceptions waiting for a decision">
      {res.isError && <p role="alert">Could not load exception requests.</p>}
      {!res.isLoading && rows.length === 0 && <p role="status">No exceptions are waiting.</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="rounded-lg border var(--ant-color-border) var(--ant-color-bg-container) p-3 text-sm"
          >
            <p className="font-semibold">{name(r)}</p>
            <p>
              Asked by {r.requestedByName ?? 'a dispatcher'} on {fmtDateTime(r.requestedAt)}, to
              last until {fmtDateTime(r.expiresAt)}.
            </p>
            <p className="text-slate-800">Reason: {r.reason}</p>
            {r.requestedBy === me.user.id ? (
              <p className="text-slate-700">You asked for this: someone else must decide.</p>
            ) : (
              <div className="mt-1 flex gap-2">
                <Button
                  type="link"
                  size="small"
                  aria-label={`Approve exception for ${name(r)}`}
                  onClick={() => setDeciding({ r, d: 'APPROVED' })}
                >
                  Approve
                </Button>
                <Button
                  type="link"
                  size="small"
                  aria-label={`Refuse exception for ${name(r)}`}
                  onClick={() => setDeciding({ r, d: 'REJECTED' })}
                >
                  Refuse
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ActionDialog
        open={deciding !== null}
        title={`${deciding?.d === 'APPROVED' ? 'Approve' : 'Refuse'} exception for ${
          deciding ? name(deciding.r) : ''
        }`}
        confirmLabel={deciding?.d === 'APPROVED' ? 'Approve exception' : 'Refuse exception'}
        danger={deciding?.d === 'REJECTED'}
        reasonLabel={
          deciding?.d === 'APPROVED' ? 'Note' : 'Why is it refused? The dispatcher sees this'
        }
        reasonRequired={deciding?.d === 'REJECTED'}
        onCancel={() => setDeciding(null)}
        onConfirm={(note) =>
          api.send(
            'POST',
            `/api/v1/allocation-exception-requests/${deciding!.r.id}/decide`,
            orgId,
            { decision: deciding!.d, ...(note ? { note } : {}) },
          )
        }
      >
        <p>
          {deciding?.d === 'APPROVED'
            ? 'The check is re-run first. You are recorded as the named approver; the exception ' +
              'ends on its expiry date.'
            : 'The job stays unallocated. Your name and reason are recorded.'}
        </p>
      </ActionDialog>
    </Section>
  );
}

/** Where an exception request stands, in words, with who asked and who decided. */
function RequestState({ request }: { request: Row | undefined }) {
  if (!request) return null;
  if (request.status === 'REQUESTED')
    return (
      <p role="status" className="mt-1 text-slate-800">
        <StatusBadge status="AMBER" reason="Exception asked for" />{' '}
        {request.requestedByName ?? 'A dispatcher'} asked on {fmtDateTime(request.requestedAt)}. A
        manager who did not ask must decide.
      </p>
    );
  if (request.status === 'REJECTED')
    return (
      <p className="mt-1 text-slate-800">
        <StatusBadge status="RED" reason="Exception refused" /> by{' '}
        {request.decidedByName ?? 'a manager'}
        {request.decisionNote ? `: ${request.decisionNote}` : ''}
      </p>
    );
  return null;
}

function ExceptionForm(p: {
  jobId: string;
  shiftId: string;
  checkCode: string;
  mode: 'approve' | 'request';
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const max = londonDate(new Date(Date.now() + 7 * 86_400_000));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(
      () =>
        api.send(
          'POST',
          p.mode === 'approve'
            ? '/api/v1/allocation-exceptions'
            : '/api/v1/allocation-exception-requests',
          orgId,
          {
            jobId: p.jobId,
            shiftId: p.shiftId,
            checkCode: p.checkCode,
            reason: String(f.get('reason')),
            expiresAt: londonDateTime(String(f.get('until')), '23:59').toISOString(),
          },
        ),
      p.mode === 'approve'
        ? 'Exception recorded with you as the named approver.'
        : 'Exception asked for. A manager decides; the job stays unallocated until then.',
    );
    if (ok) p.onClose();
  }
  return (
    <form
      onSubmit={submit}
      className="mt-2 space-y-2 rounded-lg border var(--ant-color-border) var(--ant-color-bg-container) p-2"
    >
      <Field label="Reason (recorded in the audit trail)">
        <textarea name="reason" required minLength={10} maxLength={1000} />
      </Field>
      <Field label="Valid until (at most 7 days)">
        <input
          name="until"
          type="date"
          required
          min={londonDate(new Date())}
          max={max}
          defaultValue={londonDate(new Date())}
        />
      </Field>
      <div className="flex gap-2">
        <Button htmlType="submit" type="primary">
          {p.mode === 'approve' ? 'Approve exception' : 'Send request'}
        </Button>
        <Button type="link" size="small" onClick={p.onClose}>
          Cancel
        </Button>
      </div>
      {msg}
    </form>
  );
}

const EQUIPMENT_NEEDS: Record<string, string> = {
  WHEELCHAIR_RAMP: 'Wheelchair ramp',
  CARRY_CHAIR: 'Carry chair',
  STRETCHER: 'Stretcher',
  OXYGEN: 'Oxygen',
  BARIATRIC_STRETCHER: 'Bariatric stretcher',
};
const SKILL_NEEDS: Record<string, string> = {
  BARIATRIC: 'Bariatric handling',
  MENTAL_HEALTH: 'Mental health transport',
  PAEDIATRIC: 'Children',
  END_OF_LIFE: 'End of life care',
};
const checked = (f: FormData, name: string) => f.getAll(name).map(String);

/**
 * Booking with the needs the planner checks against (finding 70). Patient contact details go
 * only into the protected contact record, never into the job, the URL or the audit trail.
 */
const MOBILITY_LABEL: Record<string, string> = {
  WALKING: 'Walking',
  WHEELCHAIR: 'Wheelchair (vehicle chair)',
  OWN_WHEELCHAIR: 'Own wheelchair',
  CARRY_CHAIR: 'Carry chair',
  STRETCHER: 'Stretcher',
  BARIATRIC: 'Bariatric',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function BookJourney({ date, locations }: { date: string; locations?: Row[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [repeat, setRepeat] = useState('');
  const [mobility, setMobility] = useState('WALKING');
  const [contract, setContract] = useState('');
  const [withReturn, setWithReturn] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const at = (name: string) => londonDateTime(text('date'), text(name));
    const from = at('from');
    const minutes = Number(f.get('duration') || 60);
    const contactName = text('contactName');
    const back = withReturn ? at('returnFrom') : null;
    let out: Row | null = null;
    setWarnings([]);
    const ok = await run(
      async () =>
        (out = (await api.send('POST', '/api/v1/bookings', orgId, {
          customer: text('customer'),
          ...(text('reference') ? { reference: text('reference') } : {}),
          ...(contract ? { contractType: contract } : {}),
          ...(contract === 'NHS'
            ? {
                nhsEligibility: {
                  met: f.get('nhsMet') === 'on',
                  criteria: text('nhsCriteria'),
                  assessedBy: text('nhsAssessedBy'),
                },
              }
            : {}),
          ...(back
            ? {
                returnJourney: {
                  pickupFrom: back.toISOString(),
                  pickupTo: at('returnTo').toISOString(),
                  plannedStart: back.toISOString(),
                  plannedEnd: new Date(back.getTime() + minutes * 60_000).toISOString(),
                },
              }
            : {}),
          ...(contactName
            ? {
                patientContact: {
                  name: contactName,
                  ...(text('contactPhone') ? { phone: text('contactPhone') } : {}),
                },
              }
            : {}),
          ...(repeat && text('until')
            ? {
                recurrence: {
                  freq: repeat,
                  interval: 1,
                  until: text('until'),
                  ...(repeat === 'WEEKLY' && f.getAll('weekday').length
                    ? { byWeekday: f.getAll('weekday').map(Number) }
                    : {}),
                },
              }
            : {}),
          job: {
            locationId: text('location'),
            pickupFrom: from.toISOString(),
            pickupTo: at('to').toISOString(),
            ...(text('appointment') ? { appointmentAt: at('appointment').toISOString() } : {}),
            plannedStart: from.toISOString(),
            plannedEnd: new Date(from.getTime() + minutes * 60_000).toISOString(),
            pickupAddress: text('pickup'),
            destinationAddress: text('destination'),
            ...(text('accessNotes') ? { accessNotes: text('accessNotes') } : {}),
            patientRef: text('ref'),
            mobility,
            ...(text('weight') ? { weightKg: Number(text('weight')) } : {}),
            stairs: f.get('stairs') === 'on',
            escorts: Number(f.get('escorts') || 0),
            infectionPrecautions: f.get('infection') === 'on',
            ...(text('comms') ? { commsNeeds: text('comms') } : {}),
            requiredEquipment: checked(f, 'equipment'),
            requiredSkills: checked(f, 'skills'),
            crewSize: Number(f.get('crew') || 2),
            accessPlanReviewed: f.get('access') === 'on',
            blueLights: f.get('blueLights') === 'on',
          },
        })) as Row),
      repeat
        ? 'Journeys booked for each date in the series. They are now waiting for allocation.'
        : 'Journey booked. It is now waiting for allocation.',
    );
    if (ok) {
      setWarnings(((out as Row | null)?.warnings as string[] | undefined) ?? []);
      form.reset();
      setRepeat('');
      setMobility('WALKING');
      setContract('');
      setWithReturn(false);
    }
  }
  const weightNeeded = mobility === 'STRETCHER' || mobility === 'BARIATRIC';
  return (
    <Section title="Book a journey">
      <form onSubmit={submit} className="hh-form" aria-label="Book a journey">
        <fieldset>
          <legend>Journey</legend>
          <div className="hh-grid">
            <Field label="Journey date">
              <input name="date" type="date" required defaultValue={date} />
            </Field>
            <Field label="Pickup from">
              <input name="from" type="time" required />
            </Field>
            <Field label="Pickup by">
              <input name="to" type="time" required />
            </Field>
            <Field label="Minutes">
              <input name="duration" type="number" min={10} max={720} defaultValue={60} />
            </Field>
            <Field label="Mobility">
              <select
                name="mobility"
                value={mobility}
                onChange={(e) => setMobility(e.target.value)}
              >
                {Object.entries(MOBILITY_LABEL).map(([m, label]) => (
                  <option key={m} value={m}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Crew">
              <input name="crew" type="number" min={1} max={4} defaultValue={2} />
            </Field>
            {weightNeeded && (
              <Field label="Patient weight in kg (checked against stretcher and vehicle load)">
                <input name="weight" type="number" min={1} max={500} required />
              </Field>
            )}
            <Field label="Patient reference (never a name)">
              <input
                name="ref"
                required
                pattern="[A-Za-z0-9\-]{2,30}"
                title="Letters, numbers and hyphens only: use the booking reference, not a name"
                aria-describedby="ref-help"
              />
            </Field>
          </div>
          <p id="ref-help" className="hh-help">
            The reference is shown on the grid and to crews. Never type a patient&apos;s name here.
          </p>
        </fieldset>

        <fieldset>
          <legend>Where</legend>
          <div className="hh-grid">
            <Field label="Location">
              <select name="location" required>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pickup address">
              <input name="pickup" required minLength={3} />
            </Field>
            <Field label="Destination">
              <input name="destination" required minLength={3} />
            </Field>
          </div>
        </fieldset>

        <fieldset>
          <legend>Booking</legend>
          <div className="hh-grid">
            <Field label="Customer">
              <input name="customer" required minLength={2} />
            </Field>
            <Field label="Contract">
              <select
                name="contract"
                value={contract}
                onChange={(e) => setContract(e.target.value)}
              >
                <option value="">Not stated</option>
                <option value="NHS">NHS</option>
                <option value="PRIVATE">Private</option>
                <option value="INSURER">Insurer</option>
              </select>
            </Field>
            <Field label="Customer order number (optional)">
              <input name="reference" maxLength={60} />
            </Field>
          </div>
          {contract === 'NHS' && (
            <div className="hh-grid">
              <label className="hh-check">
                <input type="checkbox" name="nhsMet" /> NHS eligibility criteria met
              </label>
              <Field label="Criteria applied">
                <input name="nhsCriteria" required minLength={3} maxLength={500} />
              </Field>
              <Field label="Assessed by">
                <input name="nhsAssessedBy" required minLength={2} maxLength={120} />
              </Field>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Return journey</legend>
          <label className="hh-check">
            <input
              type="checkbox"
              checked={withReturn}
              onChange={(e) => setWithReturn(e.target.checked)}
            />{' '}
            Book a return journey (destination back to pickup)
          </label>
          {withReturn && (
            <div className="hh-grid">
              <Field label="Return pickup from">
                <input name="returnFrom" type="time" required />
              </Field>
              <Field label="Return pickup by">
                <input name="returnTo" type="time" required />
              </Field>
            </div>
          )}
        </fieldset>

        <details className="hh-more">
          <summary>More details (optional)</summary>
          <div className="hh-grid">
            <Field label="Appointment time">
              <input name="appointment" type="time" />
            </Field>
            {!weightNeeded && (
              <Field label="Patient weight in kg">
                <input name="weight" type="number" min={1} max={500} />
              </Field>
            )}
            <Field label="Escorts travelling">
              <input name="escorts" type="number" min={0} max={4} defaultValue={0} />
            </Field>
            <Field label="Access notes (no names)">
              <input name="accessNotes" maxLength={500} />
            </Field>
            <Field label="Communication needs">
              <input
                name="comms"
                maxLength={200}
                placeholder="For example: British Sign Language"
              />
            </Field>
          </div>
          <div className="hh-checks">
            <label className="hh-check">
              <input type="checkbox" name="stairs" /> Stairs at pickup or destination
            </label>
            <label className="hh-check">
              <input type="checkbox" name="infection" /> Infection precautions needed
            </label>
            <label className="hh-check">
              <input type="checkbox" name="access" /> Access plan reviewed
            </label>
            <label className="hh-check">
              <input type="checkbox" name="blueLights" /> Blue-light (emergency) journey
            </label>
          </div>
          <fieldset>
            <legend>Equipment needed</legend>
            <div className="hh-checks">
              {Object.entries(EQUIPMENT_NEEDS).map(([k, v]) => (
                <label key={k} className="hh-check">
                  <input type="checkbox" name="equipment" value={k} /> {v}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Crew skills needed</legend>
            <div className="hh-checks">
              {Object.entries(SKILL_NEEDS).map(([k, v]) => (
                <label key={k} className="hh-check">
                  <input type="checkbox" name="skills" value={k} /> {v}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>
              Patient contact (kept separately, shown only to staff allowed to see it)
            </legend>
            <div className="hh-grid">
              <Field label="Contact name">
                <input name="contactName" maxLength={120} autoComplete="off" />
              </Field>
              <Field label="Contact phone">
                <input name="contactPhone" type="tel" maxLength={30} autoComplete="off" />
              </Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>Repeat</legend>
            <div className="hh-grid">
              <Field label="Repeats">
                <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                  <option value="">Does not repeat</option>
                  <option value="DAILY">Every day</option>
                  <option value="WEEKLY">Every week</option>
                </select>
              </Field>
              {repeat && (
                <Field label="Until">
                  <input name="until" type="date" required min={date} />
                </Field>
              )}
            </div>
            {repeat === 'WEEKLY' && (
              <div className="hh-checks" role="group" aria-label="On these days">
                {WEEKDAYS.map((d, i) => (
                  <label key={d} className="hh-check">
                    <input type="checkbox" name="weekday" value={i + 1} /> {d}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </details>
        <div className="hh-actions">
          <Button type="primary" htmlType="submit">
            Book journey
          </Button>
        </div>
      </form>
      {msg}
      {warnings.length > 0 && (
        <div role="status" className="rounded border border-amber-700 bg-amber-50 p-3 text-sm">
          <StatusBadge status="AMBER" reason="Check before allocating" />
          <ul className="ml-4 list-disc">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function PlanShift({ date, locations }: { date: string; locations?: Row[] }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?lifecycle=ACTIVE');
  const [driver, setDriver] = useState('');
  const [second, setSecond] = useState('');
  const [secondRole, setSecondRole] = useState('CARE_ASSISTANT');
  const [day, setDay] = useState(date);
  const [start, setStart] = useState('07:00');
  const [end, setEnd] = useState('19:00');
  const [vehicleId, setVehicleId] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const own = (prefix: string) => {
      const a = String(f.get(`${prefix}From`) ?? '');
      const b = String(f.get(`${prefix}To`) ?? '');
      return {
        ...(a ? { startsAt: londonDateTime(day, a).toISOString() } : {}),
        ...(b ? { endsAt: londonDateTime(day, b).toISOString() } : {}),
      };
    };
    const crew = [
      { staffId: driverId, role: 'DRIVER', ...own('driver') },
      ...(second && second !== driverId
        ? [{ staffId: second, role: secondRole, ...own('second') }]
        : []),
    ];
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/shifts', orgId, {
          locationId: String(f.get('location')),
          vehicleId: vehicleId || usable[0]?.id || '',
          startsAt: londonDateTime(day, start).toISOString(),
          endsAt: londonDateTime(day, end).toISOString(),
          crew,
        }),
      'Shift planned.',
    );
    if (ok) {
      form.reset();
      setDriver('');
      setSecond('');
    }
  }
  const shiftWindow =
    day && start && end && end > start
      ? {
          from: londonDateTime(day, start).toISOString(),
          to: londonDateTime(day, end).toISOString(),
        }
      : null;
  const people = staff.data?.data ?? [];
  const drivers = people.filter((p) => (p.roles as string[]).includes('DRIVER'));
  const driverId = driver || drivers[0]?.id || '';
  const all = vehicles.data?.data ?? [];
  const usable = all.filter((v) => v.status === 'AVAILABLE');
  const unusable = all.filter((v) => v.status !== 'AVAILABLE');
  return (
    <Section title="Plan a shift">
      <form onSubmit={submit} className="hh-form" aria-label="Plan a shift">
        <fieldset>
          <legend>When and where</legend>
          <div className="hh-grid">
            <Field label="Location">
              <select name="location" required>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Vehicle">
              <select
                name="vehicle"
                required

                value={vehicleId || usable[0]?.id || ''}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                {usable.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.callsign}
                  </option>
                ))}
                {unusable.length > 0 && (
                  <optgroup label="Not available (cannot be planned)">
                    {unusable.map((v) => (
                      <option key={v.id} value={v.id} disabled>
                        {v.callsign} – {VEHICLE_WORD[v.status] ?? 'not available'}
                        {v.statusReason ? `: ${v.statusReason}` : ''}
                        {v.expectedReturnOn ? `; expected back ${fmtDate(v.expectedReturnOn)}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </Field>
            <Field label="Shift date">
              <input
                name="date"
                type="date"
                required
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </Field>
            <Field label="Start">
              <input
                name="start"
                type="time"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="End">
              <input
                name="end"
                type="time"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
        <fieldset>
          <legend>Crew</legend>
          <div className="hh-grid">
            <Field label="Driver">
              <select
                name="driver"
                required

                value={driverId}
                onChange={(e) => {
                  setDriver(e.target.value);
                  if (second === e.target.value) setSecond('');
                }}
              >
                {drivers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName} ({p.staffNo})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Second crew member">
              <select
                name="second"

                value={second}
                onChange={(e) => setSecond(e.target.value)}
              >
                <option value="">None</option>
                {people
                  .filter((p) => p.id !== driverId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.staffNo})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Second crew role">
              <select
                name="secondRole"

                value={secondRole}
                onChange={(e) => setSecondRole(e.target.value)}
              >
                {['CARE_ASSISTANT', 'EMERGENCY_CARE_ASSISTANT', 'TECHNICIAN', 'PARAMEDIC'].map(
                  (r) => (
                    <option key={r} value={r}>
                      {words(r)}
                    </option>
                  ),
                )}
              </select>
            </Field>
          </div>
        </fieldset>
        <details className="hh-more">
          <summary>Part-shift times (optional)</summary>
          <div className="hh-grid">
            <Field label="Driver from">
              <input name="driverFrom" type="time" />
            </Field>
            <Field label="Driver to">
              <input name="driverTo" type="time" />
            </Field>
            {second && (
              <>
                <Field label="Second crew from">
                  <input name="secondFrom" type="time" />
                </Field>
                <Field label="Second crew to">
                  <input name="secondTo" type="time" />
                </Field>
              </>
            )}
          </div>
        </details>
        <div className="hh-ready">
          {driverId && shiftWindow && (
            <CrewReadiness
              staffId={driverId}
              name={people.find((p) => p.id === driverId)?.displayName ?? 'Driver'}
              role="DRIVER"
              window={shiftWindow}
              vehicleId={vehicleId || usable[0]?.id}
            />
          )}
          {second && shiftWindow && (
            <CrewReadiness
              staffId={second}
              name={people.find((p) => p.id === second)?.displayName ?? 'Second crew member'}
              role={secondRole}
              window={shiftWindow}
            />
          )}
        </div>
        <div className="hh-actions">
          <Button type="primary" htmlType="submit">
            Plan shift
          </Button>
        </div>
      </form>
      {msg}
    </Section>
  );
}

/** v36 Work planner: Planner · Contracts & continuity (commissioner contract measures). */
export function Planner() {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const contracts = can('compliance.registration.manage') || can('compliance.audit.view');
  const tabs = [
    { id: 'planner', label: 'Planner' },
    { id: 'contracts', label: 'Contracts & continuity', show: contracts },
  ];
  const current = tab === 'contracts' && contracts ? 'contracts' : 'planner';
  const nav = contracts ? (
    <Tabs
      label="Work planner sections"
      tabs={tabs}
      current={current}
      onChange={(id) =>
        void navigate({ to: '/planner', search: id === 'planner' ? {} : { tab: id } })
      }
    >
      {null}
    </Tabs>
  ) : null;
  if (current === 'planner') return <PlannerDay nav={nav} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
      <PageHeader
        title="Work planner"
        description="Commissioner contract measures and business continuity plans."
      />
      {nav}
      <NhsContracts />
      <BusinessContinuity />
    </div>
  );
}
