import { DataTable, StatusBadge } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useList, useOne, usePeople } from '../settings/hooks.js';
import { ActionsTable } from './Compliance.js';
import { CandourFlag } from './Events.js';
import {
  CANDOUR_STEP,
  CATEGORY,
  CHANNEL,
  DUTY_BODY,
  EVENT_STAGE,
  EVENT_TYPE,
  HARM,
  LEARNING_RESPONSE,
  OUTCOME,
  PRIORITY,
  STAGES,
} from './eventLabels.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind =
  | 'forward'
  | 'back'
  | 'candour'
  | 'addDuty'
  | 'decide'
  | 'submitted'
  | 'ack'
  | 'respond'
  | 'action'
  | 'triage'
  | 'suggested'
  | 'candourStep'
  | 'learning'
  | 'reopenComplaint';

function Duty({ o }: { o: Row }) {
  if (o.decision === 'NOT_REQUIRED')
    return <StatusBadge status="NOT_APPLICABLE" reason="Decided not required" />;
  if (o.decision === 'REQUIRED' && o.submittedAt)
    return <StatusBadge status="GREEN" reason={`Submitted ${fmtDateTime(o.submittedAt)}`} />;
  if (o.overdue)
    return <StatusBadge status="RED" reason={`Overdue – was due ${fmtDateTime(o.deadlineAt)}`} />;
  if (o.decision === 'REQUIRED')
    return <StatusBadge status="AMBER" reason="Required – not yet submitted" />;
  return <StatusBadge status="AMBER" reason="Decision needed" />;
}

