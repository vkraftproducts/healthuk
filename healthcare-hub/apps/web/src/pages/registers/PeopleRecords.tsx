// v36 screen 35: probation reviews and appraisals, sickness and return to work, leavers.
// The API decides who may see and change what; buttons are hidden here for clarity only.
import { daysUntil } from '@hub/rules';
import { DataTable } from '@hub/ui';
import { Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';
import { ActionDialog, PersonSelect, fmtDate, useCan, useRun } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { CountBar, Mut, RuleNote, StatusTag, type Tone } from '../../v36/kit.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { Ms, RowActions, WfCard, WfTag, WfWarn } from '../../v36/ui.js';
import { Who } from '../../v36/kit.js';

const dShort = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
import { AreaF, CheckF, DateF, SelectF, TextF, opts, today, useForm, type Row } from './form.js';

function useStaffOptions(enabled = true) {
  const q = useOne<{ data: Row[] }>(enabled ? '/api/v1/staff?limit=100' : null);
  return (q.data?.data ?? [])
    .filter((s) => s.lifecycleState !== 'LEAVER')
    .map((s) => ({
      value: s.id as string,
      label: `${s.displayName as string} (${s.staffNo as string})`,
    }));
}

// ---- reviews ----------------------------------------------------------------------------------
const REVIEW_KIND: Record<string, string> = {
  PROBATION_3M: 'Probation – 3 months',
  PROBATION_6M: 'Probation – 6 months',
  APPRAISAL: 'Annual appraisal',
  OTHER: 'Other review',
};
const OUTCOMES: Record<string, Record<string, string>> = {
  PROBATION_3M: { PASSED: 'Passed', EXTENDED: 'Extended', NOT_PASSED: 'Concerns – not passed' },
  PROBATION_6M: { PASSED: 'Passed', EXTENDED: 'Extended', NOT_PASSED: 'Concerns – not passed' },
  APPRAISAL: {
    MEETS: 'Meets expectations',
    EXCEEDS: 'Exceeds expectations',
    NEEDS_SUPPORT: 'Needs support',
  },
  OTHER: { RECORDED: 'Recorded' },
};

export function Reviews() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('staff.profile.manage');
  const q = useOne<{ data: Row[] }>('/api/v1/staff-reviews');
  const staff = useStaffOptions(manage);
  const people = usePeople(manage);
  const [scheduling, setScheduling] = useState(false);
  const [recording, setRecording] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const sch = useForm({ staffId: '', kind: 'APPRAISAL', dueOn: today() });
  const rec = useForm({
    outcome: '',
    reviewedOn: today(),
    reviewer: me.user.id,
    notes: '',
    objectives: '',
  });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  const all = q.data?.data ?? [];
  const open = all.filter((r) => r.status === 'SCHEDULED');

  const only = '' as '' | 'due' | 'overdue';
  const rank = (r: Row) => (r.status === 'SCHEDULED' ? (r.overdue ? 0 : 1) : 2);
  const rows = (only === 'due' ? open : only === 'overdue' ? open.filter((r) => r.overdue) : all)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || String(a.dueOn).localeCompare(String(b.dueOn)));
  const statusText = (r: Row) => {
    if (r.status === 'DONE') return `Done ${r.reviewedOn ? dShort(r.reviewedOn) : ''}`.trim();
    if (r.status === 'CANCELLED') return 'Cancelled';
    if (r.overdue) {
      // Whole London days, as the server counts them.
      const d = -daysUntil(r.dueOn as string, new Date());
      const esc = r.escalation as { stage: string; toName: string | null } | null | undefined;
      const suffix =
        esc?.stage === 'MANAGER' && esc.toName
          ? ` · Escalated to ${esc.toName}`
          : esc?.stage === 'LEAD'
            ? ' · Escalated to lead'
            : '';
      return `${d} day${d === 1 ? '' : 's'} overdue${suffix}`;
    }
    return `Due ${dShort(r.dueOn)}`;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <WfCard
        title="Probation reviews and appraisals"
        table
        extra={
          manage && (
            <Button size="small" icon={<Ms i="event" />} onClick={() => setScheduling(true)}>
              Schedule a review
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Probation reviews and appraisals"
          rows={rows}
          rowTone={(r) => (r.status === 'SCHEDULED' && r.overdue ? 'red' : null)}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load reviews.' : null}
          emptyMessage="No reviews scheduled."
          columns={[
            {
              key: 'p',
              header: 'Person',
              cell: (r) => <Who name={r.staffName} sub={r.code} />,
            },
            {
              key: 'k',
              header: 'Review',
              cell: (r) => (
                <>
                  {REVIEW_KIND[r.kind] ?? r.kind}
                  {r.objectives && <span className="sub">Objectives: {r.objectives}</span>}
                  {r.outcome && !r.objectives && (
                    <span className="sub">
                      Outcome: {OUTCOMES[r.kind]?.[r.outcome] ?? r.outcome}
                      {r.reviewerName ? ` · by ${r.reviewerName}` : ''}
                    </span>
                  )}
                </>
              ),
            },
            { key: 'd', header: 'Due', cell: (r) => fmtDate(r.dueOn) },
            {
              key: 's',
              header: 'Status',
              cell: (r) => {
                const tone: Tone =
                  r.status === 'DONE'
                    ? 'green'
                    : r.status === 'CANCELLED'
                      ? 'grey'
                      : r.overdue
                        ? 'red'
                        : 'blue';
                const icon =
                  tone === 'green'
                    ? 'check_circle'
                    : tone === 'red'
                      ? 'error'
                      : tone === 'grey' && r.status === 'CANCELLED'
                        ? 'block'
                        : 'radio_button_unchecked';
                return (
                  <WfTag tone={tone === 'blue' ? 'grey' : tone} icon={icon}>
                    {statusText(r)}
                  </WfTag>
                );
              },
            },
            {
              key: 'a',
              header: '',
              cell: (r) =>
                manage && r.status === 'SCHEDULED' ? (
                  <RowActions
                    name={r.staffName}
                    primary={{
                      label: 'Record review',
                      icon: 'rate_review',
                      onClick: () => {
                        rec.reset();
                        setRecording(r);
                      },
                    }}
                    more={[{ label: 'Cancel', icon: 'block', onClick: () => setCancelling(r) }]}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>
      <ActionDialog
        open={scheduling}
        title="Schedule a review"
        confirmLabel="Schedule"
        confirmDisabled={!sch.v.staffId || !sch.v.dueOn}
        onCancel={() => {
          setScheduling(false);
          sch.reset();
        }}
        onConfirm={() => post('/api/v1/staff-reviews', sch.v)}
        fields={
          <>
            <SelectF
              label="Person"
              value={sch.v.staffId}
              options={staff}
              onChange={sch.set('staffId')}
            />
            <SelectF
              label="Type"
              value={sch.v.kind}
              options={opts(REVIEW_KIND)}
              onChange={sch.set('kind')}
            />
            <DateF label="Due" value={sch.v.dueOn} onChange={sch.set('dueOn')} />
          </>
        }
      />
      <ActionDialog
        open={recording !== null}
        title={`Record – ${REVIEW_KIND[recording?.kind] ?? ''} – ${recording?.staffName ?? ''}`}
        confirmLabel="Save review"
        confirmDisabled={
          !rec.v.outcome || (recording?.kind === 'APPRAISAL' && rec.v.objectives.trim().length < 3)
        }
        onCancel={() => setRecording(null)}
        onConfirm={() =>
          post(`/api/v1/staff-reviews/${recording!.id}/record`, {
            outcome: rec.v.outcome,
            reviewedOn: rec.v.reviewedOn,
            reviewerUserId: rec.v.reviewer,
            ...(rec.v.notes.trim() ? { notes: rec.v.notes.trim() } : {}),
            ...(rec.v.objectives.trim() ? { objectives: rec.v.objectives.trim() } : {}),
          })
        }
        fields={
          <>
            <SelectF
              label="Outcome"
              value={rec.v.outcome}
              options={opts(OUTCOMES[recording?.kind] ?? {})}
              onChange={rec.set('outcome')}
            />
            <DateF
              label="Reviewed on"
              value={rec.v.reviewedOn}
              onChange={rec.set('reviewedOn')}
              noFuture
            />
            <PersonSelect
              label="Reviewed by"
              value={rec.v.reviewer}
              onChange={rec.set('reviewer')}
              people={people}
              meId={me.user.id}
            />
            {recording?.kind === 'APPRAISAL' && (
              <AreaF
                label="Objectives for next year"
                value={rec.v.objectives}
                onChange={rec.set('objectives')}
              />
            )}
            <AreaF label="Notes (optional)" value={rec.v.notes} onChange={rec.set('notes')} />
          </>
        }
      />
      <ActionDialog
        open={cancelling !== null}
        title="Cancel this review"
        confirmLabel="Cancel review"
        reasonLabel="Why it is no longer needed"
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => post(`/api/v1/staff-reviews/${cancelling!.id}/cancel`, { reason })}
      />
    </div>
  );
}

// ---- sickness and return to work --------------------------------------------------------------
const ABS_CATEGORY: Record<string, string> = {
  MUSCULOSKELETAL: 'Musculoskeletal',
  RESPIRATORY: 'Respiratory',
  GASTROINTESTINAL: 'Gastrointestinal',
  MENTAL_HEALTH: 'Mental health',
  INJURY_AT_WORK: 'Injury at work',
  INFECTION: 'Infection',
  OTHER: 'Other',
};

export function Absence() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('staff.sensitive.view') && can('staff.profile.manage');
  const q = useOne<{ data: Row[]; triggers: Row[] }>('/api/v1/staff-absences');
  const staff = useStaffOptions(manage);
  const people = usePeople(manage);
  const [recording, setRecording] = useState(false);
  const [returning, setReturning] = useState<Row | null>(null);
  const add = useForm({ staffId: '', firstDay: today(), lastDay: '', category: 'OTHER' });
  const rtw = useForm({
    lastDay: '',
    rtwOn: today(),
    by: me.user.id,
    note: '',
    phased: false,
    phasedTerms: '',
    phasedUntil: '',
  });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {(q.data?.triggers ?? [])
        .filter((t) => t.reached)
        .map((t) => (
          <WfWarn key={t.staffId}>
            {t.staffName} has {t.episodes6m} absences in 6 months – absence review trigger reached
          </WfWarn>
        ))}
      <WfCard
        title="Absences"
        table
        extra={
          manage && (
            <Button size="small" icon={<Ms i="sick" />} onClick={() => setRecording(true)}>
              Record absence
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Sickness absence"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load absences.' : null}
          emptyMessage="No absences recorded."
          columns={[
            {
              key: 'p',
              header: 'Person',
              cell: (r) => (
                <>
                  <b>{r.staffName}</b>
                  <span className="sub">
                    {r.code}
                    {r.bradford !== undefined
                      ? ` · Bradford score ${r.bradford}`
                      : ` · ${r.days} day${r.days === 1 ? '' : 's'}`}
                  </span>
                </>
              ),
            },
            { key: 'f', header: 'From', cell: (r) => fmtDate(r.firstDay) },
            {
              key: 't',
              header: 'To',
              cell: (r) =>
                r.stillOff ? (
                  <WfTag tone="amber" icon="schedule">
                    Still off
                  </WfTag>
                ) : (
                  fmtDate(r.lastDay)
                ),
            },
            { key: 'c', header: 'Category', cell: (r) => ABS_CATEGORY[r.category] ?? r.category },
            {
              key: 'r',
              header: 'Return to work',
              cell: (r) =>
                r.rtwOn ? (
                  <>
                    <WfTag tone="green" icon="check_circle">
                      Interview {dShort(r.rtwOn)}
                      {r.rtwByName ? ` by ${r.rtwByName}` : ''}
                    </WfTag>
                    {r.phased && (
                      <span className="sub">Phased return agreed – {r.phasedTerms}</span>
                    )}
                  </>
                ) : r.rtwMissing ? (
                  <WfTag tone="red" icon="error">
                    Interview not done
                  </WfTag>
                ) : (
                  '—'
                ),
            },
            {
              key: 'a',
              header: '',
              cell: (r) =>
                manage && !r.rtwOn ? (
                  <RowActions
                    name={r.staffName}
                    primary={{
                      label: 'Return to work',
                      icon: 'login',
                      onClick: () => {
                        rtw.reset();
                        setReturning(r);
                      },
                    }}
                  />
                ) : null,
            },
          ]}
        />
      </WfCard>
      <ActionDialog
        open={recording}
        title="Record absence"
        confirmLabel="Record"
        confirmDisabled={!add.v.staffId || !add.v.firstDay}
        onCancel={() => {
          setRecording(false);
          add.reset();
        }}
        onConfirm={() =>
          post('/api/v1/staff-absences', {
            staffId: add.v.staffId,
            firstDay: add.v.firstDay,
            ...(add.v.lastDay ? { lastDay: add.v.lastDay } : {}),
            category: add.v.category,
          })
        }
        fields={
          <>
            <SelectF
              label="Person"
              value={add.v.staffId}
              options={staff}
              onChange={add.set('staffId')}
            />
            <DateF
              label="First day off"
              value={add.v.firstDay}
              onChange={add.set('firstDay')}
              noFuture
            />
            <DateF
              label="Last day off (leave blank if still off)"
              value={add.v.lastDay}
              onChange={add.set('lastDay')}
              noFuture
            />
            <SelectF
              label="Category (no medical detail)"
              value={add.v.category}
              options={opts(ABS_CATEGORY)}
              onChange={add.set('category')}
            />
          </>
        }
      />
      <ActionDialog
        open={returning !== null}
        title={`Return-to-work interview – ${returning?.staffName ?? ''}`}
        confirmLabel="Save"
        confirmDisabled={
          (returning?.stillOff && !rtw.v.lastDay) ||
          (rtw.v.phased && (rtw.v.phasedTerms.trim().length < 3 || !rtw.v.phasedUntil))
        }
        onCancel={() => setReturning(null)}
        onConfirm={() =>
          post(`/api/v1/staff-absences/${returning!.id}/return`, {
            ...(returning?.stillOff ? { lastDay: rtw.v.lastDay } : {}),
            rtwOn: rtw.v.rtwOn,
            rtwByUserId: rtw.v.by,
            ...(rtw.v.note.trim() ? { note: rtw.v.note.trim() } : {}),
            phased: rtw.v.phased,
            ...(rtw.v.phased
              ? { phasedTerms: rtw.v.phasedTerms.trim(), phasedUntil: rtw.v.phasedUntil }
              : {}),
          })
        }
        fields={
          <>
            {returning?.stillOff && (
              <DateF
                label="Last day off"
                value={rtw.v.lastDay}
                onChange={rtw.set('lastDay')}
                noFuture
              />
            )}
            <DateF label="Interview on" value={rtw.v.rtwOn} onChange={rtw.set('rtwOn')} noFuture />
            <PersonSelect
              label="Interview by"
              value={rtw.v.by}
              onChange={rtw.set('by')}
              people={people}
              meId={me.user.id}
            />
            <AreaF
              label="Note (optional, no medical detail)"
              value={rtw.v.note}
              onChange={rtw.set('note')}
            />
            <CheckF
              label="Agree a phased return (adds a restriction the planner shows)"
              checked={rtw.v.phased}
              onChange={rtw.set('phased')}
            />
            {rtw.v.phased && (
              <>
                <TextF
                  label="Phased return terms"
                  value={rtw.v.phasedTerms}
                  onChange={rtw.set('phasedTerms')}
                />
                <DateF
                  label="Phased return ends"
                  value={rtw.v.phasedUntil}
                  onChange={rtw.set('phasedUntil')}
                  noPast
                />
              </>
            )}
          </>
        }
      />
    </div>
  );
}

// ---- leavers ------------------------------------------------------------------------------------
const LEAVER_REASON: Record<string, string> = {
  RESIGNED: 'Resigned',
  RETIRED: 'Retired',
  END_OF_CONTRACT: 'End of contract',
  DISMISSED: 'Dismissed',
  REDUNDANCY: 'Redundancy',
  OTHER: 'Other',
};

export function Leavers() {
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('staff.lifecycle.transition');
  const q = useOne<{ data: Row[] }>('/api/v1/leavers');
  const staff = useStaffOptions(manage);
  const [starting, setStarting] = useState(false);
  const [moving, setMoving] = useState<Row | null>(null);
  const [cancelling, setCancelling] = useState<Row | null>(null);
  const [exitFor, setExitFor] = useState<Row | null>(null);
  const st = useForm({ staffId: '', lastDay: today(), reason: 'RESIGNED', reasonNote: '' });
  const ex = useForm({ exit: 'DONE' });
  const { run, msg } = useRun();
  const post = (path: string, body?: unknown) => api.send('POST', path, orgId, body ?? {});
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {msg}
      <Card
        title="Leavers"
        size="small"
        extra={
          manage && (
            <Button type="primary" onClick={() => setStarting(true)}>
              Start a leaver
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Leavers"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load leavers.' : null}
          emptyMessage="Nobody is leaving."
          columns={[
            {
              key: 'p',
              header: 'Person',
              cell: (r) => (
                <div>
                  <Typography.Text strong>{r.staffName}</Typography.Text>
                  <div>
                    <Mut>{r.code}</Mut>
                  </div>
                </div>
              ),
            },
            { key: 'l', header: 'Last day', cell: (r) => fmtDate(r.lastDay) },
            {
              key: 'w',
              header: 'Reason',
              cell: (r) =>
                `${LEAVER_REASON[r.reason] ?? r.reason}${r.reasonNote ? ` – ${r.reasonNote}` : ''}`,
            },
            {
              key: 'c',
              header: 'Leaving checklist',
              cell: (r) => (
                <div>
                  {(r.checklist as Row[]).map((c) => (
                    <div
                      key={c.item}
                      style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}
                    >
                      {c.done ? (
                        <StatusTag tone="green">{c.label}</StatusTag>
                      ) : manage && r.status === 'OPEN' ? (
                        c.item === 'ACCESS' ? (
                          <Button size="small" onClick={() => setMoving(r)}>
                            Move to leaver (ends access)
                          </Button>
                        ) : c.item === 'EXIT_INTERVIEW' ? (
                          <Button size="small" onClick={() => setExitFor(r)}>
                            ☐ {c.label}
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            onClick={() =>
                              void run(
                                () => post(`/api/v1/leavers/${r.id}/tick`, { item: c.item }),
                                `${c.label}: done`,
                              )
                            }
                          >
                            ☐ {c.label}
                          </Button>
                        )
                      ) : (
                        <StatusTag tone="grey">{c.label}</StatusTag>
                      )}
                      {c.doneText && c.item !== 'ACCESS' && <Mut>{c.doneText}</Mut>}
                    </div>
                  ))}
                </div>
              ),
            },
            {
              key: 's',
              header: 'State',
              cell: (r) =>
                r.status === 'COMPLETED' ? (
                  <StatusTag tone="grey">
                    Left – records kept until {fmtDate(r.keepUntil)}
                  </StatusTag>
                ) : r.status === 'CANCELLED' ? (
                  <StatusTag tone="grey">Cancelled</StatusTag>
                ) : (
                  <CountBar done={r.doneCount} total={(r.checklist as Row[]).length} />
                ),
            },
            {
              key: 'a',
              header: 'Actions',
              cell: (r) =>
                manage && r.status === 'OPEN' ? (
                  <Space wrap>
                    {r.doneCount === (r.checklist as Row[]).length && (
                      <Button
                        size="small"
                        type="primary"
                        onClick={() =>
                          void run(
                            () => post(`/api/v1/leavers/${r.id}/complete`),
                            'Leaving completed',
                          )
                        }
                      >
                        Complete leaving
                      </Button>
                    )}
                    {r.lifecycleState !== 'LEAVER' && (
                      <Button size="small" onClick={() => setCancelling(r)}>
                        Cancel
                      </Button>
                    )}
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <RuleNote>
        Moving someone to leaver ends their sign-in and phone access and flags their future shifts.
        Their name stays on everything they did. Records are kept for six years after the last day.
      </RuleNote>
      <ActionDialog
        open={starting}
        title="Start a leaver"
        confirmLabel="Start"
        confirmDisabled={!st.v.staffId || !st.v.lastDay}
        onCancel={() => {
          setStarting(false);
          st.reset();
        }}
        onConfirm={() =>
          post('/api/v1/leavers', {
            staffId: st.v.staffId,
            lastDay: st.v.lastDay,
            reason: st.v.reason,
            ...(st.v.reasonNote.trim() ? { reasonNote: st.v.reasonNote.trim() } : {}),
          })
        }
        fields={
          <>
            <SelectF
              label="Person"
              value={st.v.staffId}
              options={staff}
              onChange={st.set('staffId')}
            />
            <DateF label="Last working day" value={st.v.lastDay} onChange={st.set('lastDay')} />
            <SelectF
              label="Reason"
              value={st.v.reason}
              options={opts(LEAVER_REASON)}
              onChange={st.set('reason')}
            />
            <TextF
              label="Note (optional)"
              value={st.v.reasonNote}
              onChange={st.set('reasonNote')}
            />
          </>
        }
      />
      <ActionDialog
        open={moving !== null}
        title={`Move ${moving?.staffName ?? ''} to leaver`}
        confirmLabel="Move to leaver"
        danger
        reasonLabel="Reason (kept in their history)"
        onCancel={() => setMoving(null)}
        onConfirm={(reason) =>
          post(`/api/v1/staff/${moving!.staffId}/transition`, {
            to: 'LEAVER',
            reason,
            lastWorkingDay: moving!.lastDay,
          })
        }
      >
        <Typography.Paragraph>
          Access ends at the end of their last working day ({fmtDate(moving?.lastDay)}), or now if
          that day has passed. This cannot be undone.
        </Typography.Paragraph>
      </ActionDialog>
      <ActionDialog
        open={exitFor !== null}
        title="Exit interview"
        confirmLabel="Save"
        onCancel={() => setExitFor(null)}
        onConfirm={() =>
          post(`/api/v1/leavers/${exitFor!.id}/tick`, {
            item: 'EXIT_INTERVIEW',
            exitInterview: ex.v.exit,
          })
        }
        fields={
          <SelectF
            label="Exit interview"
            value={ex.v.exit}
            options={opts({ DONE: 'Held', DECLINED: 'Offered – the person declined' })}
            onChange={ex.set('exit')}
          />
        }
      />
      <ActionDialog
        open={cancelling !== null}
        title="Cancel this leaver checklist"
        confirmLabel="Cancel checklist"
        reasonLabel="Why (for example, they are staying)"
        onCancel={() => setCancelling(null)}
        onConfirm={(reason) => post(`/api/v1/leavers/${cancelling!.id}/cancel`, { reason })}
      />
    </div>
  );
}
