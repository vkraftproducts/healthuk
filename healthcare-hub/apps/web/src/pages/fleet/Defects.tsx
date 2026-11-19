import { DataTable, StatusBadge } from '@hub/ui';
import { Button, Checkbox, Input, Select } from 'antd';
import { useRef, useState, type ReactNode } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  fmtDate,
  fmtDateTime,
  input,
  useCan,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useInvalidate, useOne, usePeople } from '../settings/hooks.js';
import { daysUntil, londonDate } from '@hub/rules';
import { useNavigate } from '@tanstack/react-router';
import { Ms, RowActions, WfCard, WfTag } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind = 'classify' | 'start' | 'repaired' | 'release' | 'reopen';
/** The detail panel can also change the owner and review date. */
type DetailKind = Kind | 'owner';

/** Defect progress in words (FLT-06): repaired is not the same as back in service. */
export const DEFECT_PROGRESS: Record<string, string> = {
  OPEN: 'Reported – awaiting repair',
  REPAIRING: 'Being repaired',
  REPAIRED: 'Repaired – awaiting return to service',
  RELEASED: 'Returned to service',
};

const open = (r: Row) => r.status === 'OPEN' || r.status === 'REPAIRING';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** v36 dates in London time: "15 Nov" / "15 Nov 2026" (three-letter months). */
function fmtV36(iso: string, year: boolean) {
  const x = iso.length === 10 ? iso : londonDate(new Date(iso));
  return `${Number(x.slice(8, 10))} ${MON[Number(x.slice(5, 7)) - 1]}${year ? ` ${x.slice(0, 4)}` : ''}`;
}
/** UK number plates read with a space before the last three characters (SY21 ABD). */
const ukPlate = (r: string) => (r.includes(' ') ? r : r.replace(/^(.+)(.{3})$/, '$1 $2'));
const hmLondon = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(new Date(iso));
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
export function ReportDefect({ vehicleId, onClose }: { vehicleId?: string; onClose: () => void }) {
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
        reasonLabel="Anything else the repairer should know"
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
                  <Select
                    value={on}
                    onChange={(v) => {
                      setOn(v as 'VEHICLE' | 'ASSET');
                      setSubjectId('');
                    }}
                    style={{ width: '100%' }}
                    options={[
                      { value: 'VEHICLE', label: 'A vehicle' },
                      { value: 'ASSET', label: 'Equipment' },
                    ]}
                  />
                </Field>
                <Field label={on === 'VEHICLE' ? 'Vehicle' : 'Equipment'}>
                  <Select
                    value={subjectId || undefined}
                    placeholder="Choose"
                    onChange={setSubjectId}
                    style={{ width: '100%' }}
                    options={list.map((x) => ({
                      value: x.id,
                      label: String(x.callsign ?? x.tag),
                    }))}
                  />
                </Field>
              </>
            )}
            <Field label="Severity">
              <Select
                value={severity || undefined}
                placeholder="Choose a severity"
                onChange={setSeverity}
                style={{ width: '100%' }}
                options={Object.entries(SEVERITY_GUIDANCE).map(([k, t]) => ({
                  value: k,
                  label: t,
                }))}
              />
            </Field>
            <Field label="What is wrong?">
              <Input.TextArea
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
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
            <Checkbox
              checked={critical || stopUse}
              disabled={critical}
              onChange={(e) => setStopUse(e.target.checked)}
            >
              Stop use now{critical ? ' (always for a critical defect)' : ''}
            </Checkbox>
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
          <Button size="small" onClick={onClose}>
            Close
          </Button>
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
    <Button
      key={kind}
      size="small"
      aria-label={`${text}: ${subject(r)}${r.description}`}
      onClick={() => begin(kind, r)}
    >
      {text}
    </Button>
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
          <Button size="small" onClick={() => setReporting(true)}>
            Report a defect
          </Button>
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
          {
            key: 'owner',
            header: 'Owner',
            cell: (x) => x.ownerName ?? (x.ownerUserId ? 'Assigned' : 'Unassigned'),
          },
          {
            key: 'review',
            header: 'Review by',
            cell: (x) => (x.reviewBy ? fmtDate(x.reviewBy) : '—'),
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
              <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>
                I have checked the repair and the vehicle or equipment is safe to use
              </Checkbox>
            </>
          ) : act?.kind === 'classify' ? (
            <>
              <Field label="Severity">
                <Select
                  value={severity}
                  onChange={setSeverity}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'MINOR', label: 'Minor' },
                    { value: 'MAJOR', label: 'Major' },
                  ]}
                />
              </Field>
              <Field
                label={`Repair deadline${!stopUse && severity === 'MINOR' ? ' (required)' : ''}`}
              >
                <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
              <Checkbox checked={stopUse} onChange={(e) => setStopUse(e.target.checked)}>
                Stop use until repaired and returned to service
              </Checkbox>
            </>
          ) : undefined
        }
      >
        <p>{d?.text}</p>
      </ActionDialog>
    </>
  );
}

