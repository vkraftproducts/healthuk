import { addDays, endOfLondonDay, formatDate, londonDate, type ISODate } from './dates.js';

/**
 * Incidents, complaints and their duties (WORKFLOWS H1, H2, H5). Pure: the hub suggests, a person
 * decides. Nothing here is legal advice; every suggestion names its basis so it can be checked.
 */

// ---- Working days (England and Wales) -----------------------------------------------------------
/** Bank holidays in England and Wales (gov.uk). Extend each year; unknown years count weekdays. */
export const ENGLAND_BANK_HOLIDAYS: readonly ISODate[] = [
  '2025-01-01',
  '2025-04-18',
  '2025-04-21',
  '2025-05-05',
  '2025-05-26',
  '2025-08-25',
  '2025-12-25',
  '2025-12-26',
  '2026-01-01',
  '2026-04-03',
  '2026-04-06',
  '2026-05-04',
  '2026-05-25',
  '2026-08-31',
  '2026-12-25',
  '2026-12-28',
  '2027-01-01',
  '2027-03-26',
  '2027-03-29',
  '2027-05-03',
  '2027-05-31',
  '2027-08-30',
  '2027-12-27',
  '2027-12-28',
];

export function isWorkingDay(d: ISODate): boolean {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !ENGLAND_BANK_HOLIDAYS.includes(d);
}

/** `n` working days after `d` (the start day itself is not counted). */
export function addWorkingDays(d: ISODate, n: number): ISODate {
  let out = d;
  let left = n;
  while (left > 0) {
    out = addDays(out, 1);
    if (isWorkingDay(out)) left -= 1;
  }
  return out;
}

// ---- Reporting an incident (H1) ----------------------------------------------------------------
export const REPORTABLE_KINDS = [
  'INCIDENT',
  'NEAR_MISS',
  'ACCIDENT',
  'SAFEGUARDING',
  'HARASSMENT',
  'COMPLAINT',
  'IRMER',
  'DOLS',
] as const;
export type ReportableKind = (typeof REPORTABLE_KINDS)[number];

/** Event types only open to HR and the registered manager (WORKFLOWS H5). */
export const HR_RESTRICTED_TYPES: readonly string[] = ['HARASSMENT'];
/** Event types that are restricted safeguarding material. */
export const SAFEGUARDING_TYPES: readonly string[] = ['SAFEGUARDING'];

/** Event types offered for a sector: IR(ME)R for dental, DoLS outcomes for care homes (M). */
export function eventTypesFor(packs: readonly string[] | null | undefined): ReportableKind[] {
  const base: ReportableKind[] = [
    'INCIDENT',
    'NEAR_MISS',
    'ACCIDENT',
    'SAFEGUARDING',
    'HARASSMENT',
    'COMPLAINT',
  ];
  if (packs == null || packs.includes('dental')) base.push('IRMER');
  if (packs == null || packs.includes('care_home')) base.push('DOLS');
  return base;
}

/** Triage within 1 working day: the end of the next working day (London) after the report. */
export function triageDueAt(reportedAt: Date): Date {
  return endOfLondonDay(addWorkingDays(londonDate(reportedAt), 1));
}

export const INCIDENT_CATEGORIES = [
  'PATIENT_CARE',
  'MEDICATION',
  'MOVING_AND_HANDLING',
  'VEHICLE_COLLISION',
  'EQUIPMENT',
  'STAFF_INJURY',
  'VIOLENCE_AGGRESSION',
  'DATA_BREACH',
  'INFECTION',
  'SAFEGUARDING',
  'HARASSMENT',
  'RADIATION',
  'DOLS',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];
export const INCIDENT_CATEGORY_TEXT: Record<IncidentCategory, string> = {
  PATIENT_CARE: 'Patient care',
  MEDICATION: 'Medication',
  MOVING_AND_HANDLING: 'Moving and handling',
  VEHICLE_COLLISION: 'Vehicle collision',
  EQUIPMENT: 'Equipment',
  STAFF_INJURY: 'Staff injury',
  VIOLENCE_AGGRESSION: 'Violence or aggression',
  DATA_BREACH: 'Personal data breach',
  INFECTION: 'Infection prevention and control',
  SAFEGUARDING: 'Safeguarding',
  HARASSMENT: 'Sexual harassment',
  RADIATION: 'Radiation exposure (IR(ME)R)',
  DOLS: 'Deprivation of Liberty Safeguards',
  OTHER: 'Other',
};

