// v36 screen 34 (Staff › Shifts): Rota · Open shifts · Swaps · Hours · Patterns, and My hours for
// crew. The API decides who may do what; buttons are hidden here for clarity only.
import { DataTable } from '@hub/ui';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';
import { ActionDialog, errText, fmtDate, fmtDateTime, useCan, useRun } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { Mut, RuleNote, StatusTag, Views, type Tone } from '../../v36/kit.js';
import { Deeper, Ms, RowActions, WfCard, WfSearch, WfSelect, WfTag } from '../../v36/ui.js';
import { useOne } from '../settings/hooks.js';
import { ROLE_LABEL } from '../staff/labels.js';
import { Rota } from '../staff/v36/Rota.js';
import { DateF, DateTimeF, NumF, SelectF, TextF, opts, today, useForm, type Row } from './form.js';

const time = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(iso));
const hm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(iso));
const span = (a: string, b: string) => `${time(a)}–${hm(b)}`;
const hours = (min: number) => `${Math.round((min / 60) * 10) / 10}h`;

type ShiftsView = 'rota' | 'open' | 'swaps' | 'hours' | 'patterns' | 'mine';

/** The Shifts tab: the rota for planners, plus open shifts, swaps, hours and patterns. */
export function ShiftsTab({ view, go }: { view?: string; go: (t: string, v?: string) => void }) {
  const can = useCan();
  const planner = can('jobs.job.view');
  const crew = can('crew.today.view');
  const views: { value: ShiftsView; label: string }[] = [
    ...(planner ? [{ value: 'rota' as const, label: 'Rota' }] : []),
    { value: 'open', label: 'Open shifts' },
    { value: 'swaps', label: 'Swaps' },
    ...(can('jobs.allocate') || can('reports.view')
      ? [{ value: 'hours' as const, label: 'Hours' }]
      : []),
    ...(crew ? [{ value: 'mine' as const, label: 'My hours' }] : []),
    ...(planner ? [{ value: 'patterns' as const, label: 'Patterns' }] : []),
  ];
  const v = views.find((x) => x.value === view)?.value ?? views[0]?.value ?? 'open';
  const openQ = useOne<{ data: Row[] }>('/api/v1/open-shifts');
  const openN = (openQ.data?.data ?? []).filter((r) => r.status === 'OPEN').length;
  const labelled = views.map((x) =>
    x.value === 'open' && openN ? { ...x, label: `Open shifts (${openN})` } : x,
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Deeper>
        <Views label="Shifts view" value={v} onChange={(x) => go('shifts', x)} options={labelled} />
      </Deeper>
      {v === 'rota' && <Rota />}
      {v === 'open' && <OpenShifts />}
      {v === 'swaps' && <Swaps />}
      {v === 'hours' && <Hours />}
      {v === 'mine' && <MyHours />}
      {v === 'patterns' && <Patterns />}
    </div>
  );
}

