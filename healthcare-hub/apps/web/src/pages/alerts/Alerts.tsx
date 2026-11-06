import { Link } from '@tanstack/react-router';
import { addDays, londonDate } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';

interface Item {
  key: string;
  event: string;
  sourceType: string;
  sourceId: string;
  alertId: string | null;
  alertVersion: number | null;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  reasonText: string;
  raisedAt: string;
  dueOn: string | null;
  state: 'OPEN' | 'ACKNOWLEDGED';
  snoozedUntil: string | null;
  snoozeReason?: string | null;
  why: 'OWNER' | 'DEPUTY' | 'ESCALATED' | 'RULE' | 'NOTIFIED' | 'ROLE';
  link: string;
}
interface Centre {
  items: Item[];
  rules: { event: string; email: boolean; roleNames: string[] }[];
  emailReminders: boolean;
}

export const EVENT_TEXT: Record<string, string> = {
  EXPIRY_WARNING: 'Compliance items due or expiring',
  ACTION_OVERDUE: 'Overdue actions',
  AUDIT_OVERDUE: 'Overdue audits',
  INCIDENT_REPORTED: 'New incidents and events',
  BREACH_RECORDED: 'Data protection breaches',
  POLICY_PUBLISHED: 'Published policies',
  OPERATIONS: 'Vehicles, jobs and retention',
};
const WHY_TEXT: Record<Item['why'], string> = {
  OWNER: 'You own it',
  DEPUTY: 'You are covering as deputy for the owner',
  ESCALATED: 'Not acknowledged in time, so it has come to you',
  NOTIFIED: 'You were notified',
  RULE: 'A notification rule includes your role',
  ROLE: 'Your role covers this area',
};
const SEVERITY_TEXT: Record<Item['severity'], string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
const SEVERITY_STATUS: Record<Item['severity'], StatusKind> = {
  CRITICAL: 'RED',
  HIGH: 'RED',
  MEDIUM: 'AMBER',
  LOW: 'GREY',
};
const SNOOZE_DAYS = [1, 3, 7, 14, 30];

function OpenLink({ item }: { item: Item }) {
  const [to, qs] = item.link.split('?');
  const tab = new URLSearchParams(qs ?? '').get('tab');
  return (
    <Link
      to={to as string}
      {...(tab ? { search: { tab } } : {})}
      aria-label={`Open ${item.title}`}
      className="font-medium text-hub-teal-dark underline"
    >
      Open
    </Link>
  );
}

