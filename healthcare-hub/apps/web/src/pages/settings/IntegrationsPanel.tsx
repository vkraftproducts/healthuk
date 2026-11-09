import { useState } from 'react';
import { Field, Section, input, saveBlob, smallButton, useRun, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** INT-01: mock integrations. Nothing here contacts an external system. */
export function IntegrationsPanel() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const res = useOne<Row>('/api/v1/integrations');
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(addDays(new Date(), 28)));
  const [faults, setFaults] = useState(false);
  const base = '/api/v1/integrations';
  const rows: Row[] = res.data?.data ?? [];
  const runs: Row[] = res.data?.recentRuns ?? [];
  return (
    <div className="space-y-6">
      {msg}
      <p
        role="note"
        className="rounded border border-amber-700 bg-amber-50 p-3 text-sm text-amber-900"
      >
        {res.data?.notice ??
          'Mock integrations only. No external system is contacted and every record is synthetic.'}
      </p>
      <Section title="Integrations">
        {res.isError && <p role="alert">Integrations could not be loaded.</p>}
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={faults} onChange={(e) => setFaults(e.target.checked)} />
          Include faulty records in the next mock sync (to see how they are handled)
        </label>
        <ul className="space-y-3">
          {rows.map((r) => (
            <li
              key={r.adapter}
              aria-label={r.name}
              className="rounded-lg border border-hub-line bg-hub-card p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">
                    {r.name}{' '}
                    <span className="text-xs font-normal text-slate-700">
                      ({r.direction === 'INBOUND' ? 'brings data in' : 'sends data out'})
                    </span>
                  </h3>
                  <p className="text-sm">{r.summary}</p>
                  <p className="text-sm text-slate-700">{r.treatment}</p>
                  <p className="mt-1 text-xs text-slate-700">
                    {r.connected ? 'Connected (mock)' : 'Not connected'}
                    {r.lastRunAt
                      ? ` · last run ${r.lastRunAt.slice(0, 16).replace('T', ' ')} ${words(r.lastStatus ?? '')}`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!r.connected ? (
                    <button
                      className={smallButton}
                      onClick={() =>
                        void run(
                          () => api.send('POST', `${base}/${r.adapter}/connect`, orgId, {}),
                          `${r.name} connected (mock).`,
                        )
                      }
                    >
                      Connect (mock)
                    </button>
                  ) : (
                    <>
                      {r.direction === 'INBOUND' && (
                        <button
                          className={smallButton}
                          onClick={() =>
                            void run(
                              () =>
                                api.send('POST', `${base}/${r.adapter}/sync`, orgId, {
                                  scenario: faults ? 'faults' : 'normal',
                                }),
                              `${r.name}: mock sync finished.`,
                            )
                          }
                        >
                          Run mock sync
                        </button>
                      )}
                      {r.adapter === 'PAYROLL' && (
                        <button
                          className={smallButton}
                          onClick={() =>
                            void run(
                              async () =>
                                saveBlob(
                                  await api.download!(
                                    `${base}/payroll/export?from=${from}&to=${to}`,
                                    orgId,
                                  ),
                                  'payroll-hours-mock.csv',
                                ),
                              'Payroll hours downloaded.',
                            )
                          }
                        >
                          Download hours CSV
                        </button>
                      )}
                      {r.adapter === 'CALENDAR' && (
                        <button
                          className={smallButton}
                          onClick={() =>
                            void run(
                              async () =>
                                saveBlob(
                                  await api.download!(`${base}/calendar/feed`, orgId),
                                  'shifts-mock.ics',
                                ),
                              'Calendar file downloaded.',
                            )
                          }
                        >
                          Download calendar file
                        </button>
                      )}
                      <button
                        className={smallButton}
                        onClick={() =>
                          void run(
                            () => api.send('POST', `${base}/${r.adapter}/disconnect`, orgId, {}),
                            `${r.name} disconnected.`,
                          )
                        }
                      >
                        Disconnect
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Payroll period">
        <div className="flex flex-wrap gap-3">
          <Field label="From">
            <input
              type="date"
              className={input}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={input}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
      </Section>
      <Section title="Recent runs">
        {runs.length === 0 ? (
          <p className="text-sm">No runs yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {runs.map((r) => (
              <li key={r.id} className="rounded border border-hub-line bg-hub-card p-2">
                <strong>{words(r.adapter)}</strong> · {words(r.status)} · {r.recordsApplied}{' '}
                applied, {r.recordsFlagged} flagged, {r.recordsSkipped} skipped of {r.recordsSeen}
                {r.notes.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-slate-700">
                    {r.notes.map((n: string, i: number) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
