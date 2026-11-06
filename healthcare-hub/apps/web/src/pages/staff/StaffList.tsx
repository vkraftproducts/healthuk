import type { MeResponse } from '@hub/contracts';
import { staffRolesFor } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne } from '../settings/hooks.js';
import { CONTRACT_LABEL, LIFECYCLE_LABEL, RESTRICTION_LABEL, ROLE_LABEL, list } from './labels.js';
import { TrainingMatrix } from './TrainingMatrix.js';
import { GroupTraining, SupervisionBookings } from './TrainingSupervision.js';
import { StaffRequestsQueue } from '../me/MyRecord.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DISPATCH_NOTE = 'Dispatcher view shows approved roles and restrictions only.';

/** Roles that make sense for this organisation's sector (a dental practice has no paramedics). */
function sectorRoles(me: MeResponse, orgId: string | null): [string, string][] {
  const packs = me.memberships.find((m) => m.organisationId === orgId)?.sectorPacks;
  const offered = staffRolesFor(packs);
  return Object.entries(ROLE_LABEL).filter(([k]) => offered.includes(k));
}

function summary(r: Row): string {
  const c = r.counts as { red: number; amber: number; grey: number; green: number } | undefined;
  if (!c) return '';
  if (r.checksSetUp === false) return 'not set up: no checks apply yet';
  const parts = [
    c.red && `${c.red} overdue or expired`,
    c.amber && `${c.amber} due soon`,
    c.grey && `${c.grey} missing or unverified`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'all verified';
}

export function StaffList() {
  const { me, orgId } = useApp();
  const [q, setQ] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [role, setRole] = useState('');
  const [view, setView] = useState<'register' | 'matrix' | 'group' | 'supervision'>('register');
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
      {basic && (
        <div
          role="tablist"
          aria-label="Staff views"
          className="flex flex-wrap gap-1 rounded-lg border border-hub-line bg-white p-1.5"
        >
          {(
            [
              ['register', 'Register', true],
              ['matrix', 'Training matrix', true],
              ['group', 'Group training', can('staff.profile.manage')],
              ['supervision', 'Supervision bookings', true],
            ] as const
          )
            .filter(([, , show]) => show)
            .map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${view === id ? 'bg-hub-teal text-white' : 'text-hub-navy hover:bg-hub-row'}`}
              >
                {label}
              </button>
            ))}
        </div>
      )}
      {basic && view === 'matrix' ? (
        <TrainingMatrix />
      ) : basic && view === 'group' && can('staff.profile.manage') ? (
        <GroupTraining />
      ) : basic && view === 'supervision' ? (
        <SupervisionBookings />
      ) : (
        <StaffRegister
          basic={basic}
          q={q}
          setQ={setQ}
          lifecycle={lifecycle}
          setLifecycle={setLifecycle}
          role={role}
          setRole={setRole}
          res={res}
        />
      )}
    </div>
  );
}

function StaffRegister({
  basic,
  q,
  setQ,
  lifecycle,
  setLifecycle,
  role,
  setRole,
  res,
}: {
  basic: boolean;
  q: string;
  setQ: (v: string) => void;
  lifecycle: string;
  setLifecycle: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
  res: { data?: { data: Row[] }; isLoading: boolean; isError: boolean };
}) {
  const { me, orgId } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  return (
    <div className="space-y-4">
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
            {sectorRoles(me, orgId).map(([k, v]) => (
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
          {
            key: 'roles',
            header: 'Approved roles',
            cell: (r) => (r.roles.length ? list(r.roles, ROLE_LABEL) : 'No approved role yet'),
          },
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
      <StaffRequestsQueue />
      {can('staff.profile.manage') && <AddStaff />}
    </div>
  );
}

function AddStaff() {
  const { api, orgId, me } = useApp();
  const invalidate = useInvalidate();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const managers = useOne<{ data: Row[] }>(orgId ? '/api/v1/staff?limit=100' : null);
  const [msg, setMsg] = useState<string | null>(null);
  const roles = sectorRoles(me, orgId);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const opt = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v ? v : undefined;
    };
    setMsg(null);
    try {
      const created = (await api.send('POST', '/api/v1/staff', orgId, {
        staffNo: String(f.get('staffNo')).trim().toUpperCase(),
        displayName: String(f.get('displayName')).trim(),
        primaryLocationId: String(f.get('location')),
        ...(opt('jobTitle') ? { jobTitle: opt('jobTitle') } : {}),
        ...(opt('workEmail') ? { workEmail: opt('workEmail') } : {}),
        ...(opt('startDate') ? { startDate: opt('startDate') } : {}),
        ...(opt('contractType') ? { contractType: opt('contractType') } : {}),
        ...(opt('managerStaffId') ? { managerStaffId: opt('managerStaffId') } : {}),
      })) as Row;
      const role = opt('role');
      let note = 'Staff record created as a candidate.';
      if (role && created?.id) {
        try {
          await api.send('POST', `/api/v1/staff/${created.id}/role-checks`, orgId, { role });
          note = `Staff record created; checks started for ${ROLE_LABEL[role] ?? 'the role'}.`;
        } catch {
          note =
            'Staff record created as a candidate. Checks for the role could not be started: ' +
            'the role may have no requirements set up yet.';
        }
      }
      setMsg(note);
      form.reset();
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
        <label className="flex flex-col text-sm">
          Work email
          <input
            name="workEmail"
            type="email"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Start date
          <input
            name="startDate"
            type="date"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <label className="flex flex-col text-sm">
          Contract type
          <select
            name="contractType"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          >
            <option value="">Not recorded</option>
            {Object.entries(CONTRACT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Line manager
          <select
            name="managerStaffId"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          >
            <option value="">Not set</option>
            {(managers.data?.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Role to check for
          <select name="role" className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5">
            <option value="">Decide later</option>
            {roles.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
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
