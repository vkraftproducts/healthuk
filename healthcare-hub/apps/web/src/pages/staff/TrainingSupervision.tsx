import { londonDate, londonDateTime } from '@hub/rules';
import { DataTable, type StatusKind } from '@hub/ui';
import { Button, Card, Checkbox, Input, Modal, Select, Space } from 'antd';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  fmtDate,
  fmtDateTime,
  useCan,
  useRun,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne, usePeople } from '../settings/hooks.js';
import { ROLE_LABEL, list } from './labels.js';
import { Ms, RowActions, SegTabs, WfCard, WfSearch, WfSelect, WfTag } from '../../v36/ui.js';
import { Who } from '../../v36/kit.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MANAGE = 'staff.profile.manage';

/** The signed-in person's own staff record id, if they have one. */
function useMyStaffId(): string | null {
  const mine = useOne<Row>('/api/v1/staff/me');
  return (mine.data?.profile?.id as string | undefined) ?? null;
}

/** Current (non-leaver) staff for pickers. */
function useCurrentStaff() {
  const res = useOne<{ data: Row[] }>('/api/v1/staff?limit=100');
  return (res.data?.data ?? []).filter((s) => s.lifecycleState !== 'LEAVER');
}

/** A datetime-local value read as London wall-clock time, whatever the browser's zone. */
const toInstant = (v: string) => londonDateTime(v.slice(0, 10), v.slice(11, 16)).toISOString();

// ---- C1: group training -------------------------------------------------------------------------
/**
 * One entry for everyone who attended a group session. Each attendee gets their own training
 * record, awaiting verification like any other; nobody can record their own.
 */
export function GroupTraining() {
  const { api, orgId } = useApp();
  const myStaffId = useMyStaffId();
  const staff = useCurrentStaff();
  const coursesRes = useOne<{ data: Row[] }>('/api/v1/training-courses');
  const courses = (coursesRes.data?.data ?? []).filter((c) => !c.retired);
  const today = londonDate(new Date());
  const [courseId, setCourseId] = useState('');
  const [completedOn, setCompletedOn] = useState(today);
  const [provider, setProvider] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [sessionRef, setSessionRef] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const { run, msg } = useRun();
  const course = courses.find((c) => c.id === courseId);
  const shown = staff.filter(
    (s) =>
      !filter.trim() || String(s.displayName).toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const toggle = (id: string) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/training-records/bulk', orgId, {
          courseId,
          completedOn,
          sessionRef: sessionRef.trim(),
          staffIds: picked,
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          ...(expiresOn ? { expiresOn } : {}),
        }),
      'Training recorded for everyone ticked. Each record awaits verification by HR.',
    );
    if (ok) {
      setPicked([]);
      setSessionRef('');
    }
  }

  return (
    <Section title="Record group training">
      <p className="text-sm">
        Use this after a group session: one entry adds a training record for each person who
        attended. The records are not green until HR verifies them against the register. You cannot
        record your own training.
      </p>
      <form
        className="space-y-3"
        aria-label="Record group training"
        onSubmit={(e) => void submit(e)}
      >
        <Space wrap align="end" size="middle">
          <Field label="Course">
            <Select
              style={{ width: 240 }}
              value={courseId || undefined}
              onChange={setCourseId}
              placeholder="Choose a course"
              options={courses.map((c) => ({ value: c.id as string, label: c.title as string }))}
            />
          </Field>
          <Field label="Session date">
            <Input
              type="date"
              value={completedOn}
              max={today}
              required
              onChange={(e) => setCompletedOn(e.target.value)}
            />
          </Field>
          <Field label="Register reference">
            <Input
              value={sessionRef}
              maxLength={60}
              required
              onChange={(e) => setSessionRef(e.target.value)}
            />
          </Field>
          <Field label="Provider (optional)">
            <Input value={provider} maxLength={120} onChange={(e) => setProvider(e.target.value)} />
          </Field>
          <Field label="Expiry (optional)">
            <Input
              type="date"
              value={expiresOn}
              min={completedOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        </Space>
        {course && !expiresOn && (
          <p className="text-sm">
            {course.intervalMonths
              ? `Left blank, the expiry is worked out from the course interval (every ${course.intervalMonths} months).`
              : 'This course does not expire.'}
          </p>
        )}
        <Card size="small" title={`Attendees (${picked.length} ticked, up to 100)`}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Field label="Find a person">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 260 }}
              />
            </Field>
            {shown.length === 0 && <p className="text-sm">Nobody matches.</p>}
            <ul className="grid gap-1 sm:grid-cols-2" aria-label="Attendees">
              {shown.map((s) =>
                s.id === myStaffId ? (
                  <li key={s.id} className="text-sm text-slate-700">
                    {s.displayName} (you – someone else records your training)
                  </li>
                ) : (
                  <li key={s.id}>
                    <Checkbox checked={picked.includes(s.id)} onChange={() => toggle(s.id)}>
                      {s.displayName}
                      {s.roles?.length ? ` – ${list(s.roles, ROLE_LABEL)}` : ''}
                    </Checkbox>
                  </li>
                ),
              )}
            </ul>
          </Space>
        </Card>
        <Button
          type="primary"
          htmlType="submit"
          disabled={!courseId || !sessionRef.trim() || picked.length === 0 || picked.length > 100}
        >
          Record training for {picked.length} {picked.length === 1 ? 'person' : 'people'}
        </Button>
      </form>
      {msg}
    </Section>
  );
}

