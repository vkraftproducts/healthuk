import { DataTable } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  button,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KINDS = [
  { value: 'COMPLIMENT', label: 'Compliment' },
  { value: 'STAFF_FEEDBACK', label: 'Staff feedback' },
  { value: 'PATIENT_SURVEY', label: 'Patient survey' },
];
const kindLabel = (k: string) => KINDS.find((x) => x.value === k)?.label ?? words(k);
const today = () => new Date().toISOString().slice(0, 10);

/** EVT-04: compliments, staff feedback and patient surveys, with themes and actions. */
export function Feedback() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const list = useOne<{ data: Row[] }>('/api/v1/feedback');
  const themes = useOne<Row>('/api/v1/feedback/themes');
  const people = usePeople();
  const [assigning, setAssigning] = useState<Row | null>(null);
  const [act, setAct] = useState({ title: '', deadline: '', owner: '' });
  const [f, setF] = useState({
    kind: 'COMPLIMENT',
    receivedOn: today(),
    source: '',
    summary: '',
    rating: '',
    themes: '',
  });
  const manage = can('events.event.manage');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      kind: f.kind,
      receivedOn: f.receivedOn,
      source: f.source,
      summary: f.summary,
      themes: f.themes
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
    if (f.rating) payload.rating = Number(f.rating);
    void run(async () => {
      await api.send('POST', '/api/v1/feedback', orgId, payload);
      setF({ ...f, source: '', summary: '', rating: '', themes: '' });
    }, 'Feedback recorded.');
  };
  const t = themes.data;
  return (
    <div className="space-y-6">
      {msg}
      <Section title="Themes">
        {themes.isError ? (
          <p role="alert">Themes could not be loaded.</p>
        ) : (
          <>
            <DataTable<Row>
              caption="Themes across feedback and complaints"
              rows={t?.themes ?? []}
              rowKey={(r) => r.theme}
              loading={themes.isLoading}
              error={null}
              emptyMessage="No themes in this period."
              columns={[
                { key: 'th', header: 'Theme', cell: (r) => r.theme },
                { key: 'c', header: 'Compliments', cell: (r) => r.compliments },
                { key: 's', header: 'Staff feedback', cell: (r) => r.staffFeedback },
                { key: 'p', header: 'Patient surveys', cell: (r) => r.patientSurveys },
                { key: 'co', header: 'Complaints', cell: (r) => r.complaints },
                { key: 'tt', header: 'Total', cell: (r) => r.total },
                { key: 'a', header: 'Average rating', cell: (r) => r.averageRating ?? '—' },
              ]}
            />
            {t && (
              <p className="text-sm text-slate-700">
                {t.from} to {t.to}: {t.totals.feedback} feedback items and {t.totals.complaints}{' '}
                complaints; {t.totals.untagged} have no theme yet. Counts show what people raised;
                they are not a measure of quality on their own.
              </p>
            )}
          </>
        )}
      </Section>
      {manage && (
        <Section title="Record feedback">
          <form
            onSubmit={submit}
            aria-label="Record feedback"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="Type">
              <select
                className={input}
                value={f.kind}
                onChange={(e) => setF({ ...f, kind: e.target.value })}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Received on">
              <input
                type="date"
                required
                max={today()}
                className={input}
                value={f.receivedOn}
                onChange={(e) => setF({ ...f, receivedOn: e.target.value })}
              />
            </Field>
            <Field label="Source (for example: post-journey survey, October)">
              <input
                required
                minLength={2}
                className={input}
                value={f.source}
                onChange={(e) => setF({ ...f, source: e.target.value })}
              />
            </Field>
            <Field label="Rating 1 to 5 (optional)">
              <select
                className={input}
                value={f.rating}
                onChange={(e) => setF({ ...f, rating: e.target.value })}
              >
                <option value="">No rating</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Summary (no names or patient details)">
                <textarea
                  required
                  minLength={3}
                  className={input}
                  value={f.summary}
                  onChange={(e) => setF({ ...f, summary: e.target.value })}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="Themes, separated by commas (for example: punctuality, communication)">
                <input
                  className={input}
                  value={f.themes}
                  onChange={(e) => setF({ ...f, themes: e.target.value })}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <button className={button} type="submit">
                Save feedback
              </button>
            </div>
          </form>
        </Section>
      )}
      <Section title="Feedback">
        <DataTable<Row>
          caption="Feedback"
          rows={list.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.isError ? 'Could not load feedback.' : null}
          emptyMessage="No feedback recorded yet."
          columns={[
            { key: 'd', header: 'Received', cell: (r) => r.receivedOn },
            { key: 'k', header: 'Type', cell: (r) => kindLabel(r.kind) },
            { key: 's', header: 'Source', cell: (r) => r.source },
            { key: 'su', header: 'Summary', cell: (r) => r.summary },
            { key: 'r', header: 'Rating', cell: (r) => r.rating ?? '—' },
            { key: 'th', header: 'Themes', cell: (r) => r.themes.join(', ') || '—' },
            { key: 'oa', header: 'Open actions', cell: (r) => r.openActions },
            {
              key: 'x',
              header: 'Action',
              cell: (r) =>
                manage ? (
                  <button
                    className={smallButton}
                    onClick={() => {
                      setAct({ title: '', deadline: '', owner: me.user.id });
                      setAssigning(r);
                    }}
                  >
                    Assign action
                  </button>
                ) : null,
            },
          ]}
        />
      </Section>
      <ActionDialog
        open={assigning !== null}
        title="Assign an action from this feedback"
        confirmLabel="Assign action"
        confirmDisabled={act.title.trim().length < 3 || !act.deadline || !act.owner}
        onCancel={() => setAssigning(null)}
        fields={
          <>
            <label className="flex flex-col text-sm">
              What needs to happen? (at least 3 characters)
              <input
                className={input}
                value={act.title}
                onChange={(e) => setAct({ ...act, title: e.target.value })}
              />
            </label>
            <label className="flex flex-col text-sm">
              Deadline
              <input
                type="date"
                className={input}
                min={today()}
                value={act.deadline}
                onChange={(e) => setAct({ ...act, deadline: e.target.value })}
              />
            </label>
            <PersonSelect
              label="Owner"
              value={act.owner}
              onChange={(owner) => setAct({ ...act, owner })}
              people={people}
              meId={me.user.id}
            />
          </>
        }
        onConfirm={() =>
          api.send('POST', `/api/v1/feedback/${assigning!.id}/actions`, orgId, {
            title: act.title.trim(),
            deadline: act.deadline,
            ownerUserId: act.owner,
          })
        }
      >
        <p>The owner sees the action in their list and on the dashboard until it is closed.</p>
      </ActionDialog>
    </div>
  );
}
