import { DataTable, StatusBadge } from '@hub/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  button,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { openEvidence, uploadFile } from '../evidence/Evidence.js';
import { useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const MANAGE = 'compliance.policy.manage';

const ACK_TEXT: Record<string, string> = {
  CURRENT: 'Acknowledged',
  CARRIED_FORWARD: 'Acknowledged (minor change since)',
  REQUIRED: 'You need to read and acknowledge this',
  NO_PUBLISHED_VERSION: 'Not published yet',
  NOT_A_READER: 'Not required for your role',
};
const VERSION_STAGE: Record<string, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved – not yet published',
  PUBLISHED: 'Published',
  SUPERSEDED: 'Replaced by a later version',
  ARCHIVED: 'Archived',
};
const CATEGORIES = ['POLICY', 'SOP', 'GUIDANCE', 'CRITICAL_INSTRUCTION'] as const;
const STEP: Record<string, { label: string; text: string }> = {
  IN_REVIEW: {
    label: 'Send for review',
    text: 'Someone other than the author must approve it before it can be published.',
  },
  APPROVED: {
    label: 'Approve',
    text:
      'Policies are approved by the registered manager (or a director). Your name is recorded ' +
      'as the approver. The author cannot approve their own version.',
  },
  PUBLISHED: {
    label: 'Publish',
    text: 'Publishing replaces the current version. If the change is material, every reader must acknowledge it again and is notified.',
  },
  DRAFT: {
    label: 'Send back to draft',
    text: 'Any approval is cleared and the author can rework the version.',
  },
};

const inProgress = (p: Row): Row | undefined =>
  (p.versions as Row[]).find((v) => ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(v.status));
const nextStep = (v: Row) =>
  v.status === 'DRAFT' ? 'IN_REVIEW' : v.status === 'IN_REVIEW' ? 'APPROVED' : 'PUBLISHED';
const critical = (p: Row) => p.category === 'CRITICAL_INSTRUCTION';

function Review({ p }: { p: Row }) {
  const c = p.currentVersion;
  if (!c) return <>Not published</>;
  return (
    <>
      v{c.version} from {fmtDate(c.effectiveFrom)}
      <span className="block text-xs">
        {!c.reviewDate ? (
          'No review date set'
        ) : c.reviewOverdue ? (
          <StatusBadge status="RED" reason={`Review overdue – was due ${fmtDate(c.reviewDate)}`} />
        ) : (
          `Review by ${fmtDate(c.reviewDate)}`
        )}
      </span>
    </>
  );
}

