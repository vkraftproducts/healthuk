import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
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

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Where an audit run stands, in words. */
export const RUN_STAGE: Record<string, string> = {
  SCHEDULED: 'Scheduled – not started',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted – findings being reviewed',
  ACTIONS_OPEN: 'Submitted – actions open',
  CLOSED: 'Closed',
};

const published = (t: Row): Row | undefined =>
  (t.versions as Row[]).find((v) => v.status === 'PUBLISHED');
const draft = (t: Row): Row | undefined => (t.versions as Row[]).find((v) => v.status === 'DRAFT');

const SPECIALIST_PACKS = new Set(['dental', 'care_home']);
const needsSpecialist = (t: Row) => !!t.sectorPack && SPECIALIST_PACKS.has(t.sectorPack);

function TemplateState({ t }: { t: Row }) {
  if (t.retiredAt)
    return (
      <StatusBadge
        status="NOT_APPLICABLE"
        reason={`Retired${t.retiredReason ? ` – ${t.retiredReason}` : ''}`}
      />
    );
  if (t.active) return <StatusBadge status="GREEN" reason="Active – can be scheduled" />;
  if (published(t)) return <StatusBadge status="AMBER" reason="Published – awaiting activation" />;
  return <StatusBadge status="GREY" reason="Draft – awaiting a second person to publish" />;
}

