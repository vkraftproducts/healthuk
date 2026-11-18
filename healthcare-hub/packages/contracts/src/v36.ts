import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';
import { StaffRole } from './staff.js';

/**
 * v36 registers that the earlier backend did not keep (17 Nov 2026). Batch 1: safeguarding
 * referrals, vehicle accidents and damage, vehicle medicines and gases, controlled drug checks.
 * Free text never names a patient: patients are identified by a reference only.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const list = <T extends z.ZodType>(t: T) => z.object({ data: z.array(t) });

/** Overdue escalation stage for status pills (staff checks, DVLA, deep cleans, supervision). */
export const EscalationDto = z
  .object({
    stage: z.enum(['LEAD', 'MANAGER']),
    toName: z.string().nullable(),
  })
  .nullable();

// ---- safeguarding referrals -----------------------------------------------------------------
export const SafeguardingAbout = z.enum(['ADULT', 'CHILD']);
export const SafeguardingCategory = z.enum([
  'PHYSICAL',
  'NEGLECT',
  'SELF_NEGLECT',
  'FINANCIAL',
  'PSYCHOLOGICAL',
  'SEXUAL',
  'DOMESTIC',
  'MODERN_SLAVERY',
  'DISCRIMINATORY',
  'ORGANISATIONAL',
  'OTHER',
]);
export const SafeguardingStatus = z.enum(['RAISED', 'REFERRED', 'NOT_REFERRED', 'CLOSED']);
/** A patient reference such as PT-4390 or a job/booking number; never a name. */
export const PatientRef = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9/-]{1,29}$/, 'Use a patient, job or booking reference, not a name');

export const SafeguardingRaise = z.strictObject({
  about: SafeguardingAbout,
  category: SafeguardingCategory,
  patientRef: PatientRef,
  details: text(10, 2000),
  raisedByUserId: uuid,
  raisedOn: isoDate,
  eventId: uuid.optional(),
  /** An allegation of abuse: a CQC notification draft (Reg 18) is created with the record. */
  abuseAllegation: z.boolean().default(false),
});
export const SafeguardingRefer = z.strictObject({
  referredOn: isoDate,
  agency: text(3, 200),
  agencyReference: text(2, 60),
});
export const SafeguardingNotReferred = z.strictObject({ reason: text(10, 2000) });
export const SafeguardingOutcome = z.strictObject({
  outcome: text(3, 2000),
  outcomeOn: isoDate,
});
export const SafeguardingQuery = z.strictObject({ status: SafeguardingStatus.optional() });
export const SafeguardingReferralDto = z.object({
  id: uuid,
  code: z.string(),
  about: SafeguardingAbout,
  category: SafeguardingCategory,
  patientRef: z.string(),
  details: z.string(),
  raisedByUserId: uuid,
  raisedByName: z.string().nullable(),
  raisedOn: isoDate,
  recordedByName: z.string().nullable(),
  eventId: uuid.nullable(),
  eventCode: z.string().nullable(),
  abuseAllegation: z.boolean(),
  cqcNotificationId: uuid.nullable(),
  cqcNotificationCode: z.string().nullable(),
  status: SafeguardingStatus,
  referredOn: isoDate.nullable(),
  agency: z.string().nullable(),
  agencyReference: z.string().nullable(),
  decisionReason: z.string().nullable(),
  decidedByName: z.string().nullable(),
  outcome: z.string().nullable(),
  outcomeOn: isoDate.nullable(),
  closedByName: z.string().nullable(),
  /** Days since raised with no referral decision (0 once decided). */
  daysUndecided: z.number().int(),
  version: z.number().int(),
});
export type SafeguardingReferralDto = z.infer<typeof SafeguardingReferralDto>;
export const SafeguardingListDto = z.object({
  data: z.array(SafeguardingReferralDto),
  summary: z.object({ open: z.number().int(), undecided: z.number().int() }),
});

// ---- vehicle accidents and damage -----------------------------------------------------------
export const AccidentReport = z.strictObject({
  vehicleId: uuid,
  occurredAt: isoDateTime,
  place: text(2, 200).optional(),
  description: text(10, 2000),
  /** Name, insurer and registration of the other party, or "None". */
  thirdParty: text(2, 500),
  policeRef: text(2, 60).optional(),
  injuries: z.boolean().default(false),
  eventId: uuid.optional(),
  photoEvidenceItemIds: z.array(uuid).max(6).default([]),
  /** false: a critical stop-use defect is raised so the vehicle is blocked until released. */
  roadworthy: z.boolean(),
});
export const AccidentInsurer = z.strictObject({
  insurerRef: text(2, 60),
  insurerNotifiedOn: isoDate,
});
export const AccidentLinkEvent = z.strictObject({ eventId: uuid });
export const AccidentClose = z.strictObject({ note: text(3, 1000) });
export const AccidentQuery = z.strictObject({
  vehicleId: uuid.optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});
