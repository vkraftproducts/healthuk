// v36 Vehicles › Checks & defects › Daily checks: Today and History. Read-only views over the
// existing endpoints; a check is captured on the crew phone and never edited here.
import { DataTable } from '@hub/ui';
import { londonDate } from '@hub/rules';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useOne, usePeople } from '../../settings/hooks.js';
import { RowActions, WfCard, WfSearch, WfSelect, WfTag, WfWarn } from '../../../v36/ui.js';
import { typeWords, fmtReg } from './FleetCards.js';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const hm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(iso));
const dmyhm = (iso: string) =>
  `${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' })} ${hm(iso)}`;

function useChecksData() {
  const today = londonDate(new Date());
  const vehicles = useOne<{ data: R[] }>('/api/v1/vehicles');
  const vdis = useOne<{ data: R[] }>('/api/v1/vdis');
  const tpl = useOne<{ data: R[] }>('/api/v1/vdi-templates');
  const planner = useOne<R>(`/api/v1/planner?date=${today}`);
  const defects = useOne<{ data: R[] }>('/api/v1/defects');
  const people = usePeople();
  return useMemo(() => {
    const name = new Map(people.map((p) => [p.id, p.displayName]));
    const vehicle = new Map((vehicles.data?.data ?? []).map((v) => [v.id as string, v]));
    const versions = new Map((tpl.data?.data ?? []).map((t) => [t.id as string, t]));
    const firstJob = new Map<string, R>();
    for (const s of (planner.data?.shifts as R[]) ?? [])
      for (const j of (s.jobs as R[]) ?? []) {
        if (londonDate(new Date(j.startsAt)) !== today) continue;
        const cur = firstJob.get(s.vehicleId);
        if (!cur || cur.startsAt > j.startsAt) firstJob.set(s.vehicleId, j);
      }
    const todays = new Map<string, R>();
    for (const c of vdis.data?.data ?? [])
      if (londonDate(new Date(c.capturedAt)) === today) {
        const prev = todays.get(c.vehicleId);
        if (!prev || prev.capturedAt < c.capturedAt) todays.set(c.vehicleId, c);
      }
    const current = (tpl.data?.data ?? []).find((t) => t.active) ?? null;
    // The defect a failed check raised (v36 "Raised DEF-082").
    const raised = new Map<string, string>();
    for (const x of defects.data?.data ?? [])
      if (x.sourceVdiId && x.code) raised.set(x.sourceVdiId as string, x.code as string);
    return {
      raised,
      today,
      name,
      vehicle,
      versions,
      firstJob,
      todays,
      current,
      vehicles: vehicles.data?.data ?? [],
      vdis: vdis.data?.data ?? [],
      loading: vehicles.isLoading || vdis.isLoading,
    };
  }, [vehicles.data, vdis.data, tpl.data, planner.data, defects.data, people, today]);
}

const STATUS: Record<string, { tone: 'green' | 'red' | 'grey' | 'amber'; word: string }> = {
  AVAILABLE: { tone: 'green', word: 'Available' },
  BLOCKED: { tone: 'red', word: 'Blocked' },
  QUARANTINED: { tone: 'red', word: 'Quarantined' },
  OFF_ROAD: { tone: 'grey', word: 'Off road' },
};