// ---- open shifts --------------------------------------------------------------------------------
/** v36 words for an open shift: who is off ("Ravi Patel – Off sick"), else the role needed. */
function whatOf(r: Row): string {
  const n = String(r.note ?? '');
  const m = /^(.*?)\s*[–-]\s*off sick/i.exec(n);
  if (m) return `${m[1]} – Off sick`;
  return n || `${ROLE_LABEL[r.role] ?? r.role} needed`;
}
const whenOf = (a: string, b: string) => {
  const d = (x: string) =>
    new Date(x).toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Europe/London',
    });
  const h = (x: string) =>
    new Date(x).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    });
  return `${d(a)} ${h(a)}–${h(b)}`;
};
function OpenShifts() {
  const { api, orgId } = useApp();
  const can = useCan();
  const allocate = can('jobs.allocate');
  const crew = can('crew.today.view');
  const { run, msg } = useRun();
  const q = useOne<{ data: Row[] }>('/api/v1/open-shifts');
  const [posting, setPosting] = useState(false);
  const [filling, setFilling] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const p = useForm({ date: today(), shiftId: '', role: 'CARE_ASSISTANT', note: '' });
  const fill = useForm({ staffId: '' });
  const shifts = useOne<{ data: Row[] }>(
    posting && p.v.date ? `/api/v1/shifts?date=${p.v.date}` : null,
  );
  const staff = useOne<{ data: Row[] }>(filling ? '/api/v1/staff?limit=100' : null);
  const post = (path: string, body?: unknown) => api.send('POST', path, orgId, body ?? {});
  const all = q.data?.data ?? [];
  const open = all.filter((r) => r.status === 'OPEN');
  const [only, setOnly] = useState<'' | 'open' | 'offers'>('');
  const [text, setText] = useState('');
  const rows =
    only === 'open'
      ? open
      : only === 'offers'
        ? open.filter((r) => (r.offers as Row[]).length > 0)
        : all;
  const t = text.trim().toLowerCase();
  const shown = rows
    .filter((r) => !t || `${whatOf(r)} ${r.code} ${r.vehicleLabel}`.toLowerCase().includes(t))
    .sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN'));
  const fillOptions = [
    ...((filling?.offers as Row[]) ?? []).map((o) => ({
      value: o.staffId as string,
      label: `${o.staffName} (offered)`,
    })),
    ...(staff.data?.data ?? [])
      .filter(
        (s) =>
          s.lifecycleState === 'ACTIVE' &&
          !((filling?.offers as Row[]) ?? []).some((o) => o.staffId === s.id),
      )
      .map((s) => ({ value: s.id as string, label: s.displayName as string })),
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {msg}
      <WfCard
        title="Open shifts and cover needed"
        table
        extra={
          allocate && (
            <Button type="primary" icon={<Ms i="add" />} onClick={() => setPosting(true)}>
              Post an open shift
            </Button>
          )
        }
      >
        <div className="pc-tools rec-f in-card">
          <WfSearch value={text} onChange={setText} />
          <WfSelect
            label="Filter by show"
            value={only}
            onChange={setOnly}
            options={[
              { value: '', label: 'Show everything' },
              { value: 'open', label: `Needs cover (${open.length})` },
              {
                value: 'offers',
                label: `Someone offered (${open.filter((r) => (r.offers as Row[]).length > 0).length})`,
              },
            ]}
          />
        </div>
        <DataTable<Row>
          caption="Open shifts"
          rows={shown}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load open shifts.' : null}
          emptyMessage="No open shifts."
          rowTone={(r) => (r.status === 'OPEN' ? 'red' : null)}
          columns={[
            {
              key: 'w',
              header: 'What',
              cell: (r) => (
                <>
                  <b>{whatOf(r)}</b>
                  {(r.offers as Row[]).length > 0 && (
                    <span className="sub">
                      Offered: {(r.offers as Row[]).map((o) => o.staffName).join(', ')}
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 't',
              header: 'When',
              cell: (r) => `${whenOf(r.startsAt, r.endsAt)} on ${r.vehicleLabel as string}`,
            },
            {
              key: 's',
              header: '',
              cell: (r) => {
                const tone: Tone =
                  r.status === 'FILLED' ? 'green' : r.status === 'CANCELLED' ? 'grey' : 'red';
                const text =
                  r.status === 'FILLED'
                    ? `Filled by ${r.filledStaffName ?? 'someone'}`
                    : r.status === 'CANCELLED'
                      ? `Cancelled – ${r.cancelReason}`
                      : r.offeredByMe
                        ? 'You offered'
                        : 'Needs cover';
                return (
                  <WfTag
                    tone={tone}
                    icon={tone === 'green' ? 'check_circle' : tone === 'grey' ? 'block' : 'error'}
                  >
                    {text}
                  </WfTag>
                );
              },
            },
            {
              key: 'a',
              header: '',
              cell: (r) =>
                r.status !== 'OPEN' ? null : allocate ? (
                  <RowActions
                    name={whatOf(r)}
                    primary={{
                      label: 'Find cover',
                      icon: 'person_search',
                      onClick: () => setFilling(r),
                    }}
                    more={[{ label: 'Cancel', icon: 'block', onClick: () => setCancelling(r) }]}
                  />
                ) : crew ? (
                  <RowActions
                    name={whatOf(r)}
                    ghost
                    primary={
                      r.offeredByMe
                        ? {
                            label: 'Withdraw offer',
                            icon: 'undo',
                            onClick: () =>
                              void run(
                                () => post(`/api/v1/open-shifts/${r.id}/withdraw-offer`),
                                'Offer withdrawn',
                              ),
                          }
                        : {
                            label: 'Offer to cover',
                            icon: 'front_hand',
                            onClick: () =>
                              void run(
                                () => post(`/api/v1/open-shifts/${r.id}/offer`),
                                'Offer sent',
                              ),
                          }
                    }
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>
      <ActionDialog
        open={posting}
        title="Post an open shift"
        confirmLabel="Post"
        confirmDisabled={!p.v.shiftId}
        onCancel={() => {
          setPosting(false);
          p.reset();
        }}
        onConfirm={() =>
          post('/api/v1/open-shifts', {
            shiftId: p.v.shiftId,
            role: p.v.role,
            ...(p.v.note.trim() ? { note: p.v.note.trim() } : {}),
          })
        }
        fields={
          <>
            <DateF label="Day" value={p.v.date} onChange={p.set('date')} noPast />
            <SelectF
              label="Shift"
              value={p.v.shiftId}
              options={(shifts.data?.data ?? [])
                .filter((s) => s.state === 'PLANNED')
                .map((s) => ({
                  value: s.id as string,
                  label: `${s.vehicleCallsign} ${span(s.startsAt, s.endsAt)}`,
                }))}
              onChange={p.set('shiftId')}
            />
            <SelectF
              label="Role needed"
              value={p.v.role}
              options={opts(ROLE_LABEL)}
              onChange={p.set('role')}
            />
            <TextF label="Note (optional)" value={p.v.note} onChange={p.set('note')} />
          </>
        }
      />
      <ActionDialog
        open={filling !== null}
        title={`Fill ${filling?.code ?? ''}`}
        confirmLabel="Put on the shift"
        confirmDisabled={!fill.v.staffId}
        onCancel={() => {
          setFilling(null);
          fill.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/open-shifts/${filling!.id}/fill`, { staffId: fill.v.staffId })
        }
        fields={
          <SelectF
            label="Person"
            value={fill.v.staffId}
            options={fillOptions}
            onChange={fill.set('staffId')}
          />
        }
      />
      <ActionDialog
        open={cancelling !== null}
        title="Cancel this open shift"
        confirmLabel="Cancel open shift"
        reasonLabel="Why it is no longer needed"
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => post(`/api/v1/open-shifts/${cancelling!.id}/cancel`, { reason })}
      />
    </div>
  );
}

// ---- swaps --------------------------------------------------------------------------------------
const SWAP_STATUS: Record<string, { tone: Tone; text: string }> = {
  REQUESTED: { tone: 'amber', text: 'Waiting for the colleague' },
  AGREED: { tone: 'blue', text: 'Colleague agreed' },
  DECLINED: { tone: 'grey', text: 'Declined by the colleague' },
  APPROVED: { tone: 'green', text: 'Approved – rota changed' },
  REFUSED: { tone: 'red', text: 'Refused' },
  WITHDRAWN: { tone: 'grey', text: 'Withdrawn' },
};

function Swaps() {
  const { api, orgId } = useApp();
  const can = useCan();
  const crew = can('crew.today.view');
  const { run, msg } = useRun();
  const q = useOne<{ data: Row[] }>('/api/v1/shift-swaps');
  const [asking, setAsking] = useState(false);
  const [deciding, setDeciding] = useState<Row | null>(null);
  const [refusing, setRefusing] = useState<Row | null>(null);
  const options = useOne<{ mine: Row[]; colleagues: Row[] }>(
    asking ? '/api/v1/shift-swaps/options' : null,
  );
  const f = useForm({ from: '', to: '', reason: '' });
  const post = (path: string, body?: unknown) => api.send('POST', path, orgId, body ?? {});
  const label = (o: Row) =>
    `${o.vehicleLabel} ${span(o.startsAt, o.endsAt)} (${ROLE_LABEL[o.role] ?? o.role})`;
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {msg}
      <WfCard
        title="Shift swaps"
        table
        extra={
          crew && (
            <Button type="primary" icon={<Ms i="swap_horiz" />} onClick={() => setAsking(true)}>
              Ask to swap a shift
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Shift swaps"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load swaps.' : null}
          emptyMessage="No swaps asked for."
          columns={[
            {
              key: 's',
              header: 'Swap',
              cell: (r) => (
                <>
                  <b>
                    {r.from.staffName} ↔ {r.to.staffName}
                  </b>
                  <span className="sub">
                    {span(r.from.startsAt, r.from.endsAt)} ↔ {span(r.to.startsAt, r.to.endsAt)}
                  </span>
                </>
              ),
            },
            { key: 'r', header: 'Reason', cell: (r) => r.reason },
            {
              key: 'st',
              header: 'State',
              cell: (r) => (
                <div>
                  <StatusTag tone={SWAP_STATUS[r.status]?.tone ?? 'grey'}>
                    {SWAP_STATUS[r.status]?.text ?? r.status}
                  </StatusTag>
                  {r.decisionNote && (
                    <div>
                      <Mut>{r.decisionNote}</Mut>
                    </div>
                  )}
                  {(r.warnings as string[]).map((w) => (
                    <div key={w}>
                      <StatusTag tone="amber">{w}</StatusTag>
                    </div>
                  ))}
                </div>
              ),
            },
            {
              key: 'a',
              header: '',
              cell: (r) => {
                const acts: {
                  label: string;
                  icon: string;
                  onClick: () => void;
                  danger?: boolean;
                }[] = [];
                if (r.canDecide && r.status === 'AGREED')
                  acts.push({ label: 'Approve', icon: 'check', onClick: () => setDeciding(r) });
                if (r.canAgree) {
                  acts.push({
                    label: 'Agree',
                    icon: 'check',
                    onClick: () =>
                      void run(() => post(`/api/v1/shift-swaps/${r.id}/agree`), 'Agreed'),
                  });
                  acts.push({
                    label: 'Decline',
                    icon: 'close',
                    onClick: () =>
                      void run(() => post(`/api/v1/shift-swaps/${r.id}/decline`), 'Declined'),
                  });
                }
                if (r.canWithdraw)
                  acts.push({
                    label: 'Withdraw',
                    icon: 'undo',
                    onClick: () =>
                      void run(() => post(`/api/v1/shift-swaps/${r.id}/withdraw`), 'Withdrawn'),
                  });
                if (r.canDecide)
                  acts.push({
                    label: 'Refuse',
                    icon: 'block',
                    danger: true,
                    onClick: () => setRefusing(r),
                  });
                if (!acts.length) return null;
                return <RowActions name={r.code} primary={acts[0]} more={acts.slice(1)} />;
              },
            },
          ]}
        />
      </WfCard>
      <ActionDialog
        open={asking}
        title="Ask to swap a shift"
        confirmLabel="Ask"
        confirmDisabled={!f.v.from || !f.v.to || f.v.reason.trim().length < 3}
        onCancel={() => {
          setAsking(false);
          f.reset();
        }}
        onConfirm={() =>
          post('/api/v1/shift-swaps', {
            fromAssignmentId: f.v.from,
            toAssignmentId: f.v.to,
            reason: f.v.reason.trim(),
          })
        }
        fields={
          <>
            <SelectF
              label="My shift"
              value={f.v.from}
              options={(options.data?.mine ?? []).map((o) => ({
                value: o.assignmentId as string,
                label: label(o),
              }))}
              onChange={f.set('from')}
            />
            <SelectF
              label="Their shift"
              value={f.v.to}
              options={(options.data?.colleagues ?? []).map((o) => ({
                value: o.assignmentId as string,
                label: `${o.staffName}: ${label(o)}`,
              }))}
              onChange={f.set('to')}
            />
            <TextF label="Reason" value={f.v.reason} onChange={f.set('reason')} />
          </>
        }
      />
      <ActionDialog
        open={deciding !== null}
        title={`Approve ${deciding?.code ?? ''}`}
        confirmLabel="Approve and change the rota"
        onCancel={() => setDeciding(null)}
        onConfirm={() => post(`/api/v1/shift-swaps/${deciding!.id}/decide`, { approve: true })}
      >
        {deciding && (
          <Typography.Paragraph>
            {deciding.from.staffName} takes {deciding.to.vehicleLabel}{' '}
            {span(deciding.to.startsAt, deciding.to.endsAt)}; {deciding.to.staffName} takes{' '}
            {deciding.from.vehicleLabel} {span(deciding.from.startsAt, deciding.from.endsAt)}.
          </Typography.Paragraph>
        )}
      </ActionDialog>
      <ActionDialog
        open={refusing !== null}
        title={`Refuse ${refusing?.code ?? ''}`}
        confirmLabel="Refuse"
        reasonLabel="Why"
        onCancel={() => setRefusing(null)}
        onConfirm={(note) =>
          post(`/api/v1/shift-swaps/${refusing!.id}/decide`, { approve: false, note })
        }
      />
    </div>
  );
}

// ---- hours --------------------------------------------------------------------------------------
function Hours() {
  const { api, orgId } = useApp();
  const can = useCan();
  const allocate = can('jobs.allocate');
  const [range, setRange] = useState({ from: addDaysLocal(today(), -6), to: today() });
  const q = useOne<Row>(`/api/v1/shift-time/hours?from=${range.from}&to=${range.to}`);
  const [fixing, setFixing] = useState<Row | null>(null);
  const fx = useForm({ clockIn: '', clockOut: '', breakMinutes: 0, reason: '' });
  const people = (q.data?.people as Row[]) ?? [];
  const entries = (q.data?.entries as Row[]) ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Space wrap>
        <DateF
          label="From"
          value={range.from}
          onChange={(from) => setRange((r) => ({ ...r, from }))}
          noFuture
        />
        <DateF label="To" value={range.to} onChange={(to) => setRange((r) => ({ ...r, to }))} />
      </Space>
      {q.isError && <Alert type="error" showIcon message="Choose a range of up to 31 days." />}
      <RuleNote>
        Planned against actual hours from shifts clocked in and out on the crew phone. This is not a
        pay calculation – payroll is outside this system.
      </RuleNote>
      <Card title="By person" size="small">
        <DataTable<Row>
          caption="Planned against actual hours by person"
          rows={people}
          rowKey={(r) => r.staffId}
          loading={q.isLoading}
          emptyMessage="No shifts in this range."
          columns={[
            { key: 'p', header: 'Person', cell: (r) => r.staffName },
            { key: 'n', header: 'Shifts', cell: (r) => String(r.shifts) },
            { key: 'pl', header: 'Planned', cell: (r) => hours(r.plannedMinutes) },
            { key: 'ac', header: 'Actual (after breaks)', cell: (r) => hours(r.actualMinutes) },
            {
              key: 'd',
              header: 'Difference',
              cell: (r) => {
                const d = r.actualMinutes - r.plannedMinutes;
                return `${d > 0 ? '+' : ''}${hours(d)}`;
              },
            },
            {
              key: 'f',
              header: 'Flags',
              cell: (r) => (
                <Space wrap>
                  {r.missing > 0 && <StatusTag tone="red">{r.missing} without clock-out</StatusTag>}
                  {r.overrunShifts > 0 && (
                    <StatusTag tone="amber">{r.overrunShifts} over time</StatusTag>
                  )}
                  {!r.missing && !r.overrunShifts && <StatusTag tone="green">In line</StatusTag>}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Card title="Shifts" size="small">
        <DataTable<Row>
          caption="Shifts with clock-in and clock-out"
          rows={entries}
          rowKey={(r) => r.assignmentId}
          loading={q.isLoading}
          emptyMessage="No shifts in this range."
          columns={[
            { key: 'p', header: 'Person', cell: (r) => r.staffName },
            {
              key: 'v',
              header: 'Shift',
              cell: (r) => `${r.vehicleLabel} ${span(r.plannedStart, r.plannedEnd)}`,
            },
            {
              key: 'a',
              header: 'Actual',
              cell: (r) =>
                r.entry ? (
                  <span>
                    {hm(r.entry.clockIn)}–
                    {r.entry.clockOut ? hm(r.entry.clockOut) : 'still clocked in'}
                    {r.entry.breakMinutes ? ` · ${r.entry.breakMinutes} min breaks` : ''}
                    {r.entry.corrected && (
                      <div>
                        <Mut>Corrected: {r.entry.reason}</Mut>
                      </div>
                    )}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'x',
              header: 'Actions',
              cell: (r) =>
                allocate ? (
                  <Button
                    size="small"
                    onClick={() => {
                      fx.reset();
                      setFixing(r);
                    }}
                  >
                    {r.entry ? 'Correct' : 'Record'}
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={fixing !== null}
        title={`${fixing?.entry ? 'Correct' : 'Record'} hours – ${fixing?.staffName ?? ''}`}
        confirmLabel="Save"
        confirmDisabled={!fx.v.clockIn || !fx.v.clockOut || fx.v.reason.trim().length < 3}
        onCancel={() => setFixing(null)}
        onConfirm={() =>
          api.send('POST', '/api/v1/shift-time/correct', orgId, {
            assignmentId: fixing!.assignmentId,
            clockIn: fx.v.clockIn,
            clockOut: fx.v.clockOut,
            breakMinutes: fx.v.breakMinutes,
            reason: fx.v.reason.trim(),
          })
        }
        fields={
          <>
            <DateTimeF label="Started" value={fx.v.clockIn} onChange={fx.set('clockIn')} />
            <DateTimeF label="Finished" value={fx.v.clockOut} onChange={fx.set('clockOut')} />
            <NumF
              label="Break minutes"
              value={fx.v.breakMinutes}
              max={600}
              onChange={fx.set('breakMinutes')}
            />
            <TextF
              label="Reason (kept with the record)"
              value={fx.v.reason}
              onChange={fx.set('reason')}
            />
          </>
        }
      />
    </div>
  );
}

function addDaysLocal(d: string, n: number) {
  return new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ---- my hours (crew) ----------------------------------------------------------------------------
function MyHours() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const q = useOne<{ data: Row[] }>('/api/v1/shift-time/mine');
  const [out, setOut] = useState<Row | null>(null);
  const br = useForm({ breakMinutes: 0 });
  const now = Date.now();
  return (
    <Card title="My shifts and hours" size="small">
      {msg}
      <DataTable<Row>
        caption="My shifts and hours"
        rows={q.data?.data ?? []}
        rowKey={(r) => r.assignmentId}
        loading={q.isLoading}
        emptyMessage="No shifts in the last two weeks or tomorrow."
        columns={[
          {
            key: 's',
            header: 'Shift',
            cell: (r) => `${r.vehicleLabel} ${span(r.plannedStart, r.plannedEnd)}`,
          },
          {
            key: 'a',
            header: 'Clocked',
            cell: (r) =>
              r.entry
                ? `${hm(r.entry.clockIn)}–${r.entry.clockOut ? hm(r.entry.clockOut) : 'now'}${r.entry.breakMinutes ? ` · ${r.entry.breakMinutes} min breaks` : ''}`
                : '—',
          },
          {
            key: 'x',
            header: 'Actions',
            cell: (r) => {
              const canIn =
                !r.entry &&
                now >= Date.parse(r.plannedStart) - 3_600_000 &&
                now <= Date.parse(r.plannedEnd);
              if (canIn)
                return (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() =>
                      void run(
                        () =>
                          api.send('POST', '/api/v1/shift-time/clock-in', orgId, {
                            assignmentId: r.assignmentId,
                          }),
                        'Clocked in',
                      )
                    }
                  >
                    Clock in
                  </Button>
                );
              if (r.entry && !r.entry.clockOut && r.entry.source === 'CREW_APP')
                return (
                  <Button size="small" onClick={() => setOut(r)}>
                    Clock out
                  </Button>
                );
              return null;
            },
          },
        ]}
      />
      <ActionDialog
        open={out !== null}
        title="Clock out"
        confirmLabel="Clock out"
        onCancel={() => setOut(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/shift-time/${out!.entry.id}/clock-out`, orgId, {
            breakMinutes: br.v.breakMinutes,
          })
        }
        fields={
          <NumF
            label="Breaks taken (minutes)"
            value={br.v.breakMinutes}
            max={600}
            onChange={br.set('breakMinutes')}
          />
        }
      />
    </Card>
  );
}

// ---- patterns -----------------------------------------------------------------------------------
function Patterns() {
  const { api, orgId } = useApp();
  const can = useCan();
  const allocate = can('jobs.allocate');
  const { run, msg } = useRun();
  const q = useOne<{ data: Row[] }>('/api/v1/shift-patterns');
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState<Row | null>(null);
  const [results, setResults] = useState<{ date: string; ok: boolean; text: string }[] | null>(
    null,
  );
  const ap = useForm({ vehicleId: '', from: today(), weeks: 2, staffId: '', role: 'DRIVER' });
  const vehicles = useOne<{ data: Row[] }>(applying ? '/api/v1/vehicles' : null);
  const staff = useOne<{ data: Row[] }>(applying ? '/api/v1/staff?limit=100' : null);
  /**
   * Creates one shift per working day through the planner's own endpoint, so every check (vehicle
   * usable, no double booking, crew rules) applies; a refused day is reported and the rest go on.
   */
  const apply = async () => {
    const p = applying!;
    const v = (vehicles.data?.data ?? []).find((x) => x.id === ap.v.vehicleId);
    if (!v) throw new Error('Choose a vehicle');
    const d = await api.get(
      `/api/v1/shift-patterns/${p.id}/dates?from=${ap.v.from}&weeks=${ap.v.weeks}`,
      orgId,
    );
    const out: { date: string; ok: boolean; text: string }[] = [];
    for (const x of (d as { dates: Row[] }).dates) {
      try {
        await api.send('POST', '/api/v1/shifts', orgId, {
          locationId: v.baseLocationId,
          vehicleId: v.id,
          startsAt: x.startsAt,
          endsAt: x.endsAt,
          crew: ap.v.staffId ? [{ staffId: ap.v.staffId, role: ap.v.role }] : [],
        });
        out.push({ date: x.date, ok: true, text: 'Shift created' });
      } catch (e) {
        out.push({ date: x.date, ok: false, text: errText(e) });
      }
    }
    setResults(out);
  };
  const [preview, setPreview] = useState<Row | null>(null);
  const dates = useOne<{ dates: Row[] }>(
    preview ? `/api/v1/shift-patterns/${preview.id}/dates?from=${today()}&weeks=4` : null,
  );
  const START = (t: string) => (t < '06:00' ? `3${t}` : t);
  const patterns = (q.data?.data ?? [])
    .slice()
    .sort(
      (x, y) =>
        Number(y.active) - Number(x.active) || START(x.startTime).localeCompare(START(y.startTime)),
    );
  const active = patterns.filter((r) => r.active);
  const f = useForm({
    code: '',
    name: '',
    startTime: '07:00',
    endTime: '19:00',
    paidBreakMinutes: 30,
    onDays: 4,
    offDays: 4,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {msg}
      <WfCard
        title="Shift patterns"
        table
        extra={
          allocate && (
            <Space>
              <Button
                size="small"
                type="primary"
                icon={<Ms i="event_repeat" />}
                disabled={!active.length}
                onClick={() => {
                  ap.reset();
                  setResults(null);
                  setApplying(active[0]!);
                }}
              >
                Apply a pattern
              </Button>
            </Space>
          )
        }
      >
        <DataTable<Row>
          caption="Shift patterns"
          rows={patterns}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          emptyMessage="No shift patterns yet."
          columns={[
            {
              key: 'n',
              header: 'Pattern',
              cell: (r) => (
                <>
                  <b>{r.name}</b> ({r.code}){!r.active && <span className="sub">Retired</span>}
                  {r.active && r.restWarning && <span className="sub">{r.restWarning}</span>}
                </>
              ),
            },
            { key: 't', header: 'Times', cell: (r) => `${r.startTime}–${r.endTime}` },
            { key: 'b', header: 'Paid break', cell: (r) => `${r.paidBreakMinutes} min` },
            { key: 'l', header: 'Length', cell: (r) => `${r.lengthHours}h` },
            {
              key: 'a',
              header: '',
              cell: (r) =>
                r.active && allocate ? (
                  <RowActions
                    name={r.name}
                    more={[
                      {
                        label: 'Next 4 weeks',
                        icon: 'calendar_month',
                        onClick: () => setPreview(r),
                      },
                      {
                        label: 'Apply to a vehicle',
                        icon: 'event_repeat',
                        onClick: () => {
                          ap.reset();
                          setResults(null);
                          setApplying(r);
                        },
                      },
                      {
                        label: 'Retire',
                        icon: 'block',
                        onClick: () =>
                          void run(
                            () =>
                              api.send('POST', `/api/v1/shift-patterns/${r.id}/retire`, orgId, {}),
                            'Retired',
                          ),
                      },
                      { label: 'Add a pattern', icon: 'add', onClick: () => setAdding(true) },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>
      {preview && (
        <Card title={`${preview.name}: working days from today`} size="small">
          <Mut>Use these when adding shifts in the planner. Nothing is created here.</Mut>
          <ul>
            {(dates.data?.dates ?? []).map((d) => (
              <li key={d.date}>
                {fmtDate(d.date)}: {fmtDateTime(d.startsAt)} to {fmtDateTime(d.endsAt)}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {results && (
        <Card
          title={`Pattern applied: ${results.filter((r) => r.ok).length} created, ${results.filter((r) => !r.ok).length} refused`}
          size="small"
          extra={
            <Button size="small" onClick={() => setResults(null)}>
              Close
            </Button>
          }
        >
          <ul>
            {results.map((r) => (
              <li key={r.date}>
                {fmtDate(r.date)}: <StatusTag tone={r.ok ? 'green' : 'red'}>{r.text}</StatusTag>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <ActionDialog
        open={applying !== null}
        title={`Apply ${applying?.name ?? ''} to a vehicle`}
        confirmLabel="Create the shifts"
        confirmDisabled={!ap.v.vehicleId || !ap.v.from}
        onCancel={() => setApplying(null)}
        onConfirm={apply}
        fields={
          <>
            <SelectF
              label="Pattern"
              value={applying?.id ?? ''}
              options={active.map((p) => ({
                value: p.id as string,
                label: `${p.name} (${p.code})`,
              }))}
              onChange={(id) => setApplying(active.find((p) => p.id === id) ?? applying)}
            />
            <SelectF
              label="Vehicle"
              value={ap.v.vehicleId}
              options={(vehicles.data?.data ?? []).map((v) => ({
                value: v.id as string,
                label: v.callsign as string,
              }))}
              onChange={ap.set('vehicleId')}
            />
            <DateF label="From" value={ap.v.from} onChange={ap.set('from')} noPast />
            <NumF
              label="Weeks (1 to 12)"
              min={1}
              max={12}
              value={ap.v.weeks}
              onChange={ap.set('weeks')}
            />
            <SelectF
              label="Crew member (optional – add others in the planner)"
              value={ap.v.staffId}
              options={[
                { value: '', label: 'Nobody yet' },
                ...(staff.data?.data ?? [])
                  .filter((x) => x.lifecycleState === 'ACTIVE')
                  .map((x) => ({ value: x.id as string, label: x.displayName as string })),
              ]}
              onChange={ap.set('staffId')}
            />
            {ap.v.staffId && (
              <SelectF
                label="Their role"
                value={ap.v.role}
                options={opts(ROLE_LABEL)}
                onChange={ap.set('role')}
              />
            )}
            <Mut>
              Each day is created with the planner&apos;s checks. A day that clashes or fails a
              check is listed as refused; the others are still created.
            </Mut>
          </>
        }
      />
      <ActionDialog
        open={adding}
        title="Add a shift pattern"
        confirmLabel="Add"
        confirmDisabled={!/^[A-Za-z0-9]{1,6}$/.test(f.v.code) || f.v.name.trim().length < 2}
        onCancel={() => {
          setAdding(false);
          f.reset();
        }}
        onConfirm={() =>
          api.send('POST', '/api/v1/shift-patterns', orgId, {
            ...f.v,
            code: f.v.code.toUpperCase(),
            name: f.v.name.trim(),
          })
        }
        fields={
          <>
            <TextF
              label="Code (up to 6 letters or digits)"
              value={f.v.code}
              onChange={f.set('code')}
            />
            <TextF label="Name" value={f.v.name} onChange={f.set('name')} />
            <TextF label="Start (HH:MM)" value={f.v.startTime} onChange={f.set('startTime')} />
            <TextF label="End (HH:MM)" value={f.v.endTime} onChange={f.set('endTime')} />
            <NumF
              label="Paid break (minutes)"
              value={f.v.paidBreakMinutes}
              max={180}
              onChange={f.set('paidBreakMinutes')}
            />
            <NumF label="Days on" min={1} max={14} value={f.v.onDays} onChange={f.set('onDays')} />
            <NumF
              label="Days off"
              min={0}
              max={14}
              value={f.v.offDays}
              onChange={f.set('offDays')}
            />
          </>
        }
      />
    </div>
  );
}