export const AccidentDto = z.object({
  id: uuid,
  code: z.string(),
  vehicleId: uuid,
  vehicleLabel: z.string(),
  occurredAt: isoDateTime,
  place: z.string().nullable(),
  description: z.string(),
  thirdParty: z.string(),
  policeRef: z.string().nullable(),
  injuries: z.boolean(),
  eventId: uuid.nullable(),
  eventCode: z.string().nullable(),
  photoCount: z.number().int(),
  roadworthy: z.boolean(),
  defectId: uuid.nullable(),
  /** OPEN/CLASSIFIED/IN_REPAIR/REPAIRED/RELEASED from the linked defect. */
  defectStatus: z.string().nullable(),
  releasedByName: z.string().nullable(),
  insurerRef: z.string().nullable(),
  insurerNotifiedOn: isoDate.nullable(),
  reportedByName: z.string().nullable(),
  status: z.enum(['OPEN', 'CLOSED']),
  /** Plain words: "Off the road – awaiting repair and release", "Back in service", ... */
  stateText: z.string(),
  closeNote: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: isoDateTime.nullable(),
  version: z.number().int(),
});
export type AccidentDto = z.infer<typeof AccidentDto>;

// ---- vehicle medicines and gases ------------------------------------------------------------
export const StockKind = z.enum(['MEDICAL_GAS', 'MEDICINE', 'SEALED_POUCH']);
export const StockItemCreate = z.strictObject({
  vehicleId: uuid,
  kind: StockKind,
  name: text(2, 120),
  expectedQty: z.number().int().min(1).max(999),
});
export const StockItemRetire = z.strictObject({ reason: text(3, 300) });
export const StockCheckLine = z.strictObject({
  itemId: uuid,
  found: z.number().int().min(0).max(999),
  /** Earliest expiry on board for this item. */
  expiresOn: isoDate,
  /** Sealed pouches and gas cylinder seals; ignored for loose items. */
  sealIntact: z.boolean().default(true),
});
export const StockCheckCreate = z.strictObject({
  vehicleId: uuid,
  lines: z.array(StockCheckLine).min(1).max(100),
  note: text(3, 1000).optional(),
});
export const StockItemDto = z.object({
  id: uuid,
  vehicleId: uuid,
  kind: StockKind,
  name: z.string(),
  expectedQty: z.number().int(),
  /** From the latest check, or null when never checked. */
  lastFound: z.number().int().nullable(),
  lastExpiresOn: isoDate.nullable(),
  lastSealIntact: z.boolean().nullable(),
  lastCheckedAt: isoDateTime.nullable(),
  state: z.enum(['NOT_CHECKED', 'OK', 'SHORT', 'EXPIRING', 'EXPIRED', 'SEAL_BROKEN']),
  stateText: z.string(),
});
export const VehicleStockDto = z.object({
  vehicleId: uuid,
  vehicleLabel: z.string(),
  items: z.array(StockItemDto),
  lastCheck: z
    .object({
      id: uuid,
      checkedAt: isoDateTime,
      checkedByName: z.string().nullable(),
      shortCount: z.number().int(),
      expiredCount: z.number().int(),
      sealBrokenCount: z.number().int(),
    })
    .nullable(),
});
export const StockCheckDto = z.object({
  id: uuid,
  vehicleId: uuid,
  checkedAt: isoDateTime,
  checkedByName: z.string().nullable(),
  shortCount: z.number().int(),
  expiredCount: z.number().int(),
  sealBrokenCount: z.number().int(),
  note: z.string().nullable(),
  lines: z.array(
    z.object({
      itemId: uuid,
      name: z.string(),
      expected: z.number().int(),
      found: z.number().int(),
      expiresOn: isoDate,
      sealIntact: z.boolean(),
    }),
  ),
});

// ---- controlled drug balance checks ----------------------------------------------------------
export const CdCheckCreate = z.strictObject({
  drug: text(3, 160),
  store: text(2, 120),
  vehicleId: uuid.optional(),
  /** The balance written in the controlled drug register. */
  registerBalance: z.number().int().min(0).max(100000),
  countedBalance: z.number().int().min(0).max(100000),
  witnessUserId: uuid,
  note: text(3, 1000).optional(),
});
export const CdWitness = z.strictObject({
  agree: z.boolean(),
  note: text(3, 500).optional(),
});
export const CdLinkEvent = z.strictObject({ eventId: uuid });
export const CdCheckDto = z.object({
  id: uuid,
  code: z.string(),
  drug: z.string(),
  store: z.string(),
  vehicleId: uuid.nullable(),
  vehicleLabel: z.string().nullable(),
  registerBalance: z.number().int(),
  countedBalance: z.number().int(),
  discrepancy: z.boolean(),
  checkedByName: z.string().nullable(),
  checkedAt: isoDateTime,
  witnessUserId: uuid,
  witnessName: z.string().nullable(),
  status: z.enum(['AWAITING_WITNESS', 'WITNESSED', 'WITNESS_REFUSED']),
  witnessedAt: isoDateTime.nullable(),
  witnessNote: z.string().nullable(),
  eventId: uuid.nullable(),
  eventCode: z.string().nullable(),
  /** A difference (or a refused witness) with no incident linked yet. */
  needsIncident: z.boolean(),
  note: z.string().nullable(),
  /** The caller is the named witness and has not signed yet. */
  awaitingMe: z.boolean(),
});
export type CdCheckDto = z.infer<typeof CdCheckDto>;

