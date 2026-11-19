import { DataTable } from '@hub/ui';
import { Alert, Button, DatePicker, Input, Select, Space, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
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
  const maxReceived = dayjs(today());
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {msg}
      <Section title="Themes">
        {themes.isError ? (
          <Alert type="error" showIcon role="alert" message="Themes could not be loaded." />
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
              <Typography.Text type="secondary">
                {t.from} to {t.to}: {t.totals.feedback} feedback items and {t.totals.complaints}{' '}
                complaints; {t.totals.untagged} have no theme yet. Counts show what people raised;
                they are not a measure of quality on their own.
              </Typography.Text>
            )}
          </>
        )}
      </Section>
      {manage && (
        <Section title="Record feedback">
          <form onSubmit={submit} aria-label="Record feedback">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Type">
                <Select
                  value={f.kind}
                  onChange={(kind) => setF({ ...f, kind })}
                  options={KINDS}
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Received on">
                <DatePicker
                  value={dayjs(f.receivedOn)}
                  onChange={(d) => d && setF({ ...f, receivedOn: d.format('YYYY-MM-DD') })}
                  disabledDate={(d) => d.isAfter(maxReceived, 'day')}
                  format="YYYY-MM-DD"
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Source (for example: post-journey survey, October)">
                <Input
                  required
                  minLength={2}
                  value={f.source}
                  onChange={(e) => setF({ ...f, source: e.target.value })}
                />
              </Field>
              <Field label="Rating 1 to 5 (optional)">
                <Select
                  allowClear
                  placeholder="No rating"
                  value={f.rating || undefined}
                  onChange={(rating) => setF({ ...f, rating: rating ?? '' })}
                  options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))}
                  style={{ width: '100%' }}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Summary (no names or patient details)">
                  <Input.TextArea
                    required
                    minLength={3}
                    value={f.summary}
                    onChange={(e) => setF({ ...f, summary: e.target.value })}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Themes, separated by commas (for example: punctuality, communication)">
                  <Input
                    value={f.themes}
                    onChange={(e) => setF({ ...f, themes: e.target.value })}
                  />
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Button type="primary" htmlType="submit">
                  Save feedback
                </Button>
              </div>
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
                  <Button
                    size="small"
                    onClick={() => {
                      setAct({ title: '', deadline: '', owner: me.user.id });
                      setAssigning(r);
                    }}
                  >
                    Assign action
                  </Button>
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
            <Field label="What needs to happen? (at least 3 characters)">
              <Input
                value={act.title}
                onChange={(e) => setAct({ ...act, title: e.target.value })}
              />
            </Field>
            <Field label="Deadline">
              <DatePicker
                value={act.deadline ? dayjs(act.deadline) : null}
                onChange={(d) => setAct({ ...act, deadline: d ? d.format('YYYY-MM-DD') : '' })}
                disabledDate={(d) => d.isBefore(dayjs(today()), 'day')}
                format="YYYY-MM-DD"
                style={{ width: '100%' }}
              />
            </Field>
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
    </Space>
  );
}