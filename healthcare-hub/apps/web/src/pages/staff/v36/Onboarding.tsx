// v36 Staff › Onboarding: the pipeline board, the person file and the evidence review queue.
// Everything here reads and writes through existing endpoints; the server enforces every rule
// (two-person verification, lifecycle gates, role approval), the UI only explains them.
import { Link } from '@tanstack/react-router';
import { CloseOutlined, FileSearchOutlined, SendOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Steps,
  Table,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { ActionDialog, Field, errText, fmtDate } from '../../../components.js';
import { useApp } from '../../../shell/AppContext.js';
import { useInvalidate, useOne } from '../../settings/hooks.js';
import { DataTable } from '@hub/ui';
import { useNavigate } from '@tanstack/react-router';
import { DecisionDialog, UploadDialog, openEvidence } from '../../evidence/Evidence.js';
import { Mut, RuleNote, StatusTag, day, initials, toneOf, type Tone } from '../../../v36/kit.js';
import { LIFECYCLE_LABEL, RESTRICTION_LABEL, ROLE_LABEL } from '../labels.js';
import { checkCount } from './shared.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const STAGES = [
  'CANDIDATE',
  'CHECKS_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'APPROVED_FOR_ROLE',
  'ACTIVE',
] as const;
import { Deeper, RowActions, ViewSwitch, WfCard, WfSearch, WfTag } from '../../../v36/ui.js';

/** Documents waiting for a second person, counted per person (from the review queue). */
function usePendingByStaff() {
  const { me, orgId } = useApp();
  const q = useOne<{ data: Row[] }>(
    orgId && me.permissions.includes('compliance.evidence.verify')
      ? '/api/v1/evidence/review-queue'
      : null,
  );
  return useMemo(() => {
    const m = new Map<string, number>();
    for (const d of q.data?.data ?? [])
      for (const r of (d.requirements as Row[]) ?? [])
        if (r.subjectType === 'STAFF') m.set(r.subjectId, (m.get(r.subjectId) ?? 0) + 1);
    return m;
  }, [q.data]);
}

/** One segment per check (v36 `.wf-strip`): verified, due soon, to verify, overdue, missing. */
function stripOf(r: Row, pending: number): string[] {
  const c = r.counts as { red: number; amber: number; grey: number; green: number };
  if (r.checksSetUp === false) return [];
  const blue = Math.min(pending, c.grey);
  return [
    ...Array<string>(c.green).fill('g'),
    ...Array<string>(c.amber).fill('a'),
    ...Array<string>(blue).fill('b'),
    ...Array<string>(c.red).fill('r'),
    ...Array<string>(c.grey - blue).fill(''),
  ];
}

