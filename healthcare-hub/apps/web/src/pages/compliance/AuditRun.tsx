import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
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
import { useOne, usePeople } from '../settings/hooks.js';
import { RUN_STAGE } from './Audits.js';
import { ActionsTable } from './Compliance.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RESULT_KIND: Record<string, StatusKind> = {
  COMPLIANT: 'GREEN',
  PARTIAL: 'AMBER',
  NON_COMPLIANT: 'RED',
  NOT_ASSESSED: 'GREY',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};
const RESULTS = [
  'COMPLIANT',
  'PARTIAL',
  'NON_COMPLIANT',
  'NOT_APPLICABLE',
  'NOT_ASSESSED',
] as const;
const RESULT_LABEL: Record<string, string> = {
  COMPLIANT: 'Pass',
  PARTIAL: 'Partly met',
  NON_COMPLIANT: 'Fail',
  NOT_APPLICABLE: 'N/A (give the reason)',
  NOT_ASSESSED: 'Not assessed (give the reason)',
};
const NOTE_NEEDED = new Set(['PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE', 'NOT_ASSESSED']);
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const SUBJECT_TYPES = ['STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES', 'ORGANISATION'] as const;
/** Findings that call for follow-up. */
const NEEDS_FOLLOW_UP = new Set(['PARTIAL', 'NON_COMPLIANT', 'NOT_ASSESSED']);

type Subject = { id: string; label: string };
/** Names for sampled subjects, loaded only for the subject types in use. */
function useSubjects(types: Set<string>) {
  const { orgId, me } = useApp();
  const staff = useOne<{ data: Row[] }>('/api/v1/staff', types.has('STAFF'));
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', types.has('VEHICLE'));
  const equipment = useOne<{ data: Row[] }>('/api/v1/equipment', types.has('EQUIPMENT'));
  const premises = useOne<{ data: Row[] }>(
    `/api/v1/organisations/${orgId}/locations`,
    types.has('PREMISES'),
  );
  const orgName =
    me.memberships.find((m) => m.organisationId === orgId)?.organisationName ?? 'Organisation';
  const options: Record<string, Subject[]> = {
    STAFF: (staff.data?.data ?? []).map((r) => ({
      id: r.id,
      label: r.staffNo ? `${r.displayName} (${r.staffNo})` : r.displayName,
    })),
    VEHICLE: (vehicles.data?.data ?? []).map((r) => ({
      id: r.id,
      label: `${r.callsign} (${r.registration})`,
    })),
    EQUIPMENT: (equipment.data?.data ?? []).map((r) => ({
      id: r.id,
      label: `${r.assetTag} ${words(r.category)}`,
    })),
    PREMISES: (premises.data?.data ?? [])
      .filter((r) => !r.archived)
      .map((r) => ({ id: r.id, label: r.name })),
    ORGANISATION: orgId ? [{ id: orgId, label: orgName }] : [],
  };
  const all = new Map(
    Object.values(options)
      .flat()
      .map((s) => [s.id, s.label]),
  );
  return { options, label: (id: string | null) => (id ? (all.get(id) ?? 'Sampled item') : '—') };
}

