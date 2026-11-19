import { RECORD_SLUGS, SENSITIVE_RECORD_KINDS } from '@hub/contracts';
import { needsSchedule3, staffRolesFor } from '@hub/rules';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  Select,
  Space,
  Spin,
  Tabs,
  Typography,
} from 'antd';
import { useState, type ReactNode } from 'react';
import {
  ActionDialog,
  Field,
  Section,
  errText,
  fmtDate,
  fmtDateTime,
  useCan,
} from '../../components.js';
import { EvidenceDialog, StaffDocuments, UploadDialog } from '../evidence/Evidence.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne, usePeople } from '../settings/hooks.js';
import { DISPATCH_NOTE } from './StaffList.js';
import { RecordForm } from './RecordForm.js';
import { DriverEligibilityPanel, Schedule3Panel } from './Schedule3.js';
import {
  CONTRACT_LABEL,
  DATE_LABEL,
  LIFECYCLE_LABEL,
  RESTRICTION_LABEL,
  ROLE_LABEL,
  list,
} from './labels.js';

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

/**
 * Header badge (finding 51). Never "not applicable": a person with no checks set up is shown as
 * not set up, and a person with no approved role as needing one.
 */
export function readinessBadge(s: Row): { status: StatusKind; reason: string } {
  if (s.checksSetUp === false)
    return {
      status: 'GREY',
      reason: s.roles?.length ? 'checks not set up for their roles' : 'no approved role yet',
    };
  switch (s.overallStatus) {
    case 'GREEN':
      return { status: 'GREEN', reason: 'all required checks verified' };
    case 'AMBER':
      return { status: 'AMBER', reason: 'verified, something due soon' };
    case 'RED':
      return { status: 'RED', reason: 'something expired, overdue or missing' };
    default:
      return { status: 'GREY', reason: 'awaiting evidence or verification' };
  }
}