// ================================================================================================
// Batch 2: reviews, sickness absence, leavers (v36 screen 35)
export const ReviewKind = z.enum(['PROBATION_3M', 'PROBATION_6M', 'APPRAISAL', 'OTHER']);
export const ReviewOutcome = z.enum([
  'PASSED',
  'EXTENDED',
  'NOT_PASSED',
  'MEETS',
  'EXCEEDS',
  'NEEDS_SUPPORT',
  'RECORDED',
]);
export const ReviewSchedule = z.strictObject({
  staffId: uuid,
  kind: ReviewKind,
  dueOn: isoDate,
});
export const ReviewRecord = z.strictObject({
  outcome: ReviewOutcome,
  reviewedOn: isoDate,
  reviewerUserId: uuid,
  notes: text(3, 4000).optional(),
  /** Appraisals: objectives for the coming year (required). */
  objectives: text(3, 4000).optional(),
});
export const ReviewCancel = z.strictObject({ reason: text(3, 500) });
export const ReviewQuery = z.strictObject({
  staffId: uuid.optional(),
  status: z.enum(['SCHEDULED', 'DONE', 'CANCELLED']).optional(),
});
export const ReviewDto = z.object({
  id: uuid,
  code: z.string(),
  staffId: uuid,
  staffName: z.string(),
  staffNo: z.string(),
  kind: ReviewKind,
  dueOn: isoDate,
  status: z.enum(['SCHEDULED', 'DONE', 'CANCELLED']),
  /** Plain words: "Overdue by 3 days", "Due in 12 days", "Done 4 Mar 2026". */
  dueText: z.string(),
  overdue: z.boolean(),
  outcome: ReviewOutcome.nullable(),
  notes: z.string().nullable(),
  objectives: z.string().nullable(),
  reviewedOn: isoDate.nullable(),
  reviewerName: z.string().nullable(),
  cancelReason: z.string().nullable(),
  /** The review scheduled automatically after this one, if any. */
  nextReviewId: uuid.nullable(),
  /** Present when overdue past the staff-check lead/manager thresholds. */
  escalation: EscalationDto.optional(),
  version: z.number().int(),
});
export type ReviewDto = z.infer<typeof ReviewDto>;

export const AbsenceCategory = z.enum([
  'MUSCULOSKELETAL',
  'RESPIRATORY',
  'GASTROINTESTINAL',
  'MENTAL_HEALTH',
  'INJURY_AT_WORK',
  'INFECTION',
  'OTHER',
]);
export const AbsenceRecord = z.strictObject({
  staffId: uuid,
  firstDay: isoDate,
  /** Leave out while the person is still off. */
  lastDay: isoDate.optional(),
  category: AbsenceCategory,
});
export const AbsenceReturn = z.strictObject({
  /** Required when the absence is still open. */
  lastDay: isoDate.optional(),
  rtwOn: isoDate,
  rtwByUserId: uuid,
  note: text(3, 1000).optional(),
  phased: z.boolean().default(false),
  phasedTerms: text(3, 200).optional(),
  phasedUntil: isoDate.optional(),
});
export const AbsenceQuery = z.strictObject({ staffId: uuid.optional() });
export const AbsenceDto = z.object({
  id: uuid,
  code: z.string(),
  staffId: uuid,
  staffName: z.string(),
  firstDay: isoDate,
  lastDay: isoDate.nullable(),
  stillOff: z.boolean(),
  category: AbsenceCategory,
  days: z.number().int(),
  rtwOn: isoDate.nullable(),
  rtwByName: z.string().nullable(),
  rtwNote: z.string().nullable(),
  /** Back at work but no return-to-work interview recorded yet. */
  rtwMissing: z.boolean(),
  phased: z.boolean(),
  phasedTerms: z.string().nullable(),
  phasedUntil: isoDate.nullable(),
  version: z.number().int(),
});
export const AbsenceTriggerDto = z.object({
  staffId: uuid,
  staffName: z.string(),
  /** Episodes starting in the last 6 months. */
  episodes6m: z.number().int(),
  /** Bradford factor over 12 months: episodes² × days. */
  bradford12m: z.number().int(),
  reached: z.boolean(),
});
export const AbsenceListDto = z.object({
  data: z.array(AbsenceDto),
  triggers: z.array(AbsenceTriggerDto),
});

