import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable, StatusBadge, type StatusKind } from '../src/index.js';

describe('StatusBadge', () => {
  const cases: [StatusKind, string][] = [
    ['RED', 'Red – blocked'],
    ['AMBER', 'Amber – due soon'],
    ['GREEN', 'Green – verified'],
    ['GREY', 'Grey – unverified'],
    ['NOT_APPLICABLE', 'N/A – approved'],
  ];
  it.each(cases)('%s shows text and an icon, never colour alone', (status, text) => {
    const reason = text.split(' – ')[1];
    const { container } = render(<StatusBadge status={status} reason={reason} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
  it('uses a different icon shape per status', () => {
    const shapes = (['RED', 'AMBER', 'GREEN', 'GREY', 'NOT_APPLICABLE'] as StatusKind[]).map(
      (s) => {
        const { container, unmount } = render(<StatusBadge status={s} />);
        const html = container.querySelector('svg')?.innerHTML ?? '';
        unmount();
        return html;
      },
    );
    expect(new Set(shapes).size).toBe(5);
  });
});

describe('DataTable', () => {
  const cols = [{ key: 'a', header: 'Item', cell: (r: { a: string }) => r.a }];
  it('renders an accessible table with headers', () => {
    render(
      <DataTable
        caption="Action required"
        columns={cols}
        rows={[{ a: 'x' }]}
        rowKey={(r) => r.a}
      />,
    );
    const table = screen.getByRole('table', { name: 'Action required' });
    expect(within(table).getByRole('columnheader', { name: 'Item' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'x' })).toBeInTheDocument();
  });
  it('names each data row for keyboard and screen-reader users', () => {
    render(
      <DataTable
        caption="Items"
        columns={cols}
        rows={[{ a: 'Alpha' }, { a: 'Beta' }]}
        rowKey={(r) => r.a}
        rowName={(r) => `Item ${r.a}`}
      />,
    );
    const table = screen.getByRole('table', { name: 'Items' });
    expect(within(table).getByRole('row', { name: 'Item Alpha' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Item Beta' })).toBeInTheDocument();
  });
  it('shows an explicit source-unavailable alert instead of stale rows', () => {
    render(
      <DataTable
        caption="t"
        columns={cols}
        rows={[{ a: 'stale' }]}
        rowKey={(r) => r.a}
        error="timeout"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Source unavailable');
    expect(screen.queryByText('stale')).toBeNull();
  });
  it('shows loading and empty states', () => {
    const { rerender } = render(
      <DataTable caption="t" columns={cols} rows={[]} rowKey={(r) => r.a} loading />,
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    rerender(
      <DataTable
        caption="t"
        columns={cols}
        rows={[]}
        rowKey={(r) => r.a}
        emptyMessage="No actions."
      />,
    );
    expect(screen.getByText('No actions.')).toBeInTheDocument();
  });
});
