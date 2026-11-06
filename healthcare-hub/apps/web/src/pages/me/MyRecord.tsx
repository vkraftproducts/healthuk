import { londonDate } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
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
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { UploadDialog } from '../evidence/Evidence.js';
import { useOne, usePeople } from '../settings/hooks.js';
import {
  DATE_LABEL,
  LIFECYCLE_LABEL,
  RESTRICTION_LABEL,
  ROLE_LABEL,
  list,
} from '../staff/labels.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CORRECTION_FIELD: Record<string, string> = {
  displayName: 'Name',
  phone: 'Phone number',
  address: 'Address',
  nextOfKin: 'Next of kin',
  workingPattern: 'Working pattern',
  other: 'Something else',
};
export const REQUEST_KIND: Record<string, string> = {
  DUE_DATE_CHANGE: 'Date change',
  REVIEW: 'Review',
  SUPERVISION: 'Supervision',
};
const REQUEST_STATUS: Record<string, { status: StatusKind; word: string }> = {
  OPEN: { status: 'AMBER', word: 'Waiting for a decision' },
  ACCEPTED: { status: 'GREEN', word: 'Accepted' },
  DECLINED: { status: 'RED', word: 'Declined' },
  WITHDRAWN: { status: 'GREY', word: 'Withdrawn' },
};
const CORRECTION_STATUS: Record<string, { status: StatusKind; word: string }> = {
  OPEN: { status: 'AMBER', word: 'Waiting for HR' },
  APPLIED: { status: 'GREEN', word: 'Applied' },
  REJECTED: { status: 'RED', word: 'Not applied' },
};
const READINESS: Record<string, { status: StatusKind; word: string }> = {
  READY: { status: 'GREEN', word: 'Ready for the whole window' },
  RESTRICTED: { status: 'AMBER', word: 'Ready, with restrictions' },
  BLOCKED: { status: 'RED', word: 'Not ready' },
};
const CHECK_RESULT: Record<string, { status: StatusKind; word: string }> = {
  PASS: { status: 'GREEN', word: 'Met' },
  FAIL: { status: 'RED', word: 'Not met' },
  PENDING: { status: 'GREY', word: 'Waiting' },
};

function dateOf(r: Row): string | null {
  return r.deadlineKind === 'EXPIRY'
    ? r.expiryDate
    : r.deadlineKind === 'REVIEW'
      ? r.reviewDate
      : r.dueDate;
}

function requestDetail(r: Row): string {
  if (r.kind === 'DUE_DATE_CHANGE')
    return `${r.requirementTitle ?? 'Requirement'}: from ${
      r.currentDate ? fmtDate(r.currentDate) : 'no date'
    } to ${fmtDate(r.proposedDate)}`;
  if (r.kind === 'REVIEW') return r.requirementTitle ?? 'Requirement';
  return `Preferred ${fmtDate(r.proposedDate)}${
    r.supervisorName ? ` with ${r.supervisorName}` : ''
  }${r.bookedFor ? `; booked for ${fmtDateTime(r.bookedFor)}` : ''}`;
}

