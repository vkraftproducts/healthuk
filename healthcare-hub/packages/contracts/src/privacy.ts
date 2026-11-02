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
  approvedAt: isoDateTime.nullable(),
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
  })
  .refine(
    (h) => (h.scopeType === 'ORGANISATION') === !h.scopeId,
    'A scoped hold needs a record; an organisation hold must not have one',
  );
export const LegalHoldRelease = z.strictObject({ reason: z.string().trim().min(10).max(500) });
export const LegalHoldDto = z.object({
  id: uuid,
  scopeType: z.string(),
  scopeId: uuid.nullable(),
  reason: z.string(),
  placedBy: uuid,
  placedAt: isoDateTime,
  releasedAt: isoDateTime.nullable(),
  releaseReason: z.string().nullable(),
});
export type LegalHoldDto = z.infer<typeof LegalHoldDto>;

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
  })
  .refine((u) => Object.keys(u).length > 0, 'Nothing to change')
  .refine(
    (u) => !(u.status === 'COMPLETED' || u.status === 'REFUSED') || !!u.outcome,
    'Record the outcome',
  );
export const SubjectRequestDto = z.object({
  id: uuid,
  code: z.string(),
  type: z.string(),
  subjectType: z.string(),
  staffId: uuid.nullable(),
  patientRef: z.string().nullable(),
  description: z.string(),
  receivedOn: isoDate,
  dueOn: isoDate,
  extendedTo: isoDate.nullable(),
  status: z.string(),
  outcome: z.string().nullable(),
  exportJobId: uuid.nullable(),
  overdue: z.boolean(),
  version: z.number(),
});
export type SubjectRequestDto = z.infer<typeof SubjectRequestDto>;

export const DisclosureInput = z.strictObject({
  subjectRequestId: uuid.optional(),
  disclosedTo: z.string().trim().min(2).max(200),
  purpose: z.string().trim().min(3).max(500),
  lawfulBasis: z.string().trim().min(3).max(300),
  dataDescription: z.string().trim().min(3).max(1000),
  disclosedOn: isoDate,
});
export const DisclosureDto = DisclosureInput.extend({
  id: uuid,
  subjectRequestId: uuid.nullable(),
  recordedBy: uuid,
  recordedAt: isoDateTime,
});

export const BreachInput = z.strictObject({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  discoveredAt: isoDateTime,
  occurredAt: isoDateTime.optional(),
  dataCategories: z.array(z.string().trim().min(2).max(60)).max(20).default([]),
  subjectsEstimate: z.number().int().min(0).optional(),
  containment: z.string().trim().max(2000).optional(),
});
export const BreachAssessment = z
  .strictObject({
    risk: z.enum(['UNLIKELY', 'RISK', 'HIGH_RISK']),
    icoReportable: z.boolean(),
    decisionReason: z.string().trim().min(10).max(2000),
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
  discoveredAt: isoDateTime,
  icoDeadline: isoDateTime,
  clock: z.enum(['REPORTED', 'NOT_REPORTABLE', 'OVERDUE', 'DUE_SOON', 'OPEN']),
  hoursLeft: z.number(),
  risk: z.string().nullable(),
  icoReportable: z.boolean().nullable(),
  decisionReason: z.string().nullable(),
  icoReportedAt: isoDateTime.nullable(),
  icoReference: z.string().nullable(),
  status: z.string(),
  version: z.number(),
});
export type BreachDto = z.infer<typeof BreachDto>;
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
