import type { MeResponse } from '@hub/contracts';
import { staffRolesFor } from '@hub/rules';
import { DataTable } from '@hub/ui';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Alert, Button, Input, Modal, Select, Space, Typography } from 'antd';
import { UserAddOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../../api.js';
import { Field, PageHeader, Tabs } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useInvalidate, useOne } from '../settings/hooks.js';
import { CONTRACT_LABEL, LIFECYCLE_LABEL, RESTRICTION_LABEL, ROLE_LABEL } from './labels.js';
import { TrainingMatrix } from './TrainingMatrix.js';
import { GroupSessions, PlannedSessions, SupervisionBookings } from './TrainingSupervision.js';
import { MyRecord } from '../me/MyRecord.js';
import { Views, Who } from '../../v36/kit.js';
import { Deeper, WfBar, WfCard, WfFilters, WfSearch, WfSelect, WfTag } from '../../v36/ui.js';
import { EvidenceReviewView, Pipeline } from './v36/Onboarding.js';
import { Corrections } from './v36/Corrections.js';
import { ShiftsTab } from '../registers/RotaRecords.js';
import { checkCount, readiness } from './v36/shared.js';
import { Absence, Leavers, Reviews } from '../registers/PeopleRecords.js';
import { WorkforceChecks } from './v36/WorkforceChecks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const DISPATCH_NOTE = 'Dispatcher view shows approved roles and restrictions only.';

/** Roles that make sense for this organisation's sector (a dental practice has no paramedics). */
function sectorRoles(me: MeResponse, orgId: string | null): [string, string][] {
  const packs = me.memberships.find((m) => m.organisationId === orgId)?.sectorPacks;
  const offered = staffRolesFor(packs);
  return Object.entries(ROLE_LABEL).filter(([k]) => offered.includes(k));
}

type TabId = 'register' | 'onboarding' | 'training' | 'shifts' | 'me';
/** Old tab links (before the v36 layout) keep working. */
const LEGACY: Record<string, { tab: TabId; view?: string }> = {
  review: { tab: 'onboarding', view: 'review' },
  pipeline: { tab: 'onboarding', view: 'pipeline' },
  matrix: { tab: 'training', view: 'matrix' },
  group: { tab: 'training', view: 'matrix' },
  supervision: { tab: 'training', view: 'supervision' },
  requests: { tab: 'training', view: 'requests' },
};

/** v36 Staff module: People · Onboarding · Training & reviews · Shifts (and My record for crew). */
export function StaffList() {
  const { me, orgId } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const basic = can('staff.profile.view_basic') || can('staff.profile.view_clearance');
  const full = can('staff.profile.view_basic');
  const allowed = basic || can('staff.self.view');
  const [adding, setAdding] = useState(false);
  const tabs = [
    { id: 'register', label: 'People', show: basic },
    { id: 'me', label: 'My record', show: can('staff.self.view') },
    { id: 'onboarding', label: 'Onboarding', show: full || can('compliance.evidence.verify') },
    { id: 'training', label: 'Training & reviews', show: full },
    { id: 'shifts', label: 'Shifts', show: can('jobs.job.view') || can('crew.today.view') },
  ];
  const search = useSearch({ strict: false }) as { tab?: string; view?: string };
  const legacy = search.tab ? LEGACY[search.tab] : undefined;
  const wanted = legacy?.tab ?? search.tab;
  const tab = (tabs.find((t) => t.id === wanted && t.show)?.id ??
    tabs.find((t) => t.show)?.id ??
    '') as TabId;
  const view = legacy?.view ?? search.view;
  const navigate = useNavigate();
  const go = (t: string, v?: string) =>
    void navigate({ to: '/staff', search: v ? { tab: t, view: v } : { tab: t } });
  if (!orgId)
    return <Typography.Text role="status">Select an organisation to continue.</Typography.Text>;
  if (!allowed) return <Alert type="error" showIcon message="You do not have access to staff." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
      <PageHeader
        title="Staff"
        description={
          tab === 'onboarding'
            ? 'Starters move through checks, review and sign-off before they can work.'
            : tab === 'training'
              ? 'Required training for every role, supervision and requests from staff.'
              : tab === 'shifts'
                ? 'Who is working when, on which vehicle, with working-time prompts.'
                : 'Everyone on the register with their stage, approved role and readiness for shifts.'
        }
        extra={
          can('staff.profile.manage') && (tab === 'register' || tab === 'onboarding') ? (
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAdding(true)}>
              Add a new starter
            </Button>
          ) : undefined
        }
      />
      <Tabs label="Staff sections" current={tab} onChange={(t) => go(t)} tabs={tabs}>
        {tab === 'me' && <MyRecord />}
        {tab === 'register' && <People full={full} />}
        {tab === 'onboarding' && (
          <OnboardingTab view={view === 'review' ? 'review' : 'pipeline'} go={go} />
        )}
        {tab === 'training' && <TrainingTab view={view} go={go} />}
        {tab === 'shifts' && <ShiftsTab view={view} go={go} />}
      </Tabs>
      <Modal
        open={adding}
        title="Add a new starter"
        onCancel={() => setAdding(false)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        <AddStaff />
      </Modal>
    </div>
  );
}

