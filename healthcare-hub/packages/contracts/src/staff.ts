import { z } from 'zod';
import { RagStatus, isoDate, isoDateTime, page, uuid } from './common.js';
import { InstanceDto } from './requirements.js';

const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(500);
const text = (max: number) => z.string().trim().min(1).max(max);

export const StaffLifecycle = z.enum([
  'CANDIDATE',
  'CHECKS_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'APPROVED_FOR_ROLE',
  'ACTIVE',
  'SUSPENDED',
  'LEAVER',
]);
export const StaffRole = z.enum([
  'DRIVER',
  'CARE_ASSISTANT',
  'EMERGENCY_CARE_ASSISTANT',
  'TECHNICIAN',
  'PARAMEDIC',
  'NURSE',
  'CONTROL_ROOM',
  'MANAGER',
  'OTHER',
  // Dental and care-home packs (task 18, finding 96).
  'DENTIST',
  'DENTAL_NURSE',
  'RECEPTIONIST',
  'SENIOR_CARER',
  'ACTIVITIES_COORDINATOR',
]);
export const ContractType = z.enum(['PERMANENT', 'FIXED_TERM', 'BANK', 'AGENCY', 'VOLUNTEER']);
export type ContractType = z.infer<typeof ContractType>;
export const RestrictionType = z.enum([
  'NO_DRIVING',
  'NO_BLUE_LIGHT',
  'NO_LONE_WORKING',
  'NO_PATIENT_CONTACT',
  'NO_CHILDREN',
  'NO_NIGHT_SHIFTS',
  'OTHER',
]);
export const StaffNo = z.string().regex(/^ST-\d{4,6}$/, 'Expected ST- followed by 4-6 digits');

