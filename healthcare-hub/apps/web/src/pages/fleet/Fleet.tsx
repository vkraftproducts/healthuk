import { EQUIPMENT_CATEGORIES as EQUIPMENT_CATEGORY_LIST } from '@hub/contracts';
import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Alert, Button, Input, Modal, Select, Space, Typography } from 'antd';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PageHeader,
  Section,
  Tabs,
  fmtDate,
  input,
  pounds,
  saveBlob,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useOne } from '../settings/hooks.js';
import { DefectsV36, ReportDefect } from './Defects.js';
import { FleetCards, VehicleHistory } from './v36/FleetCards.js';
import { DailyHistory, DailyToday } from './v36/Checks.js';
import { MileageServicing } from './v36/Care.js';
import { Ms, RowActions, WfCard, WfSearch, WfSelect, WfTag } from '../../v36/ui.js';
import { EvidenceDialog } from '../evidence/Evidence.js';
import { CrewApp, FleetCare } from './v36/Care.js';
import { Accidents, MedicinesAndGases } from '../registers/FleetSafety.js';
import { Views } from '../../v36/kit.js';
import { Deeper } from '../../v36/ui.js';
import {
  AddVehicle,
  EquipmentDetail,
  EquipmentEditDialog,
  ReceiptPicker,
  VdiChecklists,
  VEHICLE_TYPE,
  odometerText,
} from './FleetRegisters.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Vehicle status mapped onto the shared RAG badge: text + icon + colour, never colour alone. */
export const VEHICLE_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  AVAILABLE: { kind: 'GREEN', text: 'Available' },
  BLOCKED: { kind: 'RED', text: 'Blocked' },
  QUARANTINED: { kind: 'RED', text: 'Quarantined' },
  OFF_ROAD: { kind: 'GREY', text: 'Off road' },
};
export function VehicleBadge({ v }: { v: Row }) {
  const s = VEHICLE_STATUS[v.status] ?? { kind: 'GREY' as StatusKind, text: v.status };
  return (
    <StatusBadge
      status={s.kind}
      reason={v.statusReason ? `${s.text} – ${v.statusReason}` : s.text}
    />
  );
}

const EQUIPMENT_CATEGORIES = [
  ...EQUIPMENT_CATEGORY_LIST.filter((c) => c !== 'OTHER'),
  'WHEELCHAIR',
  'HOIST',
  'OTHER',
];
const REGIMES: Record<string, string> = {
  LOLER_THOROUGH: 'LOLER thorough examination',
  SERVICE: 'Service',
  CALIBRATION: 'Calibration',
  PRE_USE: 'Pre-use check',
  PAT: 'Portable appliance test',
};
const REGIME_SHORT: Record<string, string> = {
  LOLER_THOROUGH: 'LOLER',
  SERVICE: 'Service',
  CALIBRATION: 'Calibration',
  PRE_USE: 'Pre-use',
  PAT: 'PAT',
};
const CAPABILITY: Record<string, string> = {
  STRETCHER: 'Stretcher',
  WHEELCHAIR: 'Wheelchair',
  CLINICAL: 'Clinical',
  BARIATRIC: 'Bariatric',
};
const EXPENSE_CATEGORY: Record<string, string> = {
  FUEL: 'Fuel',
  CHARGING: 'Charging',
  PARKING: 'Parking',
  TOLL: 'Toll',
  WASH: 'Vehicle wash',
  OTHER: 'Other',
};
export const EXPENSE_STATUS: Record<string, { kind: StatusKind; text: string }> = {
  SUBMITTED: { kind: 'AMBER', text: 'Awaiting approval' },
  APPROVED: { kind: 'GREEN', text: 'Approved' },
  REJECTED: { kind: 'RED', text: 'Rejected' },
};
const londonToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

type FleetTab = 'vehicles' | 'checks' | 'equipment' | 'crew';
/** Links made before the v36 layout keep working. */
const LEGACY: Record<string, { tab: FleetTab; view: string }> = {
  defects: { tab: 'checks', view: 'defects' },
  checklists: { tab: 'checks', view: 'checklists' },
  expenses: { tab: 'equipment', view: 'care' },
};

