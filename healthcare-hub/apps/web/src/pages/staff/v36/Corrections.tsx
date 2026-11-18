// v36 Staff › Training & reviews › Corrections: what staff asked to be put right on their record.
import { DataTable } from '@hub/ui';
import { useState } from 'react';
import { ActionDialog } from '../../../components.js';
import { useApp } from '../../../shell/AppContext.js';
import { RowActions, WfCard, WfTag } from '../../../v36/ui.js';
import { CORRECTION_FIELD, StaffRequestsQueue } from '../../me/MyRecord.js';
import { useInvalidate, useOne } from '../../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });

export function Corrections() {
  const { api, orgId, me } = useApp();
  const manage = me.permissions.includes('staff.profile.manage');
  const invalidate = useInvalidate();
  const res = useOne<{ data: Row[] }>(manage ? '/api/v1/staff/corrections' : null);
  const staff = useOne<{ data: Row[] }>('/api/v1/staff?limit=100');
  const requests = useOne<{ data: Row[] }>('/api/v1/staff/self-requests');
  const names = new Map(
    (staff.data?.data ?? []).map((s) => [s.id as string, s.displayName as string]),
  );
  const [deciding, setDeciding] = useState<{ row: Row; apply: boolean } | null>(null);
  const rows = res.data?.data ?? [];
  return (
    <>
      <WfCard title="Correction requests" table>
        <DataTable<Row>
          caption="Correction requests"
          rows={rows}
          rowKey={(r) => r.id}
          loading={res.isLoading}
          error={res.isError ? 'Could not load correction requests.' : null}
          emptyMessage="No correction requests are waiting."
          rowTone={(r) => (r.status === 'OPEN' ? 'amber' : null)}
          columns={[
            {
              key: 'w',
              header: 'Who',
              cell: (r) => (
                <>
                  <b>{names.get(r.staffId) ?? 'Staff member'}</b>
                  <span className="sub">{when(r.createdAt)}</span>
                </>
              ),
            },
            {
              key: 'f',
              header: 'What is wrong',
              cell: (r) => CORRECTION_FIELD[r.field] ?? 'Something else',
            },
            { key: 'v', header: 'Should say', cell: (r) => r.proposedValue },
            { key: 'r', header: 'Why', cell: (r) => r.reason },
            {
              key: 's',
              header: 'Status',
              cell: () => (
                <WfTag tone="amber" icon="schedule">
                  Waiting for HR
                </WfTag>
              ),
            },
            {
              key: 'a',
              header: '',
              cell: (r) => (
                <RowActions
                  name={`correction to ${CORRECTION_FIELD[r.field] ?? 'record'}`}
                  primary={{
                    label: 'Accept',
                    icon: 'check',
                    onClick: () => setDeciding({ row: r, apply: true }),
                  }}
                  more={[
                    {
                      label: 'Reject',
                      icon: 'block',
                      danger: true,
                      onClick: () => setDeciding({ row: r, apply: false }),
                    },
                  ]}
                />
              ),
            },
          ]}
        />
      </WfCard>
      {(requests.data?.data ?? []).length > 0 && (
        <WfCard title="Requests from staff" table>
          <StaffRequestsQueue withCorrections={false} />
        </WfCard>
      )}
      <ActionDialog
        open={!!deciding}
        title={deciding?.apply ? 'Accept the correction' : 'Reject the correction'}
        confirmLabel={deciding?.apply ? 'Mark as applied' : 'Reject correction'}
        reasonLabel="Note for the member of staff"
        reasonRequired={!deciding?.apply}
        danger={!deciding?.apply}
        onCancel={() => setDeciding(null)}
        onConfirm={async (note) => {
          await api.send(
            'POST',
            `/api/v1/staff/corrections/${deciding!.row.id as string}/decide`,
            orgId,
            {
              decision: deciding!.apply ? 'APPLIED' : 'REJECTED',
              ...(note ? { note } : {}),
            },
          );
          setDeciding(null);
          invalidate();
        }}
      >
        <p>
          {deciding?.apply
            ? 'Make the change on the staff record first; this records that it was done.'
            : 'The record stays as it is.'}
        </p>
      </ActionDialog>
    </>
  );
}