// ---------------------------------------------------------------------------
// Typed record payloads (one immutable table; each kind validated here).
// ---------------------------------------------------------------------------
const licenceCategory = z.string().regex(/^(AM|A1|A2|A|B1|B|BE|C1|C1E|C|CE|D1|D1E|D|DE)$/);
export const RecordPayloads = {
  REFERENCE: z.strictObject({
    refereeName: text(120),
    refereeOrganisation: text(120),
    relationship: text(120),
    requestedOn: isoDate,
    receivedOn: isoDate.optional(),
    outcome: z.enum(['PENDING', 'SATISFACTORY', 'UNSATISFACTORY']),
    coversFrom: isoDate.optional(),
    coversTo: isoDate.optional(),
    /** Who confirmed the reference by phone, and when. */
    phoneVerifiedByUserId: uuid.optional(),
    phoneVerifiedOn: isoDate.optional(),
    /** Required when an approved alternative replaces one of the two default references. */
    alternativeRationale: z.string().trim().max(500).optional(),
    /** The manager who approved the alternative; needs the rationale. */
    alternativeApprovedByUserId: uuid.optional(),
  }),
  DBS: z.strictObject({
    eligibility: z.enum(['BASIC', 'STANDARD', 'ENHANCED', 'ENHANCED_BARRED']),
    barredListChecked: z.boolean(),
    /** Which barred lists were checked. */
    barredLists: z
      .array(z.enum(['ADULTS', 'CHILDREN']))
      .max(2)
      .optional(),
    certificateNumber: z.string().regex(/^\d{12}$/, 'A DBS certificate number has 12 digits'),
    issueDate: isoDate,
    updateServiceConsent: z.boolean(),
    updateServiceSubscribed: z.boolean().optional(),
    updateServiceLastCheckedOn: isoDate.optional(),
    /** What the certificate shows. Information disclosed needs a named manager's risk decision. */
    disclosure: z.enum(['CLEAR', 'INFORMATION_DISCLOSED']).optional(),
    riskDecision: z.enum(['CLEAR', 'ACCEPTED_WITH_RISK_ASSESSMENT', 'NOT_ACCEPTED', 'PENDING']),
    riskAssessmentSummary: z.string().trim().max(2000).optional(),
    riskDecisionByUserId: uuid.optional(),
    /** Local policy review date. A DBS certificate has no expiry (HR-02). */
    policyReviewDate: isoDate,
  }),
  RIGHT_TO_WORK: z.strictObject({
    method: z.enum(['MANUAL_DOCUMENT', 'IDVT', 'HOME_OFFICE_SHARE_CODE']),
    checkedOn: isoDate,
    checkerUserId: uuid,
    outcome: z.enum(['UNLIMITED', 'TIME_LIMITED']).optional(),
    restrictions: z.string().trim().max(300).optional(),
    /** Time-limited permission: the last day they may work. Blocks from the day after. */
    permissionEndsOn: isoDate.optional(),
    /** Time-limited permission: the follow-up check date (set from the end date when blank). */
    followUpOn: isoDate.optional(),
  }),
  /** B1: identity. Only the last four characters of the document number are kept. */
  IDENTITY: z.strictObject({
    documentType: z.enum([
      'PASSPORT',
      'DRIVING_LICENCE',
      'BIOMETRIC_RESIDENCE_PERMIT',
      'NATIONAL_ID_CARD',
      'OTHER',
    ]),
    numberLast4: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{4}$/, 'Enter the last 4 characters only'),
    documentExpiry: isoDate.optional(),
    photoMatches: z.boolean(),
    confirmedByUserId: uuid,
    checkedOn: isoDate,
  }),
  LICENCE: z.strictObject({
    categories: z.array(licenceCategory).min(1).max(15),
    restrictionCodes: z
      .array(z.string().regex(/^\d{2,3}(\.\d{1,2})?$/))
      .max(20)
      .default([]),
    photocardExpiry: isoDate,
    lastCheckedOn: isoDate,
    checkMethod: z.enum(['DVLA_SHARE_CODE', 'DVLA_API', 'MANUAL']),
    penaltyPoints: z.number().int().min(0).max(24).default(0),
    /** DVLA driver number (16 characters). Stored encrypted; others see only the last 4. */
    licenceNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z9]{5}\d{6}[A-Z9]{2}\d[A-Z]{2}$/, 'Expected a 16-character DVLA driver number')
      .optional(),
    /** Emergency response (blue light) driver qualification. */
    emergencyDriverQualified: z.boolean().optional(),
    emergencyDriverExpiresOn: isoDate.optional(),
  }),
  REGISTRATION: z.strictObject({
    body: z.enum(['HCPC', 'NMC', 'GMC', 'GDC', 'OTHER']),
    number: text(30),
    expiresOn: isoDate.optional(),
    checkedOn: isoDate.optional(),
    nextCheckOn: isoDate.optional(),
    indemnityConfirmed: z.boolean().default(false),
  }),
  TRAINING: z.strictObject({
    courseCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
    title: text(200),
    completedOn: isoDate,
    /** Calculated from the course interval when left blank. */
    expiresOn: isoDate.optional(),
    provider: z.string().trim().max(120).optional(),
    /** Group session register reference (bulk record). */
    sessionRef: z.string().trim().max(60).optional(),
  }),
  COMPETENCY: z.strictObject({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
    assessedOn: isoDate,
    assessorUserId: uuid.optional(),
    method: z.enum(['OBSERVATION', 'SIMULATION', 'QUESTIONING', 'CERTIFICATE']).optional(),
    outcome: z.enum(['COMPETENT', 'NOT_YET_COMPETENT']),
    expiresOn: isoDate.optional(),
    evidenceNote: z.string().trim().max(500).optional(),
  }),
  SUPERVISION: z.strictObject({
    heldOn: isoDate,
    supervisorUserId: uuid.optional(),
    bookingId: uuid.optional(),
    type: z.enum(['ONE_TO_ONE', 'CLINICAL', 'RETURN_TO_WORK', 'PROBATION_REVIEW']).optional(),
    attended: z.boolean().optional(),
    wellbeingChecked: z.boolean().optional(),
    competenceConcerns: z.string().trim().max(1000).optional(),
    agreedActions: z.string().trim().max(2000).optional(),
    nextDueOn: isoDate.optional(),
    summary: z.string().trim().max(2000).optional(),
  }),
  APPRAISAL: z.strictObject({
    heldOn: isoDate,
    appraiserUserId: uuid.optional(),
    selfAssessment: z.string().trim().max(4000).optional(),
    performance: z.string().trim().max(4000).optional(),
    objectives: z.string().trim().max(2000).optional(),
    developmentNeeds: z.string().trim().max(2000).optional(),
    trainingToBook: z.string().trim().max(1000).optional(),
    nextDueOn: isoDate.optional(),
  }),
  OBJECTIVE: z.strictObject({
    title: text(200),
    dueOn: isoDate.optional(),
    status: z.enum(['OPEN', 'MET', 'NOT_MET']),
  }),
  EMPLOYMENT_HISTORY: z.strictObject({
    employer: text(120),
    role: text(120),
    from: isoDate,
    to: isoDate.optional(),
    /** Explanation recorded for any gap before this entry. */
    gapExplanation: z.string().trim().max(500).optional(),
    /** Work with children or vulnerable adults: Schedule 3 needs the reason it ended. */
    careRole: z.boolean().optional(),
    reasonForLeaving: z.string().trim().max(300).optional(),
  }),
  INDUCTION: z.strictObject({ completedOn: isoDate, signedOffByUserId: uuid.optional() }),
  PROBATION: z.strictObject({
    startOn: isoDate,
    endOn: isoDate,
    outcome: z.enum(['IN_PROGRESS', 'PASSED', 'EXTENDED', 'FAILED']),
  }),
  /** Fit-for-duty status only; clinical detail lives in OH_DETAIL (restricted). */
  OH_CLEARANCE: z.strictObject({
    fitStatus: z.enum(['FIT', 'FIT_WITH_ADJUSTMENTS', 'UNFIT', 'PENDING']),
    assessedOn: isoDate,
    reviewOn: isoDate.optional(),
  }),
  OH_DETAIL: z.strictObject({
    notes: text(4000),
    adjustments: z.string().trim().max(1000).optional(),
  }),
  PERSONAL: z.strictObject({
    dateOfBirth: isoDate.optional(),
    address: z.string().trim().max(300).optional(),
    phone: z.string().trim().max(30).optional(),
    nextOfKin: z
      .strictObject({ name: text(120), relationship: text(60), phone: text(30) })
      .optional(),
  }),
} as const;
/** Skills a competency sign-off can record (C4); the planner checks bookings against these codes. */
export const COMPETENCY_SKILLS: Record<string, string> = {
  CARRY_CHAIR: 'Carry chair and stair chair',
  STRETCHER: 'Stretcher and trolley handling',
  BARIATRIC: 'Bariatric moving and handling',
  WHEELCHAIR_RESTRAINT: 'Wheelchair securing and restraint',
  OXYGEN: 'Oxygen administration',
  DEFIBRILLATOR: 'Defibrillator (AED) use',
  SUCTION: 'Suction',
  MENTAL_HEALTH_TRANSFER: 'Mental health transfers',
  PAEDIATRIC: 'Paediatric transfers',
  BLUE_LIGHT: 'Emergency response (blue light) driving',
  MEDICINES: 'Medicines administration',
  INFECTION_CONTROL: 'Infection prevention and control practice',
};
export type RecordKind = keyof typeof RecordPayloads;
export const RecordKind = z.enum(Object.keys(RecordPayloads) as [RecordKind, ...RecordKind[]]);
export const SENSITIVE_RECORD_KINDS: readonly RecordKind[] = ['DBS', 'OH_DETAIL', 'PERSONAL'];