/** Training records awaiting a second person to verify against the register (UK-36). */
export function VerifyTrainingRecords() {
  const { api, orgId, me } = useApp();
  const queue = useOne<{ data: Row[] }>('/api/v1/training-records/awaiting-verification');
  const [pick, setPick] = useState<Row | null>(null);
  const { run, msg } = useRun();
  const rows = queue.data?.data ?? [];

  return (
    <Section title="Verify training records">
      <p className="text-sm">
        Each record was added after a group session or from a staff file. Someone other than whoever
        recorded it must confirm the register. This does not replace verified certificate evidence
        on a requirement.
      </p>
      <DataTable<Row>
        caption="Awaiting verification"
        rows={rows}
        rowKey={(r) => r.id}
        loading={queue.isLoading}
        emptyMessage="No training records are waiting."
        columns={[
          { key: 'p', header: 'Person', cell: (r) => r.staffName },
          { key: 'c', header: 'Course', cell: (r) => `${r.title} (${r.courseCode})` },
          { key: 'd', header: 'Completed', cell: (r) => fmtDate(r.completedOn) },
          { key: 's', header: 'Register ref', cell: (r) => r.sessionRef ?? '—' },
          {
            key: 'b',
            header: 'Recorded by',
            cell: (r) =>
              r.recordedBy === me.user.id ? (
                <span>You recorded this — someone else must verify</span>
              ) : (
                r.recordedByName
              ),
          },
          {
            key: 'a',
            header: 'Action',
            cell: (r) =>
              r.recordedBy === me.user.id ? null : (
                <Button
                  size="small"
                  aria-label={`Verify training for ${r.staffName}`}
                  onClick={() => setPick(r)}
                >
                  Verify
                </Button>
              ),
          },
        ]}
      />
      <ActionDialog
        open={pick !== null}
        title={pick ? `Verify training: ${pick.staffName}` : ''}
        confirmLabel="Verify against register"
        onCancel={() => setPick(null)}
        onConfirm={async () => {
          if (!pick) return;
          const ok = await run(
            () =>
              api.send('POST', `/api/v1/training-records/${pick.id}/verify`, orgId, {
                ...(pick.sessionRef ? { registerRef: pick.sessionRef } : {}),
              }),
            'Training record verified.',
          );
          if (ok) setPick(null);
        }}
      >
        {pick && (
          <p>
            {pick.title} on {fmtDate(pick.completedOn)}
            {pick.sessionRef ? ` · register ${pick.sessionRef}` : ''}. Confirm you have checked the
            signed register for {pick.staffName}.
          </p>
        )}
      </ActionDialog>
      {msg}
    </Section>
  );
}

// ---- C2: supervision bookings -------------------------------------------------------------------
export const SUPERVISION_KIND: Record<string, string> = {
  ONE_TO_ONE: 'One to one',
  CLINICAL: 'Clinical supervision',
  RETURN_TO_WORK: 'Return to work',
  PROBATION_REVIEW: 'Probation review',
};