/** Today: every vehicle, its first job, today's check and what that means for the vehicle. */
export function DailyToday() {
  const d = useChecksData();
  const navigate = useNavigate();
  const rows = d.vehicles.map((v) => {
    const check = d.todays.get(v.id) ?? null;
    const job = d.firstJob.get(v.id) ?? null;
    const missing = !check && v.status === 'AVAILABLE';
    return { v, check, job, missing };
  });
  const late = rows.filter((r) => r.missing && r.job);
  const tag = (r: (typeof rows)[number]) => {
    if (r.check)
      return r.check.outcome === 'PASS' ? (
        <WfTag tone="green" icon="check_circle">
          Passed {hm(r.check.capturedAt)} – {d.name.get(r.check.checkerUserId) ?? 'crew'}
        </WfTag>
      ) : (
        <WfTag tone="red" icon="error">
          Failed {hm(r.check.capturedAt)} – {d.name.get(r.check.checkerUserId) ?? 'crew'}
        </WfTag>
      );
    if (r.v.status !== 'AVAILABLE')
      return (
        <WfTag tone="grey" icon="block">
          Not needed – vehicle {(STATUS[r.v.status]?.word ?? 'off road').toLowerCase()}
        </WfTag>
      );
    return (
      <WfTag tone="amber" icon="schedule">
        No check yet{r.job ? ` – first job ${hm(r.job.startsAt)}` : ''}
      </WfTag>
    );
  };
  const status = (r: (typeof rows)[number]) => {
    const s = STATUS[r.v.status] ?? { tone: 'grey' as const, word: r.v.status };
    const amber = s.tone === 'green' && r.missing;
    return (
      <WfTag
        tone={amber ? 'amber' : s.tone}
        icon={
          s.tone === 'green' && !amber ? 'check_circle' : s.tone === 'red' ? 'error' : 'schedule'
        }
      >
        {s.word}
        {r.v.statusReason
          ? ` – ${r.v.statusReason as string}`
          : amber
            ? ' – No daily check yet today'
            : ''}
      </WfTag>
    );
  };
  const items = (d.current?.items as R[]) ?? [];
  return (
    <>
      {late.map((r) => (
        <WfWarn key={r.v.id}>
          {r.v.callsign} has a job at {hm(r.job!.startsAt)} and no daily check yet today. Fleet Lead
          and Dispatcher have been alerted.
        </WfWarn>
      ))}
      <WfCard
        title={`Today – ${new Date(`${d.today}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
        table
        extra={
          d.current ? (
            <span className="wf-mini">
              Using check list v{d.current.version} ({items.length} items,{' '}
              {items.filter((i) => i.critical).length} critical)
            </span>
          ) : undefined
        }
      >
        <DataTable<(typeof rows)[number]>
          caption="Today's daily checks"
          rows={rows}
          rowKey={(r) => r.v.id}
          loading={d.loading}
          emptyMessage="No vehicles."
          rowTone={(r) =>
            r.v.status === 'BLOCKED' || r.v.status === 'QUARANTINED' || r.check?.outcome === 'FAIL'
              ? 'red'
              : r.missing || r.v.statusReason
                ? 'amber'
                : null
          }
          columns={[
            {
              key: 'v',
              header: 'Vehicle',
              cell: (r) => (
                <>
                  <b>{r.v.callsign}</b>
                  <span className="sub">
                    {fmtReg(r.v.registration)} · {typeWords(r.v)}
                  </span>
                </>
              ),
            },
            {
              key: 'j',
              header: 'First job',
              cell: (r) => (r.job ? `${hm(r.job.startsAt)} · ${r.job.code as string}` : '—'),
            },
            { key: 'c', header: 'Today’s check', cell: tag },
            { key: 's', header: 'Vehicle status', cell: status },
            {
              key: 'a',
              header: '',
              cell: (r) =>
                r.missing ? (
                  <RowActions
                    name={r.v.callsign}
                    primary={{
                      label: 'Start check',
                      icon: 'fact_check',
                      onClick: () => void navigate({ to: '/vehicles', search: { tab: 'crew' } }),
                    }}
                  />
                ) : r.check ? (
                  <RowActions
                    name={r.v.callsign}
                    ghost
                    primary={{
                      label: 'View',
                      icon: 'visibility',
                      onClick: () =>
                        void navigate({
                          to: '/vehicles/$id',
                          params: { id: r.v.id },
                          search: { tab: 'checks' },
                        }),
                    }}
                    more={[
                      {
                        label: 'Vehicle record',
                        icon: 'manage_search',
                        onClick: () =>
                          void navigate({
                            to: '/vehicles/$id',
                            params: { id: r.v.id },
                            search: { tab: 'documents' },
                          }),
                      },
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>
    </>
  );
}

/** History: every check submitted, newest first. Corrections are amendments; nothing is edited. */
export function DailyHistory() {
  const d = useChecksData();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState('');
  const [veh, setVeh] = useState('');
  const t = q.trim().toLowerCase();
  const rows = d.vdis
    .slice()
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))
    .filter((c) => !outcome || c.outcome === outcome)
    .filter((c) => !veh || c.vehicleId === veh)
    .filter(
      (c) =>
        !t ||
        `${d.vehicle.get(c.vehicleId)?.callsign ?? ''} ${d.name.get(c.checkerUserId) ?? ''}`
          .toLowerCase()
          .includes(t),
    );
  return (
    <WfCard
      title="Check history"
      table
      extra={
        <span className="wf-mini">
          Checks are never edited. Corrections are added as amendments and the original is kept.
        </span>
      }
    >
      <div className="pc-tools rec-f in-card">
        <WfSearch value={q} onChange={setQ} />
        <WfSelect
          label="Filter by outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: '', label: 'All outcomes' },
            { value: 'PASS', label: 'Pass' },
            { value: 'FAIL', label: 'Fail' },
          ]}
        />
        <WfSelect
          label="Filter by vehicle"
          value={veh}
          onChange={setVeh}
          options={[
            { value: '', label: 'All' },
            ...d.vehicles.map((v) => ({ value: v.id as string, label: v.callsign as string })),
          ]}
        />
      </div>
      <DataTable<R>
        caption="Daily check history"
        rows={rows}
        rowKey={(c) => c.id}
        loading={d.loading}
        emptyMessage="No checks match."
        rowTone={(c) =>
          c.outcome === 'FAIL'
            ? 'red'
            : ((c.results as R[]) ?? []).some((x) => x.amended)
              ? 'purple'
              : null
        }
        columns={[
          {
            key: 'c',
            header: 'Check',
            cell: (c) => {
              const v = d.versions.get(c.templateId);
              return (
                <>
                  <b>{(c.code as string) || 'Daily check'}</b>
                  <span className="sub">{v ? `List v${v.version as number}` : 'Check list'}</span>
                </>
              );
            },
          },
          { key: 'v', header: 'Vehicle', cell: (c) => d.vehicle.get(c.vehicleId)?.callsign ?? '—' },
          { key: 'w', header: 'When', cell: (c) => dmyhm(c.capturedAt) },
          { key: 'b', header: 'By', cell: (c) => d.name.get(c.checkerUserId) ?? '—' },
          {
            key: 'o',
            header: 'Odometer',
            cell: (c) =>
              c.odometer != null ? `${Number(c.odometer).toLocaleString('en-GB')} mi` : '—',
          },
          {
            key: 'r',
            header: 'Outcome',
            cell: (c) => {
              const failed = ((c.results as R[]) ?? []).filter((x) => x.result === 'FAIL');
              return c.outcome === 'PASS' ? (
                <WfTag tone="green" icon="check_circle">
                  Pass
                </WfTag>
              ) : (
                <>
                  <WfTag tone="red" icon="error">
                    {failed.some((x) => x.critical) ? 'Fail – critical' : 'Fail'}
                  </WfTag>
                  {d.raised.has(c.id) ? (
                    <span className="sub">Raised {d.raised.get(c.id)}</span>
                  ) : (
                    failed.length > 0 && (
                      <span className="sub">Failed {failed.map((x) => x.code).join(', ')}</span>
                    )
                  )}
                </>
              );
            },
          },
          {
            key: 'm',
            header: 'Amendments',
            cell: (c) => {
              const n = ((c.results as R[]) ?? []).filter((x) => x.amended).length;
              return n ? (
                <WfTag tone="purple" icon="edit_note">
                  {n} amendment{n === 1 ? '' : 's'}
                </WfTag>
              ) : (
                '—'
              );
            },
          },
          {
            key: 'a',
            header: '',
            cell: (c) => (
              <RowActions
                name="check"
                ghost
                primary={{
                  label: 'Open',
                  onClick: () =>
                    void navigate({
                      to: '/vehicles/$id',
                      params: { id: c.vehicleId },
                      search: { tab: 'checks' },
                    }),
                }}
              />
            ),
          },
        ]}
      />
    </WfCard>
  );
}
