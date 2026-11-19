import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Input,
  Modal,
  Select,
  Space,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useRef, useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PageHeader,
  PersonSelect,
  Section,
  Tabs,
  fmtDate,
  fmtDateTime,
  useCan,
  useRun,
  words,
} from '../../components.js';
import type { ApiClient } from '../../api.js';
import { ReviewQueue } from '../evidence/Evidence.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { Audits } from './Audits.js';
import { Events } from './Events.js';
import { Feedback } from './Feedback.js';
import { SafeguardingRegister } from '../registers/Safeguarding.js';
import { DsptToolkit, StatementOfPurpose } from '../registers/GovernanceRecords.js';
import { Policies } from './Policies.js';
import {
  FitAndProper,
  Meetings,
  NhsContracts,
  Notifications,
  RatingDisplay,
  RegistrationEditor,
} from './Regulatory.js';
import { Risks } from './Risks.js';
import { SpeakUp } from '../speakup/SpeakUp.js';
import { ReportIncident } from './ReportIncident.js';
import { PrivacyPanel } from '../settings/PrivacyPanel.js';
import { Views } from '../../v36/kit.js';
import { Deeper } from '../../v36/ui.js';
import { CqcSelfAudit } from './SelfAudit.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ACTION_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  OPEN: { kind: 'RED', text: 'Open' },
  EVIDENCE_SUBMITTED: { kind: 'AMBER', text: 'Ready for verification' },
  VERIFIED: { kind: 'GREEN', text: 'Verified' },
  REJECTED: { kind: 'RED', text: 'Evidence rejected' },
};
export function Compliance() {
  const can = useCan();
  const { orgId } = useApp();
  // Tab order follows v36 Compliance groups: audits & risks → incidents & concerns →
  // policies & governance → notifications & data.
  const tabs = [
    { id: 'programme', label: 'Programme', show: can('compliance.audit.view') },
    { id: 'audits', label: 'Audits', show: can('compliance.audit.view') },
    { id: 'templates', label: 'Templates', show: can('compliance.audit.view') },
    { id: 'selfaudit', label: 'CQC self-audit', show: can('compliance.audit.view') },
    {
      id: 'actions',
      label: 'Actions',
      show: can('compliance.audit.view') || can('compliance.action.manage'),
    },
    {
      id: 'risks',
      label: 'Risk register',
      show: can('compliance.risk.manage') || can('compliance.audit.view'),
    },
    { id: 'events', label: 'Incidents', show: can('events.event.view') },
    { id: 'report', label: 'Report an incident', show: can('events.event.report') },
    { id: 'feedback', label: 'Complaints & feedback', show: can('events.event.view') },
    { id: 'safeguarding', label: 'Safeguarding referrals', show: can('events.safeguarding.view') },
    {
      id: 'speakup',
      label: 'Speak up',
      show: can('speakup.raise') || can('speakup.manage') || can('harassment.manage'),
    },
    {
      id: 'policies',
      label: 'Policies',
      show: can('compliance.policy.manage') || can('compliance.policy.acknowledge'),
    },
    {
      id: 'registration',
      label: 'Registration',
      show: can('compliance.registration.manage') || can('compliance.audit.view'),
    },
    {
      id: 'meetings',
      label: 'Governance meetings',
      show: can('governance.meeting.manage') || can('compliance.audit.view'),
    },
    { id: 'fpp', label: 'Fit and proper', show: can('governance.fit_proper.manage') },
    {
      id: 'notifications',
      label: 'CQC notifications',
      show: can('events.event.manage') || can('compliance.registration.manage'),
    },
    { id: 'privacy', label: 'Data protection', show: can('privacy.manage') },
    {
      id: 'dspt',
      label: 'DSP Toolkit',
      show: can('privacy.manage') || can('compliance.audit.view'),
    },
    {
      id: 'sop',
      label: 'Statement of purpose',
      show: can('compliance.registration.manage') || can('compliance.audit.view'),
    },
    { id: 'review', label: 'Evidence review', show: can('compliance.evidence.verify') },
    {
      id: 'contracts',
      label: 'NHS contracts',
      show: can('compliance.registration.manage') || can('compliance.audit.view'),
    },
    {
      id: 'pack',
      label: 'Evidence pack',
      show: can('reports.export') && can('compliance.audit.view'),
    },
  ];
  // v36 groups the sections into four tabs with views. The URL keeps the section id (?tab=actions),
  // so existing links and alerts still open the right place; one this user cannot see is ignored.
  const groups: {
    id: string;
    label: string;
    subs: { id: string; label: string; views: string[] }[];
  }[] = [
    {
      id: 'g-audits',
      label: 'Audits & risks',
      subs: [
        {
          id: 's-audits',
          label: 'Audits & actions',
          views: ['programme', 'audits', 'actions', 'templates', 'selfaudit', 'review'],
        },
        { id: 's-risks', label: 'Risks', views: ['risks'] },
      ],
    },
    {
      id: 'g-incidents',
      label: 'Incidents & concerns',
      subs: [
        { id: 's-events', label: 'Incidents', views: ['events', 'report'] },
        { id: 's-feedback', label: 'Complaints', views: ['feedback'] },
        { id: 's-safeguarding', label: 'Safeguarding', views: ['safeguarding'] },
        { id: 's-speakup', label: 'Speak up', views: ['speakup'] },
      ],
    },
    {
      id: 'g-policies',
      label: 'Policies & governance',
      subs: [
        { id: 's-policies', label: 'Policies', views: ['policies'] },
        {
          id: 's-governance',
          label: 'Governance',
          views: ['meetings', 'fpp', 'registration', 'sop', 'contracts', 'pack'],
        },
      ],
    },
    {
      id: 'g-data',
      label: 'Notifications & data',
      subs: [
        { id: 's-notifications', label: 'CQC notifications', views: ['notifications'] },
        { id: 's-privacy', label: 'Data protection', views: ['privacy', 'dspt'] },
      ],
    },
  ];
  const VIEW_LABEL: Record<string, string> = {
    programme: 'Programme',
    audits: 'Audits',
    templates: 'Templates',
    selfaudit: 'CQC self-audit',
    actions: 'Actions',
    risks: 'Risks',
    review: 'Evidence review',
    events: 'Incidents',
    report: 'Report',
    feedback: 'Complaints & feedback',
    safeguarding: 'Safeguarding referrals',
    speakup: 'Speak up',
    policies: 'Policies',
    meetings: 'Meetings',
    fpp: 'Fit and proper',
    registration: 'Registration',
    contracts: 'NHS contracts',
    pack: 'Evidence pack',
    notifications: 'CQC notifications',
    privacy: 'Data protection',
    dspt: 'DSP Toolkit',
    sop: 'Statement of purpose',
  };
  const shown = new Set(tabs.filter((t) => t.show).map((t) => t.id));
  const visibleGroups = groups
    .map((g) => {
      const subs = g.subs
        .map((x) => ({ ...x, views: x.views.filter((v) => shown.has(v) && v !== 'report') }))
        .filter((x) => x.views.length > 0);
      return { ...g, subs, views: subs.flatMap((x) => x.views) };
    })
    .filter((g) => g.views.length > 0);
  const { tab: linked } = useSearch({ strict: false }) as { tab?: string };
  const tab =
    tabs.find((t) => t.id === linked && t.show)?.id ??
    (tabs.find((t) => t.id === 'audits' && t.show) ?? tabs.find((t) => t.show))?.id;
  const group = visibleGroups.find(
    (g) => g.views.includes(tab ?? '') || (tab === 'report' && g.id === 'g-incidents'),
  );
  const sub = group?.subs.find((x) => x.views.includes(tab === 'report' ? 'events' : (tab ?? '')));
  const navigate = useNavigate();
  const setTab = (id: string) => void navigate({ to: '/compliance', search: { tab: id } });
  const [reporting, setReporting] = useState(false);
  if (!orgId)
    return (
      <Alert type="info" showIcon role="status" message="Select an organisation to continue." />
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
      <PageHeader
        title="Compliance"
        description="Audits, incidents, policies, risks and regulatory governance for your organisation."
        extra={
          can('events.event.report') ? (
            <Button type="primary" onClick={() => setReporting(true)}>
              Report an incident
            </Button>
          ) : undefined
        }
      />
      <Tabs
        label="Compliance sections"
        current={group?.id ?? ''}
        onChange={(g) => setTab(visibleGroups.find((x) => x.id === g)!.views[0]!)}
        tabs={visibleGroups.map((g) => ({ id: g.id, label: g.label }))}
      >
        {!tab && (
          <Alert
            type="warning"
            showIcon
            role="alert"
            message="You do not have access to any compliance section."
          />
        )}
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
              value={tab ?? ''}
              onChange={setTab}
              options={sub.views.map((v) => ({ value: v, label: VIEW_LABEL[v] ?? v }))}
            />
          </Deeper>
        )}
        {tab === 'review' && <ReviewQueue />}
        {tab === 'programme' && <Audits part="programme" />}
        {tab === 'audits' && <Audits />}
        {tab === 'templates' && <Audits part="templates" />}
        {tab === 'selfaudit' && <CqcSelfAudit />}
        {tab === 'actions' && <Actions />}
        {tab === 'policies' && <Policies />}
        {tab === 'risks' && <Risks />}
        {tab === 'events' && <Events />}
        {tab === 'report' && <ReportIncident />}
        {tab === 'feedback' && <Feedback />}
        {tab === 'safeguarding' && <SafeguardingRegister />}
        {tab === 'speakup' && <SpeakUp />}
        {tab === 'registration' && <Registration />}
        {tab === 'meetings' && <Meetings />}
        {tab === 'fpp' && <FitAndProper />}
        {tab === 'contracts' && <NhsContracts />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'privacy' && <PrivacyPanel />}
        {tab === 'dspt' && <DsptToolkit />}
        {tab === 'sop' && <StatementOfPurpose />}
        {tab === 'pack' && <EvidencePack />}
      </Tabs>
      <Modal
        open={reporting}
        title="Report an incident"
        onCancel={() => setReporting(false)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        <ReportIncident />
      </Modal>
    </div>
  );
}

