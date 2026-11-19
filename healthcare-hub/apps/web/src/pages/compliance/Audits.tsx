import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import {
  Button,
} from 'antd';
import { Link } from '@tanstack/react-router';
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
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { WfTag } from '../../v36/ui.js';

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

function CreateTemplateForm() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('SAFE');
  const [question, setQuestion] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/audit-templates', orgId, {
          code: code.trim().toUpperCase(),
          title: title.trim(),
          domain,
          version: {
            controls: [{ code: 'C1', question: question.trim(), critical: false }],
            methods: ['RECORDS'],
          },
        }),
      'Draft template created. A second person must publish it before it can be activated.',
    );
    if (ok) {
      setCode('');
      setTitle('');
      setQuestion('');
    }
  }
  return (
    <Section title="Create an audit template">
      <p className="text-sm">
        New templates start as a draft. Publish, activate and schedule them using the table below.
      </p>
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Template code">
          <input
            aria-label="Template code"
            value={code}
            maxLength={20}
            required
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <Field label="Title">
          <input
            aria-label="Title"
            value={title}
            minLength={2}
            maxLength={200}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Key question domain">
          <select
            aria-label="Key question domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            {['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED'].map((d) => (
              <option key={d} value={d}>
                {words(d)}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="First control question">
            <input
              aria-label="First control question"
              value={question}
              minLength={3}
              maxLength={500}
              required
              onChange={(e) => setQuestion(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex items-end">
          <Button
            type="primary"
            htmlType="submit"
            disabled={!code.trim() || !title.trim() || question.trim().length < 3}
          >
            Create draft
          </Button>
        </div>
      </form>
      {msg}
    </Section>
  );
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
            <select name="template" required>
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} {t.title} (v{published(t)?.version})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Audit title">
            <input name="title" required minLength={2} maxLength={200} />
          </Field>
          <Field label="Location (optional)">
            <select name="locationId">
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
            <input type="date" name="periodFrom" />
          </Field>
          <Field label="Period to (optional)">
            <input type="date" name="periodTo" />
          </Field>
          <Field label="Due date">
            <input type="date" name="dueDate" required />
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
            <select name="serviceId">
              <option value="">All services</option>
              {(services.data?.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Repeat (optional)">
            <select name="recurrenceMonths" defaultValue="">
              <option value="">Does not repeat</option>
              <option value="1">Every month</option>
              <option value="3">Every 3 months</option>
              <option value="6">Every 6 months</option>
              <option value="12">Every year</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button htmlType="submit" type="primary">Schedule audit</Button>
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
          <Button size="small" onClick={() => move(-1)}>
            Previous {mode}
          </Button>
          <Button size="small" onClick={() => move(1)}>
            Next {mode}
          </Button>
          <Button
            size="small"
            aria-pressed={mode === 'week'}
            onClick={() => setMode(mode === 'month' ? 'week' : 'month')}
          >
            {mode === 'month' ? 'Week view' : 'Month view'}
          </Button>
        </div>
      }
    >
      <ul aria-label="Audits by due date" className="grid gap-1 text-sm sm:grid-cols-7">
        {days.map((d) => (
          <li key={d} className="min-h-12 rounded border border-hub-line bg-hub-card p-1">
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

export function Audits({ part = 'audits' }: { part?: 'programme' | 'audits' | 'templates' }) {
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
      <Button
        size="small"
        key="view"
        aria-label={`View controls: ${t.code} ${t.title}`}
        onClick={() => setStep({ kind: 'view', t })}
      >
        View controls
      </Button>,
    ];
    const d = draft(t);
    if (d && can('compliance.audit.run')) {
      out.push(
        d.createdBy === me.user.id ? (
          <span key="pub" className="text-xs">
            You wrote this version, so someone else must publish it.
          </span>
        ) : (
          <Button
            size="small"
            key="pub"
            aria-label={`Publish v${d.version}: ${t.code} ${t.title}`}
            onClick={() => setStep({ kind: 'publish', t })}
          >
            Publish v{d.version}
          </Button>
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
          <Button
            size="small"
            key="act"
            aria-label={`Activate: ${t.code} ${t.title}`}
            onClick={() => setStep({ kind: 'activate', t })}
          >
            Activate
          </Button>
        ),
      );
    }
    if (can('compliance.audit.run') && !t.retiredAt)
      out.push(
        <Button
          size="small"
          key="clone"
          aria-label={`Copy as a new draft: ${t.code} ${t.title}`}
          onClick={() => {
            setForm({});
            setStep({ kind: 'clone', t });
          }}
        >
          Copy
        </Button>,
      );
    if (can('compliance.requirement.manage') && !t.retiredAt)
      out.push(
        <Button
          size="small"
          key="retire"
          aria-label={`Retire: ${t.code} ${t.title}`}
          onClick={() => setStep({ kind: 'retire', t })}
        >
          Retire
        </Button>,
      );
    return <div className="flex flex-wrap items-center gap-2">{out}</div>;
  }

  const t = step?.t;
  const shown = t ? (step?.kind === 'publish' ? draft(t) : (published(t) ?? t.versions[0])) : null;
  return (
    <>
      {part === 'audits' && (
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
                <>
                  <Link to="/compliance/audits/$id" params={{ id: r.id }} className="font-medium">
                    {`${r.code} ${r.title}`}
                  </Link>
                  <span className="block wf-mut text-xs">
                    {r.templateCode} · {words(r.domain)}
                  </span>
                </>
              ),
            },
            { key: 'au', header: 'Auditor', cell: (r) => r.auditorName ?? 'Not a current member' },
            { key: 'ow', header: 'Area owner', cell: (r) => r.ownerName ?? 'Not a current member' },
            {
              key: 'd',
              header: 'Due',
              cell: (r) => {
                const days = Math.round(
                  (new Date(`${String(r.dueDate).slice(0, 10)}T00:00:00Z`).getTime() -
                    new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()) /
                    86_400_000,
                );
                const done = r.status === 'CLOSED' || r.status === 'SUBMITTED';
                return done ? (
                  fmtDate(r.dueDate)
                ) : r.overdue ? (
                  <WfTag tone="red" icon="error">
                    Overdue – was due {fmtDate(r.dueDate)}
                  </WfTag>
                ) : days <= 14 ? (
                  <WfTag tone="amber" icon="schedule">
                    Due in {days} day{days === 1 ? '' : 's'}
                  </WfTag>
                ) : (
                  <WfTag tone="grey" icon="event">
                    Due {fmtDate(r.dueDate)}
                  </WfTag>
                );
              },
            },
            {
              key: 's',
              header: 'Stage',
              cell: (r) => (
                <WfTag
                  tone={r.status === 'CLOSED' ? 'green' : 'grey'}
                  icon="radio_button_unchecked"
                >
                  {RUN_STAGE[r.status] ?? words(r.status)}
                </WfTag>
              ),
            },
            {
              key: 'o',
              header: 'Result',
              cell: (r) =>
                r.outcome ? (
                  <StatusBadge status={r.outcome as StatusKind} reason={r.outcomeReason} />
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
      {part === 'programme' && <AuditCalendar runs={runs.data?.data ?? []} />}
      {part === 'audits' && can('compliance.audit.run') && <ScheduleForm templates={tpls} />}
      {part === 'templates' && can('compliance.audit.run') && <CreateTemplateForm />}
      {part === 'templates' && (
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
      )}
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
                  value={fv('code')}
                  maxLength={20}
                  onChange={(e) => setFv('code')(e.target.value)}
                />
              </Field>
              <Field label="New title">
                <input
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
                  value={fv('specialistName')}
                  maxLength={120}
                  onChange={(e) => setFv('specialistName')(e.target.value)}
                />
              </Field>
              <Field label="Specialist role or qualification">
                <input
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
