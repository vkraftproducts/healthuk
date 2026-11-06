import { addDays, addMonths, compareDates, type ISODate } from './dates.js';
import { licenceCovers } from './staff.js';

/**
 * Schedule 3 of the Health and Social Care Act 2008 (Regulated Activities) Regulations 2014:
 * the information a provider must hold for each person employed (reg 19), plus the right to work
 * check. Pure: the caller passes the person's current (not superseded) records and, for each item,
 * whether a requirement covering it has verified evidence.
 */
export const SCHEDULE3_ITEMS = [
  'IDENTITY',
  'DBS',
  'CONDUCT_REFERENCES',
  'REASON_FOR_LEAVING',
  'QUALIFICATIONS',
  'EMPLOYMENT_HISTORY',
  'HEALTH',
  'RIGHT_TO_WORK',
] as const;
export type Schedule3Item = (typeof SCHEDULE3_ITEMS)[number];

export const SCHEDULE3_TITLES: Record<Schedule3Item, string> = {
  IDENTITY: 'Proof of identity, including a recent photograph',
  DBS: 'Criminal record (DBS) check at the right level',
  CONDUCT_REFERENCES: 'Evidence of conduct in previous employment (references)',
  REASON_FOR_LEAVING: 'Why earlier work with children or vulnerable adults ended',
  QUALIFICATIONS: 'Qualifications and professional registration relevant to the role',
  EMPLOYMENT_HISTORY: 'Full employment history, with gaps explained in writing',
  HEALTH: 'Satisfactory information about physical and mental health for the role',
  RIGHT_TO_WORK: 'Right to work in the UK',
};

export interface Schedule3Record {
  kind: string;
  data: Record<string, unknown>;
}
export interface Schedule3Evidence {
  title: string;
  verified: boolean;
}
export interface Schedule3Input {
  records: readonly Schedule3Record[];
  asOf: ISODate;
  /** Requirement covering each item (null when no requirement covers it). */
  evidence: Partial<Record<Schedule3Item, Schedule3Evidence | null>>;
}
export type Schedule3State = 'COMPLETE' | 'RECORDED_UNVERIFIED' | 'ATTENTION' | 'MISSING';
export interface Schedule3Check {
  item: Schedule3Item;
  title: string;
  state: Schedule3State;
  /** RAG colour for the badge; the words in `reasonText` always go with it. */
  status: 'GREEN' | 'AMBER' | 'RED';
  reasonText: string;
  evidenceTitle: string | null;
}

type Found = { state: 'MET' | 'ATTENTION' | 'MISSING'; text: string };
const of = (records: readonly Schedule3Record[], kind: string) =>
  records.filter((r) => r.kind === kind).map((r) => r.data);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/**
 * Right to work. A time-limited permission blocks from the day after it ends until a new check is
 * recorded; the follow-up date is the reminder to re-check before then.
 */
function rightToWork(records: readonly Schedule3Record[], asOf: ISODate): Found {
  const r = of(records, 'RIGHT_TO_WORK')[0];
  if (!r) return { state: 'MISSING', text: 'No right to work check recorded' };
  const ends = str(r.permissionEndsOn);
  if (ends && compareDates(ends, asOf) < 0)
    return {
      state: 'ATTENTION',
      text: `Permission to work ended ${ends}: record a new check before they work again`,
    };
  const follow = str(r.followUpOn);
  if (follow && compareDates(follow, asOf) < 0)
    return { state: 'ATTENTION', text: `Follow-up check was due ${follow}` };
  return {
    state: 'MET',
    text: `Checked ${str(r.checkedOn)}${ends ? `; time-limited until ${ends}` : ''}${
      follow ? `; follow-up due ${follow}` : ''
    }`,
  };
}

