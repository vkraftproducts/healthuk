import { RecordPayloads, type RecordKind } from '@hub/contracts';
import { useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import type { z } from 'zod';
import { useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { UploadDialog } from '../evidence/Evidence.js';
import { useList, useOne, usePeople } from '../settings/hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Builds a form from the same zod schema the API validates with, so the UI can never drift from
 * the contract. Only simple field types are rendered; nested objects are entered as text.
 */
type Field =
  | { name: string; kind: 'text' | 'date' | 'number' | 'list' | 'bool'; required: boolean }
  | { name: string; kind: 'enum'; options: string[]; required: boolean };

interface Def {
  type: string;
  innerType?: { _zod: { def: Def } };
  entries?: Record<string, string>;
  element?: { _zod: { def: Def } };
}
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

export function fieldsOf(kind: RecordKind): Field[] {
  const shape = (RecordPayloads[kind] as unknown as z.ZodObject).shape as Record<string, unknown>;
  return Object.entries(shape).flatMap(([name, schema]): Field[] => {
    let d = defOf(schema);
    let required = true;
    while ((d.type === 'optional' || d.type === 'default') && d.innerType) {
      required = false;
      d = d.innerType._zod.def;
    }
    if (d.type === 'enum')
      return [{ name, kind: 'enum', options: Object.values(d.entries ?? {}), required }];
    if (d.type === 'boolean') return [{ name, kind: 'bool', required: false }];
    if (d.type === 'number') return [{ name, kind: 'number', required }];
    if (d.type === 'array') return [{ name, kind: 'list', required }];
    if (d.type === 'object') return []; // nested (e.g. next of kin): edited elsewhere
    const dateLike = /(On|Date|Expiry|^from$|^to$)$/.test(name);
    return [{ name, kind: dateLike ? 'date' : 'text', required }];
  });
}

/** Professional wording for each field (finding 49); never the internal field name. */
const FIELD_LABEL: Record<string, string> = {
  refereeName: 'Referee name',
  refereeOrganisation: 'Referee organisation',
  relationship: 'Relationship to the candidate',
  requestedOn: 'Date requested',
  receivedOn: 'Date received',
  outcome: 'Outcome',
  alternativeRationale: 'Why an alternative referee was accepted',
  eligibility: 'Level of check',
  barredListChecked: 'Barred list checked',
  certificateNumber: 'Certificate number (12 digits)',
  issueDate: 'Issue date',
  updateServiceConsent: 'Consent to Update Service checks',
  riskDecision: 'Recruitment decision',
  policyReviewDate: 'Local policy review date',
  method: 'How the check was done',
  checkedOn: 'Date checked',
  checkerUserId: 'Checked by',
  restrictions: 'Work restrictions',
  followUpOn: 'Follow-up check date',
  categories: 'Licence categories held',
  restrictionCodes: 'Restriction codes (comma separated, for example 01, 78)',
  photocardExpiry: 'Photocard expiry date',
  lastCheckedOn: 'Date the licence was last checked',
  checkMethod: 'How the licence was checked',
  penaltyPoints: 'Penalty points',
  body: 'Registration body',
  number: 'Registration number',
  expiresOn: 'Expiry date',
  indemnityConfirmed: 'Indemnity cover confirmed',
  courseCode: 'Course code',
  title: 'Title',
  completedOn: 'Date completed',
  provider: 'Training provider',
  code: 'Competency',
  assessedOn: 'Date assessed',
  assessorUserId: 'Assessed by',
  heldOn: 'Date held',
  supervisorUserId: 'Supervisor',
  nextDueOn: 'Next due',
  summary: 'Summary (no clinical detail)',
  appraiserUserId: 'Appraiser',
  dueOn: 'Due date',
  status: 'Status',
  employer: 'Employer',
  role: 'Job title',
  from: 'From',
  to: 'To',
  gapExplanation: 'Explanation of any gap before this job',
  careRole: 'Worked with children or vulnerable adults',
  reasonForLeaving: 'Reason for leaving',
  signedOffByUserId: 'Signed off by',
  startOn: 'Start date',
  endOn: 'End date',
  fitStatus: 'Fitness for work',
  reviewOn: 'Review date',
  notes: 'Occupational health notes',
  adjustments: 'Adjustments',
  dateOfBirth: 'Date of birth',
  address: 'Home address',
  phone: 'Phone number',
};
const OPTION_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  SATISFACTORY: 'Satisfactory',
  UNSATISFACTORY: 'Unsatisfactory',
  BASIC: 'Basic',
  STANDARD: 'Standard',
  ENHANCED: 'Enhanced',
  ENHANCED_BARRED: 'Enhanced with barred list',
  CLEAR: 'Clear',
  ACCEPTED_WITH_RISK_ASSESSMENT: 'Accepted with a risk assessment',
  NOT_ACCEPTED: 'Not accepted',
  MANUAL_DOCUMENT: 'Original documents seen',
  IDVT: 'Identity document validation technology (IDVT)',
  HOME_OFFICE_SHARE_CODE: 'Home Office share code',
  DVLA_SHARE_CODE: 'DVLA share code',
  DVLA_API: 'DVLA online check',
  MANUAL: 'Licence seen in person',
  HCPC: 'Health and Care Professions Council (HCPC)',
  NMC: 'Nursing and Midwifery Council (NMC)',
  GMC: 'General Medical Council (GMC)',
  GDC: 'General Dental Council (GDC)',
  OTHER: 'Other',
  COMPETENT: 'Competent',
  NOT_YET_COMPETENT: 'Not yet competent',
  OPEN: 'Open',
  MET: 'Met',
  NOT_MET: 'Not met',
  IN_PROGRESS: 'In progress',
  PASSED: 'Passed',
  EXTENDED: 'Extended',
  FAILED: 'Failed',
  FIT: 'Fit',
  FIT_WITH_ADJUSTMENTS: 'Fit with adjustments',
  UNFIT: 'Not fit',
};
/** Lists with a fixed set of answers are ticked, not typed. */
const LIST_OPTIONS: Record<string, string[]> = {
  categories: ['B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE', 'AM', 'A1', 'A2', 'A'],
};
const CATEGORY_HINT: Record<string, string> = {
  B: 'B – car',
  BE: 'BE – car and trailer',
  C1: 'C1 – 3.5 to 7.5 tonnes',
  D1: 'D1 – minibus',
};
const label = (n: string) =>
  FIELD_LABEL[n] ??
  n
    .replace(/UserId$/, '')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
const optionText = (o: string) =>
  OPTION_LABEL[o] ??
  o
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
const box = 'rounded-md border border-slate-500 bg-white px-2.5 py-1.5';

export function RecordForm({
  kind,
  onSubmit,
}: {
  kind: RecordKind;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const { me } = useApp();
  const can = useCan();
  const { id: staffId } = useParams({ strict: false }) as { id?: string };
  const fields = fieldsOf(kind);
  const hasPerson = fields.some((f) => f.name.endsWith('UserId'));
  const people = usePeople(hasPerson);
  const catalogue = useList(
    '/api/v1/requirements/templates',
    kind === 'TRAINING' && can('compliance.requirement.view'),
  );
  const courses = (catalogue.data ?? []).filter(
    (t) =>
      !t.isLibrary &&
      (t.versions as Row[]).some((v) => v.subjectType === 'STAFF' && v.status === 'EFFECTIVE'),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [course, setCourse] = useState({ code: '', title: '' });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const data: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const fd of fields) {
      if (fd.kind === 'bool') {
        data[fd.name] = f.get(fd.name) === 'on';
        continue;
      }
      if (fd.kind === 'list' && LIST_OPTIONS[fd.name]) {
        const picked = f.getAll(fd.name).map(String);
        if (picked.length) data[fd.name] = picked;
        else if (fd.required) missing.push(label(fd.name));
        continue;
      }
      const raw = f.get(fd.name);
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) {
        if (fd.required) missing.push(label(fd.name));
        continue;
      }
      if (fd.kind === 'number') data[fd.name] = Number(v);
      else if (fd.kind === 'list')
        data[fd.name] = v
          .split(',')
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean);
      else if (fd.name === 'courseCode' || fd.name === 'code') data[fd.name] = v.toUpperCase();
      else data[fd.name] = v;
    }
    if (missing.length) {
      setProblem(`Fill in: ${missing.join(', ')}.`);
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      await onSubmit(data);
      form.reset();
      setCourse({ code: '', title: '' });
    } finally {
      setBusy(false);
    }
  }
  const control = (fd: Field) => {
    if (fd.kind === 'enum')
      return (
        <select name={fd.name} className={box} defaultValue={fd.required ? undefined : ''}>
          {!fd.required && <option value="">Not set</option>}
          {fd.options.map((o) => (
            <option key={o} value={o}>
              {optionText(o)}
            </option>
          ))}
        </select>
      );
    if (fd.name.endsWith('UserId'))
      return (
        <select name={fd.name} className={box} defaultValue={fd.required ? me.user.id : ''}>
          {!fd.required && <option value="">Not recorded</option>}
          {people.length === 0 && <option value={me.user.id}>Me</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === me.user.id ? `Me (${p.displayName})` : p.displayName}
            </option>
          ))}
        </select>
      );
    if (kind === 'TRAINING' && fd.name === 'courseCode')
      return (
        <input
          name="courseCode"
          className={box}
          value={course.code}
          onChange={(e) => setCourse({ ...course, code: e.target.value })}
        />
      );
    if (kind === 'TRAINING' && fd.name === 'title')
      return (
        <input
          name="title"
          className={box}
          value={course.title}
          onChange={(e) => setCourse({ ...course, title: e.target.value })}
        />
      );
    return (
      <input
        name={fd.name}
        type={fd.kind === 'date' ? 'date' : fd.kind === 'number' ? 'number' : 'text'}
        className={box}
      />
    );
  };
  return (
    <>
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        aria-label={`Add ${kind.toLowerCase().replace(/_/g, ' ')} record`}
      >
        {kind === 'TRAINING' && courses.length > 0 && (
          <label className="flex flex-col text-sm sm:col-span-2">
            <span>Course from your training catalogue</span>
            <select
              className={box}
              value={String(courses.find((c) => c.code === course.code)?.id ?? '')}
              onChange={(e) => {
                const c = courses.find((x) => x.id === e.target.value);
                setCourse(c ? { code: String(c.code), title: String(c.title) } : course);
              }}
            >
              <option value="">Not in the catalogue (type the course below)</option>
              {courses.map((c) => (
                <option key={c.id as string} value={c.id as string}>
                  {c.title as string}
                </option>
              ))}
            </select>
          </label>
        )}
        {fields.map((fd) =>
          fd.kind === 'list' && LIST_OPTIONS[fd.name] ? (
            <fieldset key={fd.name} className="text-sm sm:col-span-2">
              <legend>
                {label(fd.name)}
                {fd.required ? ' (required)' : ' (optional)'}
              </legend>
              <div className="flex flex-wrap gap-3">
                {LIST_OPTIONS[fd.name]!.map((o) => (
                  <label key={o} className="flex items-center gap-1">
                    <input type="checkbox" name={fd.name} value={o} />
                    {CATEGORY_HINT[o] ?? o}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <label
              key={fd.name}
              className={
                fd.kind === 'bool' ? 'flex items-center gap-2 text-sm' : 'flex flex-col text-sm'
              }
            >
              {fd.kind === 'bool' ? <input type="checkbox" name={fd.name} /> : null}
              <span>
                {label(fd.name)}
                {fd.kind === 'bool' ? '' : fd.required ? ' (required)' : ' (optional)'}
                {fd.kind === 'list' && !FIELD_LABEL[fd.name] ? ' (comma separated)' : ''}
              </span>
              {fd.kind === 'bool' ? null : control(fd)}
            </label>
          ),
        )}
        {problem && (
          <p
            role="alert"
            className="rounded border border-red-700 bg-red-50 p-2 text-sm text-red-900 sm:col-span-2"
          >
            {problem}
          </p>
        )}
        <div className="sm:col-span-2">
          <button
            disabled={busy}
            className="rounded-md bg-hub-teal px-4 py-2 text-sm font-semibold text-white hover:bg-hub-teal-dark disabled:opacity-50"
          >
            Save record
          </button>
        </div>
      </form>
      {staffId && can('compliance.evidence.upload') && can('compliance.requirement.view') && (
        <CertificateUpload staffId={staffId} courseCode={course.code} />
      )}
    </>
  );
}

/**
 * Upload the certificate against this person's matching requirement (finding 49). The upload
 * waits for someone else to verify it; it never turns the requirement green by itself.
 */
function CertificateUpload({ staffId, courseCode }: { staffId: string; courseCode: string }) {
  const res = useOne<{ data: Row[] }>(
    `/api/v1/requirements/instances?subjectId=${staffId}&limit=100`,
  );
  const [chosen, setChosen] = useState('');
  const [target, setTarget] = useState<Row | null>(null);
  const reqs = res.data?.data ?? [];
  if (reqs.length === 0) return null;
  const match = reqs.find((r) => courseCode && r.templateCode === courseCode.toUpperCase());
  const pick = reqs.find((r) => r.id === (chosen || match?.id)) ?? null;
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-hub-line bg-white p-3">
      <label className="flex flex-col text-sm">
        Upload a certificate for
        <select className={box} value={pick?.id ?? ''} onChange={(e) => setChosen(e.target.value)}>
          <option value="">Choose the requirement it proves</option>
          {reqs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.templateTitle}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!pick}
        className="rounded-md border border-slate-500 bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row disabled:opacity-50"
        aria-label={pick ? `Upload certificate for ${pick.templateTitle}` : 'Upload certificate'}
        onClick={() => setTarget(pick)}
      >
        Upload certificate
      </button>
      <p className="w-full text-xs">Someone else verifies the certificate before it counts.</p>
      <UploadDialog
        target={
          target
            ? {
                instanceId: target.id,
                title: target.templateTitle,
                deadlineKind: target.deadlineKind,
              }
            : null
        }
        onClose={() => setTarget(null)}
      />
    </div>
  );
}
