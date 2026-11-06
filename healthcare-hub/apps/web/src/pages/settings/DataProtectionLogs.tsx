import { DataTable } from '@hub/ui';
import { londonDate } from '@hub/rules';
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
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from './hooks.js';

const METHOD: Record<string, string> = {
  SECURE_EMAIL: 'Secure email',
  SECURE_PORTAL: 'Secure portal',
  POST: 'Post',
  BY_HAND: 'By hand',
  PHONE: 'Phone',
  OTHER: 'Other',
};

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CATEGORIES = [
  'PATIENT_CONTACT',
  'JOB_RECORDS',
  'STAFF_HR_RECORDS',
  'DBS_RECORDS',
  'EVENT_RECORDS',
  'COMPLAINTS',
  'SAFEGUARDING',
  'AUDIT_RECORDS',
  'AUDIT_LOG',
];
const RETENTION_ACTION: Record<string, string> = {
  REVIEW: 'Listed for review',
  ANONYMISE: 'Anonymised',
};
const BASES = [
  'Consent (UK GDPR Article 6(1)(a))',
  'Contract (Article 6(1)(b))',
  'Legal obligation (Article 6(1)(c))',
  'Vital interests (Article 6(1)(d))',
  'Public task (Article 6(1)(e))',
  'Legitimate interests (Article 6(1)(f))',
];

const query = (p: Record<string, string>) => {
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v)).toString();
  return q ? `?${q}` : '';
};