/** Days each starter stage should take (v36 "Day 17 of 21 in stage"). */
const STAGE_DAYS: Record<string, number> = {
  CANDIDATE: 5,
  CHECKS_IN_PROGRESS: 21,
  READY_FOR_REVIEW: 3,
  APPROVED_FOR_ROLE: 5,
};
const monthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const dayMonth = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function PersonCard({
  r,
  pending,
  selected,
  onOpen,
}: {
  r: Row;
  pending: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const c = checkCount(r);
  const counts = r.counts as { red: number; amber: number; grey: number; green: number };
  const outstanding = counts.red + Math.max(0, counts.grey - pending);
  const active = r.lifecycleState === 'ACTIVE';
  const role =
    r.jobTitle ||
    (r.roles as string[]).map((x) => ROLE_LABEL[x] ?? x).join(', ') ||
    'Role not chosen';
  const when = r.startDate
    ? active
      ? ` · since ${monthYear(r.startDate as string)}`
      : ` · starts ${dayMonth(r.startDate as string)}`
    : '';
  const target = STAGE_DAYS[r.lifecycleState as string];
  const day = r.stageSince
    ? Math.max(1, Math.ceil((Date.now() - Date.parse(r.stageSince as string)) / 86_400_000))
    : null;
  const strip = stripOf(r, pending);
  return (
    <button
      type="button"
      className={`wf-pc${selected ? ' on' : ''}`}
      aria-pressed={selected}
      aria-label={`${r.displayName as string}, ${r.staffNo as string}`}
      onClick={onOpen}
    >
      <span className="pchead">
        <span
          className="wf-av"
          style={{ background: `hsl(${hueOf(r.displayName)} 50% 32%)` }}
          aria-hidden="true"
        >
          {initials(r.displayName)}
        </span>
        <span>
          <b>{r.displayName}</b>
          <small>
            {r.staffNo} · {role}
            {when}
          </small>
        </span>
      </span>
      {c.total === 0 ? (
        r.lifecycleState === 'CANDIDATE' || r.lifecycleState === 'CHECKS_IN_PROGRESS' ? (
          <WfTag tone="grey" icon="radio_button_unchecked">
            Not started
          </WfTag>
        ) : (
          <WfTag tone="red" icon="error">
            No checks set up
          </WfTag>
        )
      ) : (
        <>
          <span className="wf-strip" aria-hidden="true">
            {strip.map((k, i) => (
              <i key={i} className={k} />
            ))}
          </span>
          <small>
            {c.done} of {c.total} checks verified
          </small>
        </>
      )}
      {(r.followUpsOverdue as number) > 0 && (
        <WfTag tone="red" icon="error">
          {r.followUpsOverdue} follow-up{r.followUpsOverdue === 1 ? '' : 's'} overdue
        </WfTag>
      )}
      {pending > 0 && (
        <WfTag tone="blue" icon="hourglass_top">
          {pending} to verify
        </WfTag>
      )}
      {r.lifecycleState === 'READY_FOR_REVIEW' && (
        <WfTag tone="purple" icon="gavel">
          Awaiting sign-off
        </WfTag>
      )}
      {!active &&
        c.total > 0 &&
        outstanding > 0 &&
        pending === 0 &&
        !(r.followUpsOverdue as number) &&
        r.lifecycleState !== 'READY_FOR_REVIEW' && (
          <WfTag tone="amber" icon="schedule">
            {outstanding} outstanding
          </WfTag>
        )}
      {active && c.total > 0 && outstanding > 0 && (
        <WfTag tone="amber" icon="schedule">
          {outstanding} outstanding
        </WfTag>
      )}
      {active && c.total > 0 && outstanding === 0 && pending === 0 && (
        <WfTag tone="green" icon="check_circle">
          All verified
        </WfTag>
      )}
      {(r.activeRestrictions as string[]).length > 0 && (
        <WfTag tone="amber" icon="front_hand">
          Restricted
        </WfTag>
      )}
      {target !== undefined && day !== null && (
        <span className="stg">
          {' '}
          <WfTag tone={day > target ? 'red' : day >= target * 0.8 ? 'amber' : 'grey'} icon="timer">
            Day {day} of {target} in stage
          </WfTag>
        </span>
      )}
    </button>
  );
}

function hueOf(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** v36 Pipeline: starters by stage; selecting a person opens their file below the board. */
export function Pipeline() {
  const res = useOne<{ data: Row[] }>('/api/v1/staff?limit=100');
  const pending = usePendingByStaff();
  const [text, setText] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const t = text.trim().toLowerCase();
  const people = (res.data?.data ?? []).filter(
    (r) =>
      r.counts &&
      (!t || `${r.displayName} ${r.staffNo} ${r.jobTitle ?? ''}`.toLowerCase().includes(t)),
  );
  const cols = [
    ...STAGES,
    ...(people.some((r) => r.lifecycleState === 'SUSPENDED') ? (['SUSPENDED'] as const) : []),
  ];
  return (
    <>
      <WfCard
        title="Starters by stage"
        extra={<span className="wf-mini">Click a person to open their file</span>}
      >
        <div className="pc-tools rec-f in-card">
          <WfSearch value={text} onChange={setText} />
        </div>
        {res.isError && (
          <Alert
            type="error"
            showIcon
            message="Source unavailable: the staff list could not be loaded."
          />
        )}
        {res.isLoading ? (
          <Spin />
        ) : (
          <div className="wf-board">
            {cols.map((st) => {
              const inCol = people.filter((r) => r.lifecycleState === st);
              return (
                <section key={st} className="wf-col" aria-label={LIFECYCLE_LABEL[st]}>
                  <h4>
                    <span>{LIFECYCLE_LABEL[st]}</span>
                    <span>{inCol.length}</span>
                  </h4>
                  {inCol.map((r) => (
                    <PersonCard
                      key={r.id}
                      r={r}
                      pending={pending.get(r.id) ?? 0}
                      selected={sel === r.id}
                      onOpen={() => setSel(sel === r.id ? null : r.id)}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </WfCard>
      {sel && <PersonFile id={sel} onClose={() => setSel(null)} />}
    </>
  );
}

const CHASE_KIND: { kind: string; match: RegExp }[] = [
  { kind: 'REFERENCE', match: /reference/i },
  { kind: 'DBS', match: /\bdbs\b|disclosure/i },
  { kind: 'RIGHT_TO_WORK', match: /right to work/i },
];
const chaseKindOf = (title: string) => CHASE_KIND.find((k) => k.match.test(title))?.kind ?? null;

/** Status of one check in words (text + icon + colour). */
function checkStatus(c: Row, latest: Row | null): { tone: Tone; text: string } {
  if (latest?.state === 'PENDING_VERIFICATION')
    return { tone: 'blue', text: 'Received – awaiting verification' };
  if (latest?.state === 'REJECTED' && c.status !== 'GREEN')
    return { tone: 'red', text: 'Rejected – ask again' };
  return { tone: toneOf(c.status), text: c.reasonText ?? '—' };
}

/** The latest document for one check, with who uploaded and who verified it. */
function useLatest(instanceId: string) {
  const q = useOne<{ data: Row[] }>(`/api/v1/requirements/instances/${instanceId}/evidence`);
  return (q.data?.data ?? [])[0] ?? null;
}

function DocCell({ c }: { c: Row }) {
  const { api, orgId } = useApp();
  const d = useLatest(c.id);
  if (!d) return <>—</>;
  return (
    <>
      <Button
        type="link"
        size="small"
        style={{ padding: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }}
        onClick={() => void openEvidence(api, orgId, d.id).catch(() => undefined)}
      >
        {d.title}
      </Button>
      <div>
        <Mut>
          by {d.uploadedByName ?? 'a colleague'} · {day(d.uploadedAt)}
        </Mut>
      </div>
    </>
  );
}
function VerifiedCell({ c }: { c: Row }) {
  const d = useLatest(c.id);
  if (!d?.decidedAt) return <>—</>;
  return (
    <>
      {d.reviewerName ?? 'A colleague'}
      <div>
        <Mut>{day(d.decidedAt)}</Mut>
      </div>
    </>
  );
}
function StatusCell({ c }: { c: Row }) {
  const d = useLatest(c.id);
  const s = checkStatus(c, d);
  return <StatusTag tone={s.tone}>{s.text}</StatusTag>;
}

function ChaseCell({ c, chase }: { c: Row; chase: Row[] }) {
  const kind = chaseKindOf(c.templateTitle);
  const e = kind ? chase.find((x) => x.kind === kind) : undefined;
  if (!e) return <>—</>;
  return (
    <span style={{ fontSize: 13 }}>
      {e.requestedOn && <div>Requested {day(e.requestedOn)}</div>}
      {e.chasedOn && <div>Chased {day(e.chasedOn)}</div>}
      {e.receivedOn && <div>Received {day(e.receivedOn)}</div>}
    </span>
  );
}

function ActionsCell({
  c,
  chase,
  onUpload,
  onVerify,
  onChase,
}: {
  c: Row;
  chase: Row[];
  onUpload: (c: Row) => void;
  onVerify: (d: Row, c: Row) => void;
  onChase: (c: Row, step: 'request' | 'chase' | 'received', entry?: Row) => void;
}) {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const d = useLatest(c.id);
  const kind = chaseKindOf(c.templateTitle);
  const e = kind ? chase.find((x) => x.kind === kind) : undefined;
  const mine = d && d.uploadedBy === me.user.id;
  return (
    <Space size={4} wrap>
      {d?.state === 'PENDING_VERIFICATION' && can('compliance.evidence.verify') && !mine && (
        <Button size="small" type="primary" onClick={() => onVerify(d, c)}>
          Verify<span className="sr-only"> {c.templateTitle}</span>
        </Button>
      )}
      {d?.state === 'PENDING_VERIFICATION' && mine && (
        <Mut>You uploaded this – someone else verifies</Mut>
      )}
      {d?.state !== 'PENDING_VERIFICATION' && can('compliance.evidence.upload') && (
        <Button size="small" onClick={() => onUpload(c)}>
          {c.currentlyVerified ? 'Renewal' : 'Upload'}
          <span className="sr-only"> for {c.templateTitle}</span>
        </Button>
      )}
      {kind && !d && can('staff.profile.manage') && !c.currentlyVerified && (
        <>
          {!e && (
            <Button size="small" onClick={() => onChase(c, 'request')}>
              Request<span className="sr-only"> {c.templateTitle}</span>
            </Button>
          )}
          {e && !e.receivedOn && (
            <>
              <Button size="small" onClick={() => onChase(c, 'chase', e)}>
                Chase<span className="sr-only"> {c.templateTitle}</span>
              </Button>
              <Button size="small" onClick={() => onChase(c, 'received', e)}>
                Received<span className="sr-only"> {c.templateTitle}</span>
              </Button>
            </>
          )}
        </>
      )}
    </Space>
  );
}

/** v36 person file: stage, every check with its document and verifier, chasing, and the next step. */
export function PersonFile({ id, onClose }: { id: string; onClose?: () => void }) {
  const { me, api, orgId } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const res = useOne<Row>(`/api/v1/staff/${id}`);
  const chaseQ = useOne<{ data: Row[] }>(
    can('staff.profile.manage') || can('staff.profile.view_basic')
      ? `/api/v1/staff/${id}/chase-log`
      : null,
  );
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [upload, setUpload] = useState<Row | null>(null);
  const [verify, setVerify] = useState<{ d: Row; c: Row } | null>(null);
  const [move, setMove] = useState<string | null>(null);
  const [chase, setChase] = useState<{
    c: Row;
    step: 'request' | 'chase' | 'received';
    entry?: Row;
  } | null>(null);
  if (res.isLoading)
    return (
      <Card>
        <Spin />
      </Card>
    );
  if (res.isError || !res.data)
    return <Alert type="error" showIcon message="This staff record is not available." />;
  const s = res.data;
  const close = onClose && (
    <Button
      size="small"
      icon={<CloseOutlined />}
      onClick={onClose}
      aria-label="Close person file"
    />
  );
  const title = (
    <span>
      {s.displayName}{' '}
      <Typography.Text type="secondary" style={{ fontWeight: 500 }}>
        · {s.staffNo}
        {s.jobTitle ? ` · ${s.jobTitle as string}` : ''}
      </Typography.Text>
    </span>
  );
  if (!('requirements' in s))
    return (
      <Card title={title} extra={close}>
        <Alert
          type="info"
          showIcon
          message="Dispatcher view shows approved roles and restrictions only."
        />
      </Card>
    );
  const chaseLog = chaseQ.data?.data ?? [];
  const reqs = (s.requirements as Row[]).filter((c) => {
    const tt = text.trim().toLowerCase();
    return (
      (!status || toneOf(c.status) === status) &&
      (!tt || `${c.templateTitle} ${c.templateCode ?? ''}`.toLowerCase().includes(tt))
    );
  });
  const noRole = (s.roles as string[]).length === 0;
  const required = reqs.filter((c) => noRole || c.required);
  const other = reqs.filter((c) => !noRole && !c.required);
  const idx = STAGES.indexOf(s.lifecycleState);
  const transitions = (s.allowedTransitions as string[]) ?? [];
  const submit = transitions.includes('READY_FOR_REVIEW');
  const since = (s.events as Row[])?.[0]?.at as string | undefined;
  const cols = [
    {
      key: 'r',
      title: 'Requirement',
      render: (_: unknown, c: Row) => (
        <>
          <Typography.Text strong>{c.templateTitle}</Typography.Text>
          <div>
            <Mut>
              {c.templateCode}
              {(c.expiryDate || c.dueDate || c.reviewDate) &&
                ` · ${c.deadlineKind === 'EXPIRY' ? 'Expires' : c.deadlineKind === 'REVIEW' ? 'Review' : 'Due'} ${day(c.expiryDate ?? c.dueDate ?? c.reviewDate)}`}
            </Mut>
          </div>
        </>
      ),
    },
    {
      key: 'ch',
      title: 'Requested / chased / received',
      render: (_: unknown, c: Row) => <ChaseCell c={c} chase={chaseLog} />,
    },
    { key: 'd', title: 'Document', render: (_: unknown, c: Row) => <DocCell c={c} /> },
    { key: 'v', title: 'Verified by', render: (_: unknown, c: Row) => <VerifiedCell c={c} /> },
    { key: 's', title: 'Status', render: (_: unknown, c: Row) => <StatusCell c={c} /> },
    {
      key: 'a',
      title: <span className="sr-only">Actions</span>,
      render: (_: unknown, c: Row) => (
        <ActionsCell
          c={c}
          chase={chaseLog}
          onUpload={setUpload}
          onVerify={(d, cc) => setVerify({ d, c: cc })}
          onChase={(cc, step, entry) => setChase({ c: cc, step, entry })}
        />
      ),
    },
  ];
  return (
    <Card
      title={title}
      extra={
        <Space wrap>
          {submit && can('staff.lifecycle.transition') && (
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => setMove('READY_FOR_REVIEW')}
            >
              Submit for approval
            </Button>
          )}
          {!submit && can('staff.lifecycle.transition') && transitions.length > 0 && (
            <Select
              aria-label="Change stage"
              placeholder="Change stage"
              style={{ width: 200 }}
              value={null}
              onChange={(v: string) => setMove(v)}
              options={transitions.map((t) => ({
                value: t,
                label: `Move to ${LIFECYCLE_LABEL[t] ?? t}`,
              }))}
            />
          )}
          <Link to="/staff/$id" params={{ id }}>
            <Button icon={<FileSearchOutlined />}>Full record</Button>
          </Link>
          {close}
        </Space>
      }
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      {idx >= 0 && (
        <Steps
          size="small"
          current={idx}
          items={STAGES.map((st, i) => ({
            title: LIFECYCLE_LABEL[st],
            description: i === idx ? (since ? `Since ${day(since)}` : 'Current') : undefined,
          }))}
        />
      )}
      {s.lifecycleState === 'SUSPENDED' && (
        <Alert
          type="error"
          showIcon
          message="Suspended: cannot be allocated to jobs or start shifts."
        />
      )}
      {(s.activeRestrictions as string[]).length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`Restricted: ${(s.activeRestrictions as string[]).map((x) => RESTRICTION_LABEL[x] ?? x).join(', ')}`}
        />
      )}
      {s.lifecycleState === 'READY_FOR_REVIEW' && (
        <RuleNote>
          The Registered Manager (or deputy) approves the person for a role from the full record.
          Approval is refused if the approver verified every check themselves.
        </RuleNote>
      )}
      <Space wrap align="end">
        <Field label="Search checks">
          <Input.Search
            allowClear
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: 260 }}
          />
        </Field>
        <Field label="Status">
          <Select
            style={{ width: 200 }}
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'green', label: 'Verified and in date' },
              { value: 'amber', label: 'Due soon' },
              { value: 'red', label: 'Overdue or expired' },
              { value: 'grey', label: 'Missing or unverified' },
            ]}
          />
        </Field>
      </Space>
      <Typography.Title level={4} className="!mb-0">
        {noRole ? 'Checks for the intended role' : 'Required for approved roles'}
      </Typography.Title>
      <Table<Row>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={required}
        columns={cols}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No checks yet. Start checks for a role from the full record."
            />
          ),
        }}
        scroll={{ x: 900 }}
      />
      {other.length > 0 && (
        <>
          <Typography.Title level={4} className="!mb-0">
            Other checks
          </Typography.Title>
          <Table<Row>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={other}
            columns={cols}
            scroll={{ x: 900 }}
          />
        </>
      )}
      <RuleNote>
        Uploading never makes a check green: a different person must verify the document against the
        original. Every step is recorded in the audit trail.
      </RuleNote>
      <UploadDialog
        target={
          upload
            ? {
                instanceId: upload.id,
                title: upload.templateTitle,
                deadlineKind: upload.deadlineKind,
              }
            : null
        }
        onClose={() => setUpload(null)}
      />
      <DecisionDialog
        doc={verify?.d ?? null}
        decision="ACCEPTED"
        deadlineKind={verify?.c.deadlineKind}
        onClose={() => setVerify(null)}
      />
      <ActionDialog
        open={move !== null}
        title={
          move === 'READY_FOR_REVIEW'
            ? 'Submit for approval'
            : `Move to ${LIFECYCLE_LABEL[move ?? ''] ?? ''}`
        }
        confirmLabel={move === 'READY_FOR_REVIEW' ? 'Submit' : 'Move'}
        reasonLabel="Reason (recorded in the history)"
        reasonRequired
        onCancel={() => setMove(null)}
        onConfirm={async (reason) => {
          await api.send('POST', `/api/v1/staff/${id}/transition`, orgId, { to: move, reason });
          setMove(null);
        }}
        successText="Stage changed."
      >
        <p>
          The server checks the stage rules: for example, every check must be verified before
          review.
        </p>
      </ActionDialog>
      <ChaseDialog value={chase} staffId={id} onClose={() => setChase(null)} />
    </Card>
  );
}

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

