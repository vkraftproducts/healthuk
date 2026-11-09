import { londonDate } from '@hub/rules';
import { DataTable, StatusBadge } from '@hub/ui';
import { useState, type FormEvent } from 'react';
import {
  ActionDialog,
  Field,
  PersonSelect,
  Section,
  button,
  errText,
  fmtDate,
  fmtDateTime,
  input,
  smallButton,
  useCan,
  useRun,
  words,
} from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { uploadFile } from '../evidence/Evidence.js';
import { useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const REG = 'compliance.registration.manage';
const today = () => londonDate(new Date());
const lines = (s: FormDataEntryValue | null) =>
  String(s ?? '')
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);

const FIELD_TEXT: Record<string, string> = {
  providerRef: 'Provider reference',
  registeredManagerUserId: 'Registered manager',
  nominatedIndividual: 'Nominated individual',
  conditions: 'Conditions',
  statementOfPurposeItemId: 'Statement of purpose',
  insuranceItemId: 'Insurance',
  bcpItemId: 'Business continuity plan',
};

// ---- Registration record editing and history -------------------------------------------------
export function RegistrationEditor({ record }: { record: Row | undefined }) {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const people = usePeople(can(REG));
  const [manager, setManager] = useState<string | null>(null);
  const history = useOne<{ data: Row[] }>('/api/v1/registration/history');
  const managerId = manager ?? record?.registeredManagerUserId ?? '';
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim() || null;
    await run(
      () =>
        api.send('POST', '/api/v1/registration', orgId, {
          providerRef: text('providerRef'),
          nominatedIndividual: text('nominatedIndividual'),
          conditions: text('conditions'),
          registeredManagerUserId: managerId || null,
          ...(text('reason') ? { reason: text('reason') } : {}),
        }),
      'Registration record saved. The previous version is kept in the history.',
    );
  }
  return (
    <>
      {can(REG) && record && (
        <Section title="Update the registration record">
          <form
            onSubmit={save}
            aria-label="Update the registration record"
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="Provider reference">
              <input
                name="providerRef"
                className={input}
                defaultValue={record.providerRef ?? ''}
                maxLength={40}
              />
            </Field>
            <Field label="Nominated individual">
              <input
                name="nominatedIndividual"
                className={input}
                defaultValue={record.nominatedIndividual ?? ''}
                maxLength={120}
              />
            </Field>
            <PersonSelect
              label="Registered manager"
              value={managerId}
              onChange={setManager}
              people={people}
              meId={me.user.id}
              optional
            />
            <Field label="Conditions of registration">
              <textarea
                name="conditions"
                className={input}
                rows={2}
                defaultValue={record.conditions ?? ''}
              />
            </Field>
            <Field label="Why is it changing?">
              <input name="reason" className={input} maxLength={500} />
            </Field>
            <div className="flex items-end">
              <button className={button}>Save registration record</button>
            </div>
          </form>
          {msg}
        </Section>
      )}
      <DataTable<Row>
        caption="Registration record history"
        rows={history.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No changes recorded yet."
        columns={[
          { key: 'w', header: 'Changed', cell: (r) => fmtDateTime(r.changedAt) },
          { key: 'b', header: 'By', cell: (r) => r.changedByName ?? 'Former member' },
          {
            key: 'f',
            header: 'What changed',
            cell: (r) =>
              r.changedFields.length
                ? r.changedFields.map((k: string) => FIELD_TEXT[k] ?? words(k)).join(', ')
                : 'Saved with no changes',
          },
          { key: 'r', header: 'Reason', cell: (r) => r.reason ?? 'Not given' },
        ]}
      />
    </>
  );
}

// ---- Rating display (reg 20A) ----------------------------------------------------------------
const RATINGS = ['OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE'];
const KEY_QUESTIONS = ['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED'];