function ScheduleForm({ templates }: { templates: Row[] }) {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const services = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/services` : null,
  );
  const { run, msg } = useRun();
  const active = templates.filter((t) => t.active && published(t) && !t.retiredAt);
  const [auditor, setAuditor] = useState(me.user.id);
  const [owner, setOwner] = useState(me.user.id);
  const [reviewer, setReviewer] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const t = active.find((x) => x.id === f.get('template'));
    const v = t && published(t);
    if (!v) return;
    const opt = (k: string) => (f.get(k) ? { [k]: String(f.get(k)) } : {});
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/audit-runs', orgId, {
          templateVersionId: v.id,
          title: String(f.get('title')),
          ...opt('locationId'),
          ...opt('periodFrom'),
          ...opt('periodTo'),
          ...opt('serviceId'),
          auditorUserId: auditor,
          ownerUserId: owner,
          ...(reviewer ? { reviewerUserId: reviewer } : {}),
          ...(f.get('recurrenceMonths')
            ? { recurrenceMonths: Number(f.get('recurrenceMonths')) }
            : {}),
          dueDate: String(f.get('dueDate')),
        }),
      'Audit scheduled.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="Schedule an audit">
      {active.length === 0 ? (
        <p className="text-sm">
          No template is active yet. A template must be published by a second person and then
          activated by management before it can be scheduled.
        </p>
      ) : (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Template">
            <select name="template" required className={input}>
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} {t.title} (v{published(t)?.version})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Audit title">
            <input name="title" required minLength={2} maxLength={200} className={input} />
          </Field>
          <Field label="Location (optional)">
            <select name="locationId" className={input}>
              <option value="">Whole organisation</option>
              {(locations.data?.data ?? [])
                .filter((l) => !l.archived)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Period from (optional)">
            <input type="date" name="periodFrom" className={input} />
          </Field>
          <Field label="Period to (optional)">
            <input type="date" name="periodTo" className={input} />
          </Field>
          <Field label="Due date">
            <input type="date" name="dueDate" required className={input} />
          </Field>
          <PersonSelect
            label="Auditor"
            value={auditor}
            onChange={setAuditor}
            people={people}
            meId={me.user.id}
          />
          <PersonSelect
            label="Owner (acts on the findings)"
            value={owner}
            onChange={setOwner}
            people={people}
            meId={me.user.id}
          />
          <PersonSelect
            label="Reviewer (not the auditor; optional)"
            value={reviewer}
            onChange={setReviewer}
            people={people}
            meId={me.user.id}
            optional
          />
          <Field label="Service (optional)">
            <select name="serviceId" className={input}>
              <option value="">All services</option>
              {(services.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Repeat (optional)">
            <select name="recurrenceMonths" className={input} defaultValue="">
              <option value="">Does not repeat</option>
              <option value="1">Every month</option>
              <option value="3">Every 3 months</option>
              <option value="6">Every 6 months</option>
              <option value="12">Every year</option>
            </select>
          </Field>
          <div className="flex items-end">
            <button className={button}>Schedule audit</button>
          </div>
        </form>
      )}
      {msg}
    </Section>
  );
}

type Step = { kind: 'view' | 'publish' | 'activate' | 'clone' | 'retire'; t: Row };
const STEP_TITLE: Record<Step['kind'], string> = {
  view: 'Controls',
  publish: 'Publish',
  activate: 'Activate',
  clone: 'Copy as a new draft',
  retire: 'Retire',
};

/** Month or week view of scheduled audits; overdue ones are red with words (WORKFLOWS G2). */
function AuditCalendar({ runs }: { runs: Row[] }) {
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10));
  const start = new Date(`${anchor}T12:00:00Z`);
  let days: string[];
  if (mode === 'month') {
    const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12));
    const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 12));
    const n = last.getUTCDate();
    days = Array.from({ length: n }, (_, i) =>
      new Date(first.getTime() + i * 86_400_000).toISOString().slice(0, 10),
    );
  } else {
    const monday = new Date(start.getTime() - ((start.getUTCDay() + 6) % 7) * 86_400_000);
    days = Array.from({ length: 7 }, (_, i) =>
      new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10),
    );
  }
  const move = (dir: number) => {
    const d = new Date(`${anchor}T12:00:00Z`);
    if (mode === 'month') d.setUTCMonth(d.getUTCMonth() + dir);
    else d.setUTCDate(d.getUTCDate() + dir * 7);
    setAnchor(d.toISOString().slice(0, 10));
  };
  const byDay = new Map<string, Row[]>();
  for (const r of runs) {
    const k = String(r.dueDate).slice(0, 10);
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }
  return (
    <Section
      title="Audit calendar"
      actions={
        <div className="flex gap-2">
          <button className={smallButton} onClick={() => move(-1)}>
            Previous {mode}
          </button>
          <button className={smallButton} onClick={() => move(1)}>
            Next {mode}
          </button>
          <button
            className={smallButton}
            aria-pressed={mode === 'week'}
            onClick={() => setMode(mode === 'month' ? 'week' : 'month')}
          >
            {mode === 'month' ? 'Week view' : 'Month view'}
          </button>
        </div>
      }
    >
      <ul aria-label="Audits by due date" className="grid gap-1 text-sm sm:grid-cols-7">
        {days.map((d) => (
          <li key={d} className="min-h-12 rounded border border-hub-line bg-white p-1">
            <span className="block text-xs font-semibold">{fmtDate(d)}</span>
            {(byDay.get(d) ?? []).map((r) => (
              <Link
                key={r.id}
                to="/compliance/audits/$id"
                params={{ id: r.id }}
                className={`block underline ${r.overdue ? 'text-red-800' : 'text-hub-teal-dark'}`}
              >
                {r.code}
                {r.overdue ? ' (overdue)' : ''}
              </Link>
            ))}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Audits() {
  const runs = useOne<{ data: Row[] }>('/api/v1/audit-runs');
  const templates = useOne<{ data: Row[] }>('/api/v1/audit-templates');
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [step, setStep] = useState<Step | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const fv = (k: string) => form[k] ?? '';
  const setFv = (k: string) => (x: string) => setForm((p) => ({ ...p, [k]: x }));
  const tpls = templates.data?.data ?? [];

  function templateActions(t: Row) {
    const out = [
      <button
        key="view"
        className={smallButton}
        aria-label={`View controls: ${t.code} ${t.title}`}
        onClick={() => setStep({ kind: 'view', t })}
      >
        View controls
      </button>,
    ];
    const d = draft(t);
    if (d && can('compliance.audit.run')) {
      out.push(
        d.createdBy === me.user.id ? (
          <span key="pub" className="text-xs">
            You wrote this version, so someone else must publish it.
          </span>
        ) : (
          <button
            key="pub"
            className={smallButton}
            aria-label={`Publish v${d.version}: ${t.code} ${t.title}`}
            onClick={() => setStep({ kind: 'publish', t })}
          >
            Publish v{d.version}
          </button>
        ),
      );
    }
    const p = published(t);
    if (!t.active && p && can('compliance.requirement.manage')) {
      out.push(
        p.createdBy === me.user.id ? (
          <span key="act" className="text-xs">
            You wrote the published version, so someone else must activate it.
          </span>
        ) : (
          <button
            key="act"
            className={smallButton}
            aria-label={`Activate: ${t.code} ${t.title}`}
            onClick={() => setStep({ kind: 'activate', t })}
          >
            Activate
          </button>
        ),
      );
    }
    if (can('compliance.audit.run') && !t.retiredAt)
      out.push(
        <button
          key="clone"
          className={smallButton}
          aria-label={`Copy as a new draft: ${t.code} ${t.title}`}
          onClick={() => {
            setForm({});
            setStep({ kind: 'clone', t });
          }}
        >
          Copy
        </button>,
      );
    if (can('compliance.requirement.manage') && !t.retiredAt)
      out.push(
        <button
          key="retire"
          className={smallButton}
          aria-label={`Retire: ${t.code} ${t.title}`}
          onClick={() => setStep({ kind: 'retire', t })}
        >
          Retire
        </button>,
      );
    return <div className="flex flex-wrap items-center gap-2">{out}</div>;
  }

  const t = step?.t;
  const shown = t ? (step?.kind === 'publish' ? draft(t) : (published(t) ?? t.versions[0])) : null;
  return (
    <>
      <DataTable<Row>
        caption="Audit schedule"
        rows={runs.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={runs.isLoading}
        error={runs.isError ? 'Could not load audits.' : null}
        emptyMessage="No audits scheduled."
        columns={[
          {
            key: 'c',
            header: 'Audit',
            cell: (r) => (
              <Link
                to="/compliance/audits/$id"
                params={{ id: r.id }}
                className="font-medium text-hub-teal-dark underline"
              >{`${r.code} ${r.title}`}</Link>
            ),
          },
          { key: 't', header: 'Template', cell: (r) => `${r.templateCode} (${words(r.domain)})` },
          {
            key: 'p',
            header: 'People',
            cell: (r) => (
              <>
                Auditor: {r.auditorName ?? 'Not a current member'}
                <span className="block">Owner: {r.ownerName ?? 'Not a current member'}</span>
              </>
            ),
          },
          {
            key: 'd',
            header: 'Due',
            cell: (r) =>
              r.overdue ? (
                <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(r.dueDate)}`} />
              ) : (
                fmtDate(r.dueDate)
              ),
          },
          { key: 's', header: 'Stage', cell: (r) => RUN_STAGE[r.status] ?? words(r.status) },
          {
            key: 'o',
            header: 'Outcome',
            cell: (r) =>
              r.outcome ? (
                <StatusBadge status={r.outcome as StatusKind} reason={r.outcomeReason} />
              ) : (
                'Not submitted'
              ),
          },
        ]}
      />
      <AuditCalendar runs={runs.data?.data ?? []} />
      {can('compliance.audit.run') && <ScheduleForm templates={tpls} />}
      <DataTable<Row>
        caption="Audit templates"
        rows={tpls}
        rowKey={(r) => r.id}
        loading={templates.isLoading}
        error={templates.isError ? 'Could not load templates.' : null}
        emptyMessage="No templates."
        columns={[
          {
            key: 'c',
            header: 'Template',
            cell: (r) => (
              <>
                {`${r.code} ${r.title}`}
                {r.validationNote && (
                  <span className="block text-xs text-amber-900">
                    {r.validationNote}
                    {r.proposedCadence ? ` Proposed cadence: ${r.proposedCadence}.` : ''}
                  </span>
                )}
              </>
            ),
          },
          { key: 'k', header: 'Key question', cell: (r) => words(r.domain) },
          {
            key: 'v',
            header: 'Versions',
            cell: (r) =>
              (r.versions as Row[])
                .map((v) => `v${v.version} ${words(v.status).toLowerCase()}`)
                .join(', '),
          },
          { key: 'a', header: 'State', cell: (r) => <TemplateState t={r} /> },
          { key: 'x', header: 'Action', cell: (r) => templateActions(r) },
        ]}
      />
      <ActionDialog
        open={step !== null}
        title={t && step ? `${STEP_TITLE[step.kind]}: ${t.code} ${t.title}` : ''}
        confirmLabel={step?.kind === 'view' ? 'Close' : step ? STEP_TITLE[step.kind] : ''}
        reasonLabel={step?.kind === 'retire' ? 'Why is it being retired?' : undefined}
        confirmDisabled={
          (step?.kind === 'clone' && (!fv('code') || fv('title').trim().length < 2)) ||
          (step?.kind === 'publish' &&
            !!t &&
            needsSpecialist(t) &&
            (fv('specialistName').trim().length < 2 || fv('specialistRole').trim().length < 2))
        }
        onCancel={() => {
          setStep(null);
          setForm({});
        }}
        onConfirm={async (reason) => {
          if (!t || !step) return;
          if (step.kind === 'publish')
            await api.send(
              'POST',
              `/api/v1/audit-templates/${t.id}/versions/${draft(t)!.id}/publish`,
              orgId,
              needsSpecialist(t)
                ? {
                    specialistName: fv('specialistName').trim(),
                    specialistRole: fv('specialistRole').trim(),
                  }
                : {},
            );
          if (step.kind === 'activate')
            await api.send('POST', `/api/v1/audit-templates/${t.id}/activate`, orgId, {});
          if (step.kind === 'clone')
            await api.send('POST', `/api/v1/audit-templates/${t.id}/clone`, orgId, {
              code: fv('code').trim().toUpperCase(),
              title: fv('title').trim(),
            });
          if (step.kind === 'retire')
            await api.send('POST', `/api/v1/audit-templates/${t.id}/retire`, orgId, { reason });
        }}
        fields={
          step?.kind === 'clone' ? (
            <>
              <Field label="New template code">
                <input
                  className={input}
                  value={fv('code')}
                  maxLength={20}
                  onChange={(e) => setFv('code')(e.target.value)}
                />
              </Field>
              <Field label="New title">
                <input
                  className={input}
                  value={fv('title')}
                  maxLength={200}
                  onChange={(e) => setFv('title')(e.target.value)}
                />
              </Field>
            </>
          ) : step?.kind === 'publish' && t && needsSpecialist(t) ? (
            <>
              <p className="text-sm">
                Sector templates are draft content: a qualified specialist must validate them before
                they are published.
              </p>
              <Field label="Specialist who validated it">
                <input
                  className={input}
                  value={fv('specialistName')}
                  maxLength={120}
                  onChange={(e) => setFv('specialistName')(e.target.value)}
                />
              </Field>
              <Field label="Specialist role or qualification">
                <input
                  className={input}
                  value={fv('specialistRole')}
                  maxLength={120}
                  onChange={(e) => setFv('specialistRole')(e.target.value)}
                />
              </Field>
            </>
          ) : undefined
        }
      >
        {step?.kind === 'clone' && (
          <p>
            A copy of the controls is made as a new draft template. A second person must publish it
            before use.
          </p>
        )}
        {step?.kind === 'retire' && (
          <p>
            A retired template cannot be scheduled again. Past audits and their results are not
            changed.
          </p>
        )}
        {step?.kind === 'publish' && (
          <p>
            Publishing makes this version the one audits use and retires any earlier version. Your
            name is recorded as the second person who checked it.
          </p>
        )}
        {step?.kind === 'activate' && (
          <p>
            Activating is management approval: audits can then be scheduled from this template. Your
            name is recorded.
          </p>
        )}
        {shown && (
          <div className="space-y-2 text-sm">
            <p>
              Version {shown.version} – {words(shown.status)}. Written by{' '}
              {shown.createdByName ?? (shown.createdBy ? 'a former member' : 'the starter library')}
              {shown.approvedByName ? `; published by ${shown.approvedByName}` : ''}
              {shown.approvedByName && shown.approvedAt ? `, ${fmtDateTime(shown.approvedAt)}` : ''}
              .
            </p>
            <p>
              Methods: {(shown.methods as string[]).map((m) => words(m).toLowerCase()).join(', ')}
              {shown.sampleSize ? `. Sample size ${shown.sampleSize}` : ''}
              {shown.sampleMethod ? ` (${shown.sampleMethod})` : ''}
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              {(shown.controls as Row[]).map((c) => (
                <li key={c.code}>
                  <span className="font-medium">
                    {c.code}: {c.question}
                  </span>
                  {c.critical && ' (critical control)'}
                  {c.guidance && <span className="block text-slate-700">{c.guidance}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </ActionDialog>
    </>
  );
}