export function bookingBadge(b: Row, now = Date.now()): { status: StatusKind; reason: string } {
  switch (b.status) {
    case 'HELD':
      return { status: 'GREEN', reason: 'Held, record written' };
    case 'CANCELLED':
      return {
        status: 'GREY',
        reason: `Cancelled: ${b.statusReason ?? 'no reason given'}${b.rebookedAs ? ' (rebooked)' : ''}`,
      };
    case 'MISSED':
      return {
        status: 'RED',
        reason: `Missed: ${b.statusReason ?? 'no reason given'}${b.rebookedAs ? ' (rebooked)' : ''}`,
      };
    default:
      return new Date(b.scheduledAt).getTime() < now
        ? { status: 'AMBER', reason: 'Booked, date has passed: record what happened' }
        : { status: 'AMBER', reason: 'Booked' };
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** London day of a date or instant, as v36 writes it: "8 Sep" / "8 Sep 2026" (never "Sept"). */
const ldParts = (iso: string) => {
  const x = iso.length === 10 ? iso : londonDate(new Date(iso));
  return { d: Number(x.slice(8, 10)), m: MON[Number(x.slice(5, 7)) - 1]!, y: x.slice(0, 4) };
};
const dmy = (iso: string) => {
  const p = ldParts(iso);
  return `${p.d} ${p.m} ${p.y}`;
};
const dmShort = (iso: string) => {
  const p = ldParts(iso);
  return `${p.d} ${p.m}`;
};

/** v36 status pill for a booking, with its words (also used by the status filter). */
function bookingTag(b: Row): {
  tone: 'blue' | 'green' | 'red' | 'grey' | 'amber';
  icon: string;
  text: string;
} {
  switch (b.status) {
    case 'REQUESTED':
      return {
        tone: 'amber',
        icon: 'schedule',
        text: `Requested by ${b.requestedByName ?? b.staffName ?? 'staff'}`,
      };
    case 'HELD':
      return { tone: 'green', icon: 'check_circle', text: 'Held' };
    case 'CANCELLED':
      return { tone: 'grey', icon: 'block', text: 'Cancelled' };
    case 'MISSED':
      return b.rebookedAs
        ? { tone: 'grey', icon: 'event_repeat', text: 'Missed – rebooked' }
        : {
            tone: 'red',
            icon: 'error',
            text: `Missed – rebook by ${dmShort(new Date(Date.parse(b.scheduledAt) + 14 * 86_400_000).toISOString())}`,
          };
    default:
      return Date.parse(b.scheduledAt) < Date.now()
        ? { tone: 'amber', icon: 'schedule', text: 'Booked – record what happened' }
        : { tone: 'blue', icon: 'hourglass_top', text: 'Booked' };
  }
}

/** v36 Supervision: Bookings and Next due (every 8 weeks from the last one held). */
export function SupervisionBookings() {
  const { me, api, orgId } = useApp();
  const can = useCan();
  const manage = can(MANAGE);
  const myStaffId = useMyStaffId();
  const [view, setView] = useState<'book' | 'due'>('book');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [closing, setClosing] = useState<Row | null>(null);
  const [booking, setBooking] = useState<{ staffId?: string } | null>(null);
  const [confirming, setConfirming] = useState<Row | null>(null);
  const [confirmSup, setConfirmSup] = useState('');
  const [confirmAt, setConfirmAt] = useState('');
  const people = usePeople();
  const res = useOne<{ data: Row[] }>('/api/v1/supervision-bookings');
  const nextQ = useOne<{ data: Row[] }>('/api/v1/supervision/next-due');
  const all = res.data?.data ?? [];
  const toAction =
    all.filter((b) => b.status === 'REQUESTED').length +
    all.filter((b) => b.status === 'BOOKED' && Date.parse(b.scheduledAt) < Date.now()).length +
    all.filter((b) => b.status === 'MISSED' && !b.rebookedAs).length;
  const canClose = (r: Row) =>
    r.status === 'BOOKED' &&
    !(myStaffId && r.staffId === myStaffId) &&
    (r.supervisorUserId === me.user.id || manage);

  // Next due (server): 8 weeks after the last supervision held, with the escalation words.
  const due = (nextQ.data?.data ?? []).map((x) => {
    const s = { id: x.staffId as string, displayName: x.staffName as string, jobTitle: x.jobTitle };
    const late = x.overdueDays as number | null;
    const e = x.escalation as { stage: string; toName: string | null } | null;
    const esc = !e
      ? ''
      : e.stage === 'MANAGER' && e.toName
        ? ` · Escalated to ${e.toName}`
        : ' · Escalated to lead';
    const tag = x.bookedAt
      ? {
          tone: 'green' as const,
          icon: 'check_circle',
          text: `Booked ${dmShort(x.bookedAt as string)}`,
        }
      : late !== null && late > 0
        ? {
            tone: 'red' as const,
            icon: 'error',
            text: `${late} day${late === 1 ? '' : 's'} overdue${esc}`,
          }
        : late !== null && late > -7
          ? {
              tone: 'amber' as const,
              icon: 'schedule',
              text: late === 0 ? 'Due today' : `Due in ${-late} day${late === -1 ? '' : 's'}`,
            }
          : x.nextDueOn
            ? {
                tone: 'grey' as const,
                icon: 'radio_button_unchecked',
                text: `Due ${dmShort(x.nextDueOn as string)}`,
              }
            : { tone: 'red' as const, icon: 'error', text: 'None held yet' };
    return {
      s,
      heldOn: x.lastHeldOn as string | null,
      nextOn: x.nextDueOn as string | null,
      tag,
    };
  });
  const overdue = due.filter((d) => d.tag.tone === 'red').length;

  const t = q.trim().toLowerCase();
  const match = (txt: string) => !t || txt.toLowerCase().includes(t);
  const bookRows = all.filter(
    (r) =>
      match(`${r.staffName} ${r.supervisorName} ${r.topics ?? ''}`) &&
      (!status || bookingTag(r).text === status),
  );
  const dueRows = due.filter(
    (d) => match(`${d.s.displayName} ${d.s.jobTitle ?? ''}`) && (!status || d.tag.text === status),
  );
  const statusOptions = (texts: string[]) => {
    const counts = new Map<string, number>();
    texts.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
    return [
      { value: '', label: 'All statuses' },
      ...[...counts].map(([k, n]) => ({ value: k, label: `${k} (${n})` })),
    ];
  };

  return (
    <>
      <SegTabs
        label="Supervision"
        current={view}
        onChange={(v) => {
          setView(v);
          setStatus('');
        }}
        options={[
          {
            id: 'book',
            label: 'Bookings',
            icon: 'event_note',
            count: all.length,
            ...(toAction ? { flag: { text: `${toAction} to action`, tone: 'am' as const } } : {}),
          },
          {
            id: 'due',
            label: 'Next due',
            icon: 'event_upcoming',
            count: due.length,
            ...(overdue ? { flag: { text: `${overdue} overdue`, tone: 'rd' as const } } : {}),
          },
        ]}
      />
      {view === 'book' ? (
        <WfCard
          title="Bookings"
          table
          extra={
            manage ? (
              <Button type="primary" icon={<Ms i="event" />} onClick={() => setBooking({})}>
                Book supervision
              </Button>
            ) : undefined
          }
        >
          <div className="pc-tools rec-f in-card">
            <WfSearch value={q} onChange={setQ} />
            <WfSelect
              label="Filter by status"
              value={status}
              onChange={setStatus}
              options={statusOptions(all.map((r) => bookingTag(r).text))}
            />
          </div>
          <DataTable<Row>
            caption="Supervision bookings"
            rows={bookRows}
            rowKey={(r) => r.id}
            loading={res.isLoading}
            error={res.isError ? 'Could not load supervision bookings.' : null}
            emptyMessage="No supervision bookings."
            rowTone={(r) => {
              const tg = bookingTag(r);
              return tg.tone === 'red' || r.status === 'REQUESTED'
                ? tg.tone === 'red'
                  ? 'red'
                  : 'amber'
                : tg.tone === 'amber'
                  ? 'amber'
                  : null;
            }}
            columns={[
              {
                key: 'p',
                header: 'Person',
                cell: (r) => (
                  <>
                    <b>{r.staffName}</b>
                    {r.code && <span className="sub">{r.code}</span>}
                  </>
                ),
              },
              { key: 'k', header: 'Type', cell: (r) => SUPERVISION_KIND[r.kind] ?? 'Other' },
              {
                key: 's',
                header: 'Supervisor',
                cell: (r) =>
                  r.supervisorName ? (
                    r.supervisorName
                  ) : (
                    <span className="wf-mut">To be confirmed</span>
                  ),
              },
              { key: 'w', header: 'When', cell: (r) => dmy(r.scheduledAt) },
              {
                key: 't',
                header: 'Topics / outcome',
                cell: (r) => (
                  <>
                    {r.topics ?? '—'}
                    {r.statusReason && (
                      <span className="sub">
                        {r.status === 'HELD' ? 'Outcome' : 'Reason'}: {r.statusReason}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'st',
                header: 'Status',
                cell: (r) => {
                  const tg = bookingTag(r);
                  return (
                    <WfTag tone={tg.tone} icon={tg.icon}>
                      {tg.text}
                    </WfTag>
                  );
                },
              },
              {
                key: 'a',
                header: '',
                cell: (r) =>
                  manage && r.status === 'REQUESTED' ? (
                    <RowActions
                      name={r.staffName}
                      primary={{
                        label: 'Confirm',
                        icon: 'event_available',
                        onClick: () => {
                          setConfirmSup('');
                          setConfirmAt(r.scheduledAt.slice(0, 16));
                          setConfirming(r);
                        },
                      }}
                    />
                  ) : canClose(r) ? (
                    <RowActions
                      name={r.staffName}
                      primary={{
                        label: 'Record outcome',
                        icon: 'edit_note',
                        onClick: () => setClosing(r),
                      }}
                    />
                  ) : r.status === 'MISSED' && !r.rebookedAs && manage ? (
                    <RowActions
                      name={r.staffName}
                      primary={{
                        label: 'Rebook',
                        icon: 'event_repeat',
                        onClick: () => setBooking({ staffId: r.staffId }),
                      }}
                    />
                  ) : myStaffId && r.staffId === myStaffId && r.status === 'BOOKED' ? (
                    <span className="wf-mut">Your supervisor records this.</span>
                  ) : null,
              },
            ]}
          />
        </WfCard>
      ) : (
        <WfCard
          title="Next due"
          table
          extra={<span className="wf-mini">Every 8 weeks from the last supervision held</span>}
        >
          <div className="pc-tools rec-f in-card">
            <WfSearch value={q} onChange={setQ} />
            <WfSelect
              label="Filter by status"
              value={status}
              onChange={setStatus}
              options={statusOptions(due.map((d) => d.tag.text))}
            />
          </div>
          <DataTable<(typeof due)[number]>
            caption="Supervision next due"
            rows={dueRows}
            rowKey={(d) => d.s.id}
            loading={nextQ.isLoading}
            emptyMessage="Nobody to show."
            rowTone={(d) => (d.tag.tone === 'red' ? 'red' : null)}
            columns={[
              { key: 'p', header: 'Person', cell: (d) => <Who name={d.s.displayName} /> },
              { key: 'r', header: 'Role', cell: (d) => d.s.jobTitle ?? '—' },
              {
                key: 'l',
                header: 'Last held',
                cell: (d) => (d.heldOn ? dmy(d.heldOn) : '—'),
              },
              {
                key: 'n',
                header: 'Next due',
                cell: (d) => (d.nextOn ? dmy(d.nextOn) : '—'),
              },
              {
                key: 's',
                header: 'Status',
                cell: (d) => (
                  <WfTag tone={d.tag.tone} icon={d.tag.icon}>
                    {d.tag.text}
                  </WfTag>
                ),
              },
              {
                key: 'a',
                header: '',
                cell: (d) =>
                  manage && d.tag.tone !== 'green' ? (
                    <RowActions
                      name={d.s.displayName}
                      primary={{
                        label: 'Book',
                        icon: 'event',
                        onClick: () => setBooking({ staffId: d.s.id }),
                      }}
                    />
                  ) : null,
              },
            ]}
          />
        </WfCard>
      )}
      <Modal
        open={booking !== null}
        title="Book supervision"
        footer={null}
        onCancel={() => setBooking(null)}
        width={760}
        destroyOnHidden
      >
        <BookSupervision myStaffId={myStaffId} initialStaffId={booking?.staffId} />
      </Modal>
      {closing && <CloseBooking booking={closing} onClose={() => setClosing(null)} />}
      <ActionDialog
        open={!!confirming}
        title={`Confirm supervision – ${confirming?.staffName ?? ''}`}
        confirmLabel="Confirm booking"
        confirmDisabled={!confirmSup || !confirmAt}
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          await api.send(
            'POST',
            `/api/v1/supervision-bookings/${confirming!.id as string}/confirm`,
            orgId,
            {
              supervisorUserId: confirmSup,
              scheduledAt: toInstant(confirmAt),
            },
          );
          setConfirming(null);
        }}
        fields={
          <>
            <PersonSelect
              label="Supervisor"
              value={confirmSup}
              onChange={setConfirmSup}
              people={people}
              meId={me.user.id}
            />
            <Field label="When">
              <Input
                type="datetime-local"
                value={confirmAt}
                onChange={(e) => setConfirmAt(e.target.value)}
              />
            </Field>
          </>
        }
      />
    </>
  );
}

function BookSupervision({
  myStaffId,
  initialStaffId,
}: {
  myStaffId: string | null;
  initialStaffId?: string;
}) {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const staff = useCurrentStaff();
  const [staffId, setStaffId] = useState(initialStaffId ?? '');
  const [supervisor, setSupervisor] = useState(me.user.id);
  const [at, setAt] = useState('');
  const [kind, setKind] = useState('ONE_TO_ONE');
  const [topics, setTopics] = useState('');
  const { run, msg } = useRun();
  const person = staff.find((s) => s.id === staffId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', `/api/v1/staff/${staffId}/supervision-bookings`, orgId, {
          supervisorUserId: supervisor,
          scheduledAt: toInstant(at),
          kind,
          ...(topics.trim() ? { topics: topics.trim() } : {}),
        }),
      `Supervision booked${person ? ` for ${person.displayName}` : ''}.`,
    );
    if (ok) {
      setAt('');
      setTopics('');
    }
  }
  return (
    <Section title="Book a supervision">
      <form aria-label="Book a supervision" onSubmit={(e) => void submit(e)}>
        <Space wrap align="end" size="middle">
          <Field label="Person">
            <Select
              style={{ width: 220 }}
              value={staffId || undefined}
              onChange={setStaffId}
              placeholder="Choose a person"
              options={staff
                .filter((s) => s.id !== myStaffId)
                .map((s) => ({ value: s.id as string, label: s.displayName as string }))}
            />
          </Field>
          <PersonSelect
            label="Supervisor"
            value={supervisor}
            onChange={setSupervisor}
            people={people}
            meId={me.user.id}
          />
          <Field label="Date and time">
            <Input
              type="datetime-local"
              value={at}
              required
              onChange={(e) => setAt(e.target.value)}
            />
          </Field>
          <Field label="Type">
            <Select
              style={{ width: 200 }}
              value={kind}
              onChange={setKind}
              options={Object.entries(SUPERVISION_KIND).map(([k, v]) => ({ value: k, label: v }))}
            />
          </Field>
          <Field label="Topics (optional, no patient details)">
            <Input.TextArea
              rows={2}
              maxLength={1000}
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              style={{ width: 320 }}
            />
          </Field>
          <Button type="primary" htmlType="submit" disabled={!staffId || !supervisor || !at}>
            Book supervision
          </Button>
        </Space>
      </form>
      {msg}
    </Section>
  );
}

