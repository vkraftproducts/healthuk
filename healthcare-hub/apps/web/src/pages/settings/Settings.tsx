import { DataTable } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { useApp } from '../../shell/AppContext.js';
import { DataPanel } from './DataPanel.js';
import { PrivacyPanel } from './PrivacyPanel.js';
import { useInvalidate, useList } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TABS = [
  { id: 'org', label: 'Organisation and locations', perm: null },
  { id: 'users', label: 'Users and roles', perm: 'admin.users.manage' },
  { id: 'support', label: 'Support access', perm: 'admin.support.approve' },
  { id: 'audit', label: 'Audit log', perm: 'admin.audit.view' },
  {
    id: 'data',
    label: 'Import and export',
    perm: ['admin.import.manage', 'admin.requirements.publish', 'admin.export.full'],
  },
  { id: 'privacy', label: 'Data protection', perm: 'privacy.manage' },
] as const;

export function Settings() {
  const { me, orgId } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('org');
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  const tabs = TABS.filter(
    (t) =>
      !t.perm ||
      (Array.isArray(t.perm)
        ? t.perm.some((p: string) => me.permissions.includes(p))
        : me.permissions.includes(t.perm as string)),
  );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex flex-wrap gap-1 rounded-lg border border-hub-line bg-white p-1.5"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="settings-panel"
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab === t.id ? 'bg-hub-teal text-white' : 'text-hub-navy hover:bg-hub-row'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="settings-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'org' && <OrgPanel />}
        {tab === 'users' && <UsersPanel />}
        {tab === 'support' && <SupportPanel />}
        {tab === 'audit' && <AuditPanel />}
        {tab === 'data' && <DataPanel />}
        {tab === 'privacy' && <PrivacyPanel />}
      </div>
    </div>
  );
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'STALE_VERSION')
      return 'Someone else changed this record. Refresh and try again.';
    if (e.status === 403) return 'You do not have permission to do that.';
    return `The server rejected the request (${e.code}).`;
  }
  return 'Could not reach the server.';
}