/** v36 Vehicles and assets: Vehicles · Checks & defects · Equipment & care · Crew app. */
export function Fleet() {
  const can = useCan();
  const { orgId } = useApp();
  // Finding 21: the expenses view (and its fetch) only for people who submit or approve claims.
  const expenses = can('fleet.expense.submit') || can('fleet.expense.approve');
  const view_ = can('fleet.vehicle.view');
  const tabs = [
    { id: 'vehicles', label: 'Vehicles', show: view_ },
    { id: 'checks', label: 'Checks & defects', show: view_ },
    { id: 'equipment', label: 'Equipment & care', show: view_ || expenses },
    { id: 'crew', label: 'Crew app', show: view_ },
  ];
  const search = useSearch({ strict: false }) as { tab?: string; view?: string; vehicle?: string };
  const legacy = search.tab ? LEGACY[search.tab] : undefined;
  const navigate = useNavigate();
  const go = (tab: string, view?: string) =>
    void navigate({ to: '/vehicles', search: view ? { tab, view } : { tab } });
  const [adding, setAdding] = useState(false);
  const [reporting, setReporting] = useState(false);
  if (!orgId)
    return <Typography.Text role="status">Select an organisation to continue.</Typography.Text>;
  if (!view_ && !expenses)
    return <Alert type="error" showIcon message="You do not have access to vehicles and assets." />;
  const wanted = legacy?.tab ?? search.tab;
  const current = (tabs.find((t) => t.id === wanted && t.show)?.id ??
    (view_ ? 'vehicles' : 'equipment')) as FleetTab;
  const view = legacy?.view ?? search.view;
  type Opt = { value: string; label: string };
  // v36: each tab has a blue switch (subs) and, under some, teal view pills.
  const subs: Record<FleetTab, { id: string; label: string; views: Opt[] }[]> = {
    vehicles: [
      { id: 'fleet', label: 'Fleet', views: [{ value: 'fleet', label: 'Fleet' }] },
      {
        id: 'history',
        label: 'Vehicle history',
        views: [{ value: 'history', label: 'Vehicle history' }],
      },
    ],
    checks: [
      {
        id: 'daily',
        label: 'Daily checks',
        views: [
          { value: 'today', label: 'Today' },
          { value: 'checks', label: 'History' },
          { value: 'checklists', label: 'Check list versions' },
        ],
      },
      { id: 'defects', label: 'Defects', views: [{ value: 'defects', label: 'Defects' }] },
    ],
    equipment: [
      ...(view_
        ? [
            {
              id: 'equipment',
              label: 'Equipment',
              views: [{ value: 'equipment', label: 'Equipment' }],
            },
          ]
        : []),
      {
        id: 'care',
        label: 'Fleet care',
        views: [
          { value: 'care', label: 'Deep cleans' },
          ...(view_ || can('fleet.defect.create')
            ? [{ value: 'accidents', label: 'Accidents & damage' }]
            : []),
          ...(view_ ? [{ value: 'mileage', label: 'Mileage & servicing' }] : []),
          ...(view_ || can('fleet.vdi.submit')
            ? [{ value: 'medicines', label: 'Medicines & gases' }]
            : []),
          // Fuel claims are not in v36; the pill shows only for people who submit or approve them.
          ...(expenses ? [{ value: 'expenses', label: 'Fuel & expenses' }] : []),
        ],
      },
    ],
    crew: [],
  };
  const views: Record<FleetTab, Opt[]> = {
    // 'list' (the register table) stays reachable by link; v36 shows no switch for it.
    vehicles: [...subs.vehicles.flatMap((x) => x.views), { value: 'list', label: 'List' }],
    checks: subs.checks.flatMap((x) => x.views),
    equipment: subs.equipment.flatMap((x) => x.views),
    crew: [],
  };
  const v = views[current].find((x) => x.value === view)?.value ?? views[current][0]?.value;
  const sub = subs[current].find((x) => x.views.some((o) => o.value === v));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
      <PageHeader
        title="Vehicles and assets"
        description="Fleet status, daily checks, defects, equipment and fleet care."
        extra={
          <Space wrap>
            {can('fleet.vehicle.manage') && current === 'vehicles' && v === 'list' && (
              <Button onClick={() => setAdding(true)}>Add a vehicle</Button>
            )}
            {can('fleet.defect.create') && (
              <Button type="primary" icon={<Ms i="report" />} onClick={() => setReporting(true)}>
                Report a defect
              </Button>
            )}
          </Space>
        }
      />
      <Tabs label="Fleet sections" current={current} onChange={(t) => go(t)} tabs={tabs}>
        {subs[current].length > 1 && (
          <Views
            label={`${tabs.find((t) => t.id === current)?.label ?? ''} sections`}
            value={sub?.id ?? ''}
            onChange={(id) => go(current, subs[current].find((x) => x.id === id)!.views[0]!.value)}
            options={subs[current].map((x) => ({ value: x.id, label: x.label }))}
          />
        )}
        {sub && sub.views.length > 1 && (
          <Deeper>
            <Views
              label={`${sub.label} view`}
              value={v ?? ''}
              onChange={(x) => go(current, x)}
              options={sub.views}
            />
          </Deeper>
        )}
        {current === 'vehicles' && v === 'fleet' && (
          <FleetCards
            onHistory={(id) =>
              void navigate({
                to: '/vehicles',
                search: { tab: 'vehicles', view: 'history', vehicle: id },
              })
            }
          />
        )}
        {current === 'vehicles' && v === 'history' && <VehicleHistory initial={search.vehicle} />}
        {current === 'vehicles' && v === 'list' && <Vehicles />}
        {current === 'checks' && v === 'today' && <DailyToday />}
        {current === 'checks' && v === 'checks' && <DailyHistory />}
        {current === 'checks' && v === 'defects' && <DefectsV36 />}
        {current === 'checks' && v === 'checklists' && <VdiChecklists />}
        {current === 'equipment' && v === 'equipment' && <Equipment />}
        {current === 'equipment' && v === 'care' && <FleetCare />}
        {current === 'equipment' && v === 'expenses' && <Expenses />}
        {current === 'equipment' && v === 'accidents' && <Accidents />}
        {current === 'equipment' && v === 'mileage' && <MileageServicing />}
        {current === 'equipment' && v === 'medicines' && <MedicinesAndGases />}
        {current === 'crew' && <CrewApp />}
      </Tabs>
      <Modal
        open={adding}
        title="Add a vehicle"
        onCancel={() => setAdding(false)}
        footer={null}
        width={960}
        destroyOnHidden
      >
        <AddVehicle />
      </Modal>
      {reporting && <ReportDefect onClose={() => setReporting(false)} />}
    </div>
  );
}