// ---- v36 defect board ---------------------------------------------------------------------------
const BOARD: { label: string; is: (s: string) => boolean }[] = [
  { label: 'Reported', is: (s) => s === 'OPEN' },
  { label: 'In repair', is: (s) => s === 'REPAIRING' },
  { label: 'Signed off', is: (s) => s === 'REPAIRED' },
  { label: 'Returned to service', is: (s) => s === 'RELEASED' },
];
const SEV: Record<string, { tone: 'red' | 'amber' | 'grey'; icon: string; text: string }> = {
  CRITICAL: { tone: 'red', icon: 'dangerous', text: 'Critical – stop use' },
  MAJOR: { tone: 'amber', icon: 'warning', text: 'Major' },
  MINOR: { tone: 'grey', icon: 'info', text: 'Minor' },
};
const dShort = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });

/** v36 #20 defect detail: header, notes, history, and the same actions as the table. */
function DefectDetail({
  defect,
  onClose,
  onChanged,
}: {
  defect: Row;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [act, setAct] = useState<DetailKind | null>(null);
  const [severity, setSeverity] = useState(
    defect.severity === 'CRITICAL' ? 'MAJOR' : (defect.severity as string),
  );
  const [deadline, setDeadline] = useState((defect.repairDeadline as string) ?? '');
  const [stopUse, setStopUse] = useState(false);
  const [sheet, setSheet] = useState<File | null>(null);
  const [checked, setChecked] = useState(false);
  const [jobSheet, setJobSheet] = useState('');
  const [owner, setOwner] = useState((defect.ownerUserId as string) ?? '');
  const [reviewBy, setReviewBy] = useState((defect.reviewBy as string) ?? '');
  const navigate = useNavigate();
  const people = usePeople();
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles');
  const sev = SEV[defect.severity] ?? SEV.MINOR!;
  const patch = (b: Record<string, unknown>) =>
    api.send('PATCH', `/api/v1/defects/${defect.id}`, orgId, b, defect.version);
  const dialog: Record<
    DetailKind,
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
      text: 'Your name is recorded as the classifier.',
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
      text: 'The defect stays open until the repair is signed off and returned to service.',
      run: (reason) => patch({ status: 'REPAIRING', ...(reason ? { repairNotes: reason } : {}) }),
    },
    repaired: {
      title: 'Sign off repair',
      confirm: 'Sign off repair',
      reasonLabel: 'What was repaired?',
      text: 'Signing off does not put it back into service. Someone else must release it.',
      run: async (reason) => {
        const up = sheet
          ? await uploadFile(api, orgId, sheet, { title: `Job sheet ${defect.description}` })
          : null;
        return patch({
          status: 'REPAIRED',
          repairNotes: reason,
          ...(jobSheet.trim() ? { jobSheetRef: jobSheet.trim() } : {}),
          ...(up ? { repairJobSheetEvidenceItemId: up.itemId } : {}),
        });
      },
    },
    release: {
      title: 'Return to service',
      confirm: 'Return to service',
      reasonLabel: 'What was checked after the repair?',
      text: 'Returning it to service lifts the block if nothing else stops it being used.',
      run: (reason) => api.send('POST', `/api/v1/defects/${defect.id}/release`, orgId, { reason }),
    },
    owner: {
      title: 'Owner / review date',
      confirm: 'Save',
      text: 'The owner follows the defect up; it escalates if the review date passes.',
      run: () => patch({ ownerUserId: owner, reviewBy }),
    },
    reopen: {
      title: 'Send back for repair',
      confirm: 'Send back',
      reasonLabel: 'What is still wrong?',
      danger: true,
      text: 'The repair sign-off is cleared and the defect goes back to being repaired.',
      run: (reason) => api.send('POST', `/api/v1/defects/${defect.id}/reopen`, orgId, { reason }),
    },
  };
  const d = act ? dialog[act] : null;
  const classifyIncomplete = act === 'classify' && !stopUse && severity === 'MINOR' && !deadline;
  const releaseUnchecked = act === 'release' && !checked;
  // v36 #20 detail: header actions, the four steps, the record and its history.
  const manage = can('fleet.defect.manage');
  const releaser = can('fleet.return_to_service');
  type Act = { label: string; icon: string; kind?: DetailKind; primary?: boolean; go?: () => void };
  const actions: Act[] = [
    ...(defect.status === 'REPAIRED' && releaser && defect.repairedBy !== me.user.id
      ? [
          {
            label: 'Return to service',
            icon: 'directions_car',
            kind: 'release' as const,
            primary: true,
          },
        ]
      : []),
    ...(defect.status === 'REPAIRED' && releaser
      ? [{ label: 'Reject sign-off', icon: 'undo', kind: 'reopen' as const }]
      : []),
    ...(manage && needsClassifying(defect)
      ? [{ label: 'Classify', icon: 'rule', kind: 'classify' as const, primary: true }]
      : manage && defect.status === 'OPEN'
        ? [{ label: 'Start repair', icon: 'build', kind: 'start' as const, primary: true }]
        : manage && defect.status === 'REPAIRING'
          ? [
              {
                label: 'Sign off repair',
                icon: 'task_alt',
                kind: 'repaired' as const,
                primary: true,
              },
            ]
          : []),
    ...(manage && open(defect) && !defect.stopUse && !needsClassifying(defect)
      ? [{ label: 'Classify', icon: 'rule', kind: 'classify' as const }]
      : []),
    ...(manage && defect.status !== 'RELEASED'
      ? [{ label: 'Owner / review date', icon: 'manage_accounts', kind: 'owner' as const }]
      : []),
    ...(defect.vehicleId
      ? [
          {
            label: 'Vehicle history',
            icon: 'history',
            go: () =>
              void navigate({
                to: '/vehicles',
                search: { tab: 'vehicles', view: 'history', vehicle: defect.vehicleId as string },
              }),
          },
        ]
      : []),
  ];
  const v = (vehicles.data?.data ?? []).find((x) => x.id === defect.vehicleId);
  const dm = (iso: string) => fmtV36(iso, false);
  const dmy = (iso: string) => fmtV36(iso, true);
  const at = (iso: string) => `${dmy(iso)}, ${hmLondon(iso)}`;
  const reported = defect.discoveredAt as string;
  const started = (defect.repairStartedAt as string | null) ?? null;
  const signed = (defect.repairedAt as string | null) ?? null;
  const released = (defect.release?.at as string | undefined) ?? null;
  const stage =
    ({ OPEN: 0, REPAIRING: 1, REPAIRED: 2, RELEASED: 3 } as Record<string, number>)[
      defect.status as string
    ] ?? 0;
  const steps = [
    { label: 'Reported', when: reported },
    { label: 'In repair', when: started },
    { label: 'Signed off', when: signed },
    { label: 'Returned to service', when: released },
  ];
  const review = (defect.reviewBy as string | null) ?? null;
  const reviewLeft = review ? daysUntil(review, new Date()) : null;
  const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const history = [
    released && {
      when: released,
      what: `Returned to service: ${lower(defect.release.reason as string)}`,
      who: defect.release.releasedByName as string | null,
    },
    signed && {
      when: signed,
      what: `Repair signed off${defect.jobSheetRef ? ` (job sheet ${defect.jobSheetRef})` : ''}${
        defect.status === 'REPAIRED' ? ' – awaiting return to service' : ''
      }`,
      who: defect.repairedByName as string | null,
    },
    started && {
      when: started,
      what: `Repair started${defect.repairPlan ? `: ${lower(defect.repairPlan as string)}` : ''}`,
      who: defect.repairStartedByName as string | null,
    },
    {
      when: reported,
      what: `Defect reported (${(defect.severity as string).toLowerCase()}): ${lower(
        defect.description as string,
      )}`,
      who: defect.reportedByName as string | null,
    },
  ].filter(Boolean) as { when: string; what: string; who: string | null }[];
  return (
    <>
      <WfCard
        className="wf-detail"
        title={
          <>
            {defect.code ?? 'Defect'}{' '}
            <span className="wf-mut" style={{ fontWeight: 600 }}>
              · {defect.subjectLabel ?? 'Asset'}
            </span>
          </>
        }
        extra={
          <div className="wf-a">
            {actions.map((a) => (
              <Button
                key={a.label}
                type={a.primary ? 'primary' : 'default'}
                icon={<Ms i={a.icon} />}
                onClick={() => (a.go ? a.go() : setAct(a.kind!))}
              >
                {a.label}
              </Button>
            ))}
            <Button size="small" aria-label="Close" icon={<Ms i="close" />} onClick={onClose} />
          </div>
        }
      >
        <ol className="wf-steps">
          {steps.map((x, n) => (
            <li key={x.label} className={n < stage ? 'done' : n === stage ? 'now' : ''}>
              <span className="dot">
                <Ms i={n < stage ? 'check' : n === stage ? 'radio_button_checked' : 'circle'} />
              </span>
              <b>{x.label}</b>
              {x.when && <small>{`${dm(x.when)} ${hmLondon(x.when)}`}</small>}
            </li>
          ))}
        </ol>
        <div className="wf-g2">
          <div>
            <dl className="wf-dl">
              <dt>Vehicle</dt>
              <dd>
                {defect.subjectLabel ?? '—'}
                {v?.registration ? ` · ${ukPlate(v.registration as string)}` : ''}
              </dd>
              <dt>Severity</dt>
              <dd>
                <WfTag tone={sev.tone} icon={sev.icon}>
                  {sev.text}
                </WfTag>
              </dd>
              <dt>What is wrong</dt>
              <dd>{defect.description}</dd>
              <dt>Reported</dt>
              <dd>
                {defect.reportedByName ?? '—'} · {at(reported)}
              </dd>
              <dt>Photos</dt>
              <dd>{((defect.photoEvidenceItemIds as string[]) ?? []).length}</dd>
              <dt>Owner</dt>
              <dd>{defect.ownerName ?? '—'}</dd>
              <dt>Review by</dt>
              <dd>
                {review ? (
                  <>
                    {dmy(review)}{' '}
                    {reviewLeft !== null && reviewLeft < 0 ? (
                      <WfTag tone="red" icon="error">
                        {-reviewLeft} day{reviewLeft === -1 ? '' : 's'} overdue
                      </WfTag>
                    ) : (
                      <WfTag tone="grey" icon="radio_button_unchecked">
                        Due {dm(review)}
                      </WfTag>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              {defect.repairPlan && (
                <>
                  <dt>Repair plan</dt>
                  <dd>
                    {defect.repairPlan}
                    {started && (
                      <span className="sub wf-mut">
                        {' '}
                        – {defect.repairStartedByName ?? '—'}, {at(started)}
                      </span>
                    )}
                  </dd>
                </>
              )}
              {signed && (
                <>
                  <dt>Signed off</dt>
                  <dd>
                    {defect.repairNotes}
                    {defect.jobSheetRef ? ` · job sheet ${defect.jobSheetRef}` : ''}
                    <span className="wf-mut">
                      {' '}
                      – {defect.repairedByName ?? '—'}, {at(signed)}
                    </span>
                  </dd>
                </>
              )}
            </dl>
          </div>
          <div>
            <h3 style={{ margin: '0 0 .6rem' }}>History</h3>
            <ol className="wf-tl">
              {history.map((h) => (
                <li key={h.when + h.what}>
                  <span className="when">{`${dmy(h.when)} · ${hmLondon(h.when)}`}</span>
                  <b>{h.what}</b>
                  {h.who && <span className="who">{h.who}</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </WfCard>
      <ActionDialog
        open={d !== null}
        title={d ? `${d.title}: ${defect.subjectLabel ?? ''}` : ''}
        confirmLabel={d?.confirm ?? ''}
        reasonLabel={d?.reasonLabel}
        reasonRequired={d?.reasonRequired}
        danger={d?.danger}
        confirmDisabled={
          classifyIncomplete || releaseUnchecked || (act === 'owner' && (!owner || !reviewBy))
        }
        onCancel={() => setAct(null)}
        onConfirm={async (reason) => {
          await d!.run(reason);
          setAct(null);
          // The panel stays open and shows the defect's new stage (v36).
          onChanged();
        }}
        fields={
          act === 'owner' ? (
            <>
              <PersonSelect
                label="Owner"
                value={owner}
                onChange={setOwner}
                people={people}
                meId={me.user.id}
              />
              <Field label="Review by">
                <Input type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} />
              </Field>
            </>
          ) : act === 'repaired' ? (
            <>
              <Field label="Job sheet reference (optional)">
                <Input value={jobSheet} onChange={(e) => setJobSheet(e.target.value)} />
              </Field>
              <Field label="Garage job sheet (optional)">
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  className={input}
                  onChange={(e) => setSheet(e.target.files?.[0] ?? null)}
                />
              </Field>
            </>
          ) : act === 'release' ? (
            <>
              {defect.repairNotes && (
                <p className="text-sm">
                  Repair record: <span className="whitespace-pre-wrap">{defect.repairNotes}</span>
                </p>
              )}
              <Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)}>
                I have checked the repair and the vehicle or equipment is safe to use
              </Checkbox>
            </>
          ) : act === 'classify' ? (
            <>
              <Field label="Severity">
                <Select
                  value={severity}
                  onChange={setSeverity}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'MINOR', label: 'Minor' },
                    { value: 'MAJOR', label: 'Major' },
                  ]}
                />
              </Field>
              <Field
                label={`Repair deadline${!stopUse && severity === 'MINOR' ? ' (required)' : ''}`}
              >
                <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </Field>
              <Checkbox checked={stopUse} onChange={(e) => setStopUse(e.target.checked)}>
                Stop use until repaired and returned to service
              </Checkbox>
            </>
          ) : undefined
        }
      >
        <p>{d?.text}</p>
      </ActionDialog>
    </>
  );
}

export function DefectsV36() {
  const today = londonDate(new Date());
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [detailId, setDetailId] = useState<string | null>(null);
  const active = useOne<{ data: Row[] }>('/api/v1/defects');
  const released = useOne<{ data: Row[] }>('/api/v1/defects?status=RELEASED');
  const planner = useOne<Row>(`/api/v1/planner?date=${today}`);
  const all = [
    ...(active.data?.data ?? []),
    ...(released.data?.data ?? []).filter(
      (d) =>
        d.release &&
        Date.now() - Date.parse(d.release.releasedAt ?? d.release.at ?? 0) < 7 * 86_400_000,
    ),
  ];
  // Follows the board, so the open panel shows the defect's latest stage after an action.
  const detail = all.find((d) => d.id === detailId) ?? null;
  const blockedJobs = ((planner.data?.shifts as Row[]) ?? [])
    .filter((s) => s.vehicleStatus === 'BLOCKED' || s.vehicleStatus === 'QUARANTINED')
    .flatMap((s) =>
      ((s.jobs as Row[]) ?? [])
        .filter((j) => londonDate(new Date(j.startsAt)) === today)
        .map((j) => ({ s, j })),
    );
  const hm = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    }).format(new Date(iso));
  return (
    <>
      {blockedJobs.length > 0 && (
        <WfCard
          title="Jobs on blocked vehicles"
          className="wf-hot"
          table
          extra={
            <span className="wf-mini">Blocking a vehicle flags its booked jobs straight away</span>
          }
        >
          <DataTable<(typeof blockedJobs)[number]>
            caption="Jobs on blocked vehicles"
            rows={blockedJobs}
            rowKey={(x) => x.j.jobId}
            rowTone={() => 'red'}
            columns={[
              { key: 'j', header: 'Job', cell: (x) => <b>{x.j.code}</b> },
              { key: 't', header: 'Time', cell: (x) => hm(x.j.startsAt) },
              { key: 'v', header: 'Vehicle', cell: (x) => x.s.vehicleCallsign },
              {
                key: 'r',
                header: 'Reason',
                cell: (x) => (
                  <WfTag tone="red" icon="error">
                    {x.s.vehicleBlockReason ?? 'Vehicle blocked'}
                  </WfTag>
                ),
              },
              {
                key: 'a',
                header: '',
                cell: (x) => (
                  <RowActions
                    name={x.j.code}
                    primary={{
                      label: 'Reallocate',
                      icon: 'swap_horiz',
                      onClick: () => void navigate({ to: '/planner' }),
                    }}
                  />
                ),
              },
            ]}
          />
        </WfCard>
      )}
      <WfCard
        title="Defect board"
        extra={<span className="wf-mini">Click a defect to open it</span>}
      >
        <div className="wf-board" style={{ gridTemplateColumns: 'repeat(4,minmax(220px,1fr))' }}>
          {BOARD.map((col) => {
            const inCol = all.filter((d) => col.is(d.status));
            return (
              <section key={col.label} className="wf-col" aria-label={col.label}>
                <h4>
                  <span>{col.label}</span>
                  <span>{inCol.length}</span>
                </h4>
                {inCol.map((d) => {
                  const sev = SEV[d.severity] ?? SEV.MINOR!;
                  const code = (d.code as string) || 'Defect';
                  return (
                    <button key={d.id} type="button" className="wf-pc" onClick={() => setDetailId(d.id as string)}>
                      <b>
                        {code} · {d.subjectLabel}
                      </b>
                      <small>{d.description}</small>
                      <WfTag tone={sev.tone} icon={sev.icon}>
                        {sev.text}
                      </WfTag>
                      {d.ownerName && (
                        <small style={{ marginTop: '.35rem' }}>Owner: {d.ownerName}</small>
                      )}
                      {d.reviewBy && d.status !== 'RELEASED' && (
                        <WfTag tone="grey" icon="radio_button_unchecked">
                          Review by {dShort(d.reviewBy)}
                        </WfTag>
                      )}
                    </button>
                  );
                })}
              </section>
            );
          })}
        </div>
      </WfCard>
      {detail && (
        <DefectDetail
          key={`${detail.id as string}-${detail.version as number}`}
          defect={detail}
          onClose={() => setDetailId(null)}
          onChanged={() => void invalidate()}
        />
      )}
      <div id="all-defects">
        <WfCard title="All defects" table>
          <Defects />
        </WfCard>
      </div>
    </>
  );
}