export type Harm = 'NO_HARM' | 'LOW' | 'MODERATE' | 'SEVERE' | 'DEATH';
export type TriagePriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ---- Reporting obligations (H1) ---------------------------------------------------------------
export type ObligationBody =
  'CQC' | 'SAFEGUARDING' | 'RIDDOR' | 'INSURER' | 'COMMISSIONER' | 'ICO' | 'LFPSE' | 'OTHER';

export interface ObligationSuggestion {
  body: ObligationBody;
  trigger: string;
  basis: string;
  /** Null where no fixed deadline applies; `deadlineText` then explains. */
  deadlineAt: Date | null;
  deadlineText: string;
  /** Draft wording for a CQC notification (references only, never names). */
  draftText: string | null;
}

export interface SuggestInput {
  code: string;
  types: readonly string[];
  harm: Harm;
  category: string | null;
  /** NHS-funded work: commissioner, LFPSE and PSIRF apply. */
  nhsFunded: boolean;
  occurredAt: Date;
  discoveredAt: Date;
  /** The staff member was off work, or unable to do their normal job, for more than 7 days. */
  overSevenDayInjury?: boolean;
}

const HOUR = 3_600_000;

/** Two suggestions for the same body become one: reasons joined, the earliest deadline kept. */
export function mergeObligation(
  prior: ObligationSuggestion,
  s: ObligationSuggestion,
): ObligationSuggestion {
  return {
    ...prior,
    trigger: `${prior.trigger}; ${s.trigger}`.slice(0, 500),
    basis: `${prior.basis}; ${s.basis}`.slice(0, 500),
    deadlineAt:
      prior.deadlineAt && s.deadlineAt
        ? new Date(Math.min(prior.deadlineAt.getTime(), s.deadlineAt.getTime()))
        : (prior.deadlineAt ?? s.deadlineAt),
    draftText: prior.draftText ?? s.draftText,
  };
}

/**
 * Which bodies may need telling, with trigger, basis and deadline. One suggestion per body (the
 * hub records one obligation per body per event). A person still decides each one.
 */
