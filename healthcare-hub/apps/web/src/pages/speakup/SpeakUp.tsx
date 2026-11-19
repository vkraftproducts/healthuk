import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Select,
  Space,
  Typography,
} from 'antd';
import { londonDate } from '@hub/rules';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  Tabs,
  fmtDate,
  fmtDateTime,
  useCan,
  useRun,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';
import { Deeper } from '../../v36/ui.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const CATEGORY: Record<string, string> = {
  SEXUAL_HARASSMENT: 'Sexual harassment',
  HARASSMENT: 'Other harassment',
  BULLYING: 'Bullying',
  DISCRIMINATION: 'Discrimination',
  PATIENT_SAFETY: 'Patient safety',
  WORKER_SAFETY: 'Staff safety',
  FRAUD: 'Fraud or dishonesty',
  OTHER: 'Something else',
};
const CHANNEL: Record<string, string> = {
  IN_APP: 'In the hub',
  IN_PERSON: 'In person',
  PHONE: 'Phone',
  EMAIL: 'Email',
  LETTER: 'Letter',
};
const OUTCOME: Record<string, string> = {
  UPHELD: 'Upheld',
  PARTLY_UPHELD: 'Partly upheld',
  NOT_UPHELD: 'Not upheld',
  NO_FURTHER_ACTION: 'No further action',
  REFERRED_ELSEWHERE: 'Referred elsewhere',
};
const NOTE_KIND: Record<string, string> = {
  NOTE: 'Note',
  FEEDBACK: 'Feedback given to the person',
  DETRIMENT_CHECK: 'Detriment check',
  STATUS: 'Status',
};

export function concernStatus(c: Row): { status: StatusKind; reason: string } {
  if (c.status === 'RECEIVED')
    return c.acknowledgeOverdue
      ? { status: 'RED', reason: `Acknowledgement overdue (was due ${fmtDate(c.acknowledgeDue)})` }
      : { status: 'AMBER', reason: `Waiting to be acknowledged by ${fmtDate(c.acknowledgeDue)}` };
  if (c.status === 'ACKNOWLEDGED') return { status: 'AMBER', reason: 'Acknowledged' };
  if (c.status === 'INVESTIGATING') return { status: 'AMBER', reason: 'Being looked into' };
  if (c.detrimentCheckOverdue)
    return { status: 'AMBER', reason: 'Closed; detriment check overdue' };
  return { status: 'GREEN', reason: 'Closed' };
}

/** Task 20: speaking up, and the steps taken to prevent sexual harassment. */
export function SpeakUp() {
  const can = useCan();
  // v36: Raise & track · Guardian queue · Insight.
  const tabs = [
    { id: 'raise', label: 'Raise & track', show: can('speakup.raise') },
    { id: 'concerns', label: 'Guardian queue', show: can('speakup.manage') },
    {
      id: 'insight',
      label: 'Insight',
      show: can('speakup.manage') || can('reports.view') || can('harassment.manage'),
    },
  ];
  const first = tabs.find((t) => t.show)?.id ?? 'raise';
  const [tab, setTab] = useState(first);
  return (
    <Deeper>
      <Tabs label="Speak up sections" tabs={tabs} current={tab} onChange={setTab}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {tab === 'raise' && (
            <>
              <Raise />
              <Mine />
            </>
          )}
          {tab === 'concerns' && <Concerns />}
          {tab === 'insight' && (
            <>
              {(can('speakup.manage') || can('reports.view')) && <Themes />}
              {can('harassment.manage') && <Prevention />}
            </>
          )}
        </Space>
      </Tabs>
    </Deeper>
  );
}