/** URL slugs used by `GET/POST /staff/:id/{slug}` (API_SPEC). */
export const RECORD_SLUGS: Record<string, RecordKind> = {
  identity: 'IDENTITY',
  references: 'REFERENCE',
  dbs: 'DBS',
  'right-to-work': 'RIGHT_TO_WORK',
  licences: 'LICENCE',
  registrations: 'REGISTRATION',
  training: 'TRAINING',
  competencies: 'COMPETENCY',
  supervisions: 'SUPERVISION',
  appraisals: 'APPRAISAL',
  objectives: 'OBJECTIVE',
  'employment-history': 'EMPLOYMENT_HISTORY',
  induction: 'INDUCTION',
  probation: 'PROBATION',
  'oh-clearance': 'OH_CLEARANCE',
  'oh-detail': 'OH_DETAIL',
  personal: 'PERSONAL',
};

export const RecordCreate = z.strictObject({
  data: z.record(z.string(), z.unknown()),
  /** Correct an earlier record: the old one stays in history and is marked superseded. */
  supersedesId: uuid.optional(),
  requirementInstanceId: uuid.optional(),
});

export const StaffRecordDto = z.object({
  id: uuid,
  staffId: uuid,
  kind: RecordKind,
  data: z.record(z.string(), z.unknown()),
  validFrom: isoDate.nullable(),
  validTo: isoDate.nullable(),
  requirementInstanceId: uuid.nullable(),
  supersedesId: uuid.nullable(),
  supersededById: uuid.nullable(),
  current: z.boolean(),
  createdAt: isoDateTime,
  createdBy: uuid,
});
export type StaffRecordDto = z.infer<typeof StaffRecordDto>;

