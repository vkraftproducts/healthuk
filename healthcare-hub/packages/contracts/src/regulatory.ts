import { z } from 'zod';
import { RagStatus, isoDate, isoDateTime, uuid } from './common.js';

/**
 * Task 21: registration history, the rating as CQC published it (and where it is displayed),
 * directors' fit and proper person checks, governance meetings and drafts of CQC statutory
 * notifications. The hub records; it never works out or claims a rating, and never sends
 * anything to CQC. Notification text must not identify patients.
 */
const version = z.number().int().min(1);
const status = z.object({ status: RagStatus, reasonText: z.string() });
const names = z.array(z.string().trim().min(2).max(120)).max(40);

// ---- Registration history --------------------------------------------------------------------
export const RegistrationHistoryDto = z.object({
  id: uuid,
  snapshot: z.record(z.string(), z.unknown()),
  changedFields: z.array(z.string()),
  reason: z.string().nullable(),
  changedBy: uuid,
  changedByName: z.string().nullable(),
  changedAt: isoDateTime,
});

// ---- Rating display --------------------------------------------------------------------------
export const CqcRatingValue = z.enum(['OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT', 'INADEQUATE']);
export const KeyQuestion = z.enum(['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED']);
export const CqcRatingInput = z.strictObject({
  /** Omit for the provider-level rating. */
  locationId: uuid.optional(),
  overall: CqcRatingValue,
  keyQuestions: z.partialRecord(KeyQuestion, CqcRatingValue).default({}),
  publishedOn: isoDate,
  reportUrl: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((u) => u.startsWith('https://'), 'Use the https link to the CQC report')
    .optional(),
  noWebsite: z.boolean().default(false),
});
export const CqcRatingDisplayInput = z
  .strictObject({
    displayedPremisesOn: isoDate.optional(),
    displayedWebsiteOn: isoDate.optional(),
    noWebsite: z.boolean().optional(),
    /** A photo of the premises display and a capture of the website (WORKFLOWS I2). */
    premisesEvidenceItemId: uuid.optional(),
    websiteEvidenceItemId: uuid.optional(),
  })
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
export const CqcRatingDto = z.object({
  id: uuid,
  locationId: uuid.nullable(),
  locationName: z.string().nullable(),
  overall: CqcRatingValue,
  keyQuestions: z.partialRecord(KeyQuestion, CqcRatingValue),
  publishedOn: isoDate,
  reportUrl: z.string().nullable(),
  displayDue: isoDate,
  displayedPremisesOn: isoDate.nullable(),
  displayedWebsiteOn: isoDate.nullable(),
  noWebsite: z.boolean(),
  /** The newest record for the same location (or provider). Older ones are history. */
  current: z.boolean(),
  display: status,
  recordedByName: z.string().nullable(),
  premisesEvidenceItemId: uuid.nullable().optional(),
  websiteEvidenceItemId: uuid.nullable().optional(),
  version,
});

