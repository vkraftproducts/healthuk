import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';

/** Retention, legal hold, subject requests, disclosures and breaches (SECURITY_COMPLIANCE §4). */
export const RetentionCategory = z.enum([
  'PATIENT_CONTACT',
  'JOB_RECORDS',
  'STAFF_HR_RECORDS',
  'DBS_RECORDS',
  'EVENT_RECORDS',
  'COMPLAINTS',
  'SAFEGUARDING',
  'AUDIT_RECORDS',
  'AUDIT_LOG',
]);
export const RetentionRuleDto = z.object({
  id: uuid,
  category: RetentionCategory,
  retainMonths: z.number(),
  triggerDesc: z.string(),
  basis: z.string(),
  action: z.enum(['REVIEW', 'ANONYMISE']),
  status: z.enum(['REQUIRES_APPROVAL', 'APPROVED']),
  approvedBy: uuid.nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  /** Who last changed the rule; they cannot approve it. */
  changedBy: uuid.nullable(),
  changedByName: z.string().nullable(),
  version: z.number(),
  /** Records past the cutoff now, and how many of them are under legal hold (dry run). */
  candidates: z.number(),
  held: z.number(),
  cutoff: isoDate,
});
export type RetentionRuleDto = z.infer<typeof RetentionRuleDto>;
/** Any change puts the rule back to "requires approval". */
export const RetentionRulePatch = z
  .strictObject({
    retainMonths: z.number().int().min(1).max(1200),
    basis: z.string().trim().min(3).max(500),
    action: z.enum(['REVIEW', 'ANONYMISE']),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');

export const LegalHoldInput = z
  .strictObject({
    scopeType: z.enum(['ORGANISATION', 'STAFF', 'JOB', 'EVENT', 'VEHICLE']),
    scopeId: uuid.optional(),
    reason: z.string().trim().min(10).max(500),
    /** K4: an organisation hold can cover records from a date range only. */
    rangeFrom: isoDate.optional(),
    rangeTo: isoDate.optional(),
  })
  .refine(
    (h) => (h.scopeType === 'ORGANISATION') === !h.scopeId,
    'A scoped hold needs a record; an organisation hold must not have one',
  )
  .refine((h) => !h.rangeFrom === !h.rangeTo, 'Give both the start and end of the date range')
  .refine(
    (h) => !h.rangeFrom || h.scopeType === 'ORGANISATION',
    'A date range is only for an organisation-wide hold',
  )
  .refine(
    (h) => !h.rangeFrom || !h.rangeTo || h.rangeFrom <= h.rangeTo,
    'The start date must be before the end date',
  );
export const LegalHoldRelease = z.strictObject({ reason: z.string().trim().min(10).max(500) });
export const LegalHoldDto = z.object({
  id: uuid,
  scopeType: z.string(),
  scopeId: uuid.nullable(),
  reason: z.string(),
  placedBy: uuid,
  placedByName: z.string().nullable(),
  placedAt: isoDateTime,
  releasedAt: isoDateTime.nullable(),
  releaseReason: z.string().nullable(),
  rangeFrom: isoDate.nullable().optional(),
  rangeTo: isoDate.nullable().optional(),
});
export type LegalHoldDto = z.infer<typeof LegalHoldDto>;

/** K4: a monthly review of what one approved rule has made due. */
export const RetentionReviewInput = z.strictObject({ ruleId: uuid });
export const RetentionDecisionInput = z
  .strictObject({
    /** `BATCH` decides the whole review at once; otherwise a record type such as `JOB`. */
    recordType: z.string().regex(/^[A-Z_]{2,40}$/),
    recordId: uuid,
    decision: z.enum(['KEEP', 'ACT']),
    reason: z.string().trim().min(3).max(500).optional(),
    keepUntil: isoDate.optional(),
  })
  .refine(
    (x) => x.decision !== 'KEEP' || (!!x.reason && !!x.keepUntil),
    'Keeping records needs a reason and a date to look again',
  );
export const RetentionReviewDto = z.object({
  id: uuid,
  ruleId: uuid,
  category: z.string(),
  period: z.string(),
  cutoff: isoDate,
  candidates: z.number(),
  held: z.number(),
  status: z.enum(['OPEN', 'CLOSED']),
  createdByName: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: isoDateTime.nullable(),
  decisions: z.array(
    z.object({
      id: uuid,
      recordType: z.string(),
      recordId: uuid,
      decision: z.enum(['KEEP', 'ACT']),
      reason: z.string().nullable(),
      keepUntil: isoDate.nullable(),
      decidedByName: z.string().nullable(),
      decidedAt: isoDateTime,
    }),
  ),
  version: z.number(),
});
export type RetentionReviewDto = z.infer<typeof RetentionReviewDto>;

export const SubjectRequestInput = z
  .strictObject({
    type: z.enum(['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION']),
    subjectType: z.enum(['STAFF', 'PATIENT', 'OTHER']),
    staffId: uuid.optional(),
    patientRef: z
      .string()
      .regex(/^[A-Za-z0-9-]{2,30}$/)
      .optional(),
    description: z.string().trim().min(3).max(1000),
    receivedOn: isoDate,
  })
  .refine((r) => r.subjectType !== 'STAFF' || !!r.staffId, 'Choose the staff member')
  .refine((r) => r.subjectType !== 'PATIENT' || !!r.patientRef, 'Give the patient reference');
export const SubjectRequestUpdate = z
  .strictObject({
    status: z.enum(['IDENTITY_VERIFIED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED']).optional(),
    outcome: z.string().trim().min(3).max(2000).optional(),
    extendedTo: isoDate.optional(),
    /** K2: proof of identity was asked for on this date; the clock pauses until it arrives. */
    identityRequestedOn: isoDate.optional(),
    /** K2: the date identity was confirmed (defaults to today when verifying). */
    identityVerifiedOn: isoDate.optional(),
    /** K2: the exemption relied on when refusing (all or part). */
    exemption: z.string().trim().min(3).max(500).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, 'Nothing to change')
  .refine(
    (u) => !(u.status === 'COMPLETED' || u.status === 'REFUSED') || !!u.outcome,
    'Record the outcome',
  )
  .refine((u) => u.status !== 'REFUSED' || !!u.exemption, 'Name the exemption relied on');
export const SubjectRequestDto = z.object({
  id: uuid,
  code: z.string(),
  type: z.string(),
  subjectType: z.string(),
  staffId: uuid.nullable(),
  staffName: z.string().nullable(),
  patientRef: z.string().nullable(),
  description: z.string(),
  receivedOn: isoDate,
  dueOn: isoDate,
  extendedTo: isoDate.nullable(),
  /** The latest date an extension may run to (three months from receipt). */
  latestExtension: isoDate,
  status: z.string(),
  outcome: z.string().nullable(),
  exportJobId: uuid.nullable(),
  handledByName: z.string().nullable(),
  completedAt: isoDateTime.nullable(),
  overdue: z.boolean(),
  identityRequestedOn: isoDate.nullable().optional(),
  identityVerifiedOn: isoDate.nullable().optional(),
  /** Days the clock was paused waiting for identity; the effective due date moves by this. */
  pausedDays: z.number().optional(),
  /** The date the answer is actually due: due date (or extension) plus any pause. */
  effectiveDueOn: isoDate.optional(),
  exemption: z.string().nullable().optional(),
  version: z.number(),
});
export type SubjectRequestDto = z.infer<typeof SubjectRequestDto>;
/** K2: where to look for a staff member's data, with how many records each place holds. */
export const SubjectRequestSourcesDto = z.object({
  sources: z.array(z.object({ label: z.string(), count: z.number() })),
  note: z.string(),
});

export const DISCLOSURE_METHODS = [
  'SECURE_EMAIL',
  'SECURE_PORTAL',
  'POST',
  'BY_HAND',
  'PHONE',
  'OTHER',
] as const;
export const DISCLOSURE_METHOD_LABELS: Record<(typeof DISCLOSURE_METHODS)[number], string> = {
  SECURE_EMAIL: 'Secure email',
  SECURE_PORTAL: 'Secure portal',
  POST: 'Post',
  BY_HAND: 'By hand',
  PHONE: 'Phone',
  OTHER: 'Other',
};
export const DisclosureInput = z.strictObject({
  subjectRequestId: uuid.optional(),
  disclosedTo: z.string().trim().min(2).max(200),
  purpose: z.string().trim().min(3).max(500),
  lawfulBasis: z.string().trim().min(3).max(300),
  dataDescription: z.string().trim().min(3).max(1000),
  disclosedOn: isoDate,
  /** K5: whose data (a description, not a patient name), who asked, who approved, how sent. */
  subjectDescription: z.string().trim().min(2).max(200).optional(),
  requestedBy: z.string().trim().min(2).max(200).optional(),
  approvedBy: uuid.optional(),
  method: z.enum(DISCLOSURE_METHODS).optional(),
});
export const DisclosureDto = DisclosureInput.extend({
  id: uuid,
  subjectRequestId: uuid.nullable(),
  subjectRequestCode: z.string().nullable(),
  subjectDescription: z.string().nullable().optional(),
  requestedBy: z.string().nullable().optional(),
  approvedBy: uuid.nullable().optional(),
  approvedByName: z.string().nullable().optional(),
  method: z.enum(DISCLOSURE_METHODS).nullable().optional(),
  recordedBy: uuid,
  recordedByName: z.string().nullable(),
  recordedAt: isoDateTime,
});
/** Task 27: filter the disclosure log by the date of disclosure; K5: and by words. */
export const DisclosureQuery = z
  .strictObject({
    from: isoDate.optional(),
    to: isoDate.optional(),
    q: z.string().trim().min(2).max(100).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'The start date must be before the end date');

export const BreachInput = z.strictObject({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  discoveredAt: isoDateTime,
  occurredAt: isoDateTime.optional(),
  dataCategories: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  subjectsEstimate: z.number().int().min(0).optional(),
  containment: z.string().trim().max(2000).optional(),
  containedAt: isoDateTime.optional(),
  peopleAffected: z.number().int().min(0).optional(),
});
/** K1: the steps taken to stop it, and when it was stopped. */
export const BreachContainment = z.strictObject({
  containment: z.string().trim().min(3).max(2000),
  containedAt: isoDateTime,
  peopleAffected: z.number().int().min(0).optional(),
});
/** K1: guided questions; the answers are kept with the decision. */
export const BreachAnswers = z.strictObject({
  specialCategory: z.boolean(),
  identifiable: z.boolean(),
  volume: z.enum(['ONE', 'FEW', 'MANY']),
  likelyHarm: z.enum(['NONE', 'SOME', 'SERIOUS']),
  recovered: z.boolean(),
});
export type BreachAnswers = z.infer<typeof BreachAnswers>;
export const BreachClose = z.strictObject({
  lessons: z.string().trim().min(3).max(2000).optional(),
});
export const BreachAssessment = z
  .strictObject({
    risk: z.enum(['UNLIKELY', 'RISK', 'HIGH_RISK']),
    icoReportable: z.boolean(),
    decisionReason: z.string().trim().min(10).max(2000),
    answers: BreachAnswers.optional(),
  })
  .refine(
    (a) => a.risk !== 'HIGH_RISK' || a.icoReportable,
    'A high risk breach must be reported to the ICO',
  );
export const BreachIcoReport = z.strictObject({
  reportedAt: isoDateTime,
  reference: z.string().trim().min(1).max(60),
  lateReason: z.string().trim().min(10).max(2000).optional(),
  subjectsNotifiedAt: isoDateTime.optional(),
});
export const BreachDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  description: z.string(),
  discoveredAt: isoDateTime,
  occurredAt: isoDateTime.nullable(),
  dataCategories: z.array(z.string()),
  subjectsEstimate: z.number().nullable(),
  containment: z.string().nullable(),
  icoDeadline: isoDateTime,
  clock: z.enum(['REPORTED', 'NOT_REPORTABLE', 'OVERDUE', 'DUE_SOON', 'OPEN']),
  hoursLeft: z.number(),
  risk: z.string().nullable(),
  icoReportable: z.boolean().nullable(),
  decisionReason: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  icoReportedAt: isoDateTime.nullable(),
  icoReference: z.string().nullable(),
  lateReason: z.string().nullable(),
  subjectsNotifiedAt: isoDateTime.nullable(),
  recordedByName: z.string().nullable(),
  containedAt: isoDateTime.nullable().optional(),
  peopleAffected: z.number().nullable().optional(),
  answers: BreachAnswers.nullable().optional(),
  /** K1: the risk the answers point to (a suggestion; the decision is the person's). */
  suggestedRisk: z.enum(['UNLIKELY', 'RISK', 'HIGH_RISK']).nullable().optional(),
  lessons: z.string().nullable().optional(),
  closedByName: z.string().nullable().optional(),
  closedAt: isoDateTime.nullable().optional(),
  status: z.string(),
  version: z.number(),
});
export type BreachDto = z.infer<typeof BreachDto>;

/** Complaints about how personal data is handled. The summary must not name people. */
export const DpComplaintSource = z.enum(['DATA_SUBJECT', 'REPRESENTATIVE', 'ICO']);
const icoCaseRef = z.string().regex(/^[A-Za-z0-9/-]{3,40}$/, 'Use the ICO case reference');
export const DpComplaintInput = z
  .strictObject({
    source: DpComplaintSource,
    summary: z.string().trim().min(3).max(2000),
    receivedOn: isoDate,
    ownerUserId: uuid,
    subjectRequestId: uuid.optional(),
    breachId: uuid.optional(),
    /** K3: required when the complaint comes through the ICO. */
    icoCaseRef: icoCaseRef.optional(),
  })
  .refine((c) => c.source !== 'ICO' || !!c.icoCaseRef, {
    message: 'Give the ICO case reference',
    path: ['icoCaseRef'],
  });
export const DpComplaintAcknowledge = z.strictObject({
  acknowledgedOn: isoDate,
  /** K3: the acknowledgement as sent (starts from the drafted text). */
  text: z.string().trim().min(3).max(4000).optional(),
});
/** K3: drafted acknowledgement wording; no names, only the complaint code and dates. */
export function draftDpAcknowledgement(code: string, receivedOn: string, dueOn: string): string {
  return (
    `Thank you for your complaint (our reference ${code}), which we received on ${receivedOn}. ` +
    'We take concerns about how we handle personal data seriously. We are looking into it and ' +
    `will reply with our response by ${dueOn}. If you are not satisfied with our response you ` +
    'can contact the Information Commissioner’s Office (ico.org.uk).'
  );
}
export const DpComplaintResolve = z.strictObject({
  outcome: z.string().trim().min(3).max(2000),
  resolvedOn: isoDate,
});
export const DpComplaintDto = z.object({
  id: uuid,
  code: z.string(),
  source: DpComplaintSource,
  summary: z.string(),
  receivedOn: isoDate,
  acknowledgeDue: isoDate,
  acknowledgedOn: isoDate.nullable(),
  acknowledgeOverdue: z.boolean(),
  subjectRequestId: uuid.nullable(),
  subjectRequestCode: z.string().nullable(),
  breachId: uuid.nullable(),
  breachCode: z.string().nullable(),
  ownerUserId: uuid,
  ownerName: z.string().nullable(),
  status: z.enum(['RECEIVED', 'ACKNOWLEDGED', 'RESOLVED']),
  outcome: z.string().nullable(),
  resolvedOn: isoDate.nullable(),
  resolvedByName: z.string().nullable(),
  icoCaseRef: z.string().nullable().optional(),
  draftAcknowledgement: z.string().optional(),
  version: z.number(),
});
export type DpComplaintDto = z.infer<typeof DpComplaintDto>;
export const RetentionLogDto = z.object({
  id: uuid,
  category: z.string(),
  action: z.string(),
  cutoff: isoDate,
  candidates: z.number(),
  affected: z.number(),
  held: z.number(),
  runAt: isoDateTime,
});
/** Task 27: filter the retention log by records category and run date. */
export const RetentionLogQuery = z
  .strictObject({
    category: RetentionCategory.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, 'The start date must be before the end date');