// ---- raising ------------------------------------------------------------------------------------
function Raise() {
  const { api, orgId } = useApp();
  const [category, setCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [thirdParty, setThirdParty] = useState(false);
  const [receipt, setReceipt] = useState<Row | null>(null);
  const { run, msg } = useRun();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const out: { receipt?: Row } = {};
    const ok = await run(async () => {
      out.receipt = (await api.send('POST', '/api/v1/speak-up', orgId, {
        category,
        summary: summary.trim(),
        anonymous,
        thirdParty,
      })) as Row;
    }, 'Your concern has been received.');
    if (ok && out.receipt) {
      setReceipt(out.receipt);
      setSummary('');
      setCategory('');
    }
  }
  return (
    <Section title="Raise a concern">
      <Typography.Paragraph type="secondary">
        You can speak up about anything that worries you at work, including harassment by a
        colleague, a patient or a visitor. Please do not include patient names or details.
      </Typography.Paragraph>
      <form aria-label="Raise a concern" onSubmit={(e) => void submit(e)}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Field label="What is it about?">
            <Select
              placeholder="Choose"
              value={category || undefined}
              onChange={setCategory}
              options={Object.entries(CATEGORY).map(([k, v]) => ({ value: k, label: v }))}
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="What happened, and what worries you?">
            <Input.TextArea
              rows={5}
              value={summary}
              required
              minLength={10}
              maxLength={4000}
              onChange={(e) => setSummary(e.target.value)}
            />
          </Field>
          <Checkbox checked={thirdParty} onChange={(e) => setThirdParty(e.target.checked)}>
            It is about a patient, visitor or contractor
          </Checkbox>
          <Checkbox checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)}>
            Raise it anonymously
          </Checkbox>
          {anonymous && (
            <Alert
              type="info"
              showIcon
              role="note"
              message="Your name is not stored with an anonymous concern, so nobody can see who raised it. It will not appear under My concerns. You will get a progress code instead: keep it to check progress and read any feedback below."
            />
          )}
          <Button
            type="primary"
            htmlType="submit"
            disabled={!category || summary.trim().length < 10}
          >
            Send concern
          </Button>
        </Space>
      </form>
      {msg}
      {receipt && (
        <Alert
          type="success"
          showIcon
          role="status"
          message={
            <>
              Your reference is {receipt.code}. It should be acknowledged by{' '}
              {fmtDate(receipt.acknowledgeDue)}.
              {receipt.progressCode && (
                <>
                  {' '}
                  Your progress code is{' '}
                  <Typography.Text strong>{receipt.progressCode}</Typography.Text>. Write it down
                  now: it will not be shown again and nobody else can look it up.
                </>
              )}
            </>
          }
        />
      )}
      <Guardian />
      <CheckProgress />
    </Section>
  );
}

/** H6: who people can talk to. */
function Guardian() {
  const res = useOne<{ guardianName: string | null }>('/api/v1/speak-up/guardian');
  if (!res.data) return null;
  return (
    <p className="text-sm">
      {res.data.guardianName
        ? `Your Freedom to Speak Up guardian is ${res.data.guardianName}. ` +
          'You can talk to them in confidence.'
        : 'No Freedom to Speak Up guardian has been named yet. ' +
          'You can still raise a concern here.'}
    </p>
  );
}

/** H6: an anonymous raiser checks progress with their code. */
function CheckProgress() {
  const { api, orgId } = useApp();
  const [code, setCode] = useState('');
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const STAGE: Record<string, string> = {
    RECEIVED: 'Received, waiting to be acknowledged',
    ACKNOWLEDGED: 'Acknowledged',
    INVESTIGATING: 'Being looked into',
    CLOSED: 'Closed',
  };
  async function check(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    try {
      const q = new URLSearchParams({ code: code.trim().toUpperCase() }).toString();
      setResult((await api.get(`/api/v1/speak-up/progress?${q}`, orgId)) as Row);
    } catch {
      setError('No concern matches that code. Check it and try again.');
    }
  }
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3"
      aria-label="Check progress with your code"
      onSubmit={(e) => void check(e)}
    >
      <Field label="Progress code (for anonymous concerns)">
        <input
          value={code}
          placeholder="ABCD-EFGH-JKLM"
          maxLength={14}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="primary" htmlType="submit" disabled={code.trim().length < 14}>
        Check progress
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-900">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="w-full text-sm">
          <StatusBadge
            status={result.status === 'CLOSED' ? 'GREEN' : 'AMBER'}
            reason={`${STAGE[result.status] ?? 'Received'} (updated ${fmtDate(result.updatedOn)})`}
          />
          <p className="mt-1">
            {result.feedback ? `Feedback: ${result.feedback}` : 'No feedback has been written yet.'}
          </p>
        </div>
      )}
    </form>
  );
}

