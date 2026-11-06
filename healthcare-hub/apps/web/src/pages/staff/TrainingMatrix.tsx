import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Field, Section, fmtDate, input, smallButton } from '../../components.js';
import { EvidenceDialog } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';
import { ROLE_LABEL, list } from './labels.js';

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

/** HR-03: everyone against the requirements mapped to their roles. Words, never colour alone. */
export function TrainingMatrix() {
  const [role, setRole] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [gapsOnly, setGapsOnly] = useState(false);
  const p = new URLSearchParams();
  if (role) p.set('role', role);
  if (templateId) p.set('templateId', templateId);
  if (gapsOnly) p.set('gapsOnly', 'true');
  const res = useOne<Row>(`/api/v1/staff/training-matrix?${p.toString()}`);
  const all = useOne<Row>('/api/v1/staff/training-matrix');
  const m = Array.isArray(res.data?.columns) ? res.data! : { columns: [], rows: [] };
  const columns = m.columns as Row[];
  const options = (Array.isArray(all.data?.columns) ? all.data!.columns : []) as Row[];
  const rows = m.rows as Row[];
  const [peopleFor, setPeopleFor] = useState<string | null>(null);
  const [cellFor, setCellFor] = useState<{ staffId: string; templateId: string } | null>(null);
  const column = columns.find((c) => c.templateId === peopleFor) ?? null;
  const cellCol = columns.findIndex((c) => c.templateId === cellFor?.templateId);
  const cellRow = rows.find((r) => r.staffId === cellFor?.staffId) ?? null;
  const cell = cellRow && cellCol >= 0 ? ((cellRow.cells as Row[])[cellCol] ?? null) : null;

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter the training matrix"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field label="Role">
          <select className={input} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Requirement">
          <select
            className={input}
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">All requirements</option>
            {options.map((c) => (
              <option key={c.templateId} value={c.templateId}>
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={gapsOnly}
            onChange={(e) => setGapsOnly(e.target.checked)}
          />
          Only people with something overdue or missing
        </label>
      </form>
      {m.truncated && (
        <p role="note">Showing the first 500 people. Filter by role to see the rest.</p>
      )}

      <Section title="Totals by requirement">
        <DataTable<Row>
          caption="Totals by requirement"
          rows={columns}
          rowKey={(c) => c.templateId}
          loading={res.isLoading}
          error={res.isError ? 'Could not load the training matrix.' : null}
          emptyMessage="No requirements are mapped to roles yet. Map them in Settings, Library."
          columns={[
            { key: 't', header: 'Requirement', cell: (c) => c.title },
            { key: 'r', header: 'Roles', cell: (c) => list(c.roles ?? [], ROLE_LABEL) },
            { key: 'm', header: 'Met', cell: (c) => c.summary?.met ?? 0 },
            { key: 'd', header: 'Due soon', cell: (c) => c.summary?.dueSoon ?? 0 },
            { key: 'o', header: 'Overdue', cell: (c) => c.summary?.overdue ?? 0 },
            { key: 'x', header: 'Missing', cell: (c) => c.summary?.missing ?? 0 },
            {
              key: 'p',
              header: 'Met of required',
              cell: (c) =>
                c.summary?.percentMet === null || c.summary?.percentMet === undefined
                  ? 'Nobody needs this'
                  : `${c.summary.met} of ${c.summary.required} (${c.summary.percentMet}%)`,
            },
            {
              key: 'people',
              header: 'People',
              cell: (c) => (
                <button
                  type="button"
                  className={smallButton}
                  aria-label={`Show people: ${c.title}`}
                  aria-expanded={peopleFor === c.templateId}
                  onClick={() => setPeopleFor(peopleFor === c.templateId ? null : c.templateId)}
                >
                  {peopleFor === c.templateId ? 'Hide people' : 'Show people'}
                </button>
              ),
            },
          ]}
        />
      </Section>

      {column && (
        <ColumnPeople
          column={column}
          index={columns.indexOf(column)}
          rows={rows}
          onOpen={(staffId) => setCellFor({ staffId, templateId: column.templateId })}
          onClose={() => setPeopleFor(null)}
        />
      )}

      <Section title="Matrix">
        <DataTable<Row>
          caption="Training matrix"
          rows={m.rows as Row[]}
          rowKey={(r) => r.staffId}
          loading={res.isLoading}
          error={res.isError ? 'Could not load the training matrix.' : null}
          emptyMessage={
            gapsOnly ? 'Nobody has anything overdue or missing.' : 'Nobody matches these filters.'
          }
          columns={[
            {
              key: 'name',
              header: 'Person',
              cell: (r) => (
                <Link
                  to="/staff/$id"
                  params={{ id: r.staffId }}
                  className="font-medium text-hub-teal-dark underline"
                >
                  {r.displayName}
                </Link>
              ),
            },
            { key: 'roles', header: 'Roles', cell: (r) => list(r.roles, ROLE_LABEL) },
            ...columns.map((col, n) => ({
              key: col.templateId as string,
              header: col.title as string,
              cell: (r: Row) => {
                const c = (r.cells as Row[])[n];
                if (!c) return '';
                return (
                  <button
                    type="button"
                    className="rounded text-left hover:underline"
                    aria-label={`Open ${col.title as string} for ${r.displayName}: ${cellReason(c)}`}
                    onClick={() => setCellFor({ staffId: r.staffId, templateId: col.templateId })}
                  >
                    <StatusBadge
                      status={(CELL[c.state] ?? CELL.MISSING!).status}
                      reason={cellReason(c)}
                    />
                  </button>
                );
              },
            })),
          ]}
        />
      </Section>

      {cellRow && cell && (
        <CellDetail
          person={cellRow}
          title={columns[cellCol]!.title}
          cell={cell}
          onClose={() => setCellFor(null)}
        />
      )}
    </div>
  );
}

/** C1 drill-down: everyone who needs one requirement, worst first. */
function ColumnPeople({
  column,
  index,
  rows,
  onOpen,
  onClose,
}: {
  column: Row;
  index: number;
  rows: Row[];
  onOpen: (staffId: string) => void;
  onClose: () => void;
}) {
  const order = ['OVERDUE', 'MISSING', 'DUE_SOON', 'MET'];
  const people = rows
    .map((r) => ({ r, c: (r.cells as Row[])[index] }))
    .filter((x): x is { r: Row; c: Row } => !!x.c && x.c.state !== 'NOT_REQUIRED')
    .sort((a, b) => order.indexOf(a.c.state) - order.indexOf(b.c.state));
  return (
    <Section
      title={`People who need ${column.title}`}
      actions={
        <button type="button" className={smallButton} onClick={onClose}>
          Close list
        </button>
      }
    >
      <DataTable<{ r: Row; c: Row }>
        caption={`People who need ${column.title}`}
        rows={people}
        rowKey={(x) => x.r.staffId}
        emptyMessage="Nobody shown needs this requirement."
        columns={[
          { key: 'n', header: 'Person', cell: (x) => x.r.displayName },
          { key: 'no', header: 'Staff number', cell: (x) => x.r.staffNo ?? '' },
          { key: 'ro', header: 'Roles', cell: (x) => list(x.r.roles, ROLE_LABEL) },
          {
            key: 's',
            header: 'Status',
            cell: (x) => (
              <StatusBadge
                status={(CELL[x.c.state] ?? CELL.MISSING!).status}
                reason={cellReason(x.c)}
              />
            ),
          },
          {
            key: 'o',
            header: 'Record',
            cell: (x) => (
              <button
                type="button"
                className={smallButton}
                aria-label={`Open ${column.title} for ${x.r.displayName}`}
                onClick={() => onOpen(x.r.staffId)}
              >
                Open
              </button>
            ),
          },
        ]}
      />
    </Section>
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
    <Section
      title={`${title}: ${person.displayName}`}
      actions={
        <button type="button" className={smallButton} onClick={onClose}>
          Close record
        </button>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-semibold">Status</dt>
        <dd>
          <StatusBadge status={s.status} reason={cellReason(cell)} />
        </dd>
        <dt className="font-semibold">Required for their roles</dt>
        <dd>{cell.required ? 'Yes' : 'No'}</dd>
        <dt className="font-semibold">Next date</dt>
        <dd>{cell.nextDate ? fmtDate(cell.nextDate) : 'Not set'}</dd>
        {cell.reasonText && (
          <>
            <dt className="font-semibold">Why</dt>
            <dd>{cell.reasonText}</dd>
          </>
        )}
      </dl>
      {!cell.instanceId && (
        <p role="note" className="text-sm">
          There is no record for this yet. Start checks for their role on their profile, then upload
          evidence for someone else to verify.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {cell.instanceId && (
          <button
            type="button"
            className={smallButton}
            aria-label={`Documents for ${title}: ${person.displayName}`}
            onClick={() => setDocs(true)}
          >
            Documents
          </button>
        )}
        <Link
          to="/staff/$id"
          params={{ id: person.staffId }}
          className="font-medium text-hub-teal-dark underline"
        >
          Open {person.displayName}&rsquo;s profile
        </Link>
      </div>
      <EvidenceDialog
        target={docs && cell.instanceId ? { instanceId: cell.instanceId, title } : null}
        onClose={() => setDocs(false)}
      />
    </Section>
  );
}