// ---------------------------------------------------------------------------
export const RoleApprovalDto = z.object({
  id: uuid,
  role: StaffRole,
  reason: z.string(),
  approvedBy: uuid,
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
  revokeReason: z.string().nullable(),
  active: z.boolean(),
});
export const RestrictionDto = z.object({
  id: uuid,
  type: RestrictionType,
  detail: z.string().nullable(),
  reason: z.string(),
  appliedBy: uuid,
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
  liftedAt: isoDateTime.nullable(),
  liftReason: z.string().nullable(),
  active: z.boolean(),
});
export const LifecycleEventDto = z.object({
  id: uuid,
  fromState: StaffLifecycle.nullable(),
  toState: StaffLifecycle,
  reason: z.string(),
  actorUserId: uuid,
  at: isoDateTime,
});

/** Basic profile (staff.profile.view_basic). Never contains DBS/OH/personal data. */
export const StaffDto = z.object({
  id: uuid,
  staffNo: StaffNo,
  displayName: z.string(),
  userId: uuid.nullable(),
  lifecycleState: StaffLifecycle,
  primaryLocationId: uuid,
  managerStaffId: uuid.nullable(),
  jobTitle: z.string().nullable(),
  workingPattern: z.string().nullable(),
  /** Employment details (finding 53). Optional so older clients and fixtures still parse. */
  workEmail: z.string().nullable().optional(),
  startDate: isoDate.nullable().optional(),
  contractType: ContractType.nullable().optional(),
  /** Names for the profile header (finding 51); null when not set or not a current record. */
  locationName: z.string().nullable().optional(),
  managerName: z.string().nullable().optional(),
  roles: z.array(StaffRole),
  activeRestrictions: z.array(RestrictionType),
  /** Worst status across the person's required items (text + colour shown together in the UI). */
  overallStatus: RagStatus,
  /** False when no requirement applies yet: shown as "not set up", never compliant or N/A. */
  checksSetUp: z.boolean(),
  counts: z.object({ red: z.number(), amber: z.number(), grey: z.number(), green: z.number() }),
  version,
});
export type StaffDto = z.infer<typeof StaffDto>;
export const StaffPage = page(StaffDto);

/** Dispatcher view (staff.profile.view_clearance): approved roles and restrictions only. */
export const StaffClearanceDto = z.object({
  id: uuid,
  staffNo: StaffNo,
  displayName: z.string(),
  lifecycleState: StaffLifecycle,
  roles: z.array(StaffRole),
  activeRestrictions: z.array(RestrictionType),
});
export type StaffClearanceDto = z.infer<typeof StaffClearanceDto>;

