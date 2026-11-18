// v36 Vehicles › Fleet: one card per vehicle with its status in words, today's check, open
// defects, jobs today, odometer, and MOT / insurance / service as days left. Read-only views over
// existing endpoints; the server decides availability (gates cannot be overridden here).
import {} from '@ant-design/icons';
import { daysUntil, londonDate } from '@hub/rules';
import { DataTable } from '@hub/ui';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, Spin, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useApp } from '../../../shell/AppContext.js';
import { useOne } from '../../settings/hooks.js';
import { Defects, ReportDefect } from '../Defects.js';
import { VEHICLE_TYPE } from '../FleetRegisters.js';
import { Mut, day, toneOf, type Tone } from '../../../v36/kit.js';
import { Deeper, Ms, RowActions, ViewSwitch, WfCard, WfTag, WfTask } from '../../../v36/ui.js';
import { ReadinessCheck } from '../VehicleOperations.js';
import { UploadDialog } from '../../evidence/Evidence.js';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STATUS_WORD: Record<string, { tone: Tone; word: string }> = {
  AVAILABLE: { tone: 'green', word: 'Available' },
  BLOCKED: { tone: 'red', word: 'Blocked' },
  QUARANTINED: { tone: 'red', word: 'Quarantined' },
  OFF_ROAD: { tone: 'grey', word: 'Off road' },
};

const TYPE_ICON: Record<string, string> = {
  AMBULANCE: 'ambulance',
  HIGH_DEPENDENCY: 'ambulance',
  PTS_VEHICLE: 'airport_shuttle',
  WAV: 'accessible',
  CAR: 'directions_car',
  MINIBUS: 'airport_shuttle',
};
/** A UK registration as printed on the plate ("SY21 ABC"). */
export const fmtReg = (r: string) =>
  /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(r) ? `${r.slice(0, 4)} ${r.slice(4)}` : r;

/** v36 words for the vehicle type ("Emergency ambulance", "Rapid response car"). */
export const typeWords = (v: R) =>
  v.type === 'AMBULANCE'
    ? `Emergency ambulance${v.en1789Type ? ` (Type ${v.en1789Type as string})` : ''}`
    : v.type === 'CAR' && /^RRV/i.test(String(v.callsign))
      ? 'Rapid response car'
      : (VEHICLE_TYPE[v.type] ?? v.type);
const BAR: Record<Tone, string> = {
  green: 'var(--ok)',
  amber: 'var(--am)',
  red: 'var(--rd)',
  grey: 'var(--hh-line2)',
  blue: 'var(--bl)',
  purple: '#722ed1',
};

/** v36 `.wf-cd`: a document or service line with days left and a bar (a year; service half). */
function DocBar({
  label,
  date,
  reason,
  status,
  span = 365,
}: {
  label: string;
  date: string | null;
  reason?: string;
  status?: string;
  span?: number;
}) {
  if (!date) {
    const na = /not applicable|not due/i.test(reason ?? '');
    return (
      <div className="wf-cd" aria-label={`${label}: ${reason ?? 'not recorded'}`}>
        <div>
          <span>{label}</span>
          <b>{na ? 'Not due' : (reason ?? 'Not recorded')}</b>
        </div>
        <span className="bar">
          <i style={{ width: na ? '100%' : '0%', background: BAR.green }} />
        </span>
      </div>
    );
  }
  const d = daysUntil(date, new Date());
  const tone: Tone = d < 0 ? 'red' : status ? toneOf(status) : d <= 30 ? 'amber' : 'green';
  const pct = d < 0 ? 100 : Math.max(3, Math.min(100, Math.round((d / span) * 100)));
  return (
    <div
      className="wf-cd"
      aria-label={`${label}: ${d < 0 ? `${-d} days overdue` : `${d} days left`} (${day(date)})`}
    >
      <div>
        <span>{label}</span>
        <b>{d < 0 ? `${-d}d overdue` : `${d}d`}</b>
      </div>
      <span className="bar">
        <i style={{ width: `${pct}%`, background: BAR[tone] }} />
      </span>
    </div>
  );
}