/** Who personal data was shared with, why and on what basis. Entries cannot be changed. */
export function DisclosureLog() {
  const { api, orgId, me } = useApp();
  const { run, msg } = useRun();
  const people = usePeople();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [approver, setApprover] = useState('');
  const badRange = !!from && !!to && from > to;
  const q = search.trim().length >= 2 ? search.trim() : '';
  const log = useOne<{ data: Row[] }>(
    badRange ? null : `/api/v1/disclosures${query({ from, to, q })}`,
  );
  const requests = useOne<{ data: Row[] }>('/api/v1/subject-requests');
  const today = londonDate(new Date());
  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const requestId = String(f.get('subjectRequestId') ?? '');
    const opt = (k: string) => String(f.get(k) ?? '').trim();
    if (
      await run(
        () =>
          api.send('POST', '/api/v1/disclosures', orgId, {
            disclosedTo: String(f.get('disclosedTo')),
            purpose: String(f.get('purpose')),
            lawfulBasis: String(f.get('lawfulBasis')),
            dataDescription: String(f.get('dataDescription')),
            disclosedOn: String(f.get('disclosedOn')),
            ...(requestId ? { subjectRequestId: requestId } : {}),
            ...(opt('subjectDescription') ? { subjectDescription: opt('subjectDescription') } : {}),
            ...(opt('requestedBy') ? { requestedBy: opt('requestedBy') } : {}),
            ...(opt('method') ? { method: opt('method') } : {}),
            ...(approver ? { approvedBy: approver } : {}),
          }),
        'Disclosure recorded. It cannot be edited or deleted.',
      )
    )
      form.reset();
  }
  return (
    <Section title="Disclosure log">
      <p className="text-sm">
        Record each time personal data is shared outside the organisation: who received it, why, the
        lawful basis and what was shared. Entries are permanent; record a correction as a new entry.
      </p>
      <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filter disclosures">
        <Field label="Shared from">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="Shared until">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} />
        </Field>
        <Field label="Search (who, why, whose data)">
          <input
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            className={input}
          />
        </Field>
      </div>
      {badRange && (
        <p role="alert" className="text-red-900">
          The start date must be on or before the end date.
        </p>
      )}
      <DataTable<Row>
        caption="Disclosures"
        rows={log.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={log.isLoading}
        error={log.isError ? 'Could not load the disclosure log.' : null}
        emptyMessage="No disclosures recorded for these dates."
        columns={[
          { key: 'd', header: 'Date', cell: (r) => fmtDate(r.disclosedOn) },
          { key: 't', header: 'Shared with', cell: (r) => r.disclosedTo },
          { key: 'p', header: 'Purpose', cell: (r) => r.purpose },
          { key: 'b', header: 'Lawful basis', cell: (r) => r.lawfulBasis },
          {
            key: 'w',
            header: 'What was shared',
            cell: (r) => (
              <>
                {r.dataDescription}
                {r.subjectDescription && (
                  <span className="block text-xs">About: {r.subjectDescription}</span>
                )}
              </>
            ),
          },
          {
            key: 'h',
            header: 'Asked, approved, sent',
            cell: (r) =>
              [
                r.requestedBy ? `Asked by ${r.requestedBy}` : null,
                r.approvedByName ? `Approved by ${r.approvedByName}` : 'No approver recorded',
                r.method ? `Sent by ${METHOD[r.method] ?? words(r.method)}` : null,
              ]
                .filter(Boolean)
                .join('; '),
          },
          {
            key: 's',
            header: 'Subject request',
            cell: (r) => r.subjectRequestCode ?? 'Not linked',
          },
          {
            key: 'r',
            header: 'Recorded',
            cell: (r) => `${r.recordedByName ?? 'Unknown'}, ${fmtDateTime(r.recordedAt)}`,
          },
        ]}
      />
      {msg}
      <form
        onSubmit={record}
        aria-label="Record a disclosure"
        className="grid gap-3 rounded border border-hub-line p-3 md:grid-cols-2"
      >
        <Field label="Shared with (organisation or role)">
          <input name="disclosedTo" required minLength={2} maxLength={200} className={input} />
        </Field>
        <Field label="Date shared">
          <input
            name="disclosedOn"
            type="date"
            required
            max={today}
            defaultValue={today}
            className={input}
          />
        </Field>
        <Field label="Purpose">
          <input name="purpose" required minLength={3} maxLength={500} className={input} />
        </Field>
        <Field label="Lawful basis">
          <input
            name="lawfulBasis"
            required
            minLength={3}
            maxLength={300}
            list="lawful-bases"
            className={input}
          />
        </Field>
        <datalist id="lawful-bases">
          {BASES.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        <Field label="What was shared (describe the data, not the person)">
          <textarea
            name="dataDescription"
            required
            minLength={3}
            maxLength={1000}
            className={input}
          />
        </Field>
        <Field label="Linked subject request (optional)">
          <select name="subjectRequestId" className={input}>
            <option value="">None</option>
            {(requests.data?.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.code} – {words(r.type)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Whose data (describe them, no names) (optional)">
          <input name="subjectDescription" minLength={2} maxLength={200} className={input} />
        </Field>
        <Field label="Who asked for it (optional)">
          <input name="requestedBy" minLength={2} maxLength={200} className={input} />
        </Field>
        <Field label="How it was sent (optional)">
          <select name="method" className={input} defaultValue="">
            <option value="">Not recorded</option>
            {Object.entries(METHOD).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Approved by (someone other than you) (optional)">
          <select className={input} value={approver} onChange={(e) => setApprover(e.target.value)}>
            <option value="">Not recorded</option>
            {people
              .filter((p) => p.id !== me.user.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </Field>
        <div>
          <button className={button}>Record disclosure</button>
        </div>
      </form>
    </Section>
  );
}

/** K4: each month, review what an approved rule has made due: keep with a reason, or act. */
export function RetentionReviews() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const rules = useOne<{ data: Row[] }>('/api/v1/retention-rules');
  const reviews = useOne<{ data: Row[] }>('/api/v1/retention-reviews');
  const [deciding, setDeciding] = useState<{ r: Row; decision: 'KEEP' | 'ACT' } | null>(null);
  const [keepUntil, setKeepUntil] = useState('');
  const [closing, setClosing] = useState<Row | null>(null);
  const approved = (rules.data?.data ?? []).filter((r) => r.status === 'APPROVED');
  const label = (r: Row) => `${words(r.category)} review for ${r.period}`;
  return (
    <Section title="Monthly retention reviews">
      <p className="text-sm">
        Open a review for an approved rule to see how many records are past their retention period.
        Keep them with a reason and a date to look again, or confirm the rule can act. Decisions
        cannot be changed.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Open a review">
        {approved.length === 0 && <p className="text-sm">No approved retention rules yet.</p>}
        {approved.map((r) => (
          <button
            key={r.id}
            className={smallButton}
            aria-label={`Open this month's review: ${words(r.category)}`}
            onClick={() =>
              void run(
                () => api.send('POST', '/api/v1/retention-reviews', orgId, { ruleId: r.id }),
                'Review opened.',
              )
            }
          >
            Review {words(r.category)}
          </button>
        ))}
      </div>
      {msg}
      <DataTable<Row>
        caption="Retention reviews"
        rows={reviews.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={reviews.isLoading}
        error={reviews.isError ? 'Could not load retention reviews.' : null}
        emptyMessage="No reviews yet."
        columns={[
          { key: 'n', header: 'Review', cell: label },
          { key: 'k', header: 'Older than', cell: (r) => fmtDate(r.cutoff) },
          {
            key: 'c',
            header: 'Records',
            cell: (r) => `${r.candidates} due, ${r.held} held by a legal hold`,
          },
          {
            key: 'd',
            header: 'Decisions',
            cell: (r) =>
              (r.decisions as Row[]).length === 0
                ? 'None yet'
                : (r.decisions as Row[])
                    .map((x) =>
                      x.decision === 'KEEP'
                        ? `Keep until ${fmtDate(x.keepUntil)}: ${x.reason} (${x.decidedByName ?? 'unknown'})`
                        : `Act (${x.decidedByName ?? 'unknown'})`,
                    )
                    .join('; '),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) =>
              r.status === 'CLOSED' ? (
                `Closed ${fmtDateTime(r.closedAt)} by ${r.closedByName ?? 'unknown'}`
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(r.decisions as Row[]).length === 0 && (
                    <>
                      <button
                        className={smallButton}
                        aria-label={`Keep records: ${label(r)}`}
                        onClick={() => {
                          setKeepUntil('');
                          setDeciding({ r, decision: 'KEEP' });
                        }}
                      >
                        Keep
                      </button>
                      <button
                        className={smallButton}
                        aria-label={`Let the rule act: ${label(r)}`}
                        onClick={() => setDeciding({ r, decision: 'ACT' })}
                      >
                        Act
                      </button>
                    </>
                  )}
                  <button
                    className={smallButton}
                    aria-label={`Close review: ${label(r)}`}
                    onClick={() => setClosing(r)}
                  >
                    Close
                  </button>
                </div>
              ),
          },
        ]}
      />
      <ActionDialog
        open={!!deciding}
        title={`${deciding?.decision === 'KEEP' ? 'Keep records' : 'Let the rule act'}: ${
          deciding ? label(deciding.r) : ''
        }`}
        confirmLabel={deciding?.decision === 'KEEP' ? 'Keep records' : 'Confirm'}
        reasonLabel={deciding?.decision === 'KEEP' ? 'Why are they kept?' : undefined}
        confirmDisabled={deciding?.decision === 'KEEP' && !keepUntil}
        onCancel={() => setDeciding(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/retention-reviews/${deciding!.r.id}/decisions`, orgId, {
            recordType: 'BATCH',
            recordId: deciding!.r.id,
            decision: deciding!.decision,
            ...(deciding!.decision === 'KEEP' ? { reason, keepUntil } : {}),
          })
        }
        fields={
          deciding?.decision === 'KEEP' && (
            <Field label="Look again on">
              <input
                type="date"
                className={input}
                min={londonDate(new Date())}
                value={keepUntil}
                onChange={(e) => setKeepUntil(e.target.value)}
              />
            </Field>
          )
        }
      >
        <p>
          {deciding?.decision === 'KEEP'
            ? 'The records stay. Your reason and name are recorded and cannot be changed.'
            : 'The approved rule may act on these records on its next run. Held records are never touched.'}
        </p>
      </ActionDialog>
      <ActionDialog
        open={!!closing}
        title={`Close review: ${closing ? label(closing) : ''}`}
        confirmLabel="Close review"
        onCancel={() => setClosing(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/retention-reviews/${closing!.id}/close`, orgId, {})
        }
      >
        <p>Closing records that this month&apos;s review is finished.</p>
      </ActionDialog>
    </Section>
  );
}

/** What the retention schedule has done on each run (read-only, immutable). */
export function RetentionLog() {
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const badRange = !!from && !!to && from > to;
  const log = useOne<{ data: Row[] }>(
    badRange ? null : `/api/v1/retention-log${query({ category, from, to })}`,
  );
  return (
    <Section title="Retention log">
      <p className="text-sm">
        Each line is one run of an approved retention rule. Records held back by a legal hold are
        counted separately and were not touched.
      </p>
      <div
        className="flex flex-wrap items-end gap-3"
        role="group"
        aria-label="Filter the retention log"
      >
        <Field label="Records">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
            <option value="">All records</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {words(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Run from">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={input}
          />
        </Field>
        <Field label="Run to">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={input} />
        </Field>
      </div>
      {badRange && (
        <p role="alert" className="text-red-900">
          The start date must be on or before the end date.
        </p>
      )}
      <DataTable<Row>
        caption="Retention runs"
        rows={log.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={log.isLoading}
        error={log.isError ? 'Could not load the retention log.' : null}
        emptyMessage="Retention has not acted on any records for these filters."
        columns={[
          { key: 'w', header: 'Run', cell: (r) => fmtDateTime(r.runAt) },
          { key: 'c', header: 'Records', cell: (r) => words(r.category) },
          {
            key: 'a',
            header: 'What happened',
            cell: (r) => RETENTION_ACTION[r.action] ?? words(r.action),
          },
          { key: 'k', header: 'Older than', cell: (r) => fmtDate(r.cutoff) },
          { key: 'f', header: 'Found', cell: (r) => String(r.candidates) },
          { key: 'd', header: 'Acted on', cell: (r) => String(r.affected) },
          { key: 'h', header: 'Held by a legal hold', cell: (r) => String(r.held) },
        ]}
      />
    </Section>
  );
}
