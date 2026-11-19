import { DataTable, StatusBadge } from '@hub/ui';
import {
  DEFAULT_WARNING_DAYS,
  ITEM_KINDS,
  ITEM_KIND_LABELS,
  NOTIFICATION_EVENTS,
  NON_INVITABLE_ROLE_KEYS,
  PERMISSIONS,
  RECIPIENTS,
  RECIPIENT_LABELS,
  SECTOR_PACKS,
  type ItemKind,
  type PermissionKey,
} from '@hub/contracts';
import { Alert, Button, Modal } from 'antd';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  Tabs,
  fmtDate,
  fmtDateTime,
  saveBlob,
  useCan,
  useRun,
  words,
  PageHeader,
} from '../../components.js';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useApp } from '../../shell/AppContext.js';
import { Views, Who } from '../../v36/kit.js';
import { Deeper, Ms, WfTag } from '../../v36/ui.js';
import { DataPanel } from './DataPanel.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { IntegrationsPanel } from './IntegrationsPanel.js';
import { LibraryPanel } from './LibraryPanel.js';
import { useList, useOne, usePeople } from './hooks.js';
import { Retention } from './PrivacyPanel.js';
import {
  Deputies,
  EscalatingNow,
  EscalationRules,
  LocationsV36,
  RulesDecisions,
  SecondPersonRules,
  SecurityCard,
} from './SettingsV36.js';
import { StatementOfPurpose } from '../registers/GovernanceRecords.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TABS = [
  { id: 'org', label: 'Organisation and locations', perm: null },
  { id: 'users', label: 'Users and roles', perm: 'admin.users.manage' },
  {
    id: 'library',
    label: 'Requirement library',
    perm: ['admin.settings.manage', 'admin.requirements.publish', 'compliance.requirement.manage'],
  },
  {
    id: 'notifications',
    label: 'Escalation and deputies',
    perm: 'admin.settings.manage',
  },
  { id: 'support', label: 'Support access', perm: 'admin.support.approve' },
  { id: 'audit', label: 'Audit log', perm: 'admin.audit.view' },
  {
    id: 'data',
    label: 'Import and export',
    perm: ['admin.import.manage', 'admin.requirements.publish', 'admin.export.full'],
  },
  { id: 'privacy', label: 'Data protection', perm: 'privacy.manage' },
  { id: 'integrations', label: 'Integrations', perm: 'admin.settings.manage' },
  { id: 'accounts', label: 'Accounts & security', perm: 'admin.users.manage' },
  { id: 'rules', label: 'Rules & decisions', perm: null },
] as const;

/** v36 Settings: three tabs with views. The URL names the section (?tab=users). */
const GROUPS: {
  id: string;
  label: string;
  subs: { id: string; label: string; views: string[] }[];
}[] = [
  {
    id: 'g-access',
    label: 'Access & escalation',
    subs: [
      { id: 's-users', label: 'Users & access', views: ['users', 'support'] },
      { id: 's-escalation', label: 'Escalation & deputies', views: ['notifications'] },
    ],
  },
  {
    id: 'g-org',
    label: 'Organisation',
    subs: [
      {
        id: 's-org',
        label: 'Organisation',
        views: ['org', 'accounts', 'rules', 'data', 'library', 'integrations'],
      },
    ],
  },
];
const VIEW_LABEL: Record<string, string> = {
  users: 'Accounts & roles',
  support: 'Support & retention',
  audit: 'Audit log',
  notifications: 'Escalation & deputies',
  org: 'Locations & purpose',
  library: 'Requirement library',
  accounts: 'Accounts & security',
  rules: 'Rules & decisions',
  data: 'Data & sector packs',
  privacy: 'Data protection',
  integrations: 'Integrations',
};
/** Navigation links from before the v36 grouping. */
const ALIAS: Record<string, string> = { escalation: 'notifications', organisation: 'org' };

