import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  button,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { EvidenceDialog, UploadDialog } from '../evidence/Evidence.js';
import { useApp } from '../../shell/AppContext.js';
import { useList, useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const AREAS = [
  'FIRE',
  'WATER',
  'ELECTRICAL_GAS',
  'COSHH_INFECTION',
  'OXYGEN',
  'PEOPLE_WORKPLACE',
  'BUILDING_EQUIPMENT',
] as const;
const AREA_WORDS: Record<string, string> = {
  FIRE: 'Fire safety',
  WATER: 'Water safety (legionella)',
  ELECTRICAL_GAS: 'Electrical and gas',
  COSHH_INFECTION: 'Hazardous substances and infection control',
  OXYGEN: 'Medical gases and oxygen',
  PEOPLE_WORKPLACE: 'People and workplace',
  BUILDING_EQUIPMENT: 'Building and fixed equipment',
};

/** Published premises schedules owned by this organisation (library items must be adopted). */
function usePremisesSchedules(enabled: boolean) {
  const templates = useList('/api/v1/requirements/templates', enabled);
  return (templates.data ?? []).filter(
    (t) =>
      !t.isLibrary &&
      (t.versions as Row[]).some((v) => v.subjectType === 'PREMISES' && v.status === 'EFFECTIVE'),
  );
}

/** Premises safety register per location (HSE-01). Intervals come from a named source only. */
export function Premises() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>(can('premises.item.view') ? '/api/v1/premises-items' : null);
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const people = usePeople(can('premises.item.manage'));
  const schedules = usePremisesSchedules(can('compliance.requirement.view'));
  const [open, setOpen] = useState(false);
  const [docsFor, setDocsFor] = useState<Row | null>(null);
  const [uploadFor, setUploadFor] = useState<Row | null>(null);
  const [deciding, setDeciding] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [linking, setLinking] = useState<Row | null>(null);
  const [f, setF] = useState({
    locationId: '',
    controlArea: 'FIRE' as string,
    title: '',
    responsibleUserId: me.user.id,
    actionOwnerUserId: '',
    contractorName: '',
    assessmentRef: '',
    assessedOn: '',
    frequencySource: '',
    templateId: '',
    areaName: '',
    intervalMonths: '',
    confirmClinicalControl: false,
  });
  const [history, setHistory] = useState<Row | null>(null);
  const [finding, setFinding] = useState<Row | null>(null);
  const [reviewerId, setReviewerId] = useState('');
  const [reviewOn, setReviewOn] = useState('');
  if (!orgId) return <p role="status">Select an organisation to continue.</p>;
  if (!can('premises.item.view'))
    return <p role="alert">You do not have access to premises safety.</p>;
  const locs = locations.data?.data ?? [];
  const loc = (id: string) => locs.find((l) => l.id === id)?.name ?? 'Location';
  const named = (id: string | null, name: string | null | undefined) =>
    !id ? 'Not set' : id === me.user.id ? `${name ?? 'You'} (you)` : (name ?? 'Former member');
  const chosen = locs.find((l) => l.id === f.locationId);
  const needsClinicalConfirm = chosen?.type === 'ADMIN_ONLY' && f.controlArea === 'COSHH_INFECTION';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      locationId: f.locationId,
      controlArea: f.controlArea,
      title: f.title,
      responsibleUserId: f.responsibleUserId,
      frequencySource: f.frequencySource,
    };
    if (f.actionOwnerUserId) payload.actionOwnerUserId = f.actionOwnerUserId;
    if (f.contractorName.trim()) payload.contractorName = f.contractorName.trim();
    if (f.assessmentRef.trim()) payload.assessmentRef = f.assessmentRef.trim();
    if (f.assessedOn) payload.assessedOn = f.assessedOn;
    if (f.templateId) payload.templateId = f.templateId;
    if (f.areaName.trim()) payload.areaName = f.areaName.trim();
    if (f.intervalMonths) payload.intervalMonths = Number(f.intervalMonths);
    if (needsClinicalConfirm) payload.confirmClinicalControl = f.confirmClinicalControl;
    void run(
      async () => {
        await api.send('POST', '/api/v1/premises-items', orgId, payload);
        setOpen(false);
        setF({
          ...f,
          title: '',
          contractorName: '',
          assessmentRef: '',
          assessedOn: '',
          frequencySource: '',
          templateId: '',
          areaName: '',
          intervalMonths: '',
        });
      },
      f.templateId
        ? 'Premises item added with its schedule.'
        : 'Premises item added. Link a schedule to it so it is tracked and evidenced.',
    );
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Premises safety</h1>
        {can('premises.item.manage') && (
          <button className={button} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Cancel' : 'Add premises item'}
          </button>
        )}
      </div>
      {msg}
      {open && (
        <form
          aria-label="Add premises item"
          onSubmit={submit}
          className="grid gap-3 rounded-lg border border-hub-line bg-white p-4 sm:grid-cols-2"
        >
          <Field label="Location">
            <select
              required
              className={input}
              value={f.locationId}
              onChange={(e) => setF({ ...f, locationId: e.target.value })}
            >
              <option value="">Choose a location</option>
              {locs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.type === 'ADMIN_ONLY' ? ' (administration only)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Control area">
            <select
              className={input}
              value={f.controlArea}
              onChange={(e) => setF({ ...f, controlArea: e.target.value })}
            >
              {AREAS.map((a) => (
                <option key={a} value={a}>
                  {AREA_WORDS[a]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Item">
            <input
              required
              minLength={3}
              className={input}
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
            />
          </Field>
          <Field label="Area or room (optional)">
            <input
              maxLength={120}
              className={input}
              value={f.areaName}
              onChange={(e) => setF({ ...f, areaName: e.target.value })}
            />
          </Field>
          <Field label="Frequency source (competent person, manufacturer or law)">
            <input
              required
              minLength={3}
              className={input}
              value={f.frequencySource}
              onChange={(e) => setF({ ...f, frequencySource: e.target.value })}
            />
          </Field>
          <Field label="Interval in months from that source (optional)">
            <input
              type="number"
              min={1}
              max={120}
              className={input}
              value={f.intervalMonths}
              onChange={(e) => setF({ ...f, intervalMonths: e.target.value })}
            />
          </Field>
          <PersonSelect
            label="Responsible person"
            value={f.responsibleUserId}
            onChange={(id) => setF({ ...f, responsibleUserId: id })}
            people={people}
            meId={me.user.id}
          />
          <Field label="Action owner">
            <select
              className={input}
              value={f.actionOwnerUserId}
              onChange={(e) => setF({ ...f, actionOwnerUserId: e.target.value })}
            >
              <option value="">Same as responsible person</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === me.user.id ? `Me (${p.displayName})` : p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Contractor (optional)">
            <input
              className={input}
              value={f.contractorName}
              onChange={(e) => setF({ ...f, contractorName: e.target.value })}
            />
          </Field>
          <Field label="Assessment reference (optional)">
            <input
              className={input}
              value={f.assessmentRef}
              onChange={(e) => setF({ ...f, assessmentRef: e.target.value })}
            />
          </Field>
          <Field label="Assessed on (optional)">
            <input
              type="date"
              className={input}
              value={f.assessedOn}
              onChange={(e) => setF({ ...f, assessedOn: e.target.value })}
            />
          </Field>
          {schedules.length > 0 && (
            <Field label="Schedule (optional)">
              <select
                className={input}
                value={f.templateId}
                onChange={(e) => setF({ ...f, templateId: e.target.value })}
              >
                <option value="">Link a schedule later</option>
                {schedules.map((t) => (
                  <option key={t.id as string} value={t.id as string}>
                    {t.title as string}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {needsClinicalConfirm && (
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={f.confirmClinicalControl}
                onChange={(e) => setF({ ...f, confirmClinicalControl: e.target.checked })}
              />
              This location is administration only. I confirm infection-control items apply here.
            </label>
          )}
          <div className="sm:col-span-2">
            <button
              className={button}
              type="submit"
              disabled={needsClinicalConfirm && !f.confirmClinicalControl}
            >
              Save item
            </button>
          </div>
        </form>
      )}
      <DataTable<Row>
        caption="Premises safety register"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load the register.' : null}
        emptyMessage="No premises items yet."
        columns={[
          { key: 'l', header: 'Location', cell: (r) => loc(r.locationId) },
          {
            key: 'a',
            header: 'Area',
            cell: (r) => AREA_WORDS[r.controlArea] ?? words(r.controlArea),
          },
          {
            key: 't',
            header: 'Item',
            cell: (r) => (
              <>
                {r.title}
                {r.areaName && <span className="block text-xs">{r.areaName}</span>}
              </>
            ),
          },
          {
            key: 'rp',
            header: 'Responsible',
            cell: (r) => named(r.responsibleUserId, r.responsibleName),
          },
          {
            key: 'ao',
            header: 'Action owner',
            cell: (r) =>
              r.actionOwnerUserId
                ? named(r.actionOwnerUserId, r.actionOwnerName)
                : 'Same as responsible person',
          },
          { key: 'c', header: 'Contractor', cell: (r) => r.contractorName ?? 'None recorded' },
          {
            key: 'as',
            header: 'Assessment',
            cell: (r) =>
              r.assessmentRef
                ? `${r.assessmentRef}${r.assessedOn ? ` (${fmtDate(r.assessedOn)})` : ''}`
                : 'None recorded',
          },
          {
            key: 'f',
            header: 'Frequency source',
            cell: (r) =>
              r.intervalMonths
                ? `${r.frequencySource} (every ${r.intervalMonths} month${
                    r.intervalMonths === 1 ? '' : 's'
                  })`
                : r.frequencySource,
          },
          {
            key: 'sc',
            header: 'Schedule',
            cell: (r) => r.scheduleTitle ?? 'No schedule linked',
          },
          {
            key: 'ev',
            header: 'Evidence',
            cell: (r) =>
              r.requirementInstanceId ? (
                <button
                  className={smallButton}
                  aria-label={`Documents for ${r.title}`}
                  onClick={() => setDocsFor(r)}
                >
                  {r.evidenceCount === 1 ? '1 document' : `${r.evidenceCount} documents`}
                </button>
              ) : (
                'Link a schedule first'
              ),
          },
          { key: 'n', header: 'Next due', cell: (r) => fmtDate(r.nextDue) || 'Not set' },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <>
                <StatusBadge status={r.status as StatusKind} reason={r.reasonText} />
                {r.deploymentCritical && (
                  <span className="mt-1 block text-xs font-semibold">
                    Deployment-critical: ambulances at this base depend on it
                  </span>
                )}
                {!r.applicable && r.applicabilityReviewOn && (
                  <span className="mt-1 block text-xs">
                    Not applicable; review by {r.applicabilityReviewerName ?? 'the reviewer'} on{' '}
                    {fmtDate(r.applicabilityReviewOn)}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'x',
            header: 'Action',
            cell: (r) => (
              <div className="flex flex-wrap gap-2">
                {can('premises.item.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`Edit ${r.title}`}
                    onClick={() => setEditing(r)}
                  >
                    Edit
                  </button>
                )}
                {can('premises.item.manage') && !r.requirementInstanceId && (
                  <button
                    className={smallButton}
                    aria-label={`Link a schedule to ${r.title}`}
                    onClick={() => setLinking(r)}
                  >
                    Link a schedule
                  </button>
                )}
                {can('compliance.evidence.upload') && r.requirementInstanceId && r.applicable && (
                  <button
                    className={smallButton}
                    aria-label={`Upload evidence for ${r.title}`}
                    onClick={() => setUploadFor(r)}
                  >
                    Upload evidence
                  </button>
                )}
                {can('premises.item.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`${
                      r.applicable ? 'Mark not applicable' : 'Mark applicable'
                    }: ${r.title}`}
                    onClick={() => setDeciding(r)}
                  >
                    {r.applicable ? 'Mark not applicable' : 'Mark applicable'}
                  </button>
                )}
                {can('premises.item.manage') && (
                  <button
                    className={smallButton}
                    aria-label={`Record a finding on ${r.title}`}
                    onClick={() => setFinding(r)}
                  >
                    Record a finding
                  </button>
                )}
                <button
                  className={smallButton}
                  aria-label={`History of ${r.title}`}
                  onClick={() => setHistory(r)}
                >
                  History
                </button>
              </div>
            ),
          },
        ]}
      />
      <p className="text-sm">
        Uploaded documents are checked by someone else before an item turns green.
      </p>
      <EvidenceDialog
        target={
          docsFor
            ? {
                instanceId: docsFor.requirementInstanceId,
                title: docsFor.title,
                deadlineKind: docsFor.deadlineKind ?? undefined,
              }
            : null
        }
        onClose={() => setDocsFor(null)}
      />
      <UploadDialog
        target={
          uploadFor
            ? {
                instanceId: uploadFor.requirementInstanceId,
                title: uploadFor.title,
                deadlineKind: uploadFor.deadlineKind ?? undefined,
              }
            : null
        }
        onClose={() => setUploadFor(null)}
      />
      <EditPremises item={editing} onClose={() => setEditing(null)} />
      <LinkSchedule
        item={linking}
        schedules={schedules}
        canSeeSchedules={can('compliance.requirement.view')}
        onClose={() => setLinking(null)}
      />
      <ActionDialog
        open={deciding !== null}
        title={
          deciding?.applicable
            ? `Mark ${deciding?.title} as not applicable`
            : `Mark ${deciding?.title} as applicable`
        }
        confirmLabel="Record decision"
        reasonLabel={
          deciding?.applicable
            ? 'Why does this not apply here? (at least 10 characters)'
            : 'Why does this now apply?'
        }
        onCancel={() => {
          setDeciding(null);
          setReviewerId('');
          setReviewOn('');
        }}
        onConfirm={async (reason) => {
          if (reason.length < 10) throw new Error('Give a reason of at least 10 characters.');
          await api.send('POST', `/api/v1/premises-items/${deciding!.id}/applicability`, orgId, {
            applicable: !deciding!.applicable,
            reason,
            ...(deciding!.applicable && reviewerId ? { reviewerId } : {}),
            ...(deciding!.applicable && reviewOn ? { reviewOn } : {}),
          });
        }}
        fields={
          deciding?.applicable ? (
            <div className="grid gap-3">
              <Field label="Reviewer (optional; defaults to you)">
                <select
                  className={input}
                  value={reviewerId}
                  onChange={(e) => setReviewerId(e.target.value)}
                >
                  <option value="">Me</option>
                  {people
                    .filter((p) => p.id !== me.user.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Review the decision on (optional; defaults to one year)">
                <input
                  type="date"
                  className={input}
                  value={reviewOn}
                  onChange={(e) => setReviewOn(e.target.value)}
                />
              </Field>
            </div>
          ) : undefined
        }
      >
        <p>The decision, your name and the reason are recorded in the audit trail.</p>
      </ActionDialog>
      <PremisesFinding item={finding} onClose={() => setFinding(null)} />
      <PremisesHistory item={history} onClose={() => setHistory(null)} />
    </div>
  );
}

const HISTORY_WORDS: Record<string, string> = {
  CREATED: 'Added',
  EDITED: 'Edited',
  APPLICABILITY: 'Applicability decided',
  SCHEDULE: 'Schedule linked',
  FINDING: 'Finding recorded',
};

/** J1: every change to an item, oldest last; history cannot be edited. */
function PremisesHistory({ item, onClose }: { item: Row | null; onClose: () => void }) {
  const res = useOne<{ data: Row[] }>(item ? `/api/v1/premises-items/${item.id}/history` : null);
  if (!item) return null;
  return (
    <section
      aria-label={`History of ${item.title}`}
      className="rounded-lg border border-hub-line bg-white p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">History of {item.title}</h2>
        <button className={smallButton} onClick={onClose}>
          Close history
        </button>
      </div>
      <DataTable<Row>
        caption={`Changes to ${item.title}`}
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load the history.' : null}
        emptyMessage="No changes recorded."
        columns={[
          { key: 'w', header: 'When', cell: (r) => fmtDateTime(r.changedAt) },
          { key: 'c', header: 'Change', cell: (r) => HISTORY_WORDS[r.change] ?? 'Change' },
          { key: 's', header: 'Details', cell: (r) => r.summary },
          { key: 'b', header: 'By', cell: (r) => r.changedByName ?? 'Former member' },
        ]}
      />
    </section>
  );
}

/** J1: a finding becomes an action on the actions register, with an owner and a deadline. */
function PremisesFinding({ item, onClose }: { item: Row | null; onClose: () => void }) {
  const { api, orgId } = useApp();
  const people = usePeople(item !== null);
  const [ownerUserId, setOwner] = useState('');
  const [deadline, setDeadline] = useState('');
  const [sev, setSev] = useState('');
  const close = () => {
    setOwner('');
    setDeadline('');
    setSev('');
    onClose();
  };
  return (
    <ActionDialog
      open={item !== null}
      title={`Record a finding on ${item?.title ?? ''}`}
      confirmLabel="Create action"
      reasonLabel="What was found and what must be done?"
      confirmDisabled={!deadline}
      onCancel={close}
      onConfirm={(title) =>
        api.send('POST', `/api/v1/premises-items/${item!.id}/findings`, orgId, {
          title,
          deadline,
          ...(ownerUserId ? { ownerUserId } : {}),
          ...(sev ? { severity: sev } : {}),
        })
      }
      fields={
        <div className="grid gap-3">
          <Field label="Action owner (optional; defaults to the item's action owner)">
            <select
              className={input}
              value={ownerUserId}
              onChange={(e) => setOwner(e.target.value)}
            >
              <option value="">Item&apos;s action owner</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deadline">
            <input
              type="date"
              className={input}
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </Field>
          <Field label="Severity (optional)">
            <select className={input} value={sev} onChange={(e) => setSev(e.target.value)}>
              <option value="">
                {item?.controlArea === 'OXYGEN' ? 'High (oxygen default)' : 'Medium (default)'}
              </option>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </Field>
        </div>
      }
    >
      <p>The action is added to the actions register and stays linked to this item.</p>
    </ActionDialog>
  );
}

/** Edit a register entry (finding 65). Uses the item's version so two editors cannot clash. */
function EditPremises({ item, onClose }: { item: Row | null; onClose: () => void }) {
  const { api, orgId, me } = useApp();
  const people = usePeople(item !== null);
  const [e, setE] = useState({
    title: '',
    responsibleUserId: '',
    actionOwnerUserId: '',
    frequencySource: '',
    contractorName: '',
    assessmentRef: '',
    assessedOn: '',
    areaName: '',
    intervalMonths: '',
  });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (item && loadedFor !== `${item.id}:${item.version}`) {
    setLoadedFor(`${item.id}:${item.version}`);
    setE({
      title: item.title ?? '',
      responsibleUserId: item.responsibleUserId ?? me.user.id,
      actionOwnerUserId: item.actionOwnerUserId ?? '',
      frequencySource: item.frequencySource ?? '',
      contractorName: item.contractorName ?? '',
      assessmentRef: item.assessmentRef ?? '',
      assessedOn: item.assessedOn ?? '',
      areaName: item.areaName ?? '',
      intervalMonths: item.intervalMonths ? String(item.intervalMonths) : '',
    });
  }
  const opt = (s: string) => (s.trim().length >= 2 ? s.trim() : null);
  return (
    <ActionDialog
      open={item !== null}
      title={`Edit ${item?.title ?? ''}`}
      confirmLabel="Save changes"
      confirmDisabled={e.title.trim().length < 3 || e.frequencySource.trim().length < 3}
      onCancel={() => {
        setLoadedFor(null);
        onClose();
      }}
      onConfirm={() =>
        api.send(
          'PATCH',
          `/api/v1/premises-items/${item!.id}`,
          orgId,
          {
            title: e.title.trim(),
            responsibleUserId: e.responsibleUserId,
            actionOwnerUserId: e.actionOwnerUserId || e.responsibleUserId,
            frequencySource: e.frequencySource.trim(),
            contractorName: opt(e.contractorName),
            assessmentRef: opt(e.assessmentRef),
            assessedOn: e.assessedOn || null,
            areaName: opt(e.areaName),
            intervalMonths: e.intervalMonths ? Number(e.intervalMonths) : null,
          },
          item!.version,
        )
      }
      fields={
        <div className="grid gap-3">
          <Field label="Item name">
            <input
              className={input}
              value={e.title}
              onChange={(x) => setE({ ...e, title: x.target.value })}
            />
          </Field>
          <PersonSelect
            label="Responsible person"
            value={e.responsibleUserId}
            onChange={(id) => setE({ ...e, responsibleUserId: id })}
            people={people}
            meId={me.user.id}
          />
          <Field label="Action owner">
            <select
              className={input}
              value={e.actionOwnerUserId}
              onChange={(x) => setE({ ...e, actionOwnerUserId: x.target.value })}
            >
              <option value="">Same as responsible person</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Area or room (optional)">
            <input
              className={input}
              value={e.areaName}
              onChange={(x) => setE({ ...e, areaName: x.target.value })}
            />
          </Field>
          <Field label="Frequency source">
            <input
              className={input}
              value={e.frequencySource}
              onChange={(x) => setE({ ...e, frequencySource: x.target.value })}
            />
          </Field>
          <Field label="Interval in months (optional)">
            <input
              type="number"
              min={1}
              max={120}
              className={input}
              value={e.intervalMonths}
              onChange={(x) => setE({ ...e, intervalMonths: x.target.value })}
            />
          </Field>
          <Field label="Contractor (optional)">
            <input
              className={input}
              value={e.contractorName}
              onChange={(x) => setE({ ...e, contractorName: x.target.value })}
            />
          </Field>
          <Field label="Assessment reference (optional)">
            <input
              className={input}
              value={e.assessmentRef}
              onChange={(x) => setE({ ...e, assessmentRef: x.target.value })}
            />
          </Field>
          <Field label="Assessed on (optional)">
            <input
              type="date"
              className={input}
              value={e.assessedOn}
              onChange={(x) => setE({ ...e, assessedOn: x.target.value })}
            />
          </Field>
        </div>
      }
    >
      <p>Your name is recorded with the change. Due dates are moved on the requirement itself.</p>
    </ActionDialog>
  );
}

/** Link a published schedule to an item saved without one, with its first due date. */
function LinkSchedule({
  item,
  schedules,
  canSeeSchedules,
  onClose,
}: {
  item: Row | null;
  schedules: Row[];
  canSeeSchedules: boolean;
  onClose: () => void;
}) {
  const { api, orgId } = useApp();
  const [templateId, setTemplateId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const close = () => {
    setTemplateId('');
    setDueDate('');
    onClose();
  };
  return (
    <ActionDialog
      open={item !== null}
      title={`Link a schedule to ${item?.title ?? ''}`}
      confirmLabel="Link schedule"
      confirmDisabled={!templateId}
      onCancel={close}
      onConfirm={async () => {
        await api.send('POST', `/api/v1/premises-items/${item!.id}/schedule`, orgId, {
          templateId,
          ...(dueDate ? { dueDate } : {}),
        });
        setTemplateId('');
        setDueDate('');
      }}
      fields={
        <div className="grid gap-3">
          <Field label="Schedule">
            <select
              className={input}
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="">Choose a published premises schedule</option>
              {schedules.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="First due date (optional)">
            <input
              type="date"
              className={input}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
        </div>
      }
    >
      {schedules.length === 0 && (
        <p role="status">
          {canSeeSchedules
            ? 'No premises schedule is published yet. Adopt and publish one in Settings, ' +
              'Requirement library.'
            : 'You cannot see the schedule library. Ask a compliance manager to publish one.'}
        </p>
      )}
      <p>The responsible person owns the schedule and gets its reminders.</p>
    </ActionDialog>
  );
}