function ChaseDialog({
  value,
  staffId,
  onClose,
}: {
  value: { c: Row; step: 'request' | 'chase' | 'received'; entry?: Row } | null;
  staffId: string;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [date, setDate] = useState(today());
  const label =
    value?.step === 'request'
      ? 'Requested on'
      : value?.step === 'chase'
        ? 'Chased on'
        : 'Received on';
  return (
    <ActionDialog
      open={value !== null}
      title={`${value?.step === 'request' ? 'Request' : value?.step === 'chase' ? 'Chase' : 'Mark received'}: ${value?.c.templateTitle ?? ''}`}
      confirmLabel="Save"
      reasonLabel="Note (optional)"
      fields={
        <Field label={label}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      }
      onCancel={() => {
        setDate(today());
        onClose();
      }}
      onConfirm={async (note) => {
        const kind = chaseKindOf(value!.c.templateTitle) ?? 'OTHER';
        const n = note.trim() ? { note: note.trim() } : {};
        if (value!.step === 'request')
          await api.send('POST', `/api/v1/staff/${staffId}/chase-log`, orgId, {
            kind,
            subject: value!.c.templateTitle,
            requestedOn: date,
            ...n,
          });
        else
          await api.send('PATCH', `/api/v1/staff/${staffId}/chase-log/${value!.entry!.id}`, orgId, {
            ...(value!.step === 'chase' ? { chasedOn: date } : { receivedOn: date }),
            ...n,
          });
        setDate(today());
      }}
      successText="Saved."
    >
      <p>Requested, chased and received dates show on the person file and in the audit trail.</p>
    </ActionDialog>
  );
}

/** v36 Evidence review: KPIs over the existing queue, which handles view, verify and reject. */
const waitingWords = (iso: string | null | undefined) => {
  if (!iso) return 'Waiting';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'Today' : `Waiting ${d} day${d === 1 ? '' : 's'}`;
};
const dateWords = (iso: string | null | undefined, time = false) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
        timeZone: 'Europe/London',
      })
    : '—';