export function StaffProfile() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { me } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('overview');
  const res = useOne<Row>(`/api/v1/staff/${id}`);
  if (res.isLoading) return <Spin tip="Loading…" />;
  if (res.isError || !res.data)
    return <Alert type="error" showIcon message="This staff record is not available." />;
  const s = res.data;
  const clearanceOnly = !('counts' in s);
  const can = (p: string) => me.permissions.includes(p);
  const sensitive = can('staff.sensitive.view');

  const descItems: { key: string; label: string; children: ReactNode }[] = [
    {
      key: 'roles',
      label: 'Roles',
      children: s.roles.length ? list(s.roles, ROLE_LABEL) : 'No approved role yet',
    },
    { key: 'lifecycle', label: 'Lifecycle', children: LIFECYCLE_LABEL[s.lifecycleState] },
    {
      key: 'restr',
      label: 'Restrictions',
      children: list(s.activeRestrictions, RESTRICTION_LABEL),
    },
  ];
  if (s.jobTitle) descItems.push({ key: 'job', label: 'Job title', children: s.jobTitle });
  if (!clearanceOnly) {
    descItems.push(
      { key: 'loc', label: 'Location', children: s.locationName ?? 'Not recorded' },
      { key: 'mgr', label: 'Line manager', children: s.managerName ?? 'Not set' },
    );
    if (s.startDate)
      descItems.push({ key: 'start', label: 'Start date', children: fmtDate(s.startDate) });
    if (s.contractType)
      descItems.push({
        key: 'contract',
        label: 'Contract',
        children: CONTRACT_LABEL[s.contractType] ?? 'Other',
      });
  }

  return (
    <Space direction="vertical" size="large" style={{ display: 'flex', width: '100%' }}>
      <Typography.Text type="secondary">
        <Link to="/staff">Staff</Link> / {s.staffNo}
      </Typography.Text>
      <Card
        title={
          <Typography.Title level={2} className="!mb-0 !text-xl !font-semibold">
            {s.displayName}{' '}
            <Typography.Text type="secondary" className="!text-base !font-normal">
              / {s.staffNo}
            </Typography.Text>
          </Typography.Title>
        }
        extra={
          !clearanceOnly ? (
            <Space>
              <Typography.Text strong>Readiness</Typography.Text>
              <StatusBadge {...readinessBadge(s)} />
            </Space>
          ) : undefined
        }
      >
        <Descriptions size="small" column={{ xs: 1, sm: 2 }} items={descItems} />
      </Card>

      {clearanceOnly ? (
        <Alert type="info" showIcon role="note" message={DISPATCH_NOTE} />
      ) : (
        <>
          <Tabs
            aria-label="Staff profile sections"
            activeKey={tab}
            onChange={(k) => setTab(k as (typeof TABS)[number]['id'])}
            items={TABS.map((t) => ({ key: t.id, label: t.label }))}
          />
          <div
            role="tabpanel"
            id="staff-panel"
            aria-labelledby={`tab-${tab}`}
            className="space-y-6"
          >
            {tab === 'overview' && <Overview s={s} />}
            {tab === 'history' && <History s={s} />}
            {tab === 'documents' && <StaffDocuments s={s} />}
            {tab === 'recruitment' && can('staff.profile.manage') && sensitive && (
              <Schedule3Panel staffId={s.id} />
            )}
            {tab === 'recruitment' && <DriverEligibilityPanel staffId={s.id} />}
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
    </Space>
  );
}

/** Evidence already verified is being renewed; anything else is a first upload. */
const uploadLabel = (r: Row) =>
  r.currentlyVerified ? 'Upload renewal evidence' : 'Upload evidence';

function Overview({ s }: { s: Row }) {
  const can = useCan();
  const { api, orgId } = useApp();
  const [docsFor, setDocsFor] = useState<Row | null>(null);
  const [uploadFor, setUploadFor] = useState<Row | null>(null);
  const [reviewFor, setReviewFor] = useState<Row | null>(null);
  const reqs = (s.requirements as Row[])
    .slice()
    .sort((a, b) => Number(b.required) - Number(a.required));
  const target = (r: Row | null) =>
    r ? { instanceId: r.id, title: r.templateTitle, deadlineKind: r.deadlineKind } : null;

  return (
    <>
      <DataTable<Row>
        caption="Requirements"
        rows={reqs}
        rowKey={(r) => r.id}
        emptyMessage="No checks apply yet. Start checks for a role below; if the role has none, set them up in Settings, Requirement library."
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
              return d ? `${DATE_LABEL[r.deadlineKind]}: ${fmtDate(d)}` : 'Not set';
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
              <Space wrap size="small">
                <Button
                  size="small"
                  aria-label={`Documents for ${r.templateTitle}`}
                  onClick={() => setDocsFor(r)}
                >
                  Documents
                </Button>
                {can('compliance.evidence.upload') && s.lifecycleState !== 'LEAVER' && (
                  <Button
                    size="small"
                    aria-label={`${uploadLabel(r)} for ${r.templateTitle}`}
                    onClick={() => setUploadFor(r)}
                  >
                    {uploadLabel(r)}
                  </Button>
                )}
                {can('staff.profile.manage') && s.lifecycleState !== 'LEAVER' && (
                  <Button
                    size="small"
                    aria-label={`Request review of ${r.templateTitle}`}
                    onClick={() => setReviewFor(r)}
                  >
                    Request review
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <UploadDialog target={target(uploadFor)} onClose={() => setUploadFor(null)} />
      <EvidenceDialog target={target(docsFor)} onClose={() => setDocsFor(null)} />
      <ActionDialog
        open={reviewFor !== null}
        title={`Request a review of ${reviewFor?.templateTitle ?? ''}`}
        confirmLabel="Send request"
        reasonLabel="What should be reviewed"
        onCancel={() => setReviewFor(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/staff/${s.id}/requests`, orgId, {
            kind: 'REVIEW',
            instanceId: reviewFor!.id,
            reason,
          })
        }
      >
        <p>
          Asks a reviewer to look at this item for {s.displayName} again. Asking does not change its
          status; someone other than you decides.
        </p>
      </ActionDialog>

      <ProfileActions s={s} />
    </>
  );
}

/** B1, B4: role checks and approval, lifecycle moves and restrictions, each through a dialog. */
function ProfileActions({ s }: { s: Row }) {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const [dialog, setDialog] = useState<'lifecycle' | 'restrict' | 'supervision' | null>(null);
  const closed = s.lifecycleState === 'LEAVER';
  return (
    <>
      {(can('staff.profile.manage') || can('staff.approve_role')) && !closed && (
        <RoleChecks s={s} />
      )}
      <Space wrap>
        {can('staff.lifecycle.transition') && s.allowedTransitions.length > 0 && (
          <Button size="small" onClick={() => setDialog('lifecycle')}>
            Change lifecycle
          </Button>
        )}
        {can('staff.restrict') && !closed && (
          <Button size="small" onClick={() => setDialog('restrict')}>
            Apply restriction or suspend
          </Button>
        )}
        {can('staff.profile.manage') && !closed && (
          <Button size="small" onClick={() => setDialog('supervision')}>
            Book supervision
          </Button>
        )}
      </Space>
      {dialog === 'lifecycle' && <LifecycleDialog s={s} onClose={() => setDialog(null)} />}
      {dialog === 'restrict' && <RestrictDialog s={s} onClose={() => setDialog(null)} />}
      {dialog === 'supervision' && <SupervisionDialog s={s} onClose={() => setDialog(null)} />}
      {can('staff.profile.manage') && <StaffRequests staffId={s.id} />}
    </>
  );
}

/** Finding 15: a manager books supervision for someone; another person confirms the time. */
function SupervisionDialog({ s, onClose }: { s: Row; onClose: () => void }) {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const [date, setDate] = useState('');
  const [supervisor, setSupervisor] = useState('');
  return (
    <ActionDialog
      open
      title={`Book supervision for ${s.displayName}`}
      confirmLabel="Send booking request"
      reasonLabel="What the session is for"
      confirmDisabled={!date}
      onCancel={onClose}
      fields={
        <>
          <Field label="Proposed date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Supervisor (optional)">
            <Select
              value={supervisor || undefined}
              onChange={setSupervisor}
              allowClear
              placeholder="Anyone suitable"
              options={people
                .filter((p) => p.id && p.id !== s.userId)
                .map((p) => ({
                  value: p.id,
                  label: p.id === me.user.id ? `${p.displayName} (you)` : p.displayName,
                }))}
            />
          </Field>
        </>
      }
      onConfirm={(reason) =>
        api.send('POST', `/api/v1/staff/${s.id}/requests`, orgId, {
          kind: 'SUPERVISION',
          proposedDate: date,
          reason,
          ...(supervisor ? { supervisorUserId: supervisor } : {}),
        })
      }
    >
      <p>
        The request joins the staff requests queue. The named supervisor, or another manager,
        confirms the time; you cannot confirm a booking you asked for.
      </p>
    </ActionDialog>
  );
}

const REQUEST_KIND: Record<string, string> = {
  DUE_DATE_CHANGE: 'Due date change',
  REVIEW: 'Review',
  SUPERVISION: 'Supervision',
};
const REQUEST_STATUS: Record<string, string> = {
  OPEN: 'Waiting for a decision',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn',
};

function StaffRequests({ staffId }: { staffId: string }) {
  const res = useOne<{ data: Row[] }>(`/api/v1/staff/${staffId}/requests`);
  return (
    <DataTable<Row>
      caption="Review and supervision requests"
      rows={res.data?.data ?? []}
      rowKey={(r) => r.id}
      loading={res.isLoading}
      error={res.isError ? 'Could not load the requests.' : null}
      emptyMessage="No requests."
      columns={[
        { key: 'kind', header: 'Request', cell: (r) => REQUEST_KIND[r.kind] ?? 'Request' },
        {
          key: 'what',
          header: 'About',
          cell: (r) =>
            r.requirementTitle ??
            (r.proposedDate ? `Proposed ${fmtDate(r.proposedDate)}` : 'Not stated'),
        },
        { key: 'asked', header: 'Asked', cell: (r) => fmtDate(r.createdAt) },
        { key: 'status', header: 'State', cell: (r) => REQUEST_STATUS[r.status] ?? 'Unknown' },
      ]}
    />
  );
}

const STATUS_TEXT: Record<string, string> = {
  GREEN: 'Verified',
  AMBER: 'Verified, due soon or newer evidence awaiting review',
  RED: 'Expired or overdue',
  GREY: 'Awaiting evidence or verification',
  NOT_APPLICABLE: 'Not applicable (approved)',
};

function RoleChecks({ s }: { s: Row }) {
  const { api, orgId, me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const packs = me.memberships.find((m) => m.organisationId === orgId)?.sectorPacks;
  const offered = staffRolesFor(packs);
  const candidates = Object.entries(ROLE_LABEL).filter(
    ([k]) => offered.includes(k) && !s.roles.includes(k),
  );
  const [role, setRole] = useState<string>(candidates[0]?.[0] ?? '');
  const [approve, setApprove] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const checks = useOne<Row>(role ? `/api/v1/staff/${s.id}/role-checks/${role}` : null);
  const r = checks.data;
  if (candidates.length === 0) return null;
  const ready = r?.setUp && r.items.length > 0 && r.blockers.length === 0;
  return (
    <Section title="Checks for a role">
      <p className="mb-2 text-sm text-slate-700">
        A person can only be approved for a role when every check the role needs is verified by a
        reviewer (CQC Regulation 19 and Schedule 3).
      </p>
      <Space wrap align="end">
        <Field label="Role">
          <Select
            style={{ width: 220 }}
            value={role}
            onChange={setRole}
            options={candidates.map(([k, v]) => ({ value: k, label: v }))}
          />
        </Field>
        {can('staff.profile.manage') && r?.setUp && r.items.length === 0 && (
          <Button
            size="small"
            onClick={async () => {
              setStarted(null);
              try {
                await api.send('POST', `/api/v1/staff/${s.id}/role-checks`, orgId, { role });
                setStarted('Checks started. Each item is awaiting evidence.');
                await checks.refetch();
              } catch (e) {
                setStarted(errText(e));
              }
            }}
          >
            Start checks for {ROLE_LABEL[role]}
          </Button>
        )}
        {can('staff.approve_role') && r?.setUp && r.items.length > 0 && (
          <Button
            size="small"
            disabled={!ready}
            title={ready ? undefined : 'Every check must be verified first'}
            onClick={() => setApprove(true)}
          >
            Approve for {ROLE_LABEL[role]}
          </Button>
        )}
      </Space>
      {started && (
        <Alert style={{ marginTop: 8 }} type="info" showIcon role="status" message={started} />
      )}
      {checks.isLoading && <p className="mt-2 text-sm">Loading checks…</p>}
      {r && !r.setUp && (
        <Alert
          type="warning"
          showIcon
          role="alert"
          style={{ marginTop: 8 }}
          message={`${ROLE_LABEL[role]} has no requirements set up, so nothing can be checked and nobody can be approved for it. Publish and map them in Settings, Requirement library.`}
        />
      )}
      {r?.setUp && r.items.length > 0 && (
        <>
          <p className="mt-2 text-sm font-medium">
            {r.blockers.length === 0
              ? 'All checks verified: ready to approve.'
              : `${r.blockers.length} of ${r.items.length} checks still need verified evidence.`}
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {(r.items as Row[]).map((x) => (
              <li key={x.instanceId} className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  status={x.status as StatusKind}
                  reason={STATUS_TEXT[x.status] ?? x.reasonText}
                />
                <span>{x.title}</span>
                {x.status !== 'GREEN' && <span className="text-slate-700">– {x.reasonText}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <ActionDialog
        open={approve}
        title={`Approve ${s.displayName} for ${ROLE_LABEL[role]}`}
        confirmLabel="Approve"
        reasonLabel="Reason"
        onCancel={() => setApprove(false)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/staff/${s.id}/role-approvals`, orgId, { role, reason })
        }
      >
        <p>
          Every check for this role is verified. Approving lets the person be allocated to work in
          this role. Your name and reason are recorded.
        </p>
        {needsSchedule3(role) && (
          <p>
            This role works with patients or residents, so the Schedule 3 staff file (identity, DBS,
            references, employment history, qualifications, health and right to work) must also be
            complete. If anything is missing, approval is refused and the missing items are listed.
          </p>
        )}
      </ActionDialog>
    </Section>
  );
}

function LifecycleDialog({ s, onClose }: { s: Row; onClose: () => void }) {
  const { api, orgId } = useApp();
  const options = s.allowedTransitions as string[];
  const [to, setTo] = useState(options[0] ?? '');
  return (
    <ActionDialog
      open
      title="Change lifecycle"
      confirmLabel={`Move to ${LIFECYCLE_LABEL[to] ?? to}`}
      reasonLabel="Reason"
      danger={to === 'LEAVER' || to === 'SUSPENDED'}
      onCancel={onClose}
      fields={
        <Field label="Move to">
          <Select
            value={to}
            onChange={setTo}
            options={options.map((t) => ({ value: t, label: LIFECYCLE_LABEL[t] ?? t }))}
          />
        </Field>
      }
      onConfirm={(reason) =>
        api.send('POST', `/api/v1/staff/${s.id}/transition`, orgId, { to, reason })
      }
    >
      <p>
        Currently {LIFECYCLE_LABEL[s.lifecycleState] ?? s.lifecycleState}. Ready for review,
        Approved for role and Active are only allowed when the required checks are verified.
        {to === 'LEAVER' ? ' A leaver loses access to the app immediately.' : ''}
      </p>
    </ActionDialog>
  );
}

function RestrictDialog({ s, onClose }: { s: Row; onClose: () => void }) {
  const { api, orgId } = useApp();
  const [type, setType] = useState(Object.keys(RESTRICTION_LABEL)[0] ?? '');
  const [until, setUntil] = useState('');
  return (
    <ActionDialog
      open
      title="Apply a restriction"
      confirmLabel="Apply now"
      reasonLabel="Reason"
      danger
      onCancel={onClose}
      fields={
        <>
          <Field label="Restriction">
            <Select
              value={type}
              onChange={setType}
              options={Object.entries(RESTRICTION_LABEL).map(([k, v]) => ({ value: k, label: v }))}
            />
          </Field>
          <Field label="Ends on (optional)">
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        </>
      }
      onConfirm={(reason) =>
        api.send('POST', `/api/v1/staff/${s.id}/restrictions`, orgId, {
          type,
          reason,
          ...(until ? { validTo: `${until}T23:59:59.000Z` } : {}),
        })
      }
    >
      <p>
        Takes effect immediately on all future allocations. Dispatchers see that a restriction
        exists but not the reason.
      </p>
    </ActionDialog>
  );
}

function History({ s }: { s: Row }) {
  const { api, orgId, me } = useApp();
  const [lifting, setLifting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [chaseOpen, setChaseOpen] = useState(false);
  const [chaseKind, setChaseKind] = useState('REFERENCE');
  const [chaseSubject, setChaseSubject] = useState('');
  const [chaseRequested, setChaseRequested] = useState('');
  const [chaseChased, setChaseChased] = useState('');
  const canManage = me.permissions.includes('staff.profile.manage');
  const chase = useOne<{ data: Row[] }>(canManage ? `/api/v1/staff/${s.id}/chase-log` : null);
  const lift = (rid: string) => setLifting(rid);
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
            cell: (r) => fmtDateTime(r.at),
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
          { key: 'from', header: 'Approved', cell: (r) => fmtDate(r.validFrom) },
          {
            key: 'state',
            header: 'State',
            cell: (r) =>
              r.active ? 'Active' : r.revokedAt ? `Revoked – ${r.revokeReason}` : 'Not in force',
          },
          { key: 'reason', header: 'Reason', cell: (r) => r.reason },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              r.active && me.permissions.includes('staff.approve_role') ? (
                <Button size="small" onClick={() => setRevoking(r.id)}>
                  Revoke<span className="sr-only"> {ROLE_LABEL[r.role]}</span>
                </Button>
              ) : null,
          },
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
                <Button size="small" onClick={() => lift(r.id)}>
                  Lift<span className="sr-only"> {RESTRICTION_LABEL[r.type]}</span>
                </Button>
              ) : null,
          },
        ]}
      />
      <ActionDialog
        open={lifting !== null}
        title="Lift restriction"
        confirmLabel="Lift restriction"
        reasonLabel="Reason for lifting"
        onCancel={() => setLifting(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/staff/${s.id}/restrictions/${lifting}/lift`, orgId, { reason })
        }
      >
        <p>The person can be allocated to this work again from now.</p>
      </ActionDialog>
      <ActionDialog
        open={revoking !== null}
        title="Revoke role approval"
        confirmLabel="Revoke approval"
        danger
        reasonLabel="Reason for revoking"
        onCancel={() => setRevoking(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/staff/${s.id}/role-approvals/${revoking}/revoke`, orgId, {
            reason,
          })
        }
      >
        <p>
          The person will no longer be treated as approved for this role. Allocation and shift start
          will fail until they are approved again.
        </p>
      </ActionDialog>
      {canManage && (
        <>
          <div className="mt-4 flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Reference and DBS chase log</h3>
            <Button size="small" onClick={() => setChaseOpen(true)}>
              Add chase entry
            </Button>
          </div>
          <DataTable<Row>
            caption="Chase log"
            rows={chase.data?.data ?? []}
            rowKey={(r) => r.id}
            emptyMessage="No chase entries yet."
            columns={[
              { key: 'kind', header: 'Type', cell: (r) => wordsChase(r.kind) },
              { key: 'subject', header: 'Subject', cell: (r) => r.subject },
              {
                key: 'requested',
                header: 'Requested',
                cell: (r) => (r.requestedOn ? fmtDate(r.requestedOn) : '—'),
              },
              {
                key: 'chased',
                header: 'Chased',
                cell: (r) => (r.chasedOn ? fmtDate(r.chasedOn) : '—'),
              },
              {
                key: 'received',
                header: 'Received',
                cell: (r) => (r.receivedOn ? fmtDate(r.receivedOn) : '—'),
              },
              { key: 'note', header: 'Note', cell: (r) => r.note ?? '—' },
            ]}
          />
          <ActionDialog
            open={chaseOpen}
            title="Add chase entry"
            confirmLabel="Save"
            reasonLabel="Note (optional)"
            reasonRequired={false}
            onCancel={() => {
              setChaseOpen(false);
              setChaseKind('REFERENCE');
              setChaseSubject('');
              setChaseRequested('');
              setChaseChased('');
            }}
            onConfirm={async (note) => {
              const subject = chaseSubject.trim();
              if (!chaseKind || !subject) throw new Error('Type and subject are required');
              await api.send('POST', `/api/v1/staff/${s.id}/chase-log`, orgId, {
                kind: chaseKind,
                subject,
                ...(chaseRequested ? { requestedOn: chaseRequested } : {}),
                ...(chaseChased ? { chasedOn: chaseChased } : {}),
                ...(note?.trim() ? { note: note.trim() } : {}),
              });
              setChaseKind('REFERENCE');
              setChaseSubject('');
              setChaseRequested('');
              setChaseChased('');
            }}
            fields={
              <Space direction="vertical" style={{ width: '100%' }}>
                <Field label="Type">
                  <Select
                    value={chaseKind}
                    onChange={setChaseKind}
                    options={[
                      { value: 'REFERENCE', label: 'Reference' },
                      { value: 'DBS', label: 'DBS' },
                      { value: 'RIGHT_TO_WORK', label: 'Right to work' },
                      { value: 'OTHER', label: 'Other' },
                    ]}
                  />
                </Field>
                <Field label="Subject">
                  <Input
                    value={chaseSubject}
                    onChange={(e) => setChaseSubject(e.target.value)}
                    maxLength={200}
                    required
                  />
                </Field>
                <Field label="Requested on">
                  <Input
                    type="date"
                    value={chaseRequested}
                    onChange={(e) => setChaseRequested(e.target.value)}
                  />
                </Field>
                <Field label="Chased on">
                  <Input
                    type="date"
                    value={chaseChased}
                    onChange={(e) => setChaseChased(e.target.value)}
                  />
                </Field>
              </Space>
            }
          >
            <p>Track when references or DBS checks were requested, chased and received.</p>
          </ActionDialog>
        </>
      )}
      {/* Licence changes and corrections are part of the history (finding 48). */}
      <Records staffId={s.id} slug="licences" canAdd={false} />
    </>
  );
}