/** Uploads one file as evidence (no requirement link) and returns its evidence item id. */
async function uploadFile(api: ApiClient, orgId: string | null, file: File): Promise<string> {
  const req = (await api.send('POST', '/api/v1/evidence/uploads', orgId, {
    title: file.name.slice(0, 200),
    mime: file.type || 'application/pdf',
    sizeBytes: file.size,
  })) as Row;
  const put = await fetch(req.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/pdf' },
    body: file,
  });
  if (!put.ok) throw new Error('upload failed');
  await api.send('POST', `/api/v1/evidence/${req.evidenceVersionId}/complete`, orgId, {});
  return req.evidenceItemId as string;
}

/** Where an action's work is done, and how the next step reads. Access is still checked there. */
function actionWork(a: Row): {
  step: string;
  link: { to: string; params?: { id: string }; search?: { tab: string } };
} {
  const inRun = (step: string, id: string) => ({
    step,
    link: { to: '/compliance/audits/$id', params: { id } },
  });
  const inTab = (step: string, tab: string) => ({
    step,
    link: { to: '/compliance', search: { tab } },
  });
  if (a.kind === 'REAUDIT' && a.reauditRunId) return inRun('Complete the re-audit', a.reauditRunId);
  if (a.auditRunId) return inRun('Open the audit', a.auditRunId);
  if (a.sourceType === 'EVENT' && a.sourceId)
    return {
      step: 'Open the event',
      link: { to: '/compliance/events/$id', params: { id: a.sourceId } },
    };
  if (a.sourceType === 'EVENT') return inTab('Open the event', 'events');
  if (a.sourceType === 'FEEDBACK') return inTab('Open the feedback', 'feedback');
  if (a.sourceType === 'RISK') return inTab('Open the risk', 'risks');
  if (a.sourceType === 'MEETING') return inTab('Open the meeting', 'meetings');
  if (a.sourceType === 'PREMISES')
    return { step: 'Open the premises register', link: { to: '/premises' } };
  if (a.sourceType === 'CONTINUITY')
    return {
      step: 'Open the continuity plan',
      link: { to: '/planner', search: { tab: 'contracts' } },
    };
  return inTab('Open the registration records', 'registration');
}