// ---- Directors' fit and proper person checks -------------------------------------------------
export const FppItemKey = z.enum([
  'IDENTITY',
  'DBS',
  'BANKRUPTCY_INSOLVENCY',
  'DISQUALIFIED_DIRECTORS',
  'EMPLOYMENT_HISTORY',
  'REFERENCES',
  'QUALIFICATIONS',
  'HEALTH_DECLARATION',
  'SERIOUS_MISCONDUCT',
]);
export const FppOutcome = z.enum(['FIT', 'NOT_FIT', 'FURTHER_REVIEW']);
export const FppCheckInput = z.strictObject({
  directorName: z.string().trim().min(2).max(120),
  directorRole: z.string().trim().min(2).max(120),
  /** When the director is also a hub user. They cannot record their own check. */
  userId: uuid.optional(),
  checkedOn: isoDate,
  items: z
    .array(
      z.strictObject({
        item: FppItemKey,
        done: z.boolean(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(20),
  declarationOn: isoDate.optional(),
  outcome: FppOutcome,
  notes: z.string().trim().max(2000).optional(),
});
export const FppCheckDto = z.object({
  id: uuid,
  directorName: z.string(),
  directorRole: z.string(),
  userId: uuid.nullable(),
  checkedOn: isoDate,
  items: z.array(z.object({ item: z.string(), done: z.boolean(), note: z.string().optional() })),
  declarationOn: isoDate.nullable(),
  outcome: FppOutcome,
  nextReviewDue: isoDate,
  notes: z.string().nullable(),
  recordedByName: z.string().nullable(),
  createdAt: isoDateTime,
});
export const FppDirectorDto = z.object({
  directorName: z.string(),
  directorRole: z.string(),
  latest: FppCheckDto,
  state: status,
  checks: z.number().int(),
});

// ---- Governance meetings ---------------------------------------------------------------------
export const MeetingKind = z.enum([
  'BOARD',
  'CLINICAL_GOVERNANCE',
  'HEALTH_AND_SAFETY',
  'QUALITY',
  'INFECTION_CONTROL',
  'OTHER',
]);
export const MeetingInput = z.strictObject({
  kind: MeetingKind,
  title: z.string().trim().min(3).max(200),
  heldOn: isoDate,
  chair: z.string().trim().min(2).max(120),
  attendees: names.default([]),
  apologies: names.default([]),
  quorate: z.boolean(),
  minutes: z.string().trim().min(3).max(20000),
  decisions: z.string().trim().max(5000).optional(),
});
export const MeetingPatch = z
  .strictObject({
    kind: MeetingKind.optional(),
    title: z.string().trim().min(3).max(200).optional(),
    heldOn: isoDate.optional(),
    chair: z.string().trim().min(2).max(120).optional(),
    attendees: names.optional(),
    apologies: names.optional(),
    quorate: z.boolean().optional(),
    minutes: z.string().trim().min(3).max(20000).optional(),
    decisions: z.string().trim().max(5000).nullable().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
export const MeetingQuery = z.object({
  kind: MeetingKind.optional(),
  status: z.enum(['DRAFT', 'APPROVED']).optional(),
});
export const MeetingDto = z.object({
  id: uuid,
  code: z.string(),
  kind: MeetingKind,
  title: z.string(),
  heldOn: isoDate,
  chair: z.string(),
  attendees: z.array(z.string()),
  apologies: z.array(z.string()),
  quorate: z.boolean(),
  minutes: z.string(),
  decisions: z.string().nullable(),
  status: z.enum(['DRAFT', 'APPROVED']),
  recordedBy: uuid,
  recordedByName: z.string().nullable(),
  approvedByName: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  actions: z.array(
    z.object({
      id: uuid,
      code: z.string(),
      title: z.string(),
      status: z.string(),
      deadline: isoDate,
      ownerName: z.string().nullable(),
    }),
  ),
  /** The later meeting at which these minutes were agreed; approved minutes are locked. */
  approvedAtMeetingId: uuid.nullable().optional(),
  approvedAtMeetingCode: z.string().nullable().optional(),
  version,
});
export const MeetingApproveInput = z.strictObject({
  approvedAtMeetingId: uuid.optional(),
});

/** Agenda figures for a governance meeting, read from live records (WORKFLOWS I3). */
export const MeetingPackDto = z.object({
  generatedAt: isoDateTime,
  sinceOn: isoDate,
  incidents: z.object({ opened: z.number().int(), open: z.number().int() }),
  complaints: z.object({ opened: z.number().int(), open: z.number().int() }),
  actions: z.object({ open: z.number().int(), overdue: z.number().int() }),
  audits: z.object({
    submitted: z.number().int(),
    nonCompliant: z.number().int(),
    overdue: z.number().int(),
  }),
  risks: z.object({
    open: z.number().int(),
    high: z.number().int(),
    reviewOverdue: z.number().int(),
  }),
  notifications: z.object({ drafts: z.number().int(), overdue: z.number().int() }),
  policies: z.object({ reviewOverdue: z.number().int() }),
  previousDraftMinutes: z.array(z.object({ id: uuid, code: z.string(), heldOn: isoDate })),
  openMeetingActions: z.array(
    z.object({ id: uuid, code: z.string(), title: z.string(), deadline: isoDate }),
  ),
});

// ---- CQC statutory notification drafts -------------------------------------------------------
export const CqcNotificationKind = z.enum([
  'DEATH',
  'SERIOUS_INJURY',
  'ABUSE_ALLEGATION',
  'POLICE_INCIDENT',
  'SERVICE_DISRUPTION',
  'MANAGER_ABSENCE',
  'CHANGE_OF_DETAILS',
  'OTHER',
]);
export const CqcNotificationStatus = z.enum(['DRAFT', 'READY', 'SUBMITTED', 'NOT_REQUIRED']);
const noIdentifiers = (s: string) => !/\b\d{3}\s?\d{3}\s?\d{4}\b/.test(s);
const notifText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(noIdentifiers, 'Remove anything that looks like an NHS number; use the event code');
export const CqcNotificationInput = z.strictObject({
  kind: CqcNotificationKind,
  eventId: uuid.optional(),
  /** When it happened; for a manager absence, the first day of the absence. */
  occurredOn: isoDate,
  /** Manager absence only: planned in advance (due 28 days before it starts). */
  planned: z.boolean().default(false),
  summary: notifText(4000).pipe(z.string().min(10)),
  actionsTaken: notifText(4000).optional(),
});
export const CqcNotificationPatch = z
  .strictObject({
    summary: notifText(4000).pipe(z.string().min(10)).optional(),
    actionsTaken: notifText(4000).nullable().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
export const CqcNotificationTransition = z.discriminatedUnion('to', [
  z.strictObject({ to: z.literal('READY') }),
  z.strictObject({ to: z.literal('DRAFT') }),
  z.strictObject({
    to: z.literal('SUBMITTED'),
    submittedOn: isoDate,
    cqcReference: z.string().trim().min(2).max(60),
  }),
  z.strictObject({ to: z.literal('NOT_REQUIRED'), reason: z.string().trim().min(3).max(1000) }),
]);
export const CqcNotificationQuery = z.object({ status: CqcNotificationStatus.optional() });
export const CqcNotificationDto = z.object({
  id: uuid,
  code: z.string(),
  kind: CqcNotificationKind,
  eventId: uuid.nullable(),
  eventCode: z.string().nullable(),
  occurredOn: isoDate,
  dueOn: isoDate,
  summary: z.string(),
  actionsTaken: z.string().nullable(),
  status: CqcNotificationStatus,
  preparedBy: uuid,
  preparedByName: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  submittedOn: isoDate.nullable(),
  cqcReference: z.string().nullable(),
  notRequiredReason: z.string().nullable(),
  state: status,
  version,
});
// ---- NHS contracts (task 22) -----------------------------------------------------------------
export const NhsContractType = z.enum([
  'NHS_STANDARD_FULL',
  'NHS_STANDARD_SHORTFORM',
  'SUBCONTRACT',
  'OTHER',
]);
export const NhsReporting = z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL', 'NONE']);
const contractFields = {
  commissioner: z.string().trim().min(2).max(200),
  reference: z.string().trim().min(2).max(60),
  service: z.string().trim().min(2).max(200),
  contractType: NhsContractType,
  startOn: isoDate,
  endOn: isoDate,
  noticeMonths: z.number().int().min(0).max(24),
  reporting: NhsReporting,
  managerUserId: uuid,
  reviewMeetingOn: isoDate,
  notes: z.string().trim().max(2000),
};
export const NhsContractInput = z
  .strictObject({
    ...contractFields,
    noticeMonths: contractFields.noticeMonths.default(6),
    reporting: contractFields.reporting.default('MONTHLY'),
    reviewMeetingOn: isoDate.optional(),
    notes: contractFields.notes.optional(),
  })
  .refine((c) => c.endOn > c.startOn, 'The end date must be after the start date');
export const NhsContractPatch = z
  .strictObject({
    commissioner: contractFields.commissioner.optional(),
    service: contractFields.service.optional(),
    contractType: NhsContractType.optional(),
    startOn: isoDate.optional(),
    endOn: isoDate.optional(),
    noticeMonths: contractFields.noticeMonths.optional(),
    reporting: NhsReporting.optional(),
    managerUserId: uuid.optional(),
    reviewMeetingOn: isoDate.nullable().optional(),
    notes: contractFields.notes.nullable().optional(),
  })
  .refine((r) => Object.keys(r).length > 0, 'Nothing to update');
export const NhsContractDto = z.object({
  id: uuid,
  commissioner: z.string(),
  reference: z.string(),
  service: z.string(),
  contractType: NhsContractType,
  startOn: isoDate,
  endOn: isoDate,
  noticeMonths: z.number().int(),
  noticeBy: isoDate.nullable(),
  reporting: NhsReporting,
  managerUserId: uuid,
  managerName: z.string().nullable(),
  reviewMeetingOn: isoDate.nullable(),
  notes: z.string().nullable(),
  state: status,
  version,
});
export const NhsContractItemDto = z.object({
  instanceId: uuid,
  templateCode: z.string(),
  title: z.string(),
  status: RagStatus,
  reasonText: z.string(),
  dueDate: isoDate.nullable(),
  ownerName: z.string().nullable(),
});
export const NhsContractsDto = z.object({
  contracts: z.array(NhsContractDto),
  items: z.array(NhsContractItemDto),
  summary: z.object({
    total: z.number().int(),
    met: z.number().int(),
    notMet: z.number().int(),
    notApplicable: z.number().int(),
  }),
  /** NHS pack templates not yet adopted by the organisation. */
  notAdopted: z.number().int(),
});

/** Events that may need a notification and have none yet. */
export const NotificationSuggestionDto = z.object({
  eventId: uuid,
  eventCode: z.string(),
  title: z.string(),
  occurredOn: isoDate,
  kind: CqcNotificationKind,
});

export type RegistrationHistoryDto = z.infer<typeof RegistrationHistoryDto>;
export type CqcRatingValue = z.infer<typeof CqcRatingValue>;
export type KeyQuestion = z.infer<typeof KeyQuestion>;
export type CqcRatingInput = z.infer<typeof CqcRatingInput>;
export type CqcRatingDisplayInput = z.infer<typeof CqcRatingDisplayInput>;
export type CqcRatingDto = z.infer<typeof CqcRatingDto>;
export type FppItemKey = z.infer<typeof FppItemKey>;
export type FppOutcome = z.infer<typeof FppOutcome>;
export type FppCheckInput = z.infer<typeof FppCheckInput>;
export type FppCheckDto = z.infer<typeof FppCheckDto>;
export type FppDirectorDto = z.infer<typeof FppDirectorDto>;
export type MeetingKind = z.infer<typeof MeetingKind>;
export type MeetingInput = z.infer<typeof MeetingInput>;
export type MeetingPatch = z.infer<typeof MeetingPatch>;
export type MeetingQuery = z.infer<typeof MeetingQuery>;
export type MeetingDto = z.infer<typeof MeetingDto>;
export type MeetingApproveInput = z.infer<typeof MeetingApproveInput>;
export type MeetingPackDto = z.infer<typeof MeetingPackDto>;
export type CqcNotificationKind = z.infer<typeof CqcNotificationKind>;
export type CqcNotificationStatus = z.infer<typeof CqcNotificationStatus>;
export type CqcNotificationInput = z.infer<typeof CqcNotificationInput>;
export type CqcNotificationPatch = z.infer<typeof CqcNotificationPatch>;
export type CqcNotificationTransition = z.infer<typeof CqcNotificationTransition>;
export type CqcNotificationQuery = z.infer<typeof CqcNotificationQuery>;
export type CqcNotificationDto = z.infer<typeof CqcNotificationDto>;
export type NhsContractType = z.infer<typeof NhsContractType>;
export type NhsReporting = z.infer<typeof NhsReporting>;
export type NhsContractInput = z.infer<typeof NhsContractInput>;
export type NhsContractPatch = z.infer<typeof NhsContractPatch>;
export type NhsContractDto = z.infer<typeof NhsContractDto>;
export type NhsContractItemDto = z.infer<typeof NhsContractItemDto>;
export type NhsContractsDto = z.infer<typeof NhsContractsDto>;
export type NotificationSuggestionDto = z.infer<typeof NotificationSuggestionDto>;
