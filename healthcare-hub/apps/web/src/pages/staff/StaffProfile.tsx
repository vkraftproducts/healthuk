import { RECORD_SLUGS, SENSITIVE_RECORD_KINDS } from '@hub/contracts';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, type ApiClient } from '../../api.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne } from '../settings/hooks.js';
import { DISPATCH_NOTE } from './StaffList.js';
import { RecordForm } from './RecordForm.js';
import { DATE_LABEL, LIFECYCLE_LABEL, RESTRICTION_LABEL, ROLE_LABEL, list } from './labels.js';
import { ViewDocument } from '../ViewDocument.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Profile tabs (UI_SPEC 02). Restricted sections are hidden here AND refused by the API. */
const TABS = [
  { id: 'overview', label: 'Overview', slugs: [] },
  {
    id: 'recruitment',
    label: 'Recruitment',
    slugs: [
      'references',
      'employment-history',
      'right-to-work',
      'dbs',
      'licences',
      'registrations',
    ],
  },
  { id: 'training', label: 'Training', slugs: ['training', 'competencies'] },
  { id: 'supervisions', label: 'Supervisions', slugs: ['supervisions'] },
  { id: 'appraisals', label: 'Appraisals', slugs: ['appraisals', 'objectives'] },
  {
    id: 'documents',
    label: 'Documents',
    slugs: ['induction', 'probation', 'oh-clearance', 'oh-detail', 'personal'],
  },
  { id: 'history', label: 'History', slugs: [] },
] as const;

const SECTION_TITLE: Record<string, string> = {
  references: 'References',
  'employment-history': 'Employment history',
  'right-to-work': 'Right to work',
  dbs: 'DBS (restricted)',
  licences: 'Driving licence',
  registrations: 'Professional registration',
  training: 'Training',
  competencies: 'Competencies',
  supervisions: 'Supervisions',
  appraisals: 'Appraisals',
  objectives: 'Objectives',
  induction: 'Induction',
  probation: 'Probation',
  'oh-clearance': 'Occupational health – fitness status',
  'oh-detail': 'Occupational health – detail (restricted)',
  personal: 'Personal and next of kin (restricted)',
};

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'SELF_APPROVAL') return 'You cannot approve or change your own record.';
    if (e.code === 'TRANSITION_NOT_ALLOWED')
      return 'That move is not allowed yet (check role approvals).';
    if (e.code === 'CONFLICT') return 'That has already been done.';
    if (e.status === 403) return 'You do not have permission to do that.';
    if (e.status === 400) return 'Check the details and try again.';
    return `The server rejected the request (${e.code}).`;
  }
  return 'Could not reach the server.';
}