export const LeaverReason = z.enum([
  'RESIGNED',
  'RETIRED',
  'END_OF_CONTRACT',
  'DISMISSED',
  'REDUNDANCY',
  'OTHER',
]);
export const LeaverStart = z.strictObject({
  staffId: uuid,
  lastDay: isoDate,
  reason: LeaverReason,
  reasonNote: text(3, 500).optional(),
});
export const LeaverTick = z.strictObject({
  item: z.enum(['BADGE', 'KIT', 'PAYROLL', 'EXIT_INTERVIEW']),
  /** Exit interview only: whether it was held or the person declined. */
  exitInterview: z.enum(['DONE', 'DECLINED']).optional(),
});
export const LeaverCancel = z.strictObject({ reason: text(3, 500) });
export const LeaverDto = z.object({
  id: uuid,
  code: z.string(),
  staffId: uuid,
  staffName: z.string(),
  lifecycleState: z.string(),
  lastDay: isoDate,
  reason: LeaverReason,
  reasonNote: z.string().nullable(),
  status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']),
  checklist: z.array(
    z.object({
      item: z.enum(['ACCESS', 'BADGE', 'KIT', 'PAYROLL', 'EXIT_INTERVIEW']),
      label: z.string(),
      done: z.boolean(),
      doneText: z.string().nullable(),
    }),
  ),
  doneCount: z.number().int(),
  keepUntil: isoDate.nullable(),
  completedAt: isoDateTime.nullable(),
  startedByName: z.string().nullable(),
  version: z.number().int(),
});
export type LeaverDto = z.infer<typeof LeaverDto>;

// ================================================================================================
// Batch 3: open shifts, swaps, hours, patterns (v36 screen 34)
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM');
const role = z.string().regex(/^[A-Z_]{2,40}$/);

export const OpenShiftPost = z.strictObject({
  shiftId: uuid,
  role,
  /** Defaults to the whole shift. */
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  note: text(3, 500).optional(),
});
export const OpenShiftFill = z.strictObject({ staffId: uuid });
export const OpenShiftCancel = z.strictObject({ reason: text(3, 500) });
export const OpenShiftDto = z.object({
  id: uuid,
  code: z.string(),
  shiftId: uuid,
  vehicleLabel: z.string(),
  role: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  note: z.string().nullable(),
  status: z.enum(['OPEN', 'FILLED', 'CANCELLED']),
  postedByName: z.string().nullable(),
  offers: z.array(
    z.object({ staffId: uuid, staffName: z.string(), offeredAt: isoDateTime, mine: z.boolean() }),
  ),
  filledStaffName: z.string().nullable(),
  filledByName: z.string().nullable(),
  filledAt: isoDateTime.nullable(),
  cancelReason: z.string().nullable(),
  /** The caller has offered to cover it. */
  offeredByMe: z.boolean(),
});

export const SwapRequest = z.strictObject({
  fromAssignmentId: uuid,
  toAssignmentId: uuid,
  reason: text(3, 500),
});
export const SwapDecide = z.strictObject({
  approve: z.boolean(),
  note: text(3, 500).optional(),
});
export const SwapDto = z.object({
  id: uuid,
  code: z.string(),
  status: z.enum(['REQUESTED', 'AGREED', 'DECLINED', 'APPROVED', 'REFUSED', 'WITHDRAWN']),
  reason: z.string(),
  from: z.object({
    assignmentId: uuid,
    staffId: uuid,
    staffName: z.string(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    vehicleLabel: z.string(),
  }),
  to: z.object({
    assignmentId: uuid,
    staffId: uuid,
    staffName: z.string(),
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    vehicleLabel: z.string(),
  }),
  requestedByName: z.string().nullable(),
  decidedByName: z.string().nullable(),
  decisionNote: z.string().nullable(),
  /** Working-time prompts for both people after the swap (rest and 48-hour week). */
  warnings: z.array(z.string()),
  /** What the caller can do now. */
  canAgree: z.boolean(),
  canDecide: z.boolean(),
  canWithdraw: z.boolean(),
  createdAt: isoDateTime,
});

const SwapOption = z.object({
  assignmentId: uuid,
  staffId: uuid,
  staffName: z.string(),
  role: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  vehicleLabel: z.string(),
});
export const SwapOptionsDto = z.object({
  mine: z.array(SwapOption),
  colleagues: z.array(SwapOption),
});

export const ClockIn = z.strictObject({ assignmentId: uuid });
export const ClockOut = z.strictObject({ breakMinutes: z.number().int().min(0).max(600) });
export const TimeCorrect = z.strictObject({
  assignmentId: uuid,
  clockIn: isoDateTime,
  clockOut: isoDateTime,
  breakMinutes: z.number().int().min(0).max(600),
  reason: text(3, 500),
});
export const HoursQuery = z.strictObject({ from: isoDate, to: isoDate });
export const TimeEntryDto = z.object({
  id: uuid,
  assignmentId: uuid,
  shiftId: uuid,
  staffId: uuid,
  clockIn: isoDateTime,
  clockOut: isoDateTime.nullable(),
  breakMinutes: z.number().int(),
  source: z.enum(['CREW_APP', 'MANAGER']),
  corrected: z.boolean(),
  reason: z.string().nullable(),
});
export const HoursDto = z.object({
  from: isoDate,
  to: isoDate,
  people: z.array(
    z.object({
      staffId: uuid,
      staffName: z.string(),
      shifts: z.number().int(),
      plannedMinutes: z.number().int(),
      actualMinutes: z.number().int(),
      /** Assignments that ended with no clock-out (or no clock-in at all). */
      missing: z.number().int(),
      overrunShifts: z.number().int(),
    }),
  ),
  entries: z.array(
    z.object({
      assignmentId: uuid,
      shiftId: uuid,
      staffId: uuid,
      staffName: z.string(),
      vehicleLabel: z.string(),
      plannedStart: isoDateTime,
      plannedEnd: isoDateTime,
      entry: TimeEntryDto.nullable(),
    }),
  ),
  note: z.string(),
});
export const MyTimeDto = z.object({
  data: z.array(
    z.object({
      assignmentId: uuid,
      shiftId: uuid,
      vehicleLabel: z.string(),
      plannedStart: isoDateTime,
      plannedEnd: isoDateTime,
      entry: TimeEntryDto.nullable(),
    }),
  ),
});

export const PatternCreate = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, 'Up to 6 letters or digits'),
  name: text(2, 80),
  startTime: hhmm,
  endTime: hhmm,
  paidBreakMinutes: z.number().int().min(0).max(180).default(0),
  onDays: z.number().int().min(1).max(14),
  offDays: z.number().int().min(0).max(14),
});
export const PatternDatesQuery = z.strictObject({
  from: isoDate,
  weeks: z.coerce.number().int().min(1).max(12).default(4),
});
export const PatternDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  paidBreakMinutes: z.number().int(),
  onDays: z.number().int(),
  offDays: z.number().int(),
  /** Hours from start to end (overnight wraps), less nothing: breaks are paid. */
  lengthHours: z.number(),
  overnight: z.boolean(),
  active: z.boolean(),
  /** Working-time prompt for this pattern on its own (under 11h rest between shifts). */
  restWarning: z.string().nullable(),
});
export const PatternDatesDto = z.object({
  patternId: uuid,
  dates: z.array(z.object({ date: isoDate, startsAt: isoDateTime, endsAt: isoDateTime })),
});

