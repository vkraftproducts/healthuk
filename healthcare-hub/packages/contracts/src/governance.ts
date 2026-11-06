import { z } from 'zod';
import { RagStatus, isoDate, isoDateTime, uuid } from './common.js';

const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(1000);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/));
const severity = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export const AuditResultEnum = z.enum([
  'COMPLIANT',
  'PARTIAL',
  'NON_COMPLIANT',
  'NOT_ASSESSED',
  'NOT_APPLICABLE',
]);
export const AuditMethodEnum = z.enum(['RECORDS', 'OBSERVATION', 'INTERVIEW']);
export const QualityDomain = z.enum(['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED']);

// ---- Audit templates ----------------------------------------------------------------
export const AuditControl = z.strictObject({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,19}$/),
  question: z.string().trim().min(3).max(500),
  guidance: z.string().trim().max(2000).optional(),
  failureAction: z.string().trim().max(500).optional(),
  critical: z.boolean().default(false),
});
export const AuditVersionInput = z.strictObject({
  controls: z
    .array(AuditControl)
    .min(1)
    .max(200)
    .refine((c) => new Set(c.map((x) => x.code)).size === c.length, 'Control codes must be unique'),
  sampleMethod: z.string().trim().max(300).optional(),
  sampleSize: z.number().int().min(1).max(1000).optional(),
  methods: z.array(AuditMethodEnum).min(1).default(['RECORDS']),
});
export const AuditTemplateCreate = z.strictObject({
  code,
  title: z.string().trim().min(2).max(200),
  domain: QualityDomain,
  sourceRef: z.string().trim().max(300).optional(),
  version: AuditVersionInput,
});
export const AuditTemplateDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  domain: QualityDomain,
  sourceRef: z.string().nullable(),
  active: z.boolean(),
  versions: z.array(
    z.object({
      id: uuid,
      version: z.number(),
      status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']),
      controls: z.array(
        z.object({
          code: z.string(),
          question: z.string(),
          guidance: z.string().optional(),
          failureAction: z.string().optional(),
          critical: z.boolean(),
        }),
      ),
      sampleMethod: z.string().nullable(),
      sampleSize: z.number().nullable(),
      methods: z.array(AuditMethodEnum),
      /** Null for starter content shipped with the library. */
      createdBy: uuid.nullable(),
      createdByName: z.string().nullable(),
      approvedBy: uuid.nullable(),
      approvedByName: z.string().nullable(),
      approvedAt: isoDateTime.nullable(),
      /** Proposed audit frequency in words, e.g. 'Quarterly'; null when not set. */
      frequency: z.string().nullable().optional(),
      specialistName: z.string().nullable().optional(),
      specialistRole: z.string().nullable().optional(),
    }),
  ),
  /** 'dental' or 'care_home' for sector drafts; null for core templates. */
  sectorPack: z.string().nullable().optional(),
  proposedCadence: z.string().nullable().optional(),
  /** Where the template stands overall (WORKFLOWS G1). */
  state: z.enum(['DRAFT', 'PUBLISHED', 'ACTIVE', 'RETIRED']).optional(),
  /** 'Draft content, specialist validation required' for sector drafts not yet validated. */
  validationNote: z.string().nullable().optional(),
  retiredAt: isoDateTime.nullable().optional(),
  retiredReason: z.string().nullable().optional(),
  clonedFrom: uuid.nullable().optional(),
});
export type AuditTemplateDto = z.infer<typeof AuditTemplateDto>;
export const AuditTemplateClone = z.strictObject({
  code,
  title: z.string().trim().min(2).max(200),
});
export const AuditTemplateRetire = z.strictObject({ reason });
/** Dental and care-home templates name the specialist who validated the content. */
export const AuditPublishInput = z
  .strictObject({
    specialistName: z.string().trim().min(2).max(120),
    specialistRole: z.string().trim().min(2).max(120),
  })
  .partial();

// ---- Audit runs -----------------------------------------------------------------------
export const AuditRunCreate = z.strictObject({
  templateVersionId: uuid,
  title: z.string().trim().min(2).max(200),
  locationId: uuid.optional(),
  periodFrom: isoDate.optional(),
  periodTo: isoDate.optional(),
  auditorUserId: uuid,
  ownerUserId: uuid,
  dueDate: isoDate,
  serviceId: uuid.optional(),
  /** Accepts or returns the submitted audit; never the auditor. */
  reviewerUserId: uuid.optional(),
  /** Repeat every N months; the next run is scheduled when this one is accepted. */
  recurrenceMonths: z.number().int().min(1).max(24).optional(),
});
export const AuditReviewInput = z
  .strictObject({
    decision: z.enum(['ACCEPTED', 'RETURNED']),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine(
    (r) => r.decision === 'ACCEPTED' || (r.reason?.length ?? 0) >= 3,
    'Say why the audit is being returned',
  );
export const PickSampleInput = z.strictObject({
  method: z.enum(['RANDOM', 'EVERY_NTH', 'TARGETED']),
  size: z.number().int().min(1).max(500),
  subjectType: z.enum(['STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES', 'SERVICE', 'ORGANISATION']),
  dateFrom: isoDate,
  dateTo: isoDate,
});
export const SampleInput = z.strictObject({
  populationDesc: z.string().trim().min(3).max(500),
  selectionMethod: z.string().trim().min(3).max(300),
  dateFrom: isoDate,
  dateTo: isoDate,
  subjectType: z.enum(['STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES', 'SERVICE', 'ORGANISATION']),
  subjectIds: z.array(uuid).min(1).max(500),
  repeatReason: z.string().trim().max(300).optional(),
});
export const ResponseInput = z.strictObject({
  responses: z
    .array(
      z
        .strictObject({
          controlCode: z.string(),
          subjectId: uuid.optional(),
          result: AuditResultEnum,
          method: AuditMethodEnum,
          note: z.string().trim().max(2000).optional(),
          evidenceItemId: uuid.optional(),
        })
        .refine(
          (r) =>
            !['NOT_APPLICABLE', 'NOT_ASSESSED'].includes(r.result) || (r.note?.length ?? 0) >= 3,
          'Give a reason for N/A or Not assessed',
        ),
    )
    .min(1)
    .max(500),
});
export const FindingDto = z.object({
  id: uuid,
  controlCode: z.string(),
  passCount: z.number(),
  partialCount: z.number(),
  failCount: z.number(),
  naCount: z.number(),
  result: AuditResultEnum,
  severity,
  summary: z.string(),
});
export const ActionSourceType = z.enum([
  'FINDING',
  'EVENT',
  'RISK',
  'CORRESPONDENCE',
  'FEEDBACK',
  'MEETING',
  'PREMISES',
]);
export const ActionDto = z.object({
  id: uuid,
  code: z.string(),
  sourceType: ActionSourceType,
  sourceId: uuid,
  kind: z.enum(['ACTION', 'REAUDIT']),
  title: z.string(),
  severity,
  ownerUserId: uuid,
  /** Filled on lists and detail screens. */
  ownerName: z.string().nullable().optional(),
  deadline: isoDate,
  status: z.enum(['OPEN', 'EVIDENCE_SUBMITTED', 'VERIFIED', 'REJECTED']),
  evidenceItemIds: z.array(uuid),
  verifierUserId: uuid.nullable(),
  verifiedAt: isoDateTime.nullable(),
  reauditRunId: uuid.nullable(),
  /** The audit behind a finding's action. Only on the actions list. */
  auditRunId: uuid.optional(),
  overdue: z.boolean(),
  history: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      note: z.string().nullable(),
      byUserId: uuid,
      byName: z.string().nullable().optional(),
      at: isoDateTime,
    }),
  ),
  version,
});
export type ActionDto = z.infer<typeof ActionDto>;
/** Reassign an open action or move its deadline; the reason goes into its history. */
export const ActionPatch = z
  .strictObject({
    ownerUserId: uuid.optional(),
    deadline: isoDate.optional(),
    reason: z.string().trim().min(3).max(1000),
  })
  .refine((p) => p.ownerUserId || p.deadline, 'Change the owner or the deadline');
