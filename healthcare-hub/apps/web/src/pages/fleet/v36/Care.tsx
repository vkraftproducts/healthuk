// v36 Vehicles › Equipment & care › Fleet care, and the Crew app tab. Read-only views over the
// existing cleaning, VDI and expense endpoints; recording happens in the crew app.
import { londonDate } from '@hub/rules';
import { DataTable } from '@hub/ui';
import type { ReactNode } from 'react';
import { useInvalidate, useOne, usePeople } from '../../settings/hooks.js';
import { useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useApp } from '../../../shell/AppContext.js';
import { Ms, RowActions, WfCard, WfTag, WfTask } from '../../../v36/ui.js';
import { ActionDialog, Field, PersonSelect } from '../../../components.js';
import { Button, Input } from 'antd';
import { useState } from 'react';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** v36 date "4 Nov 2026" (London day; three-letter months, never "Sept"). */
const dmy = (d: string) => {
  const x = d.length === 10 ? d : londonDate(new Date(d));
  return `${Number(x.slice(8, 10))} ${MON[Number(x.slice(5, 7)) - 1]} ${x.slice(0, 4)}`;
};

function useVehicleDetails(ids: string[]) {
  const { api, orgId } = useApp();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['one', orgId, `/api/v1/vehicles/${id}`],
      queryFn: async () => (await api.get(`/api/v1/vehicles/${id}`, orgId)) as R,
      enabled: !!orgId,
      retry: false,
    })),
  });
}