/** Identity: the IDENTITY record when held, otherwise the photo ID seen at the right to work check. */
function identity(records: readonly Schedule3Record[], asOf: ISODate): Found {
  const id = of(records, 'IDENTITY')[0];
  if (id) {
    if (id.photoMatches === false)
      return { state: 'ATTENTION', text: 'The photograph did not match the person' };
    const expiry = str(id.documentExpiry);
    if (expiry && compareDates(expiry, asOf) < 0)
      return { state: 'ATTENTION', text: `The identity document expired ${expiry}` };
    return { state: 'MET', text: `Photo identity checked ${str(id.checkedOn)}` };
  }
  const r = of(records, 'RIGHT_TO_WORK')[0];
  if (!r) return { state: 'MISSING', text: 'No identity check recorded' };
  return {
    state: 'MET',
    text: `Photo identity seen at the right to work check (${str(r.checkedOn)})`,
  };
}

function dbs(records: readonly Schedule3Record[]): Found {
  const r = of(records, 'DBS')[0];
  if (!r) return { state: 'MISSING', text: 'No DBS check recorded' };
  if (r.riskDecision === 'PENDING') return { state: 'ATTENTION', text: 'DBS decision pending' };
  if (r.riskDecision === 'NOT_ACCEPTED')
    return { state: 'ATTENTION', text: 'DBS result not accepted' };
  // A certificate that discloses information blocks until a named manager records a risk decision.
  if (
    r.disclosure === 'INFORMATION_DISCLOSED' &&
    (r.riskDecision !== 'ACCEPTED_WITH_RISK_ASSESSMENT' || !str(r.riskDecisionByUserId))
  )
    return {
      state: 'ATTENTION',
      text: 'The certificate discloses information: a manager must record a risk decision',
    };
  if (r.eligibility !== 'ENHANCED' && r.eligibility !== 'ENHANCED_BARRED')
    return { state: 'ATTENTION', text: 'Regulated activity needs an enhanced DBS check' };
  if (r.eligibility === 'ENHANCED_BARRED' && r.barredListChecked !== true)
    return { state: 'ATTENTION', text: 'The barred list check is not recorded' };
  return {
    state: 'MET',
    text: `Enhanced DBS issued ${str(r.issueDate)}${
      r.riskDecision === 'ACCEPTED_WITH_RISK_ASSESSMENT' ? ', accepted with a risk assessment' : ''
    }`,
  };
}

/**
 * At least two satisfactory references, or one plus an alternative a manager approved (named with
 * the reasons). An unsatisfactory reference blocks until a further satisfactory reference or an
 * approved alternative makes the count up again.
 */
function references(records: readonly Schedule3Record[]): Found {
  const refs = of(records, 'REFERENCE');
  if (refs.length === 0) return { state: 'MISSING', text: 'No references recorded' };
  const good = refs.filter((r) => r.outcome === 'SATISFACTORY');
  const approvedAlternative = good.some(
    (r) => !!str(r.alternativeRationale) && !!str(r.alternativeApprovedByUserId),
  );
  const bad = refs.filter((r) => r.outcome === 'UNSATISFACTORY').length;
  if (good.length >= 2 || (good.length === 1 && approvedAlternative))
    return {
      state: 'MET',
      text: `${good.length} satisfactory reference(s)${
        good.length < 2 ? ' and an approved alternative' : ''
      }${bad ? `; ${bad} unsatisfactory, further reference obtained` : ''}`,
    };
  if (bad)
    return {
      state: 'ATTENTION',
      text: 'A reference is unsatisfactory: get a further reference or an approved alternative',
    };
  const pending = refs.filter((r) => r.outcome === 'PENDING').length;
  return {
    state: 'ATTENTION',
    text: `${good.length} of 2 satisfactory references${pending ? `; ${pending} awaited` : ''}`,
  };
}

export interface EmploymentEntry {
  employer: string;
  from: ISODate;
  to?: ISODate;
  gapExplanation?: string;
  careRole?: boolean;
  reasonForLeaving?: string;
}
type Job = EmploymentEntry;
const jobs = (records: readonly Schedule3Record[]): Job[] =>
  of(records, 'EMPLOYMENT_HISTORY')
    .map((d) => d as unknown as Job)
    .filter((j) => typeof j.from === 'string')
    .sort((a, b) => compareDates(a.from, b.from));