export function StaffProfile() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { me } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('overview');
  const res = useOne<Row>(`/api/v1/staff/${id}`);
  if (res.isLoading) return <p role="status">Loading…</p>;
  if (res.isError || !res.data)
    return (
      <p role="alert" className="rounded border border-red-700 bg-red-50 p-3 text-red-900">
        This staff record is not available.
      </p>
    );
  const s = res.data;
  const clearanceOnly = !('counts' in s);
  const can = (p: string) => me.permissions.includes(p);
  const sensitive = can('staff.sensitive.view');

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/staff" className="font-medium text-hub-teal-dark underline">
          Staff
        </Link>{' '}
        / {s.staffNo}
      </nav>
      <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-hub-line bg-white p-4">
        <div>
          <h1 className="text-2xl font-bold">
            {s.displayName} <span className="text-slate-600">/ {s.staffNo}</span>
          </h1>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
            <dt className="font-semibold">Roles</dt>
            <dd>{list(s.roles, ROLE_LABEL)}</dd>
            <dt className="font-semibold">Lifecycle</dt>
            <dd>{LIFECYCLE_LABEL[s.lifecycleState]}</dd>
            <dt className="font-semibold">Restrictions</dt>
            <dd>{list(s.activeRestrictions, RESTRICTION_LABEL)}</dd>
            {s.jobTitle && (
              <>
                <dt className="font-semibold">Job title</dt>
                <dd>{s.jobTitle}</dd>
              </>
            )}
          </dl>
        </div>
        {!clearanceOnly && (
          <StatusBadge status={s.overallStatus as StatusKind} reason="overall compliance" />
        )}
      </header>

      {clearanceOnly ? (
        <p role="note" className="rounded border border-sky-700 bg-sky-50 p-3 text-sky-950">
          {DISPATCH_NOTE}
        </p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Staff profile sections"
            className="flex flex-wrap gap-1 rounded-lg border border-hub-line bg-white p-1.5"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="staff-panel"
                onClick={() => setTab(t.id)}
                className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab === t.id ? 'bg-hub-teal text-white' : 'text-hub-navy hover:bg-hub-row'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="staff-panel"
            aria-labelledby={`tab-${tab}`}
            className="space-y-6"
          >
            {tab === 'overview' && <Overview s={s} />}
            {tab === 'history' && <History s={s} />}
            {TABS.find((t) => t.id === tab)!
              .slugs.filter(
                (slug) => sensitive || !SENSITIVE_RECORD_KINDS.includes(RECORD_SLUGS[slug]!),
              )
              .map((slug) => (
                <Records
                  key={slug}
                  staffId={s.id}
                  slug={slug}
                  canAdd={can('staff.profile.manage') && s.lifecycleState !== 'LEAVER'}
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

async function uploadEvidence(
  api: ApiClient,
  orgId: string | null,
  file: File,
  instanceId: string,
) {
  const req = (await api.send('POST', '/api/v1/evidence/uploads', orgId, {
    title: file.name.slice(0, 200),
    mime: file.type || 'application/pdf',
    sizeBytes: file.size,
    requirementInstanceIds: [instanceId],
  })) as { uploadUrl: string; evidenceVersionId: string };
  const put = await fetch(req.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/pdf' },
    body: file,
  });
  if (!put.ok) throw new ApiError(put.status, 'UPLOAD_REJECTED');
  await api.send('POST', `/api/v1/evidence/${req.evidenceVersionId}/complete`, orgId, {});
}

function Overview({ s }: { s: Row }) {
  const { api, orgId, me } = useApp();
  const invalidate = useInvalidate();
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const can = (p: string) => me.permissions.includes(p);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await invalidate();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const reqs = (s.requirements as Row[])
    .slice()
    .sort((a, b) => Number(b.required) - Number(a.required));

  return (
    <>
      <DataTable<Row>
        caption="Requirements"
        rows={reqs}
        rowKey={(r) => r.id}
        emptyMessage="No requirements yet. Approve a role, or map requirements to roles."
        columns={[
          { key: 'req', header: 'Requirement', cell: (r) => r.templateTitle },
          {
            key: 'verified',
            header: 'Verified',
            cell: (r) => (r.currentlyVerified ? 'Yes – verified evidence on file' : 'No'),
          },
          {
            key: 'next',
            header: 'Next date',
            cell: (r) => {
              const d =
                r.deadlineKind === 'DUE'
                  ? r.dueDate
                  : r.deadlineKind === 'EXPIRY'
                    ? r.expiryDate
                    : r.reviewDate;
              return d ? `${DATE_LABEL[r.deadlineKind]}: ${d}` : 'Not set';
            },
          },
          {
            key: 'status',
            header: 'Status',
            cell: (r) =>
              r.required ? (
                <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />
              ) : (
                <span>Not required for current roles</span>
              ),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) => (
              <span className="flex flex-wrap items-center gap-2">
                {can('compliance.requirement.view') && (
                  <ViewDocument instanceId={r.id} label={r.templateTitle} />
                )}
                {can('compliance.evidence.upload') && (
                  <button
                    className="rounded-md border border-hub-line bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row"
                    onClick={() => {
                      setTarget(r.id);
                      fileRef.current?.click();
                    }}
                  >
                    Upload evidence
                    <span className="sr-only"> for {r.templateTitle}</span>
                  </button>
                )}
              </span>
            ),
          },
        ]}
      />
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        aria-label="Evidence file"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && target)
            void run(
              () => uploadEvidence(api, orgId, file, target),
              'Uploaded. It stays unverified until a reviewer checks it.',
            );
          e.target.value = '';
        }}
      />
      {msg && (
        <p role="status" className="rounded border border-slate-400 bg-slate-50 p-2 text-sm">
          {msg}
        </p>
      )}

      {can('staff.lifecycle.transition') && s.allowedTransitions.length > 0 && (
        <ActionForm
          title="Change lifecycle"
          options={(s.allowedTransitions as string[]).map((t) => [t, LIFECYCLE_LABEL[t] ?? t])}
          selectLabel="Move to"
          onSubmit={(to, reason) =>
            run(
              () => api.send('POST', `/api/v1/staff/${s.id}/transition`, orgId, { to, reason }),
              'Lifecycle updated.',
            )
          }
        />
      )}
      {can('staff.approve_role') && s.lifecycleState !== 'LEAVER' && (
        <ActionForm
          title="Approve for a role"
          options={Object.entries(ROLE_LABEL).filter(([k]) => !s.roles.includes(k))}
          selectLabel="Role"
          onSubmit={(role, reason) =>
            run(
              () =>
                api.send('POST', `/api/v1/staff/${s.id}/role-approvals`, orgId, { role, reason }),
              'Role approved; required items recalculated.',
            )
          }
        />
      )}
      {can('staff.restrict') && s.lifecycleState !== 'LEAVER' && (
        <ActionForm
          title="Apply a restriction (takes effect immediately)"
          options={Object.entries(RESTRICTION_LABEL)}
          selectLabel="Restriction"
          onSubmit={(type, reason) =>
            run(
              () => api.send('POST', `/api/v1/staff/${s.id}/restrictions`, orgId, { type, reason }),
              'Restriction applied.',
            )
          }
        />
      )}
    </>
  );
}

