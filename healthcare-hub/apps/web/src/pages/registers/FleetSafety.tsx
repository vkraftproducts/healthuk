// v36 screen 42 (Fleet care): Accidents & damage, and Medicines & gases with controlled drug
// balance checks. The server decides who may do what; buttons are hidden here for clarity only.
import { DataTable } from '@hub/ui';
import { useNavigate } from '@tanstack/react-router';
import { Ms, RowActions, WfCard, WfSearch, WfSelect, WfTag } from '../../v36/ui.js';
import { Alert, Button, Row as Space, Typography } from 'antd';
import { useState } from 'react';
import { ActionDialog, fmtDate, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { Mut, StatusTag, type Tone } from '../../v36/kit.js';
import { useOne, usePeople } from '../settings/hooks.js';
import {
  AreaF,
  CheckF,
  DateF,
  DateTimeF,
  NumF,
  SelectF,
  TextF,
  opts,
  today,
  useForm,
  type Row,
} from './form.js';

function useVehicles() {
  const q = useOne<{ data: Row[] }>('/api/v1/vehicles');
  return (q.data?.data ?? []).map((v) => ({ value: v.id as string, label: v.callsign as string }));
}

/** Pick an incident (event) to link; lists the caller's visible events by code. */
function useEvents(enabled: boolean) {
  const q = useOne<{ data: Row[] }>(enabled ? '/api/v1/events' : null);
  return (q.data?.data ?? []).map((e) => ({
    value: e.id as string,
    label: `${e.code as string} – ${(e.title as string) ?? ''}`,
  }));
}

// ---- accidents and damage ---------------------------------------------------------------------
export function Accidents() {
  const navigate = useNavigate();
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('fleet.defect.manage');
  const q = useOne<{ data: Row[] }>('/api/v1/vehicle-accidents');
  const vehicles = useVehicles();
  const events = useEvents(manage && can('events.event.view'));
  const [reporting, setReporting] = useState(false);
  const [insurer, setInsurer] = useState<Row | null>(null);
  const [linking, setLinking] = useState<Row | null>(null);
  const [closing, setClosing] = useState<Row | null>(null);
  const rep = useForm({
    vehicleId: '',
    occurredAt: new Date().toISOString(),
    place: '',
    description: '',
    thirdParty: 'None',
    policeRef: '',
    injuries: false,
    roadworthy: true,
  });
  const ins = useForm({ insurerRef: '', insurerNotifiedOn: today() });
  const link = useForm({ eventId: '' });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <WfCard
        title="Accidents and damage"
        table
        extra={
          can('fleet.defect.create') && (
            <Button
              size="small"
              type="primary"
              icon={<Ms i="car_crash" />}
              onClick={() => setReporting(true)}
            >
              Report an accident
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Accidents and damage"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load accidents.' : null}
          emptyMessage="No accidents or damage reported."
          columns={[
            {
              key: 'a',
              header: 'Accident',
              cell: (r) => (
                <>
                  <b>{r.code}</b>
                  <span className="sub">
                    {fmtDate(String(r.occurredAt).slice(0, 10))} · {r.description}
                    {r.photoCount ? ` · ${r.photoCount} photos` : ''}
                    {r.policeRef ? ` · police ref ${r.policeRef}` : ''}
                    {r.eventCode ? ` · incident ${r.eventCode}` : ''}
                  </span>
                </>
              ),
            },
            { key: 'v', header: 'Vehicle', cell: (r) => r.vehicleLabel },
            { key: 't', header: 'Third party', cell: (r) => r.thirdParty },
            {
              key: 'i',
              header: 'Insurer claim',
              cell: (r) => (r.insurerRef ? r.insurerRef : '—'),
            },
            {
              key: 'r',
              header: 'Roadworthy',
              cell: (r) =>
                r.roadworthy ? (
                  <StatusTag tone="green">Yes</StatusTag>
                ) : (
                  <StatusTag tone={r.defectStatus === 'RELEASED' ? 'green' : 'red'}>
                    {r.defectStatus === 'RELEASED' ? 'Released after repair' : 'No – off the road'}
                  </StatusTag>
                ),
            },
            {
              key: 's',
              header: 'State',
              cell: (r) => {
                const tone: Tone =
                  r.status === 'CLOSED'
                    ? 'grey'
                    : r.defectId && r.defectStatus !== 'RELEASED'
                      ? 'red'
                      : 'amber';
                return (
                  <div>
                    <StatusTag tone={tone}>{r.stateText}</StatusTag>
                    {r.releasedByName && (
                      <div>
                        <Mut>released by {r.releasedByName}</Mut>
                      </div>
                    )}
                    {r.injuries && !r.eventId && (
                      <div>
                        <Mut>Someone was hurt – an incident report is needed</Mut>
                      </div>
                    )}
                  </div>
                );
              },
            },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                manage && r.status === 'OPEN' ? (
                  <RowActions
                    name={r.code}
                    ghost
                    primary={
                      r.defectId && r.defectStatus !== 'RELEASED'
                        ? {
                            label: 'Repair and release',
                            icon: 'build',
                            onClick: () =>
                              void navigate({
                                to: '/vehicles',
                                search: { tab: 'checks', view: 'defects' },
                              }),
                          }
                        : { label: 'Close', icon: 'task_alt', onClick: () => setClosing(r) }
                    }
                    more={[
                      ...(!r.insurerRef
                        ? [
                            {
                              label: 'Insurer claim',
                              icon: 'description',
                              onClick: () => setInsurer(r),
                            },
                          ]
                        : []),
                      ...(!r.eventId
                        ? [{ label: 'Link incident', icon: 'link', onClick: () => setLinking(r) }]
                        : []),
                      ...(r.defectId && r.defectStatus !== 'RELEASED'
                        ? [{ label: 'Close', icon: 'task_alt', onClick: () => setClosing(r) }]
                        : []),
                    ]}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>

      <ActionDialog
        open={reporting}
        title="Report an accident or damage"
        confirmLabel="Report"
        confirmDisabled={
          !rep.v.vehicleId ||
          rep.v.description.trim().length < 10 ||
          rep.v.thirdParty.trim().length < 2
        }
        onCancel={() => {
          setReporting(false);
          rep.reset();
        }}
        onConfirm={() =>
          post('/api/v1/vehicle-accidents', {
            vehicleId: rep.v.vehicleId,
            occurredAt: rep.v.occurredAt,
            ...(rep.v.place.trim() ? { place: rep.v.place.trim() } : {}),
            description: rep.v.description.trim(),
            thirdParty: rep.v.thirdParty.trim(),
            ...(rep.v.policeRef.trim() ? { policeRef: rep.v.policeRef.trim() } : {}),
            injuries: rep.v.injuries,
            roadworthy: rep.v.roadworthy,
          })
        }
        fields={
          <>
            <SelectF
              label="Vehicle"
              value={rep.v.vehicleId}
              options={vehicles}
              onChange={rep.set('vehicleId')}
            />
            <DateTimeF label="When" value={rep.v.occurredAt} onChange={rep.set('occurredAt')} />
            <TextF label="Where (optional)" value={rep.v.place} onChange={rep.set('place')} />
            <AreaF
              label="What happened (no patient names)"
              value={rep.v.description}
              onChange={rep.set('description')}
            />
            <TextF
              label="Third party (name, insurer, registration – or “None”)"
              value={rep.v.thirdParty}
              onChange={rep.set('thirdParty')}
            />
            <TextF
              label="Police reference (if any)"
              value={rep.v.policeRef}
              onChange={rep.set('policeRef')}
            />
            <CheckF
              label="Someone was hurt"
              checked={rep.v.injuries}
              onChange={rep.set('injuries')}
            />
            <CheckF
              label="The vehicle is safe to drive"
              checked={rep.v.roadworthy}
              onChange={rep.set('roadworthy')}
            />
            {!rep.v.roadworthy && (
              <Alert
                type="warning"
                showIcon
                message="The vehicle will be blocked until it is repaired and released."
              />
            )}
          </>
        }
      />
      <ActionDialog
        open={insurer !== null}
        title={`Insurer claim – ${insurer?.code ?? ''}`}
        confirmLabel="Save"
        confirmDisabled={ins.v.insurerRef.trim().length < 2}
        onCancel={() => {
          setInsurer(null);
          ins.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/vehicle-accidents/${insurer!.id}/insurer`, {
            insurerRef: ins.v.insurerRef.trim(),
            insurerNotifiedOn: ins.v.insurerNotifiedOn,
          })
        }
        fields={
          <>
            <TextF
              label="Claim reference"
              value={ins.v.insurerRef}
              onChange={ins.set('insurerRef')}
            />
            <DateF
              label="Insurer told on"
              value={ins.v.insurerNotifiedOn}
              onChange={ins.set('insurerNotifiedOn')}
              noFuture
            />
          </>
        }
      />
      <ActionDialog
        open={linking !== null}
        title={`Link the incident report – ${linking?.code ?? ''}`}
        confirmLabel="Link"
        confirmDisabled={!link.v.eventId}
        onCancel={() => {
          setLinking(null);
          link.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/vehicle-accidents/${linking!.id}/link-event`, { eventId: link.v.eventId })
        }
        fields={
          <SelectF
            label="Incident"
            value={link.v.eventId}
            options={events}
            onChange={link.set('eventId')}
          />
        }
      />
      <ActionDialog
        open={closing !== null}
        title={`Close ${closing?.code ?? ''}`}
        confirmLabel="Close"
        reasonLabel="Closing note"
        onCancel={() => setClosing(null)}
        onConfirm={(note) => post(`/api/v1/vehicle-accidents/${closing!.id}/close`, { note })}
      />
    </div>
  );
}

// ---- medicines and gases ----------------------------------------------------------------------
const KIND: Record<string, string> = {
  MEDICAL_GAS: 'Medical gas',
  MEDICINE: 'Medicine',
  SEALED_POUCH: 'Sealed pouch',
};

export function MedicinesAndGases() {
  // v36: stock, expiry and seal checks only – giving medicines to patients is outside this system.
  return (
    <div className="hh-two">
      <VehicleStock />
      <ControlledDrugs />
    </div>
  );
}

function VehicleStock() {
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('fleet.vehicle.manage');
  const canCheck = can('fleet.vdi.submit') || manage;
  const q = useOne<{ data: Row[] }>('/api/v1/vehicle-stock');
  const [adding, setAdding] = useState<Row | null>(null);
  const [checking, setChecking] = useState<Row | null>(null);
  const [counts, setCounts] = useState<
    Record<string, { found: number; expiresOn: string; seal: boolean }>
  >({});
  const add = useForm({ kind: 'MEDICAL_GAS', name: '', expectedQty: 1 });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  const vehicles = (q.data?.data ?? []).filter((v) => manage || (v.items as Row[]).length > 0);
  const withItems = vehicles.filter((v) => (v.items as Row[]).length > 0);
  const [text, setText] = useState('');
  const [show, setShow] = useState('');
  const t = text.trim().toLowerCase();
  const flat = vehicles.flatMap((v) => {
    const items = (v.items as Row[]).filter(
      (i) =>
        (!t || `${v.vehicleLabel} ${i.name}`.toLowerCase().includes(t)) &&
        (!show ||
          (i.lastFound !== null && i.lastFound < i.expectedQty) ||
          i.state === 'EXPIRED' ||
          i.state === 'SEAL_BROKEN'),
    );
    if (items.length === 0)
      return show || t ? [] : [{ v, i: null as Row | null, first: true, short: false }];
    return items.map((i, n) => ({
      v,
      i: i as Row | null,
      first: n === 0,
      short: i.lastFound !== null && i.lastFound < i.expectedQty,
    }));
  });
  const openCheck = (v: Row) => {
    setCounts(
      Object.fromEntries(
        (v.items as Row[]).map((i) => [
          i.id,
          {
            found: i.expectedQty as number,
            expiresOn: (i.lastExpiresOn as string) ?? '',
            seal: true,
          },
        ]),
      ),
    );
    setChecking(v);
  };
  return (
    <WfCard
      title="Vehicle medicines and gases"
      table
      extra={
        canCheck && withItems.length > 0 ? (
          <Button size="small" icon={<Ms i="inventory" />} onClick={() => openCheck(withItems[0]!)}>
            Record stock check
          </Button>
        ) : undefined
      }
    >
      {q.isError && <Alert type="error" showIcon message="Could not load vehicle stock." />}
      <div className="pc-tools rec-f in-card">
        <WfSearch value={text} onChange={setText} />
        <WfSelect
          label="Filter by show"
          value={show}
          onChange={setShow}
          options={[
            { value: '', label: 'Show everything' },
            { value: 'problem', label: 'Short, expired or seal broken' },
          ]}
        />
      </div>
      <DataTable<Row>
        caption="Vehicle medicines and gases"
        rows={flat}
        rowKey={(r) => `${r.v.vehicleId as string}:${(r.i?.id as string) ?? 'none'}`}
        loading={q.isLoading}
        emptyMessage="No medicines or gases listed on any vehicle yet."
        rowTone={(r) =>
          r.i && (r.short || r.i.state === 'EXPIRED' || r.i.state === 'SEAL_BROKEN') ? 'red' : null
        }
        columns={[
          { key: 'v', header: 'Vehicle', cell: (r) => (r.first ? <b>{r.v.vehicleLabel}</b> : '') },
          {
            key: 'n',
            header: 'Item',
            cell: (r) => r.i?.name ?? <span className="wf-mut">Nothing listed</span>,
          },
          { key: 'e', header: 'Expected', cell: (r) => (r.i ? String(r.i.expectedQty) : '') },
          {
            key: 'f',
            header: 'Found',
            cell: (r) =>
              !r.i ? (
                ''
              ) : r.i.lastFound === null ? (
                '—'
              ) : r.short ? (
                <WfTag tone="red" icon="error">
                  {r.i.lastFound} – short
                </WfTag>
              ) : (
                String(r.i.lastFound)
              ),
          },
          {
            key: 'x',
            header: 'Expires',
            cell: (r) =>
              r.i?.lastExpiresOn ? (
                <WfTag
                  tone={
                    r.i.state === 'EXPIRED' ? 'red' : r.i.state === 'EXPIRING' ? 'amber' : 'green'
                  }
                  icon={
                    r.i.state === 'EXPIRED'
                      ? 'error'
                      : r.i.state === 'EXPIRING'
                        ? 'schedule'
                        : 'check_circle'
                  }
                >
                  {new Date(`${r.i.lastExpiresOn as string}T12:00:00Z`).toLocaleDateString(
                    'en-GB',
                    {
                      day: 'numeric',
                      month: 'short',
                    },
                  )}
                </WfTag>
              ) : (
                ''
              ),
          },
          {
            key: 'a',
            header: '',
            cell: (r) =>
              r.first && (canCheck || manage) ? (
                <RowActions
                  name={r.v.vehicleLabel}
                  more={[
                    ...(canCheck && (r.v.items as Row[]).length > 0
                      ? [
                          {
                            label: 'Record stock check',
                            icon: 'inventory',
                            onClick: () => openCheck(r.v),
                          },
                        ]
                      : []),
                    ...(manage
                      ? [{ label: 'Add item', icon: 'add', onClick: () => setAdding(r.v) }]
                      : []),
                  ]}
                />
              ) : null,
          },
        ]}
      />
      <ActionDialog
        open={adding !== null}
        title={`Add an item to ${adding?.vehicleLabel ?? ''}`}
        confirmLabel="Add"
        confirmDisabled={add.v.name.trim().length < 2 || add.v.expectedQty < 1}
        onCancel={() => {
          setAdding(null);
          add.reset();
        }}
        onConfirm={() =>
          post('/api/v1/vehicle-stock/items', {
            vehicleId: adding!.vehicleId,
            kind: add.v.kind,
            name: add.v.name.trim(),
            expectedQty: add.v.expectedQty,
          })
        }
        fields={
          <>
            <SelectF
              label="Kind"
              value={add.v.kind}
              options={opts(KIND)}
              onChange={add.set('kind')}
            />
            <TextF label="Name" value={add.v.name} onChange={add.set('name')} />
            <NumF
              label="Quantity carried"
              min={1}
              max={999}
              value={add.v.expectedQty}
              onChange={add.set('expectedQty')}
            />
          </>
        }
      />
      <ActionDialog
        open={checking !== null}
        title={`Stock check – ${checking?.vehicleLabel ?? ''}`}
        confirmLabel="Save check"
        confirmDisabled={Object.values(counts).some((c) => !c.expiresOn)}
        onCancel={() => setChecking(null)}
        onConfirm={() =>
          post('/api/v1/vehicle-stock/checks', {
            vehicleId: checking!.vehicleId,
            lines: Object.entries(counts).map(([itemId, c]) => ({
              itemId,
              found: c.found,
              expiresOn: c.expiresOn,
              sealIntact: c.seal,
            })),
          })
        }
        fields={
          <>
            {((checking?.items as Row[]) ?? []).map((i) => {
              const c = counts[i.id] ?? { found: 0, expiresOn: '', seal: true };
              const set = (p: Partial<typeof c>) =>
                setCounts((s) => ({ ...s, [i.id]: { ...c, ...p } }));
              return (
                <fieldset
                  key={i.id}
                  style={{ border: '1px solid #eee', padding: 8, marginBottom: 8 }}
                >
                  <legend>
                    {i.name} (expected {i.expectedQty})
                  </legend>
                  <NumF
                    label="Found"
                    value={c.found}
                    max={999}
                    onChange={(found) => set({ found })}
                  />
                  <DateF
                    label="Earliest expiry"
                    value={c.expiresOn}
                    onChange={(expiresOn) => set({ expiresOn })}
                  />
                  {i.kind !== 'MEDICINE' && (
                    <CheckF
                      label="Seals intact"
                      checked={c.seal}
                      onChange={(seal) => set({ seal })}
                    />
                  )}
                </fieldset>
              );
            })}
          </>
        }
      />
    </WfCard>
  );
}

function ControlledDrugs() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const canRecord =
    can('fleet.vdi.submit') || can('compliance.audit.run') || can('fleet.vehicle.manage');
  const canLink = can('events.event.manage') || can('compliance.audit.run');
  const q = useOne<{ data: Row[] }>('/api/v1/controlled-drug-checks');
  const people = usePeople().filter((p) => p.id !== me.user.id);
  const events = useEvents(canLink && can('events.event.view'));
  const [recording, setRecording] = useState(false);
  const [witnessing, setWitnessing] = useState<Row | null>(null);
  const [refusing, setRefusing] = useState<Row | null>(null);
  const [linking, setLinking] = useState<Row | null>(null);
  const rows = q.data?.data ?? [];
  const last = rows[0];
  const f = useForm({
    drug: (last?.drug as string) ?? '',
    store: (last?.store as string) ?? 'Station safe',
    registerBalance: (last?.countedBalance as number) ?? 0,
    countedBalance: (last?.countedBalance as number) ?? 0,
    witness: '',
  });
  const link = useForm({ eventId: '' });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  return (
    <WfCard
      title="Controlled drugs – balance checks"
      table
      extra={
        canRecord && (
          <Button
            size="small"
            type="primary"
            icon={<Ms i="fact_check" />}
            onClick={() => setRecording(true)}
          >
            Balance check
          </Button>
        )
      }
    >
      <DataTable<Row>
        caption="Controlled drug balance checks"
        rows={rows}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError ? 'Could not load controlled drug checks.' : null}
        emptyMessage="No balance checks recorded."
        columns={[
          {
            key: 'c',
            header: 'Check',
            cell: (r) => (
              <>
                {r.code}
                <span className="sub">{fmtDate(String(r.checkedAt).slice(0, 10))}</span>
              </>
            ),
          },
          { key: 'd', header: 'Drug', cell: (r) => r.drug },
          { key: 'w', header: 'Where', cell: (r) => r.vehicleLabel ?? r.store },
          {
            key: 'b',
            header: 'Balance',
            cell: (r) =>
              r.discrepancy ? (
                <StatusTag tone="red">
                  {r.countedBalance} – register says {r.registerBalance}
                </StatusTag>
              ) : (
                <WfTag tone="green" icon="check_circle">
                  {r.countedBalance} (matches)
                </WfTag>
              ),
          },
          {
            key: 's',
            header: 'Signed',
            cell: (r) => (
              <div>
                {r.checkedByName} +{' '}
                {r.status === 'WITNESSED' ? (
                  r.witnessName
                ) : r.status === 'WITNESS_REFUSED' ? (
                  <StatusTag tone="red">{r.witnessName} refused</StatusTag>
                ) : (
                  <StatusTag tone="amber">waiting for {r.witnessName}</StatusTag>
                )}
                {r.needsIncident && (
                  <div>
                    <StatusTag tone="red">Incident needed</StatusTag>
                  </div>
                )}
                {r.eventCode && (
                  <div>
                    <Mut>incident {r.eventCode}</Mut>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: 'a',
            header: 'Actions',
            cell: (r) => (
              <Space wrap>
                {r.awaitingMe && (
                  <>
                    <Button size="small" type="primary" onClick={() => setWitnessing(r)}>
                      Witness
                    </Button>
                    <Button size="small" onClick={() => setRefusing(r)}>
                      Cannot witness
                    </Button>
                  </>
                )}
                {r.needsIncident && canLink && (
                  <Button size="small" onClick={() => setLinking(r)}>
                    Link incident
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <ActionDialog
        open={recording}
        title="Controlled drug balance check"
        confirmLabel="Sign and send to witness"
        confirmDisabled={f.v.drug.trim().length < 3 || f.v.store.trim().length < 2 || !f.v.witness}
        onCancel={() => setRecording(false)}
        onConfirm={() =>
          post('/api/v1/controlled-drug-checks', {
            drug: f.v.drug.trim(),
            store: f.v.store.trim(),
            registerBalance: f.v.registerBalance,
            countedBalance: f.v.countedBalance,
            witnessUserId: f.v.witness,
          })
        }
        fields={
          <>
            <TextF label="Drug and strength" value={f.v.drug} onChange={f.set('drug')} />
            <TextF label="Where it is kept" value={f.v.store} onChange={f.set('store')} />
            <NumF
              label="Balance in the register"
              value={f.v.registerBalance}
              onChange={f.set('registerBalance')}
            />
            <NumF label="Count" value={f.v.countedBalance} onChange={f.set('countedBalance')} />
            <SelectF
              label="Witness (a different person)"
              value={f.v.witness}
              options={people.map((p) => ({ value: p.id, label: p.displayName }))}
              onChange={f.set('witness')}
            />
          </>
        }
      />
      <ActionDialog
        open={witnessing !== null}
        title={`Witness ${witnessing?.code ?? ''}`}
        confirmLabel="I witnessed this count"
        onCancel={() => setWitnessing(null)}
        onConfirm={() =>
          post(`/api/v1/controlled-drug-checks/${witnessing!.id}/witness`, { agree: true })
        }
      >
        {witnessing && (
          <Typography.Paragraph>
            {witnessing.drug}: counted {witnessing.countedBalance}, register{' '}
            {witnessing.registerBalance}.
          </Typography.Paragraph>
        )}
      </ActionDialog>
      <ActionDialog
        open={refusing !== null}
        title={`Cannot witness ${refusing?.code ?? ''}`}
        confirmLabel="Record"
        reasonLabel="Why you cannot witness it"
        onCancel={() => setRefusing(null)}
        onConfirm={(note) =>
          post(`/api/v1/controlled-drug-checks/${refusing!.id}/witness`, { agree: false, note })
        }
      />
      <ActionDialog
        open={linking !== null}
        title={`Link the incident – ${linking?.code ?? ''}`}
        confirmLabel="Link"
        confirmDisabled={!link.v.eventId}
        onCancel={() => {
          setLinking(null);
          link.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/controlled-drug-checks/${linking!.id}/link-event`, {
            eventId: link.v.eventId,
          })
        }
        fields={
          <SelectF
            label="Incident"
            value={link.v.eventId}
            options={events}
            onChange={link.set('eventId')}
          />
        }
      />
    </WfCard>
  );
}
