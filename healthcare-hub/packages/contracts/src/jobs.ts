import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';
import { StaffRole } from './staff.js';

const version = z.number().int().min(1);
export const JobState = z.enum([
  'BOOKED',
  'ASSESSED',
  'ALLOCATED',
  'OFFERED',
  'ACKNOWLEDGED',
  'EN_ROUTE',
  'ARRIVED',
  'PATIENT_ON_BOARD',
  'AT_DESTINATION',
  'HANDOVER_COMPLETE',
  'COMPLETED',
  'CANCELLED',
  'REFUSED',
  'NO_ACCESS',
  'ABORTED',
  'REASSIGNED',
]);
export const Mobility = z.enum(['WALKING', 'WHEELCHAIR', 'STRETCHER', 'CARRY_CHAIR']);
const code = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z_]{2,30}$/));

/** Journey details with free text minimised (PRD 4.8): patient identity is a reference only. */
export const JobFields = z.strictObject({
  locationId: uuid,
  pickupFrom: isoDateTime,
  pickupTo: isoDateTime,
  appointmentAt: isoDateTime.optional(),
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
  pickupAddress: z.string().trim().min(3).max(300),
  destinationAddress: z.string().trim().min(3).max(300),
  accessNotes: z.string().trim().max(500).optional(),
  accessPlanReviewed: z.boolean().default(false),
  patientRef: z.string().regex(/^[A-Za-z0-9-]{2,30}$/, 'Use the booking reference, not a name'),
  mobility: Mobility,
  weightKg: z.number().int().min(1).max(500).optional(),
  stairs: z.boolean().default(false),
  escorts: z.number().int().min(0).max(4).default(0),
  infectionPrecautions: z.boolean().default(false),
  commsNeeds: z.string().trim().max(200).optional(),
  requiredEquipment: z.array(code).max(10).default([]),
  requiredSkills: z
    .array(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/))
    .max(10)
    .default([]),
  crewSize: z.number().int().min(1).max(4).default(2),
});
const windowOk = (j: {
  pickupFrom: string;
  pickupTo: string;
  plannedStart: string;
  plannedEnd: string;
}) =>
  new Date(j.pickupTo) > new Date(j.pickupFrom) &&
  new Date(j.plannedEnd) > new Date(j.plannedStart);
export const BookingCreate = z
  .strictObject({
    customer: z.string().trim().min(2).max(120),
    reference: z.string().trim().max(60).optional(),
    job: JobFields,
    patientContact: z
      .strictObject({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().max(30).optional(),
      })
      .optional(),
    recurrence: z
      .strictObject({
        freq: z.enum(['DAILY', 'WEEKLY']),
        interval: z.number().int().min(1).max(8).default(1),
        byWeekday: z.array(z.number().int().min(1).max(7)).max(7).optional(),
        until: isoDate,
      })
      .optional(),
  })
  .refine((b) => windowOk(b.job), 'Windows must end after they start');
export const JobPatch = JobFields.omit({ locationId: true })
  .partial()
  .extend({ timeShiftMinutes: z.number().int().min(-720).max(720).optional() })
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export const JobPatchQuery = z.object({ scope: z.enum(['this', 'following']).default('this') });

export const JobDto = z.object({
  id: uuid,
  code: z.string(),
  bookingId: uuid,
  seriesIndex: z.number().nullable(),
  detached: z.boolean(),
  locationId: uuid,
  journeyDate: isoDate,
  pickupFrom: isoDateTime,
  pickupTo: isoDateTime,
  appointmentAt: isoDateTime.nullable(),
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
  pickupAddress: z.string(),
  destinationAddress: z.string(),
  accessNotes: z.string().nullable(),
  accessPlanReviewed: z.boolean(),
  patientRef: z.string(),
  mobility: Mobility,
  weightKg: z.number().nullable(),
  stairs: z.boolean(),
  escorts: z.number(),
  infectionPrecautions: z.boolean(),
  commsNeeds: z.string().nullable(),
  requiredEquipment: z.array(z.string()),
  requiredSkills: z.array(z.string()),
  crewSize: z.number(),
  state: JobState,
  shiftId: uuid.nullable(),
  version,
});
export type JobDto = z.infer<typeof JobDto>;
export const JobDetailDto = JobDto.extend({
  patientContact: z.object({ name: z.string(), phone: z.string().nullable() }).nullable(),
  events: z.array(
    z.object({
      fromState: JobState.nullable(),
      toState: JobState,
      actorUserId: uuid,
      capturedAt: isoDateTime,
      receivedAt: isoDateTime,
      reason: z.string().nullable(),
    }),
  ),
});
export type JobDetailDto = z.infer<typeof JobDetailDto>;
export const BookingDto = z.object({
  id: uuid,
  customer: z.string(),
  reference: z.string().nullable(),
  jobs: z.array(JobDto),
});

