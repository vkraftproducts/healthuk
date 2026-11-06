import { DataTable, StatusBadge, type StatusKind } from '@hub/ui';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  button,
  fmtDate,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MANAGE = 'compliance.risk.manage';

export const RISK_KIND: Record<string, StatusKind> = {
  LOW: 'GREEN',
  MEDIUM: 'AMBER',
  HIGH: 'RED',
  EXTREME: 'RED',
};
const SCORES = [1, 2, 3, 4, 5];
const LIKELIHOOD = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
const IMPACT = ['Negligible', 'Minor', 'Moderate', 'Major', 'Catastrophic'];

function Rating({ r }: { r: Row }) {
  return (
    <StatusBadge
      status={RISK_KIND[r.rating] ?? 'GREY'}
      reason={`${words(r.rating)} (${r.likelihood} × ${r.impact} = ${r.score})`}
    />
  );
}

function ScoreSelect({
  label,
  name,
  names,
  value,
  onChange,
}: {
  label: string;
  name: string;
  names: string[];
  value?: number;
  onChange?: (v: number) => void;
}) {
  return (
    <Field label={label}>
      <select
        name={name}
        required
        className={input}
        {...(onChange
          ? { value: String(value ?? 3), onChange: (e) => onChange(Number(e.target.value)) }
          : { defaultValue: '3' })}
      >
        {SCORES.map((s) => (
          <option key={s} value={s}>
            {s} – {names[s - 1]}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AddRisk({ onDone }: { onDone: () => void }) {
  const { api, orgId, me } = useApp();
  const { run, msg } = useRun();
  const people = usePeople();
  const [owner, setOwner] = useState(me.user.id);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => Number(f.get(k));
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/risks', orgId, {
          hazard: String(f.get('hazard')),
          peopleAffected: String(f.get('peopleAffected')),
          inherentLikelihood: n('inherentLikelihood'),
          inherentImpact: n('inherentImpact'),
          controls: String(f.get('controls')),
          residualLikelihood: n('residualLikelihood'),
          residualImpact: n('residualImpact'),
          ownerUserId: owner,
          reviewDate: String(f.get('reviewDate')),
        }),
      'Risk added to the register.',
    );
    if (ok) onDone();
  }
  return (
    <Section title="Add a risk">
      <form onSubmit={submit} aria-label="Add a risk" className="grid gap-3 md:grid-cols-2">
        <Field label="Hazard or risk">
          <input name="hazard" required minLength={3} maxLength={500} className={input} />
        </Field>
        <Field label="Who could be harmed">
          <input name="peopleAffected" required minLength={2} maxLength={300} className={input} />
        </Field>
        <ScoreSelect
          label="Likelihood before controls"
          name="inherentLikelihood"
          names={LIKELIHOOD}
        />
        <ScoreSelect label="Impact before controls" name="inherentImpact" names={IMPACT} />
        <div className="md:col-span-2">
          <Field label="Controls in place">
            <textarea name="controls" required minLength={3} maxLength={4000} className={input} />
          </Field>
        </div>
        <ScoreSelect
          label="Likelihood with controls"
          name="residualLikelihood"
          names={LIKELIHOOD}
        />
        <ScoreSelect label="Impact with controls" name="residualImpact" names={IMPACT} />
        <PersonSelect
          label="Risk owner"
          value={owner}
          onChange={setOwner}
          people={people}
          meId={me.user.id}
        />
        <Field label="Review by">
          <input type="date" name="reviewDate" required className={input} />
        </Field>
        <div className="md:col-span-2">
          <button className={button}>Add risk</button>
        </div>
      </form>
      {msg}
    </Section>
  );
}

type Edit = {
  controls: string;
  residualLikelihood: number;
  residualImpact: number;
  ownerUserId: string;
  reviewDate: string;
};

export function Risks() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const people = usePeople();
  const [showClosed, setShowClosed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ r: Row; v: Edit } | null>(null);
  const [closing, setClosing] = useState<Row | null>(null);
  const [closeAs, setCloseAs] = useState<'CLOSED' | 'ARCHIVED'>('CLOSED');
  const [raising, setRaising] = useState<Row | null>(null);
  const [act, setAct] = useState({ title: '', owner: me.user.id, deadline: '' });
  const res = useOne<{ data: Row[] }>('/api/v1/risks');
  const all = res.data?.data ?? [];
  const rows = showClosed ? all : all.filter((r) => r.status === 'OPEN');
  const manage = can(MANAGE);
  const ownerText = (r: Row) =>
    r.ownerUserId === me.user.id ? `${r.ownerName ?? 'You'} (you)` : (r.ownerName ?? 'Unknown');

  return (
    <>
      <Section
        title="Risks"
        actions={
          manage && (
            <button className={smallButton} onClick={() => setAdding((x) => !x)}>
              {adding ? 'Close the form' : 'Add a risk'}
            </button>
          )
        }
      >
        <p className="text-sm">
          Scores are likelihood × impact on a 1–5 scale. The residual rating is the risk with the
          current controls in place.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Show closed risks
        </label>
      </Section>
      {adding && manage && <AddRisk onDone={() => setAdding(false)} />}
      <DataTable<Row>
        caption="Risk register"
        rows={rows}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load risks.' : null}
        emptyMessage={showClosed ? 'No risks recorded.' : 'No open risks.'}
        columns={[
          {
            key: 'c',
            header: 'Risk',
            cell: (r) => (
              <>
                <span className="font-medium">
                  {r.code} {r.title ?? r.hazard}
                </span>
                {r.title && <span className="block text-xs">{r.hazard}</span>}
                {r.category && <span className="block text-xs">Category: {words(r.category)}</span>}
                <span className="block text-xs">Who could be harmed: {r.peopleAffected}</span>
                {r.closedReason && (
                  <span className="block text-xs">
                    {r.status === 'ARCHIVED' ? 'Archived' : 'Closed'}: {r.closedReason}
                  </span>
                )}
                {(r.reviews as Row[] | undefined)?.length ? (
                  <details className="text-xs">
                    <summary>Review history ({(r.reviews as Row[]).length})</summary>
                    <ul className="list-disc pl-4">
                      {(r.reviews as Row[]).map((v: Row, i: number) => (
                        <li key={i}>
                          {fmtDate(v.at)} – {v.bandText} ({v.byName ?? 'former member'})
                          {v.note ? `: ${v.note}` : ''}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {r.linkedEvents.length > 0 && (
                  <span className="block text-xs">
                    Linked events:{' '}
                    {r.linkedEvents.map((e: Row, i: number) => (
                      <span key={e.id}>
                        {i > 0 && ', '}
                        <Link
                          to="/compliance/events/$id"
                          params={{ id: e.id }}
                          className="text-hub-teal-dark underline"
                        >
                          {e.code}
                        </Link>
                      </span>
                    ))}
                  </span>
                )}
              </>
            ),
          },
          { key: 'i', header: 'Before controls', cell: (r) => <Rating r={r.inherent} /> },
          {
            key: 'r',
            header: 'With controls',
            cell: (r) =>
              r.bandText ? (
                <StatusBadge status={RISK_KIND[r.residual.rating] ?? 'GREY'} reason={r.bandText} />
              ) : (
                <Rating r={r.residual} />
              ),
          },
          { key: 'o', header: 'Owner', cell: ownerText },
          {
            key: 'd',
            header: 'Review',
            cell: (r) =>
              r.status !== 'OPEN' ? (
                r.status === 'ARCHIVED' ? (
                  'Archived'
                ) : (
                  'Closed'
                )
              ) : r.reviewOverdue ? (
                <StatusBadge
                  status="RED"
                  reason={`Review overdue – was due ${fmtDate(r.reviewDate)}`}
                />
              ) : (
                `By ${fmtDate(r.reviewDate)}`
              ),
          },
          {
            key: 'a',
            header: 'Open actions',
            cell: (r) =>
              r.openActions > 0 ? (
                <Link
                  to="/compliance"
                  search={{ tab: 'actions' }}
                  className="text-hub-teal-dark underline"
                >
                  {r.openActions} open
                </Link>
              ) : (
                'None'
              ),
          },
          {
            key: 'x',
            header: 'Manage',
            cell: (r) =>
              manage && r.status === 'OPEN' ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    className={smallButton}
                    aria-label={`Review ${r.code} ${r.hazard}`}
                    onClick={() =>
                      setEditing({
                        r,
                        v: {
                          controls: r.controls,
                          residualLikelihood: r.residual.likelihood,
                          residualImpact: r.residual.impact,
                          ownerUserId: r.ownerUserId,
                          reviewDate: '',
                        },
                      })
                    }
                  >
                    Review
                  </button>
                  <button
                    className={smallButton}
                    aria-label={`Raise an action for ${r.code} ${r.hazard}`}
                    onClick={() => {
                      setAct({ title: '', owner: r.ownerUserId, deadline: '' });
                      setRaising(r);
                    }}
                  >
                    Raise an action
                  </button>
                  <button
                    className={smallButton}
                    aria-label={`Close ${r.code} ${r.hazard}`}
                    onClick={() => setClosing(r)}
                  >
                    Close
                  </button>
                </div>
              ) : manage && r.status !== 'OPEN' ? (
                <button
                  className={smallButton}
                  aria-label={`Reopen ${r.code} ${r.hazard}`}
                  onClick={() => setClosing(r)}
                >
                  Reopen
                </button>
              ) : null,
          },
        ]}
      />

      <ActionDialog
        open={editing !== null}
        title={`Review ${editing?.r.code ?? ''} ${editing?.r.hazard ?? ''}`}
        confirmLabel="Save review"
        confirmDisabled={!editing?.v.reviewDate || (editing?.v.controls.trim().length ?? 0) < 3}
        onCancel={() => setEditing(null)}
        onConfirm={() =>
          api.send(
            'PATCH',
            `/api/v1/risks/${editing!.r.id}`,
            orgId,
            { ...editing!.v, controls: editing!.v.controls.trim() },
            editing!.r.version,
          )
        }
        fields={
          editing && (
            <div className="grid gap-3">
              <Field label="Controls in place">
                <textarea
                  className={input}
                  value={editing.v.controls}
                  maxLength={4000}
                  onChange={(e) =>
                    setEditing({ ...editing, v: { ...editing.v, controls: e.target.value } })
                  }
                />
              </Field>
              <ScoreSelect
                label="Likelihood with controls"
                name="residualLikelihood"
                names={LIKELIHOOD}
                value={editing.v.residualLikelihood}
                onChange={(n) =>
                  setEditing({ ...editing, v: { ...editing.v, residualLikelihood: n } })
                }
              />
              <ScoreSelect
                label="Impact with controls"
                name="residualImpact"
                names={IMPACT}
                value={editing.v.residualImpact}
                onChange={(n) => setEditing({ ...editing, v: { ...editing.v, residualImpact: n } })}
              />
              <PersonSelect
                label="Risk owner"
                value={editing.v.ownerUserId}
                onChange={(id) => setEditing({ ...editing, v: { ...editing.v, ownerUserId: id } })}
                people={people}
                meId={me.user.id}
              />
              <Field label="Next review by">
                <input
                  type="date"
                  className={input}
                  value={editing.v.reviewDate}
                  onChange={(e) =>
                    setEditing({ ...editing, v: { ...editing.v, reviewDate: e.target.value } })
                  }
                />
              </Field>
            </div>
          )
        }
      >
        <p>
          Record what has changed and set the next review date. Last due{' '}
          {fmtDate(editing?.r.reviewDate)}.
        </p>
      </ActionDialog>

      <ActionDialog
        open={closing !== null}
        title={`${closing?.status === 'OPEN' ? 'Close' : 'Reopen'} ${closing?.code ?? ''} ${closing?.hazard ?? ''}`}
        confirmLabel={closing?.status === 'OPEN' ? 'Close risk' : 'Reopen risk'}
        danger={closing?.status === 'OPEN'}
        reasonLabel={closing?.status === 'OPEN' ? 'Reason for closing or archiving' : undefined}
        onCancel={() => {
          setClosing(null);
          setCloseAs('CLOSED');
        }}
        onConfirm={(reason) =>
          api.send(
            'PATCH',
            `/api/v1/risks/${closing!.id}`,
            orgId,
            closing!.status === 'OPEN' ? { status: closeAs, reason } : { status: 'OPEN' },
            closing!.version,
          )
        }
        fields={
          closing?.status === 'OPEN' ? (
            <Field label="Close or archive">
              <select
                className={input}
                value={closeAs}
                onChange={(e) => setCloseAs(e.target.value as 'CLOSED' | 'ARCHIVED')}
              >
                <option value="CLOSED">Close – the risk no longer applies</option>
                <option value="ARCHIVED">Archive – keep on record, out of the register</option>
              </select>
            </Field>
          ) : undefined
        }
      >
        <p>
          {closing?.status === 'OPEN'
            ? closing.openActions > 0
              ? `This risk still has ${closing.openActions} open action(s). They stay open until verified.`
              : 'A closed risk leaves the open register but stays on record.'
            : 'The risk returns to the open register with its current review date.'}
        </p>
      </ActionDialog>

      <ActionDialog
        open={raising !== null}
        title={`Raise an action for ${raising?.code ?? ''} ${raising?.hazard ?? ''}`}
        confirmLabel="Raise action"
        confirmDisabled={act.title.trim().length < 3 || !act.deadline}
        onCancel={() => setRaising(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/risks/${raising!.id}/actions`, orgId, {
            title: act.title.trim(),
            ownerUserId: act.owner,
            deadline: act.deadline,
          })
        }
        fields={
          <div className="grid gap-3">
            <Field label="What needs to be done">
              <input
                className={input}
                value={act.title}
                maxLength={300}
                onChange={(e) => setAct({ ...act, title: e.target.value })}
              />
            </Field>
            <PersonSelect
              label="Action owner"
              value={act.owner}
              onChange={(id) => setAct({ ...act, owner: id })}
              people={people}
              meId={me.user.id}
            />
            <Field label="Deadline">
              <input
                type="date"
                className={input}
                value={act.deadline}
                onChange={(e) => setAct({ ...act, deadline: e.target.value })}
              />
            </Field>
          </div>
        }
      >
        <p>
          The action stays open until its owner submits evidence and someone else verifies it.
          Severity follows the risk's rating with controls.
        </p>
      </ActionDialog>
    </>
  );
}
