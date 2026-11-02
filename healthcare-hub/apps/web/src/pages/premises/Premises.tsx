import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useCan, useRun, smallButton, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Premises safety register per location (HSE-01). Intervals come from a named source only. */
export function Premises() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>(can('premises.item.view') ? '/api/v1/premises-items' : null);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  if (!can('premises.item.view'))
    return <p role="alert">You do not have access to premises safety.</p>;
  const loc = (id: string) => locations.data?.data.find((l) => l.id === id)?.name ?? 'Location';
  const decide = (r: Row) => {
    const reason = window.prompt(
      r.applicable
        ? 'Why does this not apply here? (at least 10 characters)'
        : 'Why does this now apply?',
    );
    if (!reason || reason.trim().length < 10) return;
    void run(
      () =>
        api.send('POST', `/api/v1/premises-items/${r.id}/applicability`, orgId, {
          applicable: !r.applicable,
          reason: reason.trim(),
        }),
      'Applicability recorded.',
    );
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Premises safety</h1>
      {msg}
      <DataTable<Row>
        caption="Premises safety register"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load the register.' : null}
        emptyMessage="No premises items yet."
        columns={[
          { key: 'l', header: 'Location', cell: (r) => loc(r.locationId) },
          { key: 'a', header: 'Area', cell: (r) => words(r.controlArea) },
          { key: 't', header: 'Item', cell: (r) => r.title },
          { key: 'f', header: 'Frequency source', cell: (r) => r.frequencySource },
          { key: 'n', header: 'Next due', cell: (r) => r.nextDue ?? '—' },
          {
            key: 's',
            header: 'Status',
            cell: (r) => <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />,
          },
          {
            key: 'x',
            header: 'Action',
            cell: (r) =>
              can('premises.item.manage') ? (
                <button className={smallButton} onClick={() => decide(r)}>
                  {r.applicable ? 'Mark not applicable' : 'Mark applicable'}
                </button>
              ) : null,
          },
        ]}
      />
    </div>
  );
}