function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const invalidate = useInvalidate();
  async function run(fn: () => Promise<unknown>, ok: string) {
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(ok);
      await invalidate();
    } catch (e) {
      setError(errText(e));
    }
  }
  const msg = (
    <>
      {error && (
        <p role="alert" className="text-red-900">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
    </>
  );
  return { run, msg };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
const input = 'rounded-md border border-slate-500 bg-white px-2.5 py-1.5';

function OrgPanel() {
  const { api, me, orgId } = useApp();
  const canEdit = me.permissions.includes('admin.org.manage');
  const loc = useList(`/api/v1/organisations/${orgId}/locations`);
  const svc = useList(`/api/v1/organisations/${orgId}/services`);
  const act = useList(`/api/v1/organisations/${orgId}/registered-activities`);
  const { run, msg } = useAction();
  const [name, setName] = useState('');
  const [registered, setRegistered] = useState(true);

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.send('POST', `/api/v1/organisations/${orgId}/locations`, orgId, { name, registered }),
      'Location added.',
    ).then(() => setName(''));
  };
  const archive = (r: Row) =>
    run(
      () =>
        api.send(
          'PATCH',
          `/api/v1/organisations/${orgId}/locations/${r.id}`,
          orgId,
          { archived: !r.archived },
          r.version,
        ),
      r.archived ? 'Location restored.' : 'Location archived.',
    );

  return (
    <div className="space-y-6">
      {msg}
      <section aria-labelledby="loc-h" className="space-y-2">
        <h2 id="loc-h" className="text-lg font-bold">
          Locations
        </h2>
        {loc.isError ? (
          <p role="alert">Source unavailable. Locations could not be loaded.</p>
        ) : (
          <DataTable
            caption="Locations"
            rows={(loc.data ?? []) as Row[]}
            rowKey={(r: Row) => r.id}
            emptyMessage="No locations yet."
            columns={[
              { key: 'name', header: 'Name', cell: (r: Row) => r.name },
              {
                key: 'reg',
                header: 'CQC registered',
                cell: (r: Row) => (r.registered ? 'Yes' : 'No'),
              },
              {
                key: 'state',
                header: 'State',
                cell: (r: Row) => (r.archived ? 'Archived' : 'Active'),
              },
              ...(canEdit
                ? [
                    {
                      key: 'a',
                      header: 'Action',
                      cell: (r: Row) => (
                        <button
                          className="underline"
                          onClick={() => void archive(r)}
                          aria-label={`${r.archived ? 'Restore' : 'Archive'} ${r.name}`}
                        >
                          {r.archived ? 'Restore' : 'Archive'}
                        </button>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {canEdit && (
          <form onSubmit={add} className="flex flex-wrap items-end gap-3" aria-label="Add location">
            <Field label="Location name">
              <input
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={registered}
                onChange={(e) => setRegistered(e.target.checked)}
              />{' '}
              Registered with CQC
            </label>
            <button
              className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white hover:bg-hub-teal-dark"
              type="submit"
            >
              Add location
            </button>
          </form>
        )}
      </section>
      <section aria-labelledby="svc-h" className="space-y-2">
        <h2 id="svc-h" className="text-lg font-bold">
          Services
        </h2>
        <DataTable
          caption="Services"
          rows={(svc.data ?? []) as Row[]}
          rowKey={(r: Row) => r.id}
          emptyMessage="No services yet."
          columns={[
            { key: 'c', header: 'Code', cell: (r: Row) => r.code },
            { key: 'n', header: 'Name', cell: (r: Row) => r.name },
          ]}
        />
      </section>
      <section aria-labelledby="act-h" className="space-y-2">
        <h2 id="act-h" className="text-lg font-bold">
          Registered activities
        </h2>
        <DataTable
          caption="Registered activities"
          rows={(act.data ?? []) as Row[]}
          rowKey={(r: Row) => r.id}
          emptyMessage="No registered activities yet."
          columns={[
            { key: 'c', header: 'Code', cell: (r: Row) => r.code },
            { key: 'n', header: 'Name', cell: (r: Row) => r.name },
          ]}
        />
      </section>
    </div>
  );
}

function UsersPanel() {
  const { api, orgId } = useApp();
  const users = useList('/api/v1/admin/users');
  const roles = useList('/api/v1/admin/roles');
  const { run, msg } = useAction();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [revoking, setRevoking] = useState<Row | null>(null);
  const [reason, setReason] = useState('');

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(
      () =>
        api.send('POST', '/api/v1/admin/users', orgId, {
          email,
          displayName,
          roleId,
          locationId: null,
        }),
      'Invitation created. They can sign in with this email address.',
    ).then(() => {
      setEmail('');
      setDisplayName('');
    });
  };
  const revoke = (e: FormEvent) => {
    e.preventDefault();
    if (!revoking) return;
    void run(
      () => api.send('POST', `/api/v1/admin/users/${revoking.id}/revoke`, orgId, { reason }),
      'Access revoked. Their next request is refused.',
    ).then(() => {
      setRevoking(null);
      setReason('');
    });
  };

  return (
    <div className="space-y-6">
      {msg}
      <DataTable
        caption="Users"
        rows={(users.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No users."
        columns={[
          { key: 'n', header: 'Name', cell: (r: Row) => r.displayName },
          { key: 'e', header: 'Email', cell: (r: Row) => r.email },
          {
            key: 'r',
            header: 'Role',
            cell: (r: Row) =>
              (r.memberships as Row[])
                .filter((m) => !m.validTo)
                .map((m) => m.roleName)
                .join(', ') || '—',
          },
          { key: 's', header: 'Status', cell: (r: Row) => r.status },
          {
            key: 'a',
            header: 'Action',
            cell: (r: Row) =>
              r.status === 'LEAVER' || r.status === 'SUSPENDED' ? null : (
                <button
                  className="underline"
                  onClick={() => setRevoking(r)}
                  aria-label={`Revoke access for ${r.displayName}`}
                >
                  Revoke access
                </button>
              ),
          },
        ]}
      />
      {revoking && (
        <form
          onSubmit={revoke}
          aria-label="Revoke access"
          className="space-y-2 rounded border border-red-700 p-3"
        >
          <p>
            Revoking access for <strong>{revoking.displayName}</strong> signs them out of every
            device. Their history stays on record.
          </p>
          <Field label="Reason (recorded in the audit log)">
            <input
              className={input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={5}
              maxLength={500}
            />
          </Field>
          <button className="rounded bg-red-800 px-3 py-1 text-white" type="submit">
            Confirm revoke
          </button>{' '}
          <button type="button" className="underline" onClick={() => setRevoking(null)}>
            Cancel
          </button>
        </form>
      )}
      <form onSubmit={invite} aria-label="Invite user" className="flex flex-wrap items-end gap-3">
        <Field label="Email">
          <input
            className={input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Full name">
          <input
            className={input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            maxLength={120}
          />
        </Field>
        <Field label="Role">
          <select
            className={input}
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            required
          >
            <option value="">Select a role</option>
            {((roles.data ?? []) as Row[]).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white hover:bg-hub-teal-dark"
          type="submit"
        >
          Send invitation
        </button>
      </form>
      <section aria-labelledby="roles-h" className="space-y-2">
        <h2 id="roles-h" className="text-lg font-bold">
          Roles
        </h2>
        <DataTable
          caption="Roles"
          rows={(roles.data ?? []) as Row[]}
          rowKey={(r: Row) => r.id}
          emptyMessage="No roles."
          columns={[
            { key: 'n', header: 'Role', cell: (r: Row) => r.name },
            {
              key: 't',
              header: 'Type',
              cell: (r: Row) => (r.isSystem ? 'System (read-only)' : 'Custom'),
            },
            {
              key: 'p',
              header: 'Permissions',
              cell: (r: Row) => (r.permissions as string[]).length,
            },
          ]}
        />
      </section>
    </div>
  );
}

function SupportPanel() {
  const { api, orgId } = useApp();
  const grants = useList('/api/v1/admin/support-access-grants');
  const { run, msg } = useAction();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(2);
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
    );
  };
  return (
    <div className="space-y-4">
      {msg}
      <p>
        Support staff have no access unless you grant it here. Access is read-only, time-limited
        (maximum 8 hours) and fully audited.
      </p>
      <DataTable
        caption="Support access grants"
        rows={(grants.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No support access has been granted."
        columns={[
          { key: 'r', header: 'Reason', cell: (r: Row) => r.reason },
          {
            key: 's',
            header: 'Starts',
            cell: (r: Row) =>
              new Date(r.startsAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          {
            key: 'e',
            header: 'Ends',
            cell: (r: Row) =>
              new Date(r.endsAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          { key: 'a', header: 'State', cell: (r: Row) => (r.active ? 'Active' : 'Expired') },
        ]}
      />
      <form
        onSubmit={submit}
        aria-label="Grant support access"
        className="flex flex-wrap items-end gap-3"
      >
        <Field label="Support user email">
          <input
            className={input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Reason">
          <input
            className={input}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={10}
            maxLength={500}
          />
        </Field>
        <Field label="Hours (1–8)">
          <input
            className={input}
            type="number"
            min={1}
            max={8}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            required
          />
        </Field>
        <button
          className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white hover:bg-hub-teal-dark"
          type="submit"
        >
          Grant access
        </button>
      </form>
    </div>
  );
}

function AuditPanel() {
  const { api, me, orgId } = useApp();
  const log = useList('/api/v1/audit-log?limit=50');
  const [result, setResult] = useState<string | null>(null);
  const verify = async () => {
    try {
      const r = (await api.send('POST', '/api/v1/audit-log/verify-chain', orgId, {})) as Row;
      setResult(
        r.intact ? 'Audit chain intact.' : `Audit chain broken at entry ${String(r.brokenSeq)}.`,
      );
    } catch (e) {
      setResult(errText(e));
    }
  };
  return (
    <div className="space-y-3">
      {me.permissions.includes('admin.audit.verify') && (
        <div>
          <button
            className="rounded-md bg-hub-teal px-3 py-1.5 text-sm font-semibold text-white hover:bg-hub-teal-dark"
            onClick={() => void verify()}
          >
            Verify audit chain
          </button>
          {result && <p role="status">{result}</p>}
        </div>
      )}
      <DataTable
        caption="Audit log"
        rows={(log.data ?? []) as Row[]}
        rowKey={(r: Row) => r.id}
        emptyMessage="No audit entries."
        columns={[
          {
            key: 'w',
            header: 'When',
            cell: (r: Row) =>
              new Date(r.occurredAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          { key: 'a', header: 'Action', cell: (r: Row) => r.action },
          { key: 't', header: 'Actor', cell: (r: Row) => r.actorType },
          { key: 'e', header: 'Entity', cell: (r: Row) => r.entity },
        ]}
      />
    </div>
  );
}
