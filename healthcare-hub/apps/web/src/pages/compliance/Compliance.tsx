import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, type FormEvent } from 'react';
import {
  Field,
  Section,
  Tabs,
  button,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import type { ApiClient } from '../../api.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ACTION_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  OPEN: { kind: 'RED', text: 'Open' },
  EVIDENCE_SUBMITTED: { kind: 'AMBER', text: 'Evidence awaiting verification' },
  VERIFIED: { kind: 'GREEN', text: 'Verified' },
  REJECTED: { kind: 'RED', text: 'Evidence rejected' },
};
const RISK_KIND: Record<string, StatusKind> = {
  LOW: 'GREEN',
  MEDIUM: 'AMBER',
  HIGH: 'RED',
  EXTREME: 'RED',
};
const ACK_TEXT: Record<string, string> = {
  CURRENT: 'Acknowledged',
  CARRIED_FORWARD: 'Acknowledged (minor change since)',
  REQUIRED: 'You need to read and acknowledge this',
  NO_PUBLISHED_VERSION: 'Not published yet',
  NOT_A_READER: 'Not required for your role',
};

export function Compliance() {
  const can = useCan();
  const { orgId } = useApp();
  const tabs = [
    { id: 'audits', label: 'Audits', show: can('compliance.audit.view') },
    {
      id: 'actions',
      label: 'Actions',
      show: can('compliance.audit.view') || can('compliance.action.manage'),
    },
    {
      id: 'policies',
      label: 'Policies',
      show: can('compliance.policy.manage') || can('compliance.policy.acknowledge'),
    },
    {
      id: 'risks',
      label: 'Risk register',
      show: can('compliance.risk.manage') || can('compliance.audit.view'),
    },
    { id: 'events', label: 'Events', show: can('events.event.view') },
    {
      id: 'registration',
      label: 'Registration',
      show: can('compliance.registration.manage') || can('compliance.audit.view'),
    },
    {
      id: 'pack',
      label: 'Evidence pack',
      show: can('reports.export') && can('compliance.audit.view'),
    },
  ];
  // The tab lives in the URL, so links can open one and Back returns to it; one this user cannot
  // see is ignored.
  const { tab: linked } = useSearch({ strict: false }) as { tab?: string };
  const tab = tabs.find((t) => t.id === linked && t.show)?.id ?? 'audits';
  const navigate = useNavigate();
  const setTab = (id: string) => void navigate({ to: '/compliance', search: { tab: id } });
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Compliance</h1>
      <Tabs label="Compliance sections" current={tab} onChange={setTab} tabs={tabs}>
        {tab === 'audits' && <Audits />}
        {tab === 'actions' && <Actions />}
        {tab === 'policies' && <Policies />}
        {tab === 'risks' && <Risks />}
        {tab === 'events' && <Events />}
        {tab === 'registration' && <Registration />}
        {tab === 'pack' && <EvidencePack />}
      </Tabs>
    </div>
  );
}

