import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  button,
  Field,
  fmtDate,
  fmtDateTime,
  input,
  PersonSelect,
  Section,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { DisclosureLog, RetentionLog, RetentionReviews } from './DataProtectionLogs.js';
import { useOne, usePeople } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
/** A datetime-local value (London wall clock) for now. */
const londonNowLocal = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date())
    .replace(' ', 'T');

const CLOCK: Record<string, [StatusKind, string]> = {
  OPEN: ['AMBER', 'ICO decision due'],
  DUE_SOON: ['RED', 'ICO deadline within 24 hours'],
  OVERDUE: ['RED', 'ICO deadline passed'],
  REPORTED: ['GREEN', 'Reported to the ICO'],
  NOT_REPORTABLE: ['GREY', 'Not reportable (decision recorded)'],
};
const BREACH_STAGE: Record<string, string> = {
  OPEN: 'Recorded – assessment needed',
  ASSESSED: 'Assessed',
  REPORTED: 'Reported to the ICO',
  CLOSED: 'Closed',
};
const RISK: Record<string, string> = {
  UNLIKELY: 'Unlikely to result in a risk to people',
  RISK: 'Risk to people',
  HIGH_RISK: 'High risk to people',
};
const DSR_TYPE: Record<string, string> = {
  ACCESS: 'Access (copy of data)',
  RECTIFICATION: 'Correction',
  ERASURE: 'Erasure',
  RESTRICTION: 'Restriction',
  OBJECTION: 'Objection',
};
const DSR_STAGE: Record<string, string> = {
  RECEIVED: 'Received – identity not yet verified',
  IDENTITY_VERIFIED: 'Identity verified',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  REFUSED: 'Refused',
};
const COMPLAINT_SOURCE: Record<string, string> = {
  DATA_SUBJECT: 'The person themselves',
  REPRESENTATIVE: 'Someone acting for them',
  ICO: 'Forwarded by the ICO',
};
const COMPLAINT_STAGE: Record<string, string> = {
  RECEIVED: 'Received – not yet acknowledged',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
};
const HOLD_SCOPE: Record<string, string> = {
  ORGANISATION: 'Whole organisation',
  STAFF: 'Staff member',
  JOB: 'Journey',
  EVENT: 'Event',
  VEHICLE: 'Vehicle',
};

/**
 * Data protection (SECURITY_COMPLIANCE §4): retention and its log, holds, requests, disclosures,
 * breaches, complaints.
 */
export function PrivacyPanel() {
  return (
    <div className="space-y-6">
      <Retention />
      <RetentionReviews />
      <RetentionLog />
      <LegalHolds />
      <SubjectRequests />
      <DisclosureLog />
      <Breaches />
      <Complaints />
    </div>
  );
}

