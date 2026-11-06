import { DataTable, StatusBadge } from '@hub/ui';
import { useState } from 'react';
import { Field, Section, fmtDate, input } from '../../components.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const STATE_TEXT: Record<string, string> = {
  COMPLETE: 'Recorded and verified',
  RECORDED_UNVERIFIED: 'Recorded, not yet verified',
  ATTENTION: 'Needs attention',
  MISSING: 'Missing',
};
const CHECK_TEXT: Record<string, string> = {
  ROLE_APPROVED: 'Driver role',
  NO_DRIVING_RESTRICTION: 'Restrictions',
  LICENCE_RECORD: 'Licence details',
  LICENCE_VERIFIED: 'Licence evidence',
  LICENCE_CATEGORY: 'Licence category',
  PHOTOCARD_IN_DATE: 'Photocard',
  DVLA_CHECK_RECENT: 'DVLA check',
  PENALTY_POINTS: 'Penalty points',
};
const CATEGORIES = ['B', 'C1', 'D1', 'C', 'D', 'BE', 'C1E'];

/** Schedule 3 (reg 19): what must be held for each person employed, and whether it is. */
export function Schedule3Panel({ staffId }: { staffId: string }) {
  const res = useOne<Row>(`/api/v1/staff/${staffId}/schedule-3`);
  const d = Array.isArray(res.data?.items) ? res.data : null;
  const open = ((d?.items ?? []) as Row[]).filter((x) => x.state !== 'COMPLETE').length;
  return (
    <Section title="Schedule 3 checks">
      <p className="text-sm">
        The information regulation 19 and Schedule 3 require for everyone employed. An item is only
        complete when it is recorded and its evidence has been verified by someone else.
      </p>
      {d && (
        <p role="status">
          <StatusBadge
            status={d.complete ? 'GREEN' : 'RED'}
            reason={
              d.complete
                ? `All Schedule 3 information held and verified (as of ${fmtDate(d.asOf)})`
                : `${open} item(s) not complete`
            }
          />
        </p>
      )}
      <DataTable<Row>
        caption="Schedule 3 information"
        rows={d?.items ?? []}
        rowKey={(r) => r.item}
        loading={res.isLoading}
        error={res.isError ? 'Could not load the Schedule 3 checks.' : null}
        emptyMessage="Nothing to show."
        columns={[
          { key: 't', header: 'Information', cell: (r) => r.title },
          {
            key: 's',
            header: 'State',
            cell: (r) => (
              <StatusBadge status={r.status} reason={STATE_TEXT[r.state] ?? 'Unknown'} />
            ),
          },
          { key: 'r', header: 'Detail', cell: (r) => r.reasonText },
          {
            key: 'e',
            header: 'Evidence held in',
            cell: (r) => r.evidenceTitle ?? 'No requirement covers this yet',
          },
        ]}
      />
    </Section>
  );
}

/** Whether the person may drive a vehicle needing a licence category, check by check. */
export function DriverEligibilityPanel({ staffId }: { staffId: string }) {
  const [category, setCategory] = useState('B');
  const res = useOne<Row>(`/api/v1/staff/${staffId}/driver-eligibility?category=${category}`);
  const d = typeof res.data?.eligible === 'boolean' ? res.data : null;
  return (
    <Section title="Driver eligibility">
      <Field label="Vehicle needs licence category">
        <select
          className={`${input} w-40`}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>
      {d && (
        <p role="status">
          <StatusBadge
            status={d.eligible ? 'GREEN' : 'RED'}
            reason={
              d.eligible
                ? `Eligible to drive category ${d.category}`
                : `Not eligible to drive category ${d.category}`
            }
          />
        </p>
      )}
      {res.isError && <p role="alert">Could not load driver eligibility.</p>}
      <ul className="space-y-1 text-sm" aria-label="Driver checks">
        {((d?.checks ?? []) as Row[]).map((c) => (
          <li key={c.code} className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status={c.result === 'PASS' ? 'GREEN' : c.result === 'WARN' ? 'AMBER' : 'RED'}
              reason={`${CHECK_TEXT[c.code] ?? 'Check'}: ${c.reasonText}`}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}
