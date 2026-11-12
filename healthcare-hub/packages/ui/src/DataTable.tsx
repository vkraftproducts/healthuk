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
  /** Extra classes for a row, e.g. to tint a blocked item. Never the only signal: rows keep their badge. */
  rowClassName?: (row: T) => string;
  /** false when the table sits inside a panel that already has a border. */
  framed?: boolean;
}

// Light console style: a white panel, a quiet uppercase header row and hairline row dividers.
const CELL =
  'border-t border-slate-100 px-4 py-3 align-top transition-colors group-hover:bg-slate-50';
const EMPTY = 'border-t border-slate-100 px-4 py-5';

/** Plain, keyboard- and screen-reader-friendly table with explicit loading/error/empty states. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'Nothing to show.',
  rowClassName,
  framed = true,
}: DataTableProps<T>) {
  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-red-900">
        <strong>Source unavailable.</strong> {error}
      </div>
    );
  }
  return (
    <div
      className={`overflow-x-auto bg-white ${framed ? 'rounded-xl border border-hub-line' : ''}`}
      aria-busy={loading ? 'true' : 'false'}
    >
      <table className="w-full border-collapse text-left text-sm text-slate-900">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="bg-slate-50 px-4 py-3 text-[11px] font-bold uppercase tracking-[0.06em] text-slate-600"
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
              <tr key={rowKey(row)} className={`group ${rowClassName?.(row) ?? ''}`}>
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
