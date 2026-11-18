// v36 Settings cards: escalation rules, escalating now, deputies, second-person rules, locations,
// security and rules & decisions. They read and write the same settings and records as before.
import {
  DEFAULT_WARNING_DAYS,
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  LOCAL_REFRESH_ABSOLUTE_SECONDS,
  LOCAL_REFRESH_IDLE_SECONDS,
  PASSWORD_MIN_LENGTH,
  RECIPIENTS,
  RECIPIENT_LABELS,
  type ItemKind,
} from '@hub/contracts';
import {
  COMPLAINT_ACK_WORKING_DAYS,
  COMPLAINT_RESPONSE_WORKING_DAYS,
  DETRIMENT_CHECK_DAYS,
  EMPLOYMENT_GAP_MONTHS,
  FPP_REVIEW_MONTHS,
  ICO_HOURS,
  IG_TRAINING_TARGET,
  MANAGER_ABSENCE_NOTICE_DAYS,
  MIN_DAILY_REST_HOURS,
  RATING_DISPLAY_DAYS,
  SPEAK_UP_ACK_DAYS,
  WEEKLY_HOURS_PROMPT,
} from '@hub/rules';
import { Button, Input, Modal } from 'antd';
import { useState, type FormEvent } from 'react';
import { Field, useCan, useRun } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { Ms, WfCard, WfTag, type KTone } from '../../v36/ui.js';
import { useList, useOne, usePeople } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Recipient = (typeof RECIPIENTS)[number];
interface ItemRule {
  kind: ItemKind;
  recipients: Recipient[];
  leadAfterDays?: number;
  managerAfterDays?: number;
}
interface Deputy {
  leadUserId: string;
  deputyUserId: string;
  from: string;
  to: string;
}

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const fmt = (d: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${d}T12:00:00Z`),
  );
const overdue = (n: number) => (n === 0 ? 'At once' : `${n} day${n === 1 ? '' : 's'} overdue`);

function useSettings() {
  return useOne<{ settings: Row; version: number }>('/api/v1/admin/settings');
}

// ---- escalation rules --------------------------------------------------------------------------
export function EscalationRules() {
  const { api, orgId } = useApp();
  const can = useCan();
  const edit = can('admin.settings.manage');
  const q = useSettings();
  const { run, msg } = useRun();
  const [find, setFind] = useState('');
  const [editing, setEditing] = useState<ItemRule | null>(null);
  const s = q.data?.settings;
  if (!s) return null;
  const esc = (s.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 }) as {
    leadAfterDays: number;
    managerAfterDays: number;
  };
  const warn = ((s.warningDays as number[]) ?? DEFAULT_WARNING_DAYS).slice().sort((a, b) => b - a);
  const email = !!(s.channels?.email ?? true) && s.emailReminders !== false;
  const rules: ItemRule[] = ITEM_KINDS.map(
    (kind) =>
      ((s.itemRules as ItemRule[]) ?? []).find((r) => r.kind === kind) ?? {
        kind,
        recipients: ['OWNER', 'LEAD'],
      },
  );
  const shown = rules.filter((r) =>
    ITEM_KIND_LABELS[r.kind].toLowerCase().includes(find.trim().toLowerCase()),
  );
  const save = (next: ItemRule) =>
    run(async () => {
      await api.send(
        'PATCH',
        '/api/v1/admin/settings',
        orgId,
        { itemRules: rules.map((r) => (r.kind === next.kind ? next : r)) },
        q.data!.version,
      );
      await q.refetch();
      setEditing(null);
    }, `Escalation rule for ${ITEM_KIND_LABELS[next.kind].toLowerCase()} saved.`);

  return (
    <WfCard
      title="Escalation rules"
      extra={<span className="wf-mini">Product defaults – not CQC rules. Changes are logged.</span>}
    >
      {msg}
      <div className="wf-filters">
        <Input
          allowClear
          prefix={<Ms i="search" />}
          placeholder="Name, reference or text…"
          aria-label="Search escalation rules"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          style={{ width: 280, maxWidth: '100%' }}
        />
      </div>
      <table className="wf-t ant-t" aria-label="Escalation rules">
        <thead className="ant-table-thead">
          <tr>
            {[
              'Kind of item',
              'Warn',
              'Tell the lead',
              'Tell the Registered Manager',
              'How',
              '',
            ].map((h, i) => (
              <th key={i} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {shown.map((r) => {
            const lead = r.leadAfterDays ?? esc.leadAfterDays;
            const mgr = r.managerAfterDays ?? esc.managerAfterDays;
            return (
              <tr key={r.kind} className="ant-table-row">
                <td className="ant-table-cell">
                  <b>{ITEM_KIND_LABELS[r.kind]}</b>
                </td>
                <td className="ant-table-cell">{warn[0] ?? 30} days before</td>
                <td className="ant-table-cell">{overdue(lead)}</td>
                <td className="ant-table-cell">
                  {r.recipients.includes('REGISTERED_MANAGER') ? 'From the start' : overdue(mgr)}
                </td>
                <td className="ant-table-cell">
                  {email ? (
                    <WfTag tone="green" icon="mail">
                      Email + in app
                    </WfTag>
                  ) : (
                    <WfTag tone="grey" icon="radio_button_unchecked">
                      In app only
                    </WfTag>
                  )}
                </td>
                <td className="ant-table-cell" style={{ textAlign: 'right' }}>
                  {edit && (
                    <Button
                      size="small"
                      aria-label={`Edit escalation: ${ITEM_KIND_LABELS[r.kind]}`}
                      onClick={() =>
                        setEditing({ ...r, leadAfterDays: lead, managerAfterDays: mgr })
                      }
                    >
                      <Ms i="edit" /> Edit
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="wf-mini" style={{ margin: 0 }}>
        Warnings go out {warn.join(', ')} days before a date. Owners are always told.
      </p>
      <Modal
        open={editing !== null}
        title={editing ? `Escalation: ${ITEM_KIND_LABELS[editing.kind]}` : ''}
        onCancel={() => setEditing(null)}
        footer={null}
        className="hh-modal"
        destroyOnHidden
      >
        {editing && (
          <form
            className="hh-form"
            aria-label="Edit escalation rule"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void save(editing);
            }}
          >
            <div className="hh-grid">
              <Field label="Tell the lead after (days overdue)">
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={editing.leadAfterDays}
                  onChange={(e) =>
                    setEditing({ ...editing, leadAfterDays: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Tell the Registered Manager after (days overdue)">
                <input
                  type="number"
                  min={1}
                  max={180}
                  value={editing.managerAfterDays}
                  onChange={(e) =>
                    setEditing({ ...editing, managerAfterDays: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <fieldset>
              <legend>Told from the start</legend>
              <div className="hh-checks">
                {RECIPIENTS.map((who) => (
                  <label key={who} className="hh-check">
                    <input
                      type="checkbox"
                      checked={editing.recipients.includes(who)}
                      disabled={who === 'OWNER'}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          recipients: e.target.checked
                            ? [...editing.recipients, who]
                            : editing.recipients.filter((x) => x !== who),
                        })
                      }
                    />
                    {RECIPIENT_LABELS[who]}
                  </label>
                ))}
              </div>
            </fieldset>
            {(editing.managerAfterDays ?? 0) <= (editing.leadAfterDays ?? 0) && (
              <p role="alert" className="hh-help" style={{ color: '#cf1322' }}>
                The Registered Manager must be told later than the lead.
              </p>
            )}
            <div className="hh-actions">
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button
                type="primary"
                htmlType="submit"
                disabled={(editing.managerAfterDays ?? 0) <= (editing.leadAfterDays ?? 0)}
              >
                Save rule
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </WfCard>
  );
}

// ---- escalating now ---------------------------------------------------------------------------
interface AlertItem {
  key: string;
  title: string;
  reasonText: string;
  severity: string;
  raisedAt: string;
  dueOn: string | null;
  state: string;
  sourceType: string;
}
const RULE_OF: Record<string, string> = {
  REQUIREMENT: 'Staff check / document',
  ACTION: 'Action',
  AUDIT: 'Audit',
  DEFECT: 'Defect review date',
  INCIDENT: 'Incident stage deadline',
  BREACH: 'Data protection deadline',
  JOB: 'Journey',
};

export function EscalatingNow() {
  const q = useSettings();
  const centre = useOne<{ items: AlertItem[] }>('/api/v1/alerts/centre');
  const esc = (q.data?.settings.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 }) as {
    leadAfterDays: number;
    managerAfterDays: number;
  };
  const day0 = Date.parse(today());
  const rows = (centre.data?.items ?? [])
    .filter((a) => a.state === 'OPEN' && a.dueOn)
    .map((a) => {
      const late = Math.floor((day0 - Date.parse(a.dueOn!.slice(0, 10))) / 86_400_000);
      return { a, late };
    })
    .filter((x) => x.late >= -7)
    .sort((x, y) => y.late - x.late)
    .slice(0, 12);
  const status = (late: number): { tone: KTone; icon: string; text: string } =>
    late >= esc.managerAfterDays
      ? {
          tone: 'red',
          icon: 'error',
          text: `${late} days overdue · Escalated to the Registered Manager`,
        }
      : late >= esc.leadAfterDays && late > 0
        ? {
            tone: 'red',
            icon: 'error',
            text: `${late} day${late === 1 ? '' : 's'} overdue · Escalated to lead`,
          }
        : late > 0
          ? {
              tone: 'red',
              icon: 'error',
              text: `${late} day${late === 1 ? '' : 's'} overdue · Owner reminded`,
            }
          : late === 0
            ? { tone: 'amber', icon: 'schedule', text: 'Due today' }
            : { tone: 'amber', icon: 'schedule', text: `Due in ${-late} days` };
  return (
    <WfCard title="Escalating now" count={rows.length}>
      <table className="wf-t ant-t" aria-label="Escalating now">
        <thead className="ant-table-thead">
          <tr>
            {['Item', 'Rule', 'Status'].map((h) => (
              <th key={h} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {rows.length === 0 && (
            <tr className="ant-table-row">
              <td className="ant-table-cell" colSpan={3}>
                {centre.isLoading ? 'Loading…' : 'Nothing is overdue or due this week.'}
              </td>
            </tr>
          )}
          {rows.map(({ a, late }) => {
            const st = status(late);
            return (
              <tr key={a.key} className={`ant-table-row${late > 0 ? ' hh-alert-row' : ''}`}>
                <td className="ant-table-cell">{a.title}</td>
                <td className="ant-table-cell">{RULE_OF[a.sourceType] ?? a.reasonText}</td>
                <td className="ant-table-cell">
                  <WfTag tone={st.tone} icon={st.icon}>
                    {st.text}
                  </WfTag>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </WfCard>
  );
}

// ---- deputies ---------------------------------------------------------------------------------
export function Deputies() {
  const { api, orgId } = useApp();
  const can = useCan();
  const edit = can('admin.settings.manage');
  const q = useSettings();
  const people = usePeople();
  const users = useList('/api/v1/admin/users', can('admin.users.manage'));
  const { run, msg } = useRun();
  const [adding, setAdding] = useState(false);
  const s = q.data?.settings;
  if (!s) return null;
  const deputies = (s.deputies ?? []) as Deputy[];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.displayName ?? 'Former member';
  const roleOf = (id: string) =>
    ((users.data ?? []) as Row[])
      .find((u) => u.id === id)
      ?.memberships?.find((m: Row) => !m.validTo)?.roleName as string | undefined;
  const t = today();
  const saveAll = (next: Deputy[], done: string) =>
    run(async () => {
      await api.send('PATCH', '/api/v1/admin/settings', orgId, { deputies: next }, q.data!.version);
      await q.refetch();
      setAdding(false);
    }, done);
  return (
    <WfCard
      title="Deputies (cover for a lead between two dates)"
      extra={
        edit ? (
          <Button type="primary" size="small" onClick={() => setAdding(true)}>
            <Ms i="person_add" /> Add deputy
          </Button>
        ) : undefined
      }
    >
      {msg}
      <table className="wf-t ant-t" aria-label="Deputies">
        <thead className="ant-table-thead">
          <tr>
            {['Lead', 'Deputy', 'Dates', 'Covers', 'Status', ''].map((h, i) => (
              <th key={i} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {deputies.length === 0 && (
            <tr className="ant-table-row">
              <td className="ant-table-cell" colSpan={6}>
                No deputies are set.
              </td>
            </tr>
          )}
          {deputies.map((d, i) => {
            const st =
              d.to < t
                ? { tone: 'grey' as KTone, icon: 'check_circle', text: 'Ended' }
                : d.from <= t
                  ? { tone: 'green' as KTone, icon: 'check_circle', text: 'Covering now' }
                  : { tone: 'blue' as KTone, icon: 'hourglass_top', text: 'Booked' };
            return (
              <tr key={i} className="ant-table-row">
                <td className="ant-table-cell">
                  <b>{nameOf(d.leadUserId)}</b>
                  {roleOf(d.leadUserId) && <span className="sub">{roleOf(d.leadUserId)}</span>}
                </td>
                <td className="ant-table-cell">{nameOf(d.deputyUserId)}</td>
                <td className="ant-table-cell">
                  {fmt(d.from)} – {fmt(d.to)}
                </td>
                <td className="ant-table-cell">Everything the lead is told or must approve</td>
                <td className="ant-table-cell">
                  <WfTag tone={st.tone} icon={st.icon}>
                    {st.text}
                  </WfTag>
                </td>
                <td className="ant-table-cell" style={{ textAlign: 'right' }}>
                  {edit && (
                    <Button
                      size="small"
                      aria-label={`End cover by ${nameOf(d.deputyUserId)} for ${nameOf(d.leadUserId)}`}
                      onClick={() =>
                        void saveAll(
                          deputies.filter((_, j) => j !== i),
                          'Deputy cover ended.',
                        )
                      }
                    >
                      End
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Modal
        open={adding}
        title="Add a deputy"
        onCancel={() => setAdding(false)}
        footer={null}
        className="hh-modal"
        destroyOnHidden
      >
        <form
          className="hh-form"
          aria-label="Add a deputy"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const d: Deputy = {
              leadUserId: String(f.get('lead')),
              deputyUserId: String(f.get('deputy')),
              from: String(f.get('from')),
              to: String(f.get('to')),
            };
            if (d.leadUserId === d.deputyUserId || d.to < d.from) return;
            void saveAll([...deputies, d], 'Deputy added.');
          }}
        >
          <div className="hh-grid">
            <Field label="Lead">
              <select name="lead" required>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Deputy">
              <select name="deputy" required>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From">
              <input name="from" type="date" required min={t} />
            </Field>
            <Field label="To">
              <input name="to" type="date" required min={t} />
            </Field>
          </div>
          <div className="hh-actions">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit">
              Add deputy
            </Button>
          </div>
        </form>
      </Modal>
    </WfCard>
  );
}

// ---- second-person rules ----------------------------------------------------------------------
export function SecondPersonRules() {
  return (
    <WfCard title="Second-person rules (always on)">
      <ul className="hh-rules">
        <li>
          Nobody verifies a document, training record or action evidence they uploaded or own.
        </li>
        <li>
          People are approved for a role only by the Registered Manager or deputy, and not by anyone
          who verified their checks.
        </li>
        <li>
          A repair is signed off by the Fleet Lead; the vehicle is returned to service by someone
          else.
        </li>
        <li>
          Check lists, audit templates and policies are published by someone other than the person
          who drafted them.
        </li>
        <li>Incidents are closed by someone other than the lead investigator.</li>
        <li>Auditors never audit an area they own.</li>
        <li>
          Statutory blocks (licence, insurance, MOT, stop-use defects) have no override. Policy
          exceptions need a named approver, reason and end date.
        </li>
        <li>Every blocked attempt is written to the audit trail.</li>
      </ul>
    </WfCard>
  );
}

// ---- locations --------------------------------------------------------------------------------
export function LocationsV36({ onArchive }: { onArchive?: (r: Row) => void }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const canEdit = can('admin.org.manage');
  const loc = useList(`/api/v1/organisations/${orgId}/locations`);
  const act = useList(`/api/v1/organisations/${orgId}/registered-activities`);
  const users = useList('/api/v1/admin/users', can('admin.users.manage'));
  const staff = useOne<{ data: Row[] }>(
    can('staff.profile.view_basic') ? '/api/v1/staff?limit=100&lifecycle=ACTIVE' : null,
  );
  const vehicles = useOne<{ data: Row[] }>(can('fleet.vehicle.view') ? '/api/v1/vehicles' : null);
  const { run, msg } = useRun();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState(true);
  const locs = (loc.data ?? []) as Row[];
  const single = locs.filter((l) => !l.archived).length === 1;
  const managers = ((users.data ?? []) as Row[]).flatMap((u) =>
    ((u.memberships as Row[]) ?? [])
      .filter((m) => m.roleKey === 'REGISTERED_MANAGER' && !m.validTo)
      .map((m) => ({ name: u.displayName as string, locationId: m.locationId as string | null })),
  );
  const count = (rows: Row[] | undefined, id: string) =>
    rows === undefined
      ? '—'
      : rows.filter((r) => r.locationId === id || (single && !r.locationId)).length;
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', `/api/v1/organisations/${orgId}/locations`, orgId, { name, registered }),
      'Location added.',
    );
    if (ok) {
      setName('');
      setAdding(false);
      await loc.refetch?.();
    }
  };
  return (
    <WfCard
      title="Locations"
      extra={
        canEdit ? (
          <Button type="primary" size="small" onClick={() => setAdding(true)}>
            <Ms i="add_location" /> Add location
          </Button>
        ) : undefined
      }
    >
      {msg}
      <table className="wf-t ant-t" aria-label="Locations">
        <thead className="ant-table-thead">
          <tr>
            {[
              'Location',
              'Address',
              'Registered activities',
              'Registered Manager',
              'Staff',
              'Vehicles',
              ...(canEdit && onArchive ? [''] : []),
            ].map((h, i) => (
              <th key={i} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {locs.length === 0 && (
            <tr className="ant-table-row">
              <td className="ant-table-cell" colSpan={6}>
                {loc.isLoading ? 'Loading…' : 'No locations yet.'}
              </td>
            </tr>
          )}
          {locs.map((l) => {
            const acts = ((act.data ?? []) as Row[]).filter((a) => a.locationId === l.id);
            const rm = managers.filter((m) => !m.locationId || m.locationId === l.id);
            return (
              <tr key={l.id} className="ant-table-row">
                <td className="ant-table-cell">
                  <b>{l.name}</b>
                  <span className="sub">
                    {l.archived
                      ? `Archived${l.archiveReason ? `: ${l.archiveReason}` : ''}`
                      : l.registered
                        ? (l.cqcLocationId ?? 'Registered with CQC')
                        : 'Not registered with CQC'}
                  </span>
                </td>
                <td className="ant-table-cell">{l.address ?? '—'}</td>
                <td className="ant-table-cell">
                  {acts.length ? acts.map((a) => a.name).join('; ') : '—'}
                </td>
                <td className="ant-table-cell">{rm.map((m) => m.name).join(', ') || '—'}</td>
                <td className="ant-table-cell">{count(staff.data?.data, l.id)}</td>
                <td className="ant-table-cell">{count(vehicles.data?.data, l.id)}</td>
                {canEdit && onArchive && (
                  <td className="ant-table-cell" style={{ textAlign: 'right' }}>
                    <Button
                      size="small"
                      onClick={() => onArchive(l)}
                      aria-label={`${l.archived ? 'Restore' : 'Archive'} ${l.name}`}
                    >
                      {l.archived ? 'Restore' : 'Archive'}
                    </Button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <Modal
        open={adding}
        title="Add location"
        onCancel={() => setAdding(false)}
        footer={null}
        className="hh-modal"
        destroyOnHidden
      >
        <form onSubmit={add} className="hh-form" aria-label="Add location">
          <div className="hh-grid">
            <Field label="Location name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
          </div>
          <label className="hh-check">
            <input
              type="checkbox"
              checked={registered}
              onChange={(e) => setRegistered(e.target.checked)}
            />{' '}
            Registered with CQC
          </label>
          <div className="hh-actions">
            <Button onClick={() => setAdding(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit">
              Add location
            </Button>
          </div>
        </form>
      </Modal>
    </WfCard>
  );
}

// ---- security ---------------------------------------------------------------------------------
export function SecurityCard() {
  const rows: [string, string][] = [
    [
      'Sign out after inactivity',
      `${LOCAL_REFRESH_IDLE_SECONDS / 60} minutes without using the app`,
    ],
    ['Longest session', `${LOCAL_REFRESH_ABSOLUTE_SECONDS / 3600} hours, then sign in again`],
    ['Passwords', `At least ${PASSWORD_MIN_LENGTH} characters`],
  ];
  return (
    <WfCard title="Security">
      <table className="wf-t ant-t" aria-label="Security">
        <thead className="ant-table-thead">
          <tr>
            <th className="ant-table-cell" scope="col">
              Setting
            </th>
            <th className="ant-table-cell" scope="col">
              Now
            </th>
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {rows.map(([k, v]) => (
            <tr key={k} className="ant-table-row">
              <td className="ant-table-cell">
                <b>{k}</b>
              </td>
              <td className="ant-table-cell">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </WfCard>
  );
}

// ---- rules & decisions ------------------------------------------------------------------------
export function RulesDecisions() {
  const rules: [string, string, string][] = [
    [
      'D1 Minimum rest between shifts',
      'Working Time Regulations 1998 (daily rest)',
      `${MIN_DAILY_REST_HOURS} hours`,
    ],
    [
      'D2 Weekly hours prompt',
      'Working Time Regulations 1998 (48-hour week)',
      `${WEEKLY_HOURS_PROMPT} hours in 7 days`,
    ],
    [
      'D3 Complaint acknowledgement',
      'Complaints regulations 2009',
      `${COMPLAINT_ACK_WORKING_DAYS} working days`,
    ],
    [
      'D4 Complaint response',
      'Organisation policy',
      `${COMPLAINT_RESPONSE_WORKING_DAYS} working days`,
    ],
    ['D5 Personal data breach to the ICO', 'UK GDPR article 33', `${ICO_HOURS} hours`],
    [
      'D6 Speak-up acknowledgement',
      'National Guardian’s Office guidance',
      `${SPEAK_UP_ACK_DAYS} days`,
    ],
    ['D7 Detriment check after a concern', 'Organisation policy', `${DETRIMENT_CHECK_DAYS} days`],
    ['D8 Rating displayed after publication', 'Regulation 20A', `${RATING_DISPLAY_DAYS} days`],
    ['D9 Fit and proper review', 'Regulation 5', `Every ${FPP_REVIEW_MONTHS} months`],
    [
      'D10 Registered Manager absence notice',
      'Registration regulations 2009',
      `${MANAGER_ABSENCE_NOTICE_DAYS} days or more`,
    ],
    ['D11 Employment gap to explain', 'Schedule 3', `${EMPLOYMENT_GAP_MONTHS} months`],
    [
      'D12 Information governance training target',
      'NHS contract / DSP Toolkit',
      `${IG_TRAINING_TARGET}% of staff`,
    ],
  ];
  return (
    <WfCard title="Rules & decisions">
      <table className="wf-t ant-t" aria-label="Rules and decisions">
        <thead className="ant-table-thead">
          <tr>
            {['Rule', 'Now', 'Decision'].map((h) => (
              <th key={h} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {rules.map(([rule, basis, now]) => (
            <tr key={rule} className="ant-table-row">
              <td className="ant-table-cell">
                <b>{rule}</b>
                <span className="sub">{basis}</span>
              </td>
              <td className="ant-table-cell">{now}</td>
              <td className="ant-table-cell">
                <WfTag tone="green" icon="check_circle">
                  Built into this version
                </WfTag>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="wf-mini" style={{ margin: 0 }}>
        These rules are set in the product and apply to every organisation. Escalation timings can
        be changed under Access &amp; escalation › Escalation &amp; deputies.
      </p>
    </WfCard>
  );
}