export const StaffDetailDto = StaffDto.extend({
  roleApprovals: z.array(RoleApprovalDto),
  restrictions: z.array(RestrictionDto),
  events: z.array(LifecycleEventDto),
  requirements: z.array(InstanceDto.extend({ required: z.boolean() })),
  allowedTransitions: z.array(StaffLifecycle),
});
export type StaffDetailDto = z.infer<typeof StaffDetailDto>;

export const StaffListQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  lifecycle: StaffLifecycle.optional(),
  locationId: uuid.optional(),
  role: StaffRole.optional(),
  q: z.string().trim().max(60).optional(),
});

export const StaffCreate = z.strictObject({
  staffNo: StaffNo,
  displayName: text(120),
  primaryLocationId: uuid,
  userId: uuid.optional(),
  managerStaffId: uuid.optional(),
  jobTitle: z.string().trim().max(120).optional(),
  workingPattern: z.string().trim().max(120).optional(),
  workEmail: z.string().trim().toLowerCase().email().max(200).optional(),
  startDate: isoDate.optional(),
  contractType: ContractType.optional(),
});
export const StaffPatch = z
  .strictObject({
    displayName: text(120),
    primaryLocationId: uuid,
    userId: uuid.nullable(),
    managerStaffId: uuid.nullable(),
    jobTitle: z.string().trim().max(120).nullable(),
    workingPattern: z.string().trim().max(120).nullable(),
    workEmail: z.string().trim().toLowerCase().email().max(200).nullable(),
    startDate: isoDate.nullable(),
    contractType: ContractType.nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');

export const TransitionInput = z.strictObject({
  to: StaffLifecycle,
  reason,
  /** B6: the leaver's last working day; access ends at the end of that day (UK time). */
  lastWorkingDay: isoDate.optional(),
});
export const StartRoleChecksInput = z.strictObject({ role: StaffRole });
const RoleCheckItem = z.object({
  instanceId: z.string(),
  code: z.string(),
  title: z.string(),
  status: z.string(),
  reasonText: z.string(),
  verified: z.boolean(),
});
/** B1: what a role needs from one person and what still blocks approval (Reg 19, Schedule 3). */
export const RoleCheckResultDto = z.object({
  role: z.string(),
  setUp: z.boolean(),
  items: z.array(RoleCheckItem),
  blockers: z.array(RoleCheckItem),
});
export type RoleCheckResultDto = z.infer<typeof RoleCheckResultDto>;
export const RoleApprovalInput = z.strictObject({
  role: StaffRole,
  reason,
  validTo: isoDateTime.optional(),
});
export const RestrictionInput = z.strictObject({
  type: RestrictionType,
  detail: z.string().trim().max(200).optional(),
  reason,
  validFrom: isoDateTime.optional(),
  validTo: isoDateTime.optional(),
});
export const CloseInput = z.strictObject({ reason });

// Training catalogue, bulk records, supervision bookings, acknowledgements (C1-C3) ---------
const courseCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);
export const TrainingCourseDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  intervalMonths: z.number().int().nullable(),
  basis: z.enum(['STATUTORY', 'REGULATORY_GUIDANCE', 'ORG_POLICY', 'GOOD_PRACTICE']),
  basisNote: z.string().nullable(),
  deploymentCritical: z.boolean(),
  retired: z.boolean(),
  retireReason: z.string().nullable(),
  version,
});
export type TrainingCourseDto = z.infer<typeof TrainingCourseDto>;
export const TrainingCourseCreate = z.strictObject({
  code: courseCode,
  title: text(200),
  intervalMonths: z.number().int().min(1).max(120).nullable(),
  basis: z.enum(['STATUTORY', 'REGULATORY_GUIDANCE', 'ORG_POLICY', 'GOOD_PRACTICE']),
  basisNote: z.string().trim().max(300).optional(),
  deploymentCritical: z.boolean().default(false),
});
export const TrainingCourseRetire = z.strictObject({ reason });
export const BulkTrainingInput = z.strictObject({
  courseId: uuid,
  completedOn: isoDate,
  provider: z.string().trim().max(120).optional(),
  /** Blank: calculated from the course interval. */
  expiresOn: isoDate.optional(),
  /** Register reference for the group session. */
  sessionRef: z.string().trim().min(1).max(60),
  staffIds: z.array(uuid).min(1).max(100),
});
export const SUPERVISION_TYPES = ['ONE_TO_ONE', 'CLINICAL', 'RETURN_TO_WORK', 'PROBATION_REVIEW'];
export const SupervisionBookingInput = z.strictObject({
  supervisorUserId: uuid,
  scheduledAt: isoDateTime,
  kind: z.enum(['ONE_TO_ONE', 'CLINICAL', 'RETURN_TO_WORK', 'PROBATION_REVIEW']),
  topics: z.string().trim().max(1000).optional(),
});
export const SupervisionCloseInput = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('HELD'),
    attended: z.boolean(),
    summary: z.string().trim().max(2000).optional(),
    wellbeingChecked: z.boolean(),
    competenceConcerns: z.string().trim().max(1000).optional(),
    agreedActions: z.string().trim().max(2000).optional(),
    nextDueOn: isoDate.optional(),
  }),
  z.strictObject({
    status: z.enum(['CANCELLED', 'MISSED']),
    reason,
    /** Rebook straight away. */
    rebookAt: isoDateTime.optional(),
  }),
]);
export const SupervisionBookingDto = z.object({
  id: uuid,
  staffId: uuid,
  staffName: z.string(),
  supervisorUserId: uuid,
  supervisorName: z.string(),
  scheduledAt: isoDateTime,
  kind: z.string(),
  topics: z.string().nullable(),
  status: z.enum(['BOOKED', 'HELD', 'CANCELLED', 'MISSED']),
  statusReason: z.string().nullable(),
  recordId: uuid.nullable(),
  rebookedAs: uuid.nullable(),
  version,
});
export type SupervisionBookingDto = z.infer<typeof SupervisionBookingDto>;
export const RecordAckInput = z
  .strictObject({ agreed: z.boolean(), comment: z.string().trim().min(3).max(2000).optional() })
  .refine((a) => a.agreed || a.comment !== undefined, {
    message: 'Say what you disagree with',
    path: ['comment'],
  });
