// v36 screens 43, 40 and 39: business continuity plans and tests, statement of purpose versions,
// and the Data Security and Protection Toolkit tracker. The API decides who may do what.
import { DataTable } from '@hub/ui';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';
import { ActionDialog, PersonSelect, fmtDate, fmtDateTime, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { CountBar, Mut, RuleNote, StatusTag, type Tone } from '../../v36/kit.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { AreaF, DateF, SelectF, TextF, opts, today, useForm, type Row } from './form.js';

// ---- business continuity ------------------------------------------------------------------------
const METHOD: Record<string, string> = {
  TABLETOP: 'Tabletop exercise',
  LIVE: 'Live test',
  REAL_EVENT: 'Real event',
};
const RESULT: Record<string, string> = {
  PASSED: 'Passed',
  PASSED_WITH_ISSUES: 'Passed with issues',
  ACTIONS_RAISED: 'Actions raised',
  FAILED: 'Failed',
};

export function BusinessContinuity() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('compliance.policy.manage');
  const canTest = manage || can('fleet.vehicle.manage') || can('jobs.allocate');
  const visible = can('compliance.audit.view') || manage || can('compliance.registration.manage');
  const q = useOne<{ data: Row[] }>(visible ? '/api/v1/continuity-plans' : null);
  const people = usePeople(canTest);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<Row | null>(null);
  const [retiring, setRetiring] = useState<Row | null>(null);
  const add = useForm({ title: '', steps: '', owner: me.user.id });
  const t = useForm({
    testedOn: today(),
    method: 'TABLETOP',
    result: 'PASSED',
    notes: '',
    followUp: '',
    owner: me.user.id,
    deadline: '',
  });
  const raises = t.v.result === 'ACTIONS_RAISED' || t.v.result === 'FAILED';
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  if (!visible) return null;
  const rows = q.data?.data ?? [];
  const log = rows
    .flatMap((p) => (p.tests as Row[]).map((x): Row => ({ ...x, plan: p.title as string })))
    .sort((a, b) => (a.testedOn < b.testedOn ? 1 : -1));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Card
        title="Business continuity plans"
        size="small"
        extra={
          manage && (
            <Button type="primary" onClick={() => setAdding(true)}>
              Add a plan
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Business continuity plans"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load continuity plans.' : null}
          emptyMessage="No continuity plans yet."
          columns={[
            {
              key: 'p',
              header: 'Plan',
              cell: (r) => (
                <div>
                  <Typography.Text strong>{r.title}</Typography.Text>
                  <div>
                    <Mut>{r.steps}</Mut>
                  </div>
                </div>
              ),
            },
            { key: 'o', header: 'Owner', cell: (r) => r.ownerName ?? '—' },
            {
              key: 'l',
              header: 'Last tested',
              cell: (r) => (r.lastTestedOn ? fmtDate(r.lastTestedOn) : 'Never'),
            },
            {
              key: 'r',
              header: 'Result',
              cell: (r) =>
                r.status === 'RETIRED' ? (
                  <StatusTag tone="grey">Retired</StatusTag>
                ) : r.testOverdue ? (
                  <StatusTag tone="red">Test overdue (yearly)</StatusTag>
                ) : (
                  <StatusTag tone={r.lastResult === 'PASSED' ? 'green' : 'amber'}>
                    {RESULT[r.lastResult] ?? r.lastResult} · next by {fmtDate(r.testDue)}
                  </StatusTag>
                ),
            },
            {
              key: 'a',
              header: 'Actions',
              cell: (r) =>
                r.status === 'ACTIVE' ? (
                  <Space wrap>
                    {canTest && (
                      <Button
                        size="small"
                        onClick={() => {
                          t.reset();
                          setTesting(r);
                        }}
                      >
                        Record test
                      </Button>
                    )}
                    {manage && (
                      <Button size="small" onClick={() => setRetiring(r)}>
                        Retire
                      </Button>
                    )}
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card title="Test log" size="small">
        <DataTable<Row>
          caption="Continuity test log"
          rows={log}
          rowKey={(r) => r.id}
          emptyMessage="No tests recorded."
          columns={[
            { key: 'd', header: 'Date', cell: (r) => fmtDate(r.testedOn) },
            { key: 'p', header: 'Plan', cell: (r) => r.plan },
            { key: 'h', header: 'How', cell: (r) => METHOD[r.method] ?? r.method },
            {
              key: 'r',
              header: 'Result',
              cell: (r) => (
                <div>
                  {`${RESULT[r.result] ?? r.result}${r.followUp ? ` – next: ${r.followUp}` : ''}`}
                  {r.actionCode && (
                    <div>
                      <Mut>
                        Action {r.actionCode} (
                        {String(r.actionStatus ?? '')
                          .toLowerCase()
                          .replace(/_/g, ' ')}
                        )
                      </Mut>
                    </div>
                  )}
                </div>
              ),
            },
            { key: 'b', header: 'By', cell: (r) => r.recordedByName ?? '—' },
          ]}
        />
      </Card>
      <ActionDialog
        open={adding}
        title="Add a continuity plan"
        confirmLabel="Add"
        confirmDisabled={add.v.title.trim().length < 3 || add.v.steps.trim().length < 10}
        onCancel={() => {
          setAdding(false);
          add.reset();
        }}
        onConfirm={() =>
          post('/api/v1/continuity-plans', {
            title: add.v.title.trim(),
            steps: add.v.steps.trim(),
            ownerUserId: add.v.owner,
          })
        }
        fields={
          <>
            <TextF label="What could happen" value={add.v.title} onChange={add.set('title')} />
            <AreaF label="What we do" value={add.v.steps} onChange={add.set('steps')} />
            <PersonSelect
              label="Owner"
              value={add.v.owner}
              onChange={add.set('owner')}
              people={people}
              meId={me.user.id}
            />
          </>
        }
      />
      <ActionDialog
        open={testing !== null}
        title={`Record test – ${testing?.title ?? ''}`}
        confirmLabel="Save"
        confirmDisabled={
          (t.v.result !== 'PASSED' && t.v.followUp.trim().length < 3) || (raises && !t.v.deadline)
        }
        onCancel={() => setTesting(null)}
        onConfirm={() =>
          post(`/api/v1/continuity-plans/${testing!.id}/tests`, {
            testedOn: t.v.testedOn,
            method: t.v.method,
            result: t.v.result,
            ...(t.v.notes.trim() ? { notes: t.v.notes.trim() } : {}),
            ...(t.v.followUp.trim() ? { followUp: t.v.followUp.trim() } : {}),
            ...(raises ? { actionOwnerUserId: t.v.owner, actionDeadline: t.v.deadline } : {}),
          })
        }
        fields={
          <>
            <DateF label="Tested on" value={t.v.testedOn} onChange={t.set('testedOn')} noFuture />
            <SelectF
              label="How"
              value={t.v.method}
              options={opts(METHOD)}
              onChange={t.set('method')}
            />
            <SelectF
              label="Result"
              value={t.v.result}
              options={opts(RESULT)}
              onChange={t.set('result')}
            />
            <AreaF label="Notes (optional)" value={t.v.notes} onChange={t.set('notes')} />
            {t.v.result !== 'PASSED' && (
              <AreaF label="What happens next" value={t.v.followUp} onChange={t.set('followUp')} />
            )}
            {raises && (
              <>
                <Mut>This raises a tracked action in Compliance › Actions.</Mut>
                <PersonSelect
                  label="Action owner"
                  value={t.v.owner}
                  onChange={t.set('owner')}
                  people={people}
                  meId={me.user.id}
                />
                <DateF
                  label="Action due by"
                  value={t.v.deadline}
                  onChange={t.set('deadline')}
                  noPast
                />
              </>
            )}
          </>
        }
      />
      <ActionDialog
        open={retiring !== null}
        title="Retire this plan"
        confirmLabel="Retire"
        reasonLabel="Why"
        onCancel={() => setRetiring(null)}
        onConfirm={(reason) => post(`/api/v1/continuity-plans/${retiring!.id}/retire`, { reason })}
      />
    </div>
  );
}

// ---- statement of purpose -----------------------------------------------------------------------
const SOP_STATUS: Record<string, { tone: Tone; text: string }> = {
  DRAFT: { tone: 'amber', text: 'Draft – awaiting a second person' },
  PUBLISHED: { tone: 'green', text: 'Published (current)' },
  SUPERSEDED: { tone: 'grey', text: 'Superseded' },
  WITHDRAWN: { tone: 'grey', text: 'Withdrawn' },
};

export function StatementOfPurpose() {
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('compliance.registration.manage');
  const q = useOne<{ data: Row[] }>('/api/v1/statement-of-purpose');
  const [drafting, setDrafting] = useState(false);
  const [publishing, setPublishing] = useState<Row | null>(null);
  const [withdrawing, setWithdrawing] = useState<Row | null>(null);
  const d = useForm({ summary: '' });
  const rows = q.data?.data ?? [];
  const draft = rows.find((r) => r.status === 'DRAFT');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <RuleNote>
        The statement of purpose is versioned. A new version is published by a second person, and
        publishing drafts the CQC notification (within 28 days).
      </RuleNote>
      <Card
        title="Statement of purpose"
        size="small"
        extra={
          manage &&
          !draft && (
            <Button type="primary" onClick={() => setDrafting(true)}>
              New version
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Statement of purpose versions"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load the statement of purpose.' : null}
          emptyMessage="No versions recorded yet."
          columns={[
            { key: 'v', header: 'Version', cell: (r) => `v${r.versionNo}` },
            { key: 's', header: 'What changed', cell: (r) => r.summary },
            {
              key: 'd',
              header: 'Drafted',
              cell: (r) => `${r.draftedByName ?? '—'} · ${fmtDate(r.draftedAt)}`,
            },
            {
              key: 'p',
              header: 'Published',
              cell: (r) => (
                <div>
                  <StatusTag tone={SOP_STATUS[r.status]?.tone ?? 'grey'}>
                    {SOP_STATUS[r.status]?.text ?? r.status}
                  </StatusTag>
                  {r.publishedByName && (
                    <div>
                      <Mut>
                        by {r.publishedByName} · {fmtDateTime(r.publishedAt)}
                      </Mut>
                    </div>
                  )}
                </div>
              ),
            },
            { key: 'n', header: 'CQC notified', cell: (r) => r.notificationCode ?? '—' },
            {
              key: 'a',
              header: 'Actions',
              cell: (r) =>
                manage && r.status === 'DRAFT' ? (
                  <Space wrap>
                    {r.draftedByMe ? (
                      <Mut>Someone else publishes your draft</Mut>
                    ) : (
                      <Button size="small" type="primary" onClick={() => setPublishing(r)}>
                        Publish v{r.versionNo}
                      </Button>
                    )}
                    <Button size="small" onClick={() => setWithdrawing(r)}>
                      Withdraw
                    </Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <ActionDialog
        open={drafting}
        title="New statement of purpose"
        confirmLabel="Save draft"
        confirmDisabled={d.v.summary.trim().length < 3}
        onCancel={() => {
          setDrafting(false);
          d.reset();
        }}
        onConfirm={() =>
          api.send('POST', '/api/v1/statement-of-purpose', orgId, { summary: d.v.summary.trim() })
        }
        fields={<AreaF label="What changed" value={d.v.summary} onChange={d.set('summary')} />}
      />
      <ActionDialog
        open={publishing !== null}
        title={`Publish v${publishing?.versionNo ?? ''}`}
        confirmLabel="Publish and draft the CQC notification"
        onCancel={() => setPublishing(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/statement-of-purpose/${publishing!.id}/publish`, orgId, {})
        }
      >
        <Typography.Paragraph>
          The current version becomes history and a CQC notification is drafted for someone to check
          and submit.
        </Typography.Paragraph>
      </ActionDialog>
      <ActionDialog
        open={withdrawing !== null}
        title="Withdraw this draft"
        confirmLabel="Withdraw"
        onCancel={() => setWithdrawing(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/statement-of-purpose/${withdrawing!.id}/withdraw`, orgId, {})
        }
      />
    </div>
  );
}

// ---- DSP Toolkit --------------------------------------------------------------------------------
const OUTCOME: Record<string, string> = {
  STANDARDS_EXCEEDED: 'Standards exceeded',
  STANDARDS_MET: 'Standards met',
  APPROACHING_STANDARDS: 'Approaching standards',
  STANDARDS_NOT_MET: 'Standards not met',
};
const nextYear = () => {
  const d = new Date();
  const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { year: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, dueOn: `${y + 1}-06-30` };
};

export function DsptToolkit() {
  const { api, orgId } = useApp();
  const can = useCan();
  const manage = can('privacy.manage');
  const q = useOne<{ data: Row[] }>('/api/v1/dspt');
  const [starting, setStarting] = useState(false);
  const [marking, setMarking] = useState<Row | null>(null);
  const [submitting, setSubmitting] = useState<Row | null>(null);
  const st = useForm(nextYear());
  const mk = useForm({ note: '' });
  const sb = useForm({ submittedOn: today(), outcome: 'STANDARDS_MET', reference: '' });
  const rows = q.data?.data ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {manage && (
        <Space>
          <Button type="primary" onClick={() => setStarting(true)}>
            Start a toolkit year
          </Button>
        </Space>
      )}
      {q.isError && <Alert type="error" showIcon message="Could not load the toolkit." />}
      {!q.isLoading && rows.length === 0 && <Mut>No toolkit year tracked yet.</Mut>}
      {rows.map((a) => (
        <Card
          key={a.id}
          size="small"
          title={`Data Security and Protection Toolkit ${a.year}`}
          extra={
            a.status === 'SUBMITTED' ? (
              <StatusTag tone={a.outcome === 'STANDARDS_NOT_MET' ? 'red' : 'green'}>
                Submitted {fmtDate(a.submittedOn)}: {OUTCOME[a.outcome] ?? a.outcome}
              </StatusTag>
            ) : (
              <Space>
                <Mut>Due {fmtDate(a.dueOn)}</Mut>
                {manage && (
                  <Button size="small" onClick={() => setSubmitting(a)}>
                    Record submission
                  </Button>
                )}
              </Space>
            )
          }
        >
          <CountBar done={a.inPlace} total={a.total} />
          <DataTable<Row>
            caption={`Toolkit ${a.year} evidence items`}
            rows={a.items as Row[]}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 't',
                header: 'Evidence item',
                cell: (r) => (
                  <div>
                    {r.title}
                    {r.hint && (
                      <div>
                        <Mut>{r.hint}</Mut>
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 's',
                header: 'Status',
                cell: (r) =>
                  r.status === 'IN_PLACE' ? (
                    <div>
                      <StatusTag tone="green">Evidence in place</StatusTag>
                      <div>
                        <Mut>
                          {r.evidenceNote} · {r.markedByName}
                        </Mut>
                      </div>
                    </div>
                  ) : (
                    <StatusTag tone="amber">Not yet</StatusTag>
                  ),
              },
              {
                key: 'a',
                header: 'Actions',
                cell: (r) =>
                  manage && a.status !== 'SUBMITTED' && r.status !== 'IN_PLACE' ? (
                    <Button
                      size="small"
                      onClick={() => {
                        mk.reset();
                        setMarking(r);
                      }}
                    >
                      Mark in place
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      ))}
      <ActionDialog
        open={starting}
        title="Start a toolkit year"
        confirmLabel="Start"
        onCancel={() => setStarting(false)}
        onConfirm={() => api.send('POST', '/api/v1/dspt', orgId, st.v)}
        fields={
          <>
            <TextF
              label="Toolkit year (e.g. 2026-27)"
              value={st.v.year}
              onChange={st.set('year')}
            />
            <DateF label="Submission due" value={st.v.dueOn} onChange={st.set('dueOn')} />
          </>
        }
      />
      <ActionDialog
        open={marking !== null}
        title={marking?.title ?? ''}
        confirmLabel="Mark in place"
        confirmDisabled={mk.v.note.trim().length < 3}
        onCancel={() => setMarking(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/dspt/items/${marking!.id}/in-place`, orgId, {
            evidenceNote: mk.v.note.trim(),
          })
        }
        fields={<AreaF label="Where the evidence is" value={mk.v.note} onChange={mk.set('note')} />}
      />
      <ActionDialog
        open={submitting !== null}
        title={`Record submission – ${submitting?.year ?? ''}`}
        confirmLabel="Save"
        onCancel={() => setSubmitting(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/dspt/${submitting!.id}/submit`, orgId, {
            submittedOn: sb.v.submittedOn,
            outcome: sb.v.outcome,
            ...(sb.v.reference.trim() ? { reference: sb.v.reference.trim() } : {}),
          })
        }
        fields={
          <>
            <DateF
              label="Submitted on"
              value={sb.v.submittedOn}
              onChange={sb.set('submittedOn')}
              noFuture
            />
            <SelectF
              label="Outcome"
              value={sb.v.outcome}
              options={opts(OUTCOME)}
              onChange={sb.set('outcome')}
            />
            <TextF
              label="Reference (optional)"
              value={sb.v.reference}
              onChange={sb.set('reference')}
            />
          </>
        }
      />
    </div>
  );
}
