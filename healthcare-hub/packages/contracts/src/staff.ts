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
]);
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
    /** Required when an approved alternative replaces one of the two default references. */
    alternativeRationale: z.string().trim().max(500).optional(),
  }),
  DBS: z.strictObject({
    eligibility: z.enum(['BASIC', 'STANDARD', 'ENHANCED', 'ENHANCED_BARRED']),
    barredListChecked: z.boolean(),
    certificateNumber: z.string().regex(/^\d{12}$/, 'A DBS certificate number has 12 digits'),
    issueDate: isoDate,
    updateServiceConsent: z.boolean(),
    riskDecision: z.enum(['CLEAR', 'ACCEPTED_WITH_RISK_ASSESSMENT', 'NOT_ACCEPTED', 'PENDING']),
    /** Local policy review date. A DBS certificate has no expiry (HR-02). */
    policyReviewDate: isoDate,
  }),
  RIGHT_TO_WORK: z.strictObject({
    method: z.enum(['MANUAL_DOCUMENT', 'IDVT', 'HOME_OFFICE_SHARE_CODE']),
    checkedOn: isoDate,
    checkerUserId: uuid,
    restrictions: z.string().trim().max(300).optional(),
    /** Time-limited permission: the follow-up check date. */
    followUpOn: isoDate.optional(),
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
  }),
  REGISTRATION: z.strictObject({
    body: z.enum(['HCPC', 'NMC', 'GMC', 'GDC', 'OTHER']),
    number: text(30),
    expiresOn: isoDate.optional(),
    indemnityConfirmed: z.boolean().default(false),
  }),
  TRAINING: z.strictObject({
    courseCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
    title: text(200),
    completedOn: isoDate,
    expiresOn: isoDate.optional(),
    provider: z.string().trim().max(120).optional(),
  }),
  COMPETENCY: z.strictObject({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
    assessedOn: isoDate,
    assessorUserId: uuid.optional(),
    outcome: z.enum(['COMPETENT', 'NOT_YET_COMPETENT']),
    expiresOn: isoDate.optional(),
  }),
  SUPERVISION: z.strictObject({
    heldOn: isoDate,
    supervisorUserId: uuid.optional(),
    nextDueOn: isoDate.optional(),
    summary: z.string().trim().max(2000).optional(),
  }),
  APPRAISAL: z.strictObject({
    heldOn: isoDate,
    appraiserUserId: uuid.optional(),
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
export type RecordKind = keyof typeof RecordPayloads;
export const RecordKind = z.enum(Object.keys(RecordPayloads) as [RecordKind, ...RecordKind[]]);
export const SENSITIVE_RECORD_KINDS: readonly RecordKind[] = ['DBS', 'OH_DETAIL', 'PERSONAL'];

/** URL slugs used by `GET/POST /staff/:id/{slug}` (API_SPEC). */
export const RECORD_SLUGS: Record<string, RecordKind> = {
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
  /** Display names of the colleagues the record mentions (checker, assessor, ...), by user id. */
  people: z.record(z.string(), z.string()),
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
  roles: z.array(StaffRole),
  activeRestrictions: z.array(RestrictionType),
  /** Worst status across the person's required items (text + colour shown together in the UI). */
  overallStatus: RagStatus,
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
});
export const StaffPatch = z
  .strictObject({
    displayName: text(120),
    primaryLocationId: uuid,
    userId: uuid.nullable(),
    managerStaffId: uuid.nullable(),
    jobTitle: z.string().trim().max(120).nullable(),
    workingPattern: z.string().trim().max(120).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');

export const TransitionInput = z.strictObject({ to: StaffLifecycle, reason });
/** B1: start checks for a role before it is approved. */
export const RoleCheckInput = z.strictObject({ role: StaffRole });
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

export const MatrixDto = z.object({
  columns: z.array(z.object({ templateId: uuid, code: z.string(), title: z.string() })),
  rows: z.array(
    z.object({
      staffId: uuid,
      staffNo: StaffNo,
      displayName: z.string(),
      roles: z.array(StaffRole),
      cells: z.array(
        z.object({
          templateId: uuid,
          required: z.boolean(),
          instanceId: uuid.nullable(),
          status: RagStatus.nullable(),
          reasonText: z.string().nullable(),
          nextDate: isoDate.nullable(),
        }),
      ),
    }),
  ),
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
