// v36 Staff › Training & reviews › Workforce checks: agency staff, DVLA and HCPC.
import { DataTable } from '@hub/ui';
import { Button } from 'antd';
import { useState } from 'react';
import { ActionDialog } from '../../../components.js';
import { useApp } from '../../../shell/AppContext.js';
import { Ms, RowActions, WfCard, WfTag } from '../../../v36/ui.js';
import {
  CheckF,
  DateF,
  NumF,
  SelectF,
  TextF,
  AreaF,
  today,
  useForm,
  type Row,
} from '../../registers/form.js';
import { useInvalidate, useOne } from '../../settings/hooks.js';
import { ROLE_LABEL } from '../labels.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** v36 dates: "29 Apr" and "8 Jun 2026" (three-letter months, never "Sept"). */
const dShort = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const dLong = (d: string) => `${dShort(d)} ${d.slice(0, 4)}`;

const ROLE_OPTS = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

function escSuffix(e: { stage: string; toName: string | null } | null | undefined) {
  if (!e) return '';
  if (e.stage === 'MANAGER' && e.toName) return ` · Escalated to ${e.toName}`;
  if (e.stage === 'LEAD') return ' · Escalated to lead';
  return '';
}

function nextCheckTag(r: Row) {
  const days = r.overdueDays as number;
  if (days > 0) {
    return (
      <WfTag tone="red" icon="error">
        {days} day{days === 1 ? '' : 's'} overdue{escSuffix(r.escalation)}
      </WfTag>
    );
  }
  if (days === 0) {
    return (
      <WfTag tone="amber" icon="schedule">
        Due today
      </WfTag>
    );
  }
  if (days >= -30) {
    return (
      <WfTag tone="amber" icon="schedule">
        Due in {-days} day{days === -1 ? '' : 's'}
      </WfTag>
    );
  }
  return (
    <WfTag tone="grey" icon="radio_button_unchecked">
      Due {dShort(r.nextCheckOn as string)}
    </WfTag>
  );
}

function yesNo(ok: boolean, yes: string, no: string) {
  return ok ? (
    <WfTag tone="green" icon="check_circle">
      {yes}
    </WfTag>
  ) : (
    <WfTag tone="amber" icon="schedule">
      {no}
    </WfTag>
  );
}

function pointsTag(points: number) {
  const tone = points >= 6 ? 'amber' : 'green';
  return (
    <WfTag tone={tone} icon={points >= 6 ? 'schedule' : 'check_circle'}>
      {points} point{points === 1 ? '' : 's'}
    </WfTag>
  );
}

