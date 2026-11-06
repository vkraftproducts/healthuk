import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  button,
  Field,
  input,
  Section,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROW_KIND: Record<string, StatusKind> = {
  VALID: 'GREEN',
  IMPORTED: 'GREEN',
  ERROR: 'RED',
  FAILED: 'RED',
  DUPLICATE: 'AMBER',
  KEPT: 'AMBER',
  ROLLED_BACK: 'GREY',
};

/** Import (preview → commit → rollback), compliance workbook review and full export (PRD 4.12). */
export function DataPanel() {
  const can = useCan();
  return (
    <div className="space-y-6">
      {can('admin.import.manage') && <CsvImport />}
      {(can('admin.import.manage') || can('admin.requirements.publish')) && <Workbook />}
      {can('admin.export.full') && <FullExport />}
    </div>
  );
}

function CsvImport() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [current, setCurrent] = useState<Row | null>(null);
  const batches = useOne<{ data: Row[] }>('/api/v1/imports');
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file =
      (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0] ?? null;
    await run(async () => {
      if (!file || file.size === 0) throw new Error('Choose a CSV file first.');
      const csv = await file.text();
      setCurrent(
        (await api.send('POST', '/api/v1/imports', orgId, {
          kind: String(f.get('kind')),
          filename: file.name,
          csv,
        })) as Row,
      );
      void batches.refetch();
    }, 'Preview ready. Nothing has been created yet.');
  }
  const act = (action: 'commit' | 'rollback' | 'discard', done: string) =>
    void run(async () => {
      setCurrent(
        (await api.send('POST', `/api/v1/imports/${current!.id}/${action}`, orgId, {})) as Row,
      );
      void batches.refetch();
    }, done);
  return (
    <Section title="Import from CSV">
      <p className="text-sm">
        Staff columns: Staff No, Display Name, Location (name), optional Job title and Working
        pattern. Vehicle columns: Registration, Callsign, Type, Location, optional Seats, Wheelchair
        capacity, Stretcher, Licence category, Ownership, VIN. You see every row’s result before
        anything is created.
      </p>
      <form onSubmit={upload} className="flex flex-wrap items-end gap-3">
        <Field label="Records">
          <select name="kind" className={input}>
            <option value="STAFF">Staff</option>
            <option value="VEHICLES">Vehicles</option>
          </select>
        </Field>
        <Field label="CSV file">
          <input type="file" name="file" accept=".csv,text/csv" className={input} />
        </Field>
        <button className={button}>Preview</button>
      </form>
      {msg}
      {current && (
        <div className="space-y-2">
          <p>
            <strong>{current.code}</strong> – {current.filename}: {current.validCount} ready,{' '}
            {current.errorCount} with errors, {current.duplicateCount} duplicates. Status:{' '}
            {words(current.status)}.
          </p>
          <div className="flex gap-2">
            {current.status === 'PREVIEWED' && (
              <>
                <button
                  className={button}
                  disabled={current.validCount === 0}
                  onClick={() => act('commit', 'Import finished. See each row below.')}
                >
                  Import {current.validCount} ready rows
                </button>
                <button
                  className={smallButton}
                  onClick={() => act('discard', 'Preview discarded.')}
                >
                  Discard
                </button>
              </>
            )}
            {(current.status === 'COMMITTED' || current.status === 'PARTIAL') && (
              <button
                className={smallButton}
                onClick={() =>
                  act(
                    'rollback',
                    'Rolled back. Records used since the import were kept (see rows).',
                  )
                }
              >
                Roll back this import
              </button>
            )}
          </div>
          <DataTable<Row>
            caption={`Rows in ${current.code}`}
            rows={current.rows}
            rowKey={(r) => String(r.rowNo)}
            emptyMessage="No rows."
            columns={[
              { key: 'n', header: 'Row', cell: (r) => r.rowNo },
              {
                key: 's',
                header: 'Result',
                cell: (r) => (
                  <StatusBadge status={ROW_KIND[r.status] ?? 'GREY'} reason={words(r.status)} />
                ),
              },
              {
                key: 'd',
                header: 'Record',
                cell: (r) => Object.values(r.data).filter(Boolean).slice(0, 3).join(' · '),
              },
              {
                key: 'e',
                header: 'Detail',
                cell: (r) =>
                  [...r.errors, r.duplicateOf, r.resultDetail].filter(Boolean).join('; ') || '—',
              },
            ]}
          />
        </div>
      )}
      <DataTable<Row>
        caption="Recent imports"
        rows={(batches.data?.data ?? []).filter((b) => b.kind !== 'WORKBOOK')}
        rowKey={(b) => b.id}
        emptyMessage="No imports yet."
        columns={[
          { key: 'c', header: 'Import', cell: (b) => `${b.code} ${b.filename}` },
          { key: 'k', header: 'Records', cell: (b) => words(b.kind) },
          { key: 's', header: 'Status', cell: (b) => words(b.status) },
          { key: 'n', header: 'Imported', cell: (b) => `${b.importedCount} of ${b.rowCount}` },
          {
            key: 'o',
            header: 'Open',
            cell: (b) => (
              <button
                className={smallButton}
                onClick={() =>
                  void run(
                    async () =>
                      setCurrent((await api.get(`/api/v1/imports/${b.id}`, orgId)) as Row),
                    `Showing ${b.code}.`,
                  )
                }
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

function Workbook() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const items = useOne<{ data: Row[] }>('/api/v1/workbook-items');
  async function stage(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file =
      (e.currentTarget.elements.namedItem('file') as HTMLInputElement | null)?.files?.[0] ?? null;
    await run(async () => {
      if (!file || file.size === 0) throw new Error('Choose the sheet saved as CSV first.');
      await api.send('POST', '/api/v1/workbook-imports', orgId, {
        filename: file.name,
        sheet: String(f.get('sheet')),
        csv: await file.text(),
        columns: {
          code: String(f.get('code')),
          text: String(f.get('text')),
          ...(f.get('status') ? { status: String(f.get('status')) } : {}),
          ...(f.get('kloe') ? { kloe: String(f.get('kloe')) } : {}),
        },
      });
      void items.refetch();
    }, 'Sheet staged. Nothing is published until a governance reviewer approves each mapping.');
  }
  const { me } = useApp();
  const [deciding, setDeciding] = useState<{ i: Row; d: 'APPROVED' | 'REJECTED' } | null>(null);
  const [proposing, setProposing] = useState<{
    i: Row;
    classification: string;
    code: string;
    title: string;
    subject: string;
  } | null>(null);
  const [publishing, setPublishing] = useState<Row | null>(null);
  const label = (i: Row) => `${i.sheet} row ${i.rowNo}${i.promptCode ? ` ${i.promptCode}` : ''}`;
  const proposeValid =
    !!proposing &&
    (proposing.classification === 'OUT_OF_SCOPE' ||
      (/^[A-Z0-9][A-Z0-9_-]{1,59}$/.test(proposing.code) && proposing.title.trim().length > 0));
  return (
    <Section title="Compliance workbook staging">
      {can('admin.import.manage') && (
        <form onSubmit={stage} className="flex flex-wrap items-end gap-3">
          <Field label="Sheet saved as CSV">
            <input type="file" name="file" accept=".csv,text/csv" className={input} />
          </Field>
          <Field label="Sheet name">
            <input name="sheet" required className={input} />
          </Field>
          <Field label="Prompt code column">
            <input name="code" required defaultValue="Ref" className={input} />
          </Field>
          <Field label="Prompt text column">
            <input name="text" required defaultValue="Prompt" className={input} />
          </Field>
          <Field label="Status column (optional)">
            <input name="status" className={input} />
          </Field>
          <Field label="KLOE column (optional)">
            <input name="kloe" className={input} />
          </Field>
          <button className={button}>Stage sheet</button>
        </form>
      )}
      {msg}
      <DataTable<Row>
        caption="Staged workbook rows"
        rows={(items.data?.data ?? []).filter((i) => i.kind === 'PROMPT')}
        rowKey={(i) => i.id}
        emptyMessage="Nothing staged."
        columns={[
          {
            key: 'r',
            header: 'Source',
            cell: (i) => `${i.sheet} row ${i.rowNo} ${i.promptCode ?? ''}`,
          },
          { key: 't', header: 'Prompt', cell: (i) => i.text },
          {
            key: 'p',
            header: 'Placeholders',
            cell: (i) => (i.placeholders.length ? `Unresolved: ${i.placeholders.join(', ')}` : '—'),
          },
          {
            key: 'src',
            header: 'Source status (reference only)',
            cell: (i) => i.sourceStatus ?? '—',
          },
          {
            key: 'c',
            header: 'Classification',
            cell: (i) => (i.classification ? words(i.classification) : '—'),
          },
          {
            key: 'm',
            header: 'Mapping',
            cell: (i) => (
              <>
                {words(i.mappingStatus)}
                {i.proposedCode ? ` – ${i.proposedCode} ${i.proposedTitle}` : ''}
                {i.proposedByName && (
                  <span className="block text-xs">Proposed by {i.proposedByName}</span>
                )}
                {i.decidedByName && (
                  <span className="block text-xs">
                    Decided by {i.decidedByName}
                    {i.decisionNote ? `: ${i.decisionNote}` : ''}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'a',
            header: 'Action',
            cell: (i) => (
              <span className="flex flex-wrap gap-1">
                {can('admin.import.manage') &&
                  ['UNMAPPED', 'PROPOSED', 'REJECTED'].includes(i.mappingStatus) && (
                    <button
                      className={smallButton}
                      aria-label={`Propose mapping: ${label(i)}`}
                      onClick={() =>
                        setProposing({
                          i,
                          classification: i.classification ?? 'SHARED',
                          code: i.proposedCode ?? i.promptCode ?? '',
                          title: i.proposedTitle ?? i.text.slice(0, 200),
                          subject: i.proposedSubject ?? 'ORGANISATION',
                        })
                      }
                    >
                      {i.mappingStatus === 'UNMAPPED' ? 'Propose' : 'Re-propose'}
                    </button>
                  )}
                {can('admin.requirements.publish') &&
                  i.mappingStatus === 'PROPOSED' &&
                  (i.proposedBy === me.user.id ? (
                    <span className="text-xs">You proposed this; someone else decides.</span>
                  ) : (
                    <>
                      <button
                        className={smallButton}
                        aria-label={`Approve mapping: ${label(i)}`}
                        onClick={() => setDeciding({ i, d: 'APPROVED' })}
                      >
                        Approve
                      </button>
                      <button
                        className={smallButton}
                        aria-label={`Reject mapping: ${label(i)}`}
                        onClick={() => setDeciding({ i, d: 'REJECTED' })}
                      >
                        Reject
                      </button>
                    </>
                  ))}
                {can('admin.requirements.publish') &&
                  can('admin.settings.manage') &&
                  i.mappingStatus === 'APPROVED' && (
                    <button
                      className={smallButton}
                      aria-label={`Publish as draft: ${label(i)}`}
                      onClick={() => setPublishing(i)}
                    >
                      Publish as draft
                    </button>
                  )}
              </span>
            ),
          },
        ]}
      />
      <ActionDialog
        open={proposing !== null}
        title={`Propose mapping: ${proposing ? label(proposing.i) : ''}`}
        confirmLabel="Propose"
        confirmDisabled={!proposeValid}
        onCancel={() => setProposing(null)}
        onConfirm={async () => {
          const p = proposing!;
          const out = p.classification === 'OUT_OF_SCOPE';
          await api.send('POST', `/api/v1/workbook-items/${p.i.id}/propose`, orgId, {
            classification: p.classification,
            ...(out
              ? {}
              : {
                  proposedCode: p.code,
                  proposedTitle: p.title.trim(),
                  proposedSubject: p.subject,
                }),
          });
          void items.refetch();
        }}
        fields={
          proposing && (
            <div className="grid gap-3">
              <Field label="Applies to">
                <select
                  className={input}
                  value={proposing.classification}
                  onChange={(e) => setProposing({ ...proposing, classification: e.target.value })}
                >
                  {['SHARED', 'AMBULANCE', 'DENTAL', 'CARE_HOME', 'GP', 'OUT_OF_SCOPE'].map((c) => (
                    <option key={c} value={c}>
                      {c === 'SHARED' ? 'All services' : words(c)}
                    </option>
                  ))}
                </select>
              </Field>
              {proposing.classification !== 'OUT_OF_SCOPE' && (
                <>
                  <Field label="Requirement code (capitals, digits, - or _)">
                    <input
                      className={input}
                      value={proposing.code}
                      onChange={(e) =>
                        setProposing({ ...proposing, code: e.target.value.toUpperCase() })
                      }
                    />
                  </Field>
                  <Field label="Requirement title">
                    <input
                      className={input}
                      maxLength={200}
                      value={proposing.title}
                      onChange={(e) => setProposing({ ...proposing, title: e.target.value })}
                    />
                  </Field>
                  <Field label="Checked for">
                    <select
                      className={input}
                      value={proposing.subject}
                      onChange={(e) => setProposing({ ...proposing, subject: e.target.value })}
                    >
                      {['ORGANISATION', 'SERVICE', 'STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES'].map(
                        (s) => (
                          <option key={s} value={s}>
                            {s === 'ORGANISATION'
                              ? 'The organisation'
                              : `Each ${words(s).toLowerCase()}`}
                          </option>
                        ),
                      )}
                    </select>
                  </Field>
                </>
              )}
            </div>
          )
        }
      >
        <p>{proposing?.i.text}</p>
        <p>A governance reviewer other than you must approve the mapping before it is published.</p>
      </ActionDialog>
      <ActionDialog
        open={deciding !== null}
        title={`${deciding?.d === 'APPROVED' ? 'Approve' : 'Reject'} mapping: ${deciding ? label(deciding.i) : ''}`}
        confirmLabel={deciding?.d === 'APPROVED' ? 'Approve mapping' : 'Reject mapping'}
        danger={deciding?.d === 'REJECTED'}
        reasonLabel={deciding?.d === 'APPROVED' ? 'Note' : 'Why is it rejected?'}
        reasonRequired={deciding?.d === 'REJECTED'}
        onCancel={() => setDeciding(null)}
        onConfirm={async (note) => {
          await api.send('POST', `/api/v1/workbook-items/${deciding!.i.id}/decision`, orgId, {
            decision: deciding!.d,
            ...(note ? { note } : {}),
          });
          void items.refetch();
        }}
      >
        <p>
          {deciding?.i.text} → {deciding?.i.proposedCode} {deciding?.i.proposedTitle}
        </p>
        <p>Your name is recorded with the decision.</p>
      </ActionDialog>
      <ActionDialog
        open={publishing !== null}
        title={`Publish as draft: ${publishing ? label(publishing) : ''}`}
        confirmLabel="Publish as draft"
        onCancel={() => setPublishing(null)}
        onConfirm={async () => {
          await api.send('POST', `/api/v1/workbook-items/${publishing!.id}/publish`, orgId, {});
          void items.refetch();
        }}
      >
        <p>
          This creates a draft library template ({publishing?.proposedCode}). It only takes effect
          once its version is approved and published in the requirement library.
        </p>
      </ActionDialog>
    </Section>
  );
}

function FullExport() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  return (
    <Section title="Full data export">
      <p className="text-sm">
        Every record you can see, one file per table with stable IDs, plus evidence files. Built in
        the background and logged; download it from Reports when ready.
      </p>
      <button
        className={button}
        onClick={() =>
          void run(
            () => api.send('POST', '/api/v1/exports/full', orgId, {}),
            'Export requested. It appears under your exports when ready.',
          )
        }
      >
        Request full export
      </button>
      {msg}
    </Section>
  );
}
