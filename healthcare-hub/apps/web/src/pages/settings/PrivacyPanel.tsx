import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import type { FormEvent } from 'react';
import { button, Field, input, Section, smallButton, useRun, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const CLOCK: Record<string, [StatusKind, string]> = {
  OPEN: ['AMBER', 'ICO decision due'],
  DUE_SOON: ['RED', 'ICO deadline within 24 hours'],
  OVERDUE: ['RED', 'ICO deadline passed'],
  REPORTED: ['GREEN', 'Reported to the ICO'],
  NOT_REPORTABLE: ['GREY', 'Not reportable (decision recorded)'],
};

/** Data protection (SECURITY_COMPLIANCE §4): retention, holds, subject requests, breaches. */
export function PrivacyPanel() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const rules = useOne<{ data: Row[] }>('/api/v1/retention-rules');
  const holds = useOne<{ data: Row[] }>('/api/v1/legal-holds');
  const dsrs = useOne<{ data: Row[] }>('/api/v1/subject-requests');
  const breaches = useOne<{ data: Row[] }>('/api/v1/breaches');
  const post = (path: string, body: unknown, ok: string) =>
    void run(() => api.send('POST', path, orgId, body), ok);

  function newDsr(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const subjectType = String(f.get('subjectType'));
    post(
      '/api/v1/subject-requests',
      {
        type: String(f.get('type')),
        subjectType,
        ...(subjectType === 'PATIENT' ? { patientRef: String(f.get('ref')) } : {}),
        ...(subjectType === 'STAFF' ? { staffId: String(f.get('ref')) } : {}),
        description: String(f.get('description')),
        receivedOn: String(f.get('receivedOn')),
      },
      'Request logged. The response is due within one calendar month.',
    );
  }
  function newBreach(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    post(
      '/api/v1/breaches',
      {
        title: String(f.get('title')),
        description: String(f.get('description')),
        discoveredAt: new Date(String(f.get('discoveredAt'))).toISOString(),
      },
      'Breach recorded. The 72-hour ICO clock is running from discovery.',
    );
  }
  return (
    <div className="space-y-6">
      {msg}
      <Section title="Retention schedule">
        <p className="text-sm">
          Nothing is acted on until a rule is approved. Only patient contact details can be
          anonymised automatically; everything else is listed for review. Legal holds always win.
        </p>
        <DataTable<Row>
          caption="Retention rules"
          rows={rules.data?.data ?? []}
          rowKey={(r) => r.id}
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
                <StatusBadge
                  status={r.status === 'APPROVED' ? 'GREEN' : 'AMBER'}
                  reason={r.status === 'APPROVED' ? 'Approved' : 'Requires approval'}
                />
              ),
            },
            { key: 'b', header: 'Basis', cell: (r) => r.basis },
            {
              key: 'x',
              header: 'Action',
              cell: (r) =>
                r.status !== 'APPROVED' && !r.basis.startsWith('Placeholder') ? (
                  <button
                    className={smallButton}
                    onClick={() =>
                      post(`/api/v1/retention-rules/${r.id}/approve`, {}, 'Rule approved.')
                    }
                  >
                    Approve
                  </button>
                ) : null,
            },
          ]}
        />
      </Section>
      <Section title="Legal holds">
        <DataTable<Row>
          caption="Legal holds"
          rows={holds.data?.data ?? []}
          rowKey={(h) => h.id}
          emptyMessage="No legal holds."
          columns={[
            { key: 's', header: 'Scope', cell: (h) => words(h.scopeType) },
            { key: 'r', header: 'Reason', cell: (h) => h.reason },
            { key: 'p', header: 'Placed', cell: (h) => h.placedAt.slice(0, 10) },
            {
              key: 'x',
              header: 'State',
              cell: (h) => (h.releasedAt ? `Released ${h.releasedAt.slice(0, 10)}` : 'Active'),
            },
          ]}
        />
      </Section>
      <Section title="Data subject requests">
        <form onSubmit={newDsr} className="flex flex-wrap items-end gap-3">
          <Field label="Request type">
            <select name="type" className={input}>
              {['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION'].map((t) => (
                <option key={t} value={t}>
                  {words(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="About">
            <select name="subjectType" className={input}>
              <option value="STAFF">A staff member</option>
              <option value="PATIENT">A patient</option>
              <option value="OTHER">Someone else</option>
            </select>
          </Field>
          <Field label="Staff id or patient reference">
            <input name="ref" className={input} />
          </Field>
          <Field label="What is asked for">
            <input name="description" required className={input} />
          </Field>
          <Field label="Received on">
            <input
              type="date"
              name="receivedOn"
              required
              defaultValue={londonToday()}
              className={input}
            />
          </Field>
          <button className={button}>Log request</button>
        </form>
        <DataTable<Row>
          caption="Subject requests"
          rows={dsrs.data?.data ?? []}
          rowKey={(r) => r.id}
          emptyMessage="No requests."
          columns={[
            { key: 'c', header: 'Request', cell: (r) => `${r.code} ${words(r.type)}` },
            { key: 'd', header: 'Due', cell: (r) => r.extendedTo ?? r.dueOn },
            {
              key: 's',
              header: 'Status',
              cell: (r) => (
                <StatusBadge
                  status={
                    r.overdue
                      ? 'RED'
                      : r.status === 'COMPLETED' || r.status === 'REFUSED'
                        ? 'GREEN'
                        : 'AMBER'
                  }
                  reason={r.overdue ? `Overdue – ${words(r.status)}` : words(r.status)}
                />
              ),
            },
          ]}
        />
      </Section>
      <Section title="Personal data breaches">
        <form onSubmit={newBreach} className="flex flex-wrap items-end gap-3">
          <Field label="Title">
            <input name="title" required className={input} />
          </Field>
          <Field label="What happened">
            <input name="description" required className={input} />
          </Field>
          <Field label="Discovered at">
            <input type="datetime-local" name="discoveredAt" required className={input} />
          </Field>
          <button className={button}>Record breach</button>
        </form>
        <DataTable<Row>
          caption="Breach records"
          rows={breaches.data?.data ?? []}
          rowKey={(b) => b.id}
          emptyMessage="No breaches recorded."
          columns={[
            { key: 'c', header: 'Breach', cell: (b) => `${b.code} ${b.title}` },
            {
              key: 'd',
              header: 'ICO deadline',
              cell: (b) =>
                new Date(b.icoDeadline).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
            },
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
            { key: 's', header: 'Status', cell: (b) => words(b.status) },
          ]}
        />
      </Section>
    </div>
  );
}
