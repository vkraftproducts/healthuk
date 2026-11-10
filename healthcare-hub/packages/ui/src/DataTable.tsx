import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /** Accessible name for the table (rendered as a visually hidden caption). */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Message shown when the source could not be read (never show stale data as current). */
  error?: string | null;
  emptyMessage?: string;
}

// Neon Forest style: glowing header bar, each row a dark glass strip (alternate rows tinted, hover lit).
const CELL =
  'border-y border-hub-line bg-hub-card px-3 py-2.5 align-top transition-colors first:rounded-l-lg first:border-l last:rounded-r-lg last:border-r group-even:bg-hub-row group-hover:bg-sky-50 group-hover:border-teal-600/50';
const EMPTY = 'rounded-lg border border-hub-line bg-hub-card px-3 py-4';

/** Plain, keyboard- and screen-reader-friendly table with explicit loading/error/empty states. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'Nothing to show.',
}: DataTableProps<T>) {
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-900">
        <strong>Source unavailable.</strong> {error}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto" aria-busy={loading ? 'true' : 'false'}>
      <table className="w-full border-separate border-spacing-y-1.5 text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="border-y border-hub-navy bg-hub-navy px-3 py-2.5 text-xs font-semibold uppercase tracking-wider text-white first:rounded-l-lg first:border-l last:rounded-r-lg last:border-r"
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className={`${EMPTY} text-slate-600`}>
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={`${EMPTY} text-slate-600`}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className="group">
                {columns.map((c) => (
                  <td key={c.key} className={CELL}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
