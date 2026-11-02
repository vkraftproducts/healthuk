import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';
import { JobState, Mobility } from './jobs.js';
import { StaffRole } from './staff.js';

/** Crew app (APP-01, APP-02, MOBILE_APP.md): what the person on the vehicle needs, nothing more. */

const GateCheck = z.object({
  code: z.string(),
  result: z.enum(['PASS', 'FAIL', 'PENDING']),
  reasonText: z.string(),
});
const GateCard = z.object({
  code: z.enum(['DRIVING_CLEARANCE', 'VDI', 'CLEANING']),
  label: z.string(),
  state: z.enum(['APPROVED', 'COMPLETE', 'REQUIRED', 'BLOCKED']),
  reasonText: z.string(),
});

export const CrewJobSummary = z.object({
  id: uuid,
  code: z.string(),
  state: JobState,
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
  pickupFrom: isoDateTime,
  pickupTo: isoDateTime,
  mobility: Mobility,
  /** States this person may move the job to next (large single-tap buttons). */
  nextStates: z.array(JobState),
});
export type CrewJobSummary = z.infer<typeof CrewJobSummary>;

export const CrewShiftDto = z.object({
  id: uuid,
  state: z.enum(['PLANNED', 'STARTED', 'ENDED', 'CANCELLED']),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  myRole: StaffRole,
  vehicle: z.object({
    id: uuid,
    callsign: z.string(),
    registration: z.string(),
    type: z.string(),
    status: z.string(),
    statusReason: z.string().nullable(),
  }),
  crew: z.array(z.object({ displayName: z.string(), role: StaffRole, me: z.boolean() })),
  gate: z.object({
    canStart: z.boolean(),
    checks: z.array(GateCheck),
    cards: z.array(GateCard),
  }),
  vdiTemplate: z
    .object({
      id: uuid,
      version: z.number(),
      items: z.array(z.object({ code: z.string(), label: z.string(), critical: z.boolean() })),
    })
    .nullable(),
  jobs: z.array(CrewJobSummary),
});
export type CrewShiftDto = z.infer<typeof CrewShiftDto>;

export const CrewTodayDto = z.object({
  serverTime: isoDateTime,
  /** When the server last confirmed eligibility; the app allows an offline start only within 30 minutes. */
  eligibilityCheckedAt: isoDateTime,
  /** Cached data must be discarded after this (end of shift + 12 hours). */
  cacheUntil: isoDateTime,
  staff: z.object({ staffNo: z.string(), displayName: z.string() }).nullable(),
  shift: CrewShiftDto.nullable(),
  upcoming: z.array(
    z.object({ id: uuid, startsAt: isoDateTime, endsAt: isoDateTime, vehicleCallsign: z.string() }),
  ),
  policiesPending: z.number(),
});
export type CrewTodayDto = z.infer<typeof CrewTodayDto>;

export const CrewJobDto = CrewJobSummary.extend({
  shiftId: uuid,
  pickupAddress: z.string(),
  destinationAddress: z.string(),
  appointmentAt: isoDateTime.nullable(),
  accessNotes: z.string().nullable(),
  accessPlanReviewed: z.boolean(),
  escorts: z.number(),
  stairs: z.boolean(),
  infectionPrecautions: z.boolean(),
  commsNeeds: z.string().nullable(),
  requiredEquipment: z.array(z.string()),
  crewSize: z.number(),
  /** Only while this person is crewing the shift (database-enforced); null afterwards. */
  patientContact: z.object({ name: z.string(), phone: z.string().nullable() }).nullable(),
  events: z.array(
    z.object({ toState: JobState, capturedAt: isoDateTime, receivedAt: isoDateTime }),
  ),
  version: z.number(),
});
export type CrewJobDto = z.infer<typeof CrewJobDto>;

// ---- offline sync ------------------------------------------------------------------------
export const SyncItemType = z.enum([
  'VDI',
  'CLEANING',
  'JOB_STATUS',
  'DEFECT',
  'EXPENSE',
  'POLICY_ACK',
  /** Shift started on the device (offline only within 30 minutes of an eligibility check). */
  'SHIFT_START',
]);
export type SyncItemType = z.infer<typeof SyncItemType>;
export const SyncItem = z.strictObject({
  clientSubmissionId: uuid,
  type: SyncItemType,
  /** Job id (JOB_STATUS), policy version id (POLICY_ACK) or shift id (SHIFT_START). */
  ref: uuid.optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type SyncItem = z.infer<typeof SyncItem>;
export const SyncInput = z.strictObject({ items: z.array(SyncItem).min(1).max(50) });
export const SyncItemResult = z.object({
  clientSubmissionId: uuid,
  type: SyncItemType,
  outcome: z.enum(['ACCEPTED', 'DUPLICATE', 'CONFLICT', 'REJECTED', 'RETRY']),
  status: z.number(),
  code: z.string().nullable(),
  detail: z.string().nullable(),
  entityId: uuid.nullable(),
  /** On a conflict: the server's current state, for the reconciliation screen. */
  serverState: z.record(z.string(), z.unknown()).nullable(),
});
export type SyncItemResult = z.infer<typeof SyncItemResult>;
export const SyncResultDto = z.object({ results: z.array(SyncItemResult) });
export type SyncResultDto = z.infer<typeof SyncResultDto>;

// ---- policies ------------------------------------------------------------------------------
export const CrewPolicyDto = z.object({
  documentId: uuid,
  versionId: uuid,
  code: z.string(),
  title: z.string(),
  category: z.string(),
  version: z.number(),
  summary: z.string(),
  /** Critical instructions need an explicit "I have read and understood" confirmation. */
  critical: z.boolean(),
  publishedAt: isoDateTime.nullable(),
  documentEvidenceVersionId: uuid.nullable(),
});
export type CrewPolicyDto = z.infer<typeof CrewPolicyDto>;
export const CrewAckInput = z.strictObject({
  confirmCritical: z.boolean().optional(),
  device: z.string().trim().max(100).optional(),
});

// ---- profile -------------------------------------------------------------------------------
export const CrewProfileDto = z.object({
  staffNo: z.string(),
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  roles: z.array(z.string()),
  overallStatus: z.string(),
  requirements: z.array(
    z.object({
      id: uuid,
      title: z.string(),
      status: z.string(),
      reasonText: z.string(),
      dueDate: z.string().nullable(),
      expiryDate: z.string().nullable(),
      required: z.boolean(),
    }),
  ),
  documents: z.array(
    z.object({
      id: uuid,
      title: z.string(),
      state: z.string(),
      uploadedAt: isoDateTime.nullable(),
    }),
  ),
  /** Supervision and appraisal items that need action. */
  tasks: z.array(
    z.object({ id: uuid, title: z.string(), status: z.string(), reasonText: z.string() }),
  ),
});
export type CrewProfileDto = z.infer<typeof CrewProfileDto>;

// ---- devices / push --------------------------------------------------------------------------
export const DeviceRegisterInput = z.strictObject({
  deviceId: z.string().trim().min(8).max(100),
  platform: z.enum(['IOS', 'ANDROID']),
  pushToken: z.string().trim().min(10).max(300).nullable(),
  appVersion: z.string().trim().max(40).optional(),
});
export const DeviceDto = z.object({
  id: uuid,
  deviceId: z.string(),
  platform: z.enum(['IOS', 'ANDROID']),
  pushEnabled: z.boolean(),
  appVersion: z.string().nullable(),
  lastSeenAt: isoDateTime.nullable(),
  revokedAt: isoDateTime.nullable(),
});
export type DeviceDto = z.infer<typeof DeviceDto>;
