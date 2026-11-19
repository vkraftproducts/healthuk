import { DataTable, StatusBadge } from '@hub/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button, Card, Checkbox, Input, Select, Space, Typography } from 'antd';
import { useState, type FormEvent } from 'react';
import {
  Field,
  PersonSelect,
  Section,
  fmtDateTime,
  useCan,
  useRun,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { CHANNEL, EVENT_STAGE, EVENT_TYPE, HARM } from './eventLabels.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Candour is flagged by the system and decided by a person; show which. */
export function CandourFlag({ e }: { e: Row }) {
  if (!e.candourFlag) return null;
  return e.candourDecided ? (
    <StatusBadge status="GREEN" reason="Duty of candour decided" />
  ) : (
    <StatusBadge status="AMBER" reason="Possible duty of candour – a person must decide" />
  );
}

function ReportEvent() {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const navigate = useNavigate();
  const { run, msg } = useRun();
  const [types, setTypes] = useState<string[]>(['INCIDENT']);
  const [lead, setLead] = useState(me.user.id);
  const [consentToShare, setConsentToShare] = useState(false);
  const [severity, setSeverity] = useState('NO_HARM');
  const [locationId, setLocationId] = useState('');
  const [complaintChannel, setComplaintChannel] = useState('PHONE');
  const has = (t: string) => types.includes(t);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const opt = (k: string) => (s(k) ? { [k]: s(k) } : {});
    let id = '';
    const ok = await run(async () => {
      const created = (await api.send('POST', '/api/v1/events', orgId, {
        types,
        title: s('title'),
        description: s('description'),
        occurredAt: new Date(s('occurredAt')).toISOString(),
        severity,
        leadUserId: lead,
        ...(locationId ? { locationId } : {}),
        ...(has('COMPLAINT')
          ? {
              complaint: {
                receivedOn: s('receivedOn'),
                channel: complaintChannel,
                consentToShare,
                ...opt('preferences'),
              },
            }
          : {}),
        ...(has('SAFEGUARDING')
          ? {
              safeguarding: {
                details: s('details'),
                ...opt('agencies'),
                ...opt('referralRef'),
              },
            }
          : {}),
      })) as Row;
      id = created.id;
    }, 'Event recorded.');
    if (ok && id) void navigate({ to: '/compliance/events/$id', params: { id } });
  }
  return (
    <Section title="Report an event">
      <form onSubmit={submit} aria-label="Report an event">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card size="small" title="What happened (tick all that apply)">
            <Space wrap>
              {Object.entries(EVENT_TYPE).map(([k, label]) => (
                <Checkbox
                  key={k}
                  checked={has(k)}
                  onChange={(e) =>
                    setTypes((t) => (e.target.checked ? [...t, k] : t.filter((x) => x !== k)))
                  }
                >
                  {label}
                </Checkbox>
              ))}
            </Space>
          </Card>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Short title">
              <Input name="title" required minLength={3} maxLength={200} />
            </Field>
            <Field label="When it happened">
              <Input type="datetime-local" name="occurredAt" required />
            </Field>
            <Field label="Harm">
              <Select
                value={severity}
                onChange={setSeverity}
                options={Object.entries(HARM).map(([k, label]) => ({ value: k, label }))}
                style={{ width: '100%' }}
              />
            </Field>
            <PersonSelect
              label="Lead"
              value={lead}
              onChange={setLead}
              people={people}
              meId={me.user.id}
            />
            <Field label="Location (optional)">
              <Select
                allowClear
                placeholder="Not at one location"
                value={locationId || undefined}
                onChange={(v) => setLocationId(v ?? '')}
                options={(locations.data?.data ?? [])
                  .filter((l) => !l.archived)
                  .map((l) => ({ value: l.id, label: l.name }))}
                style={{ width: '100%' }}
              />
            </Field>
          </div>
          <Field label="What happened (no patient names)">
            <Input.TextArea
              name="description"
              required
              minLength={3}
              maxLength={4000}
              rows={3}
            />
          </Field>
          {has('COMPLAINT') && (
            <Card size="small" title="Complaint">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Received on">
                  <Input type="date" name="receivedOn" required />
                </Field>
                <Field label="How it was received">
                  <Select
                    value={complaintChannel}
                    onChange={setComplaintChannel}
                    options={Object.entries(CHANNEL).map(([k, label]) => ({ value: k, label }))}
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Complainant's preferences (optional)">
                  <Input name="preferences" maxLength={500} />
                </Field>
                <Field label="Consent">
                  <Checkbox checked={consentToShare} onChange={(e) => setConsentToShare(e.target.checked)}>
                    Consent to share details with others involved
                  </Checkbox>
                </Field>
              </div>
            </Card>
          )}
          {has('SAFEGUARDING') && (
            <Card size="small" title="Safeguarding (restricted to safeguarding leads)">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Field label="Concern details">
                  <Input.TextArea
                    name="details"
                    required
                    minLength={3}
                    maxLength={8000}
                    rows={3}
                  />
                </Field>
                <Field label="Agencies involved (optional)">
                  <Input name="agencies" maxLength={1000} />
                </Field>
                <Field label="Referral reference (optional)">
                  <Input name="referralRef" maxLength={120} />
                </Field>
              </Space>
            </Card>
          )}
          <Button type="primary" htmlType="submit" disabled={types.length === 0}>
            Record event
          </Button>
          {msg}
        </Space>
      </form>
    </Section>
  );
}