function Audits() {
  const runs = useOne<{ data: Row[] }>('/api/v1/audit-runs');
  const templates = useOne<{ data: Row[] }>('/api/v1/audit-templates');
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  return (
    <>
      {msg}
      <DataTable<Row>
        caption="Audit schedule"
        rows={runs.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={runs.isLoading}
        error={runs.isError ? 'Could not load audits.' : null}
        emptyMessage="No audits scheduled."
        columns={[
          {
            key: 'c',
            header: 'Audit',
            cell: (r) => (
              <Link
                to="/compliance/audits/$id"
                params={{ id: r.id }}
                className="font-medium text-hub-teal-dark underline"
              >{`${r.code} ${r.title}`}</Link>
            ),
          },
          { key: 't', header: 'Control', cell: (r) => `${r.templateCode} (${words(r.domain)})` },
          { key: 'd', header: 'Due', cell: (r) => r.dueDate },
          { key: 's', header: 'Stage', cell: (r) => words(r.status) },
          {
            key: 'o',
            header: 'Outcome',
            cell: (r) =>
              r.outcome ? (
                <StatusBadge status={r.outcome as StatusKind} reason={r.outcomeReason} />
              ) : (
                'Not submitted'
              ),
          },
        ]}
      />
      <DataTable<Row>
        caption="Audit templates"
        rows={templates.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={templates.isLoading}
        emptyMessage="No templates."
        columns={[
          { key: 'c', header: 'Code', cell: (r) => r.code },
          { key: 't', header: 'Title', cell: (r) => r.title },
          {
            key: 'v',
            header: 'Version',
            cell: (r) => `v${r.versions[0]?.version} ${words(r.versions[0]?.status)}`,
          },
          {
            key: 'a',
            header: 'Active',
            cell: (r) => (r.active ? 'Active' : 'Inactive – awaiting approval'),
          },
          {
            key: 'x',
            header: 'Action',
            cell: (r) =>
              !r.active &&
              r.versions.some((v: Row) => v.status === 'PUBLISHED') &&
              can('compliance.requirement.manage') ? (
                <button
                  className={smallButton}
                  onClick={() =>
                    void run(
                      () => api.send('POST', `/api/v1/audit-templates/${r.id}/activate`, orgId, {}),
                      'Template activated.',
                    )
                  }
                >
                  Activate
                </button>
              ) : !r.active && r.versions[0]?.status === 'DRAFT' && can('compliance.audit.run') ? (
                <button
                  className={smallButton}
                  onClick={() =>
                    void run(
                      () =>
                        api.send(
                          'POST',
                          `/api/v1/audit-templates/${r.id}/versions/${r.versions[0].id}/publish`,
                          orgId,
                          {},
                        ),
                      'Published.',
                    )
                  }
                >
                  Publish
                </button>
              ) : null,
          },
        ]}
      />
    </>
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
  if (a.sourceType === 'EVENT') return inTab('Open the event', 'events');
  if (a.sourceType === 'RISK') return inTab('Open the risk', 'risks');
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
      <button
        className={smallButton}
        aria-label={`${label} for ${a.code}`}
        onClick={() => {
          uploadFor.current = a.id;
          fileRef.current?.click();
        }}
      >
        {label}
      </button>
    );
  };
  const verify = (a: Row, decision: 'ACCEPTED' | 'REJECTED') => {
    const reason = window.prompt(
      decision === 'ACCEPTED'
        ? 'What did you check before accepting?'
        : 'Why is the evidence rejected?',
    );
    if (!reason || reason.trim().length < 3) return;
    void run(
      () =>
        api.send('POST', `/api/v1/actions/${a.id}/verify`, orgId, {
          decision,
          reason: reason.trim(),
        }),
      decision === 'ACCEPTED' ? 'Action verified.' : 'Evidence rejected.',
    );
  };
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
                <Link {...actionWork(r).link} className="font-medium text-hub-teal-dark underline">
                  {title}
                </Link>
              ) : (
                title
              );
            },
          },
          {
            key: 'o',
            header: 'Owner',
            cell: (r) => (r.ownerUserId === me.user.id ? 'You' : 'Assigned'),
          },
          {
            key: 'd',
            header: 'Deadline',
            cell: (r) => `${r.deadline}${r.overdue ? ' (overdue)' : ''}`,
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
                <div className="flex gap-2">
                  <button className={smallButton} onClick={() => verify(r, 'ACCEPTED')}>
                    Verify
                  </button>
                  <button className={smallButton} onClick={() => verify(r, 'REJECTED')}>
                    Reject
                  </button>
                </div>
              ) : r.status === 'EVIDENCE_SUBMITTED' ? (
                <div className="flex flex-wrap items-center gap-2">
                  Awaiting a verifier
                  {canUpload(r) && uploadButton(r)}
                </div>
              ) : r.status === 'VERIFIED' ? null : canUpload(r) ? (
                uploadButton(r)
              ) : linked ? (
                <Link {...actionWork(r).link} className="font-medium text-hub-teal-dark underline">
                  {actionWork(r).step}
                </Link>
              ) : r.kind === 'REAUDIT' ? (
                'Complete the re-audit'
              ) : (
                'Awaiting evidence from the owner'
              ),
          },
        ]}
      />
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
    </>
  );
}

function Actions() {
  const res = useOne<{ data: Row[] }>('/api/v1/actions');
  if (res.isError) return <p role="alert">Could not load actions.</p>;
  return <ActionsTable rows={res.data?.data ?? []} caption="Open actions" linked />;
}

function Policies() {
  const res = useOne<{ data: Row[] }>('/api/v1/policies');
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const next = (p: Row) => {
    const v = p.versions.find((x: Row) => ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(x.status));
    if (!v) return null;
    const to =
      v.status === 'DRAFT' ? 'IN_REVIEW' : v.status === 'IN_REVIEW' ? 'APPROVED' : 'PUBLISHED';
    return (
      <button
        className={smallButton}
        onClick={() =>
          void run(
            () =>
              api.send('POST', `/api/v1/policies/${p.id}/versions/${v.id}/transition`, orgId, {
                to,
              }),
            `Version ${v.version} moved to ${words(to)}.`,
          )
        }
      >
        {to === 'IN_REVIEW' ? 'Send for review' : to === 'APPROVED' ? 'Approve' : 'Publish'} v
        {v.version}
      </button>
    );
  };
  return (
    <>
      {msg}
      <DataTable<Row>
        caption="Policies and SOPs"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load policies.' : null}
        emptyMessage="No policies."
        columns={[
          { key: 'c', header: 'Policy', cell: (r) => `${r.code} ${r.title}` },
          {
            key: 'v',
            header: 'Current',
            cell: (r) =>
              r.currentVersion
                ? `v${r.currentVersion.version} from ${r.currentVersion.effectiveFrom}`
                : 'Not published',
          },
          {
            key: 'a',
            header: 'Acknowledged (current version)',
            cell: (r) =>
              r.currentVersion
                ? `${r.acknowledgement.acknowledged} of ${r.acknowledgement.required}`
                : '—',
          },
          { key: 'm', header: 'You', cell: (r) => ACK_TEXT[r.myAcknowledgement] },
          {
            key: 'x',
            header: 'Action',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                {r.myAcknowledgement === 'REQUIRED' && can('compliance.policy.acknowledge') && (
                  <button
                    className={smallButton}
                    onClick={() =>
                      void run(
                        () => api.send('POST', `/api/v1/policies/${r.id}/acknowledge`, orgId, {}),
                        'Acknowledged.',
                      )
                    }
                  >
                    Acknowledge
                  </button>
                )}
                {can('compliance.policy.manage') && next(r)}
              </div>
            ),
          },
        ]}
      />
    </>
  );
}

