import { DataTable, StatusBadge } from '@hub/ui';
import { londonDate } from '@hub/rules';
import { Alert, Button, Checkbox, Input, Select, Space, Typography } from 'antd';
import { useState, type FormEvent } from 'react';
import { Field, Section, fmtDateTime, useRun, words } from '../../components.js';
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
  const [stillAtRisk, setStillAtRisk] = useState(false);
  const [nhsFunded, setNhsFunded] = useState(false);
  const [consentToShare, setConsentToShare] = useState(false);
  const [complaintChannel, setComplaintChannel] = useState('PHONE');
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
      stillAtRisk,
      nhsFunded,
      ...(kind === 'COMPLAINT'
        ? {
            complaint: {
              receivedOn: text('receivedOn') || londonDate(new Date()),
              channel: complaintChannel,
              consentToShare,
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
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Typography.Title level={2} style={{ margin: 0 }}>
        Report an incident
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Tell us what happened. Do not write anyone&apos;s name: refer to people by job or booking
        reference (for example J-1234).
      </Typography.Paragraph>
      {receipt && (
        <Alert
          type="success"
          showIcon
          role="status"
          message={<Typography.Text strong>Your reference number is {receipt.code}.</Typography.Text>}
          description={
            <>
              <p>{receipt.message}</p>
              <p>Triage is due by {fmtDateTime(receipt.triageDueAt)}.</p>
            </>
          }
        />
      )}
      {msg}
      <form aria-label="Report an incident" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What are you reporting?">
            <Select
              value={kind}
              onChange={setKind}
              options={kinds.map((k) => ({
                value: k,
                label: REPORT_KIND_LABEL[k] ?? words(k),
              }))}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="When did it happen?">
            <Input name="occurredAt" type="datetime-local" />
          </Field>
          <Field label="Short title">
            <Input name="title" required minLength={3} maxLength={200} />
          </Field>
          <Field label="Where (place)">
            <Input name="place" maxLength={200} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="What happened">
              <Input.TextArea name="description" required minLength={10} maxLength={4000} rows={4} />
            </Field>
          </div>
          <Field label="Job or booking references (not names)">
            <Input name="peopleRefs" placeholder="J-1234, BK-5678" />
          </Field>
          <Field label="What was done straight away">
            <Input name="immediateActions" maxLength={2000} />
          </Field>
          {kind === 'COMPLAINT' && (
            <>
              <Field label="Date received">
                <Input name="receivedOn" type="date" />
              </Field>
              <Field label="How it was received">
                <Select
                  value={complaintChannel}
                  onChange={setComplaintChannel}
                  options={CHANNELS.map((c) => ({ value: c, label: words(c) }))}
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Consent">
                <Checkbox checked={consentToShare} onChange={(e) => setConsentToShare(e.target.checked)}>
                  The person agreed we can share details to investigate
                </Checkbox>
              </Field>
            </>
          )}
          <Field label="Risk">
            <Checkbox checked={stillAtRisk} onChange={(e) => setStillAtRisk(e.target.checked)}>
              <Typography.Text strong>
                Someone is still at risk now (alerts the registered manager and governance lead)
              </Typography.Text>
            </Checkbox>
          </Field>
          <Field label="Funding">
            <Checkbox checked={nhsFunded} onChange={(e) => setNhsFunded(e.target.checked)}>
              This was NHS-funded care
            </Checkbox>
          </Field>
          <div className="sm:col-span-2">
            <Button type="primary" htmlType="submit">
              Send report
            </Button>
          </div>
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
    </Space>
  );
}