function ActionForm({
  title,
  options,
  selectLabel,
  onSubmit,
}: {
  title: string;
  options: [string, string][];
  selectLabel: string;
  onSubmit: (value: string, reason: string) => Promise<void>;
}) {
  const id = title.toLowerCase().replace(/[^a-z]+/g, '-');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await onSubmit(String(f.get('value')), String(f.get('reason')).trim());
    form.reset();
  }
  if (options.length === 0) return null;
  return (
    <section aria-labelledby={id} className="rounded-lg border border-hub-line bg-white p-3">
      <h2 id={id} className="mb-2 font-semibold">
        {title}
      </h2>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-sm">
          {selectLabel}
          <select
            name="value"
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          >
            {options.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-sm">
          Reason (required)
          <input
            name="reason"
            required
            minLength={3}
            className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
          />
        </label>
        <button className="rounded-md bg-hub-teal px-4 py-2 text-sm font-semibold text-white hover:bg-hub-teal-dark">
          Confirm
        </button>
      </form>
    </section>
  );
}

function History({ s }: { s: Row }) {
  const { api, orgId, me } = useApp();
  const invalidate = useInvalidate();
  const [msg, setMsg] = useState<string | null>(null);
  const lift = async (rid: string) => {
    const reason = window.prompt('Reason for lifting the restriction');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.send('POST', `/api/v1/staff/${s.id}/restrictions/${rid}/lift`, orgId, {
        reason: reason.trim(),
      });
      setMsg('Restriction lifted.');
      await invalidate();
    } catch (e) {
      setMsg(errText(e));
    }
  };
  return (
    <>
      <DataTable<Row>
        caption="Lifecycle history"
        rows={s.events}
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'at',
            header: 'When',
            cell: (r) => new Date(r.at).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          {
            key: 'from',
            header: 'From',
            cell: (r) => (r.fromState ? LIFECYCLE_LABEL[r.fromState] : '—'),
          },
          { key: 'to', header: 'To', cell: (r) => LIFECYCLE_LABEL[r.toState] },
          { key: 'reason', header: 'Reason', cell: (r) => r.reason },
        ]}
      />
      <DataTable<Row>
        caption="Role approvals"
        rows={s.roleApprovals}
        rowKey={(r) => r.id}
        emptyMessage="No role approvals."
        columns={[
          { key: 'role', header: 'Role', cell: (r) => ROLE_LABEL[r.role] },
          { key: 'from', header: 'Approved', cell: (r) => r.validFrom.slice(0, 10) },
          {
            key: 'state',
            header: 'State',
            cell: (r) =>
              r.active ? 'Active' : r.revokedAt ? `Revoked – ${r.revokeReason}` : 'Not in force',
          },
          { key: 'reason', header: 'Reason', cell: (r) => r.reason },
        ]}
      />
      <DataTable<Row>
        caption="Restrictions"
        rows={s.restrictions}
        rowKey={(r) => r.id}
        emptyMessage="No restrictions."
        columns={[
          { key: 'type', header: 'Restriction', cell: (r) => RESTRICTION_LABEL[r.type] },
          {
            key: 'state',
            header: 'State',
            cell: (r) =>
              r.active ? 'In force' : r.liftedAt ? `Lifted – ${r.liftReason}` : 'Not in force',
          },
          { key: 'reason', header: 'Reason', cell: (r) => r.reason },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              r.active && me.permissions.includes('staff.restrict') ? (
                <button
                  className="rounded-md border border-hub-line bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row"
                  onClick={() => void lift(r.id)}
                >
                  Lift<span className="sr-only"> {RESTRICTION_LABEL[r.type]}</span>
                </button>
              ) : null,
          },
        ]}
      />
      {msg && <p role="status">{msg}</p>}
    </>
  );
}