/** Gaps longer than this many months must be explained in writing (WORKFLOWS B1). */
export const EMPLOYMENT_GAP_MONTHS = 3;

/** Gaps of more than three months between jobs that have no written explanation. */
export function unexplainedGaps(
  history: readonly EmploymentEntry[],
  months = EMPLOYMENT_GAP_MONTHS,
): { from: ISODate; to: ISODate }[] {
  const gaps: { from: ISODate; to: ISODate }[] = [];
  let reach: ISODate | null = null;
  let open = false;
  for (const j of history) {
    const late = reach !== null && compareDates(j.from, addMonths(addDays(reach, 1), months)) > 0;
    if (reach && !open && late && !j.gapExplanation?.trim())
      gaps.push({ from: addDays(reach, 1), to: addDays(j.from, -1) });
    if (!j.to) open = true;
    else if (!reach || compareDates(j.to, reach) > 0) reach = j.to;
  }
  return gaps;
}

function history(records: readonly Schedule3Record[]): Found {
  const h = jobs(records);
  if (h.length === 0) return { state: 'MISSING', text: 'No employment history recorded' };
  const gaps = unexplainedGaps(h);
  if (gaps.length)
    return {
      state: 'ATTENTION',
      text: `Unexplained gap(s): ${gaps.map((g) => `${g.from} to ${g.to}`).join(', ')}`,
    };
  return { state: 'MET', text: `${h.length} role(s) recorded, no unexplained gaps` };
}

function leaving(records: readonly Schedule3Record[]): Found {
  const care = jobs(records).filter((j) => j.careRole && j.to);
  if (jobs(records).length === 0)
    return { state: 'MISSING', text: 'Record the employment history first' };
  const missing = care.filter((j) => !j.reasonForLeaving?.trim());
  if (missing.length)
    return {
      state: 'ATTENTION',
      text: `Reason for leaving not recorded: ${missing.map((j) => j.employer).join(', ')}`,
    };
  return {
    state: 'MET',
    text: care.length
      ? `Reasons recorded for ${care.length} earlier care role(s)`
      : 'No earlier work with children or vulnerable adults recorded',
  };
}

function qualifications(records: readonly Schedule3Record[], asOf: ISODate): Found {
  const regs = of(records, 'REGISTRATION');
  const lapsed = regs.find((r) => str(r.expiresOn) && compareDates(str(r.expiresOn)!, asOf) < 0);
  if (lapsed) return { state: 'ATTENTION', text: `Registration lapsed ${str(lapsed.expiresOn)}` };
  const training = of(records, 'TRAINING');
  if (regs.length === 0 && training.length === 0)
    return { state: 'MISSING', text: 'No qualifications or registration recorded' };
  return {
    state: 'MET',
    text: [
      regs.length ? `${regs.length} registration(s)` : '',
      training.length ? `${training.length} qualification or training record(s)` : '',
    ]
      .filter(Boolean)
      .join(', '),
  };
}

function health(records: readonly Schedule3Record[], asOf: ISODate): Found {
  const r = of(records, 'OH_CLEARANCE')[0];
  if (!r) return { state: 'MISSING', text: 'No occupational health clearance recorded' };
  if (r.fitStatus === 'PENDING') return { state: 'ATTENTION', text: 'Health clearance pending' };
  if (r.fitStatus === 'UNFIT') return { state: 'ATTENTION', text: 'Assessed as not fit for duty' };
  const review = str(r.reviewOn);
  if (review && compareDates(review, asOf) < 0)
    return { state: 'ATTENTION', text: `Health review was due ${review}` };
  return {
    state: 'MET',
    text: r.fitStatus === 'FIT_WITH_ADJUSTMENTS' ? 'Fit with adjustments' : 'Fit for duty',
  };
}