function CloseBooking({ booking, onClose }: { booking: Row; onClose: () => void }) {
  const { api, orgId } = useApp();
  const [outcome, setOutcome] = useState('HELD');
  const [attended, setAttended] = useState(true);
  const [wellbeing, setWellbeing] = useState(false);
  const [concerns, setConcerns] = useState('');
  const [actions, setActions] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [rebookAt, setRebookAt] = useState('');
  const held = outcome === 'HELD';
  return (
    <ActionDialog
      open
      title={`Record outcome: ${booking.staffName}`}
      confirmLabel="Save outcome"
      reasonLabel={held ? 'Summary of the session' : 'Why it did not go ahead'}
      reasonRequired={!held}
      onCancel={onClose}
      fields={
        <>
          <p className="text-sm">
            {SUPERVISION_KIND[booking.kind] ?? 'Supervision'} with {booking.supervisorName},{' '}
            {fmtDateTime(booking.scheduledAt)}.
          </p>
          <Field label="What happened?">
            <Select
              value={outcome}
              onChange={setOutcome}
              options={[
                { value: 'HELD', label: 'It was held' },
                { value: 'CANCELLED', label: 'It was cancelled' },
                { value: 'MISSED', label: 'It was missed' },
              ]}
            />
          </Field>
          {held ? (
            <>
              <Checkbox checked={attended} onChange={(e) => setAttended(e.target.checked)}>
                {booking.staffName} attended
              </Checkbox>
              <Checkbox checked={wellbeing} onChange={(e) => setWellbeing(e.target.checked)}>
                Wellbeing check done
              </Checkbox>
              <Field label="Competence concerns (optional)">
                <Input.TextArea
                  rows={2}
                  maxLength={1000}
                  value={concerns}
                  onChange={(e) => setConcerns(e.target.value)}
                />
              </Field>
              <Field label="Agreed actions (optional)">
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  value={actions}
                  onChange={(e) => setActions(e.target.value)}
                />
              </Field>
              <Field label="Next supervision due (optional)">
                <Input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label="Rebook for (optional)">
              <Input
                type="datetime-local"
                value={rebookAt}
                onChange={(e) => setRebookAt(e.target.value)}
              />
            </Field>
          )}
        </>
      }
      onConfirm={(text) =>
        api.send(
          'POST',
          `/api/v1/supervision-bookings/${booking.id}/close`,
          orgId,
          held
            ? {
                status: 'HELD',
                attended,
                wellbeingChecked: wellbeing,
                ...(text ? { summary: text } : {}),
                ...(concerns.trim() ? { competenceConcerns: concerns.trim() } : {}),
                ...(actions.trim() ? { agreedActions: actions.trim() } : {}),
                ...(nextDue ? { nextDueOn: nextDue } : {}),
              }
            : {
                status: outcome,
                reason: text,
                ...(rebookAt ? { rebookAt: toInstant(rebookAt) } : {}),
              },
          booking.version,
        )
      }
    >
      <p>
        A held supervision writes a record on {booking.staffName}&rsquo;s file that cannot be
        changed; they can then agree with it or comment.
      </p>
    </ActionDialog>
  );
}