/** `linked`: the table is away from the action's source, so rows link to it. */
export function ActionsTable({
  rows,
  caption,
  linked = false,
}: {
  rows: Row[];
  caption: string;
  linked?: boolean;
}) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<string | null>(null);
  /** Mirrors the API: the owner, or anyone who manages actions. A re-audit closes by completing it. */
  const canUpload = (a: Row) =>
    a.kind === 'ACTION' &&
    a.status !== 'VERIFIED' &&
    can('compliance.evidence.upload') &&
    (a.ownerUserId === me.user.id || can('compliance.action.manage'));
  const uploadButton = (a: Row) => {
    const label = a.status === 'EVIDENCE_SUBMITTED' ? 'Add evidence' : 'Upload evidence';
    return (
      <Button
        size="small"
        aria-label={`${label} for ${a.code}`}
        onClick={() => {
          uploadFor.current = a.id;
          fileRef.current?.click();
        }}
      >
        {label}
      </Button>
    );
  };
  const [verifying, setVerifying] = useState<{ a: Row; d: 'ACCEPTED' | 'REJECTED' } | null>(null);
  const [changing, setChanging] = useState<{ a: Row; owner: string; deadline: string } | null>(
    null,
  );
  const people = usePeople(can('compliance.action.manage'));
  return (
    <>
      {msg}
      <DataTable<Row>
        caption={caption}
        rows={rows}
        rowKey={(r) => r.id}
        emptyMessage="No actions."
        columns={[
          {
            key: 'c',
            header: 'Action',
            cell: (r) => {
              const title = `${r.code} ${r.title}${r.kind === 'REAUDIT' ? ' (re-audit)' : ''}`;
              return linked ? (
                <Link {...actionWork(r).link}>
                  <Typography.Link>{title}</Typography.Link>
                </Link>
              ) : (
                title
              );
            },
          },
          {
            key: 'o',
            header: 'Owner',
            cell: (r) =>
              r.ownerUserId === me.user.id
                ? `${r.ownerName ?? 'You'} (you)`
                : (r.ownerName ?? 'Someone else'),
          },
          {
            key: 'd',
            header: 'Deadline',
            cell: (r) =>
              r.overdue ? (
                <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(r.deadline)}`} />
              ) : (
                fmtDate(r.deadline)
              ),
          },
          {
            key: 's',
            header: 'State',
            cell: (r) => (
              <StatusBadge
                status={ACTION_STATUS[r.status]?.kind ?? 'GREY'}
                reason={ACTION_STATUS[r.status]?.text}
              />
            ),
          },
          {
            key: 'x',
            header: 'Next step',
            cell: (r) =>
              r.status === 'EVIDENCE_SUBMITTED' &&
              can('compliance.action.verify') &&
              r.ownerUserId !== me.user.id ? (
                <Space size="small">
                  <Button
                    size="small"
                    aria-label={`Verify ${r.code}`}
                    onClick={() => setVerifying({ a: r, d: 'ACCEPTED' })}
                  >
                    Verify
                  </Button>
                  <Button
                    size="small"
                    aria-label={`Reject ${r.code}`}
                    onClick={() => setVerifying({ a: r, d: 'REJECTED' })}
                  >
                    Reject
                  </Button>
                </Space>
              ) : r.status === 'EVIDENCE_SUBMITTED' ? (
                <Space wrap size="small">
                  Awaiting a verifier
                  {canUpload(r) && uploadButton(r)}
                </Space>
              ) : r.status === 'VERIFIED' ? null : canUpload(r) ? (
                uploadButton(r)
              ) : linked ? (
                <Link {...actionWork(r).link}>
                  <Typography.Link>{actionWork(r).step}</Typography.Link>
                </Link>
              ) : r.kind === 'REAUDIT' ? (
                'Complete the re-audit'
              ) : (
                'Awaiting evidence from the owner'
              ),
          },
          ...(can('compliance.action.manage')
            ? [
                {
                  key: 'm',
                  header: 'Manage',
                  cell: (r: Row) =>
                    r.status === 'VERIFIED' ? null : (
                      <Button
                        size="small"
                        aria-label={`Change owner or deadline for ${r.code} ${r.title}`}
                        onClick={() =>
                          setChanging({ a: r, owner: r.ownerUserId, deadline: r.deadline })
                        }
                      >
                        Change owner or deadline
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      <ActionDialog
        open={changing !== null}
        title={`Change ${changing?.a.code ?? ''} ${changing?.a.title ?? ''}`}
        confirmLabel="Save change"
        reasonLabel="Why is it changing? This is kept in the action's history"
        confirmDisabled={
          !changing ||
          !changing.deadline ||
          (changing.owner === changing.a.ownerUserId && changing.deadline === changing.a.deadline)
        }
        onCancel={() => setChanging(null)}
        onConfirm={(reason) =>
          api.send(
            'PATCH',
            `/api/v1/actions/${changing!.a.id}`,
            orgId,
            {
              ...(changing!.owner !== changing!.a.ownerUserId
                ? { ownerUserId: changing!.owner }
                : {}),
              ...(changing!.deadline !== changing!.a.deadline
                ? { deadline: changing!.deadline }
                : {}),
              reason,
            },
            changing!.a.version,
          )
        }
        fields={
          changing && (
            <div className="grid gap-3">
              <PersonSelect
                label="Owner"
                value={changing.owner}
                onChange={(id) => setChanging({ ...changing, owner: id })}
                people={people}
                meId={me.user.id}
              />
              <Field label="Deadline">
                <DatePicker
                  value={changing.deadline ? dayjs(changing.deadline) : null}
                  onChange={(d) =>
                    setChanging({ ...changing, deadline: d ? d.format('YYYY-MM-DD') : '' })
                  }
                  format="YYYY-MM-DD"
                  style={{ width: '100%' }}
                />
              </Field>
            </div>
          )
        }
      >
        <p>The new owner is responsible for the evidence. The change and reason are recorded.</p>
      </ActionDialog>
      <input
        ref={fileRef}
        type="file"
        className="sr-only"
        aria-label="Action evidence file"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = uploadFor.current;
          if (file && target)
            void run(async () => {
              const item = await uploadFile(api, orgId, file);
              await api.send('POST', `/api/v1/actions/${target}/evidence`, orgId, {
                evidenceItemIds: [item],
              });
            }, 'Evidence submitted. The action stays open until a verifier accepts it.');
          e.target.value = '';
        }}
      />
      <ActionDialog
        open={verifying !== null}
        title={`${verifying?.d === 'ACCEPTED' ? 'Verify' : 'Reject'} ${verifying?.a.code ?? ''} ${verifying?.a.title ?? ''}`}
        confirmLabel={verifying?.d === 'ACCEPTED' ? 'Verify and close' : 'Reject evidence'}
        danger={verifying?.d === 'REJECTED'}
        reasonLabel={
          verifying?.d === 'ACCEPTED'
            ? 'What did you check before accepting?'
            : 'Why is the evidence rejected? The owner sees this'
        }
        onCancel={() => setVerifying(null)}
        onConfirm={(reason) =>
          api.send('POST', `/api/v1/actions/${verifying!.a.id}/verify`, orgId, {
            decision: verifying!.d,
            reason,
          })
        }
      >
        <p>
          {verifying?.d === 'ACCEPTED'
            ? 'Verifying closes the action. Your name and what you checked are recorded.'
            : 'The action goes back to its owner for new evidence.'}
        </p>
      </ActionDialog>
    </>
  );
}

/** Registered locations with their manager and start date (WORKFLOWS I1); entries are kept. */
function RegisteredLocations({ rows }: { rows: Row[] }) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const people = usePeople(can('compliance.registration.manage'));
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
    can('compliance.registration.manage'),
  );
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const v = (k: string) => f[k] ?? '';
  const set = (k: string) => (x: string) => setF((p) => ({ ...p, [k]: x }));
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Section
      title="Registered locations"
      actions={
        can('compliance.registration.manage') ? (
          <Button size="small" onClick={() => setOpen(true)}>
            Record a location change
          </Button>
        ) : undefined
      }
    >
      {notice && <Alert type="success" showIcon role="status" message={notice} />}
      <DataTable<Row>
        caption="Registered locations"
        rows={rows}
        rowKey={(x) => x.id}
        emptyMessage="No registered locations recorded."
        columns={[
          { key: 'l', header: 'Location', cell: (x) => x.locationName ?? 'Location' },
          {
            key: 'm',
            header: 'Registered manager',
            cell: (x) =>
              !x.registeredManagerName
                ? 'None recorded'
                : x.managerStartOn
                  ? `${x.registeredManagerName} since ${fmtDate(x.managerStartOn)}`
                  : x.registeredManagerName,
          },
          {
            key: 'a',
            header: 'Activities',
            cell: (x) => ((x.activities as string[]) ?? []).join(', ') || 'None',
          },
          { key: 'c', header: 'Conditions', cell: (x) => x.conditions ?? 'None' },
          {
            key: 'e',
            header: 'From',
            cell: (x) => `${fmtDate(x.effectiveFrom)} – ${x.reason}`,
          },
        ]}
      />
      <ActionDialog
        open={open}
        title="Record a registered location change"
        confirmLabel="Save"
        reasonLabel="Reason for the change"
        confirmDisabled={!v('locationId') || !v('effectiveFrom')}
        onCancel={() => {
          setOpen(false);
          setF({});
        }}
        onConfirm={async (reason) => {
          const r = (await api.send('POST', '/api/v1/registration/locations', orgId, {
            locationId: v('locationId'),
            ...(v('manager') ? { registeredManagerUserId: v('manager') } : {}),
            ...(v('managerStartOn') ? { managerStartOn: v('managerStartOn') } : {}),
            activities: v('activities')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            ...(v('conditions').trim() ? { conditions: v('conditions').trim() } : {}),
            effectiveFrom: v('effectiveFrom'),
            reason,
          })) as Row;
          setNotice(
            r.notificationDraftId
              ? 'Saved. The manager changed, so a draft CQC notification was created for review.'
              : 'Saved.',
          );
        }}
        fields={
          <>
            <Field label="Location">
              <Select
                placeholder="Choose…"
                value={v('locationId') || undefined}
                onChange={set('locationId')}
                options={(locations.data?.data ?? []).map((l) => ({
                  value: String(l.id),
                  label: String(l.name),
                }))}
                style={{ width: '100%' }}
              />
            </Field>
            <PersonSelect
              label="Registered manager"
              value={v('manager')}
              onChange={set('manager')}
              people={people}
              meId={me.user.id}
              optional
            />
            <Field label="Manager start date">
              <DatePicker
                value={v('managerStartOn') ? dayjs(v('managerStartOn')) : null}
                onChange={(d) => set('managerStartOn')(d ? d.format('YYYY-MM-DD') : '')}
                format="YYYY-MM-DD"
                style={{ width: '100%' }}
              />
            </Field>
            <Field label="Regulated activities (comma separated)">
              <Input value={v('activities')} onChange={(e) => set('activities')(e.target.value)} />
            </Field>
            <Field label="Conditions">
              <Input value={v('conditions')} onChange={(e) => set('conditions')(e.target.value)} />
            </Field>
            <Field label="Effective from">
              <DatePicker
                value={v('effectiveFrom') ? dayjs(v('effectiveFrom')) : null}
                onChange={(d) => set('effectiveFrom')(d ? d.format('YYYY-MM-DD') : '')}
                format="YYYY-MM-DD"
                style={{ width: '100%' }}
              />
            </Field>
          </>
        }
      />
    </Section>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  FINDING: 'Audit finding',
  EVENT: 'Event',
  RISK: 'Risk',
  CORRESPONDENCE: 'Regulator correspondence',
  FEEDBACK: 'Feedback',
  MEETING: 'Governance meeting',
  PREMISES: 'Premises item',
  CONTINUITY: 'Continuity test',
};

/** Action log with filters (WORKFLOWS G3); only a different person verifies and closes. */
function Actions() {
  const { me } = useApp();
  const can = useCan();
  const people = usePeople(can('compliance.action.manage'));
  const [owner, setOwner] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const params = new URLSearchParams();
  if (owner) params.set('ownerUserId', owner);
  if (source) params.set('sourceType', source);
  if (status) params.set('status', status);
  if (overdue) params.set('overdue', 'true');
  const q = params.toString();
  const res = useOne<{ data: Row[] }>(`/api/v1/actions${q ? `?${q}` : ''}`);
  const filtered = !!(owner || source || status || overdue);
  return (
    <>
      <Card size="small" styles={{ body: { paddingBottom: 8 } }}>
        <form
          aria-label="Action filters"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => e.preventDefault()}
        >
          <Field label="Owner">
            <Select
              allowClear
              placeholder="Anyone"
              value={owner || undefined}
              onChange={(v) => setOwner(v ?? '')}
              options={[
                { value: me.user.id, label: 'Me' },
                ...people
                  .filter((p) => p.id !== me.user.id)
                  .map((p) => ({ value: p.id, label: p.displayName })),
              ]}
              style={{ minWidth: 160 }}
            />
          </Field>
          <Field label="Source">
            <Select
              allowClear
              placeholder="Any source"
              value={source || undefined}
              onChange={(v) => setSource(v ?? '')}
              options={Object.entries(SOURCE_LABEL).map(([k, label]) => ({ value: k, label }))}
              style={{ minWidth: 160 }}
            />
          </Field>
          <Field label="State">
            <Select
              allowClear
              placeholder="Any state"
              value={status || undefined}
              onChange={(v) => setStatus(v ?? '')}
              options={Object.entries(ACTION_STATUS).map(([k, s]) => ({ value: k, label: s.text }))}
              style={{ minWidth: 160 }}
            />
          </Field>
          <Checkbox checked={overdue} onChange={(e) => setOverdue(e.target.checked)}>
            Overdue only
          </Checkbox>
          {filtered && (
            <Button
              size="small"
              onClick={() => {
                setOwner('');
                setSource('');
                setStatus('');
                setOverdue(false);
              }}
            >
              Clear filters
            </Button>
          )}
        </form>
      </Card>
      {res.isError ? (
        <Alert type="error" showIcon role="alert" message="Could not load actions." />
      ) : (
        <ActionsTable rows={res.data?.data ?? []} caption="Open actions" linked />
      )}
    </>
  );
}

function Registration() {
  const reg = useOne<Row>('/api/v1/registration');
  const corr = useOne<{ data: Row[] }>('/api/v1/regulatory-correspondence');
  const r = reg.data;
  return (
    <>
      <Section title="Registration record">
        {r ? (
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: 'ref',
                label: 'Provider reference',
                children: r.providerRef ?? 'Not recorded',
              },
              {
                key: 'nom',
                label: 'Nominated individual',
                children: r.nominatedIndividual ?? 'Not recorded',
              },
              { key: 'cond', label: 'Conditions', children: r.conditions ?? 'None recorded' },
              {
                key: 'act',
                label: 'Registered activities',
                children: r.registeredActivities.length
                  ? r.registeredActivities.map((a: Row) => a.activity).join(', ')
                  : 'None recorded',
              },
              {
                key: 'ins',
                label: 'Insurance expires',
                children: r.insuranceExpiresOn ? fmtDate(r.insuranceExpiresOn) : 'Not recorded',
              },
              {
                key: 'bcp',
                label: 'Business continuity plan',
                children: (
                  <>
                    {r.bcpReviewedOn
                      ? `Reviewed ${fmtDate(r.bcpReviewedOn)}`
                      : 'Review not recorded'}
                    {r.bcpNextReviewOn ? `; next review ${fmtDate(r.bcpNextReviewOn)}` : ''}
                  </>
                ),
              },
            ]}
          />
        ) : (
          <Alert type="info" showIcon role="status" message="Loading…" />
        )}
      </Section>
      <RegistrationEditor record={r} />
      <RegisteredLocations rows={(r?.locations as Row[] | undefined) ?? []} />
      <RatingDisplay />
      <DataTable<Row>
        caption="Regulatory correspondence"
        rows={corr.data?.data ?? []}
        rowKey={(x) => x.id}
        emptyMessage="No correspondence."
        columns={[
          { key: 'r', header: 'Regulator', cell: (x) => x.regulator },
          { key: 's', header: 'Subject', cell: (x) => x.subject },
          {
            key: 'd',
            header: 'Deadline',
            cell: (x) =>
              !x.deadline ? (
                'None'
              ) : x.overdue ? (
                <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(x.deadline)}`} />
              ) : (
                fmtDate(x.deadline)
              ),
          },
          { key: 'st', header: 'Status', cell: (x) => words(x.status) },
        ]}
      />
    </>
  );
}