function Risks() {
  const res = useOne<{ data: Row[] }>('/api/v1/risks');
  return (
    <DataTable<Row>
      caption="Risk register"
      rows={res.data?.data ?? []}
      rowKey={(r) => r.id}
      loading={res.isLoading}
      error={res.isError ? 'Could not load risks.' : null}
      emptyMessage="No risks recorded."
      columns={[
        { key: 'c', header: 'Risk', cell: (r) => `${r.code} ${r.hazard}` },
        { key: 'p', header: 'People affected', cell: (r) => r.peopleAffected },
        {
          key: 'i',
          header: 'Inherent',
          cell: (r) => (
            <StatusBadge
              status={RISK_KIND[r.inherent.rating] ?? 'GREY'}
              reason={`${words(r.inherent.rating)} (${r.inherent.score})`}
            />
          ),
        },
        {
          key: 'r',
          header: 'Residual',
          cell: (r) => (
            <StatusBadge
              status={RISK_KIND[r.residual.rating] ?? 'GREY'}
              reason={`${words(r.residual.rating)} (${r.residual.score})`}
            />
          ),
        },
        {
          key: 'd',
          header: 'Review',
          cell: (r) => `${r.reviewDate}${r.reviewOverdue ? ' (overdue)' : ''}`,
        },
      ]}
    />
  );
}

function Events() {
  const res = useOne<{ data: Row[] }>('/api/v1/events?open=true');
  return (
    <DataTable<Row>
      caption="Open events"
      rows={res.data?.data ?? []}
      rowKey={(r) => r.id}
      loading={res.isLoading}
      error={res.isError ? 'Could not load events.' : null}
      emptyMessage="No open events."
      columns={[
        { key: 'c', header: 'Event', cell: (r) => `${r.code} ${r.title}` },
        { key: 't', header: 'Type', cell: (r) => r.types.map(words).join(', ') },
        { key: 's', header: 'Severity', cell: (r) => words(r.severity) },
        { key: 'st', header: 'Stage', cell: (r) => words(r.status) },
        {
          key: 'f',
          header: 'Flags',
          cell: (r) =>
            [
              r.candourFlag && 'Possible duty of candour (a person decides)',
              r.restricted && 'Restricted',
            ]
              .filter(Boolean)
              .join('; ') || '—',
        },
      ]}
    />
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Provider reference</dt>
            <dd>{r.providerRef ?? 'Not recorded'}</dd>
            <dt className="font-semibold">Nominated individual</dt>
            <dd>{r.nominatedIndividual ?? 'Not recorded'}</dd>
            <dt className="font-semibold">Conditions</dt>
            <dd>{r.conditions ?? 'None recorded'}</dd>
            <dt className="font-semibold">Registered activities</dt>
            <dd>
              {r.registeredActivities.length
                ? r.registeredActivities.map((a: Row) => a.activity).join(', ')
                : 'None recorded'}
            </dd>
          </dl>
        ) : (
          <p role="status">Loading…</p>
        )}
      </Section>
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
            cell: (x) => (x.deadline ? `${x.deadline}${x.overdue ? ' (overdue)' : ''}` : '—'),
          },
          { key: 'st', header: 'Status', cell: (x) => words(x.status) },
        ]}
      />
    </>
  );
}

function EvidencePack() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const exports = useOne<{ data: Row[] }>('/api/v1/exports');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      () =>
        api.send('POST', '/api/v1/evidence-packs', orgId, {
          from: String(f.get('from')),
          to: String(f.get('to')),
          ...(f.get('domain') ? { domain: String(f.get('domain')) } : {}),
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
        <p className="text-sm">
          An indexed PDF and ZIP of verified evidence, approvals, audits, open gaps and actions.
          Only what you are allowed to see is included. Internal measure — not a CQC rating.
        </p>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="From">
            <input type="date" name="from" required className={input} />
          </Field>
          <Field label="To">
            <input type="date" name="to" required className={input} />
          </Field>
          <Field label="Key question">
            <select name="domain" className={input}>
              <option value="">All</option>
              {['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED'].map((d) => (
                <option key={d} value={d}>
                  {words(d)}
                </option>
              ))}
            </select>
          </Field>
          <button className={button}>Request pack</button>
        </form>
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
            cell: (r) =>
              new Date(r.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
          },
          { key: 's', header: 'Status', cell: (r) => words(r.status) },
          {
            key: 'd',
            header: 'Download',
            cell: (r) =>
              r.status === 'DONE' ? (
                <button className={smallButton} onClick={() => download(r.id)}>
                  Download
                </button>
              ) : null,
          },
        ]}
      />
    </>
  );
}