function Vehicles() {
  const [status, setStatus] = useState('');
  const res = useOne<{ data: Row[] }>(`/api/v1/vehicles${status ? `?status=${status}` : ''}`);
  return (
    <>
      <Field label="Status">
        <Select
          style={{ width: 220 }}
          value={status || undefined}
          onChange={(v) => setStatus(v ?? '')}
          allowClear
          placeholder="All"
          options={Object.entries(VEHICLE_STATUS).map(([k, v]) => ({ value: k, label: v.text }))}
        />
      </Field>
      <DataTable<Row>
        caption="Vehicles"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load vehicles.' : null}
        emptyMessage="No vehicles."
        columns={[
          {
            key: 'cs',
            header: 'Callsign',
            cell: (r) => (
              <Link
                to="/vehicles/$id"
                params={{ id: r.id }}
                className="font-medium text-[#1667d9] underline"
              >
                {r.callsign}
              </Link>
            ),
          },
          { key: 'reg', header: 'Registration', cell: (r) => r.registration },
          { key: 'type', header: 'Type', cell: (r) => VEHICLE_TYPE[r.type] ?? words(r.type) },
          {
            key: 'cap',
            header: 'Capability',
            cell: (r) =>
              `${r.seats} seats, ${r.wheelchairCapacity} wheelchair, ${r.stretcher ? 'stretcher' : 'no stretcher'}`,
          },
          { key: 'odo', header: 'Latest odometer reading', cell: odometerText },
          { key: 'def', header: 'Open defects', cell: (r) => String(r.openDefects) },
          { key: 'st', header: 'Status', cell: (r) => <VehicleBadge v={r} /> },
        ]}
      />
    </>
  );
}

