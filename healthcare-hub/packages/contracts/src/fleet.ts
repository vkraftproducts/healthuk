import { z } from 'zod';
import { isoDate, isoDateTime, page, uuid } from './common.js';
import { CheckDto } from './staff.js';

const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(500);

export const VehicleType = z.enum([
  'AMBULANCE',
  'HIGH_DEPENDENCY',
  'PTS_VEHICLE',
  'WAV',
  'CAR',
  'MINIBUS',
  'OTHER',
]);
export const VehicleStatus = z.enum(['AVAILABLE', 'BLOCKED', 'QUARANTINED', 'OFF_ROAD']);
export const LicenceCategory = z.enum(['B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE']);
/** BS EN 1789 ambulance types. */
export const En1789Type = z.enum(['A1', 'A2', 'B', 'C']);
/**
 * D1: UK registration formats, stored without spaces in upper case. Current (AB12CDE), prefix
 * (A123BCD), suffix (ABC123D) and dateless (1ABC, ABC1234, 1234AB and similar).
 */
export const UK_REGISTRATION = new RegExp(
  `^(?:${[
    '[A-Z]{2}\\d{2}[A-Z]{3}',
    '[A-Z]\\d{1,3}[A-Z]{3}',
    '[A-Z]{3}\\d{1,3}[A-Z]',
    '[A-Z]{1,3}\\d{1,4}',
    '\\d{1,4}[A-Z]{1,3}',
  ].join('|')})$`,
);
export const UK_REGISTRATION_MESSAGE = 'Registration must be a UK format such as SY21 ABC';
const registration = z
  .string()
  .trim()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(UK_REGISTRATION, UK_REGISTRATION_MESSAGE));
const callsign = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .regex(
        /^[A-Z0-9][A-Z0-9-]{1,15}$/,
        'Use 2 to 16 letters, numbers or hyphens, for example AMB-03',
      ),
  );
const vin = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/, 'A VIN has 17 letters and numbers (no I, O or Q)'),
  );
/** B is up to 3,500 kg; C1 up to 7,500 kg (finding 89). */
const grossWeightKg = z.number().int().min(500).max(44_000);
export const VehicleOwnership = z.enum(['OWNED', 'LEASED', 'HIRED']);

const shortText = (max: number) => z.string().trim().min(1).max(max);
const year = z.number().int().min(1980).max(2100);
const bariatricLimitKg = z.number().int().min(50).max(1000);
/** D1 register fields beyond identity and capacity. */
const registerFields = {
  make: shortText(60),
  model: shortText(60),
  year,
  firstRegisteredOn: isoDate,
  en1789Type: En1789Type,
  conversionCompany: shortText(120),
  conversionCertificateRef: shortText(80),
  ownershipEndsOn: isoDate,
  /** Services (from Settings) this vehicle can run. */
  serviceIds: z.array(uuid).max(30),
  blueLightAuthorised: z.boolean(),
  bariatricLimitKg,
};
const leaseEndMessage = 'Give the lease or hire end date';
export const VehicleCreate = z
  .strictObject({
    registration,
    callsign,
    vin: vin.optional(),
    type: VehicleType,
    ownership: VehicleOwnership.default('OWNED'),
    baseLocationId: uuid,
    seats: z.number().int().min(0).max(60).default(0),
    wheelchairCapacity: z.number().int().min(0).max(10).default(0),
    stretcher: z.boolean().default(false),
    permittedLoads: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    licenceCategory: LicenceCategory.default('B'),
    grossWeightKg: grossWeightKg.optional(),
    make: registerFields.make.optional(),
    model: registerFields.model.optional(),
    year: year.optional(),
    firstRegisteredOn: isoDate.optional(),
    en1789Type: En1789Type.optional(),
    conversionCompany: registerFields.conversionCompany.optional(),
    conversionCertificateRef: registerFields.conversionCertificateRef.optional(),
    ownershipEndsOn: isoDate.optional(),
    serviceIds: registerFields.serviceIds.default([]),
    blueLightAuthorised: z.boolean().default(false),
    bariatricLimitKg: bariatricLimitKg.optional(),
  })
  .refine((v) => v.ownership === 'OWNED' || !!v.ownershipEndsOn, {
    message: leaseEndMessage,
    path: ['ownershipEndsOn'],
  });
