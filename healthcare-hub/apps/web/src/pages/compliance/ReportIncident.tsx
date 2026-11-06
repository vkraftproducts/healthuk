import { DataTable, StatusBadge } from '@hub/ui';
import { londonDate } from '@hub/rules';
import { useState, type FormEvent } from 'react';
import { Field, Section, button, fmtDateTime, input, useRun, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useList } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const REPORT_KIND_LABEL: Record<string, string> = {
  INCIDENT: 'Incident',
  NEAR_MISS: 'Near miss',
  ACCIDENT: 'Accident or injury',
  SAFEGUARDING: 'Safeguarding concern',
  HARASSMENT: 'Harassment or sexual harassment',
  COMPLAINT: 'Complaint',
  IRMER: 'Radiation (IR(ME)R) incident',
  DOLS: 'Deprivation of liberty (DoLS) concern',
};
const CHANNELS = ['PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'WEB', 'OTHER'];

/**
 * Anyone can report (WORKFLOWS H1). People are named only by job or booking reference, never by
 * name; the receipt gives the reference number to quote.
 */
export function ReportIncident() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const types = useList('/api/v1/incidents/types');
  const mine = useList('/api/v1/incidents/mine');
  const [kind, setKind] = useState('INCIDENT');
  const [receipt, setReceipt] = useState<Row | null>(null);
  const kinds = (types.data as string[] | undefined) ?? ['INCIDENT', 'NEAR_MISS'];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const refs = text('peopleRefs')
      .split(/[\s,]+/)
      .filter(Boolean);
    const occurred = text('occurredAt');
    const body = {
      kind,
      title: text('title'),
      description: text('description'),
      occurredAt: occurred ? new Date(occurred).toISOString() : new Date().toISOString(),
      ...(text('place') ? { place: text('place') } : {}),
      peopleRefs: refs,
      ...(text('immediateActions') ? { immediateActions: text('immediateActions') } : {}),
      stillAtRisk: f.get('stillAtRisk') === 'on',
      nhsFunded: f.get('nhsFunded') === 'on',
      ...(kind === 'COMPLAINT'
        ? {
            complaint: {
              receivedOn: text('receivedOn') || londonDate(new Date()),
              channel: text('channel') || 'PHONE',
              consentToShare: f.get('consentToShare') === 'on',
            },
          }
        : {}),
    };
    await run(async () => {
      const r = (await api.send('POST', '/api/v1/incidents/report', orgId, body)) as Row;
      setReceipt(r);
      form.reset();
    }, 'Report sent.');
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Report an incident</h1>
      <p className="text-sm">
        Tell us what happened. Do not write anyone&apos;s name: refer to people by job or booking
        reference (for example J-1234).
      </p>
      {receipt && (
        <div role="status" className="rounded border border-green-700 bg-green-50 p-3 text-sm">
          <p className="font-semibold">Your reference number is {receipt.code}.</p>
          <p>{receipt.message}</p>
          <p>Triage is due by {fmtDateTime(receipt.triageDueAt)}.</p>
        </div>
      )}
      {msg}
      <form
        aria-label="Report an incident"
        className="grid gap-3 rounded-lg border border-hub-line bg-white p-4 sm:grid-cols-2"
        onSubmit={(e) => void submit(e)}
      >
        <Field label="What are you reporting?">
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {REPORT_KIND_LABEL[k] ?? words(k)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When did it happen?">
          <input name="occurredAt" type="datetime-local" className={input} />
        </Field>
        <Field label="Short title">
          <input name="title" required minLength={3} maxLength={200} className={input} />
        </Field>
        <Field label="Where (place)">
          <input name="place" maxLength={200} className={input} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="What happened">
            <textarea
              name="description"
              required
              minLength={10}
              maxLength={4000}
              rows={4}
              className={input}
            />
          </Field>
        </div>
        <Field label="Job or booking references (not names)">
          <input name="peopleRefs" placeholder="J-1234, BK-5678" className={input} />
        </Field>
        <Field label="What was done straight away">
          <input name="immediateActions" maxLength={2000} className={input} />
        </Field>
        {kind === 'COMPLAINT' && (
          <>
            <Field label="Date received">
              <input name="receivedOn" type="date" className={input} />
            </Field>
            <Field label="How it was received">
              <select name="channel" className={input} defaultValue="PHONE">
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {words(c)}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="consentToShare" /> The person agreed we can share details
              to investigate
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" name="stillAtRisk" /> Someone is still at risk now (alerts the
          registered manager and governance lead)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="nhsFunded" /> This was NHS-funded care
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className={button}>
            Send report
          </button>
        </div>
      </form>
      <Section title="Reports you have made">
        <DataTable
          caption="Reports you have made"
          rows={(mine.data as Row[] | undefined) ?? []}
          rowKey={(r: Row) => r.id}
          loading={mine.isLoading}
          emptyMessage="You have not reported anything yet."
          columns={[
            { key: 'code', header: 'Reference', cell: (r: Row) => r.code },
            { key: 'title', header: 'Title', cell: (r: Row) => r.title },
            { key: 'at', header: 'Reported', cell: (r: Row) => fmtDateTime(r.reportedAt) },
            {
              key: 'state',
              header: 'Progress',
              cell: (r: Row) => (
                <StatusBadge
                  status={r.triaged ? 'GREEN' : 'AMBER'}
                  reason={r.triaged ? `Triaged – ${words(r.status)}` : 'Waiting for triage'}
                />
              ),
            },
          ]}
        />
      </Section>
    </div>
  );
}