function VehicleCard({
  v,
  docs,
  check,
  jobs,
  onReport,
  onHistory,
}: {
  v: R;
  docs: R[];
  check: R | null;
  jobs: number;
  onReport: () => void;
  onHistory: () => void;
}) {
  const { me } = useApp();
  const navigate = useNavigate();
  const can = (p: string) => me.permissions.includes(p);
  const detail = useOne<R>(`/api/v1/vehicles/${v.id}`);
  const s = STATUS_WORD[v.status] ?? { tone: 'grey' as Tone, word: v.status };
  const noCheck = v.status === 'AVAILABLE' && !check;
  const doc = (re: RegExp) => docs.find((d) => re.test(d.templateTitle));
  const mot = doc(/\bMOT\b/i);
  const ins = doc(/insurance/i);
  const soon = docs.find((d) => d.status === 'AMBER');
  const tone: Tone = s.tone === 'green' && (noCheck || soon) ? 'amber' : s.tone;
  const svc = ((detail.data?.maintenance as R[]) ?? [])
    .filter((m) => m.dueDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
  const hhmm = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    }).format(new Date(iso));
  const statusText = `${s.word}${
    v.statusReason
      ? ` – ${v.statusReason as string}`
      : noCheck
        ? ' – No daily check yet today'
        : soon && s.tone === 'green'
          ? ` – ${String(soon.templateTitle).replace(/ test certificate$/i, ' certificate')}: Expires ${new Date(`${soon.expiryDate}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
          : ''
  }`;
  return (
    <article className={`wf-vc v-${tone}`} aria-label={`${v.callsign as string}, ${statusText}`}>
      <header>
        <span className="ic">
          <Ms i={TYPE_ICON[v.type] ?? 'airport_shuttle'} />
        </span>
        <div>
          <b>{v.callsign}</b>
          <small>
            {fmtReg(v.registration)} · {typeWords(v)}
          </small>
        </div>
      </header>
      <WfTag
        tone={tone}
        icon={tone === 'green' ? 'check_circle' : tone === 'red' ? 'error' : 'schedule'}
      >
        {statusText}
      </WfTag>
      <dl>
        <div>
          <dt>Today’s check</dt>
          <dd>
            {check ? (
              check.outcome === 'PASS' ? (
                <WfTag tone="green" icon="check_circle">
                  Passed {hhmm(check.capturedAt)}
                </WfTag>
              ) : (
                <WfTag tone="red" icon="error">
                  Failed {hhmm(check.capturedAt)}
                </WfTag>
              )
            ) : v.status === 'AVAILABLE' ? (
              <WfTag tone="amber" icon="schedule">
                Not done
              </WfTag>
            ) : (
              <WfTag tone="grey" icon="radio_button_unchecked">
                Not needed
              </WfTag>
            )}
          </dd>
        </div>
        <div>
          <dt>Open defects</dt>
          <dd>
            {v.openDefects ? (
              <WfTag
                tone={v.status === 'BLOCKED' ? 'red' : 'amber'}
                icon={v.status === 'BLOCKED' ? 'error' : 'schedule'}
              >
                {v.openDefects} open
              </WfTag>
            ) : (
              <WfTag tone="green" icon="check_circle">
                None
              </WfTag>
            )}
          </dd>
        </div>
        <div>
          <dt>Jobs today</dt>
          <dd>
            <b>{jobs}</b>
          </dd>
        </div>
        <div>
          <dt>Odometer</dt>
          <dd>
            {v.latestReading
              ? `${Number(v.latestReading.reading).toLocaleString('en-GB')} mi`
              : v.currentOdometer != null
                ? `${Number(v.currentOdometer).toLocaleString('en-GB')} mi`
                : 'No readings'}
          </dd>
        </div>
      </dl>
      <DocBar
        label="MOT"
        date={mot?.expiryDate ?? null}
        status={mot?.status}
        reason={mot ? mot.reasonText : 'Not set up'}
      />
      <DocBar
        label="Insurance"
        date={ins?.expiryDate ?? null}
        status={ins?.status}
        reason={ins ? ins.reasonText : 'Not set up'}
      />
      <DocBar
        label="Service"
        span={180}
        date={svc?.dueDate ?? null}
        reason={detail.isLoading ? 'Loading…' : 'No service plan'}
        status={
          svc
            ? svc.state === 'OVERDUE'
              ? 'RED'
              : svc.state === 'DUE_SOON'
                ? 'AMBER'
                : 'GREEN'
            : undefined
        }
      />
      <footer>
        <Button size="small" icon={<Ms i="history" />} onClick={onHistory}>
          History<span className="sr-only"> of {v.callsign}</span>
        </Button>
        <Button
          size="small"
          icon={<Ms i="manage_search" />}
          onClick={() =>
            void navigate({
              to: '/vehicles/$id',
              params: { id: v.id },
              search: { tab: 'documents' },
            })
          }
        >
          Records<span className="sr-only"> of {v.callsign}</span>
        </Button>
        {can('fleet.defect.create') ? (
          <Button size="small" icon={<Ms i="report" />} onClick={onReport}>
            Report defect<span className="sr-only"> on {v.callsign}</span>
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

/** Today's figures shared by the fleet cards: checks, documents and jobs. */
function useFleetToday() {
  const today = londonDate(new Date());
  const vdis = useOne<{ data: R[] }>('/api/v1/vdis');
  const docs = useOne<{ data: R[] }>(
    '/api/v1/requirements/instances?subjectType=VEHICLE&limit=100',
  );
  const planner = useOne<R>(`/api/v1/planner?date=${today}`);
  return useMemo(() => {
    const checks = new Map<string, R>();
    for (const c of vdis.data?.data ?? [])
      if (londonDate(new Date(c.capturedAt)) === today) {
        const prev = checks.get(c.vehicleId);
        if (!prev || prev.capturedAt < c.capturedAt) checks.set(c.vehicleId, c);
      }
    const byVehicle = new Map<string, R[]>();
    for (const d of docs.data?.data ?? [])
      byVehicle.set(d.subjectId, [...(byVehicle.get(d.subjectId) ?? []), d]);
    const jobs = new Map<string, number>();
    for (const s of (planner.data?.shifts as R[]) ?? [])
      jobs.set(
        s.vehicleId,
        (jobs.get(s.vehicleId) ?? 0) +
          ((s.jobs as R[]) ?? []).filter((j) => londonDate(new Date(j.startsAt)) === today).length,
      );
    return { checks, byVehicle, jobs };
  }, [vdis.data, docs.data, planner.data, today]);
}

export function FleetCards({ onHistory }: { onHistory?: (vehicleId: string) => void } = {}) {
  const res = useOne<{ data: R[] }>('/api/v1/vehicles');
  const t = useFleetToday();
  const [report, setReport] = useState<string | null>(null);
  return (
    <>
      {res.isError && (
        <Alert type="error" showIcon message="Source unavailable: vehicles could not be loaded." />
      )}
      {res.isLoading ? (
        <Spin />
      ) : (
        <div className="wf-vcs">
          {(res.data?.data ?? []).map((v) => (
            <VehicleCard
              key={v.id}
              v={v}
              docs={t.byVehicle.get(v.id) ?? []}
              check={t.checks.get(v.id) ?? null}
              jobs={t.jobs.get(v.id) ?? 0}
              onReport={() => setReport(v.id)}
              onHistory={() => onHistory?.(v.id)}
            />
          ))}
          {(res.data?.data ?? []).length === 0 && <Mut>No vehicles match.</Mut>}
        </div>
      )}
      {report && <ReportDefect vehicleId={report} onClose={() => setReport(null)} />}
    </>
  );
}

const DOC_LAW: [RegExp, string][] = [
  [/\bMOT\b|insurance/i, 'Road Traffic Act 1988 · statutory'],
  [/tax|VED/i, 'Vehicle Excise and Registration Act · statutory'],
  [/LOLER|tail-lift|stretcher/i, 'Lifting Operations & Lifting Equipment Regs 1998'],
];
const dmy = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const dm = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });

function DocStatus({ d }: { d: R }) {
  if (d.applicability !== 'APPLICABLE')
    return (
      <WfTag tone="grey" icon="radio_button_unchecked">
        Not applicable
      </WfTag>
    );
  if (!d.expiryDate)
    return (
      <WfTag
        tone={d.status === 'GREEN' ? 'green' : 'red'}
        icon={d.status === 'GREEN' ? 'check_circle' : 'error'}
      >
        {d.status === 'GREEN' ? 'In date' : 'Missing'}
      </WfTag>
    );
  const left = daysUntil(d.expiryDate, new Date());
  if (left < 0)
    return (
      <WfTag tone="red" icon="error">
        Expired {dm(d.expiryDate)}
      </WfTag>
    );
  if (d.status === 'AMBER')
    return (
      <WfTag tone="amber" icon="schedule">
        Expires {dm(d.expiryDate)}
      </WfTag>
    );
  return (
    <WfTag tone="green" icon="check_circle">
      Valid to {dm(d.expiryDate)}
    </WfTag>
  );
}

/** v36 Vehicle history: one vehicle at a time – overview, full history, readiness, all records. */
export function VehicleHistory({ initial }: { initial?: string } = {}) {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const vehicles = useOne<{ data: R[] }>('/api/v1/vehicles');
  const t = useFleetToday();
  const [id, setId] = useState<string | null>(initial ?? null);
  const [part, setPart] = useState<'overview' | 'history' | 'ready' | 'records'>('overview');
  const [upload, setUpload] = useState<{ instanceId: string; title: string } | null>(null);
  const list = vehicles.data?.data ?? [];
  const sel = id ?? list[0]?.id ?? null;
  const detail = useOne<R>(sel ? `/api/v1/vehicles/${sel}` : null);
  const history = useOne<{ data: R[] }>(sel ? `/api/v1/vehicles/${sel}/status-history` : null);
  const vdis = useOne<{ data: R[] }>('/api/v1/vdis');
  const defects = useOne<{ data: R[] }>(sel ? `/api/v1/defects?vehicleId=${sel}` : null);
  const v = list.find((x) => x.id === sel);
  const docs = (sel ? (t.byVehicle.get(sel) ?? []) : [])
    .slice()
    .sort((a, b) => String(a.templateTitle).localeCompare(String(b.templateTitle)));
  const open = (defects.data?.data ?? []).filter(
    (d) => !['CLOSED', 'RELEASED', 'CANCELLED'].includes(d.status),
  );
  const svc = ((detail.data?.maintenance as R[]) ?? [])
    .filter((m) => m.dueDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
  const s = v ? (STATUS_WORD[v.status] ?? { tone: 'grey' as Tone, word: v.status }) : null;
  const events = [
    ...(history.data?.data ?? []).map((h) => ({
      at: h.changedAt as string,
      what:
        h.flag === 'OFF_ROAD'
          ? h.on
            ? 'Taken off the road'
            : 'Returned to the road'
          : h.on
            ? 'Quarantined'
            : 'Released from quarantine',
      detail: `${h.reason as string}${h.changedByName ? ` · ${h.changedByName as string}` : ''}`,
    })),
    ...(vdis.data?.data ?? [])
      .filter((c) => c.vehicleId === sel)
      .map((c) => ({
        at: c.capturedAt,
        what: c.outcome === 'PASS' ? 'Daily check passed' : 'Daily check failed',
        detail: `${Number(c.odometer).toLocaleString('en-GB')} mi`,
      })),
  ]
    .filter((e) => e.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Deeper>
        <ViewSwitch
          label="Vehicle"
          current={sel ?? ''}
          onChange={(x) => {
            setId(x);
            setPart('overview');
          }}
          options={list.map((x) => ({
            id: x.id as string,
            label: x.callsign as string,
            ...(x.status === 'BLOCKED' || x.status === 'QUARANTINED'
              ? { icon: 'do_not_disturb_on' }
              : {}),
          }))}
        />
      </Deeper>
      {v && s && (
        <WfCard>
          <div className="hh-vhead">
            <span className="ic">
              <Ms i={TYPE_ICON[v.type] ?? 'airport_shuttle'} />
            </span>
            <b>
              {v.callsign} · {fmtReg(v.registration)}
            </b>
            <span className="sub">
              {typeWords(v)} · base Watford
              {v.currentOdometer != null
                ? ` · ${Number(v.currentOdometer).toLocaleString('en-GB')} mi`
                : ''}
            </span>
            <WfTag
              tone={s.tone}
              icon={s.tone === 'green' ? 'check_circle' : s.tone === 'red' ? 'error' : 'schedule'}
            >
              {s.word}
              {v.statusReason ? ` – ${v.statusReason as string}` : ''}
            </WfTag>
          </div>
        </WfCard>
      )}
      {v && (
        <Deeper>
          <Deeper>
            <ViewSwitch
              label="Vehicle history view"
              current={part}
              onChange={(x) => setPart(x as typeof part)}
              options={[
                { id: 'overview', label: 'Overview' },
                { id: 'history', label: 'Full history' },
                { id: 'ready', label: 'Readiness check' },
                { id: 'records', label: 'All records' },
              ]}
            />
          </Deeper>
        </Deeper>
      )}
      {v && part === 'overview' && (
        <div className="hh-two">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <WfCard title="Documents" table>
              <DataTable<R>
                caption={`Documents for ${v.callsign as string}`}
                rows={docs}
                rowKey={(d) => d.id}
                emptyMessage="No documents are required for this vehicle yet."
                columns={[
                  {
                    key: 'd',
                    header: 'Document',
                    cell: (d) => (
                      <>
                        <b>{d.templateTitle}</b>
                        <span className="sub">
                          {DOC_LAW.find(([re]) => re.test(d.templateTitle))?.[1] ??
                            (d.blocking === 'STATUTORY' ? 'Statutory' : 'Organisation rule')}
                        </span>
                      </>
                    ),
                  },
                  {
                    key: 'f',
                    header: 'File',
                    cell: (d) => d.latestEvidence?.fileName ?? '—',
                  },
                  {
                    key: 'vb',
                    header: 'Verified by',
                    cell: (d) => d.latestEvidence?.verifiedByName ?? '—',
                  },
                  { key: 'v', header: 'Status', cell: (d) => <DocStatus d={d} /> },
                  {
                    key: 'a',
                    header: '',
                    cell: (d) => (
                      <RowActions
                        name={d.templateTitle}
                        ghost
                        primary={{
                          label: 'Upload renewal',
                          icon: 'upload',
                          onClick: () =>
                            setUpload({
                              instanceId: d.id as string,
                              title: d.templateTitle as string,
                            }),
                        }}
                      />
                    ),
                  },
                ]}
              />
            </WfCard>
            <UploadDialog target={upload} onClose={() => setUpload(null)} />
            <WfCard
              title="Servicing (date or mileage, whichever comes first)"
              extra={
                <Button
                  size="small"
                  icon={<Ms i="build" />}
                  onClick={() =>
                    void navigate({
                      to: '/vehicles/$id',
                      params: { id: v.id },
                      search: { tab: 'overview' },
                    })
                  }
                >
                  Record service
                </Button>
              }
            >
              {svc ? (
                <dl className="hh-dl">
                  <dt>Last service</dt>
                  <dd>
                    {svc.lastDoneOn ? dmy(svc.lastDoneOn) : '—'}
                    {svc.lastDoneOdometer != null
                      ? ` at ${Number(svc.lastDoneOdometer).toLocaleString('en-GB')} mi`
                      : ''}
                  </dd>
                  <dt>Next due</dt>
                  <dd>
                    {svc.dueDate ? dmy(svc.dueDate) : '—'}
                    {svc.dueOdometer != null
                      ? ` or ${Number(svc.dueOdometer).toLocaleString('en-GB')} mi`
                      : ''}
                  </dd>
                  <dt>Odometer</dt>
                  <dd>
                    {v.currentOdometer != null
                      ? `${Number(v.currentOdometer).toLocaleString('en-GB')} mi`
                      : '—'}
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    {svc.state === 'OVERDUE' ? (
                      <WfTag tone="red" icon="error">
                        Overdue
                      </WfTag>
                    ) : svc.state === 'DUE_SOON' ? (
                      <WfTag tone="amber" icon="schedule">
                        Due soon
                      </WfTag>
                    ) : (
                      <WfTag tone="green" icon="check_circle">
                        In date
                      </WfTag>
                    )}
                  </dd>
                </dl>
              ) : (
                <Mut>No service plan yet.</Mut>
              )}
            </WfCard>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <WfCard title="Open defects">
              {open.length === 0 ? (
                <Mut>No open defects.</Mut>
              ) : (
                open.map((d) => (
                  <WfTask
                    key={d.id}
                    icon="build"
                    title={String(d.description)}
                    detail={`${String(d.status).replace(/_/g, ' ').toLowerCase()}${d.ownerName ? ` · owner ${d.ownerName as string}` : ''}`}
                    tag={
                      <WfTag
                        tone={
                          d.severity === 'RED' || d.critical
                            ? 'red'
                            : d.severity === 'AMBER'
                              ? 'amber'
                              : 'grey'
                        }
                        icon={d.severity === 'RED' || d.critical ? 'error' : 'schedule'}
                      >
                        {d.severity === 'RED' || d.critical
                          ? 'Critical – stop use'
                          : d.severity === 'AMBER'
                            ? 'Major'
                            : 'Minor'}
                      </WfTag>
                    }
                    onOpen={() => setPart('records')}
                  />
                ))
              )}
            </WfCard>
            <WfCard title="Off-road status">
              <Mut>
                {v.offRoad
                  ? `Off the road${v.expectedReturnOn ? ` – expected back ${dmy(v.expectedReturnOn)}` : ''}.`
                  : v.quarantined
                    ? 'Quarantined.'
                    : 'On the road.'}
              </Mut>
            </WfCard>
          </div>
        </div>
      )}
      {v && part === 'history' && (
        <WfCard title={`Full history – ${v.callsign as string}`}>
          {events.length === 0 ? (
            <Mut>No status changes or daily checks recorded yet.</Mut>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {events.slice(0, 60).map((e, i) => (
                <li
                  key={`${e.at}-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '150px 1fr',
                    gap: 12,
                    padding: '8px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <Mut>{day(e.at)}</Mut>
                  <span>
                    <b>{e.what}</b>
                    {e.detail && <span className="sub">{e.detail}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </WfCard>
      )}
      {v && part === 'ready' && detail.data && <ReadinessCheck v={detail.data} />}
      {v && part === 'records' && <Defects vehicleId={v.id} />}
    </div>
  );
}