export function schedule3Checks(input: Schedule3Input): Schedule3Check[] {
  const { records, asOf } = input;
  const found: Record<Schedule3Item, Found> = {
    IDENTITY: identity(records, asOf),
    DBS: dbs(records),
    CONDUCT_REFERENCES: references(records),
    REASON_FOR_LEAVING: leaving(records),
    QUALIFICATIONS: qualifications(records, asOf),
    EMPLOYMENT_HISTORY: history(records),
    HEALTH: health(records, asOf),
    RIGHT_TO_WORK: rightToWork(records, asOf),
  };
  return SCHEDULE3_ITEMS.map((item): Schedule3Check => {
    const f = found[item];
    const ev = input.evidence[item] ?? null;
    const base = { item, title: SCHEDULE3_TITLES[item], evidenceTitle: ev?.title ?? null };
    if (f.state === 'MISSING')
      return { ...base, state: 'MISSING', status: 'RED', reasonText: f.text };
    if (f.state === 'ATTENTION')
      return { ...base, state: 'ATTENTION', status: 'RED', reasonText: f.text };
    if (ev?.verified) return { ...base, state: 'COMPLETE', status: 'GREEN', reasonText: f.text };
    return {
      ...base,
      state: 'RECORDED_UNVERIFIED',
      status: 'AMBER',
      reasonText: `${f.text} – ${
        ev ? 'evidence not yet verified by a second person' : 'no requirement holds the evidence'
      }`,
    };
  });
}

/**
 * Roles carrying on the regulated activity (patient, resident or service-user facing). Approval
 * for one of these needs the Schedule 3 staff file, not only the role's own checks.
 */
export const SCHEDULE3_ROLES: readonly string[] = [
  'DRIVER',
  'CARE_ASSISTANT',
  'EMERGENCY_CARE_ASSISTANT',
  'TECHNICIAN',
  'PARAMEDIC',
  'NURSE',
  'DENTIST',
  'DENTAL_NURSE',
  'SENIOR_CARER',
  'ACTIVITIES_COORDINATOR',
];
export const needsSchedule3 = (role: string): boolean => SCHEDULE3_ROLES.includes(role);

/**
 * Items that stop a role approval: anything missing or needing attention, and anything whose
 * covering requirement has evidence not yet verified by a second person. An item recorded with no
 * requirement covering it does not block (the information is held), but is shown in amber.
 */
export function schedule3Blockers(checks: readonly Schedule3Check[]): Schedule3Check[] {
  return checks.filter(
    (c) =>
      c.state === 'MISSING' ||
      c.state === 'ATTENTION' ||
      (c.state === 'RECORDED_UNVERIFIED' && c.evidenceTitle !== null),
  );
}

/** Which Schedule 3 item a staff requirement template evidences, from its code and title. */
export function schedule3ItemsFor(code: string, title: string): Schedule3Item[] {
  const s = `${code} ${title}`.toUpperCase();
  const out: Schedule3Item[] = [];
  if (/RIGHT TO WORK|RTW|STF-03/.test(s)) out.push('RIGHT_TO_WORK');
  if (/IDENTITY|STF-03/.test(s)) out.push('IDENTITY');
  if (/DBS|STF-02/.test(s)) out.push('DBS');
  if (/REFERENCE|STF-04/.test(s)) out.push('CONDUCT_REFERENCES', 'REASON_FOR_LEAVING');
  if (/EMPLOYMENT HISTORY|STF-04/.test(s)) out.push('EMPLOYMENT_HISTORY');
  if (/QUALIFICATION|REGISTRATION/.test(s)) out.push('QUALIFICATIONS');
  if (/OCCUPATIONAL HEALTH|HEALTH CLEARANCE|\bOH\b/.test(s)) out.push('HEALTH');
  return [...new Set(out)];
}