/** Alerts centre: everything that needs this person's attention, and why they are told. */
export function Alerts() {
  const { api, orgId } = useApp();
  const can = useCan();
  const [event, setEvent] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [withAcknowledged, setWithAcknowledged] = useState(false);
  const [acknowledging, setAcknowledging] = useState<Item | null>(null);
  const [snoozing, setSnoozing] = useState<Item | null>(null);
  const [snoozeDays, setSnoozeDays] = useState(7);
  const qs = new URLSearchParams();
  if (event) qs.set('event', event);
  if (withAcknowledged) qs.set('includeAcknowledged', 'true');
  const query = qs.toString();
  const centre = useOne<Centre>(`/api/v1/alerts/centre${query ? `?${query}` : ''}`);
  const canHandle = can('compliance.requirement.manage');
  const rows = (centre.data?.items ?? []).filter((i) => !onlyMine || i.why !== 'ROLE');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Alerts</h1>
      <p className="text-sm">
        Things that need your attention. Acknowledging or snoozing an alert only pauses reminders:
        the record keeps its real status until the work is done.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Show">
          <select className={input} value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="">Everything</option>
            {Object.entries(EVENT_TEXT).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyMine}
            onChange={(e) => setOnlyMine(e.target.checked)}
          />
          Only things I own or was told about
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={withAcknowledged}
            onChange={(e) => setWithAcknowledged(e.target.checked)}
          />
          Include acknowledged alerts
        </label>
      </div>
      {centre.isError && (
        <p role="alert">Source unavailable. Could not load your alerts. Try again shortly.</p>
      )}
      <DataTable<Item>
        caption="Your alerts"
        rows={rows}
        rowKey={(r) => r.key}
        emptyMessage={centre.isLoading ? 'Loading…' : 'Nothing needs your attention.'}
        columns={[
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <StatusBadge
                status={SEVERITY_STATUS[r.severity]}
                reason={`${SEVERITY_TEXT[r.severity]}: ${r.reasonText}${
                  r.state === 'ACKNOWLEDGED' ? ' (acknowledged)' : ''
                }${
                  r.snoozedUntil
                    ? ` (reminders paused until ${fmtDateTime(r.snoozedUntil)}${
                        r.snoozeReason ? `: ${r.snoozeReason}` : ''
                      })`
                    : ''
                }`}
              />
            ),
          },
          { key: 't', header: 'What', cell: (r) => r.title },
          { key: 'e', header: 'Area', cell: (r) => EVENT_TEXT[r.event] ?? 'Other' },
          { key: 'w', header: 'Why you see it', cell: (r) => WHY_TEXT[r.why] },
          { key: 'r', header: 'Raised', cell: (r) => fmtDateTime(r.raisedAt) },
          { key: 'd', header: 'Due', cell: (r) => (r.dueOn ? fmtDate(r.dueOn) : 'Not set') },
          {
            key: 'a',
            header: 'Actions',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                <OpenLink item={r} />
                {canHandle && r.alertId && r.state === 'OPEN' && (
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Acknowledge ${r.title}`}
                    onClick={() => setAcknowledging(r)}
                  >
                    Acknowledge
                  </button>
                )}
                {canHandle && r.alertId && (
                  <button
                    type="button"
                    className={smallButton}
                    aria-label={`Snooze reminders for ${r.title}`}
                    onClick={() => setSnoozing(r)}
                  >
                    Snooze
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Section title="Who is told about what">
        {centre.data && centre.data.rules.length === 0 ? (
          <p className="text-sm">
            No notification rules name your role. You see the records you own, anything you were
            notified about, and the areas your role covers.
          </p>
        ) : (
          <ul aria-label="Notification rules that include your role" className="list-disc pl-5">
            {(centre.data?.rules ?? []).map((r, i) => (
              <li key={`${r.event}-${i}`} className="text-sm">
                {EVENT_TEXT[r.event] ?? 'Other'}: told to {r.roleNames.join(', ') || 'nobody'}
                {r.email
                  ? centre.data?.emailReminders
                    ? ', by email as well'
                    : ' (email is switched off for the organisation)'
                  : ', in the hub only'}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm">
          Notification rules are set by an administrator in Settings, Notifications.
        </p>
      </Section>

      <ActionDialog
        open={!!acknowledging}
        title={`Acknowledge ${acknowledging?.title ?? ''}`}
        confirmLabel="Acknowledge"
        onCancel={() => setAcknowledging(null)}
        successText="Alert acknowledged."
        onConfirm={() =>
          api.send('POST', `/api/v1/alerts/${acknowledging?.alertId}/acknowledge`, orgId, {})
        }
      >
        <p>
          Reminders stop until the situation changes. The record keeps its status until the work is
          done.
        </p>
      </ActionDialog>
      <ActionDialog
        open={!!snoozing}
        title={`Snooze reminders for ${snoozing?.title ?? ''}`}
        confirmLabel="Snooze reminders"
        onCancel={() => setSnoozing(null)}
        successText="Reminders paused."
        reasonLabel="Why are you snoozing it?"
        fields={
          <Field label="Pause reminders for">
            <select
              className={input}
              value={snoozeDays}
              onChange={(e) => setSnoozeDays(Number(e.target.value))}
            >
              {SNOOZE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? '1 day' : `${d} days`}
                </option>
              ))}
            </select>
          </Field>
        }
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/alerts/${snoozing?.alertId}/snooze`, orgId, {
            until: addDays(londonDate(new Date()), snoozeDays),
            reason,
          })
        }
      >
        <p>
          Only reminders pause, until the end of that day (UK time). The status and due date do not
          change.
        </p>
      </ActionDialog>
    </div>
  );
}