// ================================================================================================
// Batch 4: business continuity (screen 43), statement of purpose (screen 40), DSPT (screen 39)
export const ContinuityPlanCreate = z.strictObject({
  title: text(3, 200),
  steps: text(10, 4000),
  ownerUserId: uuid,
});
export const ContinuityPlanRetire = z.strictObject({ reason: text(3, 500) });
export const ContinuityTestRecord = z.strictObject({
  testedOn: isoDate,
  method: z.enum(['TABLETOP', 'LIVE', 'REAL_EVENT']),
  result: z.enum(['PASSED', 'PASSED_WITH_ISSUES', 'ACTIONS_RAISED', 'FAILED']),
  notes: text(3, 2000).optional(),
  /** Required unless the result is a clean pass. */
  followUp: text(3, 2000).optional(),
  /**
   * "Actions raised" and "Failed" raise a tracked action (in the actions list, closed by someone
   * other than its owner): who owns it and by when. The follow-up text is its title.
   */
  actionOwnerUserId: uuid.optional(),
  actionDeadline: isoDate.optional(),
});
export const ContinuityPlanDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  steps: z.string(),
  ownerUserId: uuid,
  ownerName: z.string().nullable(),
  status: z.enum(['ACTIVE', 'RETIRED']),
  lastTestedOn: isoDate.nullable(),
  lastResult: z.string().nullable(),
  /** A plan is tested at least once a year. */
  testDue: isoDate.nullable(),
  testOverdue: z.boolean(),
  tests: z.array(
    z.object({
      id: uuid,
      testedOn: isoDate,
      method: z.string(),
      result: z.string(),
      notes: z.string().nullable(),
      followUp: z.string().nullable(),
      recordedByName: z.string().nullable(),
      actionId: uuid.nullable(),
      actionCode: z.string().nullable(),
      actionStatus: z.string().nullable(),
    }),
  ),
});