// ---- driver eligibility -------------------------------------------------------------------------
/** Above 3,500 kg maximum authorised mass a category B licence is not enough (C1 up to 7,500 kg). */
const B_FAMILY = ['B', 'B1', 'BE'];
export function drivingCategoryFor(
  category: string,
  grossWeightKg: number | null | undefined,
): string {
  if (grossWeightKg == null || grossWeightKg <= 3500) return category;
  if (grossWeightKg > 7500 && ['B', 'B1', 'BE', 'C1'].includes(category)) return 'C';
  return B_FAMILY.includes(category) ? 'C1' : category;
}

export interface DriverLicence {
  categories: string[];
  photocardExpiry: ISODate;
  lastCheckedOn: ISODate;
  penaltyPoints: number;
  restrictionCodes?: string[];
}
export interface DriverEligibilityInput {
  licence: DriverLicence | null;
  /** The driving licence requirement has evidence verified by a second person. */
  licenceVerified: boolean;
  roleApproved: boolean;
  noDrivingRestriction: boolean;
  category: string;
  asOf: ISODate;
  /** Organisation policy; defaults: DVLA re-check every 6 months, review at 6+ points. */
  policy?: { recheckMonths?: number; reviewPoints?: number };
}
export interface DriverCheck {
  code: string;
  result: 'PASS' | 'FAIL' | 'WARN';
  reasonText: string;
}
export interface DriverEligibility {
  eligible: boolean;
  checks: DriverCheck[];
}

/**
 * Whether someone may drive a vehicle needing `category`. Any FAIL means not eligible; a WARN
 * is shown to the manager but does not change eligibility (only RULES_ENGINE gates block jobs).
 */
export function driverEligibility(i: DriverEligibilityInput): DriverEligibility {
  const recheck = i.policy?.recheckMonths ?? 6;
  const reviewPoints = i.policy?.reviewPoints ?? 6;
  const c: DriverCheck[] = [];
  const add = (code: string, ok: boolean, pass: string, fail: string, warn = false) =>
    c.push({ code, result: ok ? 'PASS' : warn ? 'WARN' : 'FAIL', reasonText: ok ? pass : fail });
  add('ROLE_APPROVED', i.roleApproved, 'Approved for the Driver role', 'Not approved as a driver');
  add(
    'NO_DRIVING_RESTRICTION',
    !i.noDrivingRestriction,
    'No restriction on driving',
    'Restricted from driving',
  );
  const l = i.licence;
  add('LICENCE_RECORD', !!l, 'Licence details recorded', 'No driving licence details on record');
  add(
    'LICENCE_VERIFIED',
    i.licenceVerified,
    'Licence evidence verified by a second person',
    'Licence evidence not verified',
  );
  if (l) {
    add(
      'LICENCE_CATEGORY',
      licenceCovers(l.categories, i.category),
      `Licence covers category ${i.category}`,
      `Licence does not cover category ${i.category} (holds ${l.categories.join(', ')})`,
    );
    add(
      'PHOTOCARD_IN_DATE',
      compareDates(l.photocardExpiry, i.asOf) >= 0,
      `Photocard valid until ${l.photocardExpiry}`,
      `Photocard expired ${l.photocardExpiry}`,
    );
    const due = addMonths(l.lastCheckedOn, recheck);
    add(
      'DVLA_CHECK_RECENT',
      compareDates(due, i.asOf) >= 0,
      `Checked with DVLA ${l.lastCheckedOn}; next check by ${due}`,
      `DVLA check is out of date (last ${l.lastCheckedOn}; was due ${due})`,
    );
    add(
      'PENALTY_POINTS',
      l.penaltyPoints < reviewPoints,
      l.penaltyPoints ? `${l.penaltyPoints} penalty point(s)` : 'No penalty points',
      `${l.penaltyPoints} penalty points: the manager should review driving duties`,
      true,
    );
  }
  return { eligible: !c.some((x) => x.result === 'FAIL'), checks: c };
}