function OnboardingTab({
  view,
  go,
}: {
  view: 'pipeline' | 'review';
  go: (t: string, v?: string) => void;
}) {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const views = [
    ...(can('staff.profile.view_basic') ? [{ value: 'pipeline' as const, label: 'Pipeline' }] : []),
    ...(can('compliance.evidence.verify')
      ? [{ value: 'review' as const, label: 'Evidence review' }]
      : []),
  ];
  const v = views.find((x) => x.value === view)?.value ?? views[0]?.value ?? 'pipeline';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {views.length > 1 && (
        <Views
          label="Onboarding view"
          value={v}
          onChange={(x) => go('onboarding', x)}
          options={views}
        />
      )}
      {v === 'pipeline' ? <Pipeline /> : <EvidenceReviewView />}
    </div>
  );
}

type TrainingView = 'matrix' | 'supervision' | 'requests' | 'reviews' | 'leavers' | 'workforce';
/** v36: Training (matrix, supervision, corrections) | Reviews & leavers. */
const TRAINING_SUBS: { id: string; label: string; views: TrainingView[] }[] = [
  { id: 'training', label: 'Training', views: ['matrix', 'supervision', 'requests'] },
  { id: 'reviews', label: 'Reviews & leavers', views: ['reviews', 'leavers', 'workforce'] },
];
function TrainingTab({ view, go }: { view?: string; go: (t: string, v?: string) => void }) {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const manage = can('staff.profile.manage');
  const views: { value: TrainingView; label: string }[] = [
    { value: 'matrix', label: 'Matrix & groups' },
    { value: 'supervision', label: 'Supervision' },
    ...(manage ? [{ value: 'requests' as const, label: 'Corrections' }] : []),
    { value: 'reviews', label: 'Reviews & absence' },
    { value: 'leavers', label: 'Leavers' },
    { value: 'workforce', label: 'Workforce checks' },
  ];
  const wanted = view === 'absence' ? 'reviews' : view;
  const v = views.find((x) => x.value === wanted)?.value ?? 'matrix';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Views
        label="Training sections"
        value={TRAINING_SUBS.find((g) => g.views.includes(v))!.id}
        onChange={(id) =>
          go(
            'training',
            views.find((x) => TRAINING_SUBS.find((g) => g.id === id)!.views.includes(x.value))!
              .value,
          )
        }
        options={TRAINING_SUBS.map((g) => ({ value: g.id, label: g.label }))}
      />
      <Deeper>
        <Views
          label="Training view"
          value={v}
          onChange={(x) => go('training', x)}
          options={views.filter((x) =>
            TRAINING_SUBS.find((g) => g.views.includes(v))!.views.includes(x.value),
          )}
        />
      </Deeper>
      {v === 'matrix' && (
        <>
          <TrainingMatrix />
          {manage && <PlannedSessions />}
          {manage && <GroupSessions />}
        </>
      )}
      {v === 'supervision' && <SupervisionBookings />}
      {v === 'requests' && <Corrections />}
      {v === 'reviews' && (
        <>
          <Reviews />
          {can('staff.sensitive.view') && <Absence />}
        </>
      )}
      {v === 'leavers' && <Leavers />}
      {v === 'workforce' && <WorkforceChecks />}
    </div>
  );
}

