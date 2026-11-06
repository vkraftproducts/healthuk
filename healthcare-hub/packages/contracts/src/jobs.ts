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
export const Mobility = z.enum([
  'WALKING',
  'WHEELCHAIR',
  'OWN_WHEELCHAIR',
  'STRETCHER',
  'BARIATRIC',
  'CARRY_CHAIR',
]);
/** Mobility values that need a wheelchair space, a stretcher, or a weight check. */
export const WHEELCHAIR_MOBILITY: readonly string[] = ['WHEELCHAIR', 'OWN_WHEELCHAIR'];
export const STRETCHER_MOBILITY: readonly string[] = ['STRETCHER', 'BARIATRIC'];
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
  /** E1: the booking reference, never a patient name (letters, numbers and hyphens only). */
  patientRef: z.string().regex(/^[A-Za-z0-9-]{2,30}$/, 'Use the booking reference, not a name'),
  /** E1: an emergency job driven under blue lights. */
  blueLights: z.boolean().default(false),
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
export const PICKUP_WINDOW_MESSAGE = 'The pickup window must end after it starts';
export const JobContractType = z.enum(['NHS', 'PRIVATE', 'INSURER']);
const legTimes = z.strictObject({
  pickupFrom: isoDateTime,
  pickupTo: isoDateTime,
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
});
export const BookingCreate = z
  .strictObject({
    customer: z.string().trim().min(2).max(120),
    reference: z.string().trim().max(60).optional(),
    /** E1: who pays; NHS work records the eligibility decision and who assessed it. */
    contractType: JobContractType.optional(),
    nhsEligibility: z
      .strictObject({
        met: z.boolean(),
        criteria: z.string().trim().min(3).max(500),
        assessedBy: z.string().trim().min(2).max(120),
      })
      .optional(),
    /** E1: a return journey becomes its own job, addresses swapped. */
    returnJourney: legTimes.optional(),
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
  .refine((b) => new Date(b.job.pickupTo) > new Date(b.job.pickupFrom), {
    message: PICKUP_WINDOW_MESSAGE,
    path: ['job', 'pickupTo'],
  })
  .refine((b) => windowOk(b.job), 'Windows must end after they start')
  .refine((b) => !b.returnJourney || windowOk(b.returnJourney), {
    message: 'The return journey windows must end after they start',
    path: ['returnJourney'],
  })
  .refine(
    (b) => !b.returnJourney || new Date(b.returnJourney.plannedStart) >= new Date(b.job.plannedEnd),
    {
      message: 'The return journey must start after the outward one ends',
      path: ['returnJourney'],
    },
  )
  .refine((b) => b.contractType !== 'NHS' || !!b.nhsEligibility, {
    message: 'NHS work needs the eligibility criteria and who assessed them',
    path: ['nhsEligibility'],
  })
  .refine((b) => !STRETCHER_MOBILITY.includes(b.job.mobility) || !!b.job.weightKg, {
    message: 'Stretcher and bariatric journeys need the patient weight',
    path: ['job', 'weightKg'],
  })
  .refine((b) => !b.recurrence?.byWeekday || b.recurrence.freq === 'WEEKLY', {
    message: 'Choose weekdays only for a weekly repeat',
    path: ['recurrence', 'byWeekday'],
  });
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
  blueLights: z.boolean().optional(),
  /** E1: set on the return leg of a journey. */
  returnOfJobId: uuid.nullable().optional(),
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
      /** E4: who made each step, by name. */
      actorName: z.string().nullable().optional(),
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
  contractType: JobContractType.nullable().optional(),
  jobs: z.array(JobDto),
  /** E1: plain warnings that do not stop the booking (e.g. weight above every vehicle). */
  warnings: z.array(z.string()).optional(),
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
/** E2: swap one crew member for another for the rest of the assignment. */
export const CrewSwapInput = z.strictObject({
  staffId: uuid,
  reason: z.string().trim().min(3).max(300),
});
/** E2: readiness for a person as they are picked for a shift role. */
export const CrewReadinessQuery = z
  .object({
    staffId: uuid,
    role: StaffRole,
    from: isoDateTime,
    to: isoDateTime,
    vehicleId: uuid.optional(),
  })
  .refine((q) => new Date(q.to) > new Date(q.from), 'to must be after from');
export const CrewReadinessDto = z.object({
  staffId: uuid,
  state: z.enum(['READY', 'BLOCKED', 'RESTRICTED']),
  checks: z.array(
    z.object({ code: z.string(), result: z.string(), reasonText: z.string(), group: z.string() }),
  ),
});
/** Task 26: cancel a planned shift; its jobs go back for reallocation. */
export const ShiftCancelInput = z.strictObject({ reason: z.string().trim().min(3).max(300) });
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
  /** E3: how to fix a failing check, and the screen that does it. */
  fix: z
    .object({
      text: z.string(),
      action: z.enum(['SHIFT_ACTIONS', 'STAFF', 'VEHICLE', 'EXCEPTION']),
    })
    .nullable()
    .optional(),
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
/** A dispatcher asks; a different person with allocation.exception.approve decides (finding 69). */
export const ExceptionRequestCreate = ExceptionInput;
export const ExceptionRequestDecision = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => d.decision !== 'REJECTED' || (d.note ?? '').length >= 3,
    'Say why the exception is refused',
  );
export const ExceptionRequestQuery = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED']).optional(),
  jobId: uuid.optional(),
});
export const ExceptionRequestDto = z.object({
  id: uuid,
  jobId: uuid,
  jobCode: z.string(),
  shiftId: uuid,
  vehicleCallsign: z.string().nullable(),
  checkCode: z.string(),
  reason: z.string(),
  expiresAt: isoDateTime,
  requestedBy: uuid,
  requestedByName: z.string().nullable(),
  requestedAt: isoDateTime,
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED']),
  decidedBy: uuid.nullable(),
  decidedByName: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  /** The allocation exception created on approval; null until approved and when rejected. */
  exceptionId: uuid.nullable(),
});
export type ExceptionRequestDto = z.infer<typeof ExceptionRequestDto>;
export const StatusInput = z.strictObject({
  state: JobState,
  capturedAt: isoDateTime,
  reason: z.string().trim().max(500).optional(),
  clientSubmissionId: uuid,
});
/** E5: move a job to another shift; E3 runs again and the old allocation ends with the reason. */
export const ReassignInput = z.strictObject({
  shiftId: uuid,
  reason: z.string().trim().min(3).max(500),
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
