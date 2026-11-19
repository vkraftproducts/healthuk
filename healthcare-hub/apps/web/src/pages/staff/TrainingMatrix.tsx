import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useNavigate } from '@tanstack/react-router';
import { Alert, Button, Descriptions, Space } from 'antd';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Section, fmtDate } from '../../components.js';
import { EvidenceDialog } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';
import { LIFECYCLE_LABEL, ROLE_LABEL, list } from './labels.js';
import { WfCard, WfFilters, WfSelect, WfTag } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CELL: Record<string, { status: StatusKind; word: string }> = {
  MET: { status: 'GREEN', word: 'Met' },
  DUE_SOON: { status: 'AMBER', word: 'Due soon' },
  OVERDUE: { status: 'RED', word: 'Overdue' },
  MISSING: { status: 'GREY', word: 'Missing or not verified' },
  NOT_REQUIRED: { status: 'NOT_APPLICABLE', word: 'Not required' },
};

function cellReason(c: Row): string {
  const s = CELL[c.state] ?? CELL.MISSING!;
  if (c.state === 'NOT_REQUIRED') return s.word;
  if (c.state === 'MISSING' && !c.instanceId) return 'Missing: no record yet';
  return c.nextDate ? `${s.word} (next ${fmtDate(c.nextDate)})` : s.word;
}

/** v36 matrix columns: the training courses, in the v36 order and words. */
const COURSES: { code: string; label: string }[] = [
  { code: 'AMB-STF-05', label: 'Manual handling' },
  { code: 'AMB-STF-06', label: 'Basic life support' },
  { code: 'AMB-STF-07', label: 'Safeguarding adults & children (level 2)' },
  { code: 'AMB-STF-08', label: 'Infection prevention & control' },
  { code: 'ORG-STF-06', label: 'Information governance & data security' },
];
const dm = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** One v36 matrix chip: "To 8 Nov", "Due 2 Dec", "Expired 11 Nov", "To verify", "Missing". */
const FROM_STATUS: Record<string, string> = {
  GREEN: 'MET',
  AMBER: 'DUE_SOON',
  RED: 'OVERDUE',
  GREY: 'MISSING',
};
function Chip({ c: raw, starter }: { c: Row | undefined; starter?: boolean }) {
  // A starter has no approved role yet: show their checks against the role they are joining.
  const c =
    raw && raw.state === 'NOT_REQUIRED' && starter
      ? { ...raw, state: raw.instanceId ? (FROM_STATUS[raw.status] ?? 'MISSING') : 'MISSING' }
      : raw;
  if (!c || c.state === 'NOT_REQUIRED') return <span className="wf-mut">—</span>;
  const waiting =
    c.state === 'MISSING' &&
    /awaiting|not verified yet/i.test(String(c.reasonText ?? c.text ?? ''));
  if (c.state === 'MET')
    return (
      <WfTag tone="green" icon="check_circle">
        {c.nextDate ? `To ${dm(c.nextDate)}` : 'Done'}
      </WfTag>
    );
  if (c.state === 'DUE_SOON')
    return (
      <WfTag tone="amber" icon="schedule">
        {c.nextDate ? `Due ${dm(c.nextDate)}` : 'Due soon'}
      </WfTag>
    );
  if (c.state === 'OVERDUE')
    return (
      <WfTag tone="red" icon="error">
        {c.nextDate ? `Expired ${dm(c.nextDate)}` : 'Overdue'}
      </WfTag>
    );
  if (waiting)
    return (
      <WfTag tone="blue" icon="hourglass_top">
        To verify
      </WfTag>
    );
  return (
    <WfTag tone="grey" icon="radio_button_unchecked">
      Missing
    </WfTag>
  );
}

