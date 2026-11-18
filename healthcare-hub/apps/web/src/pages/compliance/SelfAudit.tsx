// v36 Compliance › Audits & actions › CQC self-audit: one card per key question with a score ring,
// then that question's statements answered Pass / Partial / Fail / N/A. A second person signs off.
import { CQC_SELF_AUDIT } from '@hub/contracts';
import { Alert, Button, Input, Modal } from 'antd';
import { useState } from 'react';
import { errText, fmtDate, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { Ms, WfCard, WfTag } from '../../v36/ui.js';

type Answer = 'PASS' | 'PARTIAL' | 'FAIL' | 'NA';
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const LABEL: Record<Answer, string> = { PASS: 'Pass', PARTIAL: 'Partial', FAIL: 'Fail', NA: 'N/A' };
const CLS: Record<Answer, string> = { PASS: 'P', PARTIAL: 'A', FAIL: 'F', NA: 'N' };
const TOTAL = CQC_SELF_AUDIT.reduce((n, k) => n + k.questions.length, 0);

function score(answers: Map<string, Answer>, keys: string[]) {
  const got = keys.map((k) => answers.get(k));
  const pass = got.filter((a) => a === 'PASS').length;
  const partial = got.filter((a) => a === 'PARTIAL').length;
  const fail = got.filter((a) => a === 'FAIL').length;
  const open = got.filter((a) => !a).length;
  const counted = pass + partial + fail;
  return {
    pass,
    partial,
    fail,
    open,
    pct: counted ? Math.round(((pass + partial / 2) / counted) * 100) : null,
  };
}

function Ring({ pct }: { pct: number | null }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const v = pct ?? 0;
  const colour = pct === null ? '#bfbfbf' : v >= 90 ? '#389e0d' : v >= 75 ? '#d48806' : '#cf1322';
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="28" cy="28" r={r} fill="none" stroke="#f0f0f0" strokeWidth="6" />
      <circle
        cx="28"
        cy="28"
        r={r}
        fill="none"
        stroke={colour}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${(c * v) / 100} ${c}`}
        transform="rotate(-90 28 28)"
      />
      <text x="28" y="32" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
        {pct === null ? '—' : `${pct}%`}
      </text>
    </svg>
  );
}

export function CqcSelfAudit() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const run = can('compliance.audit.run');
  const q = useOne<{ audit: Row | null }>('/api/v1/cqc-self-audit');
  const [open, setOpen] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState('');
  const a = q.data?.audit ?? null;
  const answers = new Map<string, Answer>(
    ((a?.answers as Row[]) ?? []).map((x) => [x.questionKey as string, x.answer as Answer]),
  );
  const answered = answers.size;
  const editable = run && a?.status === 'OPEN';
  const kq = CQC_SELF_AUDIT[open]!;

  const call = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await q.refetch();
      return true;
    } catch (e) {
      setErr(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const exportCsv = () => {
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const lines = [
      'Key question,Number,Statement,Regulation,Answer',
      ...CQC_SELF_AUDIT.flatMap((k) =>
        k.questions.map((x, i) =>
          [
            k.label,
            String(i + 1),
            x.text,
            x.regulation ? `Reg ${x.regulation}` : '',
            answers.get(x.key) ? LABEL[answers.get(x.key)!] : 'Not answered',
          ]
            .map(esc)
            .join(','),
        ),
      ),
    ];
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = `cqc-self-audit-${a?.code ?? 'blank'}.csv`;
    el.click();
    URL.revokeObjectURL(url);
  };

  if (q.isLoading) return <p role="status">Loading the self-audit…</p>;
  if (q.isError) return <Alert type="error" showIcon message={errText(q.error)} />;
  if (!a)
    return (
      <WfCard title="CQC self-audit">
        <p>
          Assess the service against the CQC key questions: {TOTAL} statements across Safe,
          Effective, Caring and Responsive. Internal measure, not a CQC rating.
        </p>
        {err && <Alert type="error" showIcon message={err} />}
        {run && (
          <Button
            type="primary"
            loading={busy}
            onClick={() => void call(() => api.send('POST', '/api/v1/cqc-self-audit', orgId, {}))}
          >
            Start a self-audit
          </Button>
        )}
      </WfCard>
    );

  const status =
    a.status === 'OPEN' ? (
      <WfTag tone={answered === TOTAL ? 'green' : 'amber'} icon="schedule">
        {answered} of {TOTAL} answered
      </WfTag>
    ) : a.status === 'SUBMITTED' ? (
      <WfTag tone="blue" icon="hourglass_top">
        Submitted by {a.submittedByName ?? 'a former member'} – waiting for review
      </WfTag>
    ) : (
      <WfTag tone="green" icon="check_circle">
        Reviewed by {a.reviewedByName ?? 'a former member'} on {fmtDate(a.reviewedAt)}
      </WfTag>
    );

  return (
    <div className="wf-stack">
      <div className="wf-grid4" role="group" aria-label="CQC key questions">
        {CQC_SELF_AUDIT.map((k, i) => {
          const s = score(
            answers,
            k.questions.map((x) => x.key),
          );
          return (
            <button
              key={k.key}
              type="button"
              className={`wf-cqs${i === open ? ' on' : ''}`}
              aria-pressed={i === open}
              onClick={() => setOpen(i)}
            >
              <div className="wf-ring">
                <Ring pct={s.pct} />
                <div>
                  <b>{k.label}</b>
                  <span>
                    {s.pass} pass · {s.partial} partial · {s.fail} fail · {s.open} open
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {err && <Alert type="error" showIcon message={err} closable onClose={() => setErr(null)} />}
      <WfCard
        title={`${kq.label} – ${kq.questions.length} questions`}
        extra={
          <span className="hh-inline">
            {status}
            <Button size="small" onClick={exportCsv}>
              <Ms i="download" /> Export
            </Button>
            {a.status === 'OPEN' && run && (
              <Button
                size="small"
                type="primary"
                loading={busy}
                disabled={answered < TOTAL}
                title={answered < TOTAL ? 'Answer every statement first' : undefined}
                onClick={() =>
                  void call(() =>
                    api.send('POST', `/api/v1/cqc-self-audit/${a.id}/submit`, orgId, {}),
                  )
                }
              >
                <Ms i="send" /> Submit for review
              </Button>
            )}
            {a.status === 'SUBMITTED' && run && a.submittedBy !== me.user.id && (
              <Button size="small" type="primary" onClick={() => setReviewing(true)}>
                <Ms i="how_to_reg" /> Sign off review
              </Button>
            )}
            {a.status === 'REVIEWED' && run && (
              <Button
                size="small"
                loading={busy}
                onClick={() =>
                  void call(() => api.send('POST', '/api/v1/cqc-self-audit', orgId, {}))
                }
              >
                Start a new self-audit
              </Button>
            )}
          </span>
        }
      >
        {kq.questions.map((x, i) => {
          const got = answers.get(x.key);
          return (
            <div key={x.key} className="wf-cq">
              <span>
                {i + 1}. {x.text}
                {x.regulation ? <span className="wf-mut"> · Reg {x.regulation}</span> : null}
              </span>
              <div className="ph-tog cq" role="radiogroup" aria-label={`${i + 1}. ${x.text}`}>
                {(['PASS', 'PARTIAL', 'FAIL', 'NA'] as Answer[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={got === v}
                    className={got === v ? `on ${CLS[v]}` : ''}
                    disabled={!editable || busy}
                    onClick={() =>
                      void call(() =>
                        api.send('POST', `/api/v1/cqc-self-audit/${a.id}/answers/${x.key}`, orgId, {
                          answer: v,
                        }),
                      )
                    }
                  >
                    {LABEL[v]}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {a.reviewNote && (
          <p className="wf-mini" style={{ margin: 0 }}>
            Review note: {a.reviewNote}
          </p>
        )}
        <p className="wf-mini" style={{ margin: 0 }}>
          {a.code} started by {a.startedByName ?? 'a former member'} on {fmtDate(a.startedAt)}.
          Internal measure — not a CQC rating. Someone other than the person who submits it signs
          off the review.
        </p>
      </WfCard>
      <Modal
        open={reviewing}
        title="Sign off the self-audit review"
        onCancel={() => setReviewing(false)}
        okText="Sign off"
        okButtonProps={{ disabled: note.trim().length < 3, loading: busy }}
        onOk={async () => {
          if (
            await call(() =>
              api.send('POST', `/api/v1/cqc-self-audit/${a.id}/review`, orgId, { note }),
            )
          )
            setReviewing(false);
        }}
      >
        <label className="hh-form">
          What did the review find, and what happens next?
          <Input.TextArea rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </Modal>
    </div>
  );
}