export const SopDraft = z.strictObject({
  summary: text(3, 2000),
  /** The statement of purpose document uploaded as evidence (optional). */
  evidenceItemId: uuid.optional(),
});
export const SopVersionDto = z.object({
  id: uuid,
  versionNo: z.number().int(),
  summary: z.string(),
  evidenceItemId: uuid.nullable(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN']),
  draftedByName: z.string().nullable(),
  draftedAt: isoDateTime,
  publishedByName: z.string().nullable(),
  publishedAt: isoDateTime.nullable(),
  notificationId: uuid.nullable(),
  notificationCode: z.string().nullable(),
  /** The caller drafted it, so someone else must publish. */
  draftedByMe: z.boolean(),
});

export const DsptStart = z.strictObject({
  year: z.string().regex(/^20[0-9]{2}-[0-9]{2}$/, 'Use the toolkit year, e.g. 2026-27'),
  dueOn: isoDate,
});
export const DsptMark = z.strictObject({
  evidenceNote: text(3, 1000),
  evidenceItemId: uuid.optional(),
});
export const DsptSubmit = z.strictObject({
  submittedOn: isoDate,
  outcome: z.enum([
    'STANDARDS_EXCEEDED',
    'STANDARDS_MET',
    'APPROACHING_STANDARDS',
    'STANDARDS_NOT_MET',
  ]),
  reference: text(2, 60).optional(),
});
export const DsptAssessmentDto = z.object({
  id: uuid,
  year: z.string(),
  dueOn: isoDate,
  status: z.enum(['IN_PROGRESS', 'SUBMITTED']),
  submittedOn: isoDate.nullable(),
  outcome: z.string().nullable(),
  submittedByName: z.string().nullable(),
  reference: z.string().nullable(),
  inPlace: z.number().int(),
  total: z.number().int(),
  items: z.array(
    z.object({
      id: uuid,
      position: z.number().int(),
      title: z.string(),
      status: z.enum(['NOT_YET', 'IN_PLACE']),
      evidenceNote: z.string().nullable(),
      evidenceItemId: uuid.nullable(),
      markedByName: z.string().nullable(),
      markedAt: isoDateTime.nullable(),
      /** Figures the hub can work out itself (training), shown beside the item. */
      hint: z.string().nullable(),
    }),
  ),
});

export const v36Lists = {
  safeguarding: SafeguardingListDto,
  accidents: list(AccidentDto),
  stock: list(VehicleStockDto),
  stockChecks: list(StockCheckDto),
  cdChecks: list(CdCheckDto),
};

// ---- records by date: equipment inspections (Reports, 18 Nov 2026) ----------------------------
export const RecordsQuery = z.strictObject({
  days: z.coerce.number().int().min(1).max(366).default(30),
});
export const EquipmentInspectionDto = z.object({
  id: z.string().uuid(),
  verifiedAt: z.string(),
  decision: z.enum(['VERIFIED', 'REJECTED']),
  assetId: z.string().uuid(),
  assetTag: z.string(),
  category: z.string(),
  vehicleId: z.string().uuid().nullable(),
  check: z.string(),
  reviewerName: z.string().nullable(),
});
export type EquipmentInspectionDto = z.infer<typeof EquipmentInspectionDto>;

// ---- CQC self-audit (v36 Compliance › Audits & actions, 18 Nov 2026) ---------------------------
/** The statements a provider assesses itself against, by CQC key question (from the v36 design). */
export const CQC_SELF_AUDIT: {
  key: string;
  label: string;
  icon: string;
  questions: { key: string; text: string; regulation: number | null }[];
}[] = [
  {
    key: 'SAFE',
    label: 'Safe',
    icon: 'shield',
    questions: [
      { key: 'SAFE-1', text: 'Systems protect patients from abuse and avoidable harm', regulation: 13 },
      { key: 'SAFE-2', text: 'Safeguarding processes are written down and shared with all staff', regulation: 13 },
      { key: 'SAFE-3', text: 'Patients are protected from discrimination and psychological harm', regulation: null },
      { key: 'SAFE-4', text: 'Recruitment, staff support, disciplinary steps and ongoing checks are safe', regulation: 11 },
      { key: 'SAFE-5', text: 'Staff are trained in safety systems and procedures', regulation: 11 },
      { key: 'SAFE-6', text: 'Staff understand and follow the safeguarding policy', regulation: null },
      { key: 'SAFE-7', text: 'Bank, agency and hired crews meet the same safety checks', regulation: 11 },
      { key: 'SAFE-8', text: 'Risk assessments and management plans follow national guidance', regulation: 6 },
      { key: 'SAFE-9', text: 'Safety impact is assessed when the service or staffing changes', regulation: null },
      { key: 'SAFE-10', text: 'Individual journey and care records are complete and well kept', regulation: 4 },
      { key: 'SAFE-11', text: 'All staff handle medicines safely', regulation: null },
      { key: 'SAFE-12', text: 'Medicines are prescribed, given and supplied appropriately', regulation: null },
      { key: 'SAFE-13', text: 'Patients receive medicines as intended and this is recorded', regulation: null },
      { key: 'SAFE-14', text: 'Medicines, including as-needed ones, are reviewed regularly', regulation: null },
      { key: 'SAFE-15', text: 'Behaviour is never controlled by excessive or inappropriate medication', regulation: null },
    ],
  },
  {
    key: 'EFFECTIVE',
    label: 'Effective',
    icon: 'task_alt',
    questions: [
      { key: 'EFFECTIVE-1', text: 'Lessons are learned and improvements made when things go wrong', regulation: 13 },
      { key: 'EFFECTIVE-2', text: 'Technology and equipment support safe care and independence', regulation: 5 },
      { key: 'EFFECTIVE-3', text: 'Staff know patients’ rights under the Mental Health Act Code', regulation: null },
      { key: 'EFFECTIVE-4', text: 'Outcome data is routinely collected and monitored', regulation: 7 },
      { key: 'EFFECTIVE-5', text: 'Staff have the skills, knowledge and experience for their role', regulation: 11 },
      { key: 'EFFECTIVE-6', text: 'Patient needs and choices are met by suitably skilled staff', regulation: 4 },
      { key: 'EFFECTIVE-7', text: 'Staff are encouraged and given chances to develop', regulation: 2 },
      { key: 'EFFECTIVE-8', text: 'Poor or inconsistent performance is identified and managed', regulation: 2 },
      { key: 'EFFECTIVE-9', text: 'Teams and partner organisations plan and deliver care together', regulation: null },
      { key: 'EFFECTIVE-10', text: 'Patients who need extra support are identified', regulation: 4 },
      { key: 'EFFECTIVE-11', text: 'Patients are supported to manage their own health and wellbeing', regulation: null },
      { key: 'EFFECTIVE-12', text: 'Consent is sought in line with law and guidance', regulation: null },
      { key: 'EFFECTIVE-13', text: 'Staff understand consent and decision-making law', regulation: 11 },
      { key: 'EFFECTIVE-14', text: 'The consent process is reviewed against law and guidance', regulation: null },
    ],
  },
  {
    key: 'CARING',
    label: 'Caring',
    icon: 'volunteer_activism',
    questions: [
      { key: 'CARING-1', text: 'Patients are treated with kindness, respect and emotional support', regulation: null },
      { key: 'CARING-2', text: 'Personal, cultural, social and religious needs are understood and respected', regulation: null },
      { key: 'CARING-3', text: 'Interactions with patients and families are respectful and considerate', regulation: null },
      { key: 'CARING-4', text: 'Staff attitudes are encouraging, sensitive and supportive', regulation: null },
      { key: 'CARING-5', text: 'Staff raise concerns about disrespectful or abusive behaviour', regulation: 13 },
      { key: 'CARING-6', text: 'Patients get timely support and information to cope emotionally', regulation: null },
      { key: 'CARING-7', text: 'Patients are helped to use advocacy and support networks', regulation: null },
      { key: 'CARING-8', text: 'Privacy, dignity and independence are respected and promoted', regulation: 9 },
      { key: 'CARING-9', text: 'Privacy and dignity needs are consistently understood', regulation: null },
      { key: 'CARING-10', text: 'Staff respond compassionately to pain, discomfort and distress', regulation: null },
      { key: 'CARING-11', text: 'Personal information is kept confidential under data protection law', regulation: 12 },
    ],
  },
  {
    key: 'RESPONSIVE',
    label: 'Responsive',
    icon: 'support_agent',
    questions: [
      { key: 'RESPONSIVE-1', text: 'Care is personalised and responds to individual needs', regulation: 4 },
      { key: 'RESPONSIVE-2', text: 'Vehicles, premises and facilities suit the service delivered', regulation: 6 },
      { key: 'RESPONSIVE-3', text: 'Communication needs of disabled or sensory-impaired patients are met', regulation: null },
      { key: 'RESPONSIVE-4', text: 'Patients are supported through referral, transfer and discharge', regulation: 9 },
      { key: 'RESPONSIVE-5', text: 'Reasonable adjustments give disabled patients equal access', regulation: 5 },
      { key: 'RESPONSIVE-6', text: 'Different patients’ needs and choices are taken into account', regulation: null },
      { key: 'RESPONSIVE-7', text: 'Patients with the most urgent needs are prioritised', regulation: 4 },
      { key: 'RESPONSIVE-8', text: 'Concerns and complaints are acted on to improve care', regulation: 13 },
      { key: 'RESPONSIVE-9', text: 'Patients know how to make a complaint', regulation: null },
      { key: 'RESPONSIVE-10', text: 'The complaints process is easy to use', regulation: null },
      { key: 'RESPONSIVE-11', text: 'Complaints are handled openly, promptly, confidentially and recorded', regulation: 13 },
      { key: 'RESPONSIVE-12', text: 'People who complain are protected from disadvantage', regulation: null },
    ],
  },
];
export const SelfAuditAnswer = z.enum(['PASS', 'PARTIAL', 'FAIL', 'NA']);
export const SelfAuditAnswerSet = z.strictObject({
  answer: SelfAuditAnswer,
  note: z.string().trim().min(1).max(1000).optional(),
});
export const SelfAuditReview = z.strictObject({ note: z.string().trim().min(3).max(2000) });
export const SelfAuditDto = z.object({
  id: z.string().uuid(),
  code: z.string(),
  status: z.enum(['OPEN', 'SUBMITTED', 'REVIEWED']),
  startedAt: z.string(),
  startedByName: z.string().nullable(),
  submittedAt: z.string().nullable(),
  submittedBy: z.string().uuid().nullable(),
  submittedByName: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedByName: z.string().nullable(),
  reviewNote: z.string().nullable(),
  answers: z.array(
    z.object({
      questionKey: z.string(),
      answer: SelfAuditAnswer,
      note: z.string().nullable(),
      answeredByName: z.string().nullable(),
      answeredAt: z.string(),
    }),
  ),
  version: z.number().int(),
});
export type SelfAuditDto = z.infer<typeof SelfAuditDto>;
export const SelfAuditCurrentDto = z.object({ audit: SelfAuditDto.nullable() });

// ---- workforce checks (Staff › Training › Workforce checks) ---------------------------------
export const AgencyWorkerCreate = z.strictObject({
  name: text(2, 120),
  agency: text(2, 160),
  role: StaffRole,
  confirmationItems: text(3, 1000),
  confirmationReceivedOn: isoDate,
  confirmationExpiresOn: isoDate,
  localInductionDone: z.boolean().optional(),
  idCheckedOnArrival: z.boolean().optional(),
});
export const AgencyWorkerArrival = z.strictObject({
  localInductionDone: z.boolean(),
  idCheckedOnArrival: z.boolean(),
});
export const AgencyWorkerDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  agency: z.string(),
  role: StaffRole,
  roleLabel: z.string(),
  confirmationItems: z.string(),
  confirmationReceivedOn: isoDate,
  confirmationRecordedBy: uuid,
  confirmationRecordedByName: z.string().nullable(),
  confirmationVerifiedBy: uuid.nullable(),
  confirmationVerifiedByName: z.string().nullable(),
  confirmationVerifiedAt: z.string().nullable(),
  confirmationExpiresOn: isoDate,
  localInductionDone: z.boolean(),
  idCheckedOnArrival: z.boolean(),
  /** Verified, not expired, induction done and ID checked on arrival. */
  canWork: z.boolean(),
  version: z.number().int(),
});
export type AgencyWorkerDto = z.infer<typeof AgencyWorkerDto>;