export function RatingDisplay() {
  const { api, orgId } = useApp();
  const can = useCan();
  const { run, msg } = useRun();
  const ratings = useOne<{ data: Row[] }>('/api/v1/cqc-ratings');
  const locations = useOne<{ data: Row[] }>(
    orgId && can(REG) ? `/api/v1/organisations/${orgId}/locations` : null,
  );
  const [displaying, setDisplaying] = useState<Row | null>(null);
  const [premises, setPremises] = useState('');
  const [website, setWebsite] = useState('');
  const [noWebsite, setNoWebsite] = useState(false);
  const [premisesFile, setPremisesFile] = useState<File | null>(null);
  const [websiteFile, setWebsiteFile] = useState<File | null>(null);
  const where = (r: Row) => r.locationName ?? 'Whole provider';
  const evidenceText = (r: Row) =>
    [
      r.premisesEvidenceItemId ? 'Premises photo on file' : 'No premises photo',
      r.noWebsite
        ? null
        : r.websiteEvidenceItemId
          ? 'website capture on file'
          : 'no website capture',
    ]
      .filter(Boolean)
      .join('; ');
  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const keyQuestions: Record<string, string> = {};
    for (const k of KEY_QUESTIONS) {
      const v = String(f.get(`kq-${k}`) ?? '');
      if (v) keyQuestions[k] = v;
    }
    const form = e.currentTarget;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/cqc-ratings', orgId, {
          ...(f.get('locationId') ? { locationId: String(f.get('locationId')) } : {}),
          overall: String(f.get('overall')),
          keyQuestions,
          publishedOn: String(f.get('publishedOn')),
          ...(f.get('reportUrl') ? { reportUrl: String(f.get('reportUrl')) } : {}),
          noWebsite: f.get('noWebsite') === 'on',
        }),
      'Rating recorded. Display it within 21 days of publication.',
    );
    if (ok) form.reset();
  }
  return (
    <Section title="CQC rating display">
      <p className="text-sm">
        Record each rating exactly as CQC published it, then when it went up at the premises and on
        the website. It must be displayed within 21 days of publication. The hub never calculates or
        predicts a rating.
      </p>
      {ratings.isError && <p role="alert">Could not load ratings.</p>}
      <DataTable<Row>
        caption="Published CQC ratings"
        rows={ratings.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No published rating recorded."
        columns={[
          { key: 'l', header: 'Location', cell: (r) => where(r) },
          {
            key: 'o',
            header: 'Rating published by CQC',
            cell: (r) => (
              <>
                {words(r.overall)}
                {Object.keys(r.keyQuestions ?? {}).length > 0 && (
                  <span className="block text-xs text-slate-700">
                    {Object.entries(r.keyQuestions as Record<string, string>)
                      .map(([k, v]) => `${words(k)}: ${words(v)}`)
                      .join('; ')}
                  </span>
                )}
              </>
            ),
          },
          {
            key: 'p',
            header: 'Published',
            cell: (r) =>
              r.reportUrl ? (
                <a className="underline" href={r.reportUrl} target="_blank" rel="noreferrer">
                  {fmtDate(r.publishedOn)} (CQC report)
                </a>
              ) : (
                fmtDate(r.publishedOn)
              ),
          },
          {
            key: 'd',
            header: 'Display',
            cell: (r) => (
              <>
                <StatusBadge status={r.display.status} reason={r.display.reasonText} />
                <span className="block text-xs text-slate-700">{evidenceText(r)}</span>
              </>
            ),
          },
          {
            key: 'a',
            header: 'Record display',
            cell: (r) =>
              can(REG) && r.current ? (
                <button
                  className={smallButton}
                  aria-label={`Record display: ${where(r)}, published ${fmtDate(r.publishedOn)}`}
                  onClick={() => {
                    setPremises(r.displayedPremisesOn ?? '');
                    setWebsite(r.displayedWebsiteOn ?? '');
                    setNoWebsite(r.noWebsite);
                    setPremisesFile(null);
                    setWebsiteFile(null);
                    setDisplaying(r);
                  }}
                >
                  Record display
                </button>
              ) : null,
          },
        ]}
      />
      {can(REG) && (
        <form
          onSubmit={record}
          aria-label="Record a published rating"
          className="grid gap-3 rounded border border-hub-line bg-hub-card p-3 sm:grid-cols-3"
        >
          <Field label="Location">
            <select name="locationId" className={input}>
              <option value="">Whole provider</option>
              {(locations.data?.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Overall rating">
            <select name="overall" className={input} required>
              {RATINGS.map((x) => (
                <option key={x} value={x}>
                  {words(x)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Published by CQC on">
            <input type="date" name="publishedOn" required max={today()} className={input} />
          </Field>
          {KEY_QUESTIONS.map((k) => (
            <Field key={k} label={`${words(k)} (optional)`}>
              <select name={`kq-${k}`} className={input}>
                <option value="">Not recorded</option>
                {RATINGS.map((x) => (
                  <option key={x} value={x}>
                    {words(x)}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="Link to the CQC report (https)">
            <input type="url" name="reportUrl" className={input} placeholder="https://" />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="noWebsite" /> We have no website
          </label>
          <div className="flex items-end">
            <button className={button}>Record rating</button>
          </div>
        </form>
      )}
      {msg}
      <ActionDialog
        open={displaying !== null}
        title={`Record display: ${displaying ? where(displaying) : ''}`}
        confirmLabel="Save display dates"
        onCancel={() => setDisplaying(null)}
        onConfirm={async () => {
          const label = where(displaying!);
          const photo = premisesFile
            ? await uploadFile(api, orgId, premisesFile, {
                title: `CQC rating display at the premises – ${label}`,
              })
            : null;
          const capture =
            websiteFile && !noWebsite
              ? await uploadFile(api, orgId, websiteFile, {
                  title: `CQC rating display on the website – ${label}`,
                })
              : null;
          await api.send(
            'PATCH',
            `/api/v1/cqc-ratings/${displaying!.id}`,
            orgId,
            {
              ...(premises ? { displayedPremisesOn: premises } : {}),
              ...(website && !noWebsite ? { displayedWebsiteOn: website } : {}),
              noWebsite,
              ...(photo ? { premisesEvidenceItemId: photo.itemId } : {}),
              ...(capture ? { websiteEvidenceItemId: capture.itemId } : {}),
            },
            displaying!.version,
          );
        }}
        fields={
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Displayed at the premises on">
              <input
                type="date"
                className={input}
                value={premises}
                max={today()}
                onChange={(e) => setPremises(e.target.value)}
              />
            </Field>
            <Field label="Displayed on the website on">
              <input
                type="date"
                className={input}
                value={website}
                max={today()}
                disabled={noWebsite}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={noWebsite}
                onChange={(e) => setNoWebsite(e.target.checked)}
              />{' '}
              We have no website
            </label>
            <Field label="Photo of the premises display (optional)">
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.pdf"
                className={input}
                onChange={(e) => setPremisesFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label="Capture of the website display (optional)">
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.pdf"
                className={input}
                disabled={noWebsite}
                onChange={(e) => setWebsiteFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          </div>
        }
      >
        <p>Display dates are kept with the rating. The rating itself cannot be changed.</p>
        <p>
          A photo or capture is kept as evidence. Uploading does not make anything green: it waits
          for a different person to verify it.
        </p>
      </ActionDialog>
    </Section>
  );
}

// ---- Directors' fit and proper person checks -------------------------------------------------
const FPP_ITEMS: [string, string][] = [
  ['IDENTITY', 'Proof of identity'],
  ['DBS', 'DBS check at the right level'],
  ['BANKRUPTCY_INSOLVENCY', 'Bankruptcy and insolvency search'],
  ['DISQUALIFIED_DIRECTORS', 'Disqualified directors search'],
  ['EMPLOYMENT_HISTORY', 'Full employment history, gaps explained'],
  ['REFERENCES', 'References, including the last employer'],
  ['QUALIFICATIONS', 'Qualifications and professional registration'],
  ['HEALTH_DECLARATION', 'Health declaration (able to do the role)'],
  ['SERIOUS_MISCONDUCT', 'No serious misconduct or mismanagement found'],
];
const FPP_OUTCOME: Record<string, string> = {
  FIT: 'Fit and proper',
  NOT_FIT: 'Not fit and proper',
  FURTHER_REVIEW: 'Needs further review',
};

export function FitAndProper() {
  const { api, orgId } = useApp();
  const { run, msg } = useRun();
  const res = useOne<{ directors: Row[]; checks: Row[] }>('/api/v1/fit-and-proper');
  const [director, setDirector] = useState<{ name: string; role: string }>({ name: '', role: '' });
  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/fit-and-proper', orgId, {
          directorName: director.name,
          directorRole: director.role,
          checkedOn: String(f.get('checkedOn')),
          items: FPP_ITEMS.map(([k]) => ({ item: k, done: f.get(`item-${k}`) === 'on' })),
          ...(f.get('declarationOn') ? { declarationOn: String(f.get('declarationOn')) } : {}),
          outcome: String(f.get('outcome')),
          ...(String(f.get('notes') ?? '').trim() ? { notes: String(f.get('notes')).trim() } : {}),
        }),
      'Check recorded. The next review is due in 12 months.',
    );
    if (ok) {
      form.reset();
      setDirector({ name: '', role: '' });
    }
  }
  if (res.isError) return <p role="alert">Could not load fit and proper checks.</p>;
  return (
    <>
      <Section title="Directors: fit and proper person checks">
        <p className="text-sm">
          Each check is kept; a new check never overwrites an old one. You cannot record your own
          check. Reviews are due every 12 months.
        </p>
        <DataTable<Row>
          caption="Directors"
          rows={res.data?.directors ?? []}
          rowKey={(r) => r.directorName}
          emptyMessage="No director checks recorded."
          columns={[
            { key: 'n', header: 'Director', cell: (r) => r.directorName },
            { key: 'r', header: 'Role', cell: (r) => r.directorRole },
            {
              key: 's',
              header: 'State',
              cell: (r) => <StatusBadge status={r.state.status} reason={r.state.reasonText} />,
            },
            { key: 'c', header: 'Checks recorded', cell: (r) => String(r.checks) },
            {
              key: 'a',
              header: 'New check',
              cell: (r) => (
                <button
                  className={smallButton}
                  aria-label={`Record a new check for ${r.directorName}`}
                  onClick={() => setDirector({ name: r.directorName, role: r.directorRole })}
                >
                  New check
                </button>
              ),
            },
          ]}
        />
      </Section>
      <form
        onSubmit={record}
        aria-label="Record a fit and proper check"
        className="space-y-3 rounded border border-hub-line bg-hub-card p-3"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Director's name">
            <input
              className={input}
              required
              minLength={2}
              value={director.name}
              onChange={(e) => setDirector({ ...director, name: e.target.value })}
            />
          </Field>
          <Field label="Role (for example, chair)">
            <input
              className={input}
              required
              minLength={2}
              value={director.role}
              onChange={(e) => setDirector({ ...director, role: e.target.value })}
            />
          </Field>
          <Field label="Checked on">
            <input type="date" name="checkedOn" required max={today()} className={input} />
          </Field>
        </div>
        <fieldset className="grid gap-1 sm:grid-cols-2">
          <legend className="text-sm font-semibold">Done on this check</legend>
          {FPP_ITEMS.map(([k, text]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`item-${k}`} /> {text}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Self-declaration signed on">
            <input type="date" name="declarationOn" max={today()} className={input} />
          </Field>
          <Field label="Outcome">
            <select name="outcome" className={input} required>
              {Object.entries(FPP_OUTCOME).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes (no health details)">
            <input name="notes" className={input} maxLength={2000} />
          </Field>
        </div>
        <button className={button}>Record check</button>
        {msg}
      </form>
      <DataTable<Row>
        caption="All fit and proper checks"
        rows={res.data?.checks ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No checks recorded."
        columns={[
          { key: 'n', header: 'Director', cell: (r) => r.directorName },
          { key: 'd', header: 'Checked', cell: (r) => fmtDate(r.checkedOn) },
          { key: 'o', header: 'Outcome', cell: (r) => FPP_OUTCOME[r.outcome] ?? words(r.outcome) },
          {
            key: 'i',
            header: 'Items done',
            cell: (r) => `${r.items.filter((i: Row) => i.done).length} of ${FPP_ITEMS.length}`,
          },
          { key: 'v', header: 'Next review', cell: (r) => fmtDate(r.nextReviewDue) },
          { key: 'b', header: 'Recorded by', cell: (r) => r.recordedByName ?? 'Former member' },
        ]}
      />
    </>
  );
}

// ---- Governance meetings ---------------------------------------------------------------------
const MEETING_KINDS = [
  'BOARD',
  'CLINICAL_GOVERNANCE',
  'HEALTH_AND_SAFETY',
  'QUALITY',
  'INFECTION_CONTROL',
  'OTHER',
];

export function Meetings() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('governance.meeting.manage');
  const { run, msg } = useRun();
  const people = usePeople(manage);
  const res = useOne<{ data: Row[] }>('/api/v1/governance-meetings');
  const [open, setOpen] = useState<string | null>(null);
  const [approving, setApproving] = useState<Row | null>(null);
  const [acting, setActing] = useState<Row | null>(null);
  const [action, setAction] = useState({ title: '', owner: '', deadline: '' });
  const [approvedAt, setApprovedAt] = useState('');
  const rows = res.data?.data ?? [];
  const current = rows.find((r) => r.id === open) ?? null;
  const laterMeetings = approving
    ? rows.filter((r) => r.id !== approving.id && r.heldOn > approving.heldOn)
    : [];
  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/governance-meetings', orgId, {
          kind: String(f.get('kind')),
          title: String(f.get('title')),
          heldOn: String(f.get('heldOn')),
          chair: String(f.get('chair')),
          attendees: lines(f.get('attendees')),
          apologies: lines(f.get('apologies')),
          quorate: f.get('quorate') === 'on',
          minutes: String(f.get('minutes')),
          ...(String(f.get('decisions') ?? '').trim()
            ? { decisions: String(f.get('decisions')).trim() }
            : {}),
        }),
      'Meeting recorded as draft minutes. Someone else approves them.',
    );
    if (ok) form.reset();
  }
  if (res.isError) return <p role="alert">Could not load governance meetings.</p>;
  return (
    <>
      <MeetingPack onOpen={setOpen} />
      <DataTable<Row>
        caption="Governance meetings"
        rows={rows}
        rowKey={(r) => r.id}
        emptyMessage="No meetings recorded."
        columns={[
          { key: 'c', header: 'Reference', cell: (r) => r.code },
          { key: 't', header: 'Meeting', cell: (r) => r.title },
          { key: 'k', header: 'Type', cell: (r) => words(r.kind) },
          { key: 'h', header: 'Held', cell: (r) => fmtDate(r.heldOn) },
          {
            key: 'q',
            header: 'Quorate',
            cell: (r) =>
              r.quorate ? (
                'Yes'
              ) : (
                <StatusBadge status="AMBER" reason="Not quorate – decisions may need ratifying" />
              ),
          },
          {
            key: 's',
            header: 'Minutes',
            cell: (r) =>
              r.status === 'APPROVED' ? (
                <StatusBadge
                  status="GREEN"
                  reason={`Approved by ${r.approvedByName ?? 'a former member'}`}
                />
              ) : (
                <StatusBadge status="AMBER" reason="Draft – awaiting approval" />
              ),
          },
          {
            key: 'o',
            header: 'Open',
            cell: (r) => (
              <button
                className={smallButton}
                aria-label={`Open meeting ${r.code} ${r.title}`}
                onClick={() => setOpen(r.id)}
              >
                Open
              </button>
            ),
          },
        ]}
      />
      {current && (
        <Section
          title={`${current.code}: ${current.title}`}
          actions={
            <button className={smallButton} onClick={() => setOpen(null)}>
              Close meeting
            </button>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-semibold">Chair</dt>
            <dd>{current.chair}</dd>
            <dt className="font-semibold">Attended</dt>
            <dd>{current.attendees.join(', ') || 'Not recorded'}</dd>
            <dt className="font-semibold">Apologies</dt>
            <dd>{current.apologies.join(', ') || 'None'}</dd>
            <dt className="font-semibold">Minutes</dt>
            <dd className="whitespace-pre-wrap">{current.minutes}</dd>
            <dt className="font-semibold">Decisions</dt>
            <dd className="whitespace-pre-wrap">{current.decisions ?? 'None recorded'}</dd>
            <dt className="font-semibold">Written by</dt>
            <dd>{current.recordedByName ?? 'Former member'}</dd>
            {current.approvedAt && (
              <>
                <dt className="font-semibold">Approved</dt>
                <dd>
                  {fmtDateTime(current.approvedAt)} by {current.approvedByName ?? 'former member'}
                </dd>
                <dt className="font-semibold">Agreed at</dt>
                <dd>
                  {current.approvedAtMeetingCode
                    ? `Meeting ${current.approvedAtMeetingCode}`
                    : 'Meeting not recorded'}
                </dd>
              </>
            )}
          </dl>
          <DataTable<Row>
            caption={`Actions from ${current.code}`}
            rows={current.actions}
            rowKey={(a) => a.id}
            emptyMessage="No actions raised from this meeting."
            columns={[
              { key: 'c', header: 'Reference', cell: (a) => a.code },
              { key: 't', header: 'Action', cell: (a) => a.title },
              { key: 'o', header: 'Owner', cell: (a) => a.ownerName ?? 'Former member' },
              { key: 'd', header: 'Deadline', cell: (a) => fmtDate(a.deadline) },
              { key: 's', header: 'Status', cell: (a) => words(a.status) },
            ]}
          />
          {manage && (
            <div className="flex flex-wrap gap-2">
              <button
                className={smallButton}
                onClick={() => {
                  setAction({ title: '', owner: me.user.id, deadline: '' });
                  setActing(current);
                }}
              >
                Raise an action from {current.code}
              </button>
              {current.status === 'DRAFT' &&
                (current.recordedBy === me.user.id ? (
                  <p className="text-sm">
                    You wrote these minutes, so someone else must approve them.
                  </p>
                ) : (
                  <button
                    className={smallButton}
                    onClick={() => {
                      setApprovedAt('');
                      setApproving(current);
                    }}
                  >
                    Approve minutes of {current.code}
                  </button>
                ))}
            </div>
          )}
        </Section>
      )}
      {manage && (
        <form
          onSubmit={record}
          aria-label="Record a meeting"
          className="grid gap-3 rounded border border-hub-line bg-hub-card p-3 sm:grid-cols-2"
        >
          <Field label="Type of meeting">
            <select name="kind" className={input} required>
              {MEETING_KINDS.map((k) => (
                <option key={k} value={k}>
                  {words(k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input name="title" className={input} required minLength={3} maxLength={200} />
          </Field>
          <Field label="Held on">
            <input type="date" name="heldOn" required max={today()} className={input} />
          </Field>
          <Field label="Chair">
            <input name="chair" className={input} required minLength={2} maxLength={120} />
          </Field>
          <Field label="Attended (one name per line)">
            <textarea name="attendees" className={input} rows={3} />
          </Field>
          <Field label="Apologies (one name per line)">
            <textarea name="apologies" className={input} rows={3} />
          </Field>
          <Field label="Minutes">
            <textarea name="minutes" className={input} rows={5} required minLength={3} />
          </Field>
          <Field label="Decisions">
            <textarea name="decisions" className={input} rows={5} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="quorate" /> The meeting was quorate
          </label>
          <div className="flex items-end">
            <button className={button}>Record meeting</button>
          </div>
        </form>
      )}
      {msg}
      <ActionDialog
        open={approving !== null}
        title={`Approve minutes of ${approving?.code ?? ''} ${approving?.title ?? ''}`}
        confirmLabel="Approve minutes"
        onCancel={() => setApproving(null)}
        onConfirm={() =>
          api.send(
            'POST',
            `/api/v1/governance-meetings/${approving!.id}/approve`,
            orgId,
            approvedAt ? { approvedAtMeetingId: approvedAt } : {},
            approving!.version,
          )
        }
        fields={
          laterMeetings.length > 0 ? (
            <Field label="Agreed at which meeting?">
              <select
                className={input}
                value={approvedAt}
                onChange={(e) => setApprovedAt(e.target.value)}
              >
                <option value="">Not recorded</option>
                {laterMeetings.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} {m.title} (held {fmtDate(m.heldOn)})
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p className="text-sm">
              No later meeting is recorded yet. Minutes are normally agreed at the next meeting:
              record that meeting first if you want to name it here.
            </p>
          )
        }
      >
        <p>Approved minutes are frozen. Your name and the time are recorded.</p>
      </ActionDialog>
      <ActionDialog
        open={acting !== null}
        title={`Raise an action from ${acting?.code ?? ''}`}
        confirmLabel="Raise action"
        confirmDisabled={action.title.trim().length < 3 || !action.deadline || !action.owner}
        onCancel={() => setActing(null)}
        onConfirm={() =>
          api.send('POST', `/api/v1/governance-meetings/${acting!.id}/actions`, orgId, {
            title: action.title.trim(),
            ownerUserId: action.owner,
            deadline: action.deadline,
          })
        }
        fields={
          <div className="grid gap-3">
            <Field label="What needs doing?">
              <input
                className={input}
                value={action.title}
                onChange={(e) => setAction({ ...action, title: e.target.value })}
              />
            </Field>
            <PersonSelect
              label="Owner"
              value={action.owner}
              onChange={(id) => setAction({ ...action, owner: id })}
              people={people}
              meId={me.user.id}
            />
            <Field label="Deadline">
              <input
                type="date"
                className={input}
                min={today()}
                value={action.deadline}
                onChange={(e) => setAction({ ...action, deadline: e.target.value })}
              />
            </Field>
          </div>
        }
      >
        <p>The action joins the action log. It closes only when someone verifies the evidence.</p>
      </ActionDialog>
    </>
  );
}

/**
 * I3: agenda figures for the next meeting, read from live records when asked (the server logs
 * each request, so it is built on demand rather than on page load).
 */
function MeetingPack({ onOpen }: { onOpen: (id: string) => void }) {
  const { api, orgId } = useApp();
  const [pack, setPack] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function build() {
    setBusy(true);
    setError('');
    try {
      setPack((await api.get('/api/v1/governance-meetings/pack', orgId)) as Row);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const attention = (n: number, word: string) =>
    n > 0 ? (
      <StatusBadge status="RED" reason={`${n} ${word}`} />
    ) : (
      <StatusBadge status="GREEN" reason={`None ${word}`} />
    );
  const figures: { area: string; figures: string; flag: ReturnType<typeof attention> | string }[] =
    pack
      ? [
          {
            area: 'Incidents',
            figures: `${pack.incidents.opened} reported since, ${pack.incidents.open} still open`,
            flag: '',
          },
          {
            area: 'Complaints',
            figures: `${pack.complaints.opened} received since, ${pack.complaints.open} still open`,
            flag: '',
          },
          {
            area: 'Actions',
            figures: `${pack.actions.open} open`,
            flag: attention(pack.actions.overdue, 'overdue'),
          },
          {
            area: 'Audits',
            figures: `${pack.audits.submitted} submitted since, ${pack.audits.nonCompliant} not compliant`,
            flag: attention(pack.audits.overdue, 'overdue'),
          },
          {
            area: 'Risks',
            figures: `${pack.risks.open} open, ${pack.risks.high} high or extreme`,
            flag: attention(pack.risks.reviewOverdue, 'with review overdue'),
          },
          {
            area: 'CQC notifications',
            figures: `${pack.notifications.drafts} in draft`,
            flag: attention(pack.notifications.overdue, 'overdue'),
          },
          {
            area: 'Policies',
            figures: 'Published policies past their review date',
            flag: attention(pack.policies.reviewOverdue, 'past review'),
          },
        ]
      : [];
  return (
    <Section
      title="Meeting pack"
      actions={
        <button className={smallButton} disabled={busy} onClick={() => void build()}>
          {busy ? 'Building…' : pack ? 'Rebuild the meeting pack' : 'Build the meeting pack'}
        </button>
      }
    >
      <p className="text-sm">
        Figures for the next meeting&rsquo;s agenda, taken from live records since the last meeting.
        Counts only: no names or patient details.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-900">
          {error}
        </p>
      )}
      {pack && (
        <>
          <p className="text-sm">
            Since {fmtDate(pack.sinceOn)}. Built {fmtDateTime(pack.generatedAt)}.
          </p>
          <DataTable<(typeof figures)[number]>
            caption="Meeting pack figures"
            rows={figures}
            rowKey={(l) => l.area}
            columns={[
              { key: 'a', header: 'Area', cell: (l) => l.area },
              { key: 'f', header: 'Figures', cell: (l) => l.figures },
              { key: 'x', header: 'Needs attention', cell: (l) => l.flag },
            ]}
          />
          <DataTable<Row>
            caption="Minutes waiting to be agreed"
            rows={pack.previousDraftMinutes as Row[]}
            rowKey={(m) => m.id}
            emptyMessage="No draft minutes are waiting."
            columns={[
              { key: 'c', header: 'Meeting', cell: (m) => m.code },
              { key: 'h', header: 'Held', cell: (m) => fmtDate(m.heldOn) },
              {
                key: 'o',
                header: 'Open',
                cell: (m) => (
                  <button
                    className={smallButton}
                    aria-label={`Open minutes of ${m.code}`}
                    onClick={() => onOpen(m.id)}
                  >
                    Open
                  </button>
                ),
              },
            ]}
          />
          <DataTable<Row>
            caption="Open actions from earlier meetings"
            rows={pack.openMeetingActions as Row[]}
            rowKey={(a) => a.id}
            emptyMessage="No open actions from earlier meetings."
            columns={[
              { key: 'c', header: 'Reference', cell: (a) => a.code },
              { key: 't', header: 'Action', cell: (a) => a.title },
              { key: 'd', header: 'Deadline', cell: (a) => fmtDate(a.deadline) },
            ]}
          />
        </>
      )}
    </Section>
  );
}

// ---- NHS contracts (task 22) -----------------------------------------------------------------
const CONTRACT_TYPE: Record<string, string> = {
  NHS_STANDARD_FULL: 'NHS Standard Contract (full length)',
  NHS_STANDARD_SHORTFORM: 'NHS Standard Contract (shorter form)',
  SUBCONTRACT: 'Subcontract',
  OTHER: 'Other',
};
const REPORTING: Record<string, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  ANNUAL: 'Annual',
  NONE: 'None',
};

export function NhsContracts() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can(REG);
  const { run, msg } = useRun();
  const people = usePeople(manage);
  const res = useOne<Row>('/api/v1/nhs-contracts');
  const [manager, setManager] = useState(me.user.id);
  const [editing, setEditing] = useState<Row | null>(null);
  const [endOn, setEndOn] = useState('');
  const [notice, setNotice] = useState('6');
  const data = res.data;
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/nhs-contracts', orgId, {
          commissioner: String(f.get('commissioner')),
          reference: String(f.get('reference')),
          service: String(f.get('service')),
          contractType: String(f.get('contractType')),
          startOn: String(f.get('startOn')),
          endOn: String(f.get('endOn')),
          noticeMonths: Number(f.get('noticeMonths')),
          reporting: String(f.get('reporting')),
          managerUserId: manager,
          ...(f.get('reviewMeetingOn')
            ? { reviewMeetingOn: String(f.get('reviewMeetingOn')) }
            : {}),
        }),
      'Contract recorded.',
    );
    if (ok) form.reset();
  }
  if (res.isError) return <p role="alert">Could not load NHS contracts.</p>;
  if (!data) return <p role="status">Loading…</p>;
  const s = data.summary;
  return (
    <>
      <Section title="NHS contracts">
        <DataTable<Row>
          caption="NHS contracts held"
          rows={data.contracts}
          rowKey={(r) => r.id}
          emptyMessage="No NHS contracts recorded."
          columns={[
            { key: 'r', header: 'Reference', cell: (r) => r.reference },
            { key: 'c', header: 'Commissioner', cell: (r) => r.commissioner },
            { key: 's', header: 'Service', cell: (r) => r.service },
            {
              key: 't',
              header: 'Type',
              cell: (r) => CONTRACT_TYPE[r.contractType] ?? words(r.contractType),
            },
            {
              key: 'd',
              header: 'Term',
              cell: (r) => `${fmtDate(r.startOn)} to ${fmtDate(r.endOn)}`,
            },
            {
              key: 'n',
              header: 'Notice by',
              cell: (r) => (r.noticeBy ? fmtDate(r.noticeBy) : 'No notice period'),
            },
            {
              key: 'st',
              header: 'State',
              cell: (r) => <StatusBadge status={r.state.status} reason={r.state.reasonText} />,
            },
            { key: 'm', header: 'Contract manager', cell: (r) => r.managerName ?? 'Former member' },
            {
              key: 'e',
              header: 'Change',
              cell: (r) =>
                manage ? (
                  <button
                    className={smallButton}
                    aria-label={`Change contract ${r.reference}`}
                    onClick={() => {
                      setEndOn(r.endOn);
                      setNotice(String(r.noticeMonths));
                      setEditing(r);
                    }}
                  >
                    Change
                  </button>
                ) : null,
            },
          ]}
        />
      </Section>
      <Section title="NHS contract items">
        <p className="text-sm">
          {s.total === 0
            ? 'No NHS contract items are in use yet.'
            : `${s.met} of ${s.total - s.notApplicable} item(s) met with verified evidence; ${s.notMet} not met.`}{' '}
          {data.notAdopted > 0 &&
            `${data.notAdopted} item(s) from the NHS contract library are not adopted yet (Settings, Library).`}{' '}
          Check every item against your own contract.
        </p>
        <DataTable<Row>
          caption="NHS contract items"
          rows={data.items}
          rowKey={(r) => r.instanceId}
          emptyMessage="No NHS contract items."
          columns={[
            { key: 't', header: 'Item', cell: (r) => r.title },
            {
              key: 's',
              header: 'Status',
              cell: (r) => <StatusBadge status={r.status} reason={r.reasonText} />,
            },
            { key: 'd', header: 'Due', cell: (r) => (r.dueDate ? fmtDate(r.dueDate) : 'Not set') },
            { key: 'o', header: 'Owner', cell: (r) => r.ownerName ?? 'Nobody yet' },
          ]}
        />
      </Section>
      {manage && (
        <form
          onSubmit={add}
          aria-label="Record an NHS contract"
          className="grid gap-3 rounded border border-hub-line bg-hub-card p-3 sm:grid-cols-3"
        >
          <Field label="Commissioner">
            <input name="commissioner" className={input} required minLength={2} maxLength={200} />
          </Field>
          <Field label="Contract reference">
            <input name="reference" className={input} required minLength={2} maxLength={60} />
          </Field>
          <Field label="Service">
            <input name="service" className={input} required minLength={2} maxLength={200} />
          </Field>
          <Field label="Contract type">
            <select name="contractType" className={input}>
              {Object.entries(CONTRACT_TYPE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Starts on">
            <input type="date" name="startOn" required className={input} />
          </Field>
          <Field label="Ends on">
            <input type="date" name="endOn" required className={input} />
          </Field>
          <Field label="Notice period (months)">
            <input
              type="number"
              name="noticeMonths"
              min={0}
              max={24}
              defaultValue={6}
              className={input}
            />
          </Field>
          <Field label="Reporting to the commissioner">
            <select name="reporting" className={input}>
              {Object.entries(REPORTING).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Next contract review meeting">
            <input type="date" name="reviewMeetingOn" className={input} />
          </Field>
          <PersonSelect
            label="Contract manager"
            value={manager}
            onChange={setManager}
            people={people}
            meId={me.user.id}
          />
          <div className="flex items-end">
            <button className={button}>Record contract</button>
          </div>
        </form>
      )}
      {msg}
      <ActionDialog
        open={editing !== null}
        title={`Change contract ${editing?.reference ?? ''}`}
        confirmLabel="Save changes"
        confirmDisabled={!endOn}
        onCancel={() => setEditing(null)}
        onConfirm={() =>
          api.send(
            'PATCH',
            `/api/v1/nhs-contracts/${editing!.id}`,
            orgId,
            { endOn, noticeMonths: Number(notice) },
            editing!.version,
          )
        }
        fields={
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ends on">
              <input
                type="date"
                className={input}
                value={endOn}
                onChange={(e) => setEndOn(e.target.value)}
              />
            </Field>
            <Field label="Notice period (months)">
              <input
                type="number"
                min={0}
                max={24}
                className={input}
                value={notice}
                onChange={(e) => setNotice(e.target.value)}
              />
            </Field>
          </div>
        }
      >
        <p>For an extension or variation, record the new end date. The change is audited.</p>
      </ActionDialog>
    </>
  );
}

// ---- CQC statutory notification drafts -------------------------------------------------------
const NOTIFICATION_KIND: Record<string, string> = {
  DEATH: 'Death of a person using the service',
  SERIOUS_INJURY: 'Serious injury',
  ABUSE_ALLEGATION: 'Abuse or allegation of abuse',
  POLICE_INCIDENT: 'Incident reported to or investigated by the police',
  SERVICE_DISRUPTION: 'Event that stops the service running safely',
  MANAGER_ABSENCE: 'Registered manager absence (28 days or more)',
  CHANGE_OF_DETAILS: 'Change of provider details',
  OTHER: 'Other notification',
};
export function Notifications() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const manage = can('events.event.manage');
  const { run, msg } = useRun();
  const res = useOne<{ data: Row[] }>('/api/v1/cqc-notifications');
  const suggestions = useOne<{ data: Row[] }>('/api/v1/cqc-notifications/suggestions');
  const [kind, setKind] = useState('SERIOUS_INJURY');
  const [eventId, setEventId] = useState('');
  const [occurredOn, setOccurredOn] = useState('');
  const [moving, setMoving] = useState<{ n: Row; to: string } | null>(null);
  const [submittedOn, setSubmittedOn] = useState('');
  const [reference, setReference] = useState('');
  async function draft(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    const ok = await run(
      () =>
        api.send('POST', '/api/v1/cqc-notifications', orgId, {
          kind,
          ...(eventId ? { eventId } : {}),
          occurredOn,
          planned: f.get('planned') === 'on',
          summary: String(f.get('summary')),
          ...(String(f.get('actionsTaken') ?? '').trim()
            ? { actionsTaken: String(f.get('actionsTaken')).trim() }
            : {}),
        }),
      'Draft saved. Someone else reviews it before it is submitted through the CQC portal.',
    );
    if (ok) {
      form.reset();
      setEventId('');
      setOccurredOn('');
    }
  }
  const moveTitle = (m: { n: Row; to: string }) =>
    ({
      READY: `Review ${m.n.code} as ready to submit`,
      DRAFT: `Return ${m.n.code} to draft`,
      SUBMITTED: `Record that ${m.n.code} was submitted to CQC`,
      NOT_REQUIRED: `Mark ${m.n.code} as not required`,
    })[m.to] ?? m.n.code;
  if (res.isError) return <p role="alert">Could not load notifications.</p>;
  return (
    <>
      <p className="text-sm">
        The hub drafts notifications; it never sends them. Submit through the CQC provider portal,
        then record the date and CQC&apos;s reference here. Do not name patients: use the event
        reference.
      </p>
      {(suggestions.data?.data ?? []).length > 0 && (
        <Section title="Events that may need a notification">
          <ul className="list-disc pl-5 text-sm">
            {suggestions.data!.data.map((s) => (
              <li key={s.eventId}>
                {s.eventCode}: {s.title} ({fmtDate(s.occurredOn)}) –{' '}
                {NOTIFICATION_KIND[s.kind] ?? words(s.kind)}
                {manage && (
                  <button
                    className={`${smallButton} ml-2`}
                    aria-label={`Draft a notification for ${s.eventCode}`}
                    onClick={() => {
                      setKind(s.kind);
                      setEventId(s.eventId);
                      setOccurredOn(s.occurredOn);
                    }}
                  >
                    Draft
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <DataTable<Row>
        caption="CQC notifications"
        rows={res.data?.data ?? []}
        rowKey={(r) => r.id}
        emptyMessage="No notifications drafted."
        columns={[
          { key: 'c', header: 'Reference', cell: (r) => r.code },
          { key: 'k', header: 'Type', cell: (r) => NOTIFICATION_KIND[r.kind] ?? words(r.kind) },
          { key: 'e', header: 'Event', cell: (r) => r.eventCode ?? 'None' },
          {
            key: 's',
            header: 'Status',
            cell: (r) => <StatusBadge status={r.state.status} reason={r.state.reasonText} />,
          },
          {
            key: 'w',
            header: 'Who',
            cell: (r) =>
              [
                `Prepared by ${r.preparedByName ?? 'former member'}`,
                r.reviewedByName ? `reviewed by ${r.reviewedByName}` : null,
                r.cqcReference ? `CQC reference ${r.cqcReference}` : null,
              ]
                .filter(Boolean)
                .join('; '),
          },
          {
            key: 'a',
            header: 'Next step',
            cell: (r) =>
              !manage ? null : (
                <div className="flex flex-wrap gap-1">
                  {r.status === 'DRAFT' && r.preparedBy !== me.user.id && (
                    <button
                      className={smallButton}
                      aria-label={`Review ${r.code}`}
                      onClick={() => setMoving({ n: r, to: 'READY' })}
                    >
                      Review
                    </button>
                  )}
                  {r.status === 'DRAFT' && r.preparedBy === me.user.id && (
                    <span className="text-sm">Someone else must review this.</span>
                  )}
                  {r.status === 'DRAFT' && (
                    <button
                      className={smallButton}
                      aria-label={`Mark ${r.code} not required`}
                      onClick={() => setMoving({ n: r, to: 'NOT_REQUIRED' })}
                    >
                      Not required
                    </button>
                  )}
                  {r.status === 'READY' && (
                    <>
                      <button
                        className={smallButton}
                        aria-label={`Record submission of ${r.code}`}
                        onClick={() => {
                          setSubmittedOn(today());
                          setReference('');
                          setMoving({ n: r, to: 'SUBMITTED' });
                        }}
                      >
                        Record submission
                      </button>
                      <button
                        className={smallButton}
                        aria-label={`Return ${r.code} to draft`}
                        onClick={() => setMoving({ n: r, to: 'DRAFT' })}
                      >
                        Return to draft
                      </button>
                    </>
                  )}
                </div>
              ),
          },
        ]}
      />
      {manage && (
        <form
          onSubmit={draft}
          aria-label="Draft a CQC notification"
          className="grid gap-3 rounded border border-hub-line bg-hub-card p-3 sm:grid-cols-2"
        >
          <Field label="Type of notification">
            <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(NOTIFICATION_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label={kind === 'MANAGER_ABSENCE' ? 'Absence starts on' : 'Happened on'}>
            <input
              type="date"
              required
              className={input}
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </Field>
          {kind === 'MANAGER_ABSENCE' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="planned" /> The absence is planned
            </label>
          )}
          {eventId && <p className="text-sm">Linked to the event you chose.</p>}
          <Field label="What happened (no names or NHS numbers)">
            <textarea name="summary" className={input} rows={4} required minLength={10} />
          </Field>
          <Field label="What has been done">
            <textarea name="actionsTaken" className={input} rows={4} />
          </Field>
          <div className="flex items-end">
            <button className={button}>Save draft</button>
          </div>
        </form>
      )}
      {msg}
      <ActionDialog
        open={moving !== null}
        title={moving ? moveTitle(moving) : ''}
        confirmLabel={moving?.to === 'SUBMITTED' ? 'Record submission' : 'Confirm'}
        danger={moving?.to === 'NOT_REQUIRED'}
        reasonLabel={moving?.to === 'NOT_REQUIRED' ? 'Why is no notification needed?' : undefined}
        confirmDisabled={
          moving?.to === 'SUBMITTED' && (!submittedOn || reference.trim().length < 2)
        }
        onCancel={() => setMoving(null)}
        onConfirm={(reason) =>
          api.send(
            'POST',
            `/api/v1/cqc-notifications/${moving!.n.id}/transition`,
            orgId,
            moving!.to === 'SUBMITTED'
              ? { to: 'SUBMITTED', submittedOn, cqcReference: reference.trim() }
              : moving!.to === 'NOT_REQUIRED'
                ? { to: 'NOT_REQUIRED', reason }
                : { to: moving!.to },
            moving!.n.version,
          )
        }
        fields={
          moving?.to === 'SUBMITTED' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Submitted on">
                <input
                  type="date"
                  className={input}
                  max={today()}
                  value={submittedOn}
                  onChange={(e) => setSubmittedOn(e.target.value)}
                />
              </Field>
              <Field label="CQC reference">
                <input
                  className={input}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </Field>
            </div>
          ) : undefined
        }
      >
        <p>
          {moving?.to === 'READY'
            ? 'You confirm the draft is accurate and has no patient identifiers.'
            : moving?.to === 'SUBMITTED'
              ? 'Record this only after submitting through the CQC portal.'
              : 'The change and your name are recorded.'}
        </p>
      </ActionDialog>
    </>
  );
}