export function suggestObligations(i: SuggestInput): ObligationSuggestion[] {
  const out = new Map<ObligationBody, ObligationSuggestion>();
  const add = (s: ObligationSuggestion) => {
    const prior = out.get(s.body);
    out.set(s.body, prior ? mergeObligation(prior, s) : s);
  };
  const occurred = londonDate(i.occurredAt);
  const nextDay = endOfLondonDay(addDays(londonDate(i.discoveredAt), 1));
  const draft = (reg: string, what: string) =>
    `Notification under ${reg}. Event ${i.code}, ${what}, on ${formatDate(occurred)}. ` +
    'What happened: [describe using job or booking references only, no names]. ' +
    'Action taken: [immediate protection steps]. Contact: registered manager.';
  const has = (t: string) => i.types.includes(t);
  const cat = i.category;

  if (i.harm === 'DEATH')
    add({
      body: 'CQC',
      trigger: 'A person using the service died',
      basis: 'CQC (Registration) Regulations 2009, regulation 16',
      deadlineAt: nextDay,
      deadlineText: 'Without delay (the hub prompts by the next day)',
      draftText: draft('regulation 16', 'death of a person using the service'),
    });
  if (i.harm === 'SEVERE')
    add({
      body: 'CQC',
      trigger: 'Serious injury to a person using the service',
      basis: 'CQC (Registration) Regulations 2009, regulation 18(2)(a)',
      deadlineAt: nextDay,
      deadlineText: 'Without delay (the hub prompts by the next day)',
      draftText: draft('regulation 18', 'serious injury'),
    });
  if (has('SAFEGUARDING') || cat === 'SAFEGUARDING') {
    add({
      body: 'CQC',
      trigger: 'Abuse or an allegation of abuse',
      basis: 'CQC (Registration) Regulations 2009, regulation 18(2)(e)',
      deadlineAt: nextDay,
      deadlineText: 'Without delay (the hub prompts by the next day)',
      draftText: draft('regulation 18', 'abuse or allegation of abuse'),
    });
    add({
      body: 'SAFEGUARDING',
      trigger: 'Safeguarding concern about an adult or child',
      basis: 'Care Act 2014 s42 / Children Act 1989; local safeguarding procedures',
      deadlineAt: new Date(i.discoveredAt.getTime() + 24 * HOUR),
      deadlineText: 'Same day where possible, within 24 hours',
      draftText: null,
    });
  }
  if (has('IRMER') || cat === 'RADIATION')
    add({
      body: 'CQC',
      trigger: 'Significant accidental or unintended exposure to ionising radiation',
      basis: 'Ionising Radiation (Medical Exposure) Regulations 2017, regulation 8',
      deadlineAt: nextDay,
      deadlineText: 'As soon as practicable (the hub prompts by the next day)',
      draftText: draft('IR(ME)R 2017 regulation 8', 'unintended radiation exposure'),
    });
  if (has('DOLS') || cat === 'DOLS')
    add({
      body: 'CQC',
      trigger: 'Outcome of a Deprivation of Liberty Safeguards application',
      basis: 'CQC (Registration) Regulations 2009, regulation 18(4A) and (4B)',
      deadlineAt: nextDay,
      deadlineText: 'Without delay once the outcome is known',
      draftText: draft('regulation 18(4A)', 'DoLS application outcome'),
    });
  const injury = cat === 'STAFF_INJURY' || has('ACCIDENT');
  if (injury && (i.harm === 'SEVERE' || i.harm === 'DEATH'))
    add({
      body: 'RIDDOR',
      trigger: 'Death or specified injury from a work-related accident',
      basis: 'RIDDOR 2013, regulations 4 and 6',
      deadlineAt: endOfLondonDay(addDays(occurred, 10)),
      deadlineText: 'Without delay; report within 10 days',
      draftText: null,
    });
  else if (injury && i.overSevenDayInjury)
    add({
      body: 'RIDDOR',
      trigger: 'Worker off work for more than 7 days after a work accident',
      basis: 'RIDDOR 2013, regulation 4(2)',
      deadlineAt: endOfLondonDay(addDays(occurred, 15)),
      deadlineText: 'Within 15 days of the accident',
      draftText: null,
    });
  if (cat === 'DATA_BREACH')
    add({
      body: 'ICO',
      trigger: 'Personal data breach that may risk people’s rights and freedoms',
      basis: 'UK GDPR Article 33 (record the breach under Data protection, K1)',
      deadlineAt: new Date(i.discoveredAt.getTime() + 72 * HOUR),
      deadlineText: 'Within 72 hours of becoming aware',
      draftText: null,
    });
  if (i.harm === 'SEVERE' || i.harm === 'DEATH' || cat === 'VEHICLE_COLLISION')
    add({
      body: 'INSURER',
      trigger:
        cat === 'VEHICLE_COLLISION' ? 'Vehicle collision' : 'Serious harm that may lead to a claim',
      basis: 'Your insurance policy conditions (check the notification clause)',
      deadlineAt: null,
      deadlineText: 'As your policy requires',
      draftText: null,
    });
  if (i.nhsFunded && (i.harm === 'MODERATE' || i.harm === 'SEVERE' || i.harm === 'DEATH'))
    add({
      body: 'COMMISSIONER',
      trigger: 'Moderate or worse harm on NHS-funded work',
      basis: 'NHS Standard Contract incident reporting (check your contract)',
      deadlineAt: endOfLondonDay(addWorkingDays(londonDate(i.discoveredAt), 2)),
      deadlineText: 'Within 2 working days unless your contract says otherwise',
      draftText: null,
    });
  if (i.nhsFunded && (has('INCIDENT') || has('NEAR_MISS') || has('ACCIDENT')))
    add({
      body: 'LFPSE',
      trigger: 'Patient safety event on NHS-funded work',
      basis: 'NHS England Learn from Patient Safety Events service; PSIRF',
      deadlineAt: null,
      deadlineText: 'As soon as practicable',
      draftText: null,
    });
  return [...out.values()];
}

// ---- Duty of candour (regulation 20) ------------------------------------------------------------
export const CANDOUR_STEPS = [
  'TOLD_IN_PERSON',
  'APOLOGY',
  'WRITTEN_NOTICE',
  'SUPPORT_OFFERED',
  'FINDINGS_SHARED',
] as const;
export type CandourStep = (typeof CANDOUR_STEPS)[number];
export const CANDOUR_STEP_TEXT: Record<CandourStep, string> = {
  TOLD_IN_PERSON:
    'Told the person (or their representative) in person, as soon as reasonably practicable',
  APOLOGY: 'Gave a sincere apology',
  WRITTEN_NOTICE:
    'Followed up in writing: what happened, the apology, and what will be looked into',
  SUPPORT_OFFERED: 'Offered reasonable support',
  FINDINGS_SHARED: 'Shared the outcome of further enquiries',
};