/** v36 People: the register with checks verified, restrictions and readiness. */
const STAGE_ORDER = ['CANDIDATE', 'CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW', 'APPROVED_FOR_ROLE'];
/** v36 order: starters by stage, then people not ready, restricted, then everyone ready. */
function rank(r: Row): number {
  const st = STAGE_ORDER.indexOf(r.lifecycleState as string);
  if (st >= 0) return st;
  const x = readiness(r);
  if (x.word !== 'Ready') return 10;
  if ((r.activeRestrictions as string[]).length) return 20;
  return 30;
}
function People({ full }: { full: boolean }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [ready, setReady] = useState('');
  const params = new URLSearchParams({ limit: '100' });
  if (lifecycle) params.set('lifecycle', lifecycle);
  const res = useOne<{ data: Row[] }>(`/api/v1/staff?${params.toString()}`);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (res.data?.data ?? [])
      .filter((r) => !ready || (readiness(r).word === 'Ready') === (ready === 'ready'))
      .filter(
        (r) =>
          !t ||
          [r.displayName, r.staffNo, r.jobTitle, ...(r.roles as string[]).map((x) => ROLE_LABEL[x])]
            .filter(Boolean)
            .some((x) => String(x).toLowerCase().includes(t)),
      )
      .sort((a, b) => rank(a) - rank(b));
  }, [res.data, ready, q]);
  return (
    <WfCard title={`Register (${rows.length})`} table>
      {!full && <Alert type="info" showIcon role="note" message={DISPATCH_NOTE} />}
      <WfFilters>
        <WfSearch value={q} onChange={setQ} placeholder="Search name, staff number or role" />
        <WfSelect
          label="Stage"
          value={lifecycle}
          onChange={setLifecycle}
          options={[
            { value: '', label: 'All stages' },
            ...Object.entries(LIFECYCLE_LABEL)
              .filter(([k]) => k !== 'LEAVER')
              .map(([k, v]) => ({ value: k, label: v })),
          ]}
        />
        {full && (
          <WfSelect
            label="Readiness"
            value={ready}
            onChange={setReady}
            options={[
              { value: '', label: 'Any readiness' },
              { value: 'ready', label: 'Ready' },
              { value: 'not', label: 'Not ready' },
            ]}
          />
        )}
      </WfFilters>
      <DataTable<Row>
        caption="Staff register"
        rows={rows}
        rowKey={(r) => r.id}
        rowName={(r) => `${r.staffNo as string} ${r.displayName as string}`}
        rowTone={(r) =>
          full && r.lifecycleState === 'ACTIVE' && readiness(r).word !== 'Ready'
            ? 'red'
            : (r.activeRestrictions as string[]).length
              ? 'amber'
              : null
        }
        onRowClick={(r) => void navigate({ to: '/staff/$id', params: { id: r.id } })}
        loading={res.isLoading}
        error={res.isError ? 'Could not load staff.' : null}
        emptyMessage="No staff match these filters."
        columns={[
          {
            key: 'p',
            header: 'Person',
            cell: (r) => <Who name={r.displayName} sub={r.staffNo} />,
          },
          {
            key: 'r',
            header: 'Role',
            cell: (r) =>
              r.jobTitle ||
              (r.roles.length
                ? (r.roles as string[]).map((x) => ROLE_LABEL[x] ?? x).join(', ')
                : 'No approved role yet'),
          },
          {
            key: 's',
            header: 'Stage',
            cell: (r) => LIFECYCLE_LABEL[r.lifecycleState] ?? r.lifecycleState,
          },
          ...(full
            ? [
                {
                  key: 'c',
                  header: 'Checks verified',
                  cell: (r: Row) => {
                    const c = checkCount(r);
                    return <WfBar done={c.done} total={c.total} />;
                  },
                },
              ]
            : []),
          {
            key: 'x',
            header: 'Restrictions',
            cell: (r) =>
              r.activeRestrictions.length ? (
                <WfTag tone="amber" icon="front_hand">
                  {(r.activeRestrictions as string[])
                    .map((x) => RESTRICTION_LABEL[x] ?? x)
                    .join(', ')}
                </WfTag>
              ) : (
                <span className="wf-mut">None</span>
              ),
          },
          ...(full
            ? [
                {
                  key: 'rd',
                  header: 'Readiness',
                  cell: (r: Row) => {
                    const x = readiness(r);
                    const icon =
                      x.word === 'Ready'
                        ? 'check_circle'
                        : x.tone === 'red'
                          ? 'error'
                          : 'radio_button_unchecked';
                    const why =
                      x.tone === 'red' ? ((r.issue as string | undefined) ?? x.why) : x.why;
                    return (
                      <>
                        <WfTag tone={x.tone} icon={icon}>
                          {x.word}
                        </WfTag>
                        {why && <span className="sub">{why}</span>}
                      </>
                    );
                  },
                },
              ]
            : []),
        ]}
      />
    </WfCard>
  );
}