const PACK_SECTIONS: [string, string, boolean][] = [
  ['REQUIREMENTS', 'Requirements and verified evidence', true],
  ['AUDITS', 'Audits in the period', true],
  ['ACTIONS', 'Open actions', true],
  ['POLICIES', 'Published policies', true],
  [
    'GOVERNANCE',
    'Registration and governance (ratings as published, meetings, notifications)',
    false,
  ],
  ['CONTRACTS', 'NHS contracts', false],
];

function EvidencePack() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [noSections, setNoSections] = useState(false);
  const exports = useOne<{ data: Row[] }>('/api/v1/exports');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const sections = PACK_SECTIONS.filter(([k]) => f.get(`section-${k}`) === 'on').map(([k]) => k);
    if (sections.length === 0) {
      setNoSections(true);
      return;
    }
    setNoSections(false);
    await run(
      () =>
        api.send('POST', '/api/v1/evidence-packs', orgId, {
          from: String(f.get('from')),
          to: String(f.get('to')),
          ...(f.get('domain') ? { domain: String(f.get('domain')) } : {}),
          purpose: String(f.get('purpose')),
          sections,
          includeFiles: f.get('indexOnly') !== 'on',
          gapsOnly: f.get('gapsOnly') === 'on',
        }),
      'Requested. The pack is built in the background; refresh to see when it is ready.',
    );
  }
  const download = (id: string) =>
    void run(async () => {
      const x = (await api.get(`/api/v1/exports/${id}`, orgId)) as Row;
      if (x.download) window.location.assign(x.download.url);
    }, 'Download started (logged).');
  return (
    <>
      <Section title="Inspection evidence pack">
        <Typography.Paragraph type="secondary">
          An indexed PDF and ZIP of verified evidence, approvals, audits, open gaps and actions.
          Only what you are allowed to see is included. Internal measure — not a CQC rating.
        </Typography.Paragraph>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <Input type="date" name="from" required />
          </Field>
          <Field label="To">
            <Input type="date" name="to" required />
          </Field>
          <Field label="Key question">
            <select name="domain" defaultValue="" style={{ width: '100%', padding: '4px 11px' }}>
              <option value="">All</option>
              {['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED'].map((d) => (
                <option key={d} value={d}>
                  {words(d)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Who is it for?">
            <select
              name="purpose"
              defaultValue="INSPECTION"
              style={{ width: '100%', padding: '4px 11px' }}
            >
              <option value="INSPECTION">Inspection</option>
              <option value="NHS_CONTRACT">NHS commissioner (NHS contract items only)</option>
              <option value="INTERNAL">Internal review</option>
            </select>
          </Field>
          <Card size="small" title="Include" style={{ width: '100%' }}>
            <div className="grid gap-1 sm:grid-cols-2">
              {PACK_SECTIONS.map(([k, label, on]) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" name={`section-${k}`} defaultChecked={on} /> {label}
                </label>
              ))}
            </div>
          </Card>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="indexOnly" /> Index only (no evidence files)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="gapsOnly" /> Only requirements that are not met
          </label>
          <Button type="primary" htmlType="submit">
            Request pack
          </Button>
        </form>
        {noSections && (
          <Alert
            type="error"
            showIcon
            role="alert"
            message="Choose at least one section to include."
          />
        )}
        {msg}
      </Section>
      <DataTable<Row>
        caption="Your exports"
        rows={exports.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No exports yet."
        columns={[
          { key: 'k', header: 'Export', cell: (r) => words(r.kind) },
          {
            key: 'c',
            header: 'Requested',
            cell: (r) => fmtDateTime(r.createdAt),
          },
          { key: 's', header: 'Status', cell: (r) => words(r.status) },
          {
            key: 'd',
            header: 'Download',
            cell: (r) =>
              r.status === 'DONE' ? (
                <Button size="small" onClick={() => download(r.id)}>
                  Download
                </Button>
              ) : null,
          },
        ]}
      />
    </>
  );
}
