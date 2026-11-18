// v36 Reports › Records by date: daily checks and defects in one dated list, filterable by
// vehicle, record type and period, with a CSV export of what is shown.
import { Select } from 'antd';
import { useMemo, useState } from 'react';
import { useCan } from '../../components.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { Ms, WfCard, WfTag, type KTone } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Rec {
  key: string;
  at: string;
  vehicle: string;
  record: string;
  ref: string;
  details: string;
  outcome: string;
  tone: KTone;
  icon: string;
  by: string;
  alert: boolean;
}

const DAY = 86_400_000;
const fmtDay = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
const DEFECT_STATUS: Record<string, string> = {
  OPEN: 'Open',
  REPORTED: 'Reported',
  CLASSIFIED: 'Classified',
  IN_REPAIR: 'In repair',
  REPAIRING: 'In repair',
  AWAITING_RELEASE: 'Awaiting release',
  REPAIRED: 'Repaired',
  RELEASED: 'Released',
  CLOSED: 'Closed',
};

export function RecordsByDate() {
  const can = useCan();
  const fleet = can('fleet.vehicle.view');
  const vehicles = useOne<{ data: Row[] }>(fleet ? '/api/v1/vehicles' : null);
  const vdis = useOne<{ data: Row[] }>(fleet ? '/api/v1/vdis' : null);
  const defects = useOne<{ data: Row[] }>(fleet ? '/api/v1/defects' : null);
  const inspections = useOne<{ data: Row[] }>(
    fleet ? '/api/v1/records/equipment-inspections?days=90' : null,
  );
  const cleans = useOne<{ data: Row[] }>(fleet ? '/api/v1/cleaning-records' : null);
  const people = usePeople(fleet);
  const [vehicle, setVehicle] = useState('');
  const [kind, setKind] = useState('');
  const [days, setDays] = useState(3);

  const callsign = useMemo(
    () => new Map((vehicles.data?.data ?? []).map((v) => [v.id as string, v.callsign as string])),
    [vehicles.data],
  );
  const name = useMemo(
    () => new Map(people.map((p) => [p.id as string, p.displayName as string])),
    [people],
  );

  const all: Rec[] = useMemo(() => {
    const out: Rec[] = [];
    for (const c of vdis.data?.data ?? []) {
      const fails = ((c.results as Row[]) ?? []).filter((x) => x.result === 'FAIL');
      const critical = fails.some((x) => x.critical);
      out.push({
        key: `vdi-${c.id}`,
        at: c.capturedAt,
        vehicle: callsign.get(c.vehicleId) ?? '—',
        record: 'Daily check',
        ref: `VDI-${String(c.id).slice(0, 4).toUpperCase()}`,
        details: [
          c.odometer != null ? `${Number(c.odometer).toLocaleString('en-GB')} mi` : null,
          fails.length ? `failed ${fails.map((x) => x.code).join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        outcome: c.outcome === 'PASS' ? 'Pass' : critical ? 'Fail – critical' : 'Fail',
        tone: c.outcome === 'PASS' ? 'green' : 'red',
        icon: c.outcome === 'PASS' ? 'check_circle' : 'error',
        by: name.get(c.checkerUserId) ?? '—',
        alert: c.outcome !== 'PASS',
      });
    }
    for (const d of defects.data?.data ?? []) {
      const open = !['RELEASED', 'CLOSED', 'REPAIRED', 'RESOLVED'].includes(String(d.status));
      out.push({
        key: `def-${d.id}`,
        at: d.discoveredAt,
        vehicle: d.vehicleId ? (callsign.get(d.vehicleId) ?? '—') : (d.subjectLabel ?? '—'),
        record: 'Defect',
        ref: d.code ?? '',
        details: `${String(d.severity ?? '').charAt(0)}${String(d.severity ?? '')
          .slice(1)
          .toLowerCase()
          .replace(/_/g, ' ')} · ${d.description ?? ''}`,
        outcome: DEFECT_STATUS[d.status] ?? String(d.status),
        tone: open ? (d.stopUse ? 'red' : 'amber') : 'green',
        icon: open ? 'build' : 'check_circle',
        by: d.reportedByName ?? '—',
        alert: open && !!d.stopUse,
      });
    }
    for (const e of inspections.data?.data ?? []) {
      const ok = e.decision !== 'REJECTED';
      out.push({
        key: `eq-${e.id}`,
        at: e.verifiedAt,
        vehicle: e.vehicleId ? (callsign.get(e.vehicleId) ?? '—') : 'Base',
        record: 'Equipment inspection',
        ref: e.assetTag,
        details: `${String(e.category).charAt(0)}${String(e.category).slice(1).toLowerCase().replace(/_/g, ' ')} · ${e.check}`,
        outcome: ok ? 'Verified' : 'Rejected',
        tone: ok ? 'green' : 'red',
        icon: ok ? 'check_circle' : 'error',
        by: e.reviewerName ?? '—',
        alert: !ok,
      });
    }
    const CLEAN: Record<string, [string, string]> = {
      PRE_SHIFT: ['Pre-shift clean', 'Crew confirmed the IPC clean before the shift'],
      BETWEEN_PATIENT: ['Between-patient clean', 'Cleaned between patients'],
      ENHANCED: ['Enhanced clean', 'Enhanced (deep) clean recorded'],
    };
    for (const c of cleans.data?.data ?? []) {
      if (c.duplicate) continue;
      const [label, text] = CLEAN[c.type] ?? ['Clean', 'Cleaning recorded'];
      out.push({
        key: `cl-${c.id}`,
        at: c.capturedAt,
        vehicle: callsign.get(c.vehicleId) ?? '—',
        record: label,
        ref: 'IPC',
        details: text,
        outcome: 'Confirmed',
        tone: 'green',
        icon: 'check_circle',
        by: name.get(c.cleanedBy) ?? '—',
        alert: false,
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [vdis.data, defects.data, inspections.data, cleans.data, callsign, name]);

  const since = Date.now() - days * DAY;
  const shown = all.filter(
    (r) =>
      Date.parse(r.at) >= since &&
      (!vehicle || r.vehicle === vehicle) &&
      (!kind || r.record === kind || (kind === 'clean' && r.record.endsWith('clean'))),
  );

  const csv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      ['Date', 'Time', 'Vehicle', 'Record', 'Reference', 'Details', 'Outcome', 'By'].join(','),
      ...shown.map((r) =>
        [fmtDay(r.at), fmtTime(r.at), r.vehicle, r.record, r.ref, r.details, r.outcome, r.by]
          .map((x) => esc(String(x)))
          .join(','),
      ),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `records-by-date-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!fleet) return null;
  const first = shown.at(-1)?.at;
  return (
    <WfCard
      title="Records by date"
      extra={
        can('reports.export') ? (
          <button
            type="button"
            className="wf-btn sm ant-btn ant-btn-default ant-btn-sm"
            onClick={csv}
          >
            <Ms i="download" /> Export CSV
          </button>
        ) : undefined
      }
    >
      <div className="wf-filters">
        <Select
          aria-label="Vehicle"
          value={vehicle}
          onChange={setVehicle}
          style={{ minWidth: 140 }}
          options={[
            { value: '', label: 'All vehicles' },
            ...[...callsign.values()].sort().map((c) => ({ value: c, label: c })),
          ]}
        />
        <Select
          aria-label="Record type"
          value={kind}
          onChange={setKind}
          style={{ minWidth: 180 }}
          options={[
            { value: '', label: 'All records' },
            { value: 'Daily check', label: 'Daily checks' },
            { value: 'Defect', label: 'Defects' },
            { value: 'Equipment inspection', label: 'Equipment inspections' },
            { value: 'clean', label: 'Cleaning' },
          ]}
        />
        <Select
          aria-label="Period"
          value={days}
          onChange={setDays}
          style={{ minWidth: 140 }}
          options={[
            { value: 3, label: 'Last 3 days' },
            { value: 7, label: 'Last 7 days' },
            { value: 30, label: 'Last 30 days' },
            { value: 90, label: 'Last 90 days' },
          ]}
        />
      </div>
      <p className="wf-mini" role="status">
        {shown.length} record{shown.length === 1 ? '' : 's'}
        {first ? ` · ${fmtDay(first)} to ${fmtDay(new Date().toISOString())}` : ''}
      </p>
      <table className="wf-t ant-t" aria-label="Records by date">
        <thead className="ant-table-thead">
          <tr>
            {['Date', 'Vehicle', 'Record', 'Details', 'Outcome', 'By'].map((h) => (
              <th key={h} className="ant-table-cell" scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="ant-table-tbody">
          {shown.length === 0 && (
            <tr className="ant-table-row">
              <td className="ant-table-cell" colSpan={6}>
                {vdis.isLoading || defects.isLoading ? 'Loading…' : 'No records in this period.'}
              </td>
            </tr>
          )}
          {shown.map((r) => (
            <tr key={r.key} className={`ant-table-row${r.alert ? ' hh-alert-row' : ''}`}>
              <td className="ant-table-cell">
                <b>{fmtDay(r.at)}</b>
                <span className="sub">{fmtTime(r.at)}</span>
              </td>
              <td className="ant-table-cell">{r.vehicle}</td>
              <td className="ant-table-cell">
                <b>{r.record}</b>
                {r.ref && <span className="sub">{r.ref}</span>}
              </td>
              <td className="ant-table-cell">{r.details || '—'}</td>
              <td className="ant-table-cell">
                <WfTag tone={r.tone} icon={r.icon}>
                  {r.outcome}
                </WfTag>
              </td>
              <td className="ant-table-cell">{r.by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </WfCard>
  );
}