export function Settings() {
  const { me, orgId } = useApp();
  const { tab: linked } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  if (!orgId)
    return (
      <Alert type="info" showIcon role="status" message="Select an organisation to continue." />
    );
  const tabs = TABS.filter(
    (t) =>
      !t.perm ||
      (Array.isArray(t.perm)
        ? t.perm.some((p: string) => me.permissions.includes(p))
        : me.permissions.includes(t.perm as string)),
  );
  const allowed = new Set<string>(tabs.map((t) => t.id));
  const groups = GROUPS.map((g) => {
    const subs = g.subs
      .map((x) => ({ ...x, views: x.views.filter((v) => allowed.has(v)) }))
      .filter((x) => x.views.length > 0);
    return { ...g, subs, views: subs.flatMap((x) => x.views) };
  }).filter((g) => g.views.length > 0);
  const want = linked ? (ALIAS[linked] ?? linked) : undefined;
  // With no section in the URL, open Organisation (every member may see the locations).
  const tab = (want && allowed.has(want) ? want : 'org') as (typeof TABS)[number]['id'];
  const group = groups.find((g) => g.views.includes(tab));
  const sub = group?.subs.find((x) => x.views.includes(tab));
  const setTab = (id: string) => void navigate({ to: '/settings', search: { tab: id } });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <PageHeader
        title="Settings"
        description="Your organisation, locations, who can use the system and how alerts reach people."
      />
      <Tabs
        label="Settings sections"
        tabs={groups.map((g) => ({ id: g.id, label: g.label, show: true }))}
        current={group?.id ?? ''}
        onChange={(id) => setTab(groups.find((g) => g.id === id)!.views[0]!)}
      >
        {group && group.subs.length > 1 && (
          <Views
            label={`${group.label} sections`}
            value={sub?.id ?? ''}
            onChange={(id) => setTab(group.subs.find((x) => x.id === id)!.views[0]!)}
            options={group.subs.map((x) => ({ value: x.id, label: x.label }))}
          />
        )}
        {sub && sub.views.length > 1 && (
          <Deeper>
            <Views
              label={`${sub.label} view`}
              value={tab}
              onChange={setTab}
              options={sub.views.map((v) => ({ value: v, label: VIEW_LABEL[v] ?? v }))}
            />
          </Deeper>
        )}
        <div id="settings-panel">
          {tab === 'org' && <OrgPanel />}
          {tab === 'users' && <UsersPanel />}
          {tab === 'accounts' && (
            <div className="wf-stack">
              <UsersPanel />
              <SecurityCard />
            </div>
          )}
          {tab === 'rules' && <RulesDecisions />}
          {tab === 'library' && <LibraryPanel />}
          {tab === 'notifications' && (
            <div className="wf-stack">
              <EscalationRules />
              <EscalatingNow />
              <Deputies />
              <SecondPersonRules />
              <details className="hh-more">
                <summary>Who else is told, channels and warning days</summary>
                <div className="wf-stack">
                  <NotificationsPanel />
                  <AlertRoutingPanel compact />
                </div>
              </details>
            </div>
          )}
          {tab === 'support' && (
            <div className="wf-stack">
              <SupportPanel />
              {me.permissions.includes('privacy.manage') && <Retention />}
            </div>
          )}
          {tab === 'audit' && <AuditPanel />}
          {tab === 'data' && (
            <div className="wf-stack">
              <OrgDetails />
              <ServicesCard />
              <DataPanel />
            </div>
          )}
          {tab === 'privacy' && <PrivacyPanel />}
          {tab === 'integrations' && <IntegrationsPanel />}
        </div>
      </Tabs>
    </div>
  );
}

