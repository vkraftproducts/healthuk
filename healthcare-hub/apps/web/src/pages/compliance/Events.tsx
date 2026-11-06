import { DataTable, StatusBadge } from '@hub/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  Field,
  PersonSelect,
  Section,
  button,
  fmtDateTime,
  input,
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
        severity: s('severity'),
        leadUserId: lead,
        ...(s('locationId') ? { locationId: s('locationId') } : {}),
        ...(has('COMPLAINT')
          ? {
              complaint: {
                receivedOn: s('receivedOn'),
                channel: s('channel'),
                consentToShare: f.get('consentToShare') === 'on',
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
      <form onSubmit={submit} className="space-y-3" aria-label="Report an event">
        <fieldset className="rounded border border-hub-line p-2">
          <legend className="px-1 text-sm font-semibold">
            What happened (tick all that apply)
          </legend>
          <div className="flex flex-wrap gap-3">
            {Object.entries(EVENT_TYPE).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={has(k)}
                  onChange={(e) =>
                    setTypes((t) => (e.target.checked ? [...t, k] : t.filter((x) => x !== k)))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Short title">
            <input name="title" required minLength={3} maxLength={200} className={input} />
          </Field>
          <Field label="When it happened">
            <input type="datetime-local" name="occurredAt" required className={input} />
          </Field>
          <Field label="Harm">
            <select name="severity" className={input} defaultValue="NO_HARM">
              {Object.entries(HARM).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <PersonSelect
            label="Lead"
            value={lead}
            onChange={setLead}
            people={people}
            meId={me.user.id}
          />
          <Field label="Location (optional)">
            <select name="locationId" className={input}>
              <option value="">Not at one location</option>
              {(locations.data?.data ?? [])
                .filter((l) => !l.archived)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="What happened (no patient names)">
          <textarea
            name="description"
            required
            minLength={3}
            maxLength={4000}
            rows={3}
            className={input}
          />
        </Field>
        {has('COMPLAINT') && (
          <fieldset className="grid gap-3 rounded border border-hub-line p-2 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold">Complaint</legend>
            <Field label="Received on">
              <input type="date" name="receivedOn" required className={input} />
            </Field>
            <Field label="How it was received">
              <select name="channel" className={input}>
                {Object.entries(CHANNEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Complainant's preferences (optional)">
              <input name="preferences" maxLength={500} className={input} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="consentToShare" />
              Consent to share details with others involved
            </label>
          </fieldset>
        )}
        {has('SAFEGUARDING') && (
          <fieldset className="grid gap-3 rounded border border-hub-line p-2">
            <legend className="px-1 text-sm font-semibold">
              Safeguarding (restricted to safeguarding leads)
            </legend>
            <Field label="Concern details">
              <textarea
                name="details"
                required
                minLength={3}
                maxLength={8000}
                rows={3}
                className={input}
              />
            </Field>
            <Field label="Agencies involved (optional)">
              <input name="agencies" maxLength={1000} className={input} />
            </Field>
            <Field label="Referral reference (optional)">
              <input name="referralRef" maxLength={120} className={input} />
            </Field>
          </fieldset>
        )}
        <button className={button} disabled={types.length === 0}>
          Record event
        </button>
        {msg}
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
      <div className="flex flex-wrap gap-3">
        <Field label="Show">
          <select
            className={input}
            value={show}
            onChange={(e) => setShow(e.target.value as 'true' | 'false' | 'all')}
          >
            <option value="true">Open events</option>
            <option value="false">Closed events</option>
            <option value="all">All events</option>
          </select>
        </Field>
        <Field label="Type">
          <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {Object.entries(EVENT_TYPE).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
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
              <Link
                to="/compliance/events/$id"
                params={{ id: r.id }}
                className="font-medium text-hub-teal-dark underline"
              >{`${r.code} ${r.title}`}</Link>
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
              <div className="space-y-1">
                <CandourFlag e={r} />
                {r.restricted && <span className="block text-xs">Restricted details</span>}
              </div>
            ),
          },
        ]}
      />
      {can('events.event.manage') && <ReportEvent />}
    </>
  );
}