function Equipment() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const [proof, setProof] = useState<File | null>(null);
  const res = useOne<{ data: Row[] }>('/api/v1/equipment');
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles');
  const locations = useOne<{ data: Row[] }>(
    orgId ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const [acting, setActing] = useState<{ r: Row; kind: 'quarantine' | 'release' } | null>(null);
  const [regimeFor, setRegimeFor] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const vehicleName = new Map((vehicles.data?.data ?? []).map((v) => [v.id, v.callsign]));
  const locationName = new Map((locations.data?.data ?? []).map((l) => [l.id, l.name]));
  const where = (r: Row) =>
    r.vehicleId
      ? `On ${vehicleName.get(r.vehicleId) ?? 'a vehicle'}`
      : r.locationId
        ? `At ${locationName.get(r.locationId) ?? 'a base'}`
        : 'Not assigned';
  const assets = res.data?.data ?? [];
  const tagOf = (g: Row) => {
    const short = REGIME_SHORT[g.regime] ?? REGIMES[g.regime] ?? words(g.regime);
    const nd = g.nextDate
      ? new Date(`${g.nextDate as string}T12:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
        })
      : null;
    if (g.status === 'GREEN')
      return {
        tone: 'green' as const,
        icon: 'check_circle',
        text: `${short}: In date${nd ? ` to ${nd}` : ''}`,
      };
    if (g.status === 'AMBER')
      return { tone: 'amber' as const, icon: 'schedule', text: `${short}: Due ${nd ?? 'soon'}` };
    if (g.status === 'RED') {
      const late = g.nextDate
        ? Math.max(
            1,
            Math.floor((Date.now() - Date.parse(`${g.nextDate as string}T12:00:00Z`)) / 86_400_000),
          )
        : null;
      return {
        tone: 'red' as const,
        icon: 'error',
        text: `${short}: Overdue${late ? ` ${late}d` : ''} – out of use`,
      };
    }
    return { tone: 'grey' as const, icon: 'radio_button_unchecked', text: `${short}: Not set up` };
  };
  const statusOf = (r: Row) =>
    r.status === 'RETIRED'
      ? { tone: 'grey' as const, icon: 'block', text: 'Retired' }
      : r.status !== 'AVAILABLE'
        ? {
            tone: 'red' as const,
            icon: 'error',
            text: `Out of use – ${r.quarantineReason ?? 'quarantined'}`,
          }
        : (r.regimes as Row[]).some((g) => g.status === 'RED')
          ? { tone: 'red' as const, icon: 'error', text: 'Out of use – inspection overdue' }
          : { tone: 'green' as const, icon: 'check_circle', text: 'In service' };
  const [text, setText] = useState('');
  const [st, setSt] = useState('');
  const [recording, setRecording] = useState<{ instanceId: string; title: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const t = text.trim().toLowerCase();
  const shown = assets
    .filter((r) => !st || statusOf(r).text === st)
    .filter(
      (r) => !t || `${r.assetTag} ${words(r.category)} ${where(r)}`.toLowerCase().includes(t),
    );
  const statuses = new Map<string, number>();
  assets.forEach((r) => statuses.set(statusOf(r).text, (statuses.get(statusOf(r).text) ?? 0) + 1));
  // What each vehicle can do now: the capabilities its fitted, in-service equipment gives.
  const caps = (vehicles.data?.data ?? []).map((v) => {
    const fitted = assets.filter((a) => a.vehicleId === v.id && a.capability);
    const by = new Map<string, boolean>();
    for (const a of fitted) {
      const ok = statusOf(a).tone === 'green';
      by.set(a.capability, (by.get(a.capability) ?? false) || ok);
    }
    return { v, caps: [...by].sort((x, y) => Number(x[1]) - Number(y[1])) };
  });
  return (
    <>
      <WfCard title="What each vehicle can do now">
        <div className="wf-cap">
          {caps.map(({ v, caps: list }) => (
            <div key={v.id}>
              <b>{v.callsign}</b>
              <div className="wf-pills">
                {list.length === 0 && <span className="wf-mut">Nothing fitted</span>}
                {list.map(([k, ok]) =>
                  ok ? (
                    <WfTag key={k} tone="green" icon="check">
                      {CAPABILITY[k] ?? words(k)}
                    </WfTag>
                  ) : (
                    <WfTag key={k} tone="red" icon="block">
                      {CAPABILITY[k] ?? words(k)} out of use
                    </WfTag>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </WfCard>
      <WfCard
        title="Equipment register"
        table
        extra={
          can('fleet.vehicle.manage') && (
            <Button size="small" icon={<Ms i="add" />} onClick={() => setAdding(true)}>
              Add equipment
            </Button>
          )
        }
      >
        <div className="pc-tools rec-f in-card">
          <WfSearch value={text} onChange={setText} />
          <WfSelect
            label="Filter by status"
            value={st}
            onChange={setSt}
            options={[
              { value: '', label: 'All statuses' },
              ...[...statuses].map(([k, n]) => ({ value: k, label: `${k} (${n})` })),
            ]}
          />
        </div>
        <DataTable<Row>
          caption="Equipment register"
          rows={shown}
          rowKey={(r) => r.id}
          loading={res.isLoading}
          error={res.isError ? 'Could not load equipment.' : null}
          emptyMessage="No equipment."
          rowTone={(r) => {
            const x = statusOf(r).tone;
            if (x === 'red') return 'red';
            return (r.regimes as Row[]).some((g) => g.status === 'AMBER') ? 'amber' : null;
          }}
          columns={[
            {
              key: 'i',
              header: 'Item',
              cell: (r) => (
                <>
                  <b>
                    {r.assetTag} · {words(r.category)}
                  </b>
                  <span className="sub">
                    {[
                      where(r),
                      r.swlKg ? `SWL ${r.swlKg as number} kg` : null,
                      r.capability
                        ? `gives ${CAPABILITY[r.capability] ?? words(r.capability)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </>
              ),
            },
            {
              key: 'reg',
              header: 'Inspection regimes',
              cell: (r) =>
                (r.regimes as Row[]).length === 0 ? (
                  <WfTag tone="grey" icon="radio_button_unchecked">
                    No inspection regime set up
                  </WfTag>
                ) : (
                  <div className="wf-pills col">
                    {(r.regimes as Row[]).map((g) => {
                      const x = tagOf(g);
                      return (
                        <WfTag key={g.regime} tone={x.tone} icon={x.icon}>
                          {x.text}
                        </WfTag>
                      );
                    })}
                  </div>
                ),
            },
            {
              key: 'st',
              header: 'Status',
              cell: (r) => {
                const x = statusOf(r);
                return (
                  <WfTag tone={x.tone} icon={x.icon}>
                    {x.text}
                  </WfTag>
                );
              },
            },
            {
              key: 'act',
              header: '',
              cell: (r) => {
                const manage = can('fleet.vehicle.manage');
                const worst =
                  (r.regimes as Row[]).find((g) => g.status === 'RED') ??
                  (r.regimes as Row[]).find((g) => g.status === 'AMBER') ??
                  (r.regimes as Row[])[0];
                const more = [
                  {
                    label: viewing === r.id ? 'Hide details' : 'Details',
                    icon: 'info',
                    onClick: () => setViewing(viewing === r.id ? null : r.id),
                  },
                  ...(r.status !== 'RETIRED' && manage
                    ? [
                        { label: 'Edit', icon: 'edit', onClick: () => setEditing(r) },
                        {
                          label: 'Add inspection regime',
                          icon: 'add',
                          onClick: () => setRegimeFor(r),
                        },
                      ]
                    : []),
                  ...(r.status === 'AVAILABLE' && manage
                    ? [
                        {
                          label: 'Quarantine',
                          icon: 'block',
                          danger: true,
                          onClick: () => setActing({ r, kind: 'quarantine' as const }),
                        },
                      ]
                    : []),
                  ...(r.status === 'QUARANTINED' &&
                  can('fleet.return_to_service') &&
                  r.quarantinedBy !== me.user.id
                    ? [
                        {
                          label: 'Release',
                          icon: 'check',
                          onClick: () => setActing({ r, kind: 'release' as const }),
                        },
                      ]
                    : []),
                ];
                return (
                  <RowActions
                    name={r.assetTag}
                    primary={
                      worst
                        ? {
                            label: 'Record inspection',
                            icon: 'fact_check',
                            onClick: () =>
                              setRecording({
                                instanceId: worst.requirementInstanceId,
                                title: `${r.assetTag as string} – ${REGIMES[worst.regime] ?? words(worst.regime)}`,
                              }),
                          }
                        : null
                    }
                    more={more}
                  />
                );
              },
            },
          ]}
        />
      </WfCard>
      <EvidenceDialog target={recording} onClose={() => setRecording(null)} />
      {(res.data?.data ?? [])
        .filter((r) => r.id === viewing)
        .map((r) => (
          <EquipmentDetail key={r.id} asset={r} where={where(r)} />
        ))}
      <Modal
        open={adding}
        title="Add equipment"
        footer={null}
        width={900}
        onCancel={() => setAdding(false)}
        destroyOnHidden
      >
        <AddEquipment vehicles={vehicles.data?.data ?? []} locations={locations.data?.data ?? []} />
      </Modal>
      <EquipmentEditDialog
        asset={editing}
        vehicles={vehicles.data?.data ?? []}
        locations={locations.data?.data ?? []}
        onClose={() => setEditing(null)}
      />
      <ActionDialog
        open={acting !== null}
        title={
          acting?.kind === 'quarantine'
            ? `Quarantine ${acting.r.assetTag}`
            : `Release ${acting?.r.assetTag ?? ''} to service`
        }
        confirmLabel={acting?.kind === 'quarantine' ? 'Quarantine' : 'Release to service'}
        danger={acting?.kind === 'quarantine'}
        reasonLabel={
          acting?.kind === 'quarantine'
            ? 'Why is this asset being quarantined?'
            : 'Why is it safe to release? (what was checked)'
        }
        confirmDisabled={acting?.kind === 'release' && !proof}
        onCancel={() => {
          setActing(null);
          setProof(null);
        }}
        onConfirm={async (reason) => {
          const a = acting!;
          if (a.kind === 'quarantine')
            return api.send('POST', `/api/v1/equipment/${a.r.id}/quarantine`, orgId, { reason });
          // D3: release needs evidence (repair or inspection record), uploaded first.
          const up = await uploadFile(api, orgId, proof!, {
            title: `Release evidence ${a.r.assetTag}`,
          });
          const out = await api.send('POST', `/api/v1/equipment/${a.r.id}/release`, orgId, {
            reason,
            evidenceItemId: up.itemId,
          });
          setProof(null);
          return out;
        }}
        fields={
          acting?.kind === 'release' ? (
            <Field label="Repair or inspection evidence">
              <input
                type="file"
                className={input}
                onChange={(e) => setProof(e.target.files?.[0] ?? null)}
              />
            </Field>
          ) : undefined
        }
      >
        <p>
          {acting?.kind === 'quarantine'
            ? 'The asset cannot be used, and any vehicle it is fitted to is re-checked for what it can still do.'
            : 'The asset goes back into service. Someone other than the person who quarantined it releases it, with evidence. Your name, reason and evidence are recorded.'}
        </p>
      </ActionDialog>
      <RegimeDialog asset={regimeFor} onClose={() => setRegimeFor(null)} />
    </>
  );
}