export function AddStaff() {
  const { api, orgId, me } = useApp();
  const invalidate = useInvalidate();
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const managers = useOne<{ data: Row[] }>(orgId ? '/api/v1/staff?limit=100' : null);
  const [msg, setMsg] = useState<string | null>(null);
  const locs = locations.data?.data;
  const [locationId, setLocationId] = useState('');
  const [contractType, setContractType] = useState('');
  const [managerStaffId, setManagerStaffId] = useState('');
  const [roleToCheck, setRoleToCheck] = useState('');
  useEffect(() => {
    if (!locationId && locs?.[0]?.id) setLocationId(String(locs[0].id));
  }, [locationId, locs]);
  const roles = sectorRoles(me, orgId);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const opt = (k: string) => {
      const v = String(f.get(k) ?? '').trim();
      return v ? v : undefined;
    };
    setMsg(null);
    try {
      const created = (await api.send('POST', '/api/v1/staff', orgId, {
        staffNo: String(f.get('staffNo')).trim().toUpperCase(),
        displayName: String(f.get('displayName')).trim(),
        primaryLocationId: String(f.get('location')),
        ...(opt('jobTitle') ? { jobTitle: opt('jobTitle') } : {}),
        ...(opt('workEmail') ? { workEmail: opt('workEmail') } : {}),
        ...(opt('startDate') ? { startDate: opt('startDate') } : {}),
        ...(opt('contractType') ? { contractType: opt('contractType') } : {}),
        ...(opt('managerStaffId') ? { managerStaffId: opt('managerStaffId') } : {}),
      })) as Row;
      const role = opt('role');
      let note = 'Staff record created as a candidate.';
      if (role && created?.id) {
        try {
          await api.send('POST', `/api/v1/staff/${created.id}/role-checks`, orgId, { role });
          note = `Staff record created; checks started for ${ROLE_LABEL[role] ?? 'the role'}.`;
        } catch {
          note =
            'Staff record created as a candidate. Checks for the role could not be started: ' +
            'the role may have no requirements set up yet.';
        }
      }
      setMsg(note);
      form.reset();
      await invalidate();
    } catch (err) {
      setMsg(
        err instanceof ApiError && err.code === 'CONFLICT'
          ? 'That staff number is already in use.'
          : err instanceof ApiError && err.status === 400
            ? 'Check the details: the staff number looks like ST-0042.'
            : 'Could not create the record.',
      );
    }
  }
  return (
    <div>
      <form onSubmit={submit}>
        <input type="hidden" name="location" value={locationId} />
        <input type="hidden" name="contractType" value={contractType} />
        <input type="hidden" name="managerStaffId" value={managerStaffId} />
        <input type="hidden" name="role" value={roleToCheck} />
        <Space wrap align="end" size="middle">
          <Field label="Staff number">
            <Input name="staffNo" required placeholder="ST-0000" style={{ width: 140 }} />
          </Field>
          <Field label="Name">
            <Input name="displayName" required style={{ width: 180 }} />
          </Field>
          <Field label="Job title">
            <Input name="jobTitle" style={{ width: 160 }} />
          </Field>
          <Field label="Base location">
            <Select
              style={{ width: 200 }}
              value={locationId || undefined}
              onChange={setLocationId}
              options={(locs ?? []).map((l) => ({
                value: l.id as string,
                label: l.name as string,
              }))}
            />
          </Field>
          <Field label="Work email">
            <Input name="workEmail" type="email" style={{ width: 200 }} />
          </Field>
          <Field label="Start date">
            <Input name="startDate" type="date" style={{ width: 160 }} />
          </Field>
          <Field label="Contract type">
            <Select
              style={{ width: 180 }}
              value={contractType || undefined}
              onChange={setContractType}
              allowClear
              placeholder="Not recorded"
              options={Object.entries(CONTRACT_LABEL).map(([k, v]) => ({ value: k, label: v }))}
            />
          </Field>
          <Field label="Line manager">
            <Select
              style={{ width: 200 }}
              value={managerStaffId || undefined}
              onChange={setManagerStaffId}
              allowClear
              placeholder="Not set"
              options={(managers.data?.data ?? []).map((m) => ({
                value: m.id as string,
                label: m.displayName as string,
              }))}
            />
          </Field>
          <Field label="Role to check for">
            <Select
              style={{ width: 200 }}
              value={roleToCheck || undefined}
              onChange={setRoleToCheck}
              allowClear
              placeholder="Decide later"
              options={roles.map(([k, v]) => ({ value: k, label: v }))}
            />
          </Field>
          <Button type="primary" htmlType="submit" disabled={!locationId}>
            Add
          </Button>
        </Space>
      </form>
      {msg && <Alert style={{ marginTop: 12 }} type="info" showIcon role="status" message={msg} />}
    </div>
  );
}