// ---- retention ------------------------------------------------------------------------------------
type RuleEdit = { r: Row; months: string; basis: string; action: string };
function Retention() {
  const { api, orgId, me } = useApp();
  const rules = useOne<{ data: Row[] }>('/api/v1/retention-rules');
  const [editing, setEditing] = useState<RuleEdit | null>(null);
  const [approving, setApproving] = useState<Row | null>(null);
  const months = Number(editing?.months);
  const editValid =
    !!editing &&
    Number.isInteger(months) &&
    months >= 1 &&
    months <= 1200 &&
    editing.basis.trim().length >= 3;
  return (
    <Section title="Retention schedule">
      <p className="text-sm">
        Nothing is acted on until a rule is approved, and the person who changed a rule cannot
        approve it. Only patient contact details can be anonymised automatically; everything else is
        listed for review. Legal holds always win.
      </p>
      <DataTable<Row>
        caption="Retention rules"
        rows={rules.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={rules.isLoading}
        error={rules.isError ? 'Could not load retention rules.' : null}
        emptyMessage="No rules."
        columns={[
          { key: 'c', header: 'Records', cell: (r) => words(r.category) },
          {
            key: 'm',
            header: 'Keep for',
            cell: (r) => `${r.retainMonths} months from ${r.triggerDesc.toLowerCase()}`,
          },
          {
            key: 'a',
            header: 'Then',
            cell: (r) => (r.action === 'ANONYMISE' ? 'Anonymise' : 'List for review'),
          },
          {
            key: 'n',
            header: 'Past cutoff now',
            cell: (r) => `${r.candidates}${r.held ? ` (${r.held} on hold)` : ''}`,
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <>
                <StatusBadge
                  status={r.status === 'APPROVED' ? 'GREEN' : 'AMBER'}
                  reason={r.status === 'APPROVED' ? 'Approved' : 'Requires approval'}
                />
                <span className="block text-xs">
                  {r.status === 'APPROVED'
                    ? `By ${r.approvedByName ?? 'unknown'} on ${fmtDate(r.approvedAt)}`
                    : r.changedBy
                      ? `Changed by ${r.changedBy === me.user.id ? 'you' : (r.changedByName ?? 'unknown')}`
                      : 'Default – record your basis first'}
                </span>
              </>
            ),
          },
          { key: 'b', header: 'Basis', cell: (r) => r.basis },
          {
            key: 'x',
            header: 'Action',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                <button
                  className={smallButton}
                  aria-label={`Change rule: ${words(r.category)}`}
                  onClick={() =>
                    setEditing({
                      r,
                      months: String(r.retainMonths),
                      basis: r.basis.startsWith('Placeholder') ? '' : r.basis,
                      action: r.action,
                    })
                  }
                >
                  Change
                </button>
                {r.status !== 'APPROVED' &&
                  !r.basis.startsWith('Placeholder') &&
                  (r.changedBy === me.user.id ? (
                    <span className="text-xs">Someone else must approve your change.</span>
                  ) : (
                    <button
                      className={smallButton}
                      aria-label={`Approve rule: ${words(r.category)}`}
                      onClick={() => setApproving(r)}
                    >
                      Approve
                    </button>
                  ))}
              </div>
            ),
          },
        ]}
      />
      <ActionDialog
        open={editing !== null}
        title={`Change rule: ${words(editing?.r.category)}`}
        confirmLabel="Save change"
        confirmDisabled={!editValid}
        onCancel={() => setEditing(null)}
        onConfirm={() => {
          const e = editing!;
          return api.send('PATCH', `/api/v1/retention-rules/${e.r.id}`, orgId, {
            ...(months !== e.r.retainMonths ? { retainMonths: months } : {}),
            ...(e.basis.trim() !== e.r.basis ? { basis: e.basis.trim() } : {}),
            ...(e.action !== e.r.action ? { action: e.action } : {}),
          });
        }}
        fields={
          editing && (
            <div className="grid gap-3">
              <Field label="Keep for (months)">
                <input
                  type="number"
                  min={1}
                  max={1200}
                  className={input}
                  value={editing.months}
                  onChange={(e) => setEditing({ ...editing, months: e.target.value })}
                />
              </Field>
              <Field label="Basis (your approved schedule or legal source)">
                <input
                  className={input}
                  maxLength={500}
                  value={editing.basis}
                  onChange={(e) => setEditing({ ...editing, basis: e.target.value })}
                />
              </Field>
              {editing.r.category === 'PATIENT_CONTACT' && (
                <Field label="Then">
                  <select
                    className={input}
                    value={editing.action}
                    onChange={(e) => setEditing({ ...editing, action: e.target.value })}
                  >
                    <option value="REVIEW">List for review</option>
                    <option value="ANONYMISE">Anonymise</option>
                  </select>
                </Field>
              )}
            </div>
          )
        }
      >
        <p>Any change puts the rule back to "requires approval" by someone else.</p>
      </ActionDialog>
      <ActionDialog
        open={approving !== null}
        title={`Approve rule: ${words(approving?.category)}`}
        confirmLabel="Approve"
        onCancel={() => setApproving(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/retention-rules/${approving!.id}/approve`, orgId, {})
        }
      >
        <p>
          Keep for {approving?.retainMonths} months, then{' '}
          {approving?.action === 'ANONYMISE' ? 'anonymise' : 'list for review'}. Basis:{' '}
          {approving?.basis}. {approving?.candidates ?? 0} record(s) are past the cutoff now. Your
          name is recorded as the approver.
        </p>
      </ActionDialog>
    </Section>
  );
}

// ---- legal holds ----------------------------------------------------------------------------------
function LegalHolds() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const holds = useOne<{ data: Row[] }>('/api/v1/legal-holds');
  const [scope, setScope] = useState('ORGANISATION');
  const staff = useOne<{ data: Row[] }>('/api/v1/staff', scope === 'STAFF');
  const staffNames = new Map((staff.data?.data ?? []).map((s) => [s.id, s.displayName]));
  const [releasing, setReleasing] = useState<Row | null>(null);
  async function place(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const from = String(f.get('rangeFrom') ?? '');
    const to = String(f.get('rangeTo') ?? '');
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/legal-holds', orgId, {
          scopeType: scope,
          ...(scope === 'STAFF' ? { scopeId: String(f.get('scopeId')) } : {}),
          ...(scope === 'ORGANISATION' && from && to ? { rangeFrom: from, rangeTo: to } : {}),
          reason: String(f.get('reason')),
        }),
      'Legal hold placed. Retention will not touch these records until it is released.',
    );
    if (ok) form.reset();
  }
  const scopeText = (h: Row) =>
    h.scopeType === 'ORGANISATION'
      ? h.rangeFrom
        ? `${HOLD_SCOPE.ORGANISATION}: records from ${fmtDate(h.rangeFrom)} to ${fmtDate(h.rangeTo)}`
        : HOLD_SCOPE.ORGANISATION
      : `${HOLD_SCOPE[h.scopeType] ?? words(h.scopeType)}${
          h.scopeType === 'STAFF' && staffNames.get(h.scopeId)
            ? `: ${staffNames.get(h.scopeId)}`
            : ''
        }`;
  return (
    <Section title="Legal holds">
      <form
        onSubmit={place}
        aria-label="Place a legal hold"
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Hold">
          <select className={input} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="ORGANISATION">{HOLD_SCOPE.ORGANISATION}</option>
            <option value="STAFF">{HOLD_SCOPE.STAFF}</option>
          </select>
        </Field>
        {scope === 'STAFF' && (
          <Field label="Staff member">
            <select name="scopeId" required className={input}>
              {(staff.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {scope === 'ORGANISATION' && (
          <>
            <Field label="Records from (optional)">
              <input type="date" name="rangeFrom" className={input} />
            </Field>
            <Field label="Records to (optional)">
              <input type="date" name="rangeTo" className={input} />
            </Field>
          </>
        )}
        <Field label="Reason (at least 10 characters)">
          <input name="reason" required minLength={10} maxLength={500} className={input} />
        </Field>
        <button className={button}>Place hold</button>
      </form>
      {msg}
      <DataTable<Row>
        caption="Legal holds"
        rows={holds.data?.data ?? []}
        rowKey={(h) => h.id}
        emptyMessage="No legal holds."
        columns={[
          { key: 's', header: 'Scope', cell: scopeText },
          { key: 'r', header: 'Reason', cell: (h) => h.reason },
          {
            key: 'p',
            header: 'Placed',
            cell: (h) => `${fmtDate(h.placedAt)} by ${h.placedByName ?? 'unknown'}`,
          },
          {
            key: 'x',
            header: 'State',
            cell: (h) =>
              h.releasedAt ? (
                <StatusBadge
                  status="GREY"
                  reason={`Released ${fmtDate(h.releasedAt)} – ${h.releaseReason}`}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status="AMBER" reason="Active" />
                  <button
                    className={smallButton}
                    aria-label={`Release hold: ${scopeText(h)}`}
                    onClick={() => setReleasing(h)}
                  >
                    Release
                  </button>
                </div>
              ),
          },
        ]}
      />
      <ActionDialog
        open={releasing !== null}
        title={`Release hold: ${releasing ? scopeText(releasing) : ''}`}
        confirmLabel="Release hold"
        danger
        reasonLabel="Why can the hold be released? (at least 10 characters)"
        onCancel={() => setReleasing(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/legal-holds/${releasing!.id}/release`, orgId, { reason })
        }
      >
        <p>Approved retention rules can act on these records again once the hold is released.</p>
      </ActionDialog>
    </Section>
  );
}

