import { DataTable, StatusBadge } from '@hub/ui';
import { useRef, useState, type ReactNode } from 'react';
import {
  ActionDialog,
  Field,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind = 'classify' | 'start' | 'repaired' | 'release' | 'reopen';

/** Defect progress in words (FLT-06): repaired is not the same as back in service. */
export const DEFECT_PROGRESS: Record<string, string> = {
  OPEN: 'Reported – awaiting repair',
  REPAIRING: 'Being repaired',
  REPAIRED: 'Repaired – awaiting return to service',
  RELEASED: 'Returned to service',
};

const open = (r: Row) => r.status === 'OPEN' || r.status === 'REPAIRING';
/** A minor defect that is not stop-use needs a named classifier and a repair deadline first. */
const needsClassifying = (r: Row) =>
  open(r) && !r.stopUse && r.severity === 'MINOR' && (!r.classifiedBy || !r.repairDeadline);
const subject = (r: Row) => (r.subjectLabel ? `${r.subjectLabel}: ` : '');

function Deadline({ r }: { r: Row }) {
  if (r.status === 'RELEASED' || r.repairDue === 'DONE') return <>Repair signed off</>;
  if (r.stopUse) return <>Repair before use</>;
  if (needsClassifying(r))
    return <StatusBadge status="GREY" reason="Not classified – needs a repair deadline" />;
  switch (r.repairDue) {
    case 'OVERDUE':
      return <StatusBadge status="RED" reason={`Overdue – was due ${fmtDate(r.repairDeadline)}`} />;
    case 'DUE_TODAY':
      return <StatusBadge status="AMBER" reason="Due today" />;
    case 'DUE_SOON':
      return <StatusBadge status="AMBER" reason={`Due ${fmtDate(r.repairDeadline)}`} />;
    case 'DUE':
      return <>Due {fmtDate(r.repairDeadline)}</>;
    default:
      return <>No deadline set</>;
  }
}

function Progress({ r }: { r: Row }) {
  let who: ReactNode = null;
  if (r.status === 'REPAIRED')
    who = `Signed off by ${r.repairedByName ?? 'unknown'}, ${fmtDateTime(r.repairedAt)}`;
  if (r.status === 'RELEASED' && r.release) {
    const by = r.release.releasedByName ?? 'unknown';
    who = `By ${by}, ${fmtDateTime(r.release.at)}: ${r.release.reason}`;
  }
  return (
    <div className="space-y-1">
      <p className="font-medium">{DEFECT_PROGRESS[r.status] ?? words(r.status)}</p>
      {who && <p className="text-xs text-slate-700">{who}</p>}
      {r.repairNotes && (
        <details className="text-xs">
          <summary className="cursor-pointer">Repair notes</summary>
          <p className="whitespace-pre-wrap">{r.repairNotes}</p>
        </details>
      )}
    </div>
  );
}

/** D4: the next step for each defect, in words. */
function nextAction(r: Row): string {
  if (r.status === 'RELEASED') return 'None';
  if (r.status === 'REPAIRED') return 'Return to service (by someone other than the repairer)';
  if (needsClassifying(r)) return 'Classify and set a repair deadline';
  if (r.status === 'OPEN') return 'Start the repair';
  return 'Record the repair';
}

export const SEVERITY_GUIDANCE: Record<string, string> = {
  CRITICAL: 'Critical – unsafe to use (always stop use)',
  MAJOR: 'Major – affects the journey or patient comfort; repair soon',
  MINOR: 'Minor – cosmetic or convenience; repair by a set date',
};

/** D4: report a defect on a vehicle or equipment, with optional photos. */
function ReportDefect({ vehicleId, onClose }: { vehicleId?: string; onClose: () => void }) {
  const { api, orgId } = useApp();
  const [on, setOn] = useState<'VEHICLE' | 'ASSET'>('VEHICLE');
  const [subjectId, setSubjectId] = useState(vehicleId ?? '');
  const [severity, setSeverity] = useState('');
  const [stopUse, setStopUse] = useState(false);
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [result, setResult] = useState<Row | null>(null);
  const reported = useRef(false);
  const pick = !vehicleId;
  const vehicles = useOne<{ data: Row[] }>(pick && on === 'VEHICLE' ? '/api/v1/vehicles' : null);
  const assets = useOne<{ data: Row[] }>(pick && on === 'ASSET' ? '/api/v1/equipment' : null);
  const list = (on === 'VEHICLE' ? vehicles : assets).data?.data ?? [];
  const critical = severity === 'CRITICAL';
  return (
    <>
      <ActionDialog
        open={result === null}
        title="Report a defect"
        confirmLabel="Report defect"
        danger={critical || stopUse}
        reasonLabel="Anything else the repairer should know (optional)"
        reasonRequired={false}
        confirmDisabled={!subjectId || !severity || description.trim().length < 3}
        onCancel={() => {
          if (!reported.current) onClose();
        }}
        onConfirm={async (extra) => {
          const ids: string[] = [];
          for (const f of photos.slice(0, 6)) {
            const up = await uploadFile(api, orgId, f, { title: `Defect photo ${f.name}` });
            ids.push(up.itemId);
          }
          const text = [description.trim(), extra.trim()].filter(Boolean).join('\n');
          const out = (await api.send('POST', '/api/v1/defects', orgId, {
            ...(on === 'VEHICLE' ? { vehicleId: subjectId } : { assetId: subjectId }),
            severity,
            stopUse: critical || stopUse,
            description: text,
            photoEvidenceItemIds: ids,
          })) as Row;
          reported.current = true;
          setResult(out);
          return out;
        }}
        fields={
          <div className="grid gap-3">
            {!vehicleId && (
              <>
                <Field label="Defect on">
                  <select
                    className={input}
                    value={on}
                    onChange={(e) => {
                      setOn(e.target.value as 'VEHICLE' | 'ASSET');
                      setSubjectId('');
                    }}
                  >
                    <option value="VEHICLE">A vehicle</option>
                    <option value="ASSET">Equipment</option>
                  </select>
                </Field>
                <Field label={on === 'VEHICLE' ? 'Vehicle' : 'Equipment'}>
                  <select
                    className={input}
                    value={subjectId}
                    onChange={(e) => setSubjectId(e.target.value)}
                  >
                    <option value="">Choose</option>
                    {list.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.callsign ?? x.tag}
                      </option>
                    ))}
                  </select>
                </Field>
              </>
            )}
            <Field label="Severity">
              <select
                className={input}
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
              >
                <option value="">Choose a severity</option>
                {Object.entries(SEVERITY_GUIDANCE).map(([k, t]) => (
                  <option key={k} value={k}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What is wrong?">
              <textarea
                className={input}
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field label="Photos (optional, up to 6)">
              <input
                type="file"
                accept="image/*"
                multiple
                className={input}
                onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={critical || stopUse}
                disabled={critical}
                onChange={(e) => setStopUse(e.target.checked)}
              />
              Stop use now{critical ? ' (always for a critical defect)' : ''}
            </label>
          </div>
        }
      >
        <p>
          Your name and the time are recorded. A critical or stop-use defect blocks the vehicle or
          equipment at once and control is alerted.
        </p>
      </ActionDialog>
      {result && (
        <div role="status" className="rounded border p-3 text-sm">
          <p>Defect reported.</p>
          {result.stopUse && (
            <p>
              Blocked until repaired and returned to service.{' '}
              {result.affectedJobCodes?.length
                ? `Jobs sent back for reassignment: ${result.affectedJobCodes.join(', ')}.`
                : 'No upcoming jobs were affected.'}
            </p>
          )}
          <button className={smallButton} onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </>
  );
}

export function Defects({ vehicleId }: { vehicleId?: string }) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [show, setShow] = useState<'ACTIVE' | 'RELEASED'>('ACTIVE');
  const [severityFilter, setSeverityFilter] = useState('');
  const [reporting, setReporting] = useState(false);
  const params = new URLSearchParams();
  if (show === 'RELEASED') params.set('status', 'RELEASED');
  if (vehicleId) params.set('vehicleId', vehicleId);
  if (severityFilter) params.set('severity', severityFilter);
  const qs = params.toString();
  const res = useOne<{ data: Row[] }>(`/api/v1/defects${qs ? `?${qs}` : ''}`);
  const [act, setAct] = useState<{ kind: Kind; r: Row } | null>(null);
  const [severity, setSeverity] = useState('MINOR');
  const [deadline, setDeadline] = useState('');
  const [stopUse, setStopUse] = useState(false);
  const [sheet, setSheet] = useState<File | null>(null);
  const [checked, setChecked] = useState(false);

  const begin = (kind: Kind, r: Row) => {
    setSeverity(r.severity === 'CRITICAL' ? 'MAJOR' : r.severity);
    setDeadline(r.repairDeadline ?? '');
    setStopUse(false);
    setSheet(null);
    setChecked(false);
    setAct({ kind, r });
  };
  const btn = (kind: Kind, r: Row, text: string) => (
    <button
      key={kind}
      className={smallButton}
      aria-label={`${text}: ${subject(r)}${r.description}`}
      onClick={() => begin(kind, r)}
    >
      {text}
    </button>
  );

  function actions(r: Row) {
    const out: ReactNode[] = [];
    if (can('fleet.defect.manage') && open(r)) {
      if (!r.stopUse) out.push(btn('classify', r, 'Classify'));
      if (!needsClassifying(r)) {
        if (r.status === 'OPEN') out.push(btn('start', r, 'Start repair'));
        out.push(btn('repaired', r, 'Sign off repair'));
      }
    }
    if (can('fleet.return_to_service') && r.status === 'REPAIRED') {
      if (r.repairedBy === me.user.id)
        out.push(
          <span key="self" className="text-xs">
            Someone other than the repairer must return it to service.
          </span>,
        );
      else out.push(btn('release', r, 'Return to service'));
      out.push(btn('reopen', r, 'Send back for repair'));
    }
    return out.length ? <div className="flex flex-wrap items-center gap-2">{out}</div> : null;
  }

  const r = act?.r;
  const patch = (b: Record<string, unknown>) =>
    api.send('PATCH', `/api/v1/defects/${r!.id}`, orgId, b, r!.version);
  const dialog: Record<
    Kind,
    {
      title: string;
      confirm: string;
      reasonLabel?: string;
      reasonRequired?: boolean;
      danger?: boolean;
      text: string;
      run: (reason: string) => Promise<unknown>;
    }
  > = {
    classify: {
      title: 'Classify defect',
      confirm: 'Save classification',
      text: 'Your name is recorded as the classifier. Making it stop-use blocks the vehicle or asset at once and sends its upcoming jobs back for reassignment.',
      run: () =>
        patch({
          severity,
          ...(deadline ? { repairDeadline: deadline } : {}),
          ...(stopUse ? { stopUse: true } : {}),
        }),
    },
    start: {
      title: 'Start repair',
      confirm: 'Start repair',
      reasonLabel: 'Repair plan or workshop booking',
      reasonRequired: false,
      text: 'The defect stays open, and any block stays in place, until the repair is signed off and someone returns it to service.',
      run: (reason) => patch({ status: 'REPAIRING', ...(reason ? { repairNotes: reason } : {}) }),
    },
    repaired: {
      title: 'Sign off repair',
      confirm: 'Sign off repair',
      reasonLabel: 'What was repaired? (work done, parts, by whom, date)',
      text: 'Signing off does not put it back into service. Someone else with return-to-service rights must check it and release it. Your name is recorded.',
      run: async (reason) => {
        const up = sheet
          ? await uploadFile(api, orgId, sheet, { title: `Job sheet ${r!.description}` })
          : null;
        return patch({
          status: 'REPAIRED',
          repairNotes: reason,
          ...(up ? { repairJobSheetEvidenceItemId: up.itemId } : {}),
        });
      },
    },
    release: {
      title: 'Return to service',
      confirm: 'Return to service',
      reasonLabel: 'What was checked after the repair?',
      text: 'Returning it to service lifts the block on the vehicle or asset if nothing else stops it being used. Your name and what you checked are recorded and cannot be changed.',
      run: (reason) => api.send('POST', `/api/v1/defects/${r!.id}/release`, orgId, { reason }),
    },
    reopen: {
      title: 'Send back for repair',
      confirm: 'Send back',
      reasonLabel: 'What is still wrong?',
      danger: true,
      text: 'The repair sign-off is cleared and the defect goes back to "Being repaired". The vehicle or asset stays blocked if the defect is stop-use.',
      run: (reason) => api.send('POST', `/api/v1/defects/${r!.id}/reopen`, orgId, { reason }),
    },
  };
  const d = act ? dialog[act.kind] : null;
  const classifyIncomplete =
    act?.kind === 'classify' && !stopUse && severity === 'MINOR' && !deadline;
  const releaseUnchecked = act?.kind === 'release' && !checked;

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show">
          <select
            className={`${input} w-60`}
            value={show}
            onChange={(e) => setShow(e.target.value as 'ACTIVE' | 'RELEASED')}
          >
            <option value="ACTIVE">Open defects</option>
            <option value="RELEASED">Returned to service</option>
          </select>
        </Field>
        <Field label="Severity filter">
          <select
            className={`${input} w-48`}
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
          >
            <option value="">All severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="MAJOR">Major</option>
            <option value="MINOR">Minor</option>
          </select>
        </Field>
        {can('fleet.defect.create') && (
          <button className={smallButton} onClick={() => setReporting(true)}>
            Report a defect
          </button>
        )}
      </div>
      {reporting && <ReportDefect vehicleId={vehicleId} onClose={() => setReporting(false)} />}
      <DataTable<Row>
        caption={show === 'ACTIVE' ? 'Open defects' : 'Defects returned to service'}
        rows={res.data?.data ?? []}
        rowKey={(x) => x.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load defects.' : null}
        emptyMessage={show === 'ACTIVE' ? 'No open defects.' : 'No defects returned to service.'}
        columns={[
          ...(vehicleId
            ? []
            : [{ key: 'on', header: 'On', cell: (x: Row) => x.subjectLabel ?? '—' }]),
          {
            key: 'sev',
            header: 'Severity',
            cell: (x) => (
              <StatusBadge
                status={x.stopUse ? 'RED' : x.severity === 'MAJOR' ? 'AMBER' : 'GREY'}
                reason={`${words(x.severity)}${x.stopUse ? ' – stop use' : ''}`}
              />
            ),
          },
          { key: 'desc', header: 'Description', cell: (x) => x.description },
          {
            key: 'when',
            header: 'Reported',
            cell: (x) => (
              <>
                {fmtDateTime(x.discoveredAt)}
                <span className="block text-xs text-slate-700">
                  by {x.reportedByName ?? 'unknown'}
                </span>
              </>
            ),
          },
          { key: 'due', header: 'Repair deadline', cell: (x) => <Deadline r={x} /> },
          { key: 'status', header: 'Progress', cell: (x) => <Progress r={x} /> },
          { key: 'next', header: 'Next action', cell: (x) => nextAction(x) },
          { key: 'act', header: 'Action', cell: (x) => actions(x) },
        ]}
      />
      <ActionDialog
        open={d !== null}
        title={d ? `${d.title}: ${r ? subject(r) : ''}${r?.description ?? ''}` : ''}
        confirmLabel={d?.confirm ?? ''}
        reasonLabel={d?.reasonLabel}
        reasonRequired={d?.reasonRequired}
        danger={d?.danger}
        confirmDisabled={classifyIncomplete || releaseUnchecked}
        onCancel={() => setAct(null)}
        onConfirm={(reason) => d!.run(reason)}
        fields={
          act?.kind === 'repaired' ? (
            <Field label="Garage job sheet (optional)">
              <input
                type="file"
                accept="image/*,application/pdf"
                className={input}
                onChange={(e) => setSheet(e.target.files?.[0] ?? null)}
              />
            </Field>
          ) : act?.kind === 'release' ? (
            <>
              {r?.repairNotes && (
                <p className="text-sm">
                  Repair record: <span className="whitespace-pre-wrap">{r.repairNotes}</span>
                </p>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                I have checked the repair and the vehicle or equipment is safe to use
              </label>
            </>
          ) : act?.kind === 'classify' ? (
            <>
              <Field label="Severity">
                <select
                  className={input}
                  value={severity}
                  onChange={(e) => setSeverity(e.target.value)}
                >
                  <option value="MINOR">Minor</option>
                  <option value="MAJOR">Major</option>
                </select>
              </Field>
              <Field
                label={`Repair deadline${!stopUse && severity === 'MINOR' ? ' (required)' : ''}`}
              >
                <input
                  type="date"
                  className={input}
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={stopUse}
                  onChange={(e) => setStopUse(e.target.checked)}
                />
                Stop use until repaired and returned to service
              </label>
            </>
          ) : undefined
        }
      >
        <p>{d?.text}</p>
      </ActionDialog>
    </>
  );
}