function Mine() {
  const res = useOne<{ data: Row[] }>('/api/v1/speak-up/mine');
  return (
    <Section title="My concerns">
      <DataTable<Row>
        caption="My concerns"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.code}
        loading={res.isLoading}
        error={res.isError ? 'Could not load your concerns.' : null}
        emptyMessage="You have not raised a named concern. Anonymous concerns are not listed here."
        columns={[
          { key: 'c', header: 'Reference', cell: (r) => r.code },
          { key: 'k', header: 'About', cell: (r) => CATEGORY[r.category] ?? 'Something else' },
          { key: 'r', header: 'Raised', cell: (r) => fmtDate(r.raisedOn) },
          {
            key: 's',
            header: 'Progress',
            cell: (r) => (
              <StatusBadge
                status={r.status === 'CLOSED' ? 'GREEN' : 'AMBER'}
                reason={
                  r.status === 'CLOSED'
                    ? `Closed ${fmtDate(r.closedOn)}`
                    : r.acknowledgedOn
                      ? `Acknowledged ${fmtDate(r.acknowledgedOn)}`
                      : 'Waiting to be acknowledged'
                }
              />
            ),
          },
          {
            key: 'f',
            header: 'Feedback given',
            cell: (r) => (r.feedbackGivenOn ? fmtDate(r.feedbackGivenOn) : 'Not yet'),
          },
        ]}
      />
    </Section>
  );
}

// ---- handling -----------------------------------------------------------------------------------
function Concerns() {
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const res = useOne<{ data: Row[] }>(`/api/v1/speak-up${status ? `?status=${status}` : ''}`);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Section title="Concerns">
        <Field label="Show">
          <Select
            allowClear
            placeholder="All concerns"
            value={status || undefined}
            onChange={(v) => setStatus(v ?? '')}
            style={{ width: 224 }}
            options={[
              { value: 'RECEIVED', label: 'Waiting to be acknowledged' },
              { value: 'ACKNOWLEDGED', label: 'Acknowledged' },
              { value: 'INVESTIGATING', label: 'Being looked into' },
              { value: 'CLOSED', label: 'Closed' },
            ]}
          />
        </Field>
        <DataTable<Row>
          caption="Speak-up concerns"
          rows={res.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={res.isLoading}
          error={res.isError ? 'Could not load concerns.' : null}
          emptyMessage="No concerns."
          columns={[
            { key: 'c', header: 'Reference', cell: (r) => r.code },
            { key: 'k', header: 'About', cell: (r) => CATEGORY[r.category] ?? 'Something else' },
            { key: 'd', header: 'Raised', cell: (r) => fmtDate(r.raisedOn) },
            {
              key: 'w',
              header: 'Raised by',
              cell: (r) => (r.anonymous ? 'Anonymous' : (r.raisedByName ?? 'Unknown')),
            },
            {
              key: 's',
              header: 'Status',
              cell: (r) => <StatusBadge {...concernStatus(r)} />,
            },
            { key: 'h', header: 'Handled by', cell: (r) => r.handlerName ?? 'Nobody yet' },
            {
              key: 'a',
              header: 'Open',
              cell: (r) => (
                <Button
                  size="small"
                  aria-label={`Open concern ${r.code}`}
                  onClick={() => setOpenId(openId === r.id ? null : r.id)}
                >
                  {openId === r.id ? 'Hide' : 'Open'}
                </Button>
              ),
            },
          ]}
        />
      </Section>
      {openId && <ConcernDetail id={openId} />}
      <RecordConcern />
    </Space>
  );
}