function Target({ by, done, overdue }: { by: string; done: string | null; overdue: boolean }) {
  if (done)
    return (
      <>
        Done {fmtDate(done)} (target {fmtDate(by)})
      </>
    );
  if (overdue) return <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(by)}`} />;
  return <>By {fmtDate(by)}</>;
}

/** One event through triage to verified learning (EVT-01..04). */
export function EventDetail() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { api, orgId, me } = useApp();
  const can = useCan();
  const people = usePeople();
  const res = useOne<Row>(`/api/v1/events/${id}`);
  const suggestions = useList(
    `/api/v1/events/${id}/obligation-suggestions`,
    can('events.event.manage'),
  );
  const [dialog, setDialog] = useState<{ kind: Kind; o?: Row } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  if (res.isLoading) return <p role="status">Loading…</p>;
  if (res.isError || !res.data) return <p role="alert">This event is not available.</p>;
  const e = res.data;
  const manage = can('events.event.manage');
  const idx = STAGES.indexOf(e.status);
  const next = idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
  const prev = idx > 0 ? STAGES[idx - 1] : null;
  const pending = (e.obligations as Row[]).filter((o) => o.decision === 'PENDING').length;
  const candourNeeded = e.candourFlag && !e.candourDecided;
  const openActions = (e.actions as Row[]).filter((a) => a.status !== 'VERIFIED').length;
  const untriaged = !!e.reportedByName && !e.triagedAt;
  const blocker =
    e.status === 'TRIAGE' && untriaged
      ? 'Complete triage (harm, category, owner and protection steps) before moving on.'
      : e.status === 'ASSESS' && pending > 0
        ? `Record a decision on ${pending} reporting ${pending === 1 ? 'duty' : 'duties'} before moving on.`
        : e.status === 'ASSESS' && candourNeeded
          ? 'A duty of candour decision is needed before moving on.'
          : e.status === 'ACTIONS' && openActions > 0
            ? `${openActions} action${openActions === 1 ? '' : 's'} must be verified before learning can be confirmed.`
            : null;

  const begin = (kind: Kind, o?: Row, init: Record<string, string> = {}) => {
    setF(init);
    setDialog({ kind, o });
  };
  const today = new Date().toISOString().slice(0, 10);
  const o = dialog?.o;
  const v = (k: string) => f[k] ?? '';
  const dt = (k: string) => new Date(v(k)).toISOString();
  const spec: Record<
    Kind,
    {
      title: string;
      confirm: string;
      reasonLabel?: string;
      disabled?: boolean;
      danger?: boolean;
      text: ReactNode;
      fields?: ReactNode;
      run: (reason: string) => Promise<unknown>;
    }
  > = {
    forward: {
      title: `Move to ${EVENT_STAGE[next ?? ''] ?? ''}`,
      confirm: 'Move on',
      reasonLabel: 'What was done at this stage?',
      text: 'The note is kept in the event history with your name.',
      run: (note) =>
        api.send('POST', `/api/v1/events/${e.id}/transition`, orgId, { to: next, note }),
    },
    back: {
      title: `Reopen: back to ${EVENT_STAGE[prev ?? ''] ?? ''}`,
      confirm: 'Reopen',
      reasonLabel: 'Why is it being reopened?',
      danger: true,
      text: 'The event goes back one stage. Nothing already recorded is removed.',
      run: (note) =>
        api.send('POST', `/api/v1/events/${e.id}/transition`, orgId, { to: prev, note }),
    },
    candour: {
      title: 'Record duty of candour decision',
      confirm: 'Record decision',
      disabled: v('reason').trim().length < 10 || !v('notifiable'),
      text: 'The system only flags possible candour; this decision is yours and cannot be changed later. A new decision can be added if things change.',
      fields: (
        <>
          <Field label="Is this a notifiable safety incident?">
            <select
              className={input}
              value={v('notifiable')}
              onChange={(x) => set('notifiable')(x.target.value)}
            >
              <option value="">Choose…</option>
              <option value="yes">Yes – the duty of candour applies</option>
              <option value="no">No – the duty of candour does not apply</option>
            </select>
          </Field>
          <Field label="Reason (at least 10 characters)">
            <textarea
              className={input}
              rows={3}
              maxLength={2000}
              value={v('reason')}
              onChange={(x) => set('reason')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/candour-assessment`, orgId, {
          notifiable: v('notifiable') === 'yes',
          reason: v('reason').trim(),
        }),
    },
    addDuty: {
      title: 'Add a reporting duty to consider',
      confirm: 'Add duty',
      disabled: v('trigger').trim().length < 3 || v('basis').trim().length < 3,
      text: 'Adding a duty does not mean it applies: each one needs its own decision with a reason.',
      fields: (
        <>
          <Field label="Who it may need reporting to">
            <select
              className={input}
              value={v('body') || 'CQC'}
              onChange={(x) => set('body')(x.target.value)}
            >
              {Object.entries(DUTY_BODY).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What may trigger it">
            <input
              className={input}
              maxLength={500}
              value={v('trigger')}
              onChange={(x) => set('trigger')(x.target.value)}
            />
          </Field>
          <Field label="Legal or contract basis">
            <input
              className={input}
              maxLength={500}
              value={v('basis')}
              onChange={(x) => set('basis')(x.target.value)}
            />
          </Field>
          <Field label="Deadline (optional)">
            <input
              type="datetime-local"
              className={input}
              value={v('deadline')}
              onChange={(x) => set('deadline')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/obligations`, orgId, {
          body: v('body') || 'CQC',
          trigger: v('trigger').trim(),
          basis: v('basis').trim(),
          ...(v('deadline') ? { deadlineAt: dt('deadline') } : {}),
        }),
    },
    decide: {
      title: `Decide: ${DUTY_BODY[o?.body] ?? ''}`,
      confirm: 'Record decision',
      reasonLabel: 'Reason for the decision',
      text: 'Your name and reason are recorded.',
      fields: (
        <Field label="Decision">
          <select
            className={input}
            value={v('decision') || 'REQUIRED'}
            onChange={(x) => set('decision')(x.target.value)}
          >
            <option value="REQUIRED">Required – it must be reported</option>
            <option value="NOT_REQUIRED">Not required</option>
          </select>
        </Field>
      ),
      run: (reason) =>
        api.send(
          'PATCH',
          `/api/v1/obligations/${o!.id}`,
          orgId,
          { decision: v('decision') || 'REQUIRED', decisionReason: reason },
          o!.version,
        ),
    },
    submitted: {
      title: `Record submission: ${DUTY_BODY[o?.body] ?? ''}`,
      confirm: 'Record submission',
      disabled: !v('submittedAt'),
      text: 'Record when it was sent and the reference you were given.',
      fields: (
        <>
          <Field label="Sent at">
            <input
              type="datetime-local"
              className={input}
              value={v('submittedAt')}
              onChange={(x) => set('submittedAt')(x.target.value)}
            />
          </Field>
          <Field label="Reference (optional)">
            <input
              className={input}
              maxLength={120}
              value={v('reference')}
              onChange={(x) => set('reference')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send(
          'PATCH',
          `/api/v1/obligations/${o!.id}`,
          orgId,
          {
            submittedAt: dt('submittedAt'),
            ...(v('reference').trim() ? { reference: v('reference').trim() } : {}),
          },
          o!.version,
        ),
    },
    ack: {
      title: 'Record complaint acknowledgement',
      confirm: 'Record acknowledgement',
      disabled: !v('date'),
      text: 'The date the complainant was told their complaint was received.',
      fields: (
        <Field label="Acknowledged on">
          <input
            type="date"
            className={input}
            max={today}
            value={v('date')}
            onChange={(x) => set('date')(x.target.value)}
          />
        </Field>
      ),
      run: () =>
        api.send(
          'PATCH',
          `/api/v1/events/${e.id}/complaint`,
          orgId,
          { acknowledgedOn: v('date') },
          e.complaint?.version,
        ),
    },
    respond: {
      title: 'Record complaint response',
      confirm: 'Record response',
      disabled: !v('date') || !v('outcome'),
      text: 'The response should tell the complainant how to escalate if they are not satisfied.',
      fields: (
        <>
          <Field label="Responded on">
            <input
              type="date"
              className={input}
              max={today}
              value={v('date')}
              onChange={(x) => set('date')(x.target.value)}
            />
          </Field>
          <Field label="Outcome">
            <select
              className={input}
              value={v('outcome')}
              onChange={(x) => set('outcome')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(OUTCOME).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v('escalation') === 'yes'}
              onChange={(x) => set('escalation')(x.target.checked ? 'yes' : '')}
            />
            The complainant was told their escalation rights
          </label>
        </>
      ),
      run: () =>
        api.send(
          'PATCH',
          `/api/v1/events/${e.id}/complaint`,
          orgId,
          {
            respondedOn: v('date'),
            outcome: v('outcome'),
            escalationRightsGiven: v('escalation') === 'yes',
          },
          e.complaint?.version,
        ),
    },
    action: {
      title: `Raise an action: ${e.code} ${e.title}`,
      confirm: 'Raise action',
      disabled: v('title').trim().length < 3 || !v('deadline'),
      text: 'The owner uploads evidence and a different person verifies it before the action closes.',
      fields: (
        <>
          <Field label="What needs to happen">
            <input
              className={input}
              maxLength={300}
              value={v('title')}
              onChange={(x) => set('title')(x.target.value)}
            />
          </Field>
          <PersonSelect
            label="Owner"
            value={v('owner') || e.leadUserId}
            onChange={set('owner')}
            people={people}
            meId={me.user.id}
          />
          <Field label="Deadline">
            <input
              type="date"
              className={input}
              min={today}
              value={v('deadline')}
              onChange={(x) => set('deadline')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/actions`, orgId, {
          title: v('title').trim(),
          ownerUserId: v('owner') || e.leadUserId,
          deadline: v('deadline'),
        }),
    },
    triage: {
      title: `Triage: ${e.code} ${e.title}`,
      confirm: 'Save triage',
      disabled: !v('priority') || !v('harm') || !v('category') || v('steps').trim().length < 3,
      text: 'Triage is due within one working day of the report. Your name is recorded.',
      fields: (
        <>
          <Field label="Priority">
            <select
              className={input}
              value={v('priority')}
              onChange={(x) => set('priority')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(PRIORITY).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Harm">
            <select
              className={input}
              value={v('harm')}
              onChange={(x) => set('harm')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(HARM).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              className={input}
              value={v('category')}
              onChange={(x) => set('category')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(CATEGORY).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <PersonSelect
            label="Owner (lead)"
            value={v('lead') || e.leadUserId}
            onChange={set('lead')}
            people={people}
            meId={me.user.id}
          />
          <Field label="Protection steps taken">
            <textarea
              className={input}
              rows={3}
              maxLength={2000}
              value={v('steps')}
              onChange={(x) => set('steps')(x.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={v('nhs') === 'yes'}
              onChange={(x) => set('nhs')(x.target.checked ? 'yes' : '')}
            />
            NHS-funded care (needs a PSIRF learning response)
          </label>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/triage`, orgId, {
          priority: v('priority'),
          harm: v('harm'),
          category: v('category'),
          leadUserId: v('lead') || e.leadUserId,
          protectionSteps: v('steps').trim(),
          nhsFunded: v('nhs') === 'yes',
        }),
    },
    suggested: {
      title: 'Add the suggested reporting duties',
      confirm: 'Add duties',
      text: 'Each duty is added as "decision needed". Adding it does not decide that it applies.',
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/obligations/suggested`, orgId, {
          bodies: ((suggestions.data as Row[] | undefined) ?? [])
            .filter((s) => !s.recorded)
            .map((s) => s.body),
        }),
    },
    candourStep: {
      title: 'Record a duty of candour step',
      confirm: 'Record step',
      disabled: !v('step') || !v('doneOn'),
      text: 'Steps are kept in order with your name and cannot be changed.',
      fields: (
        <>
          <Field label="Step">
            <select
              className={input}
              value={v('step')}
              onChange={(x) => set('step')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(CANDOUR_STEP).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Done on">
            <input
              type="date"
              className={input}
              max={today}
              value={v('doneOn')}
              onChange={(x) => set('doneOn')(x.target.value)}
            />
          </Field>
          <Field label="Note (optional)">
            <input
              className={input}
              maxLength={1000}
              value={v('note')}
              onChange={(x) => set('note')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/candour-steps`, orgId, {
          step: v('step'),
          doneOn: v('doneOn'),
          ...(v('note').trim() ? { note: v('note').trim() } : {}),
        }),
    },
    learning: {
      title: 'Record the learning response (PSIRF)',
      confirm: 'Record learning response',
      disabled: !v('response') || v('notes').trim().length < 3,
      text: 'NHS-funded incidents cannot close without a learning response.',
      fields: (
        <>
          <Field label="Learning response">
            <select
              className={input}
              value={v('response')}
              onChange={(x) => set('response')(x.target.value)}
            >
              <option value="">Choose…</option>
              {Object.entries(LEARNING_RESPONSE).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What was learned">
            <textarea
              className={input}
              rows={3}
              maxLength={4000}
              value={v('notes')}
              onChange={(x) => set('notes')(x.target.value)}
            />
          </Field>
          <Field label="Contributory factors (optional)">
            <textarea
              className={input}
              rows={2}
              maxLength={4000}
              value={v('factors')}
              onChange={(x) => set('factors')(x.target.value)}
            />
          </Field>
        </>
      ),
      run: () =>
        api.send('POST', `/api/v1/events/${e.id}/learning`, orgId, {
          response: v('response'),
          notes: v('notes').trim(),
          ...(v('factors').trim() ? { contributoryFactors: v('factors').trim() } : {}),
        }),
    },
    reopenComplaint: {
      title: `Reopen complaint: ${e.code}`,
      confirm: 'Reopen complaint',
      reasonLabel: 'Why is the complaint being reopened?',
      danger: true,
      text:
        'The response and outcome are cleared and the event goes back to Investigate. ' +
        'History is kept.',
      run: (reason) =>
        api.send(
          'PATCH',
          `/api/v1/events/${e.id}/complaint`,
          orgId,
          { reopenReason: reason },
          e.complaint?.version,
        ),
    },
  };
  const d = dialog ? spec[dialog.kind] : null;

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link
          to="/compliance"
          search={{ tab: 'events' }}
          className="font-medium text-hub-teal-dark underline"
        >
          Events
        </Link>{' '}
        / {e.code}
      </nav>
      <header className="rounded-lg border border-hub-line bg-hub-card p-4">
        <h1 className="text-2xl font-bold">
          {e.code} {e.title}
        </h1>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="font-semibold">Type</dt>
          <dd>{(e.types as string[]).map((t) => EVENT_TYPE[t] ?? t).join(', ')}</dd>
          <dt className="font-semibold">Harm</dt>
          <dd>{HARM[e.severity] ?? e.severity}</dd>
          <dt className="font-semibold">Happened</dt>
          <dd>
            {fmtDateTime(e.occurredAt)} (found {fmtDateTime(e.discoveredAt)})
          </dd>
          <dt className="font-semibold">Lead</dt>
          <dd>{e.leadUserId === me.user.id ? 'You' : (e.leadName ?? 'Not a current member')}</dd>
          <dt className="font-semibold">What happened</dt>
          <dd className="whitespace-pre-wrap">{e.description}</dd>
          {e.reportedByName && (
            <>
              <dt className="font-semibold">Reported by</dt>
              <dd>{e.reportedByName}</dd>
            </>
          )}
          {e.place && (
            <>
              <dt className="font-semibold">Place</dt>
              <dd>{e.place}</dd>
            </>
          )}
          {(e.peopleRefs as string[] | undefined)?.length ? (
            <>
              <dt className="font-semibold">Job or booking references</dt>
              <dd>{(e.peopleRefs as string[]).join(', ')}</dd>
            </>
          ) : null}
          {e.immediateActions && (
            <>
              <dt className="font-semibold">Done straight away</dt>
              <dd>{e.immediateActions}</dd>
            </>
          )}
        </dl>
        {e.stillAtRisk && (
          <p className="mt-2">
            <StatusBadge status="RED" reason="Reported as still at risk" />
          </p>
        )}
        <CandourFlag e={e} />
      </header>

      {e.reportedByName && (
        <Section
          title="Triage"
          actions={
            manage && untriaged && e.status === 'TRIAGE' ? (
              <button className={smallButton} onClick={() => begin('triage')}>
                Triage this report
              </button>
            ) : undefined
          }
        >
          {e.triagedAt ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="font-semibold">Priority</dt>
              <dd>{PRIORITY[e.priority] ?? 'Not set'}</dd>
              <dt className="font-semibold">Category</dt>
              <dd>{CATEGORY[e.category] ?? 'Not set'}</dd>
              <dt className="font-semibold">Protection steps</dt>
              <dd className="whitespace-pre-wrap">{e.protectionSteps}</dd>
              <dt className="font-semibold">Triaged</dt>
              <dd>
                {fmtDateTime(e.triagedAt)} by {e.triagedByName ?? 'former member'}
              </dd>
            </dl>
          ) : e.triageOverdue ? (
            <StatusBadge
              status="RED"
              reason={`Triage overdue – was due ${fmtDateTime(e.triageDueAt)}`}
            />
          ) : (
            <StatusBadge
              status="AMBER"
              reason={`Waiting for triage – due ${fmtDateTime(e.triageDueAt)}`}
            />
          )}
        </Section>
      )}

      {(e.closeBlockers as string[] | undefined)?.length ? (
        <Section title="Before this can close">
          <ul aria-label="Before this can close" className="list-disc pl-5 text-sm">
            {(e.closeBlockers as string[]).map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Stage">
        <ol className="flex flex-wrap gap-2 text-sm" aria-label="Event stages">
          {STAGES.map((s, i) => (
            <li
              key={s}
              aria-current={s === e.status ? 'step' : undefined}
              className={`rounded border px-2 py-1 ${s === e.status ? 'border-hub-teal font-semibold' : 'border-hub-line'}`}
            >
              {i < idx ? 'Done: ' : s === e.status ? 'Now: ' : ''}
              {EVENT_STAGE[s]}
            </li>
          ))}
        </ol>
        {blocker && <p className="text-sm">{blocker}</p>}
        {manage && (
          <div className="flex flex-wrap gap-2">
            {next && (
              <button className={smallButton} disabled={!!blocker} onClick={() => begin('forward')}>
                Move to {EVENT_STAGE[next]}
              </button>
            )}
            {prev && e.status !== 'TRIAGE' && (
              <button className={smallButton} onClick={() => begin('back')}>
                Reopen: back to {EVENT_STAGE[prev]}
              </button>
            )}
          </div>
        )}
      </Section>

      {e.candourFlag && (
        <Section
          title="Duty of candour"
          actions={
            can('events.candour.decide') ? (
              <button className={smallButton} onClick={() => begin('candour')}>
                Record decision
              </button>
            ) : undefined
          }
        >
          <p className="text-sm">
            The system flagged this event because of the harm recorded. It never decides: a person
            with authority records whether the duty applies.
          </p>
          {(e.candour as Row[]).length === 0 ? (
            <p className="text-sm font-medium">No decision recorded yet.</p>
          ) : (
            <ul className="text-sm">
              {(e.candour as Row[]).map((c, i) => (
                <li key={i}>
                  {c.notifiable ? 'Applies' : 'Does not apply'} – {c.reason} (
                  {c.decidedByName ?? 'former member'}, {fmtDateTime(c.decidedAt)})
                </li>
              ))}
            </ul>
          )}
          {((e.candourSteps as Row[] | undefined) ?? []).length > 0 && (
            <ol aria-label="Candour steps done" className="list-decimal pl-5 text-sm">
              {(e.candourSteps as Row[]).map((s) => (
                <li key={s.step}>
                  {CANDOUR_STEP[s.step] ?? s.label} – {fmtDate(s.doneOn)} (
                  {s.byName ?? 'former member'}){s.note ? `: ${s.note}` : ''}
                </li>
              ))}
            </ol>
          )}
          {((e.candourOutstanding as string[] | undefined) ?? []).length > 0 && (
            <>
              <p className="text-sm font-medium">Steps still to do:</p>
              <ul className="list-disc pl-5 text-sm">
                {(e.candourOutstanding as string[]).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              {manage && (
                <button className={smallButton} onClick={() => begin('candourStep')}>
                  Record a candour step
                </button>
              )}
            </>
          )}
        </Section>
      )}

      {e.nhsFunded && (
        <Section
          title="Learning response (PSIRF)"
          actions={
            manage && !e.learningResponse ? (
              <button className={smallButton} onClick={() => begin('learning')}>
                Record learning response
              </button>
            ) : undefined
          }
        >
          {e.learningResponse ? (
            <p className="text-sm">
              {LEARNING_RESPONSE[e.learningResponse] ?? 'Recorded'}: {e.learningNotes}
              {e.contributoryFactors ? ` Contributory factors: ${e.contributoryFactors}` : ''}
            </p>
          ) : (
            <StatusBadge status="AMBER" reason="Learning response needed before closing" />
          )}
        </Section>
      )}

      <Section
        title="Reporting duties"
        actions={
          manage ? (
            <div className="flex gap-2">
              {((suggestions.data as Row[] | undefined) ?? []).some((s) => !s.recorded) && (
                <button className={smallButton} onClick={() => begin('suggested')}>
                  Add suggested duties
                </button>
              )}
              <button className={smallButton} onClick={() => begin('addDuty')}>
                Add a reporting duty
              </button>
            </div>
          ) : undefined
        }
      >
        {((suggestions.data as Row[] | undefined) ?? []).some((s) => !s.recorded) && (
          <div className="rounded border border-hub-line bg-hub-card p-3 text-sm">
            <p className="font-medium">Suggested from what was recorded (a person decides):</p>
            <ul className="list-disc pl-5">
              {((suggestions.data as Row[]) ?? [])
                .filter((s) => !s.recorded)
                .map((s) => (
                  <li key={s.body}>
                    {DUTY_BODY[s.body] ?? s.body}: {s.trigger} ({s.deadlineText})
                    {s.draftText && (
                      <span className="block whitespace-pre-wrap text-xs">
                        Draft: {s.draftText}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        )}
        <DataTable<Row>
          caption="Reporting duties"
          rows={e.obligations}
          rowKey={(x) => x.id}
          emptyMessage="No reporting duties recorded. Not every event is reportable; add each duty that may apply and decide it."
          columns={[
            { key: 'b', header: 'Report to', cell: (x) => DUTY_BODY[x.body] ?? x.body },
            {
              key: 't',
              header: 'Trigger and basis',
              cell: (x) => (
                <>
                  {x.trigger}
                  <span className="block text-xs">{x.basis}</span>
                </>
              ),
            },
            {
              key: 'd',
              header: 'Deadline',
              cell: (x) => (x.deadlineAt ? fmtDateTime(x.deadlineAt) : 'None set'),
            },
            { key: 's', header: 'State', cell: (x) => <Duty o={x} /> },
            {
              key: 'r',
              header: 'Decision',
              cell: (x) =>
                x.decisionReason
                  ? `${x.decisionReason} (${x.decidedByName ?? 'former member'})${x.reference ? ` – ref ${x.reference}` : ''}`
                  : '—',
            },
            {
              key: 'x',
              header: 'Action',
              cell: (x) =>
                !manage ? null : x.decision === 'PENDING' ? (
                  <button
                    className={smallButton}
                    aria-label={`Decide: ${DUTY_BODY[x.body] ?? x.body}`}
                    onClick={() => begin('decide', x)}
                  >
                    Decide
                  </button>
                ) : x.decision === 'REQUIRED' && !x.submittedAt ? (
                  <button
                    className={smallButton}
                    aria-label={`Record submission: ${DUTY_BODY[x.body] ?? x.body}`}
                    onClick={() => begin('submitted', x)}
                  >
                    Record submission
                  </button>
                ) : null,
            },
          ]}
        />
      </Section>

      {e.complaint && (
        <Section title="Complaint">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Received</dt>
            <dd>
              {fmtDate(e.complaint.receivedOn)} by{' '}
              {(CHANNEL[e.complaint.channel] ?? e.complaint.channel).toLowerCase()}
            </dd>
            <dt className="font-semibold">Acknowledge</dt>
            <dd>
              <Target
                by={e.complaint.acknowledgeBy}
                done={e.complaint.acknowledgedOn}
                overdue={e.complaint.acknowledgeOverdue}
              />
            </dd>
            <dt className="font-semibold">Respond</dt>
            <dd>
              <Target
                by={e.complaint.respondBy}
                done={e.complaint.respondedOn}
                overdue={e.complaint.respondOverdue}
              />
            </dd>
            <dt className="font-semibold">Preferences</dt>
            <dd>{e.complaint.preferences ?? 'None recorded'}</dd>
            <dt className="font-semibold">Consent to share</dt>
            <dd>{e.complaint.consentToShare ? 'Given' : 'Not given'}</dd>
            <dt className="font-semibold">Outcome</dt>
            <dd>
              {e.complaint.outcome ? OUTCOME[e.complaint.outcome] : 'Not decided'}
              {e.complaint.outcome &&
                (e.complaint.escalationRightsGiven
                  ? ' – escalation rights given'
                  : ' – escalation rights not recorded')}
            </dd>
          </dl>
          {e.complaint.escalationText && (
            <p className="rounded border border-hub-line bg-hub-card p-2 text-sm">
              <span className="font-semibold">Escalation rights to include: </span>
              {e.complaint.escalationText}
            </p>
          )}
          {manage && (
            <div className="flex gap-2">
              {!e.complaint.acknowledgedOn && (
                <button className={smallButton} onClick={() => begin('ack')}>
                  Record acknowledgement
                </button>
              )}
              {!e.complaint.respondedOn && (
                <button className={smallButton} onClick={() => begin('respond')}>
                  Record response
                </button>
              )}
              {e.complaint.respondedOn && (
                <button className={smallButton} onClick={() => begin('reopenComplaint')}>
                  Reopen complaint
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      {e.safeguarding && (
        <Section title="Safeguarding (restricted)">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Details</dt>
            <dd className="whitespace-pre-wrap">{e.safeguarding.details}</dd>
            <dt className="font-semibold">Agencies</dt>
            <dd>{e.safeguarding.agencies ?? 'None recorded'}</dd>
            <dt className="font-semibold">Referral reference</dt>
            <dd>{e.safeguarding.referralRef ?? 'None recorded'}</dd>
          </dl>
        </Section>
      )}

      <Section
        title="Actions"
        actions={
          manage || can('compliance.action.manage') ? (
            <button className={smallButton} onClick={() => begin('action')}>
              Raise an action
            </button>
          ) : undefined
        }
      >
        <ActionsTable rows={e.actions} caption="Actions from this event" />
      </Section>

      <Section title="History">
        <ol className="space-y-1 text-sm">
          {(e.transitions as Row[]).map((t, i) => (
            <li key={i}>
              {fmtDateTime(t.at)} – {EVENT_STAGE[t.toStatus] ?? t.toStatus} by{' '}
              {t.byName ?? 'former member'}: {t.note}
            </li>
          ))}
        </ol>
      </Section>

      <ActionDialog
        open={d !== null}
        title={d?.title ?? ''}
        confirmLabel={d?.confirm ?? ''}
        reasonLabel={d?.reasonLabel}
        danger={d?.danger}
        confirmDisabled={d?.disabled}
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => d!.run(reason)}
        fields={d?.fields}
      >
        <p>{d?.text}</p>
      </ActionDialog>
    </div>
  );
}