function AddEquipment({ vehicles, locations }: { vehicles: Row[]; locations: Row[] }) {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const [place, setPlace] = useState<'vehicle' | 'location' | 'none'>('vehicle');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const swl = text('swlKg');
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/equipment', orgId, {
          assetTag: text('assetTag'),
          category: text('category'),
          ...(text('manufacturer') ? { manufacturer: text('manufacturer') } : {}),
          ...(text('model') ? { model: text('model') } : {}),
          ...(text('serial') ? { serial: text('serial') } : {}),
          ...(swl ? { swlKg: Number(swl) } : {}),
          ...(text('capability') ? { capability: text('capability') } : {}),
          ...(text('instructions') ? { instructions: text('instructions') } : {}),
          ...(place === 'vehicle' && text('vehicleId') ? { vehicleId: text('vehicleId') } : {}),
          ...(place === 'location' && text('locationId') ? { locationId: text('locationId') } : {}),
        }),
      'Equipment added. Add its inspection regimes so it is checked on time; until then it shows as not set up.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="Add equipment">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-3" aria-label="Add equipment">
        <Field label="Asset tag">
          <input
            name="assetTag"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9\-]{1,23}"
            placeholder="STR-04"
            className={input}
          />
        </Field>
        <Field label="Category">
          <select name="category" className={input}>
            {EQUIPMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {words(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manufacturer (optional)">
          <input name="manufacturer" maxLength={120} className={input} />
        </Field>
        <Field label="Model (optional)">
          <input name="model" maxLength={120} className={input} />
        </Field>
        <Field label="Serial number (optional)">
          <input name="serial" maxLength={60} className={input} />
        </Field>
        <Field label="Safe working load in kg (optional)">
          <input name="swlKg" type="number" min={1} max={100000} className={input} />
        </Field>
        <Field label="Gives the vehicle (optional)">
          <select name="capability" className={input} defaultValue="">
            <option value="">Nothing extra</option>
            {Object.entries(CAPABILITY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kept">
          <select
            className={input}
            value={place}
            onChange={(e) => setPlace(e.target.value as typeof place)}
          >
            <option value="vehicle">On a vehicle</option>
            <option value="location">At a base</option>
            <option value="none">Not assigned yet</option>
          </select>
        </Field>
        {place === 'vehicle' && (
          <Field label="Vehicle">
            <select name="vehicleId" required className={input}>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.callsign} ({v.registration})
                </option>
              ))}
            </select>
          </Field>
        )}
        {place === 'location' && (
          <Field label="Base">
            <select name="locationId" required className={input}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="md:col-span-3">
          <Field label="Instructions for use (optional)">
            <textarea name="instructions" maxLength={2000} rows={2} className={input} />
          </Field>
        </div>
        <div className="md:col-span-3">
          <Button type="primary" htmlType="submit">
            Add equipment
          </Button>
        </div>
      </form>
      {msg}
    </Section>
  );
}

function RegimeDialog({ asset, onClose }: { asset: Row | null; onClose: () => void }) {
  const { api, orgId } = useApp();
  const templates = useOne<{ data: Row[] }>('/api/v1/requirements/templates', asset !== null);
  const [regime, setRegime] = useState('SERVICE');
  const [templateId, setTemplateId] = useState('');
  const [source, setSource] = useState('');
  const usable = (templates.data?.data ?? []).filter(
    (t) =>
      !t.isLibrary &&
      (t.versions as Row[]).some((v) => v.status === 'EFFECTIVE' && v.subjectType === 'EQUIPMENT'),
  );
  const taken = new Set(((asset?.regimes ?? []) as Row[]).map((g) => g.regime));
  return (
    <ActionDialog
      open={asset !== null}
      title={`Add inspection regime to ${asset?.assetTag ?? ''}`}
      confirmLabel="Add regime"
      confirmDisabled={!templateId || taken.has(regime)}
      onCancel={() => {
        setTemplateId('');
        setSource('');
        onClose();
      }}
      onConfirm={() =>
        api.send('POST', `/api/v1/equipment/${asset!.id}/regimes`, orgId, {
          regime,
          templateId,
          ...(source.trim() ? { source: source.trim() } : {}),
        })
      }
      fields={
        <div className="grid gap-3">
          <Field label="Regime">
            <Select
              value={regime}
              onChange={setRegime}
              style={{ width: '100%' }}
              options={Object.entries(REGIMES).map(([k, v]) => ({
                value: k,
                label: `${v}${taken.has(k) ? ' (already set up)' : ''}`,
                disabled: taken.has(k),
              }))}
            />
          </Field>
          <Field label="Requirement it follows">
            <Select
              value={templateId || undefined}
              placeholder="Choose a published equipment requirement"
              onChange={setTemplateId}
              style={{ width: '100%' }}
              options={usable.map((t) => ({ value: t.id, label: t.title }))}
            />
          </Field>
          <Field label="Where the schedule comes from (optional)">
            <Input maxLength={300} value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
        </div>
      }
    >
      <p>
        Each regime has its own requirement and deadline. It starts as awaiting evidence: it only
        turns green once a certificate is uploaded and verified by someone else.
      </p>
      {templates.data && usable.length === 0 && (
        <p role="status">
          No equipment requirement is published yet. Publish one in Settings, Requirement library.
        </p>
      )}
    </ActionDialog>
  );
}

function Expenses() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const res = useOne<{ data: Row[] }>(`/api/v1/fuel-expenses${status ? `?status=${status}` : ''}`);
  const [deciding, setDeciding] = useState<{ r: Row; d: 'APPROVED' | 'REJECTED' } | null>(null);
  const name = (r: Row) =>
    `${EXPENSE_CATEGORY[r.category] ?? words(r.category)} ${pounds(r.amountPence)} on ${fmtDate(r.spentOn)}`;
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Show">
          <select
            className={`${input} w-56`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All claims</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.text}
              </option>
            ))}
          </select>
        </Field>
        {can('fleet.expense.approve') && (
          <>
            <Field label="Approved from">
              <input
                type="date"
                className={input}
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Approved to">
              <input
                type="date"
                className={input}
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Button
              size="small"
              onClick={() =>
                void run(async () => {
                  // D7: the export is approved claims for the chosen period.
                  const q = new URLSearchParams({ status: 'APPROVED' });
                  if (from) q.set('from', from);
                  if (to) q.set('to', to);
                  saveBlob(
                    await api.download!(`/api/v1/fuel-expenses/export?${q.toString()}`, orgId),
                    `approved-expenses${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}.csv`,
                  );
                }, 'Export of approved claims downloaded.')
              }
            >
              Export approved claims (CSV)
            </Button>
          </>
        )}
      </div>
      {msg}
      <DataTable<Row>
        caption="Fuel and expenses"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load expenses.' : null}
        emptyMessage="No expenses."
        columns={[
          { key: 'd', header: 'Date', cell: (r) => fmtDate(r.spentOn) },
          { key: 'v', header: 'Vehicle', cell: (r) => r.vehicleLabel ?? 'Vehicle' },
          {
            key: 'c',
            header: 'Claim',
            cell: (r) => (
              <>
                {EXPENSE_CATEGORY[r.category] ?? words(r.category)}
                {r.quantity !== null && (
                  <span className="block text-xs">
                    {r.quantity} {r.unit === 'KWH' ? 'kWh' : 'litres'}
                  </span>
                )}
                {r.supplier && <span className="block text-xs">{r.supplier}</span>}
              </>
            ),
          },
          { key: 'a', header: 'Amount', cell: (r) => pounds(r.amountPence) },
          {
            key: 'rc',
            header: 'Receipt',
            cell: (r) => (r.receiptEvidenceItemId ? 'Receipt attached' : 'No receipt'),
          },
          {
            key: 'by',
            header: 'Submitted by',
            cell: (r) =>
              r.submittedBy === me.user.id
                ? `${r.submittedByName ?? 'You'} (you)`
                : (r.submittedByName ?? 'Unknown'),
          },
          {
            key: 'dup',
            header: 'Check',
            cell: (r) =>
              r.duplicateOf ? (
                <StatusBadge status="AMBER" reason="Possible duplicate of another claim" />
              ) : (
                ''
              ),
          },
          {
            key: 's',
            header: 'Status',
            cell: (r) => (
              <>
                <StatusBadge
                  status={EXPENSE_STATUS[r.status]?.kind ?? 'GREY'}
                  reason={EXPENSE_STATUS[r.status]?.text ?? words(r.status)}
                />
                {r.status !== 'SUBMITTED' && (
                  <span className="block text-xs">
                    By {r.decidedByName ?? 'unknown'}
                    {r.decisionNote ? ` – ${r.decisionNote}` : ''}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'act',
            header: 'Action',
            cell: (r) =>
              can('fleet.expense.approve') && r.status === 'SUBMITTED' ? (
                r.submittedBy === me.user.id ? (
                  <span className="text-xs">Someone else must approve your claim.</span>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      size="small"
                      aria-label={`Approve: ${name(r)}`}
                      onClick={() => setDeciding({ r, d: 'APPROVED' })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="small"
                      aria-label={`Reject: ${name(r)}`}
                      onClick={() => setDeciding({ r, d: 'REJECTED' })}
                    >
                      Reject
                    </Button>
                  </div>
                )
              ) : null,
          },
        ]}
      />
      {can('fleet.expense.submit') && <SubmitExpense />}
      <ActionDialog
        open={deciding !== null}
        title={`${deciding?.d === 'APPROVED' ? 'Approve' : 'Reject'}: ${deciding ? name(deciding.r) : ''}`}
        confirmLabel={deciding?.d === 'APPROVED' ? 'Approve claim' : 'Reject claim'}
        danger={deciding?.d === 'REJECTED'}
        reasonLabel={
          deciding?.d === 'APPROVED'
            ? 'Note (optional)'
            : 'Why is it rejected? The claimant sees this'
        }
        reasonRequired={deciding?.d === 'REJECTED'}
        onCancel={() => setDeciding(null)}
        onConfirm={(note) =>
          api.send('POST', `/api/v1/fuel-expenses/${deciding!.r.id}/approve`, orgId, {
            decision: deciding!.d,
            ...(note ? { note } : {}),
          })
        }
      >
        <p>
          {deciding?.r.duplicateOf
            ? 'This claim looks like a duplicate of another one: check before deciding. '
            : ''}
          Your name is recorded with the decision.
        </p>
      </ActionDialog>
    </>
  );
}

function SubmitExpense() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const vehicles = useOne<{ data: Row[] }>('/api/v1/vehicles', can('fleet.vehicle.view'));
  const [category, setCategory] = useState('FUEL');
  const [receipt, setReceipt] = useState<File | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const pence = Math.round(Number(text('amount')) * 100);
    const qty = text('quantity');
    const odo = text('odometer');
    const ok = await run(async () => {
      // The receipt is uploaded first as the claimant's own evidence, then linked to the claim.
      const up = receipt
        ? await uploadFile(api, orgId, receipt, { title: `Receipt ${text('spentOn')}` })
        : null;
      return api.send('POST', '/api/v1/fuel-expenses', orgId, {
        vehicleId: text('vehicleId'),
        spentOn: text('spentOn'),
        category,
        amountPence: pence,
        ...(qty ? { quantity: Number(qty), unit: category === 'CHARGING' ? 'KWH' : 'LITRES' } : {}),
        ...(odo ? { odometer: Number(odo) } : {}),
        ...(text('supplier') ? { supplier: text('supplier') } : {}),
        ...(up ? { receiptEvidenceItemId: up.itemId } : {}),
      });
    }, 'Claim submitted. Someone else approves it.');
    if (ok) {
      form.reset();
      setReceipt(null);
    }
  }
  if (!can('fleet.vehicle.view'))
    return <p className="text-sm">Submit fuel and expenses from the crew app during your shift.</p>;
  return (
    <Section title="Submit a claim">
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-3" aria-label="Submit a claim">
        <Field label="Vehicle">
          <select name="vehicleId" required className={input}>
            {(vehicles.data?.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.callsign} ({v.registration})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            type="date"
            name="spentOn"
            required
            max={londonToday()}
            defaultValue={londonToday()}
            className={input}
          />
        </Field>
        <Field label="Category">
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(EXPENSE_CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount in pounds">
          <input
            name="amount"
            type="number"
            step="0.01"
            min={0.01}
            max={100000}
            required
            className={input}
          />
        </Field>
        {(category === 'FUEL' || category === 'CHARGING') && (
          <Field label={category === 'FUEL' ? 'Litres' : 'kWh (optional)'}>
            <input
              name="quantity"
              type="number"
              step="0.01"
              min={0.01}
              required={category === 'FUEL'}
              className={input}
            />
          </Field>
        )}
        <Field label={category === 'FUEL' ? 'Odometer in miles' : 'Odometer in miles (optional)'}>
          <input
            name="odometer"
            type="number"
            min={0}
            required={category === 'FUEL'}
            className={input}
          />
        </Field>
        <Field label="Supplier (optional)">
          <input name="supplier" maxLength={120} className={input} />
        </Field>
        <ReceiptPicker file={receipt} onChange={setReceipt} />
        <div className="md:col-span-3">
          <Button type="primary" htmlType="submit">
            Submit claim
          </Button>
        </div>
      </form>
      {msg}
    </Section>
  );
}