function ConcernDetail({ id }: { id: string }) {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const res = useOne<Row>(`/api/v1/speak-up/${id}`);
  const [dialog, setDialog] = useState<null | 'ack' | 'start' | 'note' | 'close' | 'feedback'>(
    null,
  );
  const today = londonDate(new Date());
  const [on, setOn] = useState(today);
  const [handler, setHandler] = useState(me.user.id);
  const [kind, setKind] = useState('NOTE');
  const [detriment, setDetriment] = useState('');
  const [outcome, setOutcome] = useState('');
  const [lessons, setLessons] = useState('');
  const c = res.data;
  if (res.isLoading) return <p role="status">Loading…</p>;
  if (!c || !c.id) return <p role="alert">This concern is not available.</p>;
  const path = `/api/v1/speak-up/${id}`;
  const open = (d: typeof dialog) => {
    setOn(today);
    setDialog(d);
  };
  return (
    <Section title={`Concern ${c.code}`}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-semibold">About</dt>
        <dd>
          {CATEGORY[c.category]}
          {c.thirdParty ? ' (a patient, visitor or contractor)' : ''}
        </dd>
        <dt className="font-semibold">Received</dt>
        <dd>
          {fmtDate(c.raisedOn)} – {CHANNEL[c.channel]}
        </dd>
        <dt className="font-semibold">Raised by</dt>
        <dd>{c.anonymous ? 'Anonymous' : c.raisedByName}</dd>
        <dt className="font-semibold">Status</dt>
        <dd>
          <StatusBadge {...concernStatus(c)} />
        </dd>
        {c.outcome && (
          <>
            <dt className="font-semibold">Outcome</dt>
            <dd>
              {OUTCOME[c.outcome]}: {c.outcomeText}
            </dd>
          </>
        )}
        {c.detrimentCheckDue && (
          <>
            <dt className="font-semibold">Detriment check</dt>
            <dd>
              {c.detrimentCheckedOn
                ? `Checked ${fmtDate(c.detrimentCheckedOn)}`
                : `Due by ${fmtDate(c.detrimentCheckDue)}`}
            </dd>
          </>
        )}
      </dl>
      <p className="whitespace-pre-wrap rounded  p-2 text-sm">{c.summary}</p>
      <div className="flex flex-wrap gap-2">
        {c.status === 'RECEIVED' && (
          <Button size="small" onClick={() => open('ack')}>
            Acknowledge
          </Button>
        )}
        {c.status === 'ACKNOWLEDGED' && (
          <Button size="small" onClick={() => open('start')}>
            Start looking into it
          </Button>
        )}
        <Button size="small" onClick={() => open('note')}>
          Add a note
        </Button>
        {c.anonymous && (
          <Button size="small" onClick={() => open('feedback')}>
            Write feedback for the raiser
          </Button>
        )}
        {(c.status === 'ACKNOWLEDGED' || c.status === 'INVESTIGATING') && (
          <Button size="small" onClick={() => open('close')}>
            Close
          </Button>
        )}
      </div>
      {!c.anonymous && !c.feedbackGivenOn && c.status !== 'RECEIVED' && (
        <p role="note" className="text-sm">
          Record the feedback given to the person who spoke up before closing.
        </p>
      )}
      <ol aria-label="History" className="space-y-1 text-sm">
        {((c.notes ?? []) as Row[]).map((n) => (
          <li key={n.id} className="">
            <span className="font-semibold">{NOTE_KIND[n.kind]}</span> – {fmtDate(n.on)}
            {n.detrimentReported !== null &&
              (n.detrimentReported ? ' (detriment reported)' : ' (no detriment reported)')}
            : {n.note}
            <span className="block text-xs text-slate-600">
              {n.createdByName ?? 'Unknown'}, {fmtDateTime(n.createdAt)}
            </span>
          </li>
        ))}
      </ol>

      <ActionDialog
        open={dialog === 'ack'}
        title={`Acknowledge ${c.code}`}
        confirmLabel="Acknowledge"
        onCancel={() => setDialog(null)}
        fields={
          <>
            <Field label="Acknowledged on">
              <input
                type="date"

                value={on}
                max={today}
                onChange={(e) => setOn(e.target.value)}
              />
            </Field>
            <PersonSelect
              label="Who handles it"
              value={handler}
              onChange={setHandler}
              people={people}
              meId={me.user.id}
            />
          </>
        }
        onConfirm={() =>
          api.send('POST', `${path}/acknowledge`, orgId, {
            acknowledgedOn: on,
            handlerUserId: handler,
          })
        }
      />
      <ActionDialog
        open={dialog === 'start'}
        title={`Start looking into ${c.code}`}
        confirmLabel="Start"
        reasonLabel="What will be done first"
        onCancel={() => setDialog(null)}
        onConfirm={(note) => api.send('POST', `${path}/start`, orgId, { note })}
      />
      <ActionDialog
        open={dialog === 'note'}
        title={`Add to ${c.code}`}
        confirmLabel="Add"
        reasonLabel="Note"
        confirmDisabled={kind === 'DETRIMENT_CHECK' && !detriment}
        onCancel={() => setDialog(null)}
        fields={
          <>
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="NOTE">Note</option>
                {!c.anonymous && <option value="FEEDBACK">Feedback given to the person</option>}
                {!c.anonymous && c.status === 'CLOSED' && (
                  <option value="DETRIMENT_CHECK">Detriment check</option>
                )}
              </select>
            </Field>
            <Field label="Date">
              <input
                type="date"

                value={on}
                max={today}
                onChange={(e) => setOn(e.target.value)}
              />
            </Field>
            {kind === 'DETRIMENT_CHECK' && (
              <Field label="Did the person report any detriment?">
                <select value={detriment} onChange={(e) => setDetriment(e.target.value)}>
                  <option value="">Choose</option>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </Field>
            )}
          </>
        }
        onConfirm={(note) =>
          api.send('POST', `${path}/notes`, orgId, {
            kind,
            note,
            on,
            ...(kind === 'DETRIMENT_CHECK' ? { detrimentReported: detriment === 'yes' } : {}),
          })
        }
      />
      <ActionDialog
        open={dialog === 'feedback'}
        title={`Feedback for the raiser of ${c.code}`}
        confirmLabel="Save feedback"
        reasonLabel="Feedback the raiser will read with their progress code"
        onCancel={() => setDialog(null)}
        onConfirm={(feedback) => api.send('POST', `${path}/progress-feedback`, orgId, { feedback })}
      >
        <p>
          The person raised this anonymously. They read this with their progress code, and it
          replaces any earlier feedback. Do not name anyone or include patient details. A copy is
          kept in the history.
        </p>
      </ActionDialog>
      <ActionDialog
        open={dialog === 'close'}
        title={`Close ${c.code}`}
        confirmLabel="Close concern"
        reasonLabel="What was found and done"
        confirmDisabled={!outcome}
        onCancel={() => setDialog(null)}
        fields={
          <>
            <Field label="Outcome">
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                <option value="">Choose</option>
                {Object.entries(OUTCOME).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Closed on">
              <input
                type="date"

                value={on}
                max={today}
                onChange={(e) => setOn(e.target.value)}
              />
            </Field>
            <Field label="Lessons for the organisation (optional)">
              <textarea rows={2} value={lessons} onChange={(e) => setLessons(e.target.value)} />
            </Field>
          </>
        }
        onConfirm={(outcomeText) =>
          api.send('POST', `${path}/close`, orgId, {
            outcome,
            outcomeText,
            closedOn: on,
            ...(lessons.trim() ? { lessons: lessons.trim() } : {}),
          })
        }
      />
    </Section>
  );
}

function RecordConcern() {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const today = londonDate(new Date());
  const [category, setCategory] = useState('');
  const [channel, setChannel] = useState('IN_PERSON');
  const [summary, setSummary] = useState('');
  const [raisedOn, setRaisedOn] = useState(today);
  const [anonymous, setAnonymous] = useState(false);
  const [raisedBy, setRaisedBy] = useState('');
  const { run, msg } = useRun();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/speak-up/record', orgId, {
          category,
          channel,
          summary: summary.trim(),
          raisedOn,
          anonymous,
          ...(anonymous ? {} : { raisedByUserId: raisedBy }),
        }),
      'Concern recorded.',
    );
    if (ok) setSummary('');
  }
  return (
    <Section title="Record a concern received another way">
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Record a concern"
        onSubmit={(e) => void submit(e)}
      >
        <Field label="About">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Choose</option>
            {Object.entries(CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Received by">
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            {Object.entries(CHANNEL)
              .filter(([k]) => k !== 'IN_APP')
              .map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Date raised">
          <input
            type="date"

            value={raisedOn}
            max={today}
            onChange={(e) => setRaisedOn(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={anonymous}
            onChange={(e) => setAnonymous(e.target.checked)}
          />
          The person asked to stay anonymous
        </label>
        {!anonymous && (
          <PersonSelect
            label="Raised by"
            value={raisedBy}
            onChange={setRaisedBy}
            people={people}
            meId={me.user.id}
            optional
          />
        )}
        <Field label="Summary (no patient names)">
          <textarea
            style={{ width: 384 }}
            rows={3}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
        <Button
          type="primary"
          htmlType="submit"
          disabled={!category || summary.trim().length < 10 || (!anonymous && !raisedBy)}
        >
          Record concern
        </Button>
      </form>
      {msg}
    </Section>
  );
}

// ---- themes (H6) --------------------------------------------------------------------------------
/** The current quarter and the seven before it, newest first ("2026-Q4"). */
export function recentQuarters(today: string, n = 8): string[] {
  let y = Number(today.slice(0, 4));
  let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out;
}
const quarterLabel = (k: string) => `Quarter ${k.slice(-1)} ${k.slice(0, 4)}`;

/** H6: quarterly themes for the governance meeting. Categories only; small counts hidden. */
function Themes() {
  const quarters = recentQuarters(londonDate(new Date()));
  const [quarter, setQuarter] = useState(quarters[0]!);
  const res = useOne<Row>(`/api/v1/speak-up/themes?quarter=${quarter}`);
  const t = res.data;
  return (
    <Section title="Themes by quarter">
      <Field label="Quarter">
        <select style={{ width: 224 }} value={quarter} onChange={(e) => setQuarter(e.target.value)}>
          {quarters.map((k) => (
            <option key={k} value={k}>
              {quarterLabel(k)}
            </option>
          ))}
        </select>
      </Field>
      {t?.from && (
        <p className="text-sm">
          {fmtDate(t.from)} to {fmtDate(t.to)}. Concerns raised: {t.total}.
        </p>
      )}
      {t?.note && (
        <p role="note" className=" text-sm">
          {t.note}
        </p>
      )}
      <DataTable<Row>
        caption={`Speak-up themes, ${quarterLabel(quarter)}`}
        rows={(Array.isArray(t?.themes) ? t!.themes : []) as Row[]}
        rowKey={(r) => r.category}
        loading={res.isLoading}
        error={res.isError ? 'Could not load the themes.' : null}
        emptyMessage="No concerns were raised in this quarter."
        columns={[
          { key: 'k', header: 'Theme', cell: (r) => CATEGORY[r.category] ?? 'Something else' },
          { key: 'n', header: 'Concerns', cell: (r) => r.count },
        ]}
      />
    </Section>
  );
}

// ---- harassment prevention ----------------------------------------------------------------------
const emptyRisk = () => ({
  area: '',
  risk: '',
  controls: '',
  furtherAction: '',
  thirdParty: false,
});

function Prevention() {
  const { api, orgId, me } = useApp();
  const duty = useOne<Row>('/api/v1/harassment/duty');
  const list = useOne<{ data: Row[] }>('/api/v1/harassment/assessments');
  const [approving, setApproving] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null | 'new'>(null);
  const rows = list.data?.data ?? [];
  const hasDraft = rows.some((r) => r.status === 'DRAFT');
  const steps = (Array.isArray(duty.data?.steps) ? duty.data!.steps : []) as Row[];
  const counts = Object.entries((duty.data?.concernsLast12Months ?? {}) as Record<string, number>);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Section title="Steps to prevent sexual harassment">
        {duty.data?.note && (
          <p role="note" className="text-sm">
            {duty.data.note}
          </p>
        )}
        <ul aria-label="Prevention steps" className="space-y-1 text-sm">
          {steps.map((s) => (
            <li key={s.step} className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{s.title}</span>
              <StatusBadge status={s.status} reason={s.reasonText} />
            </li>
          ))}
        </ul>
        {counts.length > 0 && (
          <p className="text-sm">
            Concerns in the last 12 months:{' '}
            {counts.map(([k, n]) => `${CATEGORY[k] ?? 'Other'} ${n}`).join(', ')}.
          </p>
        )}
      </Section>
      <Section
        title="Risk assessments"
        actions={
          !hasDraft && (
            <Button size="small" onClick={() => setEditing('new')}>
              Start a new assessment
            </Button>
          )
        }
      >
        <DataTable<Row>
          caption="Sexual harassment risk assessments"
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          error={list.isError ? 'Could not load risk assessments.' : null}
          emptyMessage="No risk assessment yet."
          columns={[
            { key: 't', header: 'Title', cell: (r) => r.title },
            { key: 'a', header: 'Assessed', cell: (r) => fmtDate(r.assessedOn) },
            { key: 'r', header: 'Review due', cell: (r) => fmtDate(r.reviewDue) },
            { key: 'n', header: 'Risks', cell: (r) => (r.risks as Row[]).length },
            {
              key: 's',
              header: 'Status',
              cell: (r) => (
                <StatusBadge
                  status={
                    r.status === 'APPROVED' ? 'GREEN' : r.status === 'DRAFT' ? 'AMBER' : 'GREY'
                  }
                  reason={
                    r.status === 'APPROVED'
                      ? `Approved by ${r.approvedByName ?? 'unknown'}`
                      : r.status === 'DRAFT'
                        ? `Draft by ${r.preparedByName ?? 'unknown'}`
                        : 'Replaced by a newer assessment'
                  }
                />
              ),
            },
            {
              key: 'x',
              header: 'Actions',
              cell: (r) =>
                r.status !== 'DRAFT' ? (
                  ''
                ) : (
                  <span className="flex flex-wrap gap-2">
                    <Button
                      size="small"
                      aria-label={`Edit: ${r.title}`}
                      onClick={() => setEditing(r)}
                    >
                      Edit
                    </Button>
                    {r.preparedBy === me.user.id ? (
                      <span className="text-sm">Someone else must approve this.</span>
                    ) : (
                      <Button
                        size="small"
                        aria-label={`Approve: ${r.title}`}
                        onClick={() => setApproving(r)}
                      >
                        Approve
                      </Button>
                    )}
                  </span>
                ),
            },
          ]}
        />
      </Section>
      {editing && (
        <AssessmentForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
      <ActionDialog
        open={!!approving}
        title={`Approve "${approving?.title ?? ''}"`}
        confirmLabel="Approve assessment"
        onCancel={() => setApproving(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/harassment/assessments/${approving!.id}/approve`, orgId, {})
        }
      >
        <p>Once approved it cannot be changed. Any earlier approved assessment is replaced.</p>
      </ActionDialog>
    </Space>
  );
}

function AssessmentForm({ existing, onDone }: { existing: Row | null; onDone: () => void }) {
  const { api, orgId } = useApp();
  const today = londonDate(new Date());
  const [title, setTitle] = useState(existing?.title ?? 'Sexual harassment risk assessment');
  const [assessedOn, setAssessedOn] = useState(existing?.assessedOn ?? today);
  const [reviewDue, setReviewDue] = useState(existing?.reviewDue ?? '');
  const [risks, setRisks] = useState<Row[]>(
    existing ? (existing.risks as Row[]).map((r) => ({ ...emptyRisk(), ...r })) : [emptyRisk()],
  );
  const { run, msg } = useRun();
  const set = (i: number, k: string, v: unknown) =>
    setRisks(risks.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      title: title.trim(),
      assessedOn,
      reviewDue,
      risks: risks.map((r) => ({
        area: r.area.trim(),
        risk: r.risk.trim(),
        controls: r.controls.trim(),
        ...(r.furtherAction?.trim() ? { furtherAction: r.furtherAction.trim() } : {}),
        thirdParty: !!r.thirdParty,
      })),
    };
    const ok = await run(
      () =>
        existing
          ? api.send(
              'PATCH',
              `/api/v1/harassment/assessments/${existing.id}`,
              orgId,
              body,
              existing.version,
            )
          : api.send('POST', '/api/v1/harassment/assessments', orgId, body),
      'Draft saved. Someone else must approve it.',
    );
    if (ok) onDone();
  }
  return (
    <Section title={existing ? 'Edit draft assessment' : 'New risk assessment'}>
      <form
        className="space-y-3"
        aria-label={existing ? 'Edit draft assessment' : 'New risk assessment'}
        onSubmit={(e) => void submit(e)}
      >
        <div className="flex flex-wrap gap-3">
          <Field label="Title">
            <input
              style={{ width: 320 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label="Assessed on">
            <input
              type="date"

              value={assessedOn}
              max={today}
              onChange={(e) => setAssessedOn(e.target.value)}
            />
          </Field>
          <Field label="Review by">
            <input
              type="date"

              value={reviewDue}
              onChange={(e) => setReviewDue(e.target.value)}
            />
          </Field>
        </div>
        {risks.map((r, i) => (
          <fieldset key={i} className="space-y-2 rounded border border-hub-line p-3">
            <legend className="text-sm font-semibold">Risk {i + 1}</legend>
            <Field label="Where or when it could happen">
              <input value={r.area} onChange={(e) => set(i, 'area', e.target.value)} />
            </Field>
            <Field label="The risk">
              <textarea rows={2} value={r.risk} onChange={(e) => set(i, 'risk', e.target.value)} />
            </Field>
            <Field label="Controls in place">
              <textarea
                rows={2}
                value={r.controls}
                onChange={(e) => set(i, 'controls', e.target.value)}
              />
            </Field>
            <Field label="Further action (optional)">
              <input
                value={r.furtherAction ?? ''}
                onChange={(e) => set(i, 'furtherAction', e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!r.thirdParty}
                onChange={(e) => set(i, 'thirdParty', e.target.checked)}
              />
              Includes harassment by patients, visitors or contractors
            </label>
            {risks.length > 1 && (
              <Button
                size="small"
                aria-label={`Remove risk ${i + 1}`}
                onClick={() => setRisks(risks.filter((_, n) => n !== i))}
              >
                Remove
              </Button>
            )}
          </fieldset>
        ))}
        <div className="flex gap-2">
          <Button size="small" onClick={() => setRisks([...risks, emptyRisk()])}>
            Add another risk
          </Button>
          <Button size="small" onClick={onDone}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" disabled={!reviewDue || !title.trim()}>
            Save draft
          </Button>
        </div>
      </form>
      {msg}
    </Section>
  );
}
