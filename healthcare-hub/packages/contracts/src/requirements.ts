import { z } from 'zod';
import { isoDate, isoDateTime, RagStatus, uuid } from './common.js';

const version = z.number().int().min(1);

export const SubjectType = z.enum([
  'STAFF',
  'VEHICLE',
  'EQUIPMENT',
  'PREMISES',
  'SERVICE',
  'ORGANISATION',
]);
export type SubjectType = z.infer<typeof SubjectType>;
export const Blocking = z.enum([
  'NONE',
  'POLICY',
  'DEPLOYMENT_CRITICAL',
  'STATUTORY',
  'SAFETY_CRITICAL',
]);
export const DeadlineKind = z.enum(['DUE', 'EXPIRY', 'REVIEW']);
export const Basis = z.enum(['STATUTORY', 'REGULATORY_GUIDANCE', 'ORG_POLICY', 'GOOD_PRACTICE']);
export const VersionStatus = z.enum(['DRAFT', 'APPROVED', 'EFFECTIVE', 'SUPERSEDED']);

export const Recurrence = z
  .object({
    type: z.enum(['FIXED_CALENDAR', 'COMPLETION_BASED', 'MILEAGE', 'EVENT_TRIGGERED', 'PER_SHIFT']),
    interval: z
      .object({
        unit: z.enum(['DAYS', 'MONTHS', 'YEARS']),
        every: z.number().int().min(1).max(3650),
      })
      .strict()
      .optional(),
    mileageEvery: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.type === 'FIXED_CALENDAR' || r.type === 'COMPLETION_BASED') && !r.interval) {
      ctx.addIssue({ code: 'custom', path: ['interval'], message: `${r.type} needs an interval` });
    }
    if (r.type === 'MILEAGE' && !r.mileageEvery) {
      ctx.addIssue({
        code: 'custom',
        path: ['mileageEvery'],
        message: 'MILEAGE needs mileageEvery',
      });
    }
  });
export type Recurrence = z.infer<typeof Recurrence>;

export const TemplateVersionInput = z
  .object({
    basisType: Basis,
    regulationRef: z.string().trim().max(200).optional(),
    sourceUrl: z.string().url().max(500).startsWith('https://').optional(),
    sourceVersionDate: isoDate.optional(),
    subjectType: SubjectType,
    applicabilityRule: z.record(z.string(), z.unknown()).default({}),
    evidenceType: z.string().trim().min(1).max(60).default('DOCUMENT'),
    recurrence: Recurrence,
    warningDays: z
      .array(z.number().int().min(1).max(365))
      .min(1)
      .max(10)
      .default([90, 60, 30, 14, 7]),
    dueSoonDays: z.number().int().min(0).max(365).default(30),
    blocking: Blocking.default('NONE'),
    deadlineKind: DeadlineKind.default('DUE'),
    approvalRole: z.string().trim().max(60).optional(),
    frameworkMappings: z
      .array(z.object({ framework: z.string().max(60), key: z.string().max(60) }).strict())
      .max(20)
      .default([]),
  })
  .strict();
export type TemplateVersionInput = z.infer<typeof TemplateVersionInput>;

export const TemplateCreate = z
  .object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,59}$/, 'Use capital letters, digits, - or _'),
    title: z.string().trim().min(1).max(200),
    version: TemplateVersionInput,
  })
  .strict();

export const TemplateVersionDto = TemplateVersionInput.extend({
  id: uuid,
  templateId: uuid,
  version,
  status: VersionStatus,
  effectiveFrom: isoDate.nullable(),
  approvedBy: uuid.nullable(),
  approvedAt: isoDateTime.nullable(),
  createdBy: uuid.nullable(),
})
  .omit({ applicabilityRule: true })
  .extend({ applicabilityRule: z.record(z.string(), z.unknown()) });
export type TemplateVersionDto = z.infer<typeof TemplateVersionDto>;

export const TemplateDto = z.object({
  id: uuid,
  code: z.string(),
  title: z.string(),
  pack: z.string(),
  /** Library templates are read-only; adopt one to get an editable organisation copy. */
  isLibrary: z.boolean(),
  versions: z.array(TemplateVersionDto),
});
export type TemplateDto = z.infer<typeof TemplateDto>;

export const InstanceDto = z.object({
  id: uuid,
  templateId: uuid,
  templateCode: z.string(),
  templateTitle: z.string(),
  templateVersionId: uuid,
  subjectType: SubjectType,
  subjectId: uuid,
  locationId: uuid.nullable(),
  ownerUserId: uuid.nullable(),
  deputyUserId: uuid.nullable(),
  deadlineKind: DeadlineKind,
  blocking: Blocking,
  anchorDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  expiryDate: isoDate.nullable(),
  reviewDate: isoDate.nullable(),
  applicability: z.enum(['APPLICABLE', 'APPROVED_NOT_APPLICABLE']),
  status: RagStatus,
  reasonCode: z.string(),
  reasonText: z.string(),
  effect: z.enum(['NONE', 'POLICY_BLOCK', 'BLOCK']),
  currentlyVerified: z.boolean(),
  computedAt: isoDateTime.nullable(),
  version,
});
export type InstanceDto = z.infer<typeof InstanceDto>;