export const AuditRunDto = z.object({
  id: uuid,
  code: z.string(),
  templateVersionId: uuid,
  templateCode: z.string(),
  title: z.string(),
  domain: QualityDomain,
  locationId: uuid.nullable(),
  periodFrom: isoDate.nullable(),
  periodTo: isoDate.nullable(),
  auditorUserId: uuid,
  auditorName: z.string().nullable(),
  ownerUserId: uuid,
  ownerName: z.string().nullable(),
  dueDate: isoDate,
  /** Due date passed and not yet submitted (London date). */
  overdue: z.boolean(),
  status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'ACTIONS_OPEN', 'CLOSED']),
  outcome: RagStatus.nullable(),
  outcomeReason: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  reauditOf: uuid.nullable(),
  serviceId: uuid.nullable().optional(),
  reviewerUserId: uuid.nullable().optional(),
  reviewerName: z.string().nullable().optional(),
  recurrenceMonths: z.number().nullable().optional(),
  reviewState: z.enum(['RETURNED', 'ACCEPTED']).nullable().optional(),
  submissionNo: z.number().optional(),
  version,
});
export type AuditRunDto = z.infer<typeof AuditRunDto>;
export const AuditRunDetailDto = AuditRunDto.extend({
  controls: z.array(
    z.object({
      code: z.string(),
      question: z.string(),
      critical: z.boolean(),
      guidance: z.string().optional(),
      failureAction: z.string().optional(),
    }),
  ),
  /** Controls answered for every sampled subject (save as you go). */
  progress: z.object({ answered: z.number(), total: z.number(), percent: z.number() }).optional(),
  overall: z.object({ result: AuditResultEnum.nullable(), text: z.string() }).optional(),
  reviews: z
    .array(
      z.object({
        decision: z.enum(['ACCEPTED', 'RETURNED']),
        reason: z.string().nullable(),
        byName: z.string().nullable(),
        at: isoDateTime,
      }),
    )
    .optional(),
  methods: z.array(AuditMethodEnum),
  samples: z.array(
    z.object({
      id: uuid,
      populationDesc: z.string(),
      selectionMethod: z.string(),
      dateFrom: isoDate,
      dateTo: isoDate,
      subjectType: z.string(),
      subjectIds: z.array(uuid),
      repeatWarning: z.array(uuid),
    }),
  ),
  responses: z.array(
    z.object({
      id: uuid,
      controlCode: z.string(),
      subjectId: uuid.nullable(),
      result: AuditResultEnum,
      method: AuditMethodEnum,
      note: z.string().nullable(),
      recordedBy: uuid,
      recordedByName: z.string().nullable(),
      recordedAt: isoDateTime,
    }),
  ),
  findings: z.array(FindingDto),
  actions: z.array(ActionDto),
});
export type AuditRunDetailDto = z.infer<typeof AuditRunDetailDto>;
export const FindingActionInput = z.strictObject({
  title: z.string().trim().min(3).max(300),
  ownerUserId: uuid,
  deadline: isoDate,
  severity: severity.optional(),
  kind: z.enum(['ACTION', 'REAUDIT']).default('ACTION'),
});
export const ActionEvidenceInput = z.strictObject({
  evidenceItemIds: z.array(uuid).min(1).max(20),
  note: z.string().trim().max(1000).optional(),
});
export const ActionVerifyInput = z.strictObject({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  reason,
});
export const ActionListQuery = z.object({
  status: z
    .enum(['OPEN', 'EVIDENCE_SUBMITTED', 'VERIFIED', 'REJECTED', 'ACTIVE'])
    .default('ACTIVE'),
  ownerUserId: uuid.optional(),
  sourceType: ActionSourceType.optional(),
  overdue: z.enum(['true', 'false']).optional(),
});
/** Raise an action from any source with an owner picked (WORKFLOWS G3). */
export const ActionCreateInput = z.strictObject({
  sourceType: ActionSourceType,
  sourceId: uuid,
  title: z.string().trim().min(3).max(300),
  ownerUserId: uuid,
  deadline: isoDate,
  severity: severity.optional(),
});