export const DvlaCheckCreate = z.strictObject({
  staffId: uuid,
  checkCode: text(4, 40),
  categories: text(1, 80),
  points: z.number().int().min(0).max(99),
  checkedOn: isoDate,
  nextCheckOn: isoDate,
});
export const DvlaCheckDto = z.object({
  id: uuid,
  staffId: uuid,
  staffName: z.string(),
  staffNo: z.string(),
  checkCode: z.string(),
  categories: z.string(),
  points: z.number().int(),
  checkedOn: isoDate,
  nextCheckOn: isoDate,
  /** Days until next check (negative = overdue). */
  overdueDays: z.number().int(),
  recordedBy: uuid,
  recordedByName: z.string().nullable(),
  escalation: EscalationDto,
});
export type DvlaCheckDto = z.infer<typeof DvlaCheckDto>;

export const HcpcRegistrationCreate = z.strictObject({
  staffId: uuid,
  registrationNo: text(4, 40),
  checkedOn: isoDate,
  expiresOn: isoDate,
});
export const HcpcRegistrationDto = z.object({
  id: uuid,
  staffId: uuid,
  staffName: z.string(),
  staffNo: z.string(),
  registrationNo: z.string(),
  checkedOn: isoDate,
  expiresOn: isoDate,
  recordedByName: z.string().nullable(),
  version: z.number().int(),
});
export type HcpcRegistrationDto = z.infer<typeof HcpcRegistrationDto>;

