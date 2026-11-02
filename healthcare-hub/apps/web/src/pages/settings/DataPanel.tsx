import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
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
  const decide = (id: string, decision: 'APPROVED' | 'REJECTED') =>
    void run(
      async () => {
        await api.send('POST', `/api/v1/workbook-items/${id}/decision`, orgId, { decision });
        void items.refetch();
      },
      decision === 'APPROVED' ? 'Mapping approved.' : 'Mapping rejected.',
    );
  const publish = (id: string) =>
    void run(async () => {
      await api.send('POST', `/api/v1/workbook-items/${id}/publish`, orgId, {});
      void items.refetch();
    }, 'Published as a draft library template. Approve and publish its version in the library.');
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
            cell: (i) =>
              `${words(i.mappingStatus)}${i.proposedCode ? ` – ${i.proposedCode} ${i.proposedTitle}` : ''}`,
          },
          {
            key: 'a',
            header: 'Action',
            cell: (i) =>
              can('admin.requirements.publish') && i.mappingStatus === 'PROPOSED' ? (
                <span className="flex gap-1">
                  <button className={smallButton} onClick={() => decide(i.id, 'APPROVED')}>
                    Approve
                  </button>
                  <button className={smallButton} onClick={() => decide(i.id, 'REJECTED')}>
                    Reject
                  </button>
                </span>
              ) : can('admin.requirements.publish') &&
                can('admin.settings.manage') &&
                i.mappingStatus === 'APPROVED' ? (
                <button className={smallButton} onClick={() => publish(i.id)}>
                  Publish as draft
                </button>
              ) : null,
          },
        ]}
      />
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