/** Steps still to record. Nothing is outstanding until a person decides candour applies. */
export function candourOutstanding(
  notifiable: boolean | null,
  done: readonly string[],
): CandourStep[] {
  if (notifiable !== true) return [];
  return CANDOUR_STEPS.filter((s) => !done.includes(s));
}

// ---- PSIRF learning responses (NHS work) ------------------------------------------------------
export const LEARNING_RESPONSES = [
  'AFTER_ACTION_REVIEW',
  'SWARM_HUDDLE',
  'MDT_REVIEW',
  'THEMATIC_REVIEW',
  'PSII',
  'NO_FURTHER_RESPONSE',
] as const;
export type LearningResponse = (typeof LEARNING_RESPONSES)[number];
export const LEARNING_RESPONSE_TEXT: Record<LearningResponse, string> = {
  AFTER_ACTION_REVIEW: 'After action review',
  SWARM_HUDDLE: 'Swarm huddle',
  MDT_REVIEW: 'Multidisciplinary team review',
  THEMATIC_REVIEW: 'Thematic review',
  PSII: 'Patient safety incident investigation (PSII)',
  NO_FURTHER_RESPONSE: 'No further learning response (reason recorded)',
};

/** Why an incident cannot close yet, in words. Empty means it may close. */
export function incidentCloseBlockers(i: {
  triaged: boolean;
  pendingObligations: number;
  candourFlagged: boolean;
  candourDecision: boolean | null;
  candourStepsOutstanding: number;
  openActions: number;
  nhsFunded: boolean;
  learningRecorded: boolean;
}): string[] {
  const out: string[] = [];
  if (!i.triaged) out.push('Triage has not been recorded');
  if (i.pendingObligations > 0)
    out.push(`${i.pendingObligations} reporting obligation(s) still need a decision`);
  if (i.candourFlagged && i.candourDecision === null)
    out.push('The registered manager has not decided on duty of candour');
  if (i.candourStepsOutstanding > 0)
    out.push(`${i.candourStepsOutstanding} duty of candour step(s) not recorded`);
  if (i.openActions > 0) out.push(`${i.openActions} action(s) not yet verified`);
  if (i.nhsFunded && !i.learningRecorded)
    out.push('NHS-funded work needs a PSIRF learning response recorded');
  return out;
}

// ---- Complaints (H2) ---------------------------------------------------------------------------
export const COMPLAINT_ACK_WORKING_DAYS = 3;
export const COMPLAINT_RESPONSE_WORKING_DAYS = 20;

/** Acknowledge and respond targets in working days (default 3 and 20). */
export function complaintTargetsWorking(
  receivedOn: ISODate,
  policy: { acknowledgeWorkingDays?: number; respondWorkingDays?: number } = {},
): { acknowledgeBy: ISODate; respondBy: ISODate } {
  return {
    acknowledgeBy: addWorkingDays(receivedOn, policy.acknowledgeWorkingDays ?? 3),
    respondBy: addWorkingDays(receivedOn, policy.respondWorkingDays ?? 20),
  };
}

/** Escalation rights text for the final response; who reviews depends on who paid. */
export function complaintEscalationText(nhsFunded: boolean): string {
  return nhsFunded
    ? 'If you are not satisfied with our response, you can ask the Parliamentary and Health ' +
        'Service Ombudsman (PHSO) to review your complaint: www.ombudsman.org.uk, 0345 015 4033.'
    : 'If you are not satisfied with our response, you can ask the Independent Sector ' +
        'Complaints Adjudication Service (ISCAS) to review it if we subscribe, or the Local ' +
        'Government and Social Care Ombudsman for adult social care you arrange or fund yourself. ' +
        'You can also tell CQC about your experience, although CQC does not resolve complaints.';
}

export const COMPLAINT_OUTCOME_TEXT: Record<string, string> = {
  UPHELD: 'Upheld',
  PARTLY_UPHELD: 'Partly upheld',
  NOT_UPHELD: 'Not upheld',
  WITHDRAWN: 'Withdrawn',
};

/** People referenced in an incident must be by job or booking reference, never by name. */
export const PERSON_REFERENCE = /^(?:J|BK|BKG|JOB)-?[A-Z0-9-]{2,20}$/i;