export const RecordAckDto = z.object({
  id: uuid,
  recordId: uuid,
  agreed: z.boolean(),
  comment: z.string().nullable(),
  userName: z.string(),
  createdAt: isoDateTime,
});
export type RecordAckDto = z.infer<typeof RecordAckDto>;

// Readiness ---------------------------------------------------------------
export const ReadinessQuery = z
  .object({
    from: isoDateTime,
    to: isoDateTime,
    role: StaffRole,
    licenceCategory: licenceCategory.optional(),
    competencies: z
      .string()
      .max(400)
      .optional()
      .transform((s) => (s ? s.split(',').filter(Boolean) : [])),
  })
  .refine((q) => new Date(q.to) > new Date(q.from), 'to must be after from');
export const CheckDto = z.object({
  code: z.string(),
  group: z.string(),
  result: z.enum(['PASS', 'FAIL', 'PENDING']),
  reasonText: z.string(),
  overridable: z.boolean(),
  requirementInstanceId: uuid.optional(),
});
export const ReadinessDto = z.object({
  staffId: uuid,
  role: StaffRole,
  state: z.enum(['READY', 'BLOCKED', 'RESTRICTED']),
  checks: z.array(CheckDto),
  restrictions: z.array(RestrictionType),
});
export type ReadinessDto = z.infer<typeof ReadinessDto>;