type Area = 'staff' | 'vehicle' | 'training' | 'action' | 'other';
const AREA: Record<
  Area,
  { label: string; tone: 'blue' | 'grey' | 'purple' | 'amber'; icon: string }
> = {
  staff: { label: 'Staff', tone: 'blue', icon: 'badge' },
  vehicle: { label: 'Vehicle', tone: 'grey', icon: 'airport_shuttle' },
  training: { label: 'Training', tone: 'purple', icon: 'school' },
  action: { label: 'Action', tone: 'amber', icon: 'task_alt' },
  other: { label: 'Premises', tone: 'grey', icon: 'apartment' },
};
interface ReviewRow {
  key: string;
  area: Area;
  what: string;
  sub: string;
  document: string;
  by: string;
  at: string | null;
  mine: boolean;
  verify: () => void;
  more: { label: string; icon: string; onClick: () => void; danger?: boolean }[];
}

/** v36 Evidence review: one queue for documents, training registers and action evidence. */
export function EvidenceReviewView() {
  const { api, orgId, me } = useApp();
  const navigate = useNavigate();
  const can = (p: string) => me.permissions.includes(p);
  const [show, setShow] = useState<'all' | Area>('all');
  const [deciding, setDeciding] = useState<{ doc: Row; d: 'ACCEPTED' | 'REJECTED' } | null>(null);
  const [pickTraining, setPickTraining] = useState<Row | null>(null);
  const q = useOne<{ data: Row[] }>(orgId ? '/api/v1/evidence/review-queue' : null);
  const recent = useOne<{ data: Row[] }>(orgId ? '/api/v1/evidence/recent-decisions' : null);
  const trainingQ = useOne<{ data: Row[] }>(
    orgId && can('staff.profile.manage') ? '/api/v1/training-records/awaiting-verification' : null,
  );
  const actionsQ = useOne<{ data: Row[] }>(
    orgId && (can('compliance.action.manage') || can('compliance.audit.view'))
      ? '/api/v1/actions?status=EVIDENCE_SUBMITTED'
      : null,
  );
  const invalidate = useInvalidate();
  const rows: ReviewRow[] = [];
  for (const d of q.data?.data ?? []) {
    const r0 = ((d.requirements as Row[]) ?? [])[0];
    const t = String(r0?.subjectType ?? '');
    const area: Area =
      t === 'STAFF' ? 'staff' : t === 'VEHICLE' || t === 'EQUIPMENT' ? 'vehicle' : 'other';
    rows.push({
      key: `d${d.id as string}`,
      area,
      what:
        area === 'staff'
          ? String(d.title).split(' – ')[0]!
          : ((r0?.templateTitle as string) ?? (d.title as string)),
      sub: String(r0?.subjectLabel ?? '').replace(/ \((ST-\d+)\)$/, ' · $1'),
      document: (d.fileName as string) ?? (d.title as string),
      by:
        d.channel === 'CANDIDATE_PORTAL'
          ? `${(d.uploadedByName as string) ?? 'Candidate'} (candidate portal)`
          : ((d.uploadedByName as string) ?? '—'),
      at: d.uploadedAt as string,
      mine: !!d.mine,
      verify: () => setDeciding({ doc: d, d: 'ACCEPTED' }),
      more: [
        {
          label: 'View',
          icon: 'visibility',
          onClick: () => void openEvidence(api, orgId, d.id as string),
        },
        {
          label: 'Reject',
          icon: 'block',
          danger: true,
          onClick: () => setDeciding({ doc: d, d: 'REJECTED' }),
        },
      ],
    });
  }
  for (const t of trainingQ.data?.data ?? [])
    rows.push({
      key: `t${t.id as string}`,
      area: 'training',
      what: `${t.sessionRef ? 'Group session: ' : ''}${t.title as string} (${dateWords(t.completedOn as string).replace(/ \d{4}$/, '')})`,
      sub: `${t.staffName as string}${t.courseCode ? ` · ${t.courseCode as string}` : ''}`,
      document: t.sessionRef ? `Register ${t.sessionRef as string}` : '—',
      by: (t.recordedByName as string) ?? '—',
      at: (t.recordedAt ?? t.createdAt) as string,
      mine: t.recordedBy === me.user.id,
      verify: () => setPickTraining(t),
      more: [],
    });
  for (const a of (actionsQ.data?.data ?? []).filter((x) => x.status === 'EVIDENCE_SUBMITTED')) {
    const last = ((a.history as Row[]) ?? [])
      .filter((h) => h.toStatus === 'EVIDENCE_SUBMITTED')
      .pop();
    rows.push({
      key: `a${a.id as string}`,
      area: 'action',
      what: 'Action evidence',
      sub: `${a.title as string} · ${a.code as string}`,
      document: `${((a.evidenceItemIds as string[]) ?? []).length} document${(a.evidenceItemIds as string[])?.length === 1 ? '' : 's'}`,
      by: (last?.byName as string) ?? (a.ownerName as string) ?? '—',
      at: (last?.at as string) ?? null,
      mine: last?.byUserId === me.user.id,
      verify: () => void navigate({ to: '/compliance', search: { tab: 'actions' } }),
      more: [],
    });
  }
  const has = (x: Area) => rows.some((r) => r.area === x);
  const shown = rows.filter((r) => show === 'all' || r.area === show);
  const decisions = recent.data?.data ?? [];
  return (
    <>
      <Deeper>
        <ViewSwitch
          role="radio"
          label="Show evidence for"
          current={show}
          onChange={(v) => setShow(v as 'all' | Area)}
          options={[
            { id: 'all', label: 'All' },
            { id: 'staff', label: 'Staff documents' },
            { id: 'vehicle', label: 'Vehicle' },
            { id: 'training', label: 'Training records' },
            { id: 'action', label: 'Action' },
            ...(has('other') ? [{ id: 'other', label: 'Premises & organisation' }] : []),
          ]}
        />
      </Deeper>
      <WfCard title="Waiting for verification" table>
        {q.isError && (
          <Alert type="error" showIcon message={`Source unavailable. ${errText(q.error)}`} />
        )}
        <DataTable<ReviewRow>
          caption="Waiting for verification"
          rows={shown}
          rowKey={(r) => r.key}
          loading={q.isLoading}
          rowTone={(r) => (r.area === 'training' ? 'purple' : r.area === 'action' ? 'amber' : null)}
          emptyMessage="Nothing is waiting for verification."
          columns={[
            {
              key: 'area',
              header: 'Area',
              cell: (r) => (
                <WfTag tone={AREA[r.area].tone} icon={AREA[r.area].icon}>
                  {r.area === 'other' ? 'Premises' : AREA[r.area].label}
                </WfTag>
              ),
            },
            {
              key: 'what',
              header: 'What',
              cell: (r) => (
                <>
                  <b>{r.what}</b>
                  <span className="sub">{r.sub}</span>
                </>
              ),
            },
            { key: 'doc', header: 'Document', cell: (r) => r.document },
            {
              key: 'by',
              header: 'Uploaded by',
              cell: (r) => (
                <>
                  {r.by}
                  <span className="sub">{dateWords(r.at, r.area === 'training')}</span>
                </>
              ),
            },
            {
              key: 'w',
              header: 'Waiting',
              cell: (r) => (
                <WfTag tone="blue" icon="hourglass_top">
                  {waitingWords(r.at)}
                </WfTag>
              ),
            },
            {
              key: 'act',
              header: '',
              cell: (r) =>
                r.mine ? (
                  <span className="wf-mut">You uploaded this</span>
                ) : (
                  <RowActions
                    name={r.what}
                    primary={{ label: 'Verify', icon: 'verified', onClick: r.verify }}
                    more={r.more}
                  />
                ),
            },
          ]}
        />
      </WfCard>
      <WfCard title="Recent decisions" table>
        <DataTable<Row>
          caption="Recent decisions"
          rows={decisions}
          rowKey={(r) => r.id}
          loading={recent.isLoading}
          emptyMessage="No decisions yet."
          columns={[
            { key: 'd', header: 'Document', cell: (r) => <b>{r.title}</b> },
            {
              key: 'o',
              header: 'Decision',
              cell: (r) =>
                r.decision === 'ACCEPTED' ? (
                  <WfTag tone="green" icon="check_circle">
                    Verified
                  </WfTag>
                ) : (
                  <WfTag tone="red" icon="block">
                    Rejected
                  </WfTag>
                ),
            },
            {
              key: 'b',
              header: 'By',
              cell: (r) => (
                <>
                  {r.reviewerName ?? '—'}
                  <span className="sub">{dateWords(r.decidedAt, true)}</span>
                </>
              ),
            },
            { key: 'r', header: 'Reason', cell: (r) => r.decisionReason ?? '—' },
          ]}
        />
      </WfCard>
      <DecisionDialog
        doc={deciding?.doc ?? null}
        decision={deciding?.d ?? 'ACCEPTED'}
        deadlineKind={((deciding?.doc.requirements as Row[]) ?? [])[0]?.deadlineKind as string}
        onClose={() => {
          setDeciding(null);
          invalidate();
        }}
      />
      <ActionDialog
        open={pickTraining !== null}
        title={pickTraining ? `Verify training: ${pickTraining.staffName as string}` : ''}
        confirmLabel="Verify against register"
        onCancel={() => setPickTraining(null)}
        onConfirm={async () => {
          await api.send(
            'POST',
            `/api/v1/training-records/${pickTraining!.id as string}/verify`,
            orgId,
            {
              ...(pickTraining!.sessionRef ? { registerRef: pickTraining!.sessionRef } : {}),
            },
          );
          setPickTraining(null);
          invalidate();
        }}
      >
        {pickTraining && (
          <p>
            {pickTraining.title} on {fmtDate(pickTraining.completedOn)}
            {pickTraining.sessionRef ? ` · register ${pickTraining.sessionRef as string}` : ''}.
            Confirm you have checked the signed register for {pickTraining.staffName}.
          </p>
        )}
      </ActionDialog>
    </>
  );
}