export const InstanceCreate = z
  .object({
    templateId: uuid,
    subjectType: SubjectType,
    subjectId: uuid,
    locationId: uuid.nullable().default(null),
    ownerUserId: uuid.nullable().default(null),
    deputyUserId: uuid.nullable().default(null),
    anchorDate: isoDate.nullable().default(null),
    dueDate: isoDate.nullable().default(null),
    expiryDate: isoDate.nullable().default(null),
    reviewDate: isoDate.nullable().default(null),
  })
  .strict();
export const InstancePatch = z
  .object({
    ownerUserId: uuid.nullable().optional(),
    deputyUserId: uuid.nullable().optional(),
    locationId: uuid.nullable().optional(),
  })
  .strict();

export const InstanceListQuery = z.object({
  subjectType: SubjectType.optional(),
  subjectId: uuid.optional(),
  status: z
    .string()
    .regex(/^(RED|AMBER|GREEN|GREY|NOT_APPLICABLE)(,(RED|AMBER|GREEN|GREY|NOT_APPLICABLE))*$/)
    .optional(),
  ownerId: uuid.optional(),
  locationId: uuid.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const ApplicabilityInput = z
  .object({
    decision: z.enum(['APPLICABLE', 'APPROVED_NOT_APPLICABLE']),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export const DueDateChangeInput = z
  .object({
    field: DeadlineKind,
    newDate: isoDate,
    reason: z.string().trim().min(10).max(1000),
    approverId: uuid,
  })
  .strict();

export const DueDateChangeDto = z.object({
  id: uuid,
  field: DeadlineKind,
  oldDate: isoDate.nullable(),
  newDate: isoDate,
  reason: z.string(),
  approverId: uuid,
  createdAt: isoDateTime,
});

export const InstanceDetailDto = InstanceDto.extend({
  decisions: z.array(
    z.object({
      id: uuid,
      decision: z.string(),
      reason: z.string(),
      reviewerId: uuid,
      reviewDate: isoDate,
      createdAt: isoDateTime,
    }),
  ),
  dueDateChanges: z.array(DueDateChangeDto),
});
export type InstanceDetailDto = z.infer<typeof InstanceDetailDto>;

export const InstancePage = z.object({
  data: z.array(InstanceDto),
  nextCursor: z.string().nullable(),
});

// ---- evidence ---------------------------------------------------------------

export const EVIDENCE_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
export const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

export const UploadRequest = z
  .object({
    title: z.string().trim().min(1).max(200),
    mime: z.enum(EVIDENCE_MIME_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_EVIDENCE_BYTES),
    requirementInstanceIds: z.array(uuid).max(20).default([]),
    itemId: uuid.optional(),
    validFrom: isoDate.optional(),
    validTo: isoDate.optional(),
    sensitivity: z
      .enum(['NORMAL', 'HR', 'CLINICAL', 'SAFEGUARDING', 'CRIMINAL_OFFENCE'])
      .default('NORMAL'),
  })
  .strict()
  .refine((u) => !u.validFrom || !u.validTo || u.validTo >= u.validFrom, {
    message: 'validTo must not be before validFrom',
    path: ['validTo'],
  });

export const UploadResponse = z.object({
  evidenceItemId: uuid,
  evidenceVersionId: uuid,
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  maxBytes: z.number().int(),
  expiresAt: isoDateTime,
});

export const EvidenceState = z.enum([
  'AWAITING_UPLOAD',
  'SCANNING',
  'QUARANTINED',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
]);
export const EvidenceVersionDto = z.object({
  id: uuid,
  itemId: uuid,
  versionNo: version,
  title: z.string(),
  sensitivity: z.string(),
  mime: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  sha256: z.string().nullable(),
  scanStatus: z.enum(['PENDING', 'CLEAN', 'MALICIOUS', 'FAILED']),
  state: EvidenceState,
  uploadedBy: uuid,
  uploadedAt: isoDateTime.nullable(),
  validFrom: isoDate.nullable(),
  validTo: isoDate.nullable(),
  decision: z.enum(['ACCEPTED', 'REJECTED']).nullable(),
  decisionReason: z.string().nullable(),
  reviewerId: uuid.nullable(),
  decidedAt: isoDateTime.nullable(),
  linkedInstanceIds: z.array(uuid),
});
export type EvidenceVersionDto = z.infer<typeof EvidenceVersionDto>;

export const VerifyInput = z
  .object({
    decision: z.enum(['ACCEPTED', 'REJECTED']),
    reason: z.string().trim().min(3).max(1000).optional(),
    confirmedValidTo: isoDate.optional(),
  })
  .strict()
  .refine((v) => v.decision === 'ACCEPTED' || !!v.reason, {
    message: 'A reason is required to reject evidence',
    path: ['reason'],
  });

export const LinkInput = z
  .object({ requirementInstanceIds: z.array(uuid).min(1).max(50) })
  .strict();
export const LinkResponse = z.object({ linked: z.number().int() });
export const DownloadResponse = z.object({ url: z.string(), expiresAt: isoDateTime });

// ---- alerts -----------------------------------------------------------------

export const AlertDto = z.object({
  id: uuid,
  sourceType: z.string(),
  sourceId: uuid,
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  reasonCode: z.string(),
  reasonText: z.string(),
  ownerUserId: uuid.nullable(),
  state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
  snoozedUntil: isoDateTime.nullable(),
  raisedAt: isoDateTime,
  version,
});
export type AlertDto = z.infer<typeof AlertDto>;
export const SnoozeInput = z.object({ until: isoDateTime }).strict();
