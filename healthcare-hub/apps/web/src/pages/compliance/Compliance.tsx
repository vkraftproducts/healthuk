import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  Tabs,
  button,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
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
  const tabs = [
    { id: 'review', label: 'Evidence review', show: can('compliance.evidence.verify') },
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
    { id: 'feedback', label: 'Feedback', show: can('events.event.view') },
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
      id: 'contracts',
      label: 'NHS contracts',
      show: can('compliance.registration.manage') || can('compliance.audit.view'),
    },
    {
      id: 'notifications',
      label: 'CQC notifications',
      show: can('events.event.manage') || can('compliance.registration.manage'),
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
  const tab =
    tabs.find((t) => t.id === linked && t.show)?.id ??
    (tabs.find((t) => t.id === 'audits' && t.show) ?? tabs.find((t) => t.show))?.id;
  const navigate = useNavigate();
  const setTab = (id: string) => void navigate({ to: '/compliance', search: { tab: id } });
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Compliance</h1>
      <Tabs label="Compliance sections" current={tab ?? ''} onChange={setTab} tabs={tabs}>
        {!tab && <p role="alert">You do not have access to any compliance section.</p>}
        {tab === 'review' && <ReviewQueue />}
        {tab === 'audits' && <Audits />}
        {tab === 'actions' && <Actions />}
        {tab === 'policies' && <Policies />}
        {tab === 'risks' && <Risks />}
        {tab === 'events' && <Events />}
        {tab === 'feedback' && <Feedback />}
        {tab === 'registration' && <Registration />}
        {tab === 'meetings' && <Meetings />}
        {tab === 'fpp' && <FitAndProper />}
        {tab === 'contracts' && <NhsContracts />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'pack' && <EvidencePack />}
      </Tabs>
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
                <div className="flex gap-2">
                  <button
                    className={smallButton}
                    aria-label={`Verify ${r.code}`}
                    onClick={() => setVerifying({ a: r, d: 'ACCEPTED' })}
                  >
                    Verify
                  </button>
                  <button
                    className={smallButton}
                    aria-label={`Reject ${r.code}`}
                    onClick={() => setVerifying({ a: r, d: 'REJECTED' })}
                  >
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
          ...(can('compliance.action.manage')
            ? [
                {
                  key: 'm',
                  header: 'Manage',
                  cell: (r: Row) =>
                    r.status === 'VERIFIED' ? null : (
                      <button
                        className={smallButton}
                        aria-label={`Change owner or deadline for ${r.code} ${r.title}`}
                        onClick={() =>
                          setChanging({ a: r, owner: r.ownerUserId, deadline: r.deadline })
                        }
                      >
                        Change owner or deadline
                      </button>
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
                <input
                  type="date"
                  className={input}
                  value={changing.deadline}
                  onChange={(e) => setChanging({ ...changing, deadline: e.target.value })}
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
          <button className={smallButton} onClick={() => setOpen(true)}>
            Record a location change
          </button>
        ) : undefined
      }
    >
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
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
              <select
                className={input}
                value={v('locationId')}
                onChange={(e) => set('locationId')(e.target.value)}
              >
                <option value="">Choose…</option>
                {(locations.data?.data ?? []).map((l) => (
                  <option key={String(l.id)} value={String(l.id)}>
                    {String(l.name)}
                  </option>
                ))}
              </select>
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
              <input
                type="date"
                className={input}
                value={v('managerStartOn')}
                onChange={(e) => set('managerStartOn')(e.target.value)}
              />
            </Field>
            <Field label="Regulated activities (comma separated)">
              <input
                className={input}
                value={v('activities')}
                onChange={(e) => set('activities')(e.target.value)}
              />
            </Field>
            <Field label="Conditions">
              <input
                className={input}
                value={v('conditions')}
                onChange={(e) => set('conditions')(e.target.value)}
              />
            </Field>
            <Field label="Effective from">
              <input
                type="date"
                className={input}
                value={v('effectiveFrom')}
                onChange={(e) => set('effectiveFrom')(e.target.value)}
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
      <form
        aria-label="Action filters"
        className="flex flex-wrap items-end gap-3 rounded-lg border border-hub-line bg-white p-3 text-sm"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field label="Owner">
          <select className={input} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            <option value={me.user.id}>Me</option>
            {people
              .filter((p) => p.id !== me.user.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Source">
          <select className={input} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Any source</option>
            {Object.entries(SOURCE_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="State">
          <select className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any state</option>
            {Object.entries(ACTION_STATUS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.text}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
          Overdue only
        </label>
        {filtered && (
          <button
            type="button"
            className={smallButton}
            onClick={() => {
              setOwner('');
              setSource('');
              setStatus('');
              setOverdue(false);
            }}
          >
            Clear filters
          </button>
        )}
      </form>
      {res.isError ? (
        <p role="alert">Could not load actions.</p>
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
            <dt className="font-semibold">Insurance expires</dt>
            <dd>{r.insuranceExpiresOn ? fmtDate(r.insuranceExpiresOn) : 'Not recorded'}</dd>
            <dt className="font-semibold">Business continuity plan</dt>
            <dd>
              {r.bcpReviewedOn ? `Reviewed ${fmtDate(r.bcpReviewedOn)}` : 'Review not recorded'}
              {r.bcpNextReviewOn ? `; next review ${fmtDate(r.bcpNextReviewOn)}` : ''}
            </dd>
          </dl>
        ) : (
          <p role="status">Loading…</p>
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
          <Field label="Who is it for?">
            <select name="purpose" className={input} defaultValue="INSPECTION">
              <option value="INSPECTION">Inspection</option>
              <option value="NHS_CONTRACT">NHS commissioner (NHS contract items only)</option>
              <option value="INTERNAL">Internal review</option>
            </select>
          </Field>
          <fieldset className="w-full">
            <legend className="text-sm font-semibold">Include</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {PACK_SECTIONS.map(([k, label, on]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={`section-${k}`} defaultChecked={on} /> {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="indexOnly" /> Index only (no evidence files)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="gapsOnly" /> Only requirements that are not met
          </label>
          <button className={button}>Request pack</button>
        </form>
        {noSections && <p role="alert">Choose at least one section to include.</p>}
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
