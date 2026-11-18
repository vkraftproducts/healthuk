// v36 screen 37: safeguarding referrals register. Restricted to people who may see safeguarding
// cases; the API and the database enforce that, hiding here is cosmetic.
import { DataTable } from '@hub/ui';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { useState } from 'react';
import { ActionDialog, PersonSelect, fmtDate, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { Kpis, Mut, RuleNote, StatusTag, type Tone } from '../../v36/kit.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { AreaF, CheckF, DateF, SelectF, TextF, opts, today, useForm, type Row } from './form.js';

export const SG_CATEGORY: Record<string, string> = {
  PHYSICAL: 'Physical abuse',
  NEGLECT: 'Neglect',
  SELF_NEGLECT: 'Self-neglect',
  FINANCIAL: 'Financial or material abuse',
  PSYCHOLOGICAL: 'Psychological abuse',
  SEXUAL: 'Sexual abuse',
  DOMESTIC: 'Domestic abuse',
  MODERN_SLAVERY: 'Modern slavery',
  DISCRIMINATORY: 'Discriminatory abuse',
  ORGANISATIONAL: 'Organisational abuse',
  OTHER: 'Other',
};
const STATUS: Record<string, { tone: Tone; text: string }> = {
  RAISED: { tone: 'red', text: 'Raised – referral decision needed' },
  REFERRED: { tone: 'blue', text: 'Referred – awaiting outcome' },
  NOT_REFERRED: { tone: 'amber', text: 'Not referred – outcome to record' },
  CLOSED: { tone: 'green', text: 'Closed' },
};

export function SafeguardingRegister() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('events.event.manage') && can('events.safeguarding.view');
  const q = useOne<{ data: Row[]; summary: { open: number; undecided: number } }>(
    '/api/v1/safeguarding-referrals',
  );
  const people = usePeople();
  const [adding, setAdding] = useState(false);
  const [refer, setRefer] = useState<Row | null>(null);
  const [noRefer, setNoRefer] = useState<Row | null>(null);
  const [outcome, setOutcome] = useState<Row | null>(null);
  const add = useForm({
    about: 'ADULT',
    category: 'NEGLECT',
    patientRef: '',
    details: '',
    raisedBy: me.user.id,
    raisedOn: today(),
    abuse: false,
  });
  const ref = useForm({ referredOn: today(), agency: '', agencyReference: '' });
  const out = useForm({ outcome: '', outcomeOn: today() });
  const post = (path: string, body: unknown) => api.send('POST', path, orgId, body);
  const [only, setOnly] = useState<'' | 'open' | 'undecided'>('');
  if (!can('events.safeguarding.view'))
    return <Alert type="error" showIcon message="Safeguarding referrals are restricted." />;
  const all = q.data?.data ?? [];
  const pick = (k: 'open' | 'undecided') => setOnly((cur) => (cur === k ? '' : k));
  const rows =
    only === 'open'
      ? all.filter((r) => r.status !== 'CLOSED')
      : only === 'undecided'
        ? all.filter((r) => r.status === 'RAISED')
        : all;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      <Kpis
        items={[
          {
            title: 'Open referrals',
            value: q.data ? q.data.summary.open : '—',
            foot: 'waiting for a decision or an outcome',
            tone: 'blue',
            onClick: () => pick('open'),
            pressed: only === 'open',
          },
          {
            title: 'Not yet decided',
            value: q.data ? q.data.summary.undecided : '—',
            foot: 'decide today whether to refer',
            tone: (q.data?.summary.undecided ?? 0) > 0 ? 'red' : 'green',
            onClick: () => pick('undecided'),
            pressed: only === 'undecided',
          },
        ]}
      />
      <Card
        title="Safeguarding referrals"
        size="small"
        extra={
          manage && (
            <Button type="primary" onClick={() => setAdding(true)}>
              Record a concern
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Safeguarding referrals"
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load safeguarding referrals.' : null}
          emptyMessage="No safeguarding concerns recorded."
          columns={[
            {
              key: 'c',
              header: 'Concern',
              cell: (r) => (
                <div>
                  <Typography.Text strong>
                    {r.code} · {r.about === 'CHILD' ? 'Child' : 'Adult'} –{' '}
                    {SG_CATEGORY[r.category] ?? r.category}
                  </Typography.Text>
                  <div>
                    <Mut>
                      {r.patientRef} · raised by {r.raisedByName ?? 'unknown'}
                      {r.eventCode ? ` · incident ${r.eventCode}` : ''}
                    </Mut>
                  </div>
                </div>
              ),
            },
            { key: 'r', header: 'Raised', cell: (r) => fmtDate(r.raisedOn) },
            {
              key: 'to',
              header: 'Referred to',
              cell: (r) =>
                r.agency ? (
                  <span>
                    {r.agency}
                    <div>
                      <Mut>
                        {r.agencyReference} · {fmtDate(r.referredOn)}
                      </Mut>
                    </div>
                  </span>
                ) : r.status === 'NOT_REFERRED' ? (
                  <span>
                    Not referred
                    <div>
                      <Mut>{r.decisionReason}</Mut>
                    </div>
                  </span>
                ) : (
                  <StatusTag tone="red">Not referred yet</StatusTag>
                ),
            },
            {
              key: 's',
              header: 'State',
              cell: (r) => (
                <div>
                  <StatusTag tone={STATUS[r.status]?.tone ?? 'grey'}>
                    {STATUS[r.status]?.text ?? r.status}
                  </StatusTag>
                  {r.outcome && (
                    <div>
                      <Mut>Outcome: {r.outcome}</Mut>
                    </div>
                  )}
                  {r.cqcNotificationCode && (
                    <div>
                      <Mut>CQC notification {r.cqcNotificationCode}</Mut>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'a',
              header: 'Actions',
              cell: (r) =>
                manage ? (
                  <Space wrap>
                    {r.status === 'RAISED' && (
                      <>
                        <Button size="small" type="primary" onClick={() => setRefer(r)}>
                          Refer
                        </Button>
                        {!r.abuseAllegation && (
                          <Button size="small" onClick={() => setNoRefer(r)}>
                            Decide not to refer
                          </Button>
                        )}
                      </>
                    )}
                    {(r.status === 'REFERRED' || r.status === 'NOT_REFERRED') && (
                      <Button size="small" onClick={() => setOutcome(r)}>
                        Record outcome
                      </Button>
                    )}
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <RuleNote>
        Use a patient, job or booking reference, never a name. An allegation of abuse is always
        referred to the local authority and drafts a CQC notification (Regulation 18) for someone to
        check and submit.
      </RuleNote>

      <ActionDialog
        open={adding}
        title="Record a safeguarding concern"
        confirmLabel="Record"
        confirmDisabled={add.v.patientRef.trim().length < 2 || add.v.details.trim().length < 10}
        onCancel={() => {
          setAdding(false);
          add.reset();
        }}
        onConfirm={() =>
          post('/api/v1/safeguarding-referrals', {
            about: add.v.about,
            category: add.v.category,
            patientRef: add.v.patientRef.trim(),
            details: add.v.details.trim(),
            raisedByUserId: add.v.raisedBy,
            raisedOn: add.v.raisedOn,
            abuseAllegation: add.v.abuse,
          })
        }
        fields={
          <>
            <SelectF
              label="About"
              value={add.v.about}
              options={opts({ ADULT: 'Adult', CHILD: 'Child' })}
              onChange={add.set('about')}
            />
            <SelectF
              label="Category"
              value={add.v.category}
              options={opts(SG_CATEGORY)}
              onChange={add.set('category')}
            />
            <TextF
              label="Patient reference (not a name)"
              value={add.v.patientRef}
              onChange={add.set('patientRef')}
            />
            <AreaF
              label="What was seen or said (at least 10 characters)"
              value={add.v.details}
              onChange={add.set('details')}
            />
            <PersonSelect
              label="Raised by"
              value={add.v.raisedBy}
              onChange={add.set('raisedBy')}
              people={people}
              meId={me.user.id}
            />
            <DateF
              label="Raised on"
              value={add.v.raisedOn}
              onChange={add.set('raisedOn')}
              noFuture
            />
            <CheckF
              label="This is an allegation of abuse (CQC must be notified)"
              checked={add.v.abuse}
              onChange={add.set('abuse')}
            />
          </>
        }
      />
      <ActionDialog
        open={refer !== null}
        title={`Refer ${refer?.code ?? ''}`}
        confirmLabel="Save referral"
        confirmDisabled={ref.v.agency.trim().length < 3 || ref.v.agencyReference.trim().length < 2}
        onCancel={() => {
          setRefer(null);
          ref.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/safeguarding-referrals/${refer!.id}/refer`, {
            referredOn: ref.v.referredOn,
            agency: ref.v.agency.trim(),
            agencyReference: ref.v.agencyReference.trim(),
          })
        }
        fields={
          <>
            <TextF label="Local authority team" value={ref.v.agency} onChange={ref.set('agency')} />
            <TextF
              label="Their reference"
              value={ref.v.agencyReference}
              onChange={ref.set('agencyReference')}
            />
            <DateF
              label="Referred on"
              value={ref.v.referredOn}
              onChange={ref.set('referredOn')}
              noFuture
            />
          </>
        }
      />
      <ActionDialog
        open={noRefer !== null}
        title={`Decide not to refer ${noRefer?.code ?? ''}`}
        confirmLabel="Record decision"
        reasonLabel="Why this does not need a referral (at least 10 characters)"
        onCancel={() => setNoRefer(null)}
        onConfirm={(reason) =>
          post(`/api/v1/safeguarding-referrals/${noRefer!.id}/not-referred`, { reason })
        }
      />
      <ActionDialog
        open={outcome !== null}
        title={`Outcome – ${outcome?.code ?? ''}`}
        confirmLabel="Close"
        confirmDisabled={out.v.outcome.trim().length < 3}
        onCancel={() => {
          setOutcome(null);
          out.reset();
        }}
        onConfirm={() =>
          post(`/api/v1/safeguarding-referrals/${outcome!.id}/outcome`, {
            outcome: out.v.outcome.trim(),
            outcomeOn: out.v.outcomeOn,
          })
        }
        fields={
          <>
            <AreaF label="Outcome" value={out.v.outcome} onChange={out.set('outcome')} />
            <DateF
              label="Outcome received on"
              value={out.v.outcomeOn}
              onChange={out.set('outcomeOn')}
              noFuture
            />
          </>
        }
      />
    </div>
  );
}
