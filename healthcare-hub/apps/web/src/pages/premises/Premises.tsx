import { DataTable } from '@hub/ui';
import { Alert, Button, Card, Checkbox, Form, Input, Select, Space, Typography } from 'antd';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ActionDialog,
  Field,
  PageHeader,
  PersonSelect,
  fmtDate,
  fmtDateTime,
  useCan,
  useRun,
  words,
  Tabs as ModuleTabs,
} from '../../components.js';
import { EvidenceDialog, UploadDialog } from '../evidence/Evidence.js';
import { useApp } from '../../shell/AppContext.js';
import { useList, useOne, usePeople } from '../settings/hooks.js';
import { WfTag } from '../../v36/ui.js';

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
  if (!orgId)
    return (
      <Alert type="info" showIcon role="status" message="Select an organisation to continue." />
    );
  if (!can('premises.item.view'))
    return (
      <Alert
        type="warning"
        showIcon
        role="alert"
        message="You do not have access to premises safety."
      />
    );
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
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = search.tab === 'contractors' ? 'contractors' : 'checks';
  return (
    <Space direction="vertical" size="large" className="w-full">
      <PageHeader
        title="Premises safety"
        description="Checks, schedules and evidence for the buildings you run."
        extra={
          tab === 'checks' && can('premises.item.manage') ? (
            <Button type="primary" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Cancel' : 'Add premises item'}
            </Button>
          ) : undefined
        }
      />
      <ModuleTabs
        label="Premises safety sections"
        current={tab}
        onChange={(k) =>
          void navigate({ to: '/premises', search: k === 'checks' ? {} : { tab: k } })
        }
        tabs={[
          { id: 'checks', label: 'Premises checks' },
          { id: 'contractors', label: 'Contractors & visitors' },
        ]}
      >
        {null}
      </ModuleTabs>
      {tab === 'contractors' ? (
        <Card size="small" role="status">
          <Typography.Title level={4} className="!mb-2 !text-base">
            Contractors and visitors
          </Typography.Title>
          <Typography.Paragraph className="!mb-0 text-slate-700">
            This register is not in the product yet. Contractor names can still be recorded on each
            premises safety item when work is carried out by an outside firm.
          </Typography.Paragraph>
        </Card>
      ) : null}
      {tab === 'checks' ? (
        <>
          {msg}
          {open && (
            <Card size="small">
              <form
                aria-label="Add premises item"
                onSubmit={submit}
                style={{
                  display: 'grid',
                  gap: 0,
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  columnGap: 16,
                }}
              >
                <Field label="Location">
                  <Select
                    value={f.locationId || undefined}
                    placeholder="Choose a location"
                    onChange={(v) => setF({ ...f, locationId: v })}
                    options={locs.map((l) => ({
                      value: l.id,
                      label: `${l.name}${l.type === 'ADMIN_ONLY' ? ' (administration only)' : ''}`,
                    }))}
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Control area">
                  <Select
                    value={f.controlArea}
                    onChange={(v) => setF({ ...f, controlArea: v })}
                    options={AREAS.map((a) => ({ value: a, label: AREA_WORDS[a] }))}
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Item">
                  <Input
                    required
                    minLength={3}
                    value={f.title}
                    onChange={(e) => setF({ ...f, title: e.target.value })}
                  />
                </Field>
                <Field label="Area or room (optional)">
                  <Input
                    maxLength={120}
                    value={f.areaName}
                    onChange={(e) => setF({ ...f, areaName: e.target.value })}
                  />
                </Field>
                <Field label="Frequency source (competent person, manufacturer or law)">
                  <Input
                    required
                    minLength={3}
                    value={f.frequencySource}
                    onChange={(e) => setF({ ...f, frequencySource: e.target.value })}
                  />
                </Field>
                <Field label="Interval in months from that source (optional)">
                  <Input
                    type="number"
                    min={1}
                    max={120}
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
                  <Select
                    value={f.actionOwnerUserId || undefined}
                    allowClear
                    placeholder="Same as responsible person"
                    onChange={(v) => setF({ ...f, actionOwnerUserId: v ?? '' })}
                    options={people.map((p) => ({
                      value: p.id,
                      label: p.id === me.user.id ? `Me (${p.displayName})` : p.displayName,
                    }))}
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Contractor (optional)">
                  <Input
                    value={f.contractorName}
                    onChange={(e) => setF({ ...f, contractorName: e.target.value })}
                  />
                </Field>
                <Field label="Assessment reference (optional)">
                  <Input
                    value={f.assessmentRef}
                    onChange={(e) => setF({ ...f, assessmentRef: e.target.value })}
                  />
                </Field>
                <Field label="Assessed on (optional)">
                  <Input
                    type="date"
                    value={f.assessedOn}
                    onChange={(e) => setF({ ...f, assessedOn: e.target.value })}
                  />
                </Field>
                {schedules.length > 0 && (
                  <Field label="Schedule (optional)">
                    <Select
                      value={f.templateId || undefined}
                      allowClear
                      placeholder="Link a schedule later"
                      onChange={(v) => setF({ ...f, templateId: v ?? '' })}
                      options={schedules.map((t) => ({
                        value: t.id as string,
                        label: t.title as string,
                      }))}
                      style={{ width: '100%' }}
                    />
                  </Field>
                )}
                {needsClinicalConfirm && (
                  <Form.Item style={{ gridColumn: '1 / -1', marginBottom: 12 }}>
                    <Checkbox
                      checked={f.confirmClinicalControl}
                      onChange={(e) => setF({ ...f, confirmClinicalControl: e.target.checked })}
                    >
                      This location is administration only. I confirm infection-control items apply
                      here.
                    </Checkbox>
                  </Form.Item>
                )}
                <div style={{ gridColumn: '1 / -1' }}>
                  <Button
                    type="primary"
                    htmlType="submit"
                    disabled={needsClinicalConfirm && !f.confirmClinicalControl}
                  >
                    Save item
                  </Button>
                </div>
              </form>
            </Card>
          )}
          <DataTable<Row>
            caption="Premises safety register"
            rows={res.data?.data ?? []}
            rowKey={(r) => r.id}
            loading={res.isLoading}
            error={res.isError ? 'Could not load the register.' : null}
            emptyMessage="No premises items yet."
            columns={[
              ...(new Set((res.data?.data ?? []).map((r) => r.locationId)).size > 1
                ? [{ key: 'l', header: 'Location', cell: (r: Row) => loc(r.locationId) }]
                : []),
              {
                key: 't',
                header: 'Item',
                cell: (r) => {
                  const code = /\(([A-Z]{2,}-\d+)\)/.exec(String(r.frequencySource ?? ''))?.[1];
                  return (
                    <>
                      <b>{r.title}</b>
                      <span className="block wf-mut text-xs">
                        {AREA_WORDS[r.controlArea] ?? words(r.controlArea)}
                        {r.areaName ? ` · ${r.areaName}` : ''}
                        {code ? ` · ${code}` : ''}
                      </span>
                      {r.deploymentCritical && (
                        <span className="block text-xs font-semibold">Deployment-critical</span>
                      )}
                    </>
                  );
                },
              },
              {
                key: 'f',
                header: 'Frequency',
                cell: (r) => {
                  const m = r.intervalMonths as number | null;
                  const src = String(r.frequencySource ?? '').replace(/\s*\([^)]*\)\s*$/, '');
                  if (/^every 7 days$/i.test(src)) return 'Every week';
                  if (m === 12) return 'Every year';
                  if (m) return `Every ${m === 1 ? 'month' : `${m} months`}`;
                  return src || '—';
                },
              },
              {
                key: 'ld',
                header: 'Last done',
                cell: (r) =>
                  r.lastDone ? fmtDate(r.lastDone) : <span className="wf-mut">—</span>,
              },
              {
                key: 'n',
                header: 'Next due',
                cell: (r) => {
                  if (!r.applicable)
                    return (
                      <WfTag tone="grey" icon="block">
                        Not applicable
                      </WfTag>
                    );
                  if (!r.nextDue) return <WfTag tone="grey">Not set</WfTag>;
                  const days = Math.round(
                    (new Date(`${String(r.nextDue).slice(0, 10)}T00:00:00Z`).getTime() -
                      new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime()) /
                      86_400_000,
                  );
                  const tone =
                    r.status === 'RED' ? 'red' : r.status === 'AMBER' ? 'amber' : 'green';
                  return (
                    <WfTag tone={tone} icon={tone === 'red' ? 'error' : 'schedule'}>
                      {days < 0
                        ? `Overdue by ${-days} day${days === -1 ? '' : 's'}`
                        : days === 0
                          ? 'Due today'
                          : days <= 31
                            ? `Due in ${days} day${days === 1 ? '' : 's'}`
                            : `Due ${fmtDate(r.nextDue)}`}
                    </WfTag>
                  );
                },
              },
              {
                key: 'ev',
                header: 'Evidence',
                cell: (r) =>
                  r.requirementInstanceId ? (
                    <Button
                      type="link"
                      size="small"
                      aria-label={`Documents for ${r.title}`}
                      onClick={() => setDocsFor(r)}
                    >
                      {r.evidenceCount === 1 ? '1 document' : `${r.evidenceCount} documents`}
                    </Button>
                  ) : (
                    <span className="wf-mut">Link a schedule first</span>
                  ),
              },
              {
                key: 'rp',
                header: 'Responsible',
                cell: (r) => named(r.responsibleUserId, r.responsibleName),
              },
              {
                key: 'x',
                header: 'Action',
                cell: (r) => (
                  <Space size="small" wrap>
                    {can('premises.item.manage') && (
                      <Button
                        type="link"
                        size="small"
                        aria-label={`Edit ${r.title}`}
                        onClick={() => setEditing(r)}
                      >
                        Edit
                      </Button>
                    )}
                    {can('premises.item.manage') && !r.requirementInstanceId && (
                      <Button
                        type="link"
                        size="small"
                        aria-label={`Link a schedule to ${r.title}`}
                        onClick={() => setLinking(r)}
                      >
                        Link a schedule
                      </Button>
                    )}
                    {can('compliance.evidence.upload') &&
                      r.requirementInstanceId &&
                      r.applicable && (
                        <Button
                          type="link"
                          size="small"
                          aria-label={`Upload evidence for ${r.title}`}
                          onClick={() => setUploadFor(r)}
                        >
                          Upload evidence
                        </Button>
                      )}
                    {can('premises.item.manage') && (
                      <Button
                        type="link"
                        size="small"
                        aria-label={`${
                          r.applicable ? 'Mark not applicable' : 'Mark applicable'
                        }: ${r.title}`}
                        onClick={() => setDeciding(r)}
                      >
                        {r.applicable ? 'Mark not applicable' : 'Mark applicable'}
                      </Button>
                    )}
                    {can('premises.item.manage') && (
                      <Button
                        type="link"
                        size="small"
                        aria-label={`Record a finding on ${r.title}`}
                        onClick={() => setFinding(r)}
                      >
                        Record a finding
                      </Button>
                    )}
                    <Button
                      type="link"
                      size="small"
                      aria-label={`History of ${r.title}`}
                      onClick={() => setHistory(r)}
                    >
                      History
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
          <Typography.Text type="secondary">
            Uploaded documents are checked by someone else before an item turns green.
          </Typography.Text>
        </>
      ) : null}
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
                <Select
                  value={reviewerId || undefined}
                  allowClear
                  placeholder="Me"
                  onChange={(v) => setReviewerId(v ?? '')}
                  options={people
                    .filter((p) => p.id !== me.user.id)
                    .map((p) => ({ value: p.id, label: p.displayName }))}
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Review the decision on (optional; defaults to one year)">
                <Input type="date" value={reviewOn} onChange={(e) => setReviewOn(e.target.value)} />
              </Field>
            </div>
          ) : undefined
        }
      >
        <p>The decision, your name and the reason are recorded in the audit trail.</p>
      </ActionDialog>
      <PremisesFinding item={finding} onClose={() => setFinding(null)} />
      <PremisesHistory item={history} onClose={() => setHistory(null)} />
    </Space>
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
    <Card
      size="small"
      aria-label={`History of ${item.title}`}
      title={`History of ${item.title}`}
      extra={
        <Button type="link" size="small" onClick={onClose}>
          Close history
        </Button>
      }
    >
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
    </Card>
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
            <Select
              value={ownerUserId || undefined}
              allowClear
              placeholder="Item's action owner"
              onChange={(v) => setOwner(v ?? '')}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="Deadline">
            <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <Field label="Severity (optional)">
            <Select
              value={sev || undefined}
              allowClear
              placeholder={
                item?.controlArea === 'OXYGEN' ? 'High (oxygen default)' : 'Medium (default)'
              }
              onChange={(v) => setSev(v ?? '')}
              options={[
                { value: 'CRITICAL', label: 'Critical' },
                { value: 'HIGH', label: 'High' },
                { value: 'MEDIUM', label: 'Medium' },
                { value: 'LOW', label: 'Low' },
              ]}
              style={{ width: '100%' }}
            />
          </Field>
        </div>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        The action is added to the actions register and stays linked to this item.
      </Typography.Paragraph>
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
            <Input value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} />
          </Field>
          <PersonSelect
            label="Responsible person"
            value={e.responsibleUserId}
            onChange={(id) => setE({ ...e, responsibleUserId: id })}
            people={people}
            meId={me.user.id}
          />
          <Field label="Action owner">
            <Select
              value={e.actionOwnerUserId || undefined}
              allowClear
              placeholder="Same as responsible person"
              onChange={(v) => setE({ ...e, actionOwnerUserId: v ?? '' })}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="Area or room (optional)">
            <Input value={e.areaName} onChange={(x) => setE({ ...e, areaName: x.target.value })} />
          </Field>
          <Field label="Frequency source">
            <Input
              value={e.frequencySource}
              onChange={(x) => setE({ ...e, frequencySource: x.target.value })}
            />
          </Field>
          <Field label="Interval in months (optional)">
            <Input
              type="number"
              min={1}
              max={120}
              value={e.intervalMonths}
              onChange={(x) => setE({ ...e, intervalMonths: x.target.value })}
            />
          </Field>
          <Field label="Contractor (optional)">
            <Input
              value={e.contractorName}
              onChange={(x) => setE({ ...e, contractorName: x.target.value })}
            />
          </Field>
          <Field label="Assessment reference (optional)">
            <Input
              value={e.assessmentRef}
              onChange={(x) => setE({ ...e, assessmentRef: x.target.value })}
            />
          </Field>
          <Field label="Assessed on (optional)">
            <Input
              type="date"
              value={e.assessedOn}
              onChange={(x) => setE({ ...e, assessedOn: x.target.value })}
            />
          </Field>
        </div>
      }
    >
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        Your name is recorded with the change. Due dates are moved on the requirement itself.
      </Typography.Paragraph>
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
            <Select
              value={templateId || undefined}
              placeholder="Choose a published premises schedule"
              onChange={(v) => setTemplateId(v)}
              options={schedules.map((t) => ({ value: t.id, label: t.title }))}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="First due date (optional)">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
      }
    >
      {schedules.length === 0 && (
        <Alert
          type="info"
          showIcon
          role="status"
          style={{ marginBottom: 12 }}
          message={
            canSeeSchedules
              ? 'No premises schedule is published yet. Adopt and publish one in Settings, Requirement library.'
              : 'You cannot see the schedule library. Ask a compliance manager to publish one.'
          }
        />
      )}
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        The responsible person owns the schedule and gets its reminders.
      </Typography.Paragraph>
    </ActionDialog>
  );
}