function SampleForm({
  a,
  subjects,
  type,
  setType,
}: {
  a: Row;
  subjects: Subject[];
  type: string;
  setType: (t: string) => void;
}) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [picked, setPicked] = useState<string[]>([]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const repeatReason = String(f.get('repeatReason') ?? '').trim();
    const ok = await run(
      () =>
        api.send('POST', `/api/v1/audit-runs/${a.id}/samples`, orgId, {
          populationDesc: String(f.get('populationDesc')),
          selectionMethod: String(f.get('selectionMethod')),
          dateFrom: String(f.get('dateFrom')),
          dateTo: String(f.get('dateTo')),
          subjectType: type,
          subjectIds: picked,
          ...(repeatReason ? { repeatReason } : {}),
        }),
      'Sample recorded.',
    );
    if (ok) {
      form.reset();
      setPicked([]);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Record the sample">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Population (what you sampled from)">
          <input name="populationDesc" required minLength={3} maxLength={500} className={input} />
        </Field>
        <Field label="How the sample was chosen">
          <input name="selectionMethod" required minLength={3} maxLength={300} className={input} />
        </Field>
        <Field label="Records from">
          <input type="date" name="dateFrom" required className={input} />
        </Field>
        <Field label="Records to">
          <input type="date" name="dateTo" required className={input} />
        </Field>
        <Field label="What was sampled">
          <select
            className={input}
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPicked([]);
            }}
          >
            {SUBJECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {words(t)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="rounded border border-hub-line p-2">
        <legend className="px-1 text-sm font-semibold">Sampled items ({picked.length})</legend>
        {subjects.length === 0 ? (
          <p className="text-sm">Nothing of this type is available to you.</p>
        ) : (
          <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
            {subjects.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id),
                    )
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <Field label="Reason for sampling the same items again (needed if they were in a recent audit of this template)">
        <input name="repeatReason" maxLength={300} className={input} />
      </Field>
      <button className={button} disabled={picked.length === 0}>
        Record sample
      </button>
      {msg}
    </form>
  );
}

function ResponseForm({ a, subjects }: { a: Row; subjects: Subject[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const methods: string[] = a.methods ?? [];
  const [result, setResult] = useState<string>('COMPLIANT');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const subjectId = String(f.get('subjectId') ?? '');
    const note = String(f.get('note') ?? '').trim();
    const ok = await run(
      () =>
        api.send('POST', `/api/v1/audit-runs/${a.id}/responses`, orgId, {
          responses: [
            {
              controlCode: String(f.get('controlCode')),
              ...(subjectId ? { subjectId } : {}),
              result,
              method: String(f.get('method')),
              ...(note ? { note } : {}),
            },
          ],
        }),
      'Response saved.',
    );
    if (ok) {
      form.reset();
      setResult('COMPLIANT');
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Record a response">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Control">
          <select name="controlCode" required className={input}>
            {(a.controls as Row[]).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}: {c.question}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sampled item (optional)">
          <select name="subjectId" className={input}>
            <option value="">Not about one item</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Result">
          <select className={input} value={result} onChange={(e) => setResult(e.target.value)}>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {RESULT_LABEL[r] ?? words(r)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="How it was checked">
          <select name="method" required className={input}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {words(m)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label={`Note${NOTE_NEEDED.has(result) ? ' (required for this result)' : ' (optional)'}`}
      >
        <textarea
          name="note"
          rows={2}
          maxLength={2000}
          required={NOTE_NEEDED.has(result)}
          className={input}
        />
      </Field>
      <button className={button}>Save response</button>
      {msg}
    </form>
  );
}

type Dialog =
  | { kind: 'submit' }
  | { kind: 'observe' }
  | { kind: 'action'; f: Row }
  | { kind: 'review'; decision: 'ACCEPTED' | 'RETURNED' };

/** Compliance and audit workspace (wireframe 03, UI_SPEC 03). */
export function AuditRun() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { api, orgId, me } = useApp();
  const can = useCan();
  const people = usePeople();
  const res = useOne<Row>(`/api/v1/audit-runs/${id}`);
  const a = res.data;
  const samples: Row[] = a?.samples ?? [];
  const [sampleType, setSampleType] = useState<string>('STAFF');
  const types = new Set<string>([sampleType, ...samples.map((s) => s.subjectType as string)]);
  const subjects = useSubjects(types);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(me.user.id);
  const [deadline, setDeadline] = useState('');
  const [kind, setKind] = useState<'ACTION' | 'REAUDIT'>('ACTION');
  const [severity, setSeverity] = useState('');
  const [control, setControl] = useState('');
  const [summary, setSummary] = useState('');

  if (res.isLoading) return <p role="status">Loading…</p>;
  if (res.isError || !a) return <p role="alert">This audit is not available.</p>;
  const open =
    a.status === 'SCHEDULED' || a.status === 'IN_PROGRESS' || a.reviewState === 'RETURNED';
  const canReview =
    !!a.submittedAt &&
    !a.reviewState &&
    a.auditorUserId !== me.user.id &&
    can('compliance.audit.run') &&
    (!a.reviewerUserId || a.reviewerUserId === me.user.id);
  const unanswered = a.progress ? a.progress.total - a.progress.answered : 0;
  const reviewing = a.status === 'SUBMITTED' || a.status === 'ACTIONS_OPEN';
  const responses: Row[] = a.responses ?? [];
  const actions: Row[] = a.actions ?? [];
  const sampled: Subject[] = [...new Set(samples.flatMap((s) => s.subjectIds as string[]))].map(
    (sid) => ({ id: sid, label: subjects.label(sid) }),
  );
  const controlText = (code: string) => {
    const c = (a.controls as Row[]).find((x) => x.code === code);
    return c ? `${c.code}: ${c.question}` : code;
  };

  const beginAction = (f: Row) => {
    setTitle('');
    setOwner(a.ownerUserId);
    setDeadline('');
    setKind('ACTION');
    setSeverity('');
    setDialog({ kind: 'action', f });
  };
  const beginObservation = () => {
    setControl(a.controls[0]?.code ?? '');
    setSummary('');
    setSeverity('MEDIUM');
    setDialog({ kind: 'observe' });
  };

  const dialogProps = (() => {
    if (!dialog) return null;
    if (dialog.kind === 'submit')
      return {
        title: `Submit for review: ${a.code} ${a.title}`,
        confirmLabel: 'Submit for review',
        disabled: false,
        run: () => api.send('POST', `/api/v1/audit-runs/${a.id}/submit`, orgId, {}),
        body: (
          <p>
            Responses are fixed once submitted. A finding is worked out for each control from the
            latest answer per sampled item. A failed critical control makes the audit non-compliant,
            and each failure gets a draft action for the owner. Your name is recorded.
          </p>
        ),
      };
    if (dialog.kind === 'review')
      return {
        title: `${dialog.decision === 'ACCEPTED' ? 'Accept' : 'Return'}: ${a.code} ${a.title}`,
        confirmLabel: dialog.decision === 'ACCEPTED' ? 'Accept audit' : 'Return to auditor',
        disabled: false,
        reasonLabel: dialog.decision === 'RETURNED' ? 'Why is it being returned?' : undefined,
        run: (reason: string) =>
          api.send('POST', `/api/v1/audit-runs/${a.id}/review`, orgId, {
            decision: dialog.decision,
            ...(reason ? { reason } : {}),
          }),
        body: (
          <p>
            {dialog.decision === 'ACCEPTED'
              ? 'Accepting confirms the results. A recurring audit schedules its next run.'
              : 'The auditor can add answers and submit again. Earlier answers stay as history.'}
          </p>
        ),
      };
    if (dialog.kind === 'observe')
      return {
        title: `Add an observation: ${a.code} ${a.title}`,
        confirmLabel: 'Add observation',
        disabled: summary.trim().length < 3 || !control,
        run: () =>
          api.send('POST', `/api/v1/audit-runs/${a.id}/findings`, orgId, {
            controlCode: control,
            summary: summary.trim(),
            severity,
          }),
        body: (
          <p>
            Use this for something seen during the audit that the questions did not cover. It is
            added as a failed finding and affects the outcome.
          </p>
        ),
      };
    const f = dialog.f;
    return {
      title: `Raise an action: ${controlText(f.controlCode)}`,
      confirmLabel: kind === 'REAUDIT' ? 'Schedule re-audit' : 'Raise action',
      disabled: title.trim().length < 3 || !deadline || !owner,
      run: () =>
        api.send('POST', `/api/v1/findings/${f.id}/actions`, orgId, {
          title: title.trim(),
          ownerUserId: owner,
          deadline,
          kind,
          ...(severity ? { severity } : {}),
        }),
      body: (
        <p>
          {kind === 'REAUDIT'
            ? 'A new audit run is scheduled on the same template version; this audit stays unchanged.'
            : 'The owner uploads evidence and a different person verifies it before the action closes.'}
        </p>
      ),
    };
  })();

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/compliance" className="font-medium text-hub-teal-dark underline">
          Compliance
        </Link>{' '}
        / {words(a.domain)} / {a.templateCode} / {a.code}
      </nav>
      <div className="grid gap-4 lg:grid-cols-3">
        <header className="rounded-lg border border-hub-line bg-hub-card p-4 lg:col-span-2">
          <h1 className="text-2xl font-bold">
            {a.code} {a.title}
          </h1>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Stage</dt>
            <dd>{RUN_STAGE[a.status] ?? words(a.status)}</dd>
            <dt className="font-semibold">Due</dt>
            <dd>
              {a.overdue ? (
                <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(a.dueDate)}`} />
              ) : (
                fmtDate(a.dueDate)
              )}
            </dd>
            <dt className="font-semibold">Period</dt>
            <dd>
              {a.periodFrom && a.periodTo
                ? `${fmtDate(a.periodFrom)} to ${fmtDate(a.periodTo)}`
                : 'Not set'}
            </dd>
            <dt className="font-semibold">Auditor</dt>
            <dd>
              {a.auditorUserId === me.user.id ? 'You' : (a.auditorName ?? 'Not a current member')}
            </dd>
            <dt className="font-semibold">Owner</dt>
            <dd>
              {a.ownerUserId === me.user.id ? 'You' : (a.ownerName ?? 'Not a current member')}
            </dd>
            <dt className="font-semibold">Sample</dt>
            <dd>
              {samples.length ? (
                <ul>
                  {samples.map((s) => (
                    <li key={s.id}>
                      {s.populationDesc} – {s.selectionMethod} ({s.subjectIds.length}
                      {s.dateFrom ? `, ${fmtDate(s.dateFrom)} to ${fmtDate(s.dateTo)}` : ''})
                      {s.repeatWarning?.length > 0 &&
                        ` – ${s.repeatWarning.length} also sampled in a recent audit`}
                    </li>
                  ))}
                </ul>
              ) : (
                'No sample recorded'
              )}
            </dd>
            <dt className="font-semibold">Controls</dt>
            <dd>
              <ul>
                {(a.controls as Row[]).map((c) => (
                  <li key={c.code}>
                    {c.code}: {c.question}
                    {c.critical ? ' (critical)' : ''}
                  </li>
                ))}
              </ul>
            </dd>
          </dl>
        </header>
        <section
          aria-labelledby="outcome-h"
          className="rounded-lg border border-hub-line bg-hub-card p-4"
        >
          <h2 id="outcome-h" className="font-semibold">
            Outcome
          </h2>
          {a.outcome ? (
            <StatusBadge status={a.outcome as StatusKind} reason={a.outcomeReason} />
          ) : (
            <p>Not submitted yet ({RUN_STAGE[a.status] ?? words(a.status)}).</p>
          )}
          {a.submittedAt && <p className="mt-1 text-sm">Submitted {fmtDateTime(a.submittedAt)}</p>}
          {a.overall?.text && <p className="mt-1 text-sm font-medium">{a.overall.text}</p>}
          {a.progress && open && (
            <p className="mt-1 text-sm">
              {a.progress.answered} of {a.progress.total} controls answered ({a.progress.percent}
              %). Answers are saved as you go.
            </p>
          )}
          {a.reviewState === 'RETURNED' && (
            <p className="mt-1">
              <StatusBadge status="AMBER" reason="Returned by the reviewer – answer and resubmit" />
            </p>
          )}
          {a.reviewState === 'ACCEPTED' && (
            <p className="mt-1">
              <StatusBadge status="GREEN" reason="Accepted by the reviewer" />
            </p>
          )}
          <p className="mt-2 text-sm">Closure requires verification.</p>
          {open &&
            can('compliance.audit.run') &&
            (responses.length && unanswered === 0 ? (
              <button
                className={`${smallButton} mt-2`}
                onClick={() => setDialog({ kind: 'submit' })}
              >
                Submit for review
              </button>
            ) : responses.length ? (
              <p className="mt-2 text-sm">
                Answer every control before submitting ({unanswered} still to answer).
              </p>
            ) : (
              <p className="mt-2 text-sm">Record at least one response before submitting.</p>
            ))}
          {canReview && (
            <div className="mt-2 flex gap-2">
              <button
                className={smallButton}
                onClick={() => setDialog({ kind: 'review', decision: 'ACCEPTED' })}
              >
                Accept
              </button>
              <button
                className={smallButton}
                onClick={() => setDialog({ kind: 'review', decision: 'RETURNED' })}
              >
                Return with reason
              </button>
            </div>
          )}
          {((a.reviews as Row[] | undefined) ?? []).length > 0 && (
            <ul aria-label="Reviews" className="mt-2 text-sm">
              {(a.reviews as Row[]).map((v, i) => (
                <li key={i}>
                  {v.decision === 'ACCEPTED' ? 'Accepted' : 'Returned'} by{' '}
                  {v.byName ?? 'former member'}, {fmtDateTime(v.at)}
                  {v.reason && v.decision === 'RETURNED' ? `: ${v.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {open && can('compliance.audit.run') && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Record a response">
            <ResponseForm a={a} subjects={sampled} />
          </Section>
          <Section title="Record the sample">
            <SampleForm
              a={a}
              subjects={subjects.options[sampleType] ?? []}
              type={sampleType}
              setType={setSampleType}
            />
          </Section>
        </div>
      )}
      <Section title="Responses">
        <DataTable<Row>
          caption="Responses recorded"
          rows={responses}
          rowKey={(r) => r.id}
          emptyMessage="No responses recorded yet."
          columns={[
            { key: 'c', header: 'Control', cell: (r) => controlText(r.controlCode) },
            { key: 'i', header: 'Item', cell: (r) => subjects.label(r.subjectId) },
            {
              key: 'r',
              header: 'Result',
              cell: (r) => (
                <StatusBadge status={RESULT_KIND[r.result] ?? 'GREY'} reason={words(r.result)} />
              ),
            },
            { key: 'm', header: 'Method', cell: (r) => words(r.method) },
            { key: 'n', header: 'Note', cell: (r) => r.note ?? '—' },
            {
              key: 'w',
              header: 'Recorded',
              cell: (r) => `${r.recordedByName ?? 'Former member'}, ${fmtDateTime(r.recordedAt)}`,
            },
          ]}
        />
        <p className="text-sm text-slate-700">
          A later answer for the same control and item replaces the earlier one when the audit is
          submitted; earlier answers stay here as history.
        </p>
      </Section>
      <Section
        title="Findings and controls"
        actions={
          reviewing && can('compliance.audit.run') ? (
            <button className={smallButton} onClick={beginObservation}>
              Add an observation
            </button>
          ) : undefined
        }
      >
        <DataTable<Row>
          caption="Findings"
          rows={a.findings}
          rowKey={(r) => r.id}
          emptyMessage="Findings appear when the audit is submitted."
          columns={[
            { key: 'c', header: 'Finding / control', cell: (r) => controlText(r.controlCode) },
            { key: 'e', header: 'Evidence', cell: (r) => r.summary },
            {
              key: 'v',
              header: 'Severity',
              cell: (r) => (r.severity ? words(r.severity) : '—'),
            },
            {
              key: 's',
              header: 'State',
              cell: (r) => (
                <StatusBadge
                  status={RESULT_KIND[r.result] ?? 'GREY'}
                  reason={`${words(r.result)} – ${r.summary}`}
                />
              ),
            },
            {
              key: 'x',
              header: 'Follow-up',
              cell: (r) => {
                const raised = actions.filter((x) => x.sourceId === r.id);
                return (
                  <div className="flex flex-wrap items-center gap-2">
                    {raised.length > 0 && (
                      <span className="text-xs">
                        Raised: {raised.map((x) => x.code).join(', ')}
                      </span>
                    )}
                    {reviewing &&
                      NEEDS_FOLLOW_UP.has(r.result) &&
                      can('compliance.action.manage') && (
                        <button
                          className={smallButton}
                          aria-label={`Raise an action: ${r.controlCode}`}
                          onClick={() => beginAction(r)}
                        >
                          Raise action
                        </button>
                      )}
                  </div>
                );
              },
            },
          ]}
        />
      </Section>
      <Section title="Actions">
        <ActionsTable rows={actions} caption="Actions from this audit" />
      </Section>
      <Section title="Evidence and decision history">
        <ol className="space-y-1 text-sm">
          {actions
            .flatMap((x) => x.history.map((h: Row) => ({ ...h, code: x.code })))
            .sort((x: Row, y: Row) => x.at.localeCompare(y.at))
            .map((h: Row, i: number) => (
              <li key={i}>
                {fmtDateTime(h.at)} – {h.code}: {words(h.toStatus)}
                {h.note ? ` (${h.note})` : ''}
              </li>
            ))}
        </ol>
        <p className="text-sm text-slate-700">
          Original audit, findings and source version remain unchanged after corrective action.
          Results never change after corrective action: a re-audit records new results.
        </p>
      </Section>
      <ActionDialog
        open={dialogProps !== null}
        title={dialogProps?.title ?? ''}
        confirmLabel={dialogProps?.confirmLabel ?? ''}
        confirmDisabled={dialogProps?.disabled}
        reasonLabel={dialogProps?.reasonLabel}
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => dialogProps!.run(reason)}
        fields={
          dialog?.kind === 'observe' ? (
            <>
              <Field label="Control it relates to">
                <select
                  className={input}
                  value={control}
                  onChange={(e) => setControl(e.target.value)}
                >
                  {(a.controls as Row[]).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}: {c.question}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="What was observed">
                <textarea
                  className={input}
                  rows={3}
                  maxLength={1000}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </Field>
              <Field label="Severity">
                <select
                  className={input}
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {words(s)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : dialog?.kind === 'action' ? (
            <>
              <Field label="Type">
                <select
                  className={input}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as 'ACTION' | 'REAUDIT')}
                >
                  <option value="ACTION">Corrective action</option>
                  <option value="REAUDIT">Re-audit</option>
                </select>
              </Field>
              <Field label="What needs to happen">
                <input
                  className={input}
                  maxLength={300}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              <PersonSelect
                label="Owner"
                value={owner}
                onChange={setOwner}
                people={people}
                meId={me.user.id}
              />
              <Field label="Deadline">
                <input
                  type="date"
                  className={input}
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </Field>
              <Field label="Severity">
                <select
                  className={input}
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="">Same as the finding</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {words(s)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : undefined
        }
      >
        {dialogProps?.body}
      </ActionDialog>
    </div>
  );
}