/** v36 Fleet care › Deep cleans: the last deep clean per vehicle and when the next is due. */
export function FleetCare({ children }: { children?: ReactNode }) {
  const { api, orgId, me } = useApp();
  // Days and escalation come from the server (London dates, organisation escalation rules).
  const status = useOne<{ data: R[] }>('/api/v1/deep-cleans/status');
  const people = usePeople();
  const invalidate = useInvalidate();
  const [deep, setDeep] = useState<R | null>(null);
  const [cleanedBy, setCleanedBy] = useState('');
  const [checkedBy, setCheckedBy] = useState('');
  const [cleanedOn, setCleanedOn] = useState(londonDate(new Date()));
  const [note, setNote] = useState('Scheduled deep clean');
  const rows = (status.data?.data ?? []).map((x) => ({
    v: { id: x.vehicleId as string, callsign: x.callsign as string },
    x,
    days: x.daysUntil as number | null,
  }));
  return (
    <>
      <WfCard title="Deep clean status" table>
        <DataTable<(typeof rows)[number]>
          caption="Deep clean status"
          rows={rows}
          rowKey={(r) => r.v.id}
          loading={status.isLoading}
          error={status.isError ? 'Could not load deep cleans.' : null}
          emptyMessage="No vehicles."
          rowTone={(r) => (r.days === null || r.days < 0 ? 'red' : 'amber')}
          columns={[
            { key: 'v', header: 'Vehicle', cell: (r) => <b>{r.v.callsign}</b> },
            {
              key: 'l',
              header: 'Last deep clean',
              cell: (r) =>
                r.x.lastOn ? (
                  <>
                    {dmy(r.x.lastOn)}
                    <span className="sub">
                      Scheduled deep clean · {r.x.cleanedByName ?? 'crew'}
                      {r.x.checkedByName ? ` · checked by ${r.x.checkedByName}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="wf-mut">None recorded</span>
                ),
            },
            { key: 'n', header: 'Next due', cell: (r) => (r.x.nextDueOn ? dmy(r.x.nextDueOn) : 'Now') },
            {
              key: 's',
              header: 'Status',
              cell: (r) => {
                if (r.days === null)
                  return (
                    <WfTag tone="red" icon="error">
                      No deep clean on record
                    </WfTag>
                  );
                if (r.days < 0) {
                  const overdue = -r.days;
                  const e = r.x.escalation as { stage: string; toName: string | null } | null;
                  const esc = !e
                    ? ''
                    : e.stage === 'MANAGER' && e.toName
                      ? ` · Escalated to ${e.toName}`
                      : ' · Escalated to lead';
                  return (
                    <WfTag tone="red" icon="error">
                      {overdue} day{overdue === 1 ? '' : 's'} overdue{esc}
                    </WfTag>
                  );
                }
                return (
                  <WfTag tone="amber" icon="schedule">
                    Due in {r.days} day{r.days === 1 ? '' : 's'}
                  </WfTag>
                );
              },
            },
            {
              key: 'a',
              header: '',
              cell: (r) => (
                <RowActions
                  name={r.v.callsign}
                  primary={{
                    label: 'Record deep clean',
                    icon: 'cleaning_services',
                    onClick: () => {
                      setCleanedBy(me.user.id);
                      setCheckedBy('');
                      setCleanedOn(londonDate(new Date()));
                      setNote('Scheduled deep clean');
                      setDeep(r.v);
                    },
                  }}
                  more={[
                    {
                      label: 'Infectious transfer',
                      icon: 'coronavirus',
                      danger: true,
                      onClick: async () => {
                        await api.send(
                          'POST',
                          `/api/v1/vehicles/${r.v.id}/infectious-transfer`,
                          orgId,
                          {},
                        );
                        void invalidate();
                      },
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </WfCard>
      <ActionDialog
        open={!!deep}
        title={`Record deep clean – ${deep?.callsign ?? ''}`}
        confirmLabel="Save deep clean"
        confirmDisabled={!cleanedBy || !checkedBy || cleanedBy === checkedBy || !cleanedOn}
        onCancel={() => setDeep(null)}
        onConfirm={async () => {
          await api.send('POST', '/api/v1/cleaning-records/deep', orgId, {
            vehicleId: deep!.id,
            cleanedOn,
            cleanedBy,
            checkedBy,
            ...(note.trim().length >= 3 ? { note: note.trim() } : {}),
          });
          setDeep(null);
          void invalidate();
        }}
        fields={
          <>
            <PersonSelect
              label="Cleaned by"
              value={cleanedBy}
              onChange={setCleanedBy}
              people={people}
              meId={me.user.id}
            />
            <PersonSelect
              label="Checked by"
              value={checkedBy}
              onChange={setCheckedBy}
              people={people}
              meId={me.user.id}
            />
            <Field label="Cleaned on">
              <Input type="date" value={cleanedOn} onChange={(e) => setCleanedOn(e.target.value)} />
            </Field>
            <Field label="Note">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        }
      />
      {children}
    </>
  );
}

/** v36 Fleet care › Mileage & servicing: odometer against the next service, by miles and date. */
export function MileageServicing() {
  const navigate = useNavigate();
  const vehicles = useOne<{ data: R[] }>('/api/v1/vehicles');
  const list = vehicles.data?.data ?? [];
  const details = useVehicleDetails(list.map((v) => v.id as string));
  const rows = list.map((v, i) => {
    const d = details[i]?.data;
    const plan = ((d?.maintenance as R[]) ?? [])
      .filter((m) => m.dueDate || m.dueOdometer)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    return { v, plan };
  });
  return (
    <WfCard title="Mileage and service intervals" table>
      <DataTable<(typeof rows)[number]>
        caption="Mileage and service intervals"
        rows={rows}
        rowKey={(r) => r.v.id}
        loading={vehicles.isLoading}
        emptyMessage="No vehicles."
        rowTone={(r) =>
          r.plan?.state === 'OVERDUE' ? 'red' : r.plan?.state === 'DUE_SOON' ? 'amber' : null
        }
        columns={[
          { key: 'v', header: 'Vehicle', cell: (r) => <b>{r.v.callsign}</b> },
          {
            key: 'o',
            header: 'Odometer',
            cell: (r) =>
              r.v.currentOdometer != null
                ? `${Number(r.v.currentOdometer).toLocaleString('en-GB')} mi`
                : '—',
          },
          {
            key: 'm',
            header: 'Service due by miles',
            cell: (r) => {
              const p = r.plan;
              if (!p?.dueOdometer || r.v.currentOdometer == null) return '—';
              const left = Number(p.dueOdometer) - Number(r.v.currentOdometer);
              const span = Number(p.intervalMiles ?? 12000) || 12000;
              const pct = Math.max(
                3,
                Math.min(100, Math.round(((span - Math.max(0, left)) / span) * 100)),
              );
              const tone = left < 0 ? 'var(--rd)' : left <= 1000 ? 'var(--am)' : 'var(--ok)';
              return (
                <>
                  <div className="wf-bar sm" aria-hidden="true">
                    <i style={{ width: `${pct}%`, background: tone }} />
                  </div>
                  <span className="sub">
                    {Number(p.dueOdometer).toLocaleString('en-GB')} mi ·{' '}
                    {left < 0
                      ? `${(-left).toLocaleString('en-GB')} over`
                      : `${left.toLocaleString('en-GB')} to go`}
                  </span>
                </>
              );
            },
          },
          {
            key: 'd',
            header: 'Service due by date',
            cell: (r) => (r.plan?.dueDate ? dmy(r.plan.dueDate) : '—'),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) =>
              !r.plan ? (
                <WfTag tone="grey" icon="radio_button_unchecked">
                  No service plan
                </WfTag>
              ) : r.plan.state === 'OVERDUE' ? (
                <WfTag tone="red" icon="error">
                  Service overdue
                </WfTag>
              ) : r.plan.state === 'DUE_SOON' ? (
                <WfTag tone="amber" icon="schedule">
                  Service soon
                </WfTag>
              ) : (
                <WfTag tone="green" icon="check_circle">
                  In date
                </WfTag>
              ),
          },
          {
            key: 'a',
            header: '',
            cell: (r) => (
              <RowActions
                name={r.v.callsign}
                ghost
                primary={{
                  label: 'Record reading',
                  icon: 'speed',
                  onClick: () =>
                    void navigate({
                      to: '/vehicles/$id',
                      params: { id: r.v.id },
                      search: { tab: 'status' },
                    }),
                }}
              />
            ),
          },
        ]}
      />
    </WfCard>
  );
}

/**
 * v36 Crew app: a preview of the phone a crew member sees at shift start – the gates that must all
 * pass before "Start shift" works – built from today's real records. Only crew submit from the
 * phone itself; here it is read-only.
 */
export function CrewApp() {
  const today = londonDate(new Date());
  const vdis = useOne<{ data: R[] }>('/api/v1/vdis');
  const cleaning = useOne<{ data: R[] }>('/api/v1/cleaning-records');
  const vehicles = useOne<{ data: R[] }>('/api/v1/vehicles');
  const planner = useOne<R>(`/api/v1/planner?date=${today}`);
  const staff = useOne<{ data: R[] }>('/api/v1/staff?limit=100');
  const people = usePeople();
  const who = new Map(people.map((p) => [p.id, p.displayName]));
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<'shift' | 'check' | 'defect' | 'jobs'>('shift');
  const vehicle = new Map((vehicles.data?.data ?? []).map((v) => [v.id as string, v]));
  const hm = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    }).format(new Date(iso));
  // The first crew member on a shift that starts today.
  const shift = ((planner.data?.shifts as R[]) ?? [])
    .filter((x) => londonDate(new Date(x.startsAt)) === today && ((x.crew as R[]) ?? []).length > 0)
    .sort((x, y) => String(x.startsAt).localeCompare(String(y.startsAt)))[0];
  const member = shift ? (shift.crew as R[])[0] : null;
  const person = member ? (staff.data?.data ?? []).find((x) => x.id === member.staffId) : null;
  const v = shift ? vehicle.get(shift.vehicleId) : null;
  const check = shift
    ? (vdis.data?.data ?? [])
        .filter(
          (c) => c.vehicleId === shift.vehicleId && londonDate(new Date(c.capturedAt)) === today,
        )
        .sort((x, y) => String(y.capturedAt).localeCompare(String(x.capturedAt)))[0]
    : null;
  const clean = shift
    ? (cleaning.data?.data ?? []).find(
        (c) =>
          c.vehicleId === shift.vehicleId &&
          c.type === 'PRE_SHIFT' &&
          londonDate(new Date(c.capturedAt)) === today,
      )
    : null;
  const gates =
    shift && v && member
      ? [
          {
            ok: true,
            title: 'Rostered today',
            sub: `${hm(shift.startsAt)}–${hm(shift.endsAt)} on ${v.callsign as string}`,
          },
          {
            ok: !person || !person.issue,
            title: member.role === 'DRIVER' ? 'Driving clearance' : 'Cleared for the role',
            sub: person?.issue ?? 'All checks verified',
          },
          { ok: true, title: 'Rested and within hours', sub: 'Rules met' },
          {
            ok: v.status === 'AVAILABLE',
            title: `${v.callsign as string} not blocked`,
            sub:
              v.status === 'AVAILABLE'
                ? 'No stop-use defects, documents valid'
                : (v.statusReason ?? 'Blocked'),
          },
          {
            ok: check?.outcome === 'PASS',
            title: `${v.callsign as string} daily check`,
            sub: check
              ? `${check.outcome === 'PASS' ? 'Pass' : 'Fail'} at ${hm(check.capturedAt)} by ${who.get(check.checkerUserId) ?? 'crew'}`
              : 'Do the daily check',
          },
          {
            ok: !!clean,
            title: `${v.callsign as string} pre-shift clean`,
            sub: clean ? `Recorded at ${hm(clean.capturedAt)}` : 'Confirm the IPC clean',
            action: !clean,
          },
        ]
      : [];
  const done = gates.filter((g) => g.ok).length;
  const recent = (vdis.data?.data ?? [])
    .slice()
    .sort((x, y) => String(y.capturedAt).localeCompare(String(x.capturedAt)))
    .slice(0, 5);
  return (
    <div className="ph-wrap">
      <div className="phone" aria-label="Crew phone preview">
        <div className="ph-screen">
          <div className="ph-top">
            <span>{hm(new Date().toISOString())}</span>
            <Ms i={online ? 'signal_cellular_alt' : 'wifi_off'} />
          </div>
          {member ? (
            <div className="ph-head">
              <span className="wf-av" style={{ background: 'hsl(78 50% 32%)' }} aria-hidden="true">
                {String(member.displayName)
                  .split(' ')
                  .map((w: string) => w[0])
                  .join('')
                  .slice(0, 2)}
              </span>
              <div>
                <b>{member.displayName}</b>
                <small>
                  {person?.jobTitle ?? member.role} · {v?.callsign}
                </small>
              </div>
            </div>
          ) : (
            <div className="ph-head">
              <div>
                <b>No shift today</b>
                <small>Nobody is rostered yet</small>
              </div>
            </div>
          )}
          <div className="ph-body">
            {tab === 'shift' && gates.length > 0 && (
              <>
                <div className={`ph-hero${done === gates.length ? '' : ' lock'}`}>
                  <Ms i={done === gates.length ? 'lock_open' : 'lock'} />
                  <b>{done === gates.length ? 'Ready to start' : 'Shift start blocked'}</b>
                  <small>
                    {done} of {gates.length} gates complete · {v?.callsign}
                  </small>
                </div>
                {gates.map((g) => (
                  <div key={g.title} className={`ph-gate ${g.ok ? 'ok' : 'bad'}`}>
                    <Ms i={g.ok ? 'check_circle' : 'pending'} />
                    <div>
                      <b>{g.title}</b>
                      <small>{g.sub}</small>
                    </div>
                    {g.action && (
                      <button
                        type="button"
                        className="ph-btn"
                        disabled
                        title="Crew confirm this on the phone"
                      >
                        Confirm
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className={`ph-cta${done === gates.length ? '' : ' blocked'}`}
                  disabled
                  title={
                    done === gates.length
                      ? 'Crew start the shift on the phone'
                      : 'Blocked – the gates above are not all met'
                  }
                >
                  Start shift
                </button>
              </>
            )}
            {tab !== 'shift' && (
              <div className="ph-gate ok">
                <Ms i="smartphone" />
                <div>
                  <b>
                    {tab === 'check'
                      ? 'Daily check'
                      : tab === 'defect'
                        ? 'Report a defect'
                        : 'Jobs'}
                  </b>
                  <small>Crew complete this in the phone app.</small>
                </div>
              </div>
            )}
          </div>
          <nav className="ph-nav" aria-label="Phone sections">
            {(
              [
                ['shift', 'lock', 'Shift'],
                ['check', 'fact_check', 'Check'],
                ['defect', 'report', 'Defect'],
                ['jobs', 'route', 'Jobs'],
              ] as const
            ).map(([k, icon, label]) => (
              <button
                key={k}
                type="button"
                className={tab === k ? 'on' : ''}
                onClick={() => setTab(k)}
              >
                <Ms i={icon} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </div>
      <div className="ph-side">
        <div className={`wf-net${online ? '' : ' off'}`}>
          <Ms i={online ? 'signal_cellular_alt' : 'wifi_off'} />
          <div>
            <b>{online ? 'Phone online' : 'Phone offline'}</b>
            <small>
              {online
                ? 'Everything has been sent.'
                : 'Taps are kept on the phone and sent when signal returns.'}
            </small>
          </div>
          <Button
            size="small"
            icon={<Ms i={online ? 'wifi_off' : 'wifi'} />}
            onClick={() => setOnline(!online)}
          >
            {online ? 'Simulate losing signal' : 'Signal back'}
          </Button>
        </div>
        <WfCard title="What happens next">
          <ul className="wf-mini" style={{ fontSize: '.88rem', lineHeight: 1.7 }}>
            <li>Patient names are never shown – only references.</li>
            <li>Every tap is time-stamped in the audit trail.</li>
            <li>Only crew can submit from the phone; other roles see a preview.</li>
          </ul>
        </WfCard>
        <WfCard title="Recent checks">
          {recent.map((c) => (
            <WfTask
              key={c.id}
              icon="fact_check"
              title={`${vehicle.get(c.vehicleId)?.callsign ?? '—'} · ${hm(c.capturedAt)}`}
              detail={`${who.get(c.checkerUserId) ?? 'crew'}${c.code ? ` · ${c.code}` : ''}`}
              tag={
                c.outcome === 'PASS' ? (
                  <WfTag tone="green" icon="check_circle">
                    Pass
                  </WfTag>
                ) : (
                  <WfTag tone="red" icon="error">
                    Fail
                  </WfTag>
                )
              }
            />
          ))}
        </WfCard>
      </div>
    </div>
  );
}