// ---- organisation ---------------------------------------------------------------------------------
function OrgDetails() {
  const { api, orgId } = useApp();
  const can = useCan();
  const org = useOne<Row>(`/api/v1/organisations/${orgId}`);
  const [edit, setEdit] = useState<{ name: string; packs: string[] } | null>(null);
  const o = org.data;
  if (!o) return <p role="status">Loading…</p>;
  const current = (o.sectorPacks as string[] | undefined) ?? [];
  const packs = current.map((p) => SECTOR_PACKS[p] ?? words(p));
  const removing = edit ? current.filter((p) => !edit.packs.includes(p)) : [];
  return (
    <Section
      title="Organisation details"
      actions={
        can('admin.org.manage') && (
          <Button
            type="link"
            size="small"
            onClick={() => setEdit({ name: o.name, packs: [...current] })}
          >
            Edit details
          </Button>
        )
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-semibold">Name</dt>
        <dd>{o.name}</dd>
        <dt className="font-semibold">Sector packs</dt>
        <dd>{packs.length ? packs.join(', ') : 'None switched on'}</dd>
        <dt className="font-semibold">Regulator</dt>
        <dd>{o.regulator}</dd>
        <dt className="font-semibold">Time zone</dt>
        <dd>{o.timezone === 'Europe/London' ? 'UK (London)' : o.timezone}</dd>
      </dl>
      <ActionDialog
        open={edit !== null}
        title="Edit organisation details"
        confirmLabel="Save details"
        confirmDisabled={!edit || edit.name.trim().length < 2}
        onCancel={() => setEdit(null)}
        onConfirm={() =>
          api.send(
            'PATCH',
            `/api/v1/organisations/${orgId}`,
            orgId,
            {
              ...(edit!.name.trim() !== o.name ? { name: edit!.name.trim() } : {}),
              sectorPacks: edit!.packs,
            },
            o.version,
          )
        }
        fields={
          edit && (
            <div className="grid gap-3">
              <Field label="Organisation name">
                <input
                  maxLength={120}
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </Field>
              <fieldset className="space-y-1 text-sm">
                <legend className="font-medium">Sector packs</legend>
                {Object.entries(SECTOR_PACKS).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={edit.packs.includes(k)}
                      onChange={(e) =>
                        setEdit({
                          ...edit,
                          packs: e.target.checked
                            ? [...edit.packs, k]
                            : edit.packs.filter((p) => p !== k),
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </div>
          )
        }
      >
        <p>
          {removing.length
            ? `Switching off ${removing.map((p) => SECTOR_PACKS[p] ?? words(p)).join(', ')} stops new templates from that pack being adopted. Requirements already adopted stay in place.`
            : 'Switching a pack on lets you adopt its templates from the requirement library. Dental and care home content must be validated by a specialist before adoption.'}
        </p>
      </ActionDialog>
    </Section>
  );
}

function OrgPanel() {
  const { api, orgId } = useApp();
  const [archiving, setArchiving] = useState<Row | null>(null);
  const loc = useList(`/api/v1/organisations/${orgId}/locations`);
  return (
    <div className="wf-stack">
      <LocationsV36 onArchive={setArchiving} />
      <StatementOfPurpose />
      <ActionDialog
        open={archiving !== null}
        title={`${archiving?.archived ? 'Restore' : 'Archive'} ${archiving?.name ?? ''}`}
        confirmLabel={archiving?.archived ? 'Restore location' : 'Archive location'}
        danger={!archiving?.archived}
        reasonLabel={archiving?.archived ? undefined : 'Why is it being archived?'}
        onCancel={() => setArchiving(null)}
        onConfirm={async (reason) => {
          await api.send(
            'PATCH',
            `/api/v1/organisations/${orgId}/locations/${archiving!.id}`,
            orgId,
            archiving!.archived ? { archived: false } : { archived: true, archiveReason: reason },
            archiving!.version,
          );
          await loc.refetch();
        }}
      >
        <p>
          {archiving?.archived
            ? 'The location becomes available again for staff, vehicles and jobs.'
            : 'The location is hidden from new records. Its history stays on record.'}
        </p>
      </ActionDialog>
    </div>
  );
}

/** Services the organisation provides (shown with the organisation's details). */
function ServicesCard() {
  const { orgId } = useApp();
  const svc = useList(`/api/v1/organisations/${orgId}/services`);
  return (
    <Section title="Services">
      <DataTable
        caption="Services"
        rows={(svc.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No services yet."
        columns={[
          { key: 'n', header: 'Name', cell: (r: Row) => r.name },
          { key: 'c', header: 'Reference', cell: (r: Row) => r.code },
        ]}
      />
    </Section>
  );
}

// ---- users ----------------------------------------------------------------------------------------
const USER_STATUS: Record<string, { kind: 'GREEN' | 'AMBER' | 'GREY' | 'RED'; text: string }> = {
  ACTIVE: { kind: 'GREEN', text: 'Active' },
  INVITED: { kind: 'AMBER', text: 'Invited – not signed in yet' },
  SUSPENDED: { kind: 'RED', text: 'Suspended' },
  LEAVER: { kind: 'GREY', text: 'Left' },
};
type Change = { u: Row; m: Row; roleId: string; locationId: string };

function UsersPanel() {
  const { api, orgId, me } = useApp();
  const users = useList('/api/v1/admin/users');
  const roles = useList('/api/v1/admin/roles');
  const locs = useList(`/api/v1/organisations/${orgId}/locations`);
  const { run, msg } = useRun();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [revoking, setRevoking] = useState<Row | null>(null);
  const [resettingMfa, setResettingMfa] = useState<Row | null>(null);
  const [mfaResetDone, setMfaResetDone] = useState<string | null>(null);
  // Only local sign-in has an authenticator held by Healthcare Hub (ADR 0006).
  const localSignIn = import.meta.env.VITE_AUTH_MODE === 'local';
  const [changing, setChanging] = useState<Change | null>(null);
  const can = useCan();
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?limit=100', can('staff.profile.view_basic'));
  const linkable = (staff.data?.data ?? []).filter(
    (s) => s.lifecycleState !== 'LEAVER' && !s.userId,
  );
  const invitable = ((roles.data ?? []) as Row[]).filter(
    (r) => !NON_INVITABLE_ROLE_KEYS.includes(r.key),
  );
  const activeLocs = ((locs.data ?? []) as Row[]).filter((l) => !l.archived);
  const locName = new Map(((locs.data ?? []) as Row[]).map((l) => [l.id, l.name]));
  const current = (u: Row) => (u.memberships as Row[]).filter((m) => !m.validTo);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/admin/users', orgId, {
          email,
          displayName,
          roleId,
          locationId: locationId || null,
          ...(staffId ? { staffId } : {}),
        }),
      'Invitation created. They can sign in with this email address.',
    );
    if (ok) {
      setEmail('');
      setDisplayName('');
      setStaffId('');
    }
  };

  const locationSelect = (value: string, onChange: (v: string) => void) => (
    <Field label="Location">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All locations</option>
        {activeLocs.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="space-y-6">
      {msg}
      <DataTable
        caption="Users"
        rows={(users.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No users."
        columns={[
          {
            key: 'n',
            header: 'Person',
            cell: (r: Row) => (
              <Who
                name={r.id === me.user.id ? `${r.displayName} (you)` : r.displayName}
                sub={r.email}
              />
            ),
          },
          {
            key: 'r',
            header: 'Role',
            cell: (r: Row) =>
              current(r).length === 0 ? (
                'No current access'
              ) : (
                <ul className="space-y-1">
                  {current(r).map((m) => (
                    <li key={m.membershipId} className="flex flex-wrap items-center gap-2">
                      {m.roleName}
                      <span className="wf-mut">
                        {m.locationId
                          ? (locName.get(m.locationId) ?? 'One location')
                          : 'All locations'}
                      </span>
                      {r.id !== me.user.id && (
                        <Button
                          type="link"
                          size="small"
                          aria-label={`Change role or location for ${r.displayName}: ${m.roleName}`}
                          onClick={() =>
                            setChanging({
                              u: r,
                              m,
                              roleId: m.roleId,
                              locationId: m.locationId ?? '',
                            })
                          }
                        >
                          Change
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ),
          },
          {
            key: 's',
            header: 'Sign-in',
            cell: (r: Row) => {
              if (r.status !== 'ACTIVE') {
                const k = USER_STATUS[r.status]?.kind ?? 'GREY';
                const tone = k === 'RED' ? 'red' : k === 'AMBER' ? 'amber' : 'grey';
                return (
                  <WfTag tone={tone} icon={tone === 'red' ? 'block' : 'schedule'}>
                    {USER_STATUS[r.status]?.text ?? words(r.status)}
                  </WfTag>
                );
              }
              const si = r.signIn as
                { mfaRequired: boolean; mfaEnabled: boolean | null } | undefined;
              if (si?.mfaEnabled)
                return (
                  <WfTag tone="green" icon="verified_user">
                    MFA on
                  </WfTag>
                );
              if (si && si.mfaEnabled === null)
                return (
                  <WfTag tone="green" icon="verified_user">
                    Single sign-on
                  </WfTag>
                );
              if (si?.mfaRequired)
                return (
                  <WfTag tone="amber" icon="schedule">
                    MFA required – not set up
                  </WfTag>
                );
              return (
                <WfTag tone="grey" icon="key">
                  Password only
                </WfTag>
              );
            },
          },
          {
            key: 'l',
            header: 'Last signed in',
            cell: (r: Row) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : 'Never'),
          },
          {
            key: 'a',
            header: 'Action',
            cell: (r: Row) =>
              r.id === me.user.id ? (
                'You cannot revoke your own access'
              ) : r.status === 'LEAVER' || r.status === 'SUSPENDED' || !current(r).length ? null : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setRevoking(r)}
                    aria-label={`Revoke access for ${r.displayName}`}
                  >
                    Revoke access
                  </Button>
                  {localSignIn && (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        setMfaResetDone(null);
                        setResettingMfa(r);
                      }}
                      aria-label={`Reset MFA: ${r.displayName}`}
                    >
                      Reset MFA
                    </Button>
                  )}
                </div>
              ),
          },
        ]}
      />
      <ActionDialog
        open={revoking !== null}
        title={`Revoke access for ${revoking?.displayName ?? ''}`}
        confirmLabel="Revoke access"
        danger
        reasonLabel="Reason (recorded in the audit log)"
        onCancel={() => setRevoking(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/admin/users/${revoking!.id}/revoke`, orgId, { reason })
        }
      >
        <p>
          This signs them out of every device and ends all their roles here now. Their history stays
          on record.
        </p>
      </ActionDialog>
      {mfaResetDone && (
        <p role="status" className="rounded border border-sky-700 bg-sky-50 p-2 text-sm">
          <span aria-hidden="true">ℹ </span>
          MFA reset for {mfaResetDone}. They will set up their authenticator app again the next time
          they sign in.
        </p>
      )}
      <ActionDialog
        open={resettingMfa !== null}
        title={`Reset MFA for ${resettingMfa?.displayName ?? ''}`}
        confirmLabel="Reset MFA"
        danger
        reasonLabel="Reason (recorded in the audit log)"
        onCancel={() => setResettingMfa(null)}
        onConfirm={async (reason) => {
          const target = resettingMfa!;
          await api.send('POST', `/api/v1/admin/users/${target.id}/mfa-reset`, orgId, { reason });
          setMfaResetDone(target.displayName as string);
        }}
      >
        <p>
          Use this when they have lost or replaced the phone with their authenticator app. Their
          current authenticator stops working and they are signed out within 15 minutes. At their
          next sign-in they enter their password and set up the app again.
        </p>
        <p>Check that you are speaking to the right person before you continue.</p>
      </ActionDialog>
      <ActionDialog
        open={changing !== null}
        title={`Change role or location for ${changing?.u.displayName ?? ''}`}
        confirmLabel="Save change"
        reasonLabel="Reason (recorded in the audit log)"
        confirmDisabled={
          !changing ||
          (changing.roleId === changing.m.roleId &&
            changing.locationId === (changing.m.locationId ?? ''))
        }
        onCancel={() => setChanging(null)}
        onConfirm={(reason) => {
          const c = changing!;
          return api.send('PATCH', `/api/v1/admin/memberships/${c.m.membershipId}`, orgId, {
            ...(c.roleId !== c.m.roleId ? { roleId: c.roleId } : {}),
            ...(c.locationId !== (c.m.locationId ?? '')
              ? { locationId: c.locationId || null }
              : {}),
            reason,
          });
        }}
        fields={
          changing && (
            <div className="grid gap-3">
              <Field label="Role">
                <select
                  value={changing.roleId}
                  onChange={(e) => setChanging({ ...changing, roleId: e.target.value })}
                >
                  {invitable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              {locationSelect(changing.locationId, (v) =>
                setChanging({ ...changing, locationId: v }),
              )}
            </div>
          )
        }
      >
        <p>
          The current role ends now and the new one starts straight away. The change is kept in
          their access history.
        </p>
      </ActionDialog>
      <Section title="Invite someone">
        <form onSubmit={invite} aria-label="Invite user" className="flex flex-wrap items-end gap-3">
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Full name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Role">
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
              <option value="">Select a role</option>
              {invitable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          {locationSelect(locationId, setLocationId)}
          {linkable.length > 0 && (
            <Field label="Link to staff record (optional)">
              <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
                <option value="">Do not link</option>
                {linkable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName} ({s.staffNo})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button type="primary" htmlType="submit">
            Send invitation
          </Button>
        </form>
        <p className="text-sm">
          Someone who already has access cannot be invited again: use Change next to their role to
          give them a different role or location. Support staff are never invited as users. Grant
          them time-limited access under Support access.
        </p>
      </Section>
      <Section title="Roles">
        <DataTable
          caption="Roles"
          rows={invitable}
          rowKey={(r: Row) => r.id}
          emptyMessage="No roles."
          columns={[
            { key: 'n', header: 'Role', cell: (r: Row) => r.name },
            {
              key: 't',
              header: 'Type',
              cell: (r: Row) => (r.isSystem ? 'Standard (cannot be changed)' : 'Custom'),
            },
            {
              key: 'p',
              header: 'Permissions',
              cell: (r: Row) => (
                <details>
                  <summary>{`${(r.permissions as string[]).length} permissions`}</summary>
                  <ul className="list-disc pl-5 text-sm">
                    {(r.permissions as string[]).map((p) => (
                      <li key={p}>{PERMISSIONS[p as PermissionKey] ?? words(p)}</li>
                    ))}
                  </ul>
                </details>
              ),
            },
          ]}
        />
      </Section>
    </div>
  );
}

// ---- notifications --------------------------------------------------------------------------------
const EVENT_TEXT: Record<string, string> = {
  EXPIRY_WARNING: 'A requirement is due to expire',
  ACTION_OVERDUE: 'An action is overdue',
  INCIDENT_REPORTED: 'An incident is reported',
  BREACH_RECORDED: 'A personal data breach is recorded',
  POLICY_PUBLISHED: 'A policy is published',
  AUDIT_OVERDUE: 'An audit is overdue',
};
type Rule = { event: string; roleKeys: string[]; email: boolean };

function NotificationsPanel() {
  const { api, orgId } = useApp();
  const settings = useOne<{ settings: Row; version: number }>('/api/v1/admin/settings');
  const roles = useList('/api/v1/admin/roles');
  const [draft, setDraft] = useState<{ rules: Rule[]; dueSoonDays: number; email: boolean } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const s = settings.data?.settings;
  if (!s) return <p role="status">Loading…</p>;
  const rules: Rule[] = draft?.rules ?? s.notificationRules ?? [];
  const ruleFor = (event: string) =>
    rules.find((r) => r.event === event) ?? { event, roleKeys: [], email: false };
  const roleList = ((roles.data ?? []) as Row[]).filter(
    (r) => !NON_INVITABLE_ROLE_KEYS.includes(r.key),
  );
  const start = () =>
    draft ?? { rules: [...rules], dueSoonDays: s.dueSoonDays, email: s.emailReminders };
  const setRule = (next: Rule) => {
    const d = start();
    setDraft({ ...d, rules: [...d.rules.filter((r) => r.event !== next.event), next] });
  };
  return (
    <Section title="Notifications">
      <p className="text-sm">
        Record owners are always told. Choose who else is told, and whether by email as well as in
        the app. Notifications never include patient details.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show as due soon (days before)">
          <input
            type="number"
            min={1}
            max={365}

            value={draft?.dueSoonDays ?? s.dueSoonDays}
            onChange={(e) => setDraft({ ...start(), dueSoonDays: Number(e.target.value) })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft?.email ?? s.emailReminders}
            onChange={(e) => setDraft({ ...start(), email: e.target.checked })}
          />
          Send email reminders
        </label>
      </div>
      <DataTable<Row>
        caption="Who is told"
        rows={NOTIFICATION_EVENTS.map((e) => ({ id: e, ...ruleFor(e) }))}
        rowKey={(r) => r.id}
        emptyMessage="No events."
        columns={[
          { key: 'e', header: 'When', cell: (r) => EVENT_TEXT[r.event] ?? words(r.event) },
          {
            key: 'r',
            header: 'Also tell',
            cell: (r) => (
              <fieldset className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <legend className="sr-only">Roles to tell: {EVENT_TEXT[r.event]}</legend>
                {roleList.map((role) => (
                  <label key={role.key} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={r.roleKeys.includes(role.key)}
                      onChange={(e) =>
                        setRule({
                          event: r.event,
                          email: r.email,
                          roleKeys: e.target.checked
                            ? [...r.roleKeys, role.key]
                            : r.roleKeys.filter((k: string) => k !== role.key),
                        })
                      }
                    />
                    {role.name}
                  </label>
                ))}
              </fieldset>
            ),
          },
          {
            key: 'm',
            header: 'By email',
            cell: (r) => (
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={r.email}
                  onChange={(e) =>
                    setRule({ event: r.event, roleKeys: r.roleKeys, email: e.target.checked })
                  }
                />
                <span className="sr-only">Email: {EVENT_TEXT[r.event]}</span>
                Email
              </label>
            ),
          },
        ]}
      />
      <Button
        type="primary"
        disabled={!draft || saving}
        onClick={async () => {
          if (!draft) return;
          setSaving(true);
          try {
            await api.send(
              'PATCH',
              '/api/v1/admin/settings',
              orgId,
              {
                notificationRules: draft.rules.filter((r) => r.roleKeys.length || r.email),
                dueSoonDays: draft.dueSoonDays,
                emailReminders: draft.email,
              },
              settings.data!.version,
            );
            setDraft(null);
            await settings.refetch();
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : 'Save notification settings'}
      </Button>
    </Section>
  );
}

interface Routing {
  warningDays: string;
  itemRules: { kind: ItemKind; recipients: Recipient[] }[];
  escalation: { leadAfterDays: number; managerAfterDays: number };
  deputies: { leadUserId: string; deputyUserId: string; from: string; to: string }[];
  channels: { email: boolean; push: boolean };
  speakUpGuardianUserId: string | null;
}
type Recipient = (typeof RECIPIENTS)[number];

/** A6: warning days, who is told for each kind of item, escalation, deputies and channels. */
function AlertRoutingPanel({ compact = false }: { compact?: boolean } = {}) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const settings = useOne<{ settings: Row; version: number }>('/api/v1/admin/settings');
  const people = usePeople();
  const [draft, setDraft] = useState<Routing | null>(null);
  const s = settings.data?.settings;
  if (!s) return null;
  const current: Routing = draft ?? {
    warningDays: ((s.warningDays as number[]) ?? DEFAULT_WARNING_DAYS).join(', '),
    itemRules: ITEM_KINDS.map(
      (kind) =>
        ((s.itemRules as Routing['itemRules']) ?? []).find((r) => r.kind === kind) ?? {
          kind,
          recipients: ['OWNER', 'LEAD'] as Recipient[],
        },
    ),
    escalation: s.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 },
    deputies: s.deputies ?? [],
    channels: s.channels ?? { email: true, push: true },
    speakUpGuardianUserId: s.speakUpGuardianUserId ?? null,
  };
  const set = (patch: Partial<Routing>) => setDraft({ ...current, ...patch });
  const days = current.warningDays
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d > 0);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.displayName ?? 'Former member';
  const save = () =>
    void run(async () => {
      await api.send(
        'PATCH',
        '/api/v1/admin/settings',
        orgId,
        {
          warningDays: [...new Set(days)].sort((a, b) => b - a),
          itemRules: current.itemRules,
          escalation: current.escalation,
          deputies: current.deputies,
          channels: current.channels,
          speakUpGuardianUserId: current.speakUpGuardianUserId,
        },
        settings.data!.version,
      );
      setDraft(null);
      await settings.refetch();
    }, 'Alert settings saved.');
  return (
    <Section title="Warnings, escalation and deputies">
      {msg}
      <Field label="Warn this many days before a date (product defaults, not CQC rules)">
        <input value={current.warningDays} onChange={(e) => set({ warningDays: e.target.value })} />
      </Field>
      {!compact && (
        <DataTable<Routing['itemRules'][number]>
          caption="Who is told for each kind of item"
          rows={current.itemRules}
          rowKey={(r) => r.kind}
          emptyMessage="No kinds of item."
          columns={[
            { key: 'k', header: 'Item', cell: (r) => ITEM_KIND_LABELS[r.kind] },
            {
              key: 'r',
              header: 'Tell',
              cell: (r) => (
                <fieldset className="flex flex-wrap gap-x-3 text-sm">
                  <legend className="sr-only">Who is told: {ITEM_KIND_LABELS[r.kind]}</legend>
                  {RECIPIENTS.map((who) => (
                    <label key={who} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={r.recipients.includes(who)}
                        onChange={(e) => {
                          const recipients = e.target.checked
                            ? [...r.recipients, who]
                            : r.recipients.filter((x) => x !== who);
                          if (recipients.length === 0) return;
                          set({
                            itemRules: current.itemRules.map((x) =>
                              x.kind === r.kind ? { ...x, recipients } : x,
                            ),
                          });
                        }}
                      />
                      {RECIPIENT_LABELS[who]}
                    </label>
                  ))}
                </fieldset>
              ),
            },
          ]}
        />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Overdue days before the lead is told">
          <input
            type="number"
            min={0}
            max={90}

            value={current.escalation.leadAfterDays}
            onChange={(e) =>
              set({
                escalation: { ...current.escalation, leadAfterDays: Number(e.target.value) },
              })
            }
          />
        </Field>
        <Field label="Overdue days before the registered manager is told">
          <input
            type="number"
            min={1}
            max={180}

            value={current.escalation.managerAfterDays}
            onChange={(e) =>
              set({
                escalation: { ...current.escalation, managerAfterDays: Number(e.target.value) },
              })
            }
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={current.channels.email}
            onChange={(e) => set({ channels: { ...current.channels, email: e.target.checked } })}
          />
          Email as well as in the app
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={current.channels.push}
            onChange={(e) => set({ channels: { ...current.channels, push: e.target.checked } })}
          />
          Mobile push for crew (never with patient details)
        </label>
      </div>
      <Field label="Freedom to Speak Up guardian">
        <select
          value={current.speakUpGuardianUserId ?? ''}
          onChange={(e) => set({ speakUpGuardianUserId: e.target.value || null })}
        >
          <option value="">Not named</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </Field>
      {!compact && (
        <>
          <DataTable<Routing['deputies'][number] & { i: number }>
            caption="Deputies (cover for a lead between two dates)"
            rows={current.deputies.map((d, i) => ({ ...d, i }))}
            rowKey={(d) => String(d.i)}
            emptyMessage="No deputies are set."
            columns={[
              { key: 'l', header: 'Lead', cell: (d) => nameOf(d.leadUserId) },
              { key: 'd', header: 'Deputy', cell: (d) => nameOf(d.deputyUserId) },
              {
                key: 'w',
                header: 'Covers',
                cell: (d) => `${fmtDate(d.from)} to ${fmtDate(d.to)}`,
              },
              {
                key: 'x',
                header: 'Actions',
                cell: (d) => (
                  <Button
                    type="link"
                    size="small"
                    aria-label={`Remove ${nameOf(d.deputyUserId)} as deputy for ${nameOf(
                      d.leadUserId,
                    )}`}
                    onClick={() => set({ deputies: current.deputies.filter((_, i) => i !== d.i) })}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
          <form
            aria-label="Add a deputy"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const d = {
                leadUserId: String(f.get('lead')),
                deputyUserId: String(f.get('deputy')),
                from: String(f.get('from')),
                to: String(f.get('to')),
              };
              if (d.leadUserId === d.deputyUserId || d.to < d.from) return;
              set({ deputies: [...current.deputies, d] });
              e.currentTarget.reset();
            }}
          >
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
              <input name="from" type="date" required />
            </Field>
            <Field label="To">
              <input name="to" type="date" required />
            </Field>
            <Button type="primary" htmlType="submit">
              Add deputy
            </Button>
          </form>
        </>
      )}
      <Button type="primary" disabled={!draft || days.length === 0} onClick={save}>
        Save alert settings
      </Button>
    </Section>
  );
}

// ---- support access -------------------------------------------------------------------------------
function SupportPanel() {
  const { api, orgId } = useApp();
  const grants = useList('/api/v1/admin/support-access-grants');
  const { run, msg } = useRun();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(2);
  const [ending, setEnding] = useState<Row | null>(null);
  const [granting, setGranting] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.send('POST', '/api/v1/admin/support-access-grants', orgId, {
          supportUserEmail: email,
          reason,
          hours,
        }),
      'Support access granted. Every action they take is recorded in the audit log.',
    ).then((ok) => {
      if (ok) setGranting(false);
    });
  };
  return (
    <Section
      title="Support access"
      actions={
        <Button type="primary" size="small" onClick={() => setGranting(true)}>
          <Ms i="support_agent" /> Grant access
        </Button>
      }
    >
      {msg}
      <p className="wf-mini" style={{ margin: 0 }}>
        Support staff have no access unless you grant it here. Access is read-only, time-limited
        (maximum 8 hours) and fully audited. While it is active every page shows a banner, and you
        can end it early at any time.
      </p>
      <DataTable
        caption="Support access grants"
        rows={(grants.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No support access has been granted."
        columns={[
          {
            key: 'u',
            header: 'Who',
            cell: (r: Row) =>
              `${r.supportUserName ?? 'Platform support'}, granted by ${
                r.approvedByName ?? 'a former member'
              }`,
          },
          { key: 'r', header: 'Reason', cell: (r: Row) => r.reason },
          { key: 's', header: 'From', cell: (r: Row) => fmtDateTime(r.startsAt) },
          {
            key: 'e',
            header: 'Until',
            cell: (r: Row) =>
              r.endedEarlyAt
                ? `Ended early ${fmtDateTime(r.endedEarlyAt)}: ${r.endedEarlyReason ?? ''}`
                : fmtDateTime(r.endsAt),
          },
          {
            key: 'a',
            header: 'State',
            cell: (r: Row) => (
              <StatusBadge
                status={r.active ? 'AMBER' : 'GREY'}
                reason={r.active ? 'Active' : r.endedEarlyAt ? 'Ended early' : 'Ended'}
              />
            ),
          },
          {
            key: 'x',
            header: 'Actions',
            cell: (r: Row) =>
              r.active ? (
                <Button
                  type="link"
                  size="small"
                  aria-label={`End support access early: ${r.reason}`}
                  onClick={() => setEnding(r)}
                >
                  End access now
                </Button>
              ) : (
                ''
              ),
          },
        ]}
      />
      <ActionDialog
        open={!!ending}
        title="End support access now"
        confirmLabel="End access"
        reasonLabel="Why are you ending it early?"
        danger
        successText="Support access ended. The support user can no longer see this organisation."
        onCancel={() => setEnding(null)}
        onConfirm={async (why) => {
          await api.send('POST', `/api/v1/admin/support-access-grants/${ending?.id}/end`, orgId, {
            reason: why,
          });
          await grants.refetch();
        }}
      >
        <p>{ending?.reason}</p>
      </ActionDialog>
      <Modal
        open={granting}
        title="Grant support access"
        onCancel={() => setGranting(false)}
        footer={null}
        className="hh-modal"
        destroyOnHidden
      >
        <form onSubmit={submit} aria-label="Grant support access" className="hh-form">
          <div className="hh-grid">
            <Field label="Support user email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Reason">
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                minLength={10}
                maxLength={500}
              />
            </Field>
            <Field label="Hours (1–8)">
              <input
                type="number"
                min={1}
                max={8}
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                required
              />
            </Field>
          </div>
          <div className="hh-actions">
            <Button type="primary" htmlType="submit">
              Grant access
            </Button>
          </div>
        </form>
      </Modal>
    </Section>
  );
}

// ---- audit log ------------------------------------------------------------------------------------
const AREA: Record<string, string> = {
  admin: 'Administration',
  org: 'Organisation',
  compliance: 'Compliance',
  events: 'Events',
  privacy: 'Data protection',
  staff: 'Staff',
  fleet: 'Fleet',
  jobs: 'Jobs',
  requirements: 'Requirements',
  evidence: 'Evidence',
  data: 'Import and export',
  crew: 'Crew',
  reports: 'Reports',
};
const VERB: Record<string, string> = {
  create: 'created',
  update: 'changed',
  approve: 'approved',
  verify: 'verified',
  revoke: 'revoked',
  invite: 'invited',
  add: 'added',
  change: 'changed',
  record: 'recorded',
  close: 'closed',
  publish: 'published',
  release: 'released',
  place: 'placed',
  decide: 'decided',
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  export: 'exported',
  evidence: 'evidence submitted',
  propose: 'proposed',
};
/** "compliance.action.verify" → "Compliance: action verified". */
export function auditActionText(action: string): string {
  const [area = '', ...rest] = action.split('.');
  const verb = rest.pop() ?? '';
  const what = rest.map((w) => w.replace(/_/g, ' ')).join(' ');
  return `${AREA[area] ?? words(area)}: ${[what, VERB[verb] ?? verb.replace(/_/g, ' ')]
    .filter(Boolean)
    .join(' ')}`;
}

export function AuditPanel() {
  const { api, me, orgId } = useApp();
  const { run, msg } = useRun();
  const [area, setArea] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recordId, setRecordId] = useState('');
  const people = usePeople();
  const filter = new URLSearchParams();
  if (area) filter.set('action', `${area}.`);
  if (actor) filter.set('actorId', actor);
  if (from) filter.set('from', new Date(`${from}T00:00:00`).toISOString());
  if (to) filter.set('to', new Date(`${to}T23:59:59`).toISOString());
  if (recordId.trim()) filter.set('entityId', recordId.trim());
  const log = useOne<{ data: Row[]; nextCursor: string | null }>(
    `/api/v1/audit-log?limit=100${filter.toString() ? `&${filter.toString()}` : ''}`,
  );
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const verify = async () => {
    try {
      const r = (await api.send('POST', '/api/v1/audit-log/verify-chain', orgId, {})) as Row;
      setResult(
        r.intact
          ? { ok: true, text: 'Audit trail intact: no entry has been changed or removed.' }
          : { ok: false, text: `Audit trail broken at entry ${String(r.brokenSeq)}.` },
      );
    } catch {
      setResult({ ok: false, text: 'The check could not be run. Try again.' });
    }
  };
  const rows = log.data?.data ?? [];
  const who = (r: Row) => {
    const name =
      r.actorType === 'SYSTEM'
        ? 'The system'
        : r.actorType === 'SUPPORT'
          ? `Support: ${r.actorName ?? 'support user'}`
          : r.actorUserId === me.user.id
            ? `${r.actorName ?? 'You'} (you)`
            : (r.actorName ?? 'Former member');
    return r.actorRole ? `${name}, ${r.actorRole}` : name;
  };
  const exportCsv = () =>
    void run(async () => {
      saveBlob(
        await api.download!(`/api/v1/audit-log/export?${filter.toString()}`, orgId),
        `audit-log${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.csv`,
      );
    }, 'Audit log exported. The export itself is recorded in the audit log.');
  return (
    <div className="space-y-3">
      {msg}
      {me.permissions.includes('admin.audit.verify') && (
        <div className="space-y-1">
          <Button type="primary" onClick={() => void verify()}>
            Check the audit trail
          </Button>
          {result && (
            <p role="status">
              <StatusBadge status={result.ok ? 'GREEN' : 'RED'} reason={result.text} />
            </p>
          )}
        </div>
      )}
      <form
        aria-label="Filter the audit log"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field label="Area">
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All areas</option>
            {Object.entries(AREA).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Who">
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input
            type="date"

            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Record reference (optional)">
          <input value={recordId} maxLength={100} onChange={(e) => setRecordId(e.target.value)} />
        </Field>
        <Button type="link" size="small" onClick={exportCsv}>
          Export to CSV
        </Button>
      </form>
      <DataTable
        caption="Audit log (most recent 100 matching, UK time)"
        rows={rows}
        rowKey={(r: Row) => r.id}
        loading={log.isLoading}
        error={log.isError ? 'Could not load the audit log.' : null}
        emptyMessage="No audit entries."
        columns={[
          { key: 'w', header: 'When', cell: (r: Row) => fmtDateTime(r.occurredAt) },
          { key: 't', header: 'Who', cell: who },
          { key: 'a', header: 'What happened', cell: (r: Row) => auditActionText(r.action) },
          { key: 'e', header: 'Record', cell: (r: Row) => words(r.entity) },
          { key: 'r', header: 'Reason given', cell: (r: Row) => r.reason ?? '' },
        ]}
      />
    </div>
  );
}
