import { z } from 'zod';
import { isoDate, isoDateTime, page, uuid } from './common.js';
import { CheckDto } from './staff.js';

const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(500);

export const VehicleType = z.enum(['AMBULANCE', 'PTS_VEHICLE', 'WAV', 'CAR', 'MINIBUS', 'OTHER']);
export const VehicleStatus = z.enum(['AVAILABLE', 'BLOCKED', 'QUARANTINED', 'OFF_ROAD']);
export const LicenceCategory = z.enum(['B', 'BE', 'C1', 'C1E', 'C', 'CE', 'D1', 'D1E', 'D', 'DE']);
/** UK registration, stored without spaces in upper case. */
const registration = z
  .string()
  .trim()
  .transform((s) => s.replace(/\s+/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,8}$/, 'Enter a UK registration'));
const callsign = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,15}$/));

export const VehicleCreate = z.strictObject({
  registration,
  callsign,
  vin: z
    .string()
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/)
    .optional(),
  type: VehicleType,
  ownership: z.enum(['OWNED', 'LEASED', 'HIRED']).default('OWNED'),
  baseLocationId: uuid,
  seats: z.number().int().min(0).max(60).default(0),
  wheelchairCapacity: z.number().int().min(0).max(10).default(0),
  stretcher: z.boolean().default(false),
  permittedLoads: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  licenceCategory: LicenceCategory.default('B'),
});
export const VehiclePatch = z
  .strictObject({
    vin: z
      .string()
      .regex(/^[A-HJ-NPR-Z0-9]{17}$/)
      .nullable(),
    ownership: z.enum(['OWNED', 'LEASED', 'HIRED']),
    seats: z.number().int().min(0).max(60),
    wheelchairCapacity: z.number().int().min(0).max(10),
    stretcher: z.boolean(),
    permittedLoads: z.array(z.string().trim().min(1).max(60)).max(20),
    licenceCategory: LicenceCategory,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');

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
  status: VehicleStatus,
  statusReason: z.string().nullable(),
  currentOdometer: z.number().nullable(),
  openDefects: z.number(),
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
    }),
  ),
  locations: z.array(z.object({ locationId: uuid, reason: z.string(), at: isoDateTime })),
  capability: z.object({
    stretcher: z.boolean(),
    wheelchairCapacity: z.number(),
    clinicalKit: z.boolean(),
    lost: z.array(z.string()),
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
});
export const MoveInput = z.strictObject({ locationId: uuid, reason });
export const FlagInput = z.strictObject({ on: z.boolean(), reason });

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
  capability: z.enum(['STRETCHER', 'WHEELCHAIR', 'CLINICAL']).optional(),
});
export const EquipmentPatch = z
  .strictObject({
    vehicleId: uuid.nullable(),
    locationId: uuid.nullable(),
    model: z.string().trim().max(120).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
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
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to change');
export const ReleaseInput = z.strictObject({ reason, evidenceItemId: uuid.optional() });
export const DefectDto = z.object({
  id: uuid,
  vehicleId: uuid.nullable(),
  assetId: uuid.nullable(),
  severity: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  stopUse: z.boolean(),
  description: z.string(),
  reportedBy: uuid,
  discoveredAt: isoDateTime,
  sourceVdiId: uuid.nullable(),
  status: z.enum(['OPEN', 'REPAIRING', 'REPAIRED', 'RELEASED']),
  classifiedBy: uuid.nullable(),
  repairDeadline: isoDate.nullable(),
  repairNotes: z.string().nullable(),
  repairedAt: isoDateTime.nullable(),
  release: z.object({ releasedBy: uuid, reason: z.string(), at: isoDateTime }).nullable(),
  /** Jobs released for reassignment because of a stop-use defect (FLT-06). */
  affectedAllocationIds: z.array(uuid),
  photoEvidenceItemIds: z.array(uuid),
  /** True when this response replays an earlier submission with the same clientSubmissionId. */
  replayed: z.boolean().optional(),
  version,
});
export type DefectDto = z.infer<typeof DefectDto>;
export const DefectListQuery = z.object({
  status: z.enum(['OPEN', 'REPAIRING', 'REPAIRED', 'RELEASED', 'ACTIVE']).default('ACTIVE'),
  vehicleId: uuid.optional(),
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
  );
export const ExpenseDecision = z.strictObject({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
});
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