// ---- Policies ---------------------------------------------------------------------------
export const PolicyCreate = z.strictObject({
  code,
  title: z.string().trim().min(2).max(200),
  category: z.enum(['POLICY', 'SOP', 'GUIDANCE', 'CRITICAL_INSTRUCTION']).default('POLICY'),
  ownerUserId: uuid,
  readerRoles: z
    .array(z.string().regex(/^[A-Z_]{2,40}$/))
    .max(20)
    .default([]),
  /** Reader groups: roles, locations or everyone (WORKFLOWS G4). */
  readerLocationIds: z.array(uuid).max(50).default([]),
  readerEveryone: z.boolean().default(false),
  summary: z.string().trim().min(3).max(2000),
  evidenceItemId: uuid.optional(),
  reviewDate: isoDate.optional(),
});
export const PolicyReadersInput = z
  .strictObject({
    readerRoles: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20),
    readerLocationIds: z.array(uuid).max(50),
    readerEveryone: z.boolean(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export const PolicyVersionInput = z.strictObject({
  summary: z.string().trim().min(3).max(2000),
  material: z.boolean(),
  evidenceItemId: uuid.optional(),
  reviewDate: isoDate.optional(),
});
export const PolicyTransitionInput = z.strictObject({
  to: z.enum(['IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'DRAFT']),
  effectiveFrom: isoDate.optional(),
});
export const PolicyDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  category: z.string(),
  ownerUserId: uuid,
  ownerName: z.string().nullable(),
  readerRoles: z.array(z.string()),
  readerLocationIds: z.array(uuid).optional(),
  readerEveryone: z.boolean().optional(),
  currentVersion: z
    .object({
      id: uuid,
      version: z.number(),
      effectiveFrom: isoDate.nullable(),
      reviewDate: isoDate.nullable(),
      /** Review date passed (London date). */
      reviewOverdue: z.boolean(),
      material: z.boolean(),
      evidenceItemId: uuid.nullable(),
      /** Latest uploaded file of the policy document, for opening it. */
      documentEvidenceVersionId: uuid.nullable(),
    })
    .nullable(),
  versions: z.array(
    z.object({
      id: uuid,
      version: z.number(),
      status: z.string(),
      summary: z.string(),
      material: z.boolean(),
      evidenceItemId: uuid.nullable(),
      reviewDate: isoDate.nullable(),
      effectiveFrom: isoDate.nullable(),
      createdBy: uuid,
      createdByName: z.string().nullable(),
      approvedBy: uuid.nullable(),
      approvedByName: z.string().nullable(),
      approvedAt: isoDateTime.nullable(),
      publishedAt: isoDateTime.nullable(),
    }),
  ),
  /** Acknowledgement of the current version among required readers (numerator, denominator). */
  acknowledgement: z.object({ acknowledged: z.number(), required: z.number() }),
  myAcknowledgement: z.enum([
    'CURRENT',
    'CARRIED_FORWARD',
    'REQUIRED',
    'NO_PUBLISHED_VERSION',
    'NOT_A_READER',
  ]),
});
export type PolicyDto = z.infer<typeof PolicyDto>;
export const AckInput = z.strictObject({
  device: z.string().trim().max(120).optional(),
  /** Required (true) for critical instructions. */
  confirmCritical: z.boolean().optional(),
});
/** Required readers of a policy and where each stands against the current version. */
export const PolicyReadersDto = z.object({
  data: z.array(
    z.object({
      userId: uuid,
      displayName: z.string(),
      roleNames: z.array(z.string()),
      state: z.enum(['CURRENT', 'CARRIED_FORWARD', 'REQUIRED', 'NO_PUBLISHED_VERSION']),
      acknowledgedAt: isoDateTime.nullable(),
    }),
  ),
});

// ---- Risks, registration, correspondence ---------------------------------------------------------
const score = z.number().int().min(1).max(5);
export const RiskInput = z.strictObject({
  hazard: z.string().trim().min(3).max(500),
  peopleAffected: z.string().trim().min(2).max(300),
  inherentLikelihood: score,
  inherentImpact: score,
  controls: z.string().trim().min(3).max(4000),
  residualLikelihood: score,
  residualImpact: score,
  ownerUserId: uuid,
  reviewDate: isoDate,
  locationId: uuid.optional(),
  linkedEventIds: z.array(uuid).max(50).default([]),
  title: z.string().trim().min(3).max(200).optional(),
  category: z
    .enum([
      'CLINICAL',
      'OPERATIONAL',
      'WORKFORCE',
      'FLEET',
      'PREMISES',
      'INFORMATION',
      'FINANCIAL',
      'REGULATORY',
      'HARASSMENT',
      'OTHER',
    ])
    .optional(),
  linkedAuditRunIds: z.array(uuid).max(50).default([]),
});
export const RiskPatch = RiskInput.partial()
  .extend({
    status: z.enum(['OPEN', 'CLOSED', 'ARCHIVED']).optional(),
    /** Required to close or archive; also kept as the review note when scores change. */
    reason: z.string().trim().min(3).max(1000).optional(),
  })
  .refine(
    (p) => !p.status || p.status === 'OPEN' || (p.reason?.length ?? 0) >= 3,
    'Give a reason to close or archive the risk',
  );
export const RiskDto = z.object({
  id: uuid,
  code: z.string(),
  hazard: z.string(),
  peopleAffected: z.string(),
  inherent: z.object({
    likelihood: z.number(),
    impact: z.number(),
    score: z.number(),
    rating: z.string(),
  }),
  residual: z.object({
    likelihood: z.number(),
    impact: z.number(),
    score: z.number(),
    rating: z.string(),
  }),
  controls: z.string(),
  ownerUserId: uuid,
  ownerName: z.string().nullable(),
  reviewDate: isoDate,
  reviewOverdue: z.boolean(),
  locationId: uuid.nullable(),
  status: z.string(),
  linkedEventIds: z.array(uuid),
  linkedEvents: z.array(z.object({ id: uuid, code: z.string(), title: z.string() })),
  /** Actions raised from this risk that are not yet verified. */
  openActions: z.number(),
  title: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  /** Residual band in words with the score, e.g. 'High 16'. */
  bandText: z.string().optional(),
  linkedAuditRunIds: z.array(uuid).optional(),
  closedReason: z.string().nullable().optional(),
  closedAt: isoDateTime.nullable().optional(),
  reviews: z
    .array(
      z.object({
        residualScore: z.number(),
        bandText: z.string(),
        note: z.string(),
        byName: z.string().nullable(),
        at: isoDateTime,
      }),
    )
    .optional(),
  version,
});
export const RegistrationInput = z.strictObject({
  providerRef: z.string().trim().max(40).nullable().optional(),
  registeredManagerUserId: uuid.nullable().optional(),
  nominatedIndividual: z.string().trim().max(120).nullable().optional(),
  conditions: z.string().trim().max(4000).nullable().optional(),
  statementOfPurposeItemId: uuid.nullable().optional(),
  insuranceItemId: uuid.nullable().optional(),
  bcpItemId: uuid.nullable().optional(),
  insuranceExpiresOn: isoDate.nullable().optional(),
  bcpReviewedOn: isoDate.nullable().optional(),
  bcpNextReviewOn: isoDate.nullable().optional(),
  /** When the change takes effect; kept in the registration history. */
  effectiveFrom: isoDate.optional(),
  /** Why the record changed; kept in the registration history. */
  reason: z.string().trim().min(3).max(500).optional(),
});
/** A registered location's details at a point in time (append-only, WORKFLOWS I1). */
export const RegistrationLocationInput = z
  .strictObject({
    locationId: uuid,
    cqcLocationId: z.string().trim().max(40).optional(),
    registeredManagerUserId: uuid.nullable().optional(),
    managerStartOn: isoDate.optional(),
    activities: z.array(z.string().trim().min(2).max(120)).max(20).default([]),
    conditions: z.string().trim().max(4000).optional(),
    effectiveFrom: isoDate,
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (l) => !l.registeredManagerUserId || !!l.managerStartOn,
    'Give the registered manager start date',
  );
export const RegistrationLocationDto = z.object({
  id: uuid,
  locationId: uuid,
  locationName: z.string().nullable(),
  cqcLocationId: z.string().nullable(),
  registeredManagerUserId: uuid.nullable(),
  registeredManagerName: z.string().nullable(),
  managerStartOn: isoDate.nullable(),
  activities: z.array(z.string()),
  conditions: z.string().nullable(),
  effectiveFrom: isoDate,
  reason: z.string(),
  recordedByName: z.string().nullable(),
  recordedAt: isoDateTime,
});
export const RegistrationDto = z.object({
  providerRef: z.string().nullable(),
  registeredManagerUserId: uuid.nullable(),
  nominatedIndividual: z.string().nullable(),
  conditions: z.string().nullable(),
  statementOfPurposeItemId: uuid.nullable(),
  insuranceItemId: uuid.nullable(),
  bcpItemId: uuid.nullable(),
  registeredActivities: z.array(z.object({ locationId: uuid, activity: z.string() })),
  insuranceExpiresOn: isoDate.nullable().optional(),
  bcpReviewedOn: isoDate.nullable().optional(),
  bcpNextReviewOn: isoDate.nullable().optional(),
  /** Current entry per location (latest effective). */
  locations: z.array(RegistrationLocationDto).optional(),
  /** Draft CQC notification created by this save (manager or nominated individual changed). */
  notificationDraftId: uuid.nullable().optional(),
  version: z.number(),
});
export const CorrespondenceInput = z.strictObject({
  regulator: z.enum(['CQC', 'ICO', 'HSE', 'COMMISSIONER', 'OTHER']),
  subject: z.string().trim().min(3).max(300),
  receivedOn: isoDate,
  deadline: isoDate.optional(),
  ownerUserId: uuid,
  evidenceItemId: uuid.optional(),
});
export const CorrespondencePatch = z.strictObject({
  status: z.enum(['RESPONDED', 'CLOSED']),
  respondedOn: isoDate.optional(),
});
export const CorrespondenceDto = z.object({
  id: uuid,
  regulator: z.string(),
  subject: z.string(),
  receivedOn: isoDate,
  deadline: isoDate.nullable(),
  status: z.string(),
  respondedOn: isoDate.nullable(),
  ownerUserId: uuid,
  overdue: z.boolean(),
  version,
});

// ---- Events ----------------------------------------------------------------------------
export const EventType = z.enum([
  'INCIDENT',
  'ACCIDENT',
  'NEAR_MISS',
  'SAFEGUARDING',
  'COMPLAINT',
  'COMPLIMENT',
  'DEFECT',
  'HARASSMENT',
  'IRMER',
  'DOLS',
]);
export const EventStatusEnum = z.enum([
  'TRIAGE',
  'PROTECT',
  'ASSESS',
  'INVESTIGATE',
  'RESPOND',
  'ACTIONS',
  'LEARNING_VERIFIED',
  'CLOSED',
]);
const link = z.strictObject({
  type: z.enum(['STAFF', 'VEHICLE', 'EQUIPMENT', 'JOB', 'EVENT']),
  id: uuid,
});
export const EventCreate = z.strictObject({
  types: z.array(EventType).min(1).max(10),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  occurredAt: isoDateTime,
  discoveredAt: isoDateTime.optional(),
  locationId: uuid.optional(),
  severity: z.enum(['NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH']),
  leadUserId: uuid,
  themes: z.array(z.string().trim().min(2).max(40)).max(10).default([]),
  links: z.array(link).max(50).default([]),
  complaint: z
    .strictObject({
      receivedOn: isoDate,
      channel: z.enum(['PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'WEB', 'OTHER']),
      consentToShare: z.boolean().default(false),
      preferences: z.string().trim().max(500).optional(),
    })
    .optional(),
  safeguarding: z
    .strictObject({
      details: z.string().trim().min(3).max(8000),
      agencies: z.string().trim().max(1000).optional(),
      referralRef: z.string().trim().max(120).optional(),
    })
    .optional(),
});
export const EventTransitionInput = z.strictObject({ to: EventStatusEnum, note: reason });
export const ObligationBodyEnum = z.enum([
  'CQC',
  'SAFEGUARDING',
  'RIDDOR',
  'INSURER',
  'COMMISSIONER',
  'ICO',
  'LFPSE',
  'OTHER',
]);
export const ObligationInput = z.strictObject({
  body: ObligationBodyEnum,
  trigger: z.string().trim().min(3).max(500),
  basis: z.string().trim().min(3).max(500),
  deadlineAt: isoDateTime.optional(),
});
export const ObligationPatch = z
  .strictObject({
    decision: z.enum(['REQUIRED', 'NOT_REQUIRED']),
    decisionReason: z.string().trim().min(3).max(1000),
    submittedAt: isoDateTime,
    reference: z.string().trim().max(120),
    receiptItemId: uuid,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export const CandourInput = z.strictObject({
  notifiable: z.boolean(),
  reason: z.string().trim().min(10).max(2000),
});
export const ComplaintPatch = z
  .strictObject({
    acknowledgedOn: isoDate,
    respondedOn: isoDate,
    outcome: z.enum(['UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD', 'WITHDRAWN']),
    escalationRightsGiven: z.boolean(),
    /** Reopen a responded complaint: clears the response and outcome, keeps the history. */
    reopenReason: reason,
  })
  .partial();
export const EventDto = z.object({
  id: uuid,
  code: z.string(),
  types: z.array(EventType),
  title: z.string(),
  description: z.string(),
  occurredAt: isoDateTime,
  discoveredAt: isoDateTime,
  locationId: uuid.nullable(),
  severity: z.string(),
  leadUserId: uuid,
  leadName: z.string().nullable(),
  status: EventStatusEnum,
  themes: z.array(z.string()),
  links: z.array(z.object({ type: z.string(), id: uuid })),
  restricted: z.boolean(),
  candourFlag: z.boolean(),
  /** A candour decision has been recorded (only meaningful when flagged). */
  candourDecided: z.boolean(),
  /** Restricted to HR and the registered manager (harassment reports). */
  hrRestricted: z.boolean().optional(),
  reportedByName: z.string().nullable().optional(),
  place: z.string().nullable().optional(),
  /** Job or booking references only; never names. */
  peopleRefs: z.array(z.string()).optional(),
  immediateActions: z.string().nullable().optional(),
  stillAtRisk: z.boolean().optional(),
  nhsFunded: z.boolean().optional(),
  category: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  protectionSteps: z.string().nullable().optional(),
  triageDueAt: isoDateTime.nullable().optional(),
  triagedAt: isoDateTime.nullable().optional(),
  triagedByName: z.string().nullable().optional(),
  /** Reported through the any-role form and not triaged within one working day. */
  triageOverdue: z.boolean().optional(),
  learningResponse: z.string().nullable().optional(),
  learningNotes: z.string().nullable().optional(),
  contributoryFactors: z.string().nullable().optional(),
  version,
});
export type EventDto = z.infer<typeof EventDto>;

// ---- Incident reporting by any staff member (WORKFLOWS H1, finding 90) ----------------------
export const ReportKind = z.enum([
  'INCIDENT',
  'NEAR_MISS',
  'ACCIDENT',
  'SAFEGUARDING',
  'HARASSMENT',
  'COMPLAINT',
  'IRMER',
  'DOLS',
]);
const personRef = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z
      .string()
      .regex(
        /^(?:J|BK|BKG|JOB)-?[A-Z0-9-]{2,20}$/,
        'Use a job or booking reference (for example J-1234), never a name',
      ),
  );
export const IncidentReportInput = z
  .strictObject({
    kind: ReportKind,
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().min(10).max(4000),
    occurredAt: isoDateTime,
    place: z.string().trim().max(200).optional(),
    locationId: uuid.optional(),
    peopleRefs: z.array(personRef).max(20).default([]),
    immediateActions: z.string().trim().max(2000).optional(),
    /** Someone is still at risk: alerts the registered manager and governance lead now. */
    stillAtRisk: z.boolean().default(false),
    nhsFunded: z.boolean().default(false),
    photoItemIds: z.array(uuid).max(10).default([]),
    complaint: z
      .strictObject({
        receivedOn: isoDate,
        channel: z.enum(['PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'WEB', 'OTHER']),
        consentToShare: z.boolean().default(false),
        preferences: z.string().trim().max(500).optional(),
      })
      .optional(),
  })
  .refine((r) => r.kind !== 'COMPLAINT' || !!r.complaint, {
    message: 'Say when and how the complaint was received',
    path: ['complaint'],
  });
export const IncidentReportReceipt = z.object({
  id: uuid,
  /** Reference number to quote, e.g. EVT-2026-0042. */
  code: z.string(),
  triageDueAt: isoDateTime,
  stillAtRiskAlerted: z.boolean(),
  message: z.string(),
});
export const MyReportDto = z.object({
  id: uuid,
  code: z.string(),
  types: z.array(z.string()),
  title: z.string(),
  status: EventStatusEnum,
  reportedAt: isoDateTime,
  triaged: z.boolean(),
});
/** Same list as INCIDENT_CATEGORIES in @hub/rules and the event_category_check constraint. */
export const IncidentCategoryEnum = z.enum([
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
]);
export const TriageInput = z.strictObject({
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  harm: z.enum(['NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH']),
  category: IncidentCategoryEnum,
  leadUserId: uuid,
  /** What has been done to keep people safe; required even when nothing more is needed. */
  protectionSteps: z.string().trim().min(3).max(2000),
  /** Risks or actions that carry the protection steps. */
  linkedRiskIds: z.array(uuid).max(10).default([]),
  nhsFunded: z.boolean().optional(),
});
export const ObligationSuggestionDto = z.object({
  body: ObligationBodyEnum,
  trigger: z.string(),
  basis: z.string(),
  deadlineAt: isoDateTime.nullable(),
  deadlineText: z.string(),
  draftText: z.string().nullable(),
  /** An obligation for this body is already on the event. */
  recorded: z.boolean(),
});
export const AcceptSuggestionsInput = z.strictObject({
  bodies: z.array(ObligationBodyEnum).min(1).max(8),
});
export const CandourStepEnum = z.enum([
  'TOLD_IN_PERSON',
  'APOLOGY',
  'WRITTEN_NOTICE',
  'SUPPORT_OFFERED',
  'FINDINGS_SHARED',
]);
export const CandourStepInput = z.strictObject({
  step: CandourStepEnum,
  doneOn: isoDate,
  note: z.string().trim().max(1000).optional(),
});
export const LearningResponseEnum = z.enum([
  'AFTER_ACTION_REVIEW',
  'SWARM_HUDDLE',
  'MDT_REVIEW',
  'THEMATIC_REVIEW',
  'PSII',
  'NO_FURTHER_RESPONSE',
]);
export const LearningInput = z.strictObject({
  response: LearningResponseEnum,
  notes: z.string().trim().min(3).max(4000),
  contributoryFactors: z.string().trim().max(4000).optional(),
});
export const ObligationDto = z.object({
  id: uuid,
  body: z.string(),
  trigger: z.string(),
  basis: z.string(),
  deadlineAt: isoDateTime.nullable(),
  decision: z.enum(['PENDING', 'REQUIRED', 'NOT_REQUIRED']),
  decisionReason: z.string().nullable(),
  decidedByName: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  reference: z.string().nullable(),
  overdue: z.boolean(),
  version,
});
export const EventDetailDto = EventDto.extend({
  transitions: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      note: z.string(),
      byUserId: uuid,
      byName: z.string().nullable(),
      at: isoDateTime,
    }),
  ),
  obligations: z.array(ObligationDto),
  candour: z.array(
    z.object({
      notifiable: z.boolean(),
      reason: z.string(),
      decidedBy: uuid,
      decidedByName: z.string().nullable(),
      decidedAt: isoDateTime,
    }),
  ),
  complaint: z
    .object({
      receivedOn: isoDate,
      channel: z.string(),
      acknowledgeBy: isoDate,
      respondBy: isoDate,
      acknowledgedOn: isoDate.nullable(),
      respondedOn: isoDate.nullable(),
      /** Target passed without the step being recorded (London date). */
      acknowledgeOverdue: z.boolean(),
      respondOverdue: z.boolean(),
      preferences: z.string().nullable(),
      consentToShare: z.boolean(),
      outcome: z.string().nullable(),
      escalationRightsGiven: z.boolean(),
      /** Where the complainant can go next (PHSO for NHS-funded care, otherwise ISCAS/LGSCO). */
      escalationText: z.string().optional(),
      version,
    })
    .nullable(),
  candourSteps: z
    .array(
      z.object({
        step: z.string(),
        label: z.string(),
        doneOn: isoDate,
        note: z.string().nullable(),
        byName: z.string().nullable(),
        at: isoDateTime,
      }),
    )
    .optional(),
  /** Candour steps still to do (labels), empty when not notifiable or complete. */
  candourOutstanding: z.array(z.string()).optional(),
  /** Why the event cannot close yet, in words. Empty when it can. */
  closeBlockers: z.array(z.string()).optional(),
  safeguarding: z
    .object({
      details: z.string(),
      agencies: z.string().nullable(),
      referralRef: z.string().nullable(),
      outcome: z.string().nullable(),
    })
    .nullable(),
  actions: z.array(ActionDto),
});
export type EventDetailDto = z.infer<typeof EventDetailDto>;
export const EventListQuery = z.object({
  status: EventStatusEnum.optional(),
  type: EventType.optional(),
  open: z.enum(['true', 'false']).optional(),
});
export const EventActionInput = FindingActionInput.omit({ kind: true });

// ---- Feedback, surveys and themes (EVT-04) ----------------------------------------------------
export const FeedbackKind = z.enum(['COMPLIMENT', 'STAFF_FEEDBACK', 'PATIENT_SURVEY']);
const theme = z.string().trim().toLowerCase().min(2).max(40);
export const FeedbackCreate = z.strictObject({
  kind: FeedbackKind,
  receivedOn: isoDate,
  locationId: uuid.optional(),
  /** Where it came from, e.g. "Post-journey survey, October". No names. */
  source: z.string().trim().min(2).max(200),
  /** Minimised summary: no patient or staff identifiers. */
  summary: z.string().trim().min(3).max(2000),
  rating: z.number().int().min(1).max(5).optional(),
  themes: z.array(theme).max(10).default([]),
});
export const FeedbackQuery = z.object({
  kind: FeedbackKind.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export const FeedbackDto = z.object({
  id: uuid,
  kind: FeedbackKind,
  receivedOn: isoDate,
  locationId: uuid.nullable(),
  source: z.string(),
  summary: z.string(),
  rating: z.number().int().nullable(),
  themes: z.array(z.string()),
  openActions: z.number().int(),
});
export type FeedbackDto = z.infer<typeof FeedbackDto>;
export const FeedbackThemesDto = z.object({
  from: isoDate,
  to: isoDate,
  /** Complaints (events) and feedback together, grouped by theme. Counts only. */
  themes: z.array(
    z.object({
      theme: z.string(),
      compliments: z.number().int(),
      staffFeedback: z.number().int(),
      patientSurveys: z.number().int(),
      complaints: z.number().int(),
      total: z.number().int(),
      averageRating: z.number().nullable(),
    }),
  ),
  totals: z.object({
    feedback: z.number().int(),
    complaints: z.number().int(),
    untagged: z.number().int(),
  }),
});
export type FeedbackThemesDto = z.infer<typeof FeedbackThemesDto>;
export const FeedbackActionInput = FindingActionInput.omit({ kind: true });

// ---- Premises -----------------------------------------------------------------------------
export const PremisesArea = z.enum([
  'FIRE',
  'WATER',
  'ELECTRICAL_GAS',
  'COSHH_INFECTION',
  'OXYGEN',
  'PEOPLE_WORKPLACE',
  'BUILDING_EQUIPMENT',
]);
/** J1: where in the location the item is (e.g. "Oxygen store", "Garage"). */
const premisesAreaName = z.string().trim().min(2).max(120);
/** J1: without a linked requirement, an interval in months with its source (frequencySource). */
const intervalMonths = z.number().int().min(1).max(120);
export const PremisesCreate = z.strictObject({
  locationId: uuid,
  controlArea: PremisesArea,
  areaName: premisesAreaName.optional(),
  title: z.string().trim().min(3).max(200),
  responsibleUserId: uuid,
  frequencySource: z.string().trim().min(3).max(300),
  intervalMonths: intervalMonths.optional(),
  templateId: uuid.optional(),
  actionOwnerUserId: uuid.optional(),
  contractorName: z.string().trim().min(2).max(200).optional(),
  assessmentRef: z.string().trim().min(2).max(200).optional(),
  assessedOn: isoDate.optional(),
  /** Infection-control items at an administration-only base are not on by default (HSE-01). */
  confirmClinicalControl: z.boolean().optional(),
});
export const PremisesApplicability = z.strictObject({
  applicable: z.boolean(),
  reason: z.string().trim().min(10).max(1000),
  /** J1: who reviews the decision (defaults to the person deciding) and when (default 1 year). */
  reviewerId: uuid.optional(),
  reviewOn: isoDate.optional(),
});
/** J1: a finding on a premises item becomes an action on the actions register. */
export const PremisesFindingInput = z.strictObject({
  title: z.string().trim().min(3).max(300),
  ownerUserId: uuid.optional(),
  deadline: isoDate,
  severity: severity.optional(),
});
export const PremisesHistoryDto = z.object({
  id: uuid,
  change: z.enum(['CREATED', 'EDITED', 'APPLICABILITY', 'SCHEDULE', 'FINDING']),
  summary: z.string(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changedBy: uuid,
  changedByName: z.string().nullable(),
  changedAt: isoDateTime,
});
/** Edit the register entry itself; the schedule and its dates live on the linked requirement. */
export const PremisesPatch = z
  .strictObject({
    title: z.string().trim().min(3).max(200),
    responsibleUserId: uuid,
    actionOwnerUserId: uuid,
    frequencySource: z.string().trim().min(3).max(300),
    areaName: premisesAreaName.nullable(),
    intervalMonths: intervalMonths.nullable(),
    contractorName: z.string().trim().min(2).max(200).nullable(),
    assessmentRef: z.string().trim().min(2).max(200).nullable(),
    assessedOn: isoDate.nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
/** Link a schedule later (finding 65). The first due date is set here; later moves need approval. */
export const PremisesSchedule = z.strictObject({
  templateId: uuid,
  dueDate: isoDate.optional(),
});
export const PremisesDto = z.object({
  id: uuid,
  locationId: uuid,
  controlArea: PremisesArea,
  title: z.string(),
  responsibleUserId: uuid,
  responsibleName: z.string().nullable(),
  frequencySource: z.string(),
  requirementInstanceId: uuid.nullable(),
  /** Title of the linked requirement and how its date works (for uploads). */
  scheduleTitle: z.string().nullable(),
  deadlineKind: z.string().nullable(),
  applicable: z.boolean(),
  applicabilityReason: z.string().nullable(),
  applicabilityReviewerId: uuid.nullable().optional(),
  applicabilityReviewerName: z.string().nullable().optional(),
  applicabilityReviewOn: isoDate.nullable().optional(),
  areaName: z.string().nullable().optional(),
  intervalMonths: z.number().int().nullable().optional(),
  actionOwnerUserId: uuid.nullable(),
  actionOwnerName: z.string().nullable(),
  contractorName: z.string().nullable(),
  assessmentRef: z.string().nullable(),
  assessedOn: isoDate.nullable(),
  /** Evidence items attached to the linked requirement. */
  evidenceCount: z.number().int(),
  status: RagStatus,
  reasonText: z.string(),
  nextDue: isoDate.nullable(),
  /** J1: a missed oxygen storage check at a base with ambulances stops deployment. */
  deploymentCritical: z.boolean().optional(),
  version,
});

// ---- Dashboard + exports ---------------------------------------------------------------------
/**
 * DASH-01 filters. Organisation is the tenant (header / switcher); the rest narrow the rows.
 * `serviceId` keeps requirements whose template names that service (or names none = all services).
 * `dateFrom`/`dateTo` bound the row deadline; rows with no deadline (e.g. a blocked vehicle) stay.
 */
export const DashboardQuery = z.object({
  locationId: uuid.optional(),
  serviceId: uuid.optional(),
  ownerUserId: uuid.optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  module: z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES']).optional(),
});
export type DashboardFilter = z.infer<typeof DashboardQuery>;
export const DashboardSummary = z.object({
  tiles: z.object({
    overdue: z.number(),
    dueSoon: z.number(),
    blockedVehicles: z.number(),
    jobsToday: z.number(),
    unverified: z.number(),
    /** Audit runs past their due date and not submitted (sector dashboards). */
    auditsOverdue: z.number().optional(),
  }),
  /** Modules with nothing set up yet: shown in grey as 'Not set up', never 'Green, none'. */
  notSetUp: z.array(z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES'])).optional(),
  modules: z.array(
    z.object({
      module: z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES']),
      status: RagStatus,
      count: z.number(),
      label: z.string(),
    }),
  ),
  operations: z.object({
    jobsAwaitingAllocation: z.number(),
    acknowledgementsDue: z.number(),
  }),
  criticalOpen: z.number(),
  coverage: z.object({
    numerator: z.number(),
    denominator: z.number(),
    exclusions: z.number(),
    percent: z.number().nullable(),
    label: z.literal('Internal measure — not a CQC rating'),
  }),
  lastRefreshedAt: isoDateTime,
  sources: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  /**
   * Modules and tiles the caller may see (permissions and sector packs). Rows, tiles and module
   * status for anything else are left out by the server, not hidden by the screen.
   */
  visibleModules: z
    .array(z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES', 'EVENTS', 'JOBS']))
    .optional(),
  visibleTiles: z
    .array(
      z.enum(['overdue', 'dueSoon', 'blockedVehicles', 'jobsToday', 'unverified', 'auditsOverdue']),
    )
    .optional(),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;
/**
 * Group dashboard: counts only, one row per organisation the user may see. No record, patient or
 * HR detail crosses an organisation boundary; drill-down happens inside the organisation itself.
 */
export const GroupDashboardQuery = z.object({
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
});
export const GroupDashboardOrg = z.object({
  organisationId: uuid,
  organisationName: z.string(),
  ok: z.boolean(),
  /** Why the organisation is missing figures (source unavailable, MFA not satisfied). */
  unavailableReason: z.string().nullable(),
  tiles: z
    .object({
      overdue: z.number(),
      dueSoon: z.number(),
      blockedVehicles: z.number(),
      jobsToday: z.number(),
      unverified: z.number(),
    })
    .nullable(),
  criticalOpen: z.number().nullable(),
  worstStatus: RagStatus.nullable(),
});
export const GroupDashboardSummary = z.object({
  organisations: z.array(GroupDashboardOrg),
  totals: z.object({
    overdue: z.number(),
    dueSoon: z.number(),
    blockedVehicles: z.number(),
    jobsToday: z.number(),
    unverified: z.number(),
    criticalOpen: z.number(),
  }),
  lastRefreshedAt: isoDateTime,
});
export type GroupDashboardSummary = z.infer<typeof GroupDashboardSummary>;
export const DashboardTile = z.enum([
  'overdue',
  'dueSoon',
  'blockedVehicles',
  'unverified',
  'jobsToday',
  'awaitingAllocation',
  'acknowledgementsDue',
  'auditsOverdue',
  'all',
]);
export const ActionRow = z.object({
  key: z.string(),
  module: z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES', 'EVENTS', 'JOBS']),
  item: z.string(),
  ownerUserId: uuid.nullable(),
  ownerName: z.string().nullable(),
  deadline: isoDate.nullable(),
  status: RagStatus,
  reasonText: z.string(),
  tiles: z.array(z.string()),
  link: z.object({
    type: z.string(),
    id: uuid,
    subjectType: z.string().optional(),
    subjectId: uuid.optional(),
  }),
});
export type ActionRow = z.infer<typeof ActionRow>;
export const ActionRowsQuery = DashboardQuery.extend({ tile: DashboardTile.default('all') });

export const EvidencePackPurpose = z.enum(['INSPECTION', 'NHS_CONTRACT', 'INTERNAL']);
export const EvidencePackSection = z.enum([
  'REQUIREMENTS',
  'AUDITS',
  'ACTIONS',
  'POLICIES',
  'GOVERNANCE',
  'CONTRACTS',
]);
export const EvidencePackInput = z
  .strictObject({
    locationId: uuid.optional(),
    domain: QualityDomain.optional(),
    /** Several key questions at once; `domain` stays for one. */
    domains: z.array(QualityDomain).max(5).optional(),
    serviceId: uuid.optional(),
    /** Framework version the pack is built against (shown on the cover). */
    frameworkVersion: z.string().trim().max(40).optional(),
    from: isoDate,
    to: isoDate,
    /** NHS_CONTRACT keeps only NHS contract items among the requirements. */
    purpose: EvidencePackPurpose.default('INSPECTION'),
    sections: z
      .array(EvidencePackSection)
      .min(1)
      .max(6)
      .default(['REQUIREMENTS', 'AUDITS', 'ACTIONS', 'POLICIES']),
    /** False: index only (PDF and CSV), no evidence files. */
    includeFiles: z.boolean().default(true),
    /** Only requirements that are not met. */
    gapsOnly: z.boolean().default(false),
  })
  .refine((p) => p.to >= p.from, 'to must not be before from')
  .refine((p) => new Set(p.sections).size === p.sections.length, 'Each section can be chosen once');
export const ExportDto = z.object({
  id: uuid,
  kind: z.string(),
  status: z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']),
  bytes: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
  download: z.object({ url: z.string(), expiresAt: isoDateTime }).nullable(),
});
export type ExportDto = z.infer<typeof ExportDto>;

// ---- Inspection view (WORKFLOWS L5): read-only, by key question, every view logged ----------
export const InspectionQuery = z.object({ locationId: uuid.optional() });
export const InspectionOverviewDto = z.object({
  generatedAt: isoDateTime,
  /** The rating CQC published (null when none recorded). The hub never calculates one. */
  publishedRating: z
    .object({ rating: z.string(), publishedOn: isoDate.nullable(), locationName: z.string() })
    .nullable(),
  coverage: z.object({
    numerator: z.number(),
    denominator: z.number(),
    percent: z.number().nullable(),
    label: z.literal('Internal measure — not a CQC rating'),
  }),
  keyQuestions: z.array(
    z.object({
      domain: QualityDomain,
      label: z.string(),
      /** Requirements met with verified evidence / requirements that apply. */
      verified: z.number(),
      applicable: z.number(),
      gaps: z.array(z.object({ title: z.string(), reasonText: z.string() })),
      audits: z.array(
        z.object({
          id: uuid,
          code: z.string(),
          title: z.string(),
          submittedAt: isoDateTime.nullable(),
          outcome: RagStatus.nullable(),
        }),
      ),
      openActions: z.number(),
      policies: z.array(
        z.object({ code: z.string(), title: z.string(), version: z.number().nullable() }),
      ),
    }),
  ),
});
export type InspectionOverviewDto = z.infer<typeof InspectionOverviewDto>;
export type PolicyReadersDto = z.infer<typeof PolicyReadersDto>;
