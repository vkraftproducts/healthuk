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
      approvedBy: uuid.nullable(),
    }),
  ),
});
export type AuditTemplateDto = z.infer<typeof AuditTemplateDto>;

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
      z.strictObject({
        controlCode: z.string(),
        subjectId: uuid.optional(),
        result: AuditResultEnum,
        method: AuditMethodEnum,
        note: z.string().trim().max(2000).optional(),
        evidenceItemId: uuid.optional(),
      }),
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
export const ActionDto = z.object({
  id: uuid,
  code: z.string(),
  sourceType: z.enum(['FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE']),
  sourceId: uuid,
  kind: z.enum(['ACTION', 'REAUDIT']),
  title: z.string(),
  severity,
  ownerUserId: uuid,
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
      at: isoDateTime,
    }),
  ),
  version,
});
export type ActionDto = z.infer<typeof ActionDto>;
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
  ownerUserId: uuid,
  dueDate: isoDate,
  status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'ACTIONS_OPEN', 'CLOSED']),
  outcome: RagStatus.nullable(),
  outcomeReason: z.string().nullable(),
  submittedAt: isoDateTime.nullable(),
  reauditOf: uuid.nullable(),
  version,
});
export type AuditRunDto = z.infer<typeof AuditRunDto>;
export const AuditRunDetailDto = AuditRunDto.extend({
  controls: z.array(z.object({ code: z.string(), question: z.string(), critical: z.boolean() })),
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
  summary: z.string().trim().min(3).max(2000),
  evidenceItemId: uuid.optional(),
  reviewDate: isoDate.optional(),
});
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
  readerRoles: z.array(z.string()),
  currentVersion: z
    .object({
      id: uuid,
      version: z.number(),
      effectiveFrom: isoDate.nullable(),
      reviewDate: isoDate.nullable(),
      material: z.boolean(),
    })
    .nullable(),
  versions: z.array(
    z.object({
      id: uuid,
      version: z.number(),
      status: z.string(),
      summary: z.string(),
      material: z.boolean(),
      createdBy: uuid,
      approvedBy: uuid.nullable(),
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
export const AckInput = z.strictObject({ device: z.string().trim().max(120).optional() });

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
});
export const RiskPatch = RiskInput.partial().extend({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});
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
  reviewDate: isoDate,
  reviewOverdue: z.boolean(),
  locationId: uuid.nullable(),
  status: z.string(),
  linkedEventIds: z.array(uuid),
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
  types: z.array(EventType).min(1).max(7),
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
export const ObligationInput = z.strictObject({
  body: z.enum(['CQC', 'SAFEGUARDING', 'RIDDOR', 'INSURER', 'COMMISSIONER', 'ICO', 'OTHER']),
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
  status: EventStatusEnum,
  themes: z.array(z.string()),
  links: z.array(z.object({ type: z.string(), id: uuid })),
  restricted: z.boolean(),
  candourFlag: z.boolean(),
  version,
});
export type EventDto = z.infer<typeof EventDto>;
export const ObligationDto = z.object({
  id: uuid,
  body: z.string(),
  trigger: z.string(),
  basis: z.string(),
  deadlineAt: isoDateTime.nullable(),
  decision: z.enum(['PENDING', 'REQUIRED', 'NOT_REQUIRED']),
  decisionReason: z.string().nullable(),
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
      at: isoDateTime,
    }),
  ),
  obligations: z.array(ObligationDto),
  candour: z.array(
    z.object({
      notifiable: z.boolean(),
      reason: z.string(),
      decidedBy: uuid,
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
      consentToShare: z.boolean(),
      outcome: z.string().nullable(),
      escalationRightsGiven: z.boolean(),
      version,
    })
    .nullable(),
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
export const PremisesCreate = z.strictObject({
  locationId: uuid,
  controlArea: PremisesArea,
  title: z.string().trim().min(3).max(200),
  responsibleUserId: uuid,
  frequencySource: z.string().trim().min(3).max(300),
  templateId: uuid.optional(),
});
export const PremisesApplicability = z.strictObject({
  applicable: z.boolean(),
  reason: z.string().trim().min(10).max(1000),
});
export const PremisesDto = z.object({
  id: uuid,
  locationId: uuid,
  controlArea: PremisesArea,
  title: z.string(),
  responsibleUserId: uuid,
  frequencySource: z.string(),
  requirementInstanceId: uuid.nullable(),
  applicable: z.boolean(),
  applicabilityReason: z.string().nullable(),
  status: RagStatus,
  reasonText: z.string(),
  nextDue: isoDate.nullable(),
  version,
});

// ---- Dashboard + exports ---------------------------------------------------------------------
export const DashboardQuery = z.object({
  locationId: uuid.optional(),
  module: z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES']).optional(),
});
export const DashboardSummary = z.object({
  tiles: z.object({
    overdue: z.number(),
    dueSoon: z.number(),
    blockedVehicles: z.number(),
    jobsToday: z.number(),
    unverified: z.number(),
  }),
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
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;
export const DashboardTile = z.enum([
  'overdue',
  'dueSoon',
  'blockedVehicles',
  'unverified',
  'jobsToday',
  'awaitingAllocation',
  'acknowledgementsDue',
  'all',
]);
export const ActionRow = z.object({
  key: z.string(),
  module: z.enum(['STAFF', 'FLEET', 'COMPLIANCE', 'PREMISES', 'EVENTS', 'JOBS']),
  item: z.string(),
  ownerUserId: uuid.nullable(),
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

export const EvidencePackInput = z
  .strictObject({
    locationId: uuid.optional(),
    domain: QualityDomain.optional(),
    from: isoDate,
    to: isoDate,
  })
  .refine((p) => p.to >= p.from, 'to must not be before from');
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