// ---- v36 planned training sessions ------------------------------------------------------------
/** Planned sessions (invite who is due) before attendance becomes a group session to verify. */
export function PlannedSessions() {
  const { api, orgId, me } = useApp();
  const manage = me.permissions.includes(MANAGE);
  const invalidate = useInvalidate();
  const plans = useOne<{ data: Row[] }>('/api/v1/training-plans');
  const courses = useOne<{ data: Row[] }>(manage ? '/api/v1/training-courses' : null);
  const [planning, setPlanning] = useState(false);
  const [courseCode, setCourseCode] = useState('TR-BLS');
  const [plannedOn, setPlannedOn] = useState('');
  const [places, setPlaces] = useState(8);
  const [inviteDue, setInviteDue] = useState(true);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dShort = (d: string) =>
    `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
  const statusTag = (r: Row) => {
    if (r.status === 'CANCELLED')
      return (
        <WfTag tone="grey" icon="block">
          Cancelled
        </WfTag>
      );
    if (r.status === 'HELD')
      return (
        <WfTag tone="green" icon="check_circle">
          Held
        </WfTag>
      );
    const n = r.daysUntil as number;
    if (n < 0)
      return (
        <WfTag tone="amber" icon="schedule">
          Planned {-n} day{n === -1 ? '' : 's'} ago
        </WfTag>
      );
    if (n === 0)
      return (
        <WfTag tone="blue" icon="hourglass_top">
          Planned today
        </WfTag>
      );
    return (
      <WfTag tone="blue" icon="hourglass_top">
        Planned in {n} day{n === 1 ? '' : 's'}
      </WfTag>
    );
  };
  return (
    <WfCard
      title="Planned sessions"
      table
      extra={
        manage && (
          <Button
            type="primary"
            size="small"
            icon={<Ms i="event" />}
            onClick={() => {
              setPlannedOn(londonDate(new Date()));
              setPlanning(true);
            }}
          >
            Plan a session
          </Button>
        )
      }
    >
      <DataTable<Row>
        caption="Planned sessions"
        rows={plans.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={plans.isLoading}
        error={plans.isError ? 'Could not load planned sessions.' : null}
        emptyMessage="No sessions are planned."
        columns={[
          {
            key: 's',
            header: 'Session',
            cell: (r) => (
              <>
                <b>{r.courseTitle}</b>
                <span className="sub">
                  {r.code} · {dShort(r.plannedOn)} · {(r.invitedNames as string[]).length} of{' '}
                  {r.places} places
                </span>
              </>
            ),
          },
          {
            key: 'i',
            header: 'Invited',
            cell: (r) =>
              (r.invitedNames as string[]).length
                ? (r.invitedNames as string[]).join(', ')
                : '—',
          },
          { key: 'st', header: 'Status', cell: (r) => statusTag(r) },
          {
            key: 'a',
            header: '',
            cell: (r) =>
              manage && r.status === 'PLANNED' ? (
                <RowActions
                  name={r.courseTitle}
                  ghost
                  primary={{
                    label: 'Invite who is due',
                    icon: 'group_add',
                    onClick: async () => {
                      await api.send(
                        'POST',
                        `/api/v1/training-plans/${r.id as string}/invite-due`,
                        orgId,
                        {},
                      );
                      void invalidate();
                    },
                  }}
                  more={[
                    {
                      label: 'Cancel session',
                      icon: 'block',
                      danger: true,
                      onClick: async () => {
                        await api.send(
                          'POST',
                          `/api/v1/training-plans/${r.id as string}/cancel`,
                          orgId,
                          {},
                        );
                        void invalidate();
                      },
                    },
                  ]}
                />
              ) : null,
          },
        ]}
      />
      <ActionDialog
        open={planning}
        title="Plan a training session"
        confirmLabel="Plan session"
        confirmDisabled={!courseCode || !plannedOn || places < 1}
        onCancel={() => setPlanning(false)}
        onConfirm={async () => {
          await api.send('POST', '/api/v1/training-plans', orgId, {
            courseCode,
            plannedOn,
            places,
            inviteDue,
          });
          setPlanning(false);
          void invalidate();
        }}
        fields={
          <>
            <Field label="Course">
              <Select
                style={{ width: '100%' }}
                value={courseCode}
                options={(courses.data?.data ?? []).map((c) => ({
                  value: c.code as string,
                  label: `${c.title} (${c.code})`,
                }))}
                onChange={setCourseCode}
              />
            </Field>
            <Field label="Date">
              <Input type="date" value={plannedOn} onChange={(e) => setPlannedOn(e.target.value)} />
            </Field>
            <Field label="Places">
              <Input
                type="number"
                min={1}
                max={200}
                value={places}
                onChange={(e) => setPlaces(Number(e.target.value) || 1)}
              />
            </Field>
            <Checkbox checked={inviteDue} onChange={(e) => setInviteDue(e.target.checked)}>
              Invite everyone who is due, overdue or missing this course
            </Checkbox>
          </>
        }
      />
    </WfCard>
  );
}

// ---- v36 group training sessions --------------------------------------------------------------
/** Group sessions waiting for a second person to check the signed register. */
export function GroupSessions() {
  const { api, orgId, me } = useApp();
  const queue = useOne<{ data: Row[] }>('/api/v1/training-records/awaiting-verification');
  const [recording, setRecording] = useState(false);
  const [pick, setPick] = useState<Row[] | null>(null);
  const { run, msg } = useRun();
  const groups = new Map<string, Row[]>();
  for (const r of queue.data?.data ?? []) {
    const k = `${r.sessionRef ?? r.id}|${r.courseCode}|${r.completedOn}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows = [...groups.values()];
  return (
    <WfCard
      title="Group training sessions"
      table
      extra={
        <Button type="primary" icon={<Ms i="groups" />} onClick={() => setRecording(true)}>
          Record a group session
        </Button>
      }
    >
      <DataTable<Row[]>
        caption="Group training sessions"
        rows={rows}
        rowKey={(g) => g[0]!.id}
        loading={queue.isLoading}
        emptyMessage="No group sessions are waiting for verification."
        columns={[
          {
            key: 'c',
            header: 'Course',
            cell: (g) => (
              <>
                <b>{g[0]!.title}</b>
                <span className="sub">
                  {[fmtDate(g[0]!.completedOn), g[0]!.provider].filter(Boolean).join(' · ')}
                </span>
              </>
            ),
          },
          { key: 'a', header: 'Attendees', cell: (g) => g.map((r) => r.staffName).join(', ') },
          { key: 'r', header: 'Register', cell: (g) => g[0]!.sessionRef ?? '—' },
          {
            key: 'b',
            header: 'Recorded by',
            cell: (g) => (
              <>
                {g[0]!.recordedByName}
                <span className="sub">{fmtDateTime(g[0]!.createdAt)}</span>
              </>
            ),
          },
          {
            key: 's',
            header: 'Status',
            cell: () => (
              <WfTag tone="blue" icon="hourglass_top">
                Awaiting verification
              </WfTag>
            ),
          },
          {
            key: 'x',
            header: '',
            cell: (g) =>
              g[0]!.recordedBy === me.user.id ? (
                <span className="wf-mut">You recorded this</span>
              ) : (
                <RowActions
                  name={g[0]!.title}
                  primary={{ label: 'Verify all', icon: 'verified', onClick: () => setPick(g) }}
                />
              ),
          },
        ]}
      />
      <ActionDialog
        open={pick !== null}
        title={pick ? `Verify ${pick[0]!.title}` : ''}
        confirmLabel="Verify against register"
        onCancel={() => setPick(null)}
        onConfirm={async () => {
          const g = pick!;
          const ok = await run(async () => {
            for (const r of g)
              await api.send('POST', `/api/v1/training-records/${r.id}/verify`, orgId, {
                ...(r.sessionRef ? { registerRef: r.sessionRef } : {}),
              });
          }, 'Training records verified.');
          if (ok) setPick(null);
        }}
      >
        {pick && (
          <p>
            Confirm you have checked the signed register
            {pick[0]!.sessionRef ? ` ${pick[0]!.sessionRef}` : ''} for{' '}
            {pick.map((r) => r.staffName).join(', ')}.
          </p>
        )}
      </ActionDialog>
      <Modal
        open={recording}
        title="Record a group session"
        footer={null}
        onCancel={() => setRecording(false)}
        width={820}
        destroyOnHidden
      >
        <GroupTraining />
      </Modal>
      {msg}
    </WfCard>
  );
}
