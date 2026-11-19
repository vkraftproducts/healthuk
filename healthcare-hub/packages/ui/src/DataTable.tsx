import { Alert, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type React from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { createContext, useContext } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /** Accessible name for the table (caption + aria-label). */
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Message shown when the source could not be read (never show stale data as current). */
  error?: string | null;
  emptyMessage?: string;
  /** Accessible name for each data row (not the header row). */
  rowName?: (row: T) => string;
  /** v36 row flag: a coloured bar on the left of the row (`s-red`, `s-amber`, `s-purple`). */
  rowTone?: (row: T) => 'red' | 'amber' | 'purple' | 'blue' | null | undefined;
  /** Makes the whole row open something (v36 `tr.click`). */
  onRowClick?: (row: T) => void;
}

// The <table> element is defined once, outside render: a component created inline would be a new
// type on every render, so React would rebuild the whole table (losing focus and in-cell state).
const CaptionContext = createContext<string>('');
function CaptionTable({
  children,
  ...props
}: HTMLAttributes<HTMLTableElement> & { children?: ReactNode }) {
  const caption = useContext(CaptionContext);
  return (
    <table {...props} className={`${props.className ?? ''} wf-t ant-t`} aria-label={caption}>
      <caption
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {caption}
      </caption>
      {children}
    </table>
  );
}
const TABLE_COMPONENTS = { table: CaptionTable };

/** Ant Design table wrapper — same props API as the previous plain table. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'Nothing to show.',
  rowName,
  rowTone,
  onRowClick,
}: DataTableProps<T>) {
  if (error) {
    return (
      <Alert type="error" showIcon role="alert" message="Source unavailable." description={error} />
    );
  }

  const cols: ColumnsType<T> = columns.map((c) => ({
    key: c.key,
    title: c.header,
    render: (_: unknown, row: T) => c.cell(row),
  }));

  return (
    <CaptionContext.Provider value={caption}>
      <Table<T>
        size="middle"
        className="wf-tw"
        pagination={false}
        loading={!!loading && rows.length > 0}
        rowKey={rowKey}
        dataSource={[...rows]}
        columns={cols}
        locale={{
          emptyText: loading && rows.length === 0 ? 'Loading…' : emptyMessage,
        }}
        rowClassName={(r) => {
          const t = rowTone?.(r);
          return `${t ? `s-${t}` : ''}${onRowClick ? ' click' : ''}`;
        }}
        onRow={
          rowName || onRowClick
            ? (record) =>
                ({
                  ...(rowName ? { 'aria-label': rowName(record) } : {}),
                  ...(onRowClick
                    ? {
                        tabIndex: 0,
                        role: 'button',
                        onClick: (e: React.MouseEvent) => {
                          if ((e.target as HTMLElement).closest('button,a,input,select')) return;
                          onRowClick(record);
                        },
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(record);
                          }
                        },
                      }
                    : {}),
                }) as HTMLAttributes<HTMLElement>
            : undefined
        }
        components={TABLE_COMPONENTS}
      />
    </CaptionContext.Provider>
  );
}