// ---- planned training sessions (Staff › Training › Planned sessions) ---------------------------
export const TrainingPlanCreate = z.strictObject({
  courseCode: text(2, 40),
  plannedOn: isoDate,
  places: z.number().int().min(1).max(200),
  /** When true, invite staff who are due/overdue/missing for the course (up to places). */
  inviteDue: z.boolean().optional(),
});
export const TrainingPlanDto = z.object({
  id: uuid,
  code: z.string(),
  courseCode: z.string(),
  courseTitle: z.string(),
  plannedOn: isoDate,
  places: z.number().int(),
  invitedStaffIds: z.array(uuid),
  invitedNames: z.array(z.string()),
  status: z.enum(['PLANNED', 'HELD', 'CANCELLED']),
  /** Whole days until the session (negative = past). */
  daysUntil: z.number().int(),
  createdByName: z.string().nullable(),
  version: z.number().int(),
});
export type TrainingPlanDto = z.infer<typeof TrainingPlanDto>;

// ---- deep clean status (Vehicles › Fleet care › Deep cleans) ------------------------------------
/** One row per vehicle: the last deep clean and when the next is due (every 28 days). */
export const DeepCleanStatusDto = z.object({
  vehicleId: uuid,
  callsign: z.string(),
  lastId: uuid.nullable(),
  lastOn: isoDate.nullable(),
  cleanedByName: z.string().nullable(),
  checkedByName: z.string().nullable(),
  note: z.string().nullable(),
  nextDueOn: isoDate.nullable(),
  /** Whole London days until the next deep clean (negative = overdue); null when none recorded. */
  daysUntil: z.number().int().nullable(),
  escalation: EscalationDto,
});
export type DeepCleanStatusDto = z.infer<typeof DeepCleanStatusDto>;

// ---- supervision next due (Staff › Training › Supervision › Next due) ---------------------------
/** Everyone working: last supervision held, next due (56 days on) and any upcoming booking. */
export const SupervisionNextDueDto = z.object({
  staffId: uuid,
  staffName: z.string(),
  jobTitle: z.string().nullable(),
  lastHeldOn: isoDate.nullable(),
  nextDueOn: isoDate.nullable(),
  bookedAt: isoDateTime.nullable(),
  /** Whole London days overdue (negative = days left); null when there is no start date. */
  overdueDays: z.number().int().nullable(),
  escalation: EscalationDto,
});
export type SupervisionNextDueDto = z.infer<typeof SupervisionNextDueDto>;
