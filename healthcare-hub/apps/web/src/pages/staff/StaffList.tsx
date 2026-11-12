import type { MeResponse } from '@hub/contracts';
import { staffRolesFor } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { Icon, type IconName } from '../../icons.js';
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

const fieldClass = 'field h-9 py-1 text-sm';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

const AVATAR: Record<string, string> = {
  RED: 'bg-red-50 text-red-800',
  AMBER: 'bg-amber-50 text-amber-900',
  GREEN: 'bg-green-50 text-green-800',
};

type Tone = 'RED' | 'AMBER' | 'GREEN' | 'COUNT';
const TONE: Record<Tone, { bar: string; label: string; chip: string }> = {
  RED: { bar: 'border-t-red-600', label: 'text-red-700', chip: 'bg-red-50 text-red-700' },
  AMBER: { bar: 'border-t-amber-500', label: 'text-amber-800', chip: 'bg-amber-50 text-amber-700' },
  GREEN: { bar: 'border-t-green-600', label: 'text-green-800', chip: 'bg-green-50 text-green-700' },
  COUNT: { bar: 'border-t-hub-teal', label: 'text-hub-teal', chip: 'bg-hub-sky text-hub-teal' },
};

/** A figure card in the light console style; the words carry the meaning, colour only accents. */
function StatCard({
  label,
  value,
  unit,
  tone,
  icon,
  foot,
}: {
  label: string;
  value: number | string;
  unit: string;
  tone: Tone;
  icon: IconName;
  foot: string;
}) {
  return (
    <div className={`card border-t-4 px-5 py-4 ${TONE[tone].bar}`}>
      <div className="flex items-start justify-between gap-2">
        <span className={`eyebrow ${TONE[tone].label}`}>{label}</span>
        <span className={`grid h-8 w-8 place-items-center rounded-lg ${TONE[tone].chip}`}>
          <Icon name={icon} size={17} />
        </span>
      </div>
      <p className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-3xl font-extrabold text-slate-900">{value}</span>
        <span className="text-sm text-slate-600">{unit}</span>
      </p>
      <p className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">{foot}</p>
    </div>
  );
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
      <p role="alert" className="rounded-lg border border-hub-line bg-hub-card p-3">
        You do not have access to the staff register.
      </p>
    );
  const basic = can('staff.profile.view_basic');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl">Staff</h1>
          <p className="mt-1 text-slate-600">
            Deployment clearance and statutory checks for everyone on the register.
          </p>
        </div>
        {basic && view === 'register' && can('staff.profile.manage') && (
          <a href="#add-staff" className="btn-primary">
            <Icon name="plus" size={16} />
            Add a staff member
          </a>
        )}
      </div>
      {basic && (
        <div
          role="tablist"
          aria-label="Staff views"
          className="flex flex-wrap gap-1 border-b border-hub-line"
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
                className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-bold ${view === id ? 'border-hub-teal text-hub-teal' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'}`}
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
  const rows = res.data?.data ?? [];
  const count = (st: string) => rows.filter((r) => r.overallStatus === st).length;
  const filtered = q.trim() !== '' || lifecycle !== '' || role !== '';
  const scope = filtered ? 'in this filtered list' : 'on the register';
  return (
    <div className="space-y-5">
      {!basic && (
        <p role="note" className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sky-950">
          {DISPATCH_NOTE}
        </p>
      )}
      {basic && !res.isLoading && !res.isError && (
        <section aria-label="Staff figures" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="Headcount"
            value={rows.length}
            unit="people"
            tone="COUNT"
            icon="people"
            foot={`${count('GREY')} awaiting evidence or verification`}
          />
          <StatCard
            label="Ready"
            value={count('GREEN')}
            unit="all checks verified"
            tone="GREEN"
            icon="check"
            foot={`Counted ${scope}`}
          />
          <StatCard
            label="Due soon"
            value={count('AMBER')}
            unit="need renewal"
            tone="AMBER"
            icon="clock"
            foot={`Counted ${scope}`}
          />
          <StatCard
            label="Blocked"
            value={count('RED')}
            unit="expired, overdue or missing"
            tone="RED"
            icon="alert"
            foot={`Counted ${scope}`}
          />
        </section>
      )}
      <form
        className="card flex flex-wrap items-end gap-3 px-4 py-3"
        aria-label="Filter staff"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs font-semibold text-slate-600">
          Search name or staff number
          <span className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              <Icon name="search" size={16} />
            </span>
            <input
              className={`${fieldClass} w-full pl-8`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Lifecycle
          <select
            className={fieldClass}
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
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Approved role
          <select className={fieldClass} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Any role</option>
            {sectorRoles(me, orgId).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <button
            type="button"
            className="btn-ghost h-9 px-3"
            onClick={() => {
              setQ('');
              setLifecycle('');
              setRole('');
            }}
          >
            Reset
          </button>
        )}
      </form>
      <DataTable<Row>
        caption="Staff register"
        rows={rows}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load staff.' : null}
        emptyMessage="No staff match these filters."
        columns={[
          {
            key: 'name',
            header: 'Staff member',
            cell: (r) => (
              <span className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-xs font-bold ${AVATAR[r.overallStatus] ?? 'bg-slate-100 text-slate-700'}`}
                >
                  {initials(r.displayName)}
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/staff/$id"
                      params={{ id: r.id }}
                      className="font-bold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-hub-teal"
                    >
                      {r.displayName}
                    </Link>
                    <span className="rounded border border-slate-200 bg-slate-50 px-1.5 text-[11px] font-bold text-slate-600">
                      {r.staffNo}
                    </span>
                  </span>
                  {r.jobTitle && <span className="block text-xs text-slate-600">{r.jobTitle}</span>}
                </span>
              </span>
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
            cell: (r) =>
              r.activeRestrictions?.length ? (
                <span className="font-semibold text-red-800">
                  {list(r.activeRestrictions, RESTRICTION_LABEL)}
                </span>
              ) : (
                <span className="text-slate-500">None</span>
              ),
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
    <section aria-labelledby="add-staff" className="card scroll-mt-24 p-5">
      <h2 id="add-staff" className="mb-3 text-lg font-bold">
        Add a staff member
      </h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Staff number
          <input name="staffNo" required placeholder="ST-0000" className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Name
          <input name="displayName" required className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Job title
          <input name="jobTitle" className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Base location
          <select name="location" required className={fieldClass}>
            {(locations.data?.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Work email
          <input name="workEmail" type="email" className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Start date
          <input name="startDate" type="date" className={fieldClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Contract type
          <select name="contractType" className={fieldClass}>
            <option value="">Not recorded</option>
            {Object.entries(CONTRACT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Line manager
          <select name="managerStaffId" className={fieldClass}>
            <option value="">Not set</option>
            {(managers.data?.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Role to check for
          <select name="role" className={fieldClass}>
            <option value="">Decide later</option>
            {roles.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-primary h-9">Add</button>
      </form>
      {msg && (
        <p role="status" className="mt-2 text-sm">
          {msg}
        </p>
      )}
    </section>
  );
}
