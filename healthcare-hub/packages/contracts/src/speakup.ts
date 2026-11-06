import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';

/**
 * Speaking up and the duty to prevent sexual harassment (task 20). Summaries are free text: the
 * form asks people not to name patients, and nothing from a summary goes into logs or alerts.
 */
export const SpeakUpCategory = z.enum([
  'SEXUAL_HARASSMENT',
  'HARASSMENT',
  'BULLYING',
  'DISCRIMINATION',
  'PATIENT_SAFETY',
  'WORKER_SAFETY',
  'FRAUD',
  'OTHER',
]);
export const SpeakUpChannel = z.enum(['IN_APP', 'IN_PERSON', 'PHONE', 'EMAIL', 'LETTER']);
export const SpeakUpStatus = z.enum(['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'CLOSED']);
export const SpeakUpOutcome = z.enum([
  'UPHELD',
  'PARTLY_UPHELD',
  'NOT_UPHELD',
  'NO_FURTHER_ACTION',
  'REFERRED_ELSEWHERE',
]);

/** Anyone in the organisation raising a concern in the hub. */
export const SpeakUpRaise = z.strictObject({
  category: SpeakUpCategory,
  summary: z.string().trim().min(10).max(4000),
  anonymous: z.boolean().default(false),
  /** The concern is about a patient, visitor or contractor rather than a colleague. */
  thirdParty: z.boolean().default(false),
});
export const SpeakUpReceiptDto = z.object({
  code: z.string(),
  raisedOn: isoDate,
  anonymous: z.boolean(),
  acknowledgeDue: isoDate,
  /**
   * H6: anonymous concerns only. Shown once; the hub keeps only a hash, so it cannot be shown
   * again or traced back to the person.
   */
  progressCode: z.string().optional(),
});

/** H6: an anonymous raiser checks progress with their code. */
export const SpeakUpProgressQuery = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'Enter the code exactly as it was shown'),
});
export const SpeakUpProgressDto = z.object({
  status: z.enum(['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'CLOSED']),
  feedback: z.string().nullable(),
  updatedOn: isoDate,
});
export const SpeakUpProgressFeedback = z.strictObject({
  feedback: z.string().trim().min(3).max(2000),
});
/** H6: who people can speak to; null when no guardian is named in settings. */
export const SpeakUpGuardianDto = z.object({
  guardianName: z.string().nullable(),
});
/** H6: themes for the board by quarter. Small numbers are hidden so nobody can be identified. */
export const SpeakUpThemesQuery = z.strictObject({
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
});
export const SpeakUpThemesDto = z.object({
  quarter: z.string(),
  from: isoDate,
  to: isoDate,
  total: z.string(),
  themes: z.array(z.object({ category: SpeakUpCategory, count: z.string() })),
  note: z.string(),
});

/** A guardian or manager recording a concern received another way (phone, in person...). */
export const SpeakUpRecord = z.strictObject({
  category: SpeakUpCategory,
  channel: SpeakUpChannel.exclude(['IN_APP']),
  summary: z.string().trim().min(10).max(4000),
  raisedOn: isoDate,
  anonymous: z.boolean(),
  thirdParty: z.boolean().default(false),
  /** The colleague who raised it, when not anonymous. */
  raisedByUserId: uuid.optional(),
  handlerUserId: uuid.optional(),
});

export const SpeakUpAcknowledge = z.strictObject({
  acknowledgedOn: isoDate,
  handlerUserId: uuid,
});
export const SpeakUpNoteInput = z.strictObject({
  kind: z.enum(['NOTE', 'FEEDBACK', 'DETRIMENT_CHECK']),
  note: z.string().trim().min(3).max(2000),
  on: isoDate,
  /** For a detriment check: did the person report any detriment? */
  detrimentReported: z.boolean().optional(),
});
export const SpeakUpStart = z.strictObject({ note: z.string().trim().min(3).max(2000) });
export const SpeakUpClose = z.strictObject({
  outcome: SpeakUpOutcome,
  outcomeText: z.string().trim().min(3).max(2000),
  closedOn: isoDate,
  lessons: z.string().trim().max(2000).optional(),
});

export const SpeakUpNoteDto = z.object({
  id: uuid,
  kind: z.enum(['NOTE', 'FEEDBACK', 'DETRIMENT_CHECK', 'STATUS']),
  note: z.string(),
  on: isoDate,
  detrimentReported: z.boolean().nullable(),
  createdByName: z.string().nullable(),
  createdAt: isoDateTime,
});
export const SpeakUpDto = z.object({
  id: uuid,
  code: z.string(),
  category: SpeakUpCategory,
  channel: SpeakUpChannel,
  anonymous: z.boolean(),
  thirdParty: z.boolean(),
  /** Null when anonymous. */
  raisedByName: z.string().nullable(),
  summary: z.string(),
  raisedOn: isoDate,
  acknowledgeDue: isoDate,
  acknowledgedOn: isoDate.nullable(),
  acknowledgeOverdue: z.boolean(),
  handlerUserId: uuid.nullable(),
  handlerName: z.string().nullable(),
  status: SpeakUpStatus,
  feedbackGivenOn: isoDate.nullable(),
  outcome: SpeakUpOutcome.nullable(),
  outcomeText: z.string().nullable(),
  lessons: z.string().nullable(),
  closedOn: isoDate.nullable(),
  closedByName: z.string().nullable(),
  detrimentCheckDue: isoDate.nullable(),
  detrimentCheckedOn: isoDate.nullable(),
  detrimentCheckOverdue: z.boolean(),
  notes: z.array(SpeakUpNoteDto).optional(),
  version: z.number().int(),
});
export type SpeakUpDto = z.infer<typeof SpeakUpDto>;
export const SpeakUpQuery = z.object({
  status: SpeakUpStatus.optional(),
  category: SpeakUpCategory.optional(),
});

/** What the person who raised a named concern can see about it. No notes, no handler detail. */
export const MySpeakUpDto = z.object({
  code: z.string(),
  category: SpeakUpCategory,
  raisedOn: isoDate,
  status: SpeakUpStatus,
  acknowledgedOn: isoDate.nullable(),
  feedbackGivenOn: isoDate.nullable(),
  closedOn: isoDate.nullable(),
});

// ---- sexual harassment risk assessment --------------------------------------------------------
export const HarassmentRisk = z.strictObject({
  /** Where or when the risk arises, e.g. "Lone crew on night discharges". */
  area: z.string().trim().min(3).max(200),
  risk: z.string().trim().min(3).max(1000),
  controls: z.string().trim().min(3).max(1000),
  furtherAction: z.string().trim().max(1000).optional(),
  /** Includes harassment by patients, visitors or contractors. */
  thirdParty: z.boolean().default(false),
});
export const HarassmentAssessmentInput = z.strictObject({
  title: z.string().trim().min(3).max(200),
  assessedOn: isoDate,
  reviewDue: isoDate,
  risks: z.array(HarassmentRisk).min(1).max(50),
});
export const HarassmentAssessmentDto = z.object({
  id: uuid,
  title: z.string(),
  assessedOn: isoDate,
  reviewDue: isoDate,
  risks: z.array(HarassmentRisk),
  status: z.enum(['DRAFT', 'APPROVED', 'SUPERSEDED']),
  preparedByName: z.string().nullable(),
  preparedBy: uuid,
  approvedByName: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  supersedesId: uuid.nullable(),
  version: z.number().int(),
});
export type HarassmentAssessmentDto = z.infer<typeof HarassmentAssessmentDto>;

export const HarassmentDutyDto = z.object({
  asOf: isoDate,
  steps: z.array(
    z.object({
      step: z.enum([
        'RISK_ASSESSMENT',
        'POLICY',
        'TRAINING',
        'CONCERNS_ACKNOWLEDGED',
        'DETRIMENT_CHECKS',
      ]),
      title: z.string(),
      status: z.enum(['GREEN', 'AMBER', 'RED', 'GREY']),
      reasonText: z.string(),
    }),
  ),
  /** Concern counts in the last 12 months by category (numbers only). */
  concernsLast12Months: z.record(z.string(), z.number().int()),
  note: z.string(),
});
export type HarassmentDutyDto = z.infer<typeof HarassmentDutyDto>;