function wordsChase(kind: string): string {
  if (kind === 'DBS') return 'DBS';
  if (kind === 'RIGHT_TO_WORK') return 'Right to work';
  if (kind === 'REFERENCE') return 'Reference';
  return 'Other';
}

/** Readable one-line summary: no raw codes, no empty fields (UI_SPEC). */
export function summarise(data: Record<string, unknown>): string {
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
      const key = k.replace(/([A-Z])/g, ' $1').toLowerCase();
      const val = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '…' : word(v);
      return `${key}: ${val}`;
    })
    .join('; ');
}

const CHECK_METHOD: Record<string, string> = {
  DVLA_SHARE_CODE: 'DVLA share code',
  DVLA_API: 'DVLA online check',
  MANUAL: 'licence seen in person',
};

/** Driving licence in words (finding 48): what it covers, until when, and how it was checked. */
export function licenceSummary(d: Record<string, unknown>): string {
  const parts: string[] = [];
  const cats = Array.isArray(d.categories) ? (d.categories as string[]) : [];
  if (cats.length) parts.push(`Categories ${cats.join(', ')}`);
  if (typeof d.licenceNumber === 'string') parts.push(`driver number ${d.licenceNumber}`);
  if (typeof d.photocardExpiry === 'string')
    parts.push(`photocard valid until ${fmtDate(d.photocardExpiry)}`);
  if (typeof d.lastCheckedOn === 'string')
    parts.push(
      `checked ${fmtDate(d.lastCheckedOn)}${
        typeof d.checkMethod === 'string' && CHECK_METHOD[d.checkMethod]
          ? ` by ${CHECK_METHOD[d.checkMethod]}`
          : ''
      }`,
    );
  if (typeof d.penaltyPoints === 'number')
    parts.push(d.penaltyPoints ? `${d.penaltyPoints} penalty point(s)` : 'no penalty points');
  const codes = Array.isArray(d.restrictionCodes) ? (d.restrictionCodes as string[]) : [];
  if (codes.length) parts.push(`restriction codes ${codes.join(', ')}`);
  return parts.join('; ');
}