export const VehiclePatch = z
  .strictObject({
    vin: vin.nullable(),
    ownership: VehicleOwnership,
    seats: z.number().int().min(0).max(60),
    wheelchairCapacity: z.number().int().min(0).max(10),
    stretcher: z.boolean(),
    permittedLoads: z.array(z.string().trim().min(1).max(60)).max(20),
    licenceCategory: LicenceCategory,
    grossWeightKg: grossWeightKg.nullable(),
    make: registerFields.make.nullable(),
    model: registerFields.model.nullable(),
    year: year.nullable(),
    firstRegisteredOn: isoDate.nullable(),
    en1789Type: En1789Type.nullable(),
    conversionCompany: registerFields.conversionCompany.nullable(),
    conversionCertificateRef: registerFields.conversionCertificateRef.nullable(),
    ownershipEndsOn: isoDate.nullable(),
    serviceIds: registerFields.serviceIds,
    blueLightAuthorised: z.boolean(),
    bariatricLimitKg: bariatricLimitKg.nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change')
  .refine((o) => !o.ownership || o.ownership === 'OWNED' || o.ownershipEndsOn !== null, {
    message: leaseEndMessage,
    path: ['ownershipEndsOn'],
  });

export const VehicleDto = z.object({
  id: uuid,
  registration: z.string(),
  callsign: z.string(),
  vin: z.string().nullable(),
  type: VehicleType,
  ownership: z.enum(['OWNED', 'LEASED', 'HIRED']),
  baseLocationId: uuid,
  seats: z.number(),
  wheelchairCapacity: z.number(),
  stretcher: z.boolean(),
  permittedLoads: z.array(z.string()),
  licenceCategory: LicenceCategory,
  grossWeightKg: z.number().nullable(),
  status: VehicleStatus,
  statusReason: z.string().nullable(),
  offRoad: z.boolean(),
  quarantined: z.boolean(),
  currentOdometer: z.number().nullable(),
  /** The most recent recorded reading; null when none has been recorded (finding 41). */
  latestReading: z.object({ reading: z.number(), readOn: isoDate }).nullable(),
  openDefects: z.number(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  year: z.number().nullable(),
  firstRegisteredOn: isoDate.nullable(),
  en1789Type: En1789Type.nullable(),
  conversionCompany: z.string().nullable(),
  conversionCertificateRef: z.string().nullable(),
  ownershipEndsOn: isoDate.nullable(),
  serviceIds: z.array(uuid),
  blueLightAuthorised: z.boolean(),
  bariatricLimitKg: z.number().nullable(),
  /** D1: the licence the gross weight needs, in words, e.g. "Needs C1". */
  licenceNeeded: z.string(),
  expectedReturnOn: isoDate.nullable(),
  version,
});
export type VehicleDto = z.infer<typeof VehicleDto>;
export const VehiclePage = page(VehicleDto);

export const MaintenanceDto = z.object({
  id: uuid,
  title: z.string(),
  intervalDays: z.number().nullable(),
  intervalMiles: z.number().nullable(),
  lastDoneOn: isoDate.nullable(),
  lastDoneOdometer: z.number().nullable(),
  dueDate: isoDate.nullable(),
  dueOdometer: z.number().nullable(),
  state: z.enum(['OK', 'DUE_SOON', 'OVERDUE']),
  by: z.enum(['DATE', 'MILEAGE']).nullable(),
  text: z.string(),
  /** D2: which limit is expected first at the recent mileage rate. */
  firstLimit: z.enum(['DATE', 'MILEAGE']).nullable(),
  firstLimitText: z.string(),
  mileageDueOn: isoDate.nullable(),
  version,
});
export const VehicleDetailDto = VehicleDto.extend({
  maintenance: z.array(MaintenanceDto),
  readings: z.array(
    z.object({
      id: uuid,
      reading: z.number(),
      readOn: isoDate,
      source: z.string(),
      flags: z.array(z.string()),
      /** D2: a flagged reading needs the Fleet lead to confirm or correct it. */
      review: z
        .object({
          decision: z.enum(['CONFIRMED', 'CORRECTED']),
          correctedReading: z.number().nullable(),
          reason: z.string(),
          reviewedByName: z.string().nullable(),
          at: isoDateTime,
        })
        .nullable(),
    }),
  ),
  locations: z.array(
    z.object({
      locationId: uuid,
      reason: z.string(),
      at: isoDateTime,
      effectiveOn: isoDate.nullable(),
    }),
  ),
  capability: z.object({
    stretcher: z.boolean(),
    wheelchairCapacity: z.number(),
    clinicalKit: z.boolean(),
    lost: z.array(z.string()),
  }),
  /** D1 header: Available, Blocked with the reason, Off road or Quarantined. */
  headline: z.object({
    status: z.enum(['AVAILABLE', 'BLOCKED', 'OFF_ROAD', 'QUARANTINED']),
    reason: z.string().nullable(),
  }),
});
export type VehicleDetailDto = z.infer<typeof VehicleDetailDto>;

export const OdometerInput = z.strictObject({
  reading: z.number().int().min(0).max(2_000_000),
  readOn: isoDate,
});
export const OdometerDto = z.object({
  id: uuid,
  reading: z.number(),
  readOn: isoDate,
  flags: z.array(z.string()),
});
export const MaintenancePlanInput = z
  .strictObject({
    title: z.string().trim().min(2).max(120),
    intervalDays: z.number().int().min(1).max(1100).optional(),
    intervalMiles: z.number().int().min(100).max(100_000).optional(),
    lastDoneOn: isoDate.optional(),
    lastDoneOdometer: z.number().int().min(0).optional(),
  })
  .refine(
    (p) => p.intervalDays || p.intervalMiles,
    'Give a date interval, a mileage interval, or both',
  );
export const MaintenanceDoneInput = z.strictObject({
  doneOn: isoDate,
  odometer: z.number().int().min(0).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** D2: who did the work, and the job sheet. */
  garage: z.string().trim().min(2).max(120).optional(),
  jobSheetEvidenceItemId: uuid.optional(),
});
/** D2: the Fleet lead confirms a flagged reading as right, or corrects it, with a reason. */
export const OdometerReviewInput = z
  .strictObject({
    decision: z.enum(['CONFIRMED', 'CORRECTED']),
    correctedReading: z.number().int().min(0).max(2_000_000).optional(),
    reason,
  })
  .refine((r) => (r.decision === 'CORRECTED') === (r.correctedReading !== undefined), {
    message: 'Give the corrected reading when correcting, and only then',
    path: ['correctedReading'],
  });
/** D5: a move takes effect on a date (today or earlier; defaults to today). */
export const MoveInput = z.strictObject({
  locationId: uuid,
  reason,
  effectiveOn: isoDate.optional(),
});
/** D5: why a vehicle is off the road. */
export const OffRoadReason = z.enum([
  'ACCIDENT',
  'AWAITING_PARTS',
  'REPAIR',
  'SERVICE',
  'SOLD',
  'OTHER',
]);
export const FlagInput = z.strictObject({
  on: z.boolean(),
  reason,
  reasonCode: OffRoadReason.optional(),
  expectedReturnOn: isoDate.optional(),
});
/** Task 26: off-road and quarantine history (append-only). */
export const VehicleStatusChangeDto = z.object({
  id: uuid,
  flag: z.enum(['OFF_ROAD', 'QUARANTINE']),
  on: z.boolean(),
  reason: z.string(),
  reasonCode: OffRoadReason.nullable(),
  expectedReturnOn: isoDate.nullable(),
  jobsReleased: z.number().int(),
  changedBy: uuid,
  changedByName: z.string().nullable(),
  changedAt: isoDateTime,
});
export type VehicleStatusChangeDto = z.infer<typeof VehicleStatusChangeDto>;

export const NeedsQuery = z
  .object({
    from: isoDateTime,
    to: isoDateTime,
    stretcher: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    wheelchairs: z.coerce.number().int().min(0).max(10).optional(),
    seats: z.coerce.number().int().min(0).max(60).optional(),
  })
  .refine((q) => new Date(q.to) > new Date(q.from), 'to must be after from');
export const AssetReadinessDto = z.object({
  state: z.enum(['READY', 'BLOCKED', 'RESTRICTED']),
  checks: z.array(CheckDto),
});
export const VehicleReadinessDto = AssetReadinessDto.extend({
  vehicleId: uuid,
  capability: VehicleDetailDto.shape.capability,
});

// Equipment -------------------------------------------------------------------
const category = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase().replace(/[\s-]+/g, '_'))
  .pipe(z.string().regex(/^[A-Z_]{2,30}$/));
export const EquipmentCreate = z.strictObject({
  assetTag: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/)),
  category,
  model: z.string().trim().max(120).optional(),
  serial: z.string().trim().max(60).optional(),
  manufacturer: z.string().trim().max(120).optional(),
  swlKg: z.number().positive().max(100_000).optional(),
  vehicleId: uuid.optional(),
  locationId: uuid.optional(),
  capability: z.enum(['STRETCHER', 'WHEELCHAIR', 'CLINICAL', 'BARIATRIC']).optional(),
  /** D3: instructions for use. */
  instructions: z.string().trim().max(2000).optional(),
});
/** D3: equipment categories offered by the register (free text still allowed). */
export const EQUIPMENT_CATEGORIES = [
  'STRETCHER',
  'CARRY_CHAIR',
  'WHEELCHAIR_RESTRAINT',
  'TAIL_LIFT',
  'RAMP',
  'BARIATRIC_STRETCHER',
  'DEFIBRILLATOR',
  'SUCTION',
  'OXYGEN',
  'MONITOR',
  'OTHER',
] as const;
export const EquipmentPatch = z
  .strictObject({
    vehicleId: uuid.nullable(),
    locationId: uuid.nullable(),
    model: z.string().trim().max(120).nullable(),
    serial: z.string().trim().max(60).nullable(),
    manufacturer: z.string().trim().max(120).nullable(),
    swlKg: z.number().positive().max(100_000).nullable(),
    instructions: z.string().trim().max(2000).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
/** D3: release from quarantine by someone other than the person who quarantined it. */
export const EquipmentReleaseInput = z.strictObject({ reason, evidenceItemId: uuid });
export const RegimeInput = z.strictObject({
  regime: z.enum(['LOLER_THOROUGH', 'SERVICE', 'CALIBRATION', 'PRE_USE', 'PAT']),
  templateId: uuid,
  source: z.string().trim().max(300).optional(),
});
export const EquipmentDto = z.object({
  id: uuid,
  assetTag: z.string(),
  category: z.string(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  manufacturer: z.string().nullable(),
  swlKg: z.number().nullable(),
  vehicleId: uuid.nullable(),
  locationId: uuid.nullable(),
  capability: z.string().nullable(),
  status: z.enum(['AVAILABLE', 'QUARANTINED', 'RETIRED']),
  quarantineReason: z.string().nullable(),
  instructions: z.string().nullable(),
  /** Who quarantined it: they cannot release it themselves (D3). */
  quarantinedBy: uuid.nullable(),
  regimes: z.array(
    z.object({
      regime: z.string(),
      requirementInstanceId: uuid,
      status: z.string(),
      reasonText: z.string(),
    }),
  ),
  version,
});
export type EquipmentDto = z.infer<typeof EquipmentDto>;

// VDI and cleaning -------------------------------------------------------------
export const VdiItemDef = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]{2,40}$/),
  label: z.string().trim().min(2).max(120),
  /** A failed critical item raises a CRITICAL stop-use defect automatically. */
  critical: z.boolean().default(false),
});
export const VdiTemplateInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  vehicleType: VehicleType.optional(),
  items: z
    .array(VdiItemDef)
    .min(1)
    .max(100)
    .refine((xs) => new Set(xs.map((x) => x.code)).size === xs.length, 'Item codes must be unique'),
});
export const VdiTemplateDto = z.object({
  id: uuid,
  name: z.string(),
  version: z.number(),
  vehicleType: VehicleType.nullable(),
  items: z.array(z.object({ code: z.string(), label: z.string(), critical: z.boolean() })),
  active: z.boolean(),
  /** D6: drafted by the Fleet lead, published by a second person; publishing retires the old. */
  status: z.enum(['DRAFT', 'PUBLISHED', 'RETIRED']),
  createdBy: uuid.nullable(),
  createdByName: z.string().nullable(),
  publishedBy: uuid.nullable(),
  publishedByName: z.string().nullable(),
  publishedAt: isoDateTime.nullable(),
});
export const VdiTemplateQuery = z.object({
  /** Drafts and retired versions as well; for people who manage vehicles. */
  all: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export const VdiSubmit = z.strictObject({
  clientSubmissionId: uuid,
  vehicleId: uuid,
  templateId: uuid,
  shiftId: uuid.optional(),
  odometer: z.number().int().min(0).max(2_000_000),
  capturedAt: isoDateTime,
  notes: z.string().trim().max(1000).optional(),
  results: z
    .array(
      z.strictObject({
        code: z.string(),
        result: z.enum(['PASS', 'FAIL', 'NA']),
        reason: z.string().trim().max(500).optional(),
        photoEvidenceItemId: uuid.optional(),
      }),
    )
    .min(1)
    .max(100),
});
export const VdiDto = z.object({
  id: uuid,
  vehicleId: uuid,
  templateId: uuid,
  checkerUserId: uuid,
  odometer: z.number(),
  outcome: z.enum(['PASS', 'FAIL']),
  capturedAt: isoDateTime,
  receivedAt: isoDateTime,
  results: z.array(
    z.object({
      code: z.string(),
      critical: z.boolean(),
      result: z.enum(['PASS', 'FAIL', 'NA']),
      reason: z.string().nullable(),
      amended: z.boolean(),
    }),
  ),
  amendments: z.array(
    z.object({
      code: z.string(),
      newResult: z.string(),
      reason: z.string(),
      amendedBy: uuid,
      at: isoDateTime,
    }),
  ),
  defectIds: z.array(uuid),
  odometerFlags: z.array(z.string()),
  duplicate: z.boolean(),
});
export type VdiDto = z.infer<typeof VdiDto>;
export const VdiAmendInput = z.strictObject({
  code: z.string(),
  newResult: z.enum(['PASS', 'FAIL', 'NA']),
  reason,
});
export const CleaningInput = z.strictObject({
  clientSubmissionId: uuid,
  vehicleId: uuid,
  shiftId: uuid.optional(),
  type: z.enum(['PRE_SHIFT', 'BETWEEN_PATIENT', 'ENHANCED']),
  capturedAt: isoDateTime,
  notes: z.string().trim().max(500).optional(),
});
export const CleaningDto = z.object({
  id: uuid,
  vehicleId: uuid,
  type: z.enum(['PRE_SHIFT', 'BETWEEN_PATIENT', 'ENHANCED']),
  cleanedBy: uuid,
  capturedAt: isoDateTime,
  receivedAt: isoDateTime,
  duplicate: z.boolean(),
});

// Defects ------------------------------------------------------------------------
export const DefectCreate = z
  .strictObject({
    vehicleId: uuid.optional(),
    assetId: uuid.optional(),
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
    stopUse: z.boolean().default(false),
    description: z.string().trim().min(3).max(1000),
    discoveredAt: isoDateTime.optional(),
    /** Set by the crew app's offline outbox: a retried submission returns the original defect. */
    clientSubmissionId: uuid.optional(),
    photoEvidenceItemIds: z.array(uuid).max(6).default([]),
  })
  .refine((d) => !!d.vehicleId !== !!d.assetId, 'Give either a vehicle or an asset');
export const DefectPatch = z
  .strictObject({
    status: z.enum(['REPAIRING', 'REPAIRED']),
    severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
    stopUse: z.literal(true),
    repairDeadline: isoDate,
    repairNotes: z.string().trim().max(2000),
    /** D4: the repair record can carry the garage's job sheet. */
    repairJobSheetEvidenceItemId: uuid,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export const ReleaseInput = z.strictObject({ reason, evidenceItemId: uuid.optional() });
/** The person releasing found the repair not good enough: it goes back for repair (FLT-06). */
export const DefectReopen = z.strictObject({ reason });
export const DefectDto = z.object({
  id: uuid,
  vehicleId: uuid.nullable(),
  assetId: uuid.nullable(),
  /** Callsign or asset tag, so lists can say what the defect is on. */
  subjectLabel: z.string().nullable(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  stopUse: z.boolean(),
  description: z.string(),
  reportedBy: uuid,
  reportedByName: z.string().nullable(),
  discoveredAt: isoDateTime,
  sourceVdiId: uuid.nullable(),
  status: z.enum(['OPEN', 'REPAIRING', 'REPAIRED', 'RELEASED']),
  classifiedBy: uuid.nullable(),
  classifiedByName: z.string().nullable(),
  repairDeadline: isoDate.nullable(),
  /** Deadline position in London time; DONE once the repair is signed off. */
  repairDue: z.enum(['NONE', 'DUE', 'DUE_SOON', 'DUE_TODAY', 'OVERDUE', 'DONE']),
  repairNotes: z.string().nullable(),
  repairedAt: isoDateTime.nullable(),
  repairedBy: uuid.nullable(),
  repairedByName: z.string().nullable(),
  release: z
    .object({
      releasedBy: uuid,
      releasedByName: z.string().nullable(),
      reason: z.string(),
      evidenceItemId: uuid.nullable(),
      at: isoDateTime,
    })
    .nullable(),
  /** Jobs released for reassignment because of a stop-use defect (FLT-06). */
  affectedAllocationIds: z.array(uuid),
  /** D4: the same jobs by code, for the person reporting (never patient details). */
  affectedJobCodes: z.array(z.string()).optional(),
  repairJobSheetEvidenceItemId: uuid.nullable().optional(),
  photoEvidenceItemIds: z.array(uuid),
  /** True when this response replays an earlier submission with the same clientSubmissionId. */
  replayed: z.boolean().optional(),
  version,
});
export type DefectDto = z.infer<typeof DefectDto>;
export const DefectListQuery = z.object({
  status: z.enum(['OPEN', 'REPAIRING', 'REPAIRED', 'RELEASED', 'ACTIVE']).default('ACTIVE'),
  vehicleId: uuid.optional(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']).optional(),
});

// Fuel and expenses ---------------------------------------------------------------
export const ExpenseCreate = z
  .strictObject({
    vehicleId: uuid,
    spentOn: isoDate,
    category: z.enum(['FUEL', 'CHARGING', 'PARKING', 'TOLL', 'WASH', 'OTHER']),
    odometer: z.number().int().min(0).optional(),
    quantity: z.number().positive().max(10_000).optional(),
    unit: z.enum(['LITRES', 'KWH']).optional(),
    amountPence: z.number().int().min(1).max(10_000_000),
    supplier: z.string().trim().max(120).optional(),
    receiptEvidenceItemId: uuid.optional(),
    clientSubmissionId: uuid.optional(),
  })
  .refine(
    (e) => (e.quantity === undefined) === (e.unit === undefined),
    'Give quantity and unit together',
  )
  .refine((e) => e.category !== 'FUEL' || e.unit === 'LITRES', {
    message: 'Give the litres for a fuel claim',
    path: ['quantity'],
  });
export const ExpenseDecision = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => d.decision !== 'REJECTED' || (d.note ?? '').length >= 3,
    'Say why the claim is rejected',
  );
export const ExpenseDto = z.object({
  id: uuid,
  vehicleId: uuid,
  submittedBy: uuid,
  spentOn: isoDate,
  category: z.string(),
  odometer: z.number().nullable(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  amountPence: z.number(),
  currency: z.literal('GBP'),
  supplier: z.string().nullable(),
  receiptEvidenceItemId: uuid.nullable(),
  duplicateOf: uuid.nullable(),
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']),
  decidedBy: uuid.nullable(),
  decisionNote: z.string().nullable(),
  /** Filled on the register list so submitters without vehicle access still see names. */
  vehicleLabel: z.string().nullable().optional(),
  submittedByName: z.string().nullable().optional(),
  decidedByName: z.string().nullable().optional(),
  replayed: z.boolean().optional(),
  version,
});
export type ExpenseDto = z.infer<typeof ExpenseDto>;
export const ExpenseQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  vehicleId: uuid.optional(),
});