function CreatePolicy() {
  const { api, orgId, me } = useApp();
  const people = usePeople();
  const { run, msg } = useRun();
  const [owner, setOwner] = useState(me.user.id);
  const [readers, setReaders] = useState<string[]>([]);
  const roles = new Map<string, string>();
  for (const p of people)
    (p.roleKeys ?? []).forEach((k, i) => roles.set(k, p.roleNames?.[i] ?? words(k)));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('file');
    const reviewDate = String(f.get('reviewDate') ?? '');
    const ok = await run(async () => {
      const doc = file instanceof File && file.size > 0 ? await uploadFile(api, orgId, file) : null;
      await api.send('POST', '/api/v1/policies', orgId, {
        code: String(f.get('code')),
        title: String(f.get('title')),
        category: String(f.get('category')),
        ownerUserId: owner,
        readerRoles: readers,
        ...(f.get('readerEveryone') === 'on' ? { readerEveryone: true } : {}),
        summary: String(f.get('summary')),
        ...(reviewDate ? { reviewDate } : {}),
        ...(doc ? { evidenceItemId: doc.itemId } : {}),
      });
    }, 'Policy created as draft version 1. Send it for review when it is ready.');
    if (ok) {
      form.reset();
      setReaders([]);
    }
  }
  return (
    <Section title="Add a policy">
      <form onSubmit={submit} className="space-y-3" aria-label="Add a policy">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code">
            <input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9-]{1,19}" className={input} />
          </Field>
          <Field label="Title">
            <input name="title" required minLength={2} maxLength={200} className={input} />
          </Field>
          <Field label="Type">
            <select name="category" className={input} defaultValue="POLICY">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c === 'SOP' ? 'Standard operating procedure' : words(c)}
                </option>
              ))}
            </select>
          </Field>
          <PersonSelect
            label="Owner"
            value={owner}
            onChange={setOwner}
            people={people}
            meId={me.user.id}
          />
          <Field label="Review by (optional)">
            <input type="date" name="reviewDate" className={input} />
          </Field>
          <Field label="Document (optional)">
            <input type="file" name="file" accept="application/pdf" className={input} />
          </Field>
        </div>
        <Field label="Summary of what it says">
          <textarea
            name="summary"
            required
            minLength={3}
            maxLength={2000}
            rows={2}
            className={input}
          />
        </Field>
        <fieldset className="rounded border border-hub-line p-2">
          <legend className="px-1 text-sm font-semibold">
            Who must read it {readers.length === 0 ? '(nobody ticked: everyone)' : ''}
          </legend>
          <div className="flex flex-wrap gap-3">
            {[...roles.entries()].map(([key, name]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={readers.includes(key)}
                  onChange={(e) =>
                    setReaders((r) => (e.target.checked ? [...r, key] : r.filter((x) => x !== key)))
                  }
                />
                {name}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" name="readerEveryone" />
              Everyone in the organisation
            </label>
          </div>
        </fieldset>
        <button className={button}>Add policy</button>
        {msg}
      </form>
    </Section>
  );
}

function Readers({ id }: { id: string }) {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>(`/api/v1/policies/${id}/readers`);
  if (res.isLoading) return <p role="status">Loading readers…</p>;
  if (res.isError) return <p role="alert">Could not load readers.</p>;
  const rows = res.data?.data ?? [];
  const waiting = rows.filter((r) => r.state === 'REQUIRED').length;
  const counted = rows.filter((r) => r.state !== 'NO_PUBLISHED_VERSION').length;
  const pct = counted ? Math.round(((counted - waiting) / counted) * 100) : null;
  return (
    <div>
      <p className="font-semibold">
        {waiting === 0 ? 'Everyone has acknowledged.' : `${waiting} still need to acknowledge.`}
      </p>
      {pct !== null && <p className="text-sm">{pct}% of required readers have acknowledged.</p>}
      {waiting > 0 && can(MANAGE) && (
        <button
          className={smallButton}
          onClick={() =>
            void run(
              () => api.send('POST', `/api/v1/policies/${id}/chase`, orgId, {}),
              'Reminder sent to everyone who has not acknowledged (logged).',
            )
          }
        >
          Remind those outstanding
        </button>
      )}
      {msg}
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {rows.map((r) => (
          <li key={r.userId}>
            {r.displayName} ({r.roleNames.join(', ')}):{' '}
            {r.state === 'REQUIRED'
              ? 'Not yet acknowledged'
              : r.state === 'NO_PUBLISHED_VERSION'
                ? 'Nothing published yet'
                : `Acknowledged ${fmtDateTime(r.acknowledgedAt)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function History({ p }: { p: Row }) {
  return (
    <ol className="space-y-2">
      {(p.versions as Row[]).map((v) => (
        <li key={v.id}>
          <span className="font-medium">
            v{v.version} – {VERSION_STAGE[v.status] ?? words(v.status)}
            {v.material ? '' : ' (minor change)'}
          </span>
          <span className="block">{v.summary}</span>
          <span className="block text-xs text-slate-700">
            Written by {v.createdByName ?? 'a former member'}
            {v.approvedByName ? `; approved by ${v.approvedByName}` : ''}
            {v.approvedAt ? `, ${fmtDateTime(v.approvedAt)}` : ''}
            {v.publishedAt ? `; published ${fmtDateTime(v.publishedAt)}` : ''}
            {v.reviewDate ? `; review by ${fmtDate(v.reviewDate)}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

type Dialog =
  | { kind: 'ack'; p: Row }
  | { kind: 'step'; p: Row; v: Row; to: string }
  | { kind: 'version'; p: Row }
  | { kind: 'details'; p: Row };

export function Policies() {
  const res = useOne<{ data: Row[] }>('/api/v1/policies');
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [summary, setSummary] = useState('');
  const [material, setMaterial] = useState(true);
  const [reviewDate, setReviewDate] = useState('');

  const open = (d: Dialog) => {
    setConfirmed(false);
    setEffectiveFrom('');
    setSummary('');
    setMaterial(true);
    setReviewDate('');
    setDialog(d);
  };
  const label = (p: Row) => `${p.code} ${p.title}`;

  function actions(p: Row) {
    const out: ReactNode[] = [];
    if (p.myAcknowledgement === 'REQUIRED' && can('compliance.policy.acknowledge'))
      out.push(
        <button
          key="ack"
          className={smallButton}
          aria-label={`Read and acknowledge: ${label(p)}`}
          onClick={() => open({ kind: 'ack', p })}
        >
          Read and acknowledge
        </button>,
      );
    out.push(
      <button
        key="details"
        className={smallButton}
        aria-label={`Details: ${label(p)}`}
        onClick={() => open({ kind: 'details', p })}
      >
        Details
      </button>,
    );
    if (can(MANAGE)) {
      const v = inProgress(p);
      if (v) {
        const to = nextStep(v);
        if (to === 'APPROVED' && v.createdBy === me.user.id)
          out.push(
            <span key="self" className="text-xs">
              You wrote v{v.version}, so someone else must approve it.
            </span>,
          );
        else if (to === 'APPROVED' && !can('compliance.policy.approve'))
          out.push(
            <span key="rm" className="text-xs">
              v{v.version} is waiting for approval by the registered manager (or a director).
            </span>,
          );
        else
          out.push(
            <button
              key="next"
              className={smallButton}
              aria-label={`${STEP[to]!.label} v${v.version}: ${label(p)}`}
              onClick={() => open({ kind: 'step', p, v, to })}
            >
              {STEP[to]!.label} v{v.version}
            </button>,
          );
        if (v.status !== 'DRAFT')
          out.push(
            <button
              key="back"
              className={smallButton}
              aria-label={`Send back to draft v${v.version}: ${label(p)}`}
              onClick={() => open({ kind: 'step', p, v, to: 'DRAFT' })}
            >
              Send back to draft
            </button>,
          );
      } else
        out.push(
          <button
            key="ver"
            className={smallButton}
            aria-label={`New version: ${label(p)}`}
            onClick={() => open({ kind: 'version', p })}
          >
            New version
          </button>,
        );
    }
    return <div className="flex flex-wrap items-center gap-2">{out}</div>;
  }

  const d = dialog;
  const p = d?.p;
  const props = (() => {
    if (!d || !p) return null;
    if (d.kind === 'ack')
      return {
        title: `Read and acknowledge: ${label(p)}`,
        confirm: 'Acknowledge',
        disabled: critical(p) && !confirmed,
        run: () =>
          api.send(
            'POST',
            `/api/v1/policies/${p.id}/acknowledge`,
            orgId,
            critical(p) ? { confirmCritical: true } : {},
          ),
      };
    if (d.kind === 'step')
      return {
        title: `${STEP[d.to]!.label} v${d.v.version}: ${label(p)}`,
        confirm: STEP[d.to]!.label,
        disabled: false,
        run: () =>
          api.send('POST', `/api/v1/policies/${p.id}/versions/${d.v.id}/transition`, orgId, {
            to: d.to,
            ...(d.to === 'PUBLISHED' && effectiveFrom ? { effectiveFrom } : {}),
          }),
      };
    if (d.kind === 'version')
      return {
        title: `New version: ${label(p)}`,
        confirm: 'Create draft',
        disabled: summary.trim().length < 3,
        run: () =>
          api.send('POST', `/api/v1/policies/${p.id}/versions`, orgId, {
            summary: summary.trim(),
            material,
            ...(reviewDate ? { reviewDate } : {}),
          }),
      };
    return {
      title: `Details: ${label(p)}`,
      confirm: 'Close',
      disabled: false,
      run: async () => null,
    };
  })();

  const current = p ? (p.versions as Row[]).find((v) => v.status === 'PUBLISHED') : null;
  const docId: string | null = p?.currentVersion?.documentEvidenceVersionId ?? null;
  const openDoc =
    docId && can('compliance.requirement.view') ? (
      <button
        type="button"
        className={smallButton}
        onClick={() => void run(() => openEvidence(api, orgId, docId), 'Document opened.')}
      >
        Open document
      </button>
    ) : null;

  return (
    <>
      {msg}
      <DataTable<Row>
        caption="Policies and SOPs"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.isError ? 'Could not load policies.' : null}
        emptyMessage="No policies."
        columns={[
          {
            key: 'c',
            header: 'Policy',
            cell: (r) => (
              <>
                {label(r)}
                <span className="block text-xs">
                  {critical(r)
                    ? 'Critical instruction'
                    : r.category === 'SOP'
                      ? 'SOP'
                      : words(r.category)}
                </span>
              </>
            ),
          },
          { key: 'o', header: 'Owner', cell: (r) => r.ownerName ?? 'Not a current member' },
          { key: 'v', header: 'Current', cell: (r) => <Review p={r} /> },
          {
            key: 'a',
            header: 'Acknowledged (current version)',
            cell: (r) =>
              r.currentVersion
                ? `${r.acknowledgement.acknowledged} of ${r.acknowledgement.required}`
                : '—',
          },
          { key: 'm', header: 'You', cell: (r) => ACK_TEXT[r.myAcknowledgement] },
          { key: 'x', header: 'Action', cell: (r) => actions(r) },
        ]}
      />
      {can(MANAGE) && <CreatePolicy />}
      <ActionDialog
        open={props !== null}
        title={props?.title ?? ''}
        confirmLabel={props?.confirm ?? ''}
        confirmDisabled={props?.disabled}
        onCancel={() => setDialog(null)}
        onConfirm={() => props!.run()}
        fields={
          d?.kind === 'ack' && p && critical(p) ? (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I have read and understood this critical instruction
            </label>
          ) : d?.kind === 'step' && d.to === 'PUBLISHED' ? (
            <Field label="Takes effect from (optional, default today)">
              <input
                type="date"
                className={input}
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
          ) : d?.kind === 'version' ? (
            <>
              <Field label="What changed">
                <textarea
                  className={input}
                  rows={3}
                  maxLength={2000}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={material}
                  onChange={(e) => setMaterial(e.target.checked)}
                />
                Material change (everyone must acknowledge again)
              </label>
              <Field label="Review by (optional)">
                <input
                  type="date"
                  className={input}
                  value={reviewDate}
                  onChange={(e) => setReviewDate(e.target.value)}
                />
              </Field>
            </>
          ) : undefined
        }
      >
        {d?.kind === 'ack' && p && (
          <>
            <p>
              Version {p.currentVersion?.version}, in effect from{' '}
              {fmtDate(p.currentVersion?.effectiveFrom)}.
            </p>
            {current && <p className="whitespace-pre-wrap">{current.summary}</p>}
            {openDoc}
            <p>Your acknowledgement is recorded with the date and time.</p>
          </>
        )}
        {d?.kind === 'step' && (
          <>
            <p>{d.v.summary}</p>
            <p>{STEP[d.to]!.text}</p>
            {d.to === 'PUBLISHED' && !d.v.material && (
              <p>This is a minor change: existing acknowledgements carry forward.</p>
            )}
          </>
        )}
        {d?.kind === 'version' && (
          <p>
            The new version starts as a draft. The current version stays in force until the new one
            is approved by someone else and published.
          </p>
        )}
        {d?.kind === 'details' && p && (
          <div className="space-y-3">
            {openDoc}
            <History p={p} />
            {can(MANAGE) && p.currentVersion && <Readers id={p.id} />}
          </div>
        )}
      </ActionDialog>
    </>
  );
}