/**
 * Readable one-line summary: no raw codes, no empty fields (UI_SPEC). Colleagues are named
 * (`people` maps the user ids a record holds to names), never shown as ids.
 */
export function summarise(
  data: Record<string, unknown>,
  people: Record<string, string> = {},
): string {
  const word = (v: unknown): string =>
    typeof v === 'string' && /^[A-Z][A-Z0-9_]+$/.test(v) && v.includes('_')
      ? v.replace(/_/g, ' ').toLowerCase()
      : typeof v === 'string' && /^[A-Z]{4,}$/.test(v)
        ? v.toLowerCase()
        : typeof v === 'boolean'
          ? v
            ? 'yes'
            : 'no'
          : String(v);
  return Object.entries(data)
    .filter(
      ([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0),
    )
    .map(([k, v]) => {
      if (k.endsWith('UserId')) {
        const role = k
          .slice(0, -'UserId'.length)
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase();
        return `${role}: ${people[String(v)] ?? 'a former colleague'}`;
      }
      const key = k.replace(/([A-Z])/g, ' $1').toLowerCase();
      const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '…' : word(v);
      return `${key}: ${val}`;
    })
    .join('; ');
}

function Records({ staffId, slug, canAdd }: { staffId: string; slug: string; canAdd: boolean }) {
  const { api, orgId } = useApp();
  const invalidate = useInvalidate();
  const res = useOne<{ data: Row[] }>(`/api/v1/staff/${staffId}/${slug}`);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const kind = RECORD_SLUGS[slug]!;
  return (
    <section aria-labelledby={`sec-${slug}`} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={`sec-${slug}`} className="text-lg font-bold">
          {SECTION_TITLE[slug]}
        </h2>
        {canAdd && (
          <button
            className="rounded-md border border-hub-line bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Cancel' : 'Add record'}
            <span className="sr-only"> – {SECTION_TITLE[slug]}</span>
          </button>
        )}
      </div>
      {kind === 'DBS' && (
        <p className="text-sm text-slate-700">
          A DBS certificate has no expiry. The date shown is the local policy review date.
        </p>
      )}
      <DataTable<Row>
        caption={SECTION_TITLE[slug] ?? slug}
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load these records.' : null}
        emptyMessage="No records."
        columns={[
          { key: 'details', header: 'Details', cell: (r) => summarise(r.data, r.people) },
          {
            key: 'valid',
            header: 'Valid',
            cell: (r) =>
              r.validFrom || r.validTo
                ? `${r.validFrom ?? '…'} to ${r.validTo ?? 'no end date'}`
                : '—',
          },
          {
            key: 'state',
            header: 'Record',
            cell: (r) => (r.current ? 'Current' : 'Superseded by a correction'),
          },
        ]}
      />
      {open && (
        <RecordForm
          kind={kind}
          onSubmit={async (data) => {
            setMsg(null);
            try {
              await api.send('POST', `/api/v1/staff/${staffId}/${slug}`, orgId, { data });
              setMsg('Saved.');
              setOpen(false);
              await invalidate();
            } catch (e) {
              setMsg(errText(e));
            }
          }}
        />
      )}
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
