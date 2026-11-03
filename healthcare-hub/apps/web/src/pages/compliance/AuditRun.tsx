import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useParams } from '@tanstack/react-router';
import { Section, smallButton, useCan, useRun, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { ActionsTable } from './Compliance.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const RESULT_KIND: Record<string, StatusKind> = {
  COMPLIANT: 'GREEN',
  PARTIAL: 'AMBER',
  NON_COMPLIANT: 'RED',
  NOT_ASSESSED: 'GREY',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

/** Compliance and audit workspace (wireframe 03, UI_SPEC 03). */
export function AuditRun() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { api, orgId, me } = useApp();
  const can = useCan();
  const res = useOne<Row>(`/api/v1/audit-runs/${id}`);
  const { run, msg } = useRun();
  if (res.isLoading) return <p role="status">Loading…</p>;
  if (res.isError || !res.data) return <p role="alert">This audit is not available.</p>;
  const a = res.data;
  const open = a.status === 'SCHEDULED' || a.status === 'IN_PROGRESS';
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/compliance" className="font-medium text-hub-teal-dark underline">
          Compliance
        </Link>{' '}
        / {words(a.domain)} / {a.templateCode} / {a.code}
      </nav>
      <div className="grid gap-4 lg:grid-cols-3">
        <header className="rounded-lg border border-hub-line bg-white p-4 lg:col-span-2">
          <h1 className="text-2xl font-bold">
            {a.code} {a.title}
          </h1>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Due</dt>
            <dd>{a.dueDate}</dd>
            <dt className="font-semibold">Period</dt>
            <dd>{a.periodFrom && a.periodTo ? `${a.periodFrom} to ${a.periodTo}` : 'Not set'}</dd>
            <dt className="font-semibold">Sample</dt>
            <dd>
              {a.samples.length
                ? a.samples
                    .map(
                      (s: Row) =>
                        `${s.populationDesc} – ${s.selectionMethod} (${s.subjectIds.length})`,
                    )
                    .join('; ')
                : 'No sample recorded'}
            </dd>
            <dt className="font-semibold">Controls</dt>
            <dd>{a.controls.map((c: Row) => `${c.code}: ${c.question}`).join(' ')}</dd>
          </dl>
        </header>
        <section
          aria-labelledby="outcome-h"
          className="rounded-lg border border-hub-line bg-white p-4"
        >
          <h2 id="outcome-h" className="font-semibold">
            Outcome
          </h2>
          {a.outcome ? (
            <StatusBadge status={a.outcome as StatusKind} reason={a.outcomeReason} />
          ) : (
            <p>Not submitted yet ({words(a.status)}).</p>
          )}
          {a.submittedAt && (
            <p className="mt-1 text-sm">
              Submitted{' '}
              {new Date(a.submittedAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })}
            </p>
          )}
          <p className="mt-2 text-sm">Closure requires verification.</p>
          {open && can('compliance.audit.run') && (
            <button
              className={`${smallButton} mt-2`}
              onClick={() =>
                void run(
                  () => api.send('POST', `/api/v1/audit-runs/${a.id}/submit`, orgId, {}),
                  'Submitted for review.',
                )
              }
            >
              Submit for review
            </button>
          )}
        </section>
      </div>
      {msg}
      <Section title="Findings and controls">
        <DataTable<Row>
          caption="Findings"
          rows={a.findings}
          rowKey={(r) => r.id}
          emptyMessage="Findings appear when the audit is submitted."
          columns={[
            { key: 'c', header: 'Finding / control', cell: (r) => r.controlCode },
            { key: 'e', header: 'Evidence', cell: (r) => r.summary },
            {
              key: 'o',
              header: 'Owner',
              cell: () => (a.ownerUserId === me.user.id ? 'You' : 'Audit owner'),
            },
            {
              key: 's',
              header: 'State',
              cell: (r) => (
                <StatusBadge
                  status={RESULT_KIND[r.result] ?? 'GREY'}
                  reason={`${words(r.result)} – ${r.summary}`}
                />
              ),
            },
          ]}
        />
      </Section>
      <Section title="Actions">
        <ActionsTable rows={a.actions} caption="Actions from this audit" />
      </Section>
      <Section title="Evidence and decision history">
        <ol className="space-y-1 text-sm">
          {(a.actions as Row[])
            .flatMap((x) => x.history.map((h: Row) => ({ ...h, code: x.code })))
            .sort((x: Row, y: Row) => x.at.localeCompare(y.at))
            .map((h: Row, i: number) => (
              <li key={i}>
                {new Date(h.at).toLocaleString('en-GB', { timeZone: 'Europe/London' })} – {h.code}:{' '}
                {words(h.toStatus)}
                {h.note ? ` (${h.note})` : ''}
              </li>
            ))}
        </ol>
        <p className="text-sm text-slate-700">
          Original audit, findings and source version remain unchanged after corrective action.
        </p>
      </Section>
    </div>
  );
}