/** HR-03 in the v36 layout: each person against the training their roles need. */
export function TrainingMatrix() {
  const navigate = useNavigate();
  const [role, setRole] = useState('');
  const res = useOne<Row>('/api/v1/staff/training-matrix');
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?limit=100');
  const m = Array.isArray(res.data?.columns) ? res.data! : { columns: [], rows: [] };
  const columns = m.columns as Row[];
  const cols = COURSES.map((k) => ({
    ...k,
    i: columns.findIndex((c) => c.code === k.code),
  })).filter((k) => k.i >= 0);
  const byId = new Map((staff.data?.data ?? []).map((x) => [x.id as string, x]));
  const order = (r: Row) => {
    const st = String(byId.get(r.staffId)?.lifecycleState ?? 'ACTIVE');
    return ['CANDIDATE', 'CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW', 'APPROVED_FOR_ROLE'].includes(st)
      ? 0
      : 1;
  };
  const rows = (m.rows as Row[])
    .filter((r) => !role || (r.roles as string[]).includes(role))
    .sort((a, b) => order(a) - order(b));
  const cellsOf = (r: Row) => cols.map((k) => (r.cells as Row[])[k.i]);
  const [cellFor, setCellFor] = useState<{ staffId: string; i: number } | null>(null);
  const cellRow = rows.find((r) => r.staffId === cellFor?.staffId) ?? null;
  const cell = cellRow && cellFor ? ((cellRow.cells as Row[])[cellFor.i] ?? null) : null;
  return (
    <>
      <WfCard
        title="Training matrix"
        extra={
          <span className="wf-mini">
            Required training is mapped to every role. Click a person to open their file.
          </span>
        }
        table
      >
        <WfFilters>
          <WfSelect
            label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: '', label: 'All roles' },
              ...[
                'DRIVER',
                'CARE_ASSISTANT',
                'EMERGENCY_CARE_ASSISTANT',
                'TECHNICIAN',
                'PARAMEDIC',
              ].map((k) => ({ value: k, label: ROLE_LABEL[k] ?? k })),
            ]}
          />
        </WfFilters>
        {m.truncated && (
          <Alert
            type="info"
            showIcon
            role="note"
            message="Showing the first 500 people. Filter by role to see the rest."
          />
        )}
        <DataTable<Row>
          caption="Training matrix"
          rows={rows}
          rowKey={(r) => r.staffId}
          loading={res.isLoading}
          error={res.isError ? 'Could not load the training matrix.' : null}
          emptyMessage="Nobody matches this filter."
          rowTone={(r) => {
            const cs = cellsOf(r);
            if (cs.some((c) => c?.state === 'OVERDUE')) return 'red';
            if (cs.some((c) => c?.state === 'DUE_SOON')) return 'amber';
            return null;
          }}
          onRowClick={(r) => void navigate({ to: '/staff/$id', params: { id: r.staffId } })}
          columns={[
            {
              key: 'name',
              header: 'Person',
              cell: (r) => {
                const p = byId.get(r.staffId);
                return (
                  <>
                    <b>{r.displayName}</b>
                    <span className="sub">
                      {[
                        p?.jobTitle ?? list(r.roles, ROLE_LABEL),
                        p && LIFECYCLE_LABEL[p.lifecycleState],
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </>
                );
              },
            },
            ...cols.map((k) => ({
              key: k.code,
              header: k.label,
              cell: (r: Row) => {
                const c = (r.cells as Row[])[k.i];
                return (
                  <button
                    type="button"
                    className="hh-chipbtn"
                    aria-label={`${k.label} for ${r.displayName as string}: ${c ? cellReason(c) : 'not required'}`}
                    onClick={() => setCellFor({ staffId: r.staffId, i: k.i })}
                  >
                    <Chip c={c} starter={order(r) === 0} />
                  </button>
                );
              },
            })),
          ]}
        />
      </WfCard>
      {cellRow && cell && cellFor && (
        <CellDetail
          key={`${cellRow.staffId}:${cellFor.i}`}
          person={cellRow}
          title={columns[cellFor.i]!.title}
          cell={cell}
          onClose={() => setCellFor(null)}
        />
      )}
    </>
  );
}

/** Brings a card that just opened into view (it can open far from the button that opened it). */
function ScrollHere({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    ref.current?.focus?.({ preventScroll: true });
  }, []);
  return (
    <div ref={ref} tabIndex={-1} style={{ scrollMarginTop: 16, outline: 'none' }}>
      {children}
    </div>
  );
}

/** C1 drill-down: one person against one requirement, with the documents behind the cell. */
function CellDetail({
  person,
  title,
  cell,
  onClose,
}: {
  person: Row;
  title: string;
  cell: Row;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState(false);
  const s = CELL[cell.state] ?? CELL.MISSING!;
  return (
    <ScrollHere>
      <Section
        title={`${title}: ${person.displayName}`}
        actions={
          <Button size="small" onClick={onClose}>
            Close record
          </Button>
        }
      >
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Status">
            <StatusBadge status={s.status} reason={cellReason(cell)} />
          </Descriptions.Item>
          <Descriptions.Item label="Required for their roles">
            {cell.required ? 'Yes' : 'No'}
          </Descriptions.Item>
          <Descriptions.Item label="Next date">
            {cell.nextDate ? fmtDate(cell.nextDate) : 'Not set'}
          </Descriptions.Item>
          {cell.reasonText && <Descriptions.Item label="Why">{cell.reasonText}</Descriptions.Item>}
        </Descriptions>
        {!cell.instanceId && (
          <Alert
            type="info"
            showIcon
            role="note"
            style={{ marginTop: 12 }}
            message="There is no record for this yet. Start checks for their role on their profile, then upload evidence for someone else to verify."
          />
        )}
        <Space wrap style={{ marginTop: 12 }}>
          {cell.instanceId && (
            <Button
              size="small"
              aria-label={`Documents for ${title}: ${person.displayName}`}
              onClick={() => setDocs(true)}
            >
              Documents
            </Button>
          )}
          <Link
            to="/staff/$id"
            params={{ id: person.staffId }}
            className="font-medium text-hub-teal-dark underline"
          >
            Open {person.displayName}&rsquo;s profile
          </Link>
        </Space>
        <EvidenceDialog
          target={docs && cell.instanceId ? { instanceId: cell.instanceId, title } : null}
          onClose={() => setDocs(false)}
        />
      </Section>
    </ScrollHere>
  );
}