/** B9: readiness over a date range for every role the person holds. */
export const ReadinessWindowQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.to >= q.from, 'The end date must be on or after the start date')
  .refine(
    (q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= 92 * 86_400_000,
    'The period can be at most three months',
  );
export const ReadinessWindowDto = z.object({
  staffId: uuid,
  from: isoDate,
  to: isoDate,
  /** False when the person holds no approved role: shown as "No role approved", never ready. */
  hasRoles: z.boolean(),
  roles: z.array(
    z.object({
      role: StaffRole,
      state: z.enum(['READY', 'BLOCKED', 'RESTRICTED']),
      checks: z.array(CheckDto),
    }),
  ),
});
export type ReadinessWindowDto = z.infer<typeof ReadinessWindowDto>;

// Role → required templates (HR-03) ----------------------------------------
export const RoleRequirementInput = z.strictObject({ role: StaffRole, templateId: uuid });
export const RoleRequirementDto = z.object({
  id: uuid,
  role: StaffRole,
  templateId: uuid,
  templateCode: z.string(),
  templateTitle: z.string(),
});
export type RoleRequirementDto = z.infer<typeof RoleRequirementDto>;

export const MatrixQuery = z.object({
  locationId: uuid.optional(),
  role: StaffRole.optional(),
  templateId: uuid.optional(),
  /** Only people with a required item overdue or missing. */
  gapsOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export const MatrixCellState = z.enum([
  'MET',
  'DUE_SOON',
  'OVERDUE',
  'AWAITING',
  'MISSING',
  'NOT_REQUIRED',
]);
export const MatrixDto = z.object({
  columns: z.array(
    z.object({
      templateId: uuid,
      code: z.string(),
      title: z.string(),
      roles: z.array(StaffRole).optional(),
      summary: z
        .object({
          required: z.number().int(),
          met: z.number().int(),
          dueSoon: z.number().int(),
          overdue: z.number().int(),
          awaiting: z.number().int().optional(),
          missing: z.number().int(),
          percentMet: z.number().int().nullable(),
        })
        .optional(),
    }),
  ),
  rows: z.array(
    z.object({
      staffId: uuid,
      staffNo: StaffNo,
      displayName: z.string(),
      roles: z.array(StaffRole),
      hasGap: z.boolean().optional(),
      cells: z.array(
        z.object({
          templateId: uuid,
          required: z.boolean(),
          instanceId: uuid.nullable(),
          status: RagStatus.nullable(),
          state: MatrixCellState.optional(),
          /** The cell's words, e.g. "Verified, valid until 12 Mar 2027". */
          text: z.string().optional(),
          reasonText: z.string().nullable(),
          nextDate: isoDate.nullable(),
        }),
      ),
    }),
  ),
  /** The matrix shows at most 500 people; true when more matched. */
  truncated: z.boolean().optional(),
});
export type MatrixDto = z.infer<typeof MatrixDto>;

// Self-service ------------------------------------------------------------
export const CorrectionInput = z.strictObject({
  field: z.enum(['displayName', 'phone', 'address', 'nextOfKin', 'workingPattern', 'other']),
  proposedValue: text(500),
  reason,
});
export const CorrectionDecision = z.strictObject({
  decision: z.enum(['APPLIED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
});
export const CorrectionDto = z.object({
  id: uuid,
  staffId: uuid,
  field: z.string(),
  proposedValue: z.string(),
  reason: z.string(),
  status: z.enum(['OPEN', 'APPLIED', 'REJECTED']),
  requestedBy: uuid,
  decidedBy: uuid.nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: isoDateTime,
  version,
});
export type CorrectionDto = z.infer<typeof CorrectionDto>;

export const MyStaffDto = z.object({
  profile: StaffClearanceDto.extend({ jobTitle: z.string().nullable() }),
  requirements: z.array(InstanceDto.extend({ required: z.boolean() })),
  corrections: z.array(CorrectionDto),
});
export type MyStaffDto = z.infer<typeof MyStaffDto>;

// Staff self-service requests (task 25) -----------------------------------------
export const SelfRequestKind = z.enum(['DUE_DATE_CHANGE', 'REVIEW', 'SUPERVISION']);
export type SelfRequestKind = z.infer<typeof SelfRequestKind>;
export const SelfRequestStatus = z.enum(['OPEN', 'ACCEPTED', 'DECLINED', 'WITHDRAWN']);
export type SelfRequestStatus = z.infer<typeof SelfRequestStatus>;

export const SelfRequestInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('DUE_DATE_CHANGE'),
    instanceId: uuid,
    proposedDate: isoDate,
    /** The due-date log needs at least 10 characters. */
    reason: z.string().trim().min(10).max(1000),
  }),
  z.strictObject({
    kind: z.literal('REVIEW'),
    instanceId: uuid,
    reason: z.string().trim().min(3).max(1000),
  }),
  z.strictObject({
    kind: z.literal('SUPERVISION'),
    proposedDate: isoDate,
    supervisorUserId: uuid.optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
]);
export type SelfRequestInput = z.infer<typeof SelfRequestInput>;

/**
 * A manager asking on someone's behalf from their profile (task 25, finding 15): a review of a
 * requirement, or a supervision session. Somebody other than the requester decides it.
 */
export const StaffRequestInput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('REVIEW'),
    instanceId: uuid,
    reason: z.string().trim().min(3).max(1000),
  }),
  z.strictObject({
    kind: z.literal('SUPERVISION'),
    proposedDate: isoDate,
    supervisorUserId: uuid.optional(),
    reason: z.string().trim().min(3).max(1000),
  }),
]);
export type StaffRequestInput = z.infer<typeof StaffRequestInput>;