export function Events() {
  const can = useCan();
  const [show, setShow] = useState<'true' | 'false' | 'all'>('true');
  const [type, setType] = useState('');
  const params = new URLSearchParams();
  if (show !== 'all') params.set('open', show);
  if (type) params.set('type', type);
  const res = useOne<{ data: Row[] }>(`/api/v1/events?${params.toString()}`);
  return (
    <>
      <Space wrap>
        <Field label="Show">
          <Select
            value={show}
            onChange={(v) => setShow(v)}
            options={[
              { value: 'true', label: 'Open events' },
              { value: 'false', label: 'Closed events' },
              { value: 'all', label: 'All events' },
            ]}
            style={{ minWidth: 160 }}
          />
        </Field>
        <Field label="Type">
          <Select
            allowClear
            placeholder="All types"
            value={type || undefined}
            onChange={(v) => setType(v ?? '')}
            options={Object.entries(EVENT_TYPE).map(([k, label]) => ({ value: k, label }))}
            style={{ minWidth: 200 }}
          />
        </Field>
      </Space>
      <DataTable<Row>
        caption={show === 'false' ? 'Closed events' : show === 'all' ? 'All events' : 'Open events'}
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load events.' : null}
        emptyMessage="No events."
        columns={[
          {
            key: 'c',
            header: 'Event',
            cell: (r) => (
              <Link to="/compliance/events/$id" params={{ id: r.id }}>
                <Typography.Link>{`${r.code} ${r.title}`}</Typography.Link>
              </Link>
            ),
          },
          {
            key: 't',
            header: 'Type',
            cell: (r) => (r.types as string[]).map((t) => EVENT_TYPE[t] ?? t).join(', '),
          },
          { key: 's', header: 'Harm', cell: (r) => HARM[r.severity] ?? r.severity },
          { key: 'st', header: 'Stage', cell: (r) => EVENT_STAGE[r.status] ?? r.status },
          { key: 'l', header: 'Lead', cell: (r) => r.leadName ?? 'Not a current member' },
          { key: 'o', header: 'Happened', cell: (r) => fmtDateTime(r.occurredAt) },
          {
            key: 'f',
            header: 'Flags',
            cell: (r) => (
              <Space direction="vertical" size="small">
                <CandourFlag e={r} />
                {r.restricted && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Restricted details
                  </Typography.Text>
                )}
              </Space>
            ),
          },
        ]}
      />
      {can('events.event.manage') && <ReportEvent />}
    </>
  );
}