/** "My record": the signed-in person's own staff record and self-service requests (task 25). */
export function MyRecord() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const mine = useOne<Row>('/api/v1/staff/me');
  const requests = useOne<{ data: Row[] }>('/api/v1/staff/me/requests');
  const people = usePeople().filter((p) => p.id !== me.user.id);
  const [dateFor, setDateFor] = useState<Row | null>(null);
  const [reviewFor, setReviewFor] = useState<Row | null>(null);
  const [uploadFor, setUploadFor] = useState<Row | null>(null);
  const [withdrawing, setWithdrawing] = useState<Row | null>(null);
  const [newDate, setNewDate] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const update = can('staff.self.update');

  if (mine.isError || (mine.data && !mine.data.profile))
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">My record</h1>
        <p role="alert">
          There is no staff record linked to your account here. Ask HR if you think there should be.
        </p>
      </div>
    );
  if (!mine.data)
    return (
      <p role="status" className="m-6">
        Loading…
      </p>
    );
  const p = mine.data.profile as Row;
  const reqs = (mine.data.requirements as Row[]) ?? [];

  async function askCorrection(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/staff/me/corrections', orgId, {
          field: String(f.get('field')),
          proposedValue: String(f.get('proposedValue') ?? '').trim(),
          reason: String(f.get('reason') ?? '').trim(),
        }),
      'Correction requested. HR will check it and tell you the outcome here.',
    );
    if (ok) form.reset();
  }
  async function bookSupervision(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/staff/me/requests', orgId, {
          kind: 'SUPERVISION',
          proposedDate: String(f.get('proposedDate')),
          ...(supervisor ? { supervisorUserId: supervisor } : {}),
          reason: String(f.get('topic') ?? '').trim(),
        }),
      'Supervision requested. You will see here when it is booked.',
    );
    if (ok) {
      form.reset();
      setSupervisor('');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">My record</h1>
      {me.permissions.includes('crew.today.view') && (
        <section
          aria-label="Crew app"
          className="space-y-1 rounded-lg border border-hub-line bg-white p-4"
        >
          <h2 className="font-semibold">Your shifts are in the crew app</h2>
          <p>
            Today&apos;s jobs, vehicle checks, defects and incident reports are done in the
            Healthcare Hub crew app on your work phone. Here on the web you can see your own record,
            upload certificates, acknowledge policies and raise a concern.
          </p>
        </section>
      )}
      <dl className="grid gap-2 rounded-lg border border-hub-line bg-white p-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm font-semibold">Name</dt>
          <dd>{p.displayName}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold">Staff number</dt>
          <dd>{p.staffNo}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold">Job title</dt>
          <dd>{p.jobTitle ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold">Stage</dt>
          <dd>{LIFECYCLE_LABEL[p.lifecycleState] ?? words(p.lifecycleState)}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold">Approved roles</dt>
          <dd>{list(p.roles ?? [], ROLE_LABEL)}</dd>
        </div>
        <div>
          <dt className="text-sm font-semibold">Restrictions</dt>
          <dd>{list(p.activeRestrictions ?? [], RESTRICTION_LABEL)}</dd>
        </div>
      </dl>
      {msg}

      <MyToDo
        requirements={reqs}
        corrections={(mine.data.corrections as Row[]) ?? []}
        meId={me.user.id}
      />
      <ReportLinks />

      <DataTable<Row>
        caption="My requirements"
        rows={reqs}
        rowKey={(r) => r.id}
        emptyMessage="No requirements apply to you yet."
        columns={[
          { key: 't', header: 'Requirement', cell: (r) => r.templateTitle },
          {
            key: 's',
            header: 'Status',
            cell: (r) => <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />,
          },
          {
            key: 'd',
            header: 'Date',
            cell: (r) =>
              dateOf(r)
                ? `${DATE_LABEL[r.deadlineKind] ?? 'Due'}: ${fmtDate(dateOf(r))}`
                : 'Not set',
          },
          { key: 'n', header: 'Needed for my roles', cell: (r) => (r.required ? 'Yes' : 'No') },
          ...(can('compliance.evidence.upload')
            ? [
                {
                  key: 'u',
                  header: 'Evidence',
                  cell: (r: Row) => (
                    <button
                      type="button"
                      className={smallButton}
                      aria-label={`Upload a certificate for ${r.templateTitle}`}
                      onClick={() => setUploadFor(r)}
                    >
                      Upload certificate
                    </button>
                  ),
                },
              ]
            : []),
          ...(update
            ? [
                {
                  key: 'a',
                  header: 'Ask',
                  cell: (r: Row) => (
                    <div className="flex flex-wrap gap-2">
                      {r.deadlineKind !== 'EXPIRY' && (
                        <button
                          type="button"
                          className={smallButton}
                          aria-label={`Ask to change the date for ${r.templateTitle}`}
                          onClick={() => {
                            setNewDate('');
                            setDateFor(r);
                          }}
                        >
                          Change date
                        </button>
                      )}
                      <button
                        type="button"
                        className={smallButton}
                        aria-label={`Request a review of ${r.templateTitle}`}
                        onClick={() => setReviewFor(r)}
                      >
                        Request review
                      </button>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
      <p className="text-sm">
        Expiry dates come from your verified documents, so they cannot be changed by request. Upload
        a new certificate instead. An upload counts only once someone else has verified it.
      </p>
      <UploadDialog
        target={
          uploadFor
            ? {
                instanceId: uploadFor.id,
                title: uploadFor.templateTitle,
                deadlineKind: uploadFor.deadlineKind,
              }
            : null
        }
        onClose={() => setUploadFor(null)}
      />

      <ReadinessWindow roles={p.roles ?? []} />

      {update && (
        <Section title="Book supervision">
          <form
            onSubmit={bookSupervision}
            aria-label="Book supervision"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="Preferred date">
              <input
                type="date"
                name="proposedDate"
                required
                min={londonDate(new Date())}
                className={input}
              />
            </Field>
            <Field label="Supervisor (optional)">
              <select
                className={input}
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
              >
                <option value="">Anyone available</option>
                {people.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.displayName}
                    {x.roleNames.length ? ` – ${x.roleNames.join(', ')}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What would you like to talk about?">
              <textarea name="topic" required minLength={3} maxLength={1000} className={input} />
            </Field>
            <div className="flex items-end">
              <button className={button}>Request supervision</button>
            </div>
          </form>
        </Section>
      )}

      <DataTable<Row>
        caption="My requests"
        rows={requests.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="You have not asked for anything yet."
        columns={[
          { key: 'k', header: 'Request', cell: (r) => REQUEST_KIND[r.kind] ?? 'Request' },
          { key: 'd', header: 'Details', cell: (r) => requestDetail(r) },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={REQUEST_STATUS[r.status]?.status ?? 'GREY'}
                reason={`${REQUEST_STATUS[r.status]?.word ?? 'Unknown'}${
                  r.decisionNote ? ` – ${r.decisionNote}` : ''
                }`}
              />
            ),
          },
          { key: 'w', header: 'Asked', cell: (r) => fmtDateTime(r.createdAt) },
          {
            key: 'a',
            header: 'Actions',
            cell: (r) =>
              update && r.status === 'OPEN' ? (
                <button
                  type="button"
                  className={smallButton}
                  aria-label={`Withdraw ${REQUEST_KIND[r.kind] ?? ''} request: ${requestDetail(r)}`}
                  onClick={() => setWithdrawing(r)}
                >
                  Withdraw
                </button>
              ) : (
                ''
              ),
          },
        ]}
      />

      {update && (
        <Section title="Ask for a correction">
          <form
            onSubmit={askCorrection}
            aria-label="Ask for a correction"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="What is wrong?">
              <select name="field" className={input} defaultValue="displayName">
                {Object.entries(CORRECTION_FIELD).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What should it say?">
              <input name="proposedValue" required maxLength={500} className={input} />
            </Field>
            <Field label="Why?">
              <input name="reason" required minLength={3} maxLength={500} className={input} />
            </Field>
            <div className="flex items-end">
              <button className={button}>Send to HR</button>
            </div>
          </form>
        </Section>
      )}
      <DataTable<Row>
        caption="My correction requests"
        rows={(mine.data.corrections as Row[]) ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No correction requests."
        columns={[
          { key: 'f', header: 'What', cell: (r) => CORRECTION_FIELD[r.field] ?? 'Something else' },
          { key: 'v', header: 'Should say', cell: (r) => r.proposedValue },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={CORRECTION_STATUS[r.status]?.status ?? 'GREY'}
                reason={`${CORRECTION_STATUS[r.status]?.word ?? 'Unknown'}${
                  r.decisionNote ? ` – ${r.decisionNote}` : ''
                }`}
              />
            ),
          },
          { key: 'w', header: 'Asked', cell: (r) => fmtDateTime(r.createdAt) },
        ]}
      />

      <ActionDialog
        open={!!dateFor}
        title={`Ask to change the date for ${dateFor?.templateTitle ?? ''}`}
        confirmLabel="Send request"
        reasonLabel="Why does the date need to change? (at least 10 characters)"
        confirmDisabled={!newDate}
        successText="Request sent. Someone who may change due dates will decide."
        onCancel={() => setDateFor(null)}
        fields={
          <Field label="New date">
            <input
              type="date"
              className={input}
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
            />
          </Field>
        }
        onConfirm={(reason) =>
          api.send('POST', '/api/v1/staff/me/requests', orgId, {
            kind: 'DUE_DATE_CHANGE',
            instanceId: dateFor?.id,
            proposedDate: newDate,
            reason,
          })
        }
      >
        <p>
          The date only changes if someone else accepts. Until then the current date and status stay
          as they are.
        </p>
      </ActionDialog>
      <ActionDialog
        open={!!reviewFor}
        title={`Request a review of ${reviewFor?.templateTitle ?? ''}`}
        confirmLabel="Request review"
        reasonLabel="What should be looked at again?"
        successText="Review requested."
        onCancel={() => setReviewFor(null)}
        onConfirm={(reason) =>
          api.send('POST', '/api/v1/staff/me/requests', orgId, {
            kind: 'REVIEW',
            instanceId: reviewFor?.id,
            reason,
          })
        }
      >
        <p>A reviewer will look at the item. Asking does not change its status.</p>
      </ActionDialog>
      <ActionDialog
        open={!!withdrawing}
        title="Withdraw this request"
        confirmLabel="Withdraw request"
        successText="Request withdrawn."
        onCancel={() => setWithdrawing(null)}
        onConfirm={() =>
          api.send(
            'POST',
            `/api/v1/staff/me/requests/${withdrawing?.id}/withdraw`,
            orgId,
            {},
            withdrawing?.version,
          )
        }
      >
        <p>{withdrawing ? requestDetail(withdrawing) : ''}</p>
      </ActionDialog>
    </div>
  );
}

/** F0: one list of what this person needs to do next. */
function MyToDo({
  requirements,
  corrections,
  meId,
}: {
  requirements: Row[];
  corrections: Row[];
  meId: string;
}) {
  const bookings = useOne<{ data: Row[] }>('/api/v1/supervision-bookings?status=BOOKED');
  const policies = useOne<{ items: Row[] }>('/api/v1/alerts/centre?event=POLICY_PUBLISHED');
  const items: { key: string; what: string; detail: string; status: StatusKind; word: string }[] =
    [];
  for (const r of requirements) {
    if (r.status !== 'RED' && r.status !== 'AMBER') continue;
    const d = dateOf(r);
    items.push({
      key: `req-${r.id}`,
      what: `Renew or complete ${r.templateTitle}`,
      detail: d ? `${DATE_LABEL[r.deadlineKind] ?? 'Due'}: ${fmtDate(d)}` : r.reasonText,
      status: r.status as StatusKind,
      word: r.status === 'RED' ? 'Overdue or missing' : 'Due soon',
    });
  }
  for (const p of policies.data?.items ?? []) {
    if (p.state !== 'OPEN') continue;
    items.push({
      key: `pol-${p.key}`,
      what: `Read and acknowledge ${p.title}`,
      detail: p.reasonText,
      status: 'AMBER',
      word: 'To read',
    });
  }
  for (const b of bookings.data?.data ?? []) {
    const supervising = b.supervisorUserId === meId;
    items.push({
      key: `sup-${b.id}`,
      what: supervising ? `Supervise ${b.staffName}` : `Supervision with ${b.supervisorName}`,
      detail: fmtDateTime(b.scheduledAt),
      status: 'GREY',
      word: 'Booked',
    });
  }
  for (const c of corrections) {
    if (c.status === 'OPEN') continue;
    items.push({
      key: `cor-${c.id}`,
      what: `Correction to ${CORRECTION_FIELD[c.field] ?? 'your record'} answered`,
      detail: c.decisionNote ?? (c.status === 'APPLIED' ? 'Applied' : 'Not applied'),
      status: CORRECTION_STATUS[c.status]?.status ?? 'GREY',
      word: CORRECTION_STATUS[c.status]?.word ?? 'Answered',
    });
  }
  return (
    <DataTable<{ key: string; what: string; detail: string; status: StatusKind; word: string }>
      caption="To do"
      rows={items}
      rowKey={(i) => i.key}
      emptyMessage="Nothing to do right now."
      columns={[
        { key: 'w', header: 'What', cell: (i) => i.what },
        { key: 'd', header: 'Details', cell: (i) => i.detail },
        {
          key: 's',
          header: 'Status',
          cell: (i) => <StatusBadge status={i.status} reason={i.word} />,
        },
      ]}
    />
  );
}

/** F0: the places a member of staff reports from, without opening manager pages. */
function ReportLinks() {
  return (
    <Section title="Report something">
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          <a className="underline" href="/report">
            Report an incident, a near miss or harassment
          </a>
        </li>
        <li>
          <a className="underline" href="/speak-up">
            Speak up about a concern (you can stay anonymous)
          </a>
        </li>
        <li>
          Report a vehicle defect or claim an expense from the mobile app. Ask your manager for the
          install link if you do not have it.
        </li>
      </ul>
    </Section>
  );
}

function ReadinessWindow({ roles }: { roles: string[] }) {
  const { api, orgId } = useApp();
  const today = londonDate(new Date());
  const [role, setRole] = useState(roles[0] ?? '');
  const [from, setFrom] = useState(`${today}T07:00`);
  const [to, setTo] = useState(`${today}T19:00`);
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function check(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);
    const start = new Date(from);
    const end = new Date(to);
    if (!(end > start)) {
      setError('The end must be after the start.');
      return;
    }
    const qs = new URLSearchParams({
      role,
      from: start.toISOString(),
      to: end.toISOString(),
    });
    try {
      setResult((await api.get(`/api/v1/staff/me/readiness?${qs.toString()}`, orgId)) as Row);
    } catch {
      setError('Could not check readiness. The window can be at most 31 days.');
    }
  }
  return (
    <Section title="Check my readiness">
      {roles.length === 0 ? (
        <p className="text-sm">
          You are not approved for a role yet, so there is nothing to check.
        </p>
      ) : (
        <form
          onSubmit={check}
          aria-label="Check my readiness"
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="Role">
            <select className={input} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? words(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              type="datetime-local"
              className={input}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="datetime-local"
              className={input}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <button className={button}>Check readiness</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="space-y-2" role="status" aria-label="Readiness result">
          <StatusBadge
            status={READINESS[result.state]?.status ?? 'GREY'}
            reason={READINESS[result.state]?.word ?? 'Unknown'}
          />
          <DataTable<Row>
            caption="Readiness checks"
            rows={result.checks ?? []}
            rowKey={(c) => `${c.group}-${c.code}`}
            emptyMessage="No checks apply."
            columns={[
              { key: 'g', header: 'Area', cell: (c) => words(c.group) },
              {
                key: 'r',
                header: 'Result',
                cell: (c) => (
                  <StatusBadge
                    status={CHECK_RESULT[c.result]?.status ?? 'GREY'}
                    reason={`${CHECK_RESULT[c.result]?.word ?? 'Unknown'} – ${c.reasonText}`}
                  />
                ),
              },
            ]}
          />
        </div>
      )}
    </Section>
  );
}

/** Staff requests waiting for a decision: corrections, date changes, reviews and supervision. */
export function StaffRequestsQueue() {
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('staff.profile.manage');
  const due = can('compliance.due_date.change');
  const verify = can('compliance.evidence.verify');
  const requests = useOne<{ data: Row[] }>('/api/v1/staff/self-requests', manage || due || verify);
  const corrections = useOne<{ data: Row[] }>('/api/v1/staff/corrections', manage);
  const [deciding, setDeciding] = useState<{ row: Row; accept: boolean } | null>(null);
  const [correcting, setCorrecting] = useState<{ row: Row; apply: boolean } | null>(null);
  const [bookedFor, setBookedFor] = useState('');
  const mayDecide = (r: Row) =>
    r.kind === 'DUE_DATE_CHANGE' ? due : r.kind === 'REVIEW' ? manage || verify : manage;
  if (!manage && !due && !verify) return null;
  const supervision = deciding?.row.kind === 'SUPERVISION' && deciding.accept;
  return (
    <div className="space-y-4">
      <DataTable<Row>
        caption="Staff requests waiting for a decision"
        rows={requests.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No requests are waiting."
        columns={[
          { key: 'p', header: 'Who', cell: (r) => r.staffName },
          { key: 'k', header: 'Request', cell: (r) => REQUEST_KIND[r.kind] ?? 'Request' },
          { key: 'd', header: 'Details', cell: (r) => requestDetail(r) },
          { key: 'r', header: 'Reason', cell: (r) => r.reason },
          { key: 'w', header: 'Asked', cell: (r) => fmtDateTime(r.createdAt) },
          {
            key: 'a',
            header: 'Decide',
            cell: (r) =>
              mayDecide(r) ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Accept ${REQUEST_KIND[r.kind]} request from ${r.staffName}`}
                    onClick={() => {
                      setBookedFor('');
                      setDeciding({ row: r, accept: true });
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Decline ${REQUEST_KIND[r.kind]} request from ${r.staffName}`}
                    onClick={() => setDeciding({ row: r, accept: false })}
                  >
                    Decline
                  </button>
                </div>
              ) : (
                'Someone else decides this'
              ),
          },
        ]}
      />
      {manage && (
        <DataTable<Row>
          caption="Correction requests waiting for HR"
          rows={corrections.data?.data ?? []}
          rowKey={(r) => r.id}
          emptyMessage="No correction requests are waiting."
          columns={[
            {
              key: 'f',
              header: 'What',
              cell: (r) => CORRECTION_FIELD[r.field] ?? 'Something else',
            },
            { key: 'v', header: 'Should say', cell: (r) => r.proposedValue },
            { key: 'r', header: 'Reason', cell: (r) => r.reason },
            { key: 'w', header: 'Asked', cell: (r) => fmtDateTime(r.createdAt) },
            {
              key: 'a',
              header: 'Decide',
              cell: (r) => (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Mark correction to ${CORRECTION_FIELD[r.field] ?? 'record'} as applied`}
                    onClick={() => setCorrecting({ row: r, apply: true })}
                  >
                    Applied
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Reject correction to ${CORRECTION_FIELD[r.field] ?? 'record'}`}
                    onClick={() => setCorrecting({ row: r, apply: false })}
                  >
                    Reject
                  </button>
                </div>
              ),
            },
          ]}
        />
      )}
      <ActionDialog
        open={!!deciding}
        title={`${deciding?.accept ? 'Accept' : 'Decline'} ${
          REQUEST_KIND[deciding?.row.kind ?? ''] ?? ''
        } request from ${deciding?.row.staffName ?? ''}`}
        confirmLabel={deciding?.accept ? 'Accept request' : 'Decline request'}
        reasonLabel={deciding?.accept ? 'Note for the member of staff' : 'Why is it declined?'}
        reasonRequired={!deciding?.accept}
        confirmDisabled={supervision && !bookedFor}
        danger={!deciding?.accept}
        onCancel={() => setDeciding(null)}
        fields={
          supervision ? (
            <Field label="Booked for">
              <input
                type="datetime-local"
                className={input}
                value={bookedFor}
                onChange={(e) => setBookedFor(e.target.value)}
              />
            </Field>
          ) : undefined
        }
        onConfirm={(note) =>
          api.send(
            'POST',
            `/api/v1/staff/self-requests/${deciding?.row.id}/decide`,
            orgId,
            deciding?.accept
              ? {
                  decision: 'ACCEPTED',
                  ...(note ? { note } : {}),
                  ...(supervision ? { bookedFor: new Date(bookedFor).toISOString() } : {}),
                }
              : { decision: 'DECLINED', note },
            deciding?.row.version,
          )
        }
      >
        <p>{deciding ? requestDetail(deciding.row) : ''}</p>
        {deciding?.accept && deciding.row.kind === 'DUE_DATE_CHANGE' && (
          <p>The new date is applied now and recorded in the due-date log with you as approver.</p>
        )}
      </ActionDialog>
      <ActionDialog
        open={!!correcting}
        title={correcting?.apply ? 'Mark the correction as applied' : 'Reject the correction'}
        confirmLabel={correcting?.apply ? 'Mark as applied' : 'Reject correction'}
        reasonLabel="Note for the member of staff"
        reasonRequired={!correcting?.apply}
        danger={!correcting?.apply}
        onCancel={() => setCorrecting(null)}
        onConfirm={(note) =>
          api.send('POST', `/api/v1/staff/corrections/${correcting?.row.id}/decide`, orgId, {
            decision: correcting?.apply ? 'APPLIED' : 'REJECTED',
            ...(note ? { note } : {}),
          })
        }
      >
        <p>
          {correcting?.apply
            ? 'Make the change on the staff record first; this records that it was done.'
            : 'The record stays as it is.'}
        </p>
      </ActionDialog>
    </div>
  );
}