export const SelfRequestDecision = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('ACCEPTED'),
    note: z.string().trim().max(1000).optional(),
    /** Required when accepting a supervision request: when it will happen. */
    bookedFor: isoDateTime.optional(),
  }),
  z.strictObject({
    decision: z.literal('DECLINED'),
    note: z.string().trim().min(3).max(1000),
  }),
]);
export type SelfRequestDecision = z.infer<typeof SelfRequestDecision>;

export const SelfRequestDto = z.object({
  id: uuid,
  staffId: uuid,
  staffName: z.string(),
  kind: SelfRequestKind,
  instanceId: uuid.nullable(),
  requirementTitle: z.string().nullable(),
  /** The requirement's date at the time of reading (due or review), for comparison. */
  currentDate: isoDate.nullable(),
  proposedDate: isoDate.nullable(),
  supervisorUserId: uuid.nullable(),
  supervisorName: z.string().nullable(),
  reason: z.string(),
  status: SelfRequestStatus,
  requestedBy: uuid,
  decidedBy: uuid.nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  bookedFor: isoDateTime.nullable(),
  createdAt: isoDateTime,
  version,
});
export type SelfRequestDto = z.infer<typeof SelfRequestDto>;

/** My readiness for a role over a window (a shift or a week). */
export const MyReadinessQuery = z
  .strictObject({ from: isoDateTime, to: isoDateTime, role: StaffRole })
  .refine((q) => new Date(q.to) > new Date(q.from), 'to must be after from')
  .refine(
    (q) => new Date(q.to).getTime() - new Date(q.from).getTime() <= 31 * 86_400_000,
    'The window can be at most 31 days',
  );

// Schedule 3 (reg 19) and driver eligibility (task 18) -------------------------
export const Schedule3Dto = z.object({
  staffId: uuid,
  asOf: isoDate,
  /** True only when every item is recorded and its evidence verified by a second person. */
  complete: z.boolean(),
  items: z.array(
    z.object({
      item: z.string(),
      title: z.string(),
      state: z.enum(['COMPLETE', 'RECORDED_UNVERIFIED', 'ATTENTION', 'MISSING']),
      status: z.enum(['GREEN', 'AMBER', 'RED']),
      reasonText: z.string(),
      evidenceTitle: z.string().nullable(),
    }),
  ),
});
export type Schedule3Dto = z.infer<typeof Schedule3Dto>;
export const DriverEligibilityQuery = z.object({ category: licenceCategory.default('B') });
export const DriverEligibilityDto = z.object({
  staffId: uuid,
  category: z.string(),
  asOf: isoDate,
  eligible: z.boolean(),
  checks: z.array(
    z.object({
      code: z.string(),
      result: z.enum(['PASS', 'FAIL', 'WARN']),
      reasonText: z.string(),
    }),
  ),
});
export type DriverEligibilityDto = z.infer<typeof DriverEligibilityDto>;