function Records({ staffId, slug, canAdd }: { staffId: string; slug: string; canAdd: boolean }) {
  const { api, orgId } = useApp();
  const invalidate = useInvalidate();
  const people = usePeople();
  const res = useOne<{ data: Row[] }>(`/api/v1/staff/${staffId}/${slug}`);
  const [open, setOpen] = useState(false);
  const [correcting, setCorrecting] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const kind = RECORD_SLUGS[slug]!;
  const who = (uid: string) => people.find((p) => p.id === uid)?.displayName ?? 'a former member';
  return (
    <section aria-labelledby={`sec-${slug}`} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={`sec-${slug}`} className="text-lg font-bold">
          {SECTION_TITLE[slug]}
        </h2>
        {canAdd && (
          <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Add record'}
            <span className="sr-only"> – {SECTION_TITLE[slug]}</span>
          </Button>
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
          {
            key: 'details',
            header: 'Details',
            cell: (r) => (kind === 'LICENCE' ? licenceSummary(r.data) : summarise(r.data)),
          },
          {
            key: 'valid',
            header: 'Valid',
            cell: (r) =>
              r.validFrom || r.validTo
                ? `${r.validFrom ? fmtDate(r.validFrom) : '…'} to ${
                    r.validTo ? fmtDate(r.validTo) : 'no end date'
                  }`
                : '—',
          },
          {
            key: 'recorded',
            header: 'Recorded',
            cell: (r) => `${fmtDate(r.createdAt)} by ${who(r.createdBy)}`,
          },
          {
            key: 'state',
            header: 'Record',
            cell: (r) => (r.current ? 'Current' : 'Superseded by a correction'),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              canAdd && r.current ? (
                <Button
                  size="small"
                  aria-label={`Correct ${SECTION_TITLE[slug] ?? slug}, ${fmtDate(r.createdAt)}`}
                  onClick={() => {
                    setOpen(false);
                    setCorrecting(r);
                  }}
                >
                  Correct
                </Button>
              ) : null,
          },
        ]}
      />
      {(open || correcting) && (
        <>
          {correcting && (
            <p className="text-sm">
              Correcting the record from {fmtDate(correcting.createdAt)}. The old record stays in
              history, marked as superseded.{' '}
              <Button size="small" onClick={() => setCorrecting(null)}>
                Cancel correction
              </Button>
            </p>
          )}
          <RecordForm
            kind={kind}
            onSubmit={async (data) => {
              setMsg(null);
              try {
                await api.send('POST', `/api/v1/staff/${staffId}/${slug}`, orgId, {
                  data,
                  ...(correcting ? { supersedesId: correcting.id } : {}),
                });
                setMsg(correcting ? 'Corrected. The earlier record is kept in history.' : 'Saved.');
                setOpen(false);
                setCorrecting(null);
                await invalidate();
              } catch (e) {
                setMsg(errText(e));
              }
            }}
          />
        </>
      )}
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
