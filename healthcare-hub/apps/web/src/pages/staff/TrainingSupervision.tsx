import { londonDate, londonDateTime } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  button,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  useRun,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { ROLE_LABEL, list } from './labels.js';

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
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Course">
            <select
              className={input}
              value={courseId}
              required
              onChange={(e) => setCourseId(e.target.value)}
            >
              <option value="">Choose a course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Session date">
            <input
              type="date"
              className={input}
              value={completedOn}
              max={today}
              required
              onChange={(e) => setCompletedOn(e.target.value)}
            />
          </Field>
          <Field label="Register reference">
            <input
              className={input}
              value={sessionRef}
              maxLength={60}
              required
              onChange={(e) => setSessionRef(e.target.value)}
            />
          </Field>
          <Field label="Provider (optional)">
            <input
              className={input}
              value={provider}
              maxLength={120}
              onChange={(e) => setProvider(e.target.value)}
            />
          </Field>
          <Field label="Expiry (optional)">
            <input
              type="date"
              className={input}
              value={expiresOn}
              min={completedOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        </div>
        {course && !expiresOn && (
          <p className="text-sm">
            {course.intervalMonths
              ? `Left blank, the expiry is worked out from the course interval (every ${course.intervalMonths} months).`
              : 'This course does not expire.'}
          </p>
        )}
        <fieldset className="space-y-2 rounded border border-hub-line p-3">
          <legend className="text-sm font-semibold">
            Attendees ({picked.length} ticked, up to 100)
          </legend>
          <Field label="Find a person">
            <input
              className={`${input} w-64`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
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
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={picked.includes(s.id)}
                      onChange={() => toggle(s.id)}
                    />
                    {s.displayName}
                    {s.roles?.length ? ` – ${list(s.roles, ROLE_LABEL)}` : ''}
                  </label>
                </li>
              ),
            )}
          </ul>
        </fieldset>
        <button
          type="submit"
          className={button}
          disabled={!courseId || !sessionRef.trim() || picked.length === 0 || picked.length > 100}
        >
          Record training for {picked.length} {picked.length === 1 ? 'person' : 'people'}
        </button>
      </form>
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
const BOOKING_STATUS: Record<string, string> = {
  BOOKED: 'Booked',
  HELD: 'Held',
  CANCELLED: 'Cancelled',
  MISSED: 'Missed',
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

export function SupervisionBookings() {
  const { me } = useApp();
  const can = useCan();
  const manage = can(MANAGE);
  const myStaffId = useMyStaffId();
  const [status, setStatus] = useState('');
  const [closing, setClosing] = useState<Row | null>(null);
  const res = useOne<{ data: Row[] }>(
    `/api/v1/supervision-bookings${status ? `?status=${status}` : ''}`,
  );
  const rows = res.data?.data ?? [];
  return (
    <div className="space-y-4">
      <Section title="Supervision bookings">
        <p className="text-sm">
          {manage
            ? 'All supervision bookings. The supervisor or HR records what happened; nobody records their own supervision.'
            : 'Supervisions booked for you and the ones you supervise.'}
        </p>
        <Field label="Show">
          <select
            className={`${input} w-56`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All bookings</option>
            {Object.entries(BOOKING_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <DataTable<Row>
          caption="Supervision bookings"
          rows={rows}
          rowKey={(r) => r.id}
          loading={res.isLoading}
          error={res.isError ? 'Could not load supervision bookings.' : null}
          emptyMessage="No supervision bookings."
          columns={[
            { key: 'p', header: 'Person', cell: (r) => r.staffName },
            { key: 's', header: 'Supervisor', cell: (r) => r.supervisorName },
            { key: 'w', header: 'When', cell: (r) => fmtDateTime(r.scheduledAt) },
            { key: 'k', header: 'Type', cell: (r) => SUPERVISION_KIND[r.kind] ?? 'Other' },
            { key: 't', header: 'Topics', cell: (r) => r.topics ?? '' },
            { key: 'st', header: 'Status', cell: (r) => <StatusBadge {...bookingBadge(r)} /> },
            {
              key: 'a',
              header: 'Outcome',
              cell: (r) => {
                if (r.status !== 'BOOKED') return '';
                if (myStaffId && r.staffId === myStaffId)
                  return <span className="text-sm">Your supervisor records this.</span>;
                if (r.supervisorUserId !== me.user.id && !manage) return '';
                return (
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Record outcome: ${r.staffName}`}
                    onClick={() => setClosing(r)}
                  >
                    Record outcome
                  </button>
                );
              },
            },
          ]}
        />
      </Section>
      {manage && <BookSupervision myStaffId={myStaffId} />}
      {closing && <CloseBooking booking={closing} onClose={() => setClosing(null)} />}
    </div>
  );
}

function BookSupervision({ myStaffId }: { myStaffId: string | null }) {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const staff = useCurrentStaff();
  const [staffId, setStaffId] = useState('');
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
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Book a supervision"
        onSubmit={(e) => void submit(e)}
      >
        <Field label="Person">
          <select
            className={input}
            value={staffId}
            required
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">Choose a person</option>
            {staff
              .filter((s) => s.id !== myStaffId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
          </select>
        </Field>
        <PersonSelect
          label="Supervisor"
          value={supervisor}
          onChange={setSupervisor}
          people={people}
          meId={me.user.id}
        />
        <Field label="Date and time">
          <input
            type="datetime-local"
            className={input}
            value={at}
            required
            onChange={(e) => setAt(e.target.value)}
          />
        </Field>
        <Field label="Type">
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(SUPERVISION_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Topics (optional, no patient details)">
          <textarea
            className={`${input} w-80`}
            rows={2}
            maxLength={1000}
            value={topics}
            onChange={(e) => setTopics(e.target.value)}
          />
        </Field>
        <button className={button} type="submit" disabled={!staffId || !supervisor || !at}>
          Book supervision
        </button>
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
            <select className={input} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="HELD">It was held</option>
              <option value="CANCELLED">It was cancelled</option>
              <option value="MISSED">It was missed</option>
            </select>
          </Field>
          {held ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={attended}
                  onChange={(e) => setAttended(e.target.checked)}
                />
                {booking.staffName} attended
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={wellbeing}
                  onChange={(e) => setWellbeing(e.target.checked)}
                />
                Wellbeing check done
              </label>
              <Field label="Competence concerns (optional)">
                <textarea
                  className={input}
                  rows={2}
                  maxLength={1000}
                  value={concerns}
                  onChange={(e) => setConcerns(e.target.value)}
                />
              </Field>
              <Field label="Agreed actions (optional)">
                <textarea
                  className={input}
                  rows={2}
                  maxLength={2000}
                  value={actions}
                  onChange={(e) => setActions(e.target.value)}
                />
              </Field>
              <Field label="Next supervision due (optional)">
                <input
                  type="date"
                  className={input}
                  value={nextDue}
                  onChange={(e) => setNextDue(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <Field label="Rebook for (optional)">
              <input
                type="datetime-local"
                className={input}
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
