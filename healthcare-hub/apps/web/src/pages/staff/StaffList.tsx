import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne } from '../settings/hooks.js';
import { LIFECYCLE_LABEL, RESTRICTION_LABEL, ROLE_LABEL, list } from './labels.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DISPATCH_NOTE = 'Dispatcher view shows approved roles and restrictions only.';

function summary(r: Row): string {
  const c = r.counts as { red: number; amber: number; grey: number; green: number } | undefined;
  if (!c) return '';
  const parts = [
    c.red && `${c.red} overdue or expired`,
    c.amber && `${c.amber} due soon`,
    c.grey && `${c.grey} missing or unverified`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : c.green ? 'all verified' : 'nothing required';
}

export function StaffList() {
  const { me, orgId } = useApp();
  const [q, setQ] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [role, setRole] = useState('');
  const params = new URLSearchParams({ limit: '100' });
  if (q.trim()) params.set('q', q.trim());
  if (lifecycle) params.set('lifecycle', lifecycle);
  if (role) params.set('role', role);
  const can = (p: string) => me.permissions.includes(p);
  const allowed = can('staff.profile.view_basic') || can('staff.profile.view_clearance');
  const res = useOne<{ data: Row[] }>(`/api/v1/staff?${params.toString()}`, allowed);
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  if (!allowed)
    return (
      <p role="alert" className="rounded-lg border border-hub-line bg-white p-3">
        You do not have access to the staff register.
      </p>
    );
  const basic = can('staff.profile.view_basic');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Staff</h1>
      {!basic && (
        <p role="note" className="rounded border border-sky-700 bg-sky-50 p-3 text-sky-950">
          {DISPATCH_NOTE}
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter staff"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex flex-col text-sm">
          Search name or staff number
          <input
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex flex-col text-sm">
          Lifecycle
          <select
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
          >
            <option value="">Current staff</option>
            {Object.entries(LIFECYCLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Approved role
          <select
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">Any role</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </form>
      <DataTable<Row>
        caption="Staff register"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load staff.' : null}
        emptyMessage="No staff match these filters."
        columns={[
          { key: 'no', header: 'Staff no', cell: (r) => r.staffNo },
          {
            key: 'name',
            header: 'Name',
            cell: (r) => (
              <Link
                to="/staff/$id"
                params={{ id: r.id }}
                className="font-medium text-hub-teal-dark underline"
              >
                {r.displayName}
              </Link>
            ),
          },
          { key: 'roles', header: 'Approved roles', cell: (r) => list(r.roles, ROLE_LABEL) },
          {
            key: 'state',
            header: 'Lifecycle',
            cell: (r) => LIFECYCLE_LABEL[r.lifecycleState] ?? r.lifecycleState,
          },
          {
            key: 'restr',
            header: 'Restrictions',
            cell: (r) => list(r.activeRestrictions, RESTRICTION_LABEL),
          },
          ...(basic
            ? [
                {
                  key: 'status',
                  header: 'Compliance',
                  cell: (r: Row) => (
                    <StatusBadge status={r.overallStatus as StatusKind} reason={summary(r)} />
                  ),
                },
              ]
            : []),
        ]}
      />
      {can('staff.profile.manage') && <AddStaff />}
    </div>
  );
}

function AddStaff() {
  const { api, orgId } = useApp();
  const invalidate = useInvalidate();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMsg(null);
    try {
      await api.send('POST', '/api/v1/staff', orgId, {
        staffNo: String(f.get('staffNo')).trim().toUpperCase(),
        displayName: String(f.get('displayName')).trim(),
        primaryLocationId: String(f.get('location')),
        ...(f.get('jobTitle') ? { jobTitle: String(f.get('jobTitle')) } : {}),
      });
      setMsg('Staff record created as a candidate.');
      e.currentTarget?.reset();
      await invalidate();
    } catch (err) {
      setMsg(
        err instanceof ApiError && err.code === 'CONFLICT'
          ? 'That staff number is already in use.'
          : err instanceof ApiError && err.status === 400
            ? 'Check the details: the staff number looks like ST-0042.'
            : 'Could not create the record.',
      );
    }
  }
  return (
    <section aria-labelledby="add-staff" className="rounded-lg border border-hub-line bg-white p-4">
      <h2 id="add-staff" className="mb-2 text-lg font-bold">
        Add a staff member
      </h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          Staff number
          <input
            name="staffNo"
            required
            placeholder="ST-0000"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Name
          <input
            name="displayName"
            required
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Job title
          <input
            name="jobTitle"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Base location
          <select
            name="location"
            required
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          >
            {(locations.data?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-md bg-hub-teal px-4 py-2 text-sm font-semibold text-white hover:bg-hub-teal-dark">
          Add
        </button>
      </form>
      {msg && (
        <p role="status" className="mt-2 text-sm">
          {msg}
        </p>
      )}
    </section>
  );
}