export function WorkforceChecks() {
  const { api, orgId, me } = useApp();
  const manage = me.permissions.includes('staff.profile.manage');
  const invalidate = useInvalidate();
  const agency = useOne<{ data: Row[] }>('/api/v1/agency-workers');
  const dvla = useOne<{ data: Row[] }>('/api/v1/dvla-checks');
  const hcpc = useOne<{ data: Row[] }>('/api/v1/hcpc-registrations');
  const staff = useOne<{ data: Row[] }>(manage ? '/api/v1/staff?limit=100' : null);
  const drivers = (staff.data?.data ?? [])
    .filter((s) => s.lifecycleState !== 'LEAVER')
    .map((s) => ({ value: s.id as string, label: `${s.displayName} (${s.staffNo})` }));

  const [adding, setAdding] = useState(false);
  const [arrival, setArrival] = useState<Row | null>(null);
  const [recordingDvla, setRecordingDvla] = useState(false);
  const add = useForm({
    name: '',
    agency: '',
    role: 'EMERGENCY_CARE_ASSISTANT',
    confirmationItems: '',
    confirmationReceivedOn: today(),
    confirmationExpiresOn: today(),
    localInductionDone: false,
    idCheckedOnArrival: false,
  });
  const arr = useForm({ localInductionDone: false, idCheckedOnArrival: false });
  const dvlaForm = useForm({
    staffId: '',
    checkCode: '',
    categories: 'B, C1',
    points: 0,
    checkedOn: today(),
    nextCheckOn: today(),
  });

  const refresh = () => {
    void invalidate();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <WfCard
        title="Bank and agency staff"
        table
        extra={
          manage && (
            <Button
              type="primary"
              size="small"
              icon={<Ms i="person_add" />}
              onClick={() => {
                add.reset();
                setAdding(true);
              }}
            >
              Add agency worker
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Bank and agency staff"
          rows={agency.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={agency.isLoading}
          error={agency.isError ? 'Could not load agency workers.' : null}
          emptyMessage="No agency workers recorded."
          rowTone={(r) => (r.canWork ? null : 'red')}
          columns={[
            {
              key: 'p',
              header: 'Person',
              cell: (r) => (
                <>
                  <b>{r.name}</b>
                  <span className="sub">{`${r.code} · ${r.roleLabel}`}</span>
                </>
              ),
            },
            { key: 'a', header: 'Agency', cell: (r) => r.agency },
            {
              key: 'c',
              header: 'Agency confirmation',
              cell: (r) =>
                r.confirmationVerifiedBy ? (
                  <>
                    <WfTag tone="green" icon="check_circle">
                      Verified by {r.confirmationVerifiedByName ?? 'colleague'} · to{' '}
                      {dShort(r.confirmationExpiresOn)}
                    </WfTag>
                    <span className="sub">{r.confirmationItems}</span>
                  </>
                ) : (
                  <>
                    <WfTag tone="blue" icon="hourglass_top">
                      Received {dShort(r.confirmationReceivedOn)} – awaiting verification
                    </WfTag>
                    <span className="sub">{r.confirmationItems}</span>
                  </>
                ),
            },
            {
              key: 'i',
              header: 'Local induction',
              cell: (r) => yesNo(!!r.localInductionDone, 'Done', 'Not done'),
            },
            {
              key: 'id',
              header: 'ID on arrival',
              cell: (r) => yesNo(!!r.idCheckedOnArrival, 'Checked', 'Not checked'),
            },
            {
              key: 'w',
              header: 'Can work',
              cell: (r) =>
                r.canWork ? (
                  <WfTag tone="green" icon="check_circle">
                    Cleared
                  </WfTag>
                ) : (
                  <WfTag tone="red" icon="error">
                    Not cleared
                  </WfTag>
                ),
            },
            {
              key: 'x',
              header: '',
              cell: (r) => {
                if (!manage) return null;
                const awaiting =
                  !r.confirmationVerifiedBy && r.confirmationRecordedBy !== me.user.id;
                const needsArrival = !r.localInductionDone || !r.idCheckedOnArrival;
                if (!awaiting && !needsArrival) return null;
                return (
                  <RowActions
                    name={r.name}
                    primary={
                      awaiting
                        ? {
                            label: 'Verify',
                            icon: 'verified',
                            onClick: async () => {
                              await api.send(
                                'POST',
                                `/api/v1/agency-workers/${r.id as string}/verify`,
                                orgId,
                                {},
                              );
                              refresh();
                            },
                          }
                        : needsArrival
                          ? {
                              label: 'Arrival checks',
                              icon: 'badge',
                              onClick: () => {
                                arr.reset();
                                arr.set('localInductionDone')(!!r.localInductionDone);
                                arr.set('idCheckedOnArrival')(!!r.idCheckedOnArrival);
                                setArrival(r);
                              },
                            }
                          : undefined
                    }
                    more={
                      awaiting && needsArrival
                        ? [
                            {
                              label: 'Arrival checks',
                              icon: 'badge',
                              onClick: () => {
                                arr.reset();
                                arr.set('localInductionDone')(!!r.localInductionDone);
                                arr.set('idCheckedOnArrival')(!!r.idCheckedOnArrival);
                                setArrival(r);
                              },
                            },
                          ]
                        : undefined
                    }
                  />
                );
              },
            },
          ]}
        />
      </WfCard>

      <WfCard title="Driving licence checks (DVLA)" table>
        <DataTable<Row>
          caption="Driving licence checks"
          rows={dvla.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={dvla.isLoading}
          error={dvla.isError ? 'Could not load DVLA checks.' : null}
          emptyMessage="No DVLA checks recorded."
          rowTone={(r) =>
            (r.overdueDays as number) > 0 ? 'red' : (r.overdueDays as number) >= -30 ? 'amber' : null
          }
          columns={[
            {
              key: 'd',
              header: 'Driver',
              cell: (r) => <b>{r.staffName}</b>,
            },
            { key: 'c', header: 'Categories', cell: (r) => r.categories },
            {
              key: 'p',
              header: 'Points',
              cell: (r) => pointsTag(r.points as number),
            },
            { key: 'l', header: 'Last checked', cell: (r) => dLong(r.checkedOn) },
            { key: 'n', header: 'Next check', cell: (r) => nextCheckTag(r) },
            {
              key: 'x',
              header: '',
              cell: (r) =>
                manage ? (
                  <RowActions
                    name={r.staffName}
                    primary={{
                      label: 'Record DVLA check',
                      icon: 'badge',
                      onClick: () => {
                        dvlaForm.reset();
                        dvlaForm.set('staffId')(r.staffId as string);
                        dvlaForm.set('categories')(r.categories as string);
                        setRecordingDvla(true);
                      },
                    }}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>

      <WfCard title="HCPC registration" table>
        <DataTable<Row>
          caption="HCPC registration"
          rows={hcpc.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={hcpc.isLoading}
          error={hcpc.isError ? 'Could not load HCPC registrations.' : null}
          emptyMessage="No HCPC registrations recorded."
          columns={[
            {
              key: 'p',
              header: 'Paramedic',
              cell: (r) => <b>{r.staffName}</b>,
            },
            { key: 'r', header: 'Registration', cell: (r) => r.registrationNo },
            { key: 'c', header: 'Checked on register', cell: (r) => dLong(r.checkedOn) },
            {
              key: 'e',
              header: 'Renewal',
              cell: (r) => (
                <WfTag tone="green" icon="check_circle">
                  Registered to {dShort(r.expiresOn)}
                </WfTag>
              ),
            },
          ]}
        />
      </WfCard>

      <ActionDialog
        open={adding}
        title="Add agency worker"
        confirmLabel="Save"
        confirmDisabled={
          !add.v.name.trim() ||
          !add.v.agency.trim() ||
          add.v.confirmationItems.trim().length < 3 ||
          !add.v.confirmationReceivedOn ||
          !add.v.confirmationExpiresOn
        }
        onCancel={() => setAdding(false)}
        onConfirm={async () => {
          await api.send('POST', '/api/v1/agency-workers', orgId, {
            name: add.v.name.trim(),
            agency: add.v.agency.trim(),
            role: add.v.role,
            confirmationItems: add.v.confirmationItems.trim(),
            confirmationReceivedOn: add.v.confirmationReceivedOn,
            confirmationExpiresOn: add.v.confirmationExpiresOn,
            localInductionDone: !!add.v.localInductionDone,
            idCheckedOnArrival: !!add.v.idCheckedOnArrival,
          });
          setAdding(false);
          refresh();
        }}
        fields={
          <>
            <TextF label="Name" value={add.v.name} onChange={add.set('name')} />
            <TextF label="Agency" value={add.v.agency} onChange={add.set('agency')} />
            <SelectF
              label="Role"
              value={add.v.role}
              options={ROLE_OPTS}
              onChange={add.set('role')}
            />
            <AreaF
              label="Confirmation items"
              value={add.v.confirmationItems}
              onChange={add.set('confirmationItems')}
            />
            <DateF
              label="Confirmation received"
              value={add.v.confirmationReceivedOn}
              onChange={add.set('confirmationReceivedOn')}
            />
            <DateF
              label="Confirmation expires"
              value={add.v.confirmationExpiresOn}
              onChange={add.set('confirmationExpiresOn')}
            />
            <CheckF
              label="Local induction done"
              checked={!!add.v.localInductionDone}
              onChange={add.set('localInductionDone')}
            />
            <CheckF
              label="ID checked on arrival"
              checked={!!add.v.idCheckedOnArrival}
              onChange={add.set('idCheckedOnArrival')}
            />
          </>
        }
      />

      <ActionDialog
        open={!!arrival}
        title={`Arrival checks – ${arrival?.name ?? ''}`}
        confirmLabel="Save"
        onCancel={() => setArrival(null)}
        onConfirm={async () => {
          await api.send('POST', `/api/v1/agency-workers/${arrival!.id as string}/arrival`, orgId, {
            localInductionDone: !!arr.v.localInductionDone,
            idCheckedOnArrival: !!arr.v.idCheckedOnArrival,
          });
          setArrival(null);
          refresh();
        }}
        fields={
          <>
            <CheckF
              label="Local induction done"
              checked={!!arr.v.localInductionDone}
              onChange={arr.set('localInductionDone')}
            />
            <CheckF
              label="ID checked on arrival"
              checked={!!arr.v.idCheckedOnArrival}
              onChange={arr.set('idCheckedOnArrival')}
            />
          </>
        }
      />

      <ActionDialog
        open={recordingDvla}
        title="Record DVLA check"
        confirmLabel="Save check"
        confirmDisabled={
          !dvlaForm.v.staffId ||
          dvlaForm.v.checkCode.trim().length < 4 ||
          !dvlaForm.v.categories.trim() ||
          !dvlaForm.v.checkedOn ||
          !dvlaForm.v.nextCheckOn
        }
        onCancel={() => setRecordingDvla(false)}
        onConfirm={async () => {
          await api.send('POST', '/api/v1/dvla-checks', orgId, {
            staffId: dvlaForm.v.staffId,
            checkCode: dvlaForm.v.checkCode.trim(),
            categories: dvlaForm.v.categories.trim(),
            points: Number(dvlaForm.v.points) || 0,
            checkedOn: dvlaForm.v.checkedOn,
            nextCheckOn: dvlaForm.v.nextCheckOn,
          });
          setRecordingDvla(false);
          refresh();
        }}
        fields={
          <>
            <SelectF
              label="Driver"
              value={dvlaForm.v.staffId}
              options={drivers}
              onChange={dvlaForm.set('staffId')}
            />
            <TextF
              label="Check code"
              value={dvlaForm.v.checkCode}
              onChange={dvlaForm.set('checkCode')}
            />
            <TextF
              label="Categories"
              value={dvlaForm.v.categories}
              onChange={dvlaForm.set('categories')}
            />
            <NumF
              label="Points"
              value={Number(dvlaForm.v.points) || 0}
              max={99}
              onChange={dvlaForm.set('points')}
            />
            <DateF
              label="Checked on"
              value={dvlaForm.v.checkedOn}
              onChange={dvlaForm.set('checkedOn')}
            />
            <DateF
              label="Next check"
              value={dvlaForm.v.nextCheckOn}
              onChange={dvlaForm.set('nextCheckOn')}
            />
          </>
        }
      />
    </div>
  );
}