// ---- data subject requests ------------------------------------------------------------------------
type DsrStep =
  | { r: Row; kind: 'verify' | 'start' | 'askId' }
  | { r: Row; kind: 'extend' }
  | { r: Row; kind: 'COMPLETED' | 'REFUSED' };
function SubjectRequests() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const dsrs = useOne<{ data: Row[] }>('/api/v1/subject-requests');
  const [about, setAbout] = useState('STAFF');
  const staff = useOne<{ data: Row[] }>('/api/v1/staff', about === 'STAFF');
  const [step, setStep] = useState<DsrStep | null>(null);
  const [extendTo, setExtendTo] = useState('');
  const [exemption, setExemption] = useState('');
  async function newDsr(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/subject-requests', orgId, {
          type: String(f.get('type')),
          subjectType: about,
          ...(about === 'PATIENT' ? { patientRef: String(f.get('patientRef')) } : {}),
          ...(about === 'STAFF' ? { staffId: String(f.get('staffId')) } : {}),
          description: String(f.get('description')),
          receivedOn: String(f.get('receivedOn')),
        }),
      'Request logged. The response is due within one calendar month.',
    );
    if (ok) form.reset();
  }
  const exportFor = (r: Row) =>
    void run(
      () => api.send('POST', `/api/v1/subject-requests/${r.id}/export`, orgId, {}),
      'The export is being built. Download it from Compliance → Evidence pack → Your exports.',
    );
  const name = (r: Row) => `${r.code} ${DSR_TYPE[r.type] ?? words(r.type)}`;
  const open = (r: Row) => r.status !== 'COMPLETED' && r.status !== 'REFUSED';
  return (
    <Section title="Data subject requests">
      <form onSubmit={newDsr} aria-label="Log a request" className="flex flex-wrap items-end gap-3">
        <Field label="Request type">
          <select name="type" className={input}>
            {Object.entries(DSR_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="About">
          <select className={input} value={about} onChange={(e) => setAbout(e.target.value)}>
            <option value="STAFF">A staff member</option>
            <option value="PATIENT">A patient</option>
            <option value="OTHER">Someone else</option>
          </select>
        </Field>
        {about === 'STAFF' && (
          <Field label="Staff member">
            <select name="staffId" required className={input}>
              {(staff.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
        {about === 'PATIENT' && (
          <Field label="Patient reference">
            <input name="patientRef" required pattern="[A-Za-z0-9\-]{2,30}" className={input} />
          </Field>
        )}
        <Field label="What is asked for (no names)">
          <input name="description" required minLength={3} maxLength={1000} className={input} />
        </Field>
        <Field label="Received on">
          <input
            type="date"
            name="receivedOn"
            required
            max={londonToday()}
            defaultValue={londonToday()}
            className={input}
          />
        </Field>
        <button className={button}>Log request</button>
      </form>
      {msg}
      <DataTable<Row>
        caption="Subject requests"
        rows={dsrs.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={dsrs.isLoading}
        error={dsrs.isError ? 'Could not load requests.' : null}
        emptyMessage="No requests."
        columns={[
          { key: 'c', header: 'Request', cell: name },
          {
            key: 'a',
            header: 'About',
            cell: (r) =>
              r.subjectType === 'STAFF'
                ? (r.staffName ?? 'Staff member')
                : r.subjectType === 'PATIENT'
                  ? `Patient ${r.patientRef}`
                  : 'Someone else',
          },
          { key: 'r', header: 'Received', cell: (r) => fmtDate(r.receivedOn) },
          {
            key: 'd',
            header: 'Due',
            cell: (r) => (
              <>
                {fmtDate(r.effectiveDueOn ?? r.extendedTo ?? r.dueOn)}
                {r.extendedTo && (
                  <span className="block text-xs">Extended from {fmtDate(r.dueOn)}</span>
                )}
                {r.pausedDays > 0 && (
                  <span className="block text-xs">
                    Clock paused {r.pausedDays} {r.pausedDays === 1 ? 'day' : 'days'} waiting for
                    identity
                    {r.status === 'RECEIVED' ? ' (still waiting)' : ''}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={r.overdue ? 'RED' : open(r) ? 'AMBER' : 'GREEN'}
                reason={`${r.overdue ? 'Overdue – ' : ''}${DSR_STAGE[r.status] ?? words(r.status)}`}
              />
            ),
          },
          {
            key: 'x',
            header: 'Next step',
            cell: (r) =>
              !open(r) ? (
                `${r.outcome ?? ''}${r.exemption ? ` (exemption: ${r.exemption})` : ''}`
              ) : (
                <div className="flex flex-wrap gap-2">
                  {r.status === 'RECEIVED' && !r.identityRequestedOn && (
                    <button
                      className={smallButton}
                      aria-label={`Asked for identity: ${name(r)}`}
                      onClick={() => setStep({ r, kind: 'askId' })}
                    >
                      Asked for identity
                    </button>
                  )}
                  {r.status === 'RECEIVED' && (
                    <button
                      className={smallButton}
                      aria-label={`Identity verified: ${name(r)}`}
                      onClick={() => setStep({ r, kind: 'verify' })}
                    >
                      Identity verified
                    </button>
                  )}
                  {r.status === 'IDENTITY_VERIFIED' && (
                    <button
                      className={smallButton}
                      aria-label={`Start work: ${name(r)}`}
                      onClick={() => setStep({ r, kind: 'start' })}
                    >
                      Start work
                    </button>
                  )}
                  {r.type === 'ACCESS' &&
                    r.status !== 'RECEIVED' &&
                    r.subjectType !== 'OTHER' &&
                    can('reports.export') && (
                      <button
                        className={smallButton}
                        aria-label={`Build export: ${name(r)}`}
                        onClick={() => exportFor(r)}
                      >
                        {r.exportJobId ? 'Rebuild export' : 'Build export'}
                      </button>
                    )}
                  {!r.extendedTo && (
                    <button
                      className={smallButton}
                      aria-label={`Extend: ${name(r)}`}
                      onClick={() => {
                        setExtendTo('');
                        setStep({ r, kind: 'extend' });
                      }}
                    >
                      Extend
                    </button>
                  )}
                  {r.status !== 'RECEIVED' && (
                    <button
                      className={smallButton}
                      aria-label={`Complete: ${name(r)}`}
                      onClick={() => setStep({ r, kind: 'COMPLETED' })}
                    >
                      Complete
                    </button>
                  )}
                  <button
                    className={smallButton}
                    aria-label={`Refuse: ${name(r)}`}
                    onClick={() => {
                      setExemption('');
                      setStep({ r, kind: 'REFUSED' });
                    }}
                  >
                    Refuse
                  </button>
                </div>
              ),
          },
        ]}
      />
      <ActionDialog
        open={step !== null}
        title={
          step
            ? `${
                step.kind === 'verify'
                  ? 'Identity verified'
                  : step.kind === 'askId'
                    ? 'Asked for identity'
                    : step.kind === 'start'
                      ? 'Start work'
                      : step.kind === 'extend'
                        ? 'Extend'
                        : step.kind === 'COMPLETED'
                          ? 'Complete'
                          : 'Refuse'
              }: ${name(step.r)}`
            : ''
        }
        confirmLabel={
          step?.kind === 'extend'
            ? 'Extend deadline'
            : step?.kind === 'COMPLETED'
              ? 'Complete request'
              : step?.kind === 'REFUSED'
                ? 'Refuse request'
                : 'Confirm'
        }
        danger={step?.kind === 'REFUSED'}
        reasonLabel={
          step?.kind === 'COMPLETED' || step?.kind === 'REFUSED'
            ? step.kind === 'COMPLETED'
              ? 'What was provided or done?'
              : 'Why is it refused?'
            : undefined
        }
        confirmDisabled={
          (step?.kind === 'extend' && !extendTo) ||
          (step?.kind === 'REFUSED' && exemption.trim().length < 3)
        }
        onCancel={() => setStep(null)}
        onConfirm={(reason) => {
          const s = step!;
          const path = `/api/v1/subject-requests/${s.r.id}/update`;
          const payload =
            s.kind === 'verify'
              ? { status: 'IDENTITY_VERIFIED' }
              : s.kind === 'askId'
                ? { identityRequestedOn: londonToday() }
                : s.kind === 'start'
                  ? { status: 'IN_PROGRESS' }
                  : s.kind === 'extend'
                    ? { extendedTo: extendTo }
                    : s.kind === 'REFUSED'
                      ? { status: s.kind, outcome: reason, exemption: exemption.trim() }
                      : { status: s.kind, outcome: reason };
          return api.send('POST', path, orgId, payload);
        }}
        fields={
          step?.kind === 'REFUSED' ? (
            <Field label="Exemption relied on">
              <input
                className={input}
                maxLength={500}
                value={exemption}
                onChange={(e) => setExemption(e.target.value)}
              />
            </Field>
          ) : (
            step?.kind === 'extend' && (
              <Field label={`New due date (no later than ${fmtDate(step.r.latestExtension)})`}>
                <input
                  type="date"
                  className={input}
                  min={step.r.dueOn}
                  max={step.r.latestExtension}
                  value={extendTo}
                  onChange={(e) => setExtendTo(e.target.value)}
                />
              </Field>
            )
          )
        }
      >
        <p>
          {step?.kind === 'askId'
            ? 'The one-month clock pauses from today until identity is confirmed.'
            : step?.kind === 'verify'
              ? 'Confirm you have checked who is asking. Your name is recorded.'
              : step?.kind === 'start'
                ? 'The request moves to in progress.'
                : step?.kind === 'extend'
                  ? 'Complex or numerous requests can be extended by up to two further months. Tell the person why within the first month.'
                  : step?.kind === 'COMPLETED'
                    ? 'Closing the request records the outcome. It cannot be reopened.'
                    : 'Refusing closes the request. Tell the person why and that they can complain to the ICO.'}
        </p>
      </ActionDialog>
    </Section>
  );
}

// ---- breaches -------------------------------------------------------------------------------------
type BreachStep = { b: Row; kind: 'assess' | 'report' | 'close' | 'contain' };
const NO_ANSWERS = {
  specialCategory: false,
  identifiable: true,
  volume: 'FEW',
  likelyHarm: 'SOME',
  recovered: false,
};
function Breaches() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const breaches = useOne<{ data: Row[] }>('/api/v1/breaches');
  const [step, setStep] = useState<BreachStep | null>(null);
  const [risk, setRisk] = useState('RISK');
  const [reportable, setReportable] = useState(true);
  const [report, setReport] = useState({ at: '', ref: '', late: '', notified: '' });
  const [answers, setAnswers] = useState(NO_ANSWERS);
  const [contain, setContain] = useState({ at: '', how: '', people: '' });
  async function newBreach(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const cats = String(f.get('dataCategories') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const estimate = String(f.get('subjectsEstimate') ?? '');
    const occurred = String(f.get('occurredAt') ?? '');
    const containment = String(f.get('containment') ?? '').trim();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/breaches', orgId, {
          title: String(f.get('title')),
          description: String(f.get('description')),
          discoveredAt: new Date(String(f.get('discoveredAt'))).toISOString(),
          ...(occurred ? { occurredAt: new Date(occurred).toISOString() } : {}),
          dataCategories: cats,
          ...(estimate ? { subjectsEstimate: Number(estimate) } : {}),
          ...(containment ? { containment } : {}),
        }),
      'Breach recorded. The 72-hour ICO clock is running from discovery.',
    );
    if (ok) form.reset();
  }
  const name = (b: Row) => `${b.code} ${b.title}`;
  const late =
    !!step && !!report.at && new Date(report.at).getTime() > new Date(step.b.icoDeadline).getTime();
  const confirmDisabled =
    step?.kind === 'report'
      ? !report.at || !report.ref.trim() || (late && report.late.trim().length < 10)
      : step?.kind === 'contain'
        ? !contain.at || contain.how.trim().length < 3
        : false;
  return (
    <Section title="Personal data breaches">
      <form onSubmit={newBreach} aria-label="Record a breach" className="grid gap-3 md:grid-cols-2">
        <Field label="Title">
          <input name="title" required minLength={3} maxLength={200} className={input} />
        </Field>
        <Field label="Discovered at">
          <input
            type="datetime-local"
            name="discoveredAt"
            required
            max={londonNowLocal()}
            className={input}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="What happened (no names)">
            <textarea
              name="description"
              required
              minLength={3}
              maxLength={4000}
              className={input}
            />
          </Field>
        </div>
        <Field label="Occurred at (optional)">
          <input type="datetime-local" name="occurredAt" className={input} />
        </Field>
        <Field label="Types of data (comma separated, optional)">
          <input name="dataCategories" className={input} />
        </Field>
        <Field label="People affected, estimate (optional)">
          <input type="number" min={0} name="subjectsEstimate" className={input} />
        </Field>
        <Field label="Containment so far (optional)">
          <input name="containment" maxLength={2000} className={input} />
        </Field>
        <div className="md:col-span-2">
          <button className={button}>Record breach</button>
        </div>
      </form>
      {msg}
      <DataTable<Row>
        caption="Breach records"
        rows={breaches.data?.data ?? []}
        rowKey={(b) => b.id}
        loading={breaches.isLoading}
        error={breaches.isError ? 'Could not load breaches.' : null}
        emptyMessage="No breaches recorded."
        columns={[
          {
            key: 'c',
            header: 'Breach',
            cell: (b) => (
              <>
                <span className="font-medium">{name(b)}</span>
                <span className="block text-xs">
                  Discovered {fmtDateTime(b.discoveredAt)}
                  {b.subjectsEstimate !== null ? ` · about ${b.subjectsEstimate} people` : ''}
                </span>
              </>
            ),
          },
          { key: 'd', header: 'ICO deadline', cell: (b) => fmtDateTime(b.icoDeadline) },
          {
            key: 'k',
            header: 'ICO clock',
            cell: (b) => (
              <StatusBadge
                status={(CLOCK[b.clock] ?? ['GREY'])[0]}
                reason={(CLOCK[b.clock] ?? ['', words(b.clock)])[1]}
              />
            ),
          },
          {
            key: 's',
            header: 'Stage',
            cell: (b) => (
              <>
                {BREACH_STAGE[b.status] ?? words(b.status)}
                {b.risk && (
                  <span className="block text-xs">
                    {RISK[b.risk]}; {b.icoReportable ? 'reportable' : 'not reportable'} – decided by{' '}
                    {b.decidedByName ?? 'unknown'}
                  </span>
                )}
                {b.icoReference && (
                  <span className="block text-xs">
                    ICO reference {b.icoReference}, reported {fmtDateTime(b.icoReportedAt)}
                  </span>
                )}
                <span className="block text-xs">
                  {b.containedAt
                    ? `Contained ${fmtDateTime(b.containedAt)}`
                    : 'Not yet recorded as contained'}
                  {b.peopleAffected != null ? ` · ${b.peopleAffected} people affected` : ''}
                </span>
                {b.lessons && <span className="block text-xs">Lessons: {b.lessons}</span>}
              </>
            ),
          },
          {
            key: 'x',
            header: 'Next step',
            cell: (b) => (
              <div className="flex flex-wrap gap-2">
                {b.status !== 'CLOSED' && (
                  <button
                    className={smallButton}
                    aria-label={`Record containment: ${name(b)}`}
                    onClick={() => {
                      setContain({
                        at: londonNowLocal(),
                        how: b.containment ?? '',
                        people: b.peopleAffected != null ? String(b.peopleAffected) : '',
                      });
                      setStep({ b, kind: 'contain' });
                    }}
                  >
                    {b.containedAt ? 'Update containment' : 'Record containment'}
                  </button>
                )}
                {(b.status === 'OPEN' || b.status === 'ASSESSED') && (
                  <button
                    className={smallButton}
                    aria-label={`${b.status === 'OPEN' ? 'Assess' : 'Reassess'}: ${name(b)}`}
                    onClick={() => {
                      setRisk(b.risk ?? 'RISK');
                      setReportable(b.icoReportable ?? true);
                      setAnswers(b.answers ?? NO_ANSWERS);
                      setStep({ b, kind: 'assess' });
                    }}
                  >
                    {b.status === 'OPEN' ? 'Assess' : 'Reassess'}
                  </button>
                )}
                {b.status === 'ASSESSED' && b.icoReportable && (
                  <button
                    className={smallButton}
                    aria-label={`Record ICO report: ${name(b)}`}
                    onClick={() => {
                      setReport({ at: londonNowLocal(), ref: '', late: '', notified: '' });
                      setStep({ b, kind: 'report' });
                    }}
                  >
                    Record ICO report
                  </button>
                )}
                {((b.status === 'ASSESSED' && b.icoReportable === false) ||
                  b.status === 'REPORTED') && (
                  <button
                    className={smallButton}
                    aria-label={`Close: ${name(b)}`}
                    onClick={() => setStep({ b, kind: 'close' })}
                  >
                    Close
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />
      <ActionDialog
        open={step !== null}
        title={
          step
            ? `${
                step.kind === 'assess'
                  ? 'Assess'
                  : step.kind === 'report'
                    ? 'Record ICO report'
                    : step.kind === 'contain'
                      ? 'Record containment'
                      : 'Close'
              }: ${name(step.b)}`
            : ''
        }
        confirmLabel={
          step?.kind === 'assess'
            ? 'Record decision'
            : step?.kind === 'report'
              ? 'Record report'
              : step?.kind === 'contain'
                ? 'Save containment'
                : 'Close breach'
        }
        reasonLabel={
          step?.kind === 'assess'
            ? 'Reasons for the decision (at least 10 characters)'
            : step?.kind === 'close'
              ? 'Lessons learned'
              : undefined
        }
        confirmDisabled={confirmDisabled}
        onCancel={() => setStep(null)}
        onConfirm={(reason) => {
          const s = step!;
          const base = `/api/v1/breaches/${s.b.id}`;
          if (s.kind === 'assess')
            return api.send('POST', `${base}/assessment`, orgId, {
              risk,
              icoReportable: risk === 'HIGH_RISK' ? true : reportable,
              decisionReason: reason,
              answers,
            });
          if (s.kind === 'contain')
            return api.send('POST', `${base}/containment`, orgId, {
              containment: contain.how.trim(),
              containedAt: new Date(contain.at).toISOString(),
              ...(contain.people ? { peopleAffected: Number(contain.people) } : {}),
            });
          if (s.kind === 'report')
            return api.send('POST', `${base}/ico-report`, orgId, {
              reportedAt: new Date(report.at).toISOString(),
              reference: report.ref.trim(),
              ...(late ? { lateReason: report.late.trim() } : {}),
              ...(report.notified
                ? { subjectsNotifiedAt: new Date(report.notified).toISOString() }
                : {}),
            });
          return api.send('POST', `${base}/close`, orgId, { lessons: reason });
        }}
        fields={
          step?.kind === 'contain' ? (
            <div className="grid gap-3">
              <Field label="Contained at">
                <input
                  type="datetime-local"
                  className={input}
                  max={londonNowLocal()}
                  value={contain.at}
                  onChange={(e) => setContain({ ...contain, at: e.target.value })}
                />
              </Field>
              <Field label="How it was stopped (no names)">
                <textarea
                  className={input}
                  maxLength={2000}
                  value={contain.how}
                  onChange={(e) => setContain({ ...contain, how: e.target.value })}
                />
              </Field>
              <Field label="People affected (optional)">
                <input
                  type="number"
                  min={0}
                  className={input}
                  value={contain.people}
                  onChange={(e) => setContain({ ...contain, people: e.target.value })}
                />
              </Field>
            </div>
          ) : step?.kind === 'assess' ? (
            <div className="grid gap-3">
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">Guided questions</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={answers.identifiable}
                    onChange={(e) => setAnswers({ ...answers, identifiable: e.target.checked })}
                  />
                  People can be identified from the data
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={answers.specialCategory}
                    onChange={(e) => setAnswers({ ...answers, specialCategory: e.target.checked })}
                  />
                  It includes health or other special category data
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={answers.recovered}
                    onChange={(e) => setAnswers({ ...answers, recovered: e.target.checked })}
                  />
                  The data has been recovered or deleted by the recipient
                </label>
                <Field label="How many people">
                  <select
                    className={input}
                    value={answers.volume}
                    onChange={(e) => setAnswers({ ...answers, volume: e.target.value })}
                  >
                    <option value="ONE">One person</option>
                    <option value="FEW">A few people</option>
                    <option value="MANY">Many people</option>
                  </select>
                </Field>
                <Field label="Likely harm to them">
                  <select
                    className={input}
                    value={answers.likelyHarm}
                    onChange={(e) => setAnswers({ ...answers, likelyHarm: e.target.value })}
                  >
                    <option value="NONE">None expected</option>
                    <option value="SOME">Some (distress, inconvenience)</option>
                    <option value="SERIOUS">Serious (harm, fraud, safety)</option>
                  </select>
                </Field>
              </fieldset>
              <Field label="Risk to people">
                <select className={input} value={risk} onChange={(e) => setRisk(e.target.value)}>
                  {Object.entries(RISK).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={risk === 'HIGH_RISK' || reportable}
                  disabled={risk === 'HIGH_RISK'}
                  onChange={(e) => setReportable(e.target.checked)}
                />
                Report to the ICO
              </label>
              {risk === 'HIGH_RISK' && (
                <p className="text-sm">
                  A high risk breach must be reported to the ICO and the people affected told.
                </p>
              )}
            </div>
          ) : step?.kind === 'report' ? (
            <div className="grid gap-3">
              <Field label="Reported at">
                <input
                  type="datetime-local"
                  className={input}
                  value={report.at}
                  onChange={(e) => setReport({ ...report, at: e.target.value })}
                />
              </Field>
              <Field label="ICO reference">
                <input
                  className={input}
                  maxLength={60}
                  value={report.ref}
                  onChange={(e) => setReport({ ...report, ref: e.target.value })}
                />
              </Field>
              {late && (
                <Field label="Reasons for reporting after 72 hours">
                  <textarea
                    className={input}
                    maxLength={2000}
                    value={report.late}
                    onChange={(e) => setReport({ ...report, late: e.target.value })}
                  />
                </Field>
              )}
              <Field label="People affected told at (optional)">
                <input
                  type="datetime-local"
                  className={input}
                  value={report.notified}
                  onChange={(e) => setReport({ ...report, notified: e.target.value })}
                />
              </Field>
            </div>
          ) : undefined
        }
      >
        <p>
          {step?.kind === 'assess'
            ? `The ICO must be told within 72 hours of discovery (by ${fmtDateTime(step.b.icoDeadline)}) unless the breach is unlikely to result in a risk to people. Your name is recorded with the decision.`
            : step?.kind === 'report'
              ? 'Record when the ICO was told and the reference they gave.'
              : step?.kind === 'contain'
                ? 'Record what was done to stop it and when it was stopped.'
                : 'Closing keeps the record, the decision and the lessons on file.'}
        </p>
      </ActionDialog>
    </Section>
  );
}

// ---- data protection complaints -------------------------------------------------------------------
type ComplaintStep = { c: Row; kind: 'ack' | 'resolve' };
function Complaints() {
  const { api, orgId, me } = useApp();
  const { run, msg } = useRun();
  const people = usePeople();
  const list = useOne<{ data: Row[] }>('/api/v1/dp-complaints');
  const dsrs = useOne<{ data: Row[] }>('/api/v1/subject-requests');
  const breaches = useOne<{ data: Row[] }>('/api/v1/breaches');
  const [owner, setOwner] = useState(me.user.id);
  const [step, setStep] = useState<ComplaintStep | null>(null);
  const [on, setOn] = useState('');
  const [source, setSource] = useState('DATA_SUBJECT');
  const [ackText, setAckText] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const dsr = String(f.get('subjectRequestId') ?? '');
    const breach = String(f.get('breachId') ?? '');
    const ico = String(f.get('icoCaseRef') ?? '').trim();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/dp-complaints', orgId, {
          source,
          summary: String(f.get('summary')),
          receivedOn: String(f.get('receivedOn')),
          ownerUserId: owner,
          ...(dsr ? { subjectRequestId: dsr } : {}),
          ...(breach ? { breachId: breach } : {}),
          ...(source === 'ICO' && ico ? { icoCaseRef: ico } : {}),
        }),
      'Complaint logged. Acknowledge it within 30 days.',
    );
    if (ok) form.reset();
  }
  const name = (c: Row) => `${c.code} ${COMPLAINT_SOURCE[c.source] ?? words(c.source)}`;
  return (
    <Section title="Data protection complaints">
      <p className="text-sm">
        Complaints about how personal data is handled. Acknowledge each within 30 days and respond
        without undue delay. Do not write names in the summary.
      </p>
      <form onSubmit={submit} aria-label="Log a complaint" className="grid gap-3 md:grid-cols-2">
        <Field label="From">
          <select
            name="source"
            className={input}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {Object.entries(COMPLAINT_SOURCE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        {source === 'ICO' && (
          <Field label="ICO case reference">
            <input
              name="icoCaseRef"
              required
              pattern="[A-Za-z0-9/\-]{3,40}"
              maxLength={40}
              className={input}
            />
          </Field>
        )}
        <Field label="Received on">
          <input
            type="date"
            name="receivedOn"
            required
            max={londonToday()}
            defaultValue={londonToday()}
            className={input}
          />
        </Field>
        <div className="md:col-span-2">
          <Field label="Summary (no names)">
            <textarea name="summary" required minLength={3} maxLength={2000} className={input} />
          </Field>
        </div>
        <PersonSelect
          label="Owner"
          value={owner}
          onChange={setOwner}
          people={people}
          meId={me.user.id}
        />
        <Field label="Linked request (optional)">
          <select name="subjectRequestId" className={input} defaultValue="">
            <option value="">None</option>
            {(dsrs.data?.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} {DSR_TYPE[r.type] ?? words(r.type)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Linked breach (optional)">
          <select name="breachId" className={input} defaultValue="">
            <option value="">None</option>
            {(breaches.data?.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} {b.title}
              </option>
            ))}
          </select>
        </Field>
        <div className="md:col-span-2">
          <button className={button}>Log complaint</button>
        </div>
      </form>
      {msg}
      <DataTable<Row>
        caption="Data protection complaints"
        rows={list.data?.data ?? []}
        rowKey={(c) => c.id}
        loading={list.isLoading}
        error={list.isError ? 'Could not load complaints.' : null}
        emptyMessage="No complaints logged."
        columns={[
          {
            key: 'c',
            header: 'Complaint',
            cell: (c) => (
              <>
                <span className="font-medium">{name(c)}</span>
                <span className="block text-xs">{c.summary}</span>
                {c.icoCaseRef && (
                  <span className="block text-xs">ICO case reference {c.icoCaseRef}</span>
                )}
                {(c.subjectRequestCode || c.breachCode) && (
                  <span className="block text-xs">
                    Linked: {[c.subjectRequestCode, c.breachCode].filter(Boolean).join(', ')}
                  </span>
                )}
              </>
            ),
          },
          { key: 'r', header: 'Received', cell: (c) => fmtDate(c.receivedOn) },
          {
            key: 'a',
            header: 'Acknowledgement',
            cell: (c) =>
              c.acknowledgedOn ? (
                `Sent ${fmtDate(c.acknowledgedOn)}`
              ) : c.acknowledgeOverdue ? (
                <StatusBadge
                  status="RED"
                  reason={`Overdue – was due ${fmtDate(c.acknowledgeDue)}`}
                />
              ) : (
                `Due by ${fmtDate(c.acknowledgeDue)}`
              ),
          },
          {
            key: 'o',
            header: 'Owner',
            cell: (c) =>
              c.ownerUserId === me.user.id
                ? `${c.ownerName ?? 'You'} (you)`
                : (c.ownerName ?? 'Unknown'),
          },
          {
            key: 's',
            header: 'Status',
            cell: (c) => (
              <>
                <StatusBadge
                  status={
                    c.status === 'RESOLVED' ? 'GREEN' : c.acknowledgeOverdue ? 'RED' : 'AMBER'
                  }
                  reason={COMPLAINT_STAGE[c.status] ?? words(c.status)}
                />
                {c.outcome && (
                  <span className="block text-xs">
                    {c.outcome} – {fmtDate(c.resolvedOn)}, {c.resolvedByName ?? 'unknown'}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'x',
            header: 'Next step',
            cell: (c) =>
              c.status === 'RECEIVED' ? (
                <button
                  className={smallButton}
                  aria-label={`Record acknowledgement: ${name(c)}`}
                  onClick={() => {
                    setOn(londonToday());
                    setAckText(c.draftAcknowledgement ?? '');
                    setStep({ c, kind: 'ack' });
                  }}
                >
                  Record acknowledgement
                </button>
              ) : c.status === 'ACKNOWLEDGED' ? (
                <button
                  className={smallButton}
                  aria-label={`Record outcome: ${name(c)}`}
                  onClick={() => {
                    setOn(londonToday());
                    setStep({ c, kind: 'resolve' });
                  }}
                >
                  Record outcome
                </button>
              ) : null,
          },
        ]}
      />
      <ActionDialog
        open={step !== null}
        title={
          step
            ? `${step.kind === 'ack' ? 'Record acknowledgement' : 'Record outcome'}: ${name(step.c)}`
            : ''
        }
        confirmLabel={step?.kind === 'ack' ? 'Record acknowledgement' : 'Record outcome'}
        reasonLabel={step?.kind === 'resolve' ? 'Outcome (what was decided and done)' : undefined}
        confirmDisabled={!on}
        onCancel={() => setStep(null)}
        onConfirm={(reason) => {
          const s = step!;
          return s.kind === 'ack'
            ? api.send('POST', `/api/v1/dp-complaints/${s.c.id}/acknowledge`, orgId, {
                acknowledgedOn: on,
                ...(ackText.trim().length >= 3 ? { text: ackText.trim() } : {}),
              })
            : api.send('POST', `/api/v1/dp-complaints/${s.c.id}/resolve`, orgId, {
                outcome: reason,
                resolvedOn: on,
              });
        }}
        fields={
          <div className="grid gap-3">
            <Field label={step?.kind === 'ack' ? 'Acknowledged on' : 'Outcome sent on'}>
              <input
                type="date"
                className={input}
                max={londonToday()}
                value={on}
                onChange={(e) => setOn(e.target.value)}
              />
            </Field>
            {step?.kind === 'ack' && (
              <Field label="Acknowledgement text (drafted for you; edit before sending)">
                <textarea
                  className={input}
                  rows={5}
                  maxLength={4000}
                  value={ackText}
                  onChange={(e) => setAckText(e.target.value)}
                />
              </Field>
            )}
          </div>
        }
      >
        <p>
          {step?.kind === 'ack'
            ? `Acknowledgement was due by ${fmtDate(step.c.acknowledgeDue)}.`
            : 'Recording the outcome closes the complaint. Your name is recorded.'}
        </p>
      </ActionDialog>
    </Section>
  );
}