// Shifts --------------------------------------------------------------------------
export const CrewInput = z.strictObject({
  staffId: uuid,
  role: StaffRole,
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
});
export const ShiftCreate = z
  .strictObject({
    locationId: uuid,
    vehicleId: uuid,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    crew: z.array(CrewInput).max(6).default([]),
  })
  .refine((s) => new Date(s.endsAt) > new Date(s.startsAt), 'The shift must end after it starts');
export const VehicleSwapInput = z.strictObject({
  vehicleId: uuid,
  reason: z.string().trim().min(3).max(300),
});
export const CrewEndInput = z.strictObject({ reason: z.string().trim().min(3).max(300) });
export const ShiftDto = z.object({
  id: uuid,
  locationId: uuid,
  vehicleId: uuid,
  vehicleCallsign: z.string(),
  vehicleStatus: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  state: z.enum(['PLANNED', 'STARTED', 'ENDED', 'CANCELLED']),
  crew: z.array(
    z.object({
      id: uuid,
      staffId: uuid,
      staffNo: z.string(),
      displayName: z.string(),
      role: StaffRole,
      startsAt: isoDateTime,
      endsAt: isoDateTime,
      active: z.boolean(),
    }),
  ),
  jobs: z.array(
    z.object({
      jobId: uuid,
      code: z.string(),
      state: JobState,
      startsAt: isoDateTime,
      endsAt: isoDateTime,
    }),
  ),
  changes: z.array(
    z.object({
      kind: z.string(),
      details: z.record(z.string(), z.unknown()),
      reason: z.string().nullable(),
      at: isoDateTime,
    }),
  ),
  version,
});
export type ShiftDto = z.infer<typeof ShiftDto>;
export const PlannerQuery = z.object({ date: isoDate, locationId: uuid.optional() });
export const PlannerDto = z.object({
  date: isoDate,
  shifts: z.array(ShiftDto),
  unallocated: z.array(JobDto),
});
export const ShiftsQuery = z.object({ date: isoDate.optional(), locationId: uuid.optional() });

// Validation, allocation, status ------------------------------------------------------
export const AllocationCheckDto = z.object({
  code: z.enum([
    'STAFF_CLEARANCE',
    'LICENCE',
    'COMPETENCE',
    'VEHICLE_ROADWORTHY',
    'VEHICLE_SUITABILITY',
    'EQUIPMENT',
    'TIME_CONFLICT',
    'SHIFT_GATE',
  ]),
  result: z.enum(['PASS', 'FAIL', 'PENDING']),
  reasonText: z.string(),
  overridable: z.boolean(),
  excepted: z.boolean(),
  details: z.array(z.string()),
});
export const ValidationDto = z.object({
  jobId: uuid,
  shiftId: uuid,
  allowed: z.boolean(),
  checks: z.array(AllocationCheckDto),
  blockers: z.array(z.string()),
  exceptable: z.array(z.string()),
  crew: z.array(z.object({ staffId: uuid, role: z.string(), state: z.string() })),
  window: z.object({ start: isoDateTime, end: isoDateTime }),
});
export type ValidationDto = z.infer<typeof ValidationDto>;
export const ValidateInput = z.strictObject({ shiftId: uuid });
export const AllocateInput = z.strictObject({ shiftId: uuid });
export const ExceptionInput = z.strictObject({
  jobId: uuid,
  shiftId: uuid,
  checkCode: z.enum([
    'STAFF_CLEARANCE',
    'LICENCE',
    'COMPETENCE',
    'VEHICLE_ROADWORTHY',
    'VEHICLE_SUITABILITY',
    'EQUIPMENT',
    'TIME_CONFLICT',
    'SHIFT_GATE',
  ]),
  reason: z.string().trim().min(10).max(1000),
  expiresAt: isoDateTime,
});
export const ExceptionDto = z.object({
  id: uuid,
  jobId: uuid,
  checkCode: z.string(),
  approverId: uuid,
  reason: z.string(),
  expiresAt: isoDateTime,
});
export const StatusInput = z.strictObject({
  state: JobState,
  capturedAt: isoDateTime,
  reason: z.string().trim().max(500).optional(),
  clientSubmissionId: uuid,
});
export const ShiftGateDto = z.object({
  shiftId: uuid,
  canStart: z.boolean(),
  checks: z.array(
    z.object({
      code: z.string(),
      result: z.enum(['PASS', 'FAIL', 'PENDING']),
      reasonText: z.string(),
    }),
  ),
  state: z.enum(['PLANNED', 'STARTED', 'ENDED', 'CANCELLED']),
});
