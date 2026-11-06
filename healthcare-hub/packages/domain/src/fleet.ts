import type { TenantTx } from '@hub/db';
import {
  addDays,
  checkOdometer,
  londonDate,
  maintenanceState,
  motRequired,
  premisesIntervalStatus,
  vehicleDocumentKind,
  vehicleDocumentText,
  vehicleReadiness,
  equipmentReadiness,
  type Check,
  type ISODate,
  type MaintenanceState,
  type Readiness,
} from '@hub/rules';
import { evaluateInstanceDetail, recomputeInstance } from './recompute.js';

const iso = (d: Date | null): ISODate | null => (d ? d.toISOString().slice(0, 10) : null);

/** Open = anything not yet released through the separate return-to-service step (FLT-06). */
export const OPEN_DEFECT = { not: 'RELEASED' } as const;

/**
 * Derives the stored vehicle status: OFF_ROAD and QUARANTINED are explicit fleet decisions;
 * BLOCKED follows any open stop-use defect. Called after every change that can affect it.
 */
export async function refreshVehicleStatus(tx: TenantTx, vehicleId: string): Promise<string> {
  const v = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const stopUse = await tx.defect.count({
    where: { vehicleId, stopUse: true, status: OPEN_DEFECT },
  });
  const [status, reason] = v.offRoad
    ? (['OFF_ROAD', v.offRoadReason ?? 'Taken off the road by fleet'] as const)
    : v.quarantined
      ? (['QUARANTINED', v.quarantineReason ?? 'Quarantined by fleet'] as const)
      : stopUse > 0
        ? (['BLOCKED', `${stopUse} open stop-use defect${stopUse === 1 ? '' : 's'}`] as const)
        : (['AVAILABLE', null] as const);
  if (v.status !== status || v.statusReason !== reason)
    await tx.vehicle.update({ where: { id: vehicleId }, data: { status, statusReason: reason } });
  return status;
}

export interface PlanLike {
  intervalDays: number | null;
  intervalMiles: number | null;
  dueSoonMiles: number;
  dueSoonDays: number;
  lastDoneOn: Date | null;
  lastDoneOdometer: number | null;
  createdAt: Date;
}

/** Date AND mileage, whichever first (FLT-02). A plan never done is due from its creation. */
export function planStatus(
  p: PlanLike,
  currentOdometer: number | null,
  now: Date,
): MaintenanceState & { dueDate: ISODate | null; dueOdometer: number | null } {
  const anchor = iso(p.lastDoneOn) ?? iso(p.createdAt)!;
  const dueDate = p.intervalDays ? addDays(anchor, p.intervalDays) : null;
  const dueOdometer =
    p.intervalMiles && p.lastDoneOdometer !== null ? p.lastDoneOdometer + p.intervalMiles : null;
  const s = maintenanceState(
    {
      dueDate,
      dueOdometer,
      currentOdometer,
      dueSoonMiles: p.dueSoonMiles,
      dueSoonDays: p.dueSoonDays,
    },
    now,
  );
  return { ...s, dueDate, dueOdometer };
}

export interface Capability {
  stretcher: boolean;
  wheelchairCapacity: number;
  clinicalKit: boolean;
  /** Why a capability is missing (e.g. quarantined stretcher asset), for the readiness panel. */
  lost: string[];
}

/**
 * FLT-08 / D3: capability comes from fitted equipment that is not quarantined, has no stop-use
 * defect and whose inspection regimes (LOLER, service, calibration) are in date.
 */
export async function vehicleCapability(tx: TenantTx, vehicleId: string): Promise<Capability> {
  const v = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
  const assets = await tx.equipmentAsset.findMany({
    where: { vehicleId, capability: { not: null }, status: { not: 'RETIRED' } },
    include: { defects: { where: { stopUse: true, status: OPEN_DEFECT }, select: { id: true } } },
  });
  const outOfDate = new Set(
    (
      await tx.requirementInstance.findMany({
        where: {
          subjectType: 'EQUIPMENT',
          subjectId: { in: assets.map((a) => a.id) },
          status: 'RED',
        },
        select: { subjectId: true },
      })
    ).map((r) => r.subjectId),
  );
  const why = (a: (typeof assets)[number]) =>
    a.status === 'QUARANTINED'
      ? 'quarantined'
      : a.defects.length > 0
        ? 'has a stop-use defect'
        : outOfDate.has(a.id)
          ? 'is out of date'
          : null;
  const down = (cap: string) => assets.filter((a) => a.capability === cap && why(a) !== null);
  const lost: string[] = [];
  for (const a of down('STRETCHER')) lost.push(`Stretcher ${a.assetTag} ${why(a)}`);
  for (const a of down('WHEELCHAIR')) lost.push(`Wheelchair restraint ${a.assetTag} ${why(a)}`);
  for (const a of down('CLINICAL')) lost.push(`Clinical kit ${a.assetTag} ${why(a)}`);
  for (const a of down('BARIATRIC')) lost.push(`Bariatric equipment ${a.assetTag} ${why(a)}`);
  // A vehicle with stretcher assets needs at least one usable; one without any keeps its flag.
  const usable = (cap: string) =>
    assets.some((a) => a.capability === cap && why(a) === null) ||
    !assets.some((a) => a.capability === cap);
  return {
    stretcher: v.stretcher && usable('STRETCHER'),
    wheelchairCapacity: usable('WHEELCHAIR') ? v.wheelchairCapacity : 0,
    clinicalKit: usable('CLINICAL'),
    lost,
  };
}

async function requirementEntries(
  tx: TenantTx,
  subjectType: 'VEHICLE' | 'EQUIPMENT',
  subjectId: string,
  group: 'ROADWORTHY' | 'EQUIPMENT',
  now: Date,
) {
  const instances = await tx.requirementInstance.findMany({
    where: { subjectType, subjectId },
    include: { template: { select: { code: true, title: true } } },
  });
  const out = [];
  for (const i of instances) {
    const { result, verified } = await evaluateInstanceDetail(tx, i.id, now);
    out.push({
      instanceId: i.id,
      code: i.template.code,
      title: i.template.title,
      templateId: i.templateId,
      group,
      result,
      validFrom: verified?.validFrom ?? null,
      expiryDate: verified?.validTo ?? iso(i.expiryDate),
    });
  }
  return out;
}

async function missedOxygenChecks(
  tx: TenantTx,
  locationId: string | null,
  now: Date,
): Promise<string[]> {
  if (!locationId) return [];
  const items = await tx.premisesItem.findMany({
    where: { locationId, controlArea: 'OXYGEN', applicable: true },
  });
  const out: string[] = [];
  for (const p of items) {
    const red = p.requirementInstanceId
      ? (await tx.requirementInstance.findUnique({ where: { id: p.requirementInstanceId } }))
          ?.status === 'RED'
      : premisesIntervalStatus(p, londonDate(now))?.status === 'RED';
    if (red) out.push(`Oxygen storage check missed at this base (${p.title})`);
  }
  return out;
}

/**
 * D1: statutory documents the organisation requires for this vehicle (published, auto-applied
 * templates for insurance, tax and, once three years old, MOT) that have no record on it.
 */
async function missingDocuments(
  tx: TenantTx,
  v: {
    organisationId: string;
    type: string;
    firstRegisteredOn: Date | null;
    year: number | null;
  },
  have: Set<string>,
  now: Date,
): Promise<string[]> {
  const versions = await tx.requirementTemplateVersion.findMany({
    where: { status: 'EFFECTIVE', subjectType: 'VEHICLE', organisationId: v.organisationId },
    include: { template: { select: { code: true, title: true } } },
  });
  const out: string[] = [];
  for (const ver of versions) {
    if (have.has(ver.templateId)) continue;
    const kind = vehicleDocumentKind(ver.template.code) ?? vehicleDocumentKind(ver.template.title);
    if (!kind || kind === 'CONVERSION') continue;
    // Only requirements meant for every vehicle (auto-applied) count as missing.
    const rule = (ver.applicabilityRule ?? {}) as { autoApply?: boolean; types?: string[] };
    if (!rule.autoApply) continue;
    if (rule.types && rule.types.length > 0 && !rule.types.includes(v.type)) continue;
    if (
      kind === 'MOT' &&
      !motRequired({ firstRegisteredOn: iso(v.firstRegisteredOn), year: v.year }, londonDate(now))
    )
      continue;
    out.push(`${ver.template.title} missing`);
  }
  return out;
}

export interface VehicleNeeds {
  stretcher?: boolean;
  wheelchairs?: number;
  seats?: number;
}

/** Vehicle readiness across a job window (RULES_ENGINE §3), evaluated live. */
export async function vehicleReadinessFor(
  tx: TenantTx,
  a: { vehicleId: string; window: { start: Date; end: Date }; needs?: VehicleNeeds; now: Date },
): Promise<Readiness & { capability: Capability; maintenance: ReturnType<typeof planStatus>[] }> {
  const v = await tx.vehicle.findUniqueOrThrow({ where: { id: a.vehicleId } });
  const plans = await tx.maintenancePlan.findMany({ where: { vehicleId: v.id, active: true } });
  // Maintenance is judged at the END of the job (it must still be in date when the job finishes).
  const maintenance = plans.map((p) => planStatus(p, v.currentOdometer, a.window.end));
  const openCritical =
    (await tx.defect.count({ where: { vehicleId: v.id, stopUse: true, status: OPEN_DEFECT } })) > 0;
  const overdue = maintenance.filter((m) => m.state === 'OVERDUE');
  const entries = await requirementEntries(tx, 'VEHICLE', v.id, 'ROADWORTHY', a.now);
  const r = vehicleReadiness(
    {
      quarantined: v.quarantined || v.offRoad,
      openCriticalDefect: openCritical,
      maintenanceOverdue: overdue.length > 0,
      maintenanceOverdueBy: overdue.some((m) => m.by === 'MILEAGE')
        ? 'MILEAGE'
        : overdue.length
          ? 'DATE'
          : null,
      requirements: entries,
    },
    a.window,
  );
  // D1/E3: statutory documents in plain words ("Insurance not verified", "MOT expired on ...").
  for (const c of r.checks) {
    const e = c.requirementInstanceId
      ? entries.find((x) => x.instanceId === c.requirementInstanceId)
      : undefined;
    if (!e) continue;
    c.reasonText = vehicleDocumentText(e.title, c, {
      status: e.result.status,
      expiryDate: e.expiryDate,
    });
  }
  // Off road and quarantined say which, with the reason fleet gave.
  const flagCheck = r.checks.find((c) => c.code === 'QUARANTINE');
  if (flagCheck && flagCheck.result === 'FAIL')
    flagCheck.reasonText = v.offRoad
      ? `Vehicle is off road${v.offRoadReason ? `: ${v.offRoadReason}` : ''}`
      : `Vehicle is quarantined${v.quarantineReason ? `: ${v.quarantineReason}` : ''}`;
  for (const text of await missingDocuments(
    tx,
    v,
    new Set(entries.map((e) => e.templateId)),
    a.now,
  )) {
    r.checks.push({
      code: 'DOCUMENT_MISSING',
      group: 'ROADWORTHY',
      result: 'FAIL',
      reasonText: text,
      overridable: false,
    });
    r.state = 'BLOCKED';
  }
  // J1: a missed oxygen storage check at the vehicle's base stops deployment.
  for (const text of await missedOxygenChecks(tx, v.baseLocationId, a.now)) {
    r.checks.push({
      code: 'PREMISES_OXYGEN',
      group: 'EQUIPMENT',
      result: 'FAIL',
      reasonText: text,
      overridable: false,
    });
    r.state = 'BLOCKED';
  }
  const capability = await vehicleCapability(tx, v.id);
  const suit: Check[] = [];
  const need = a.needs ?? {};
  if (need.stretcher)
    suit.push(
      capability.stretcher
        ? {
            code: 'STRETCHER',
            group: 'SUITABILITY',
            result: 'PASS',
            reasonText: 'Stretcher available',
            overridable: false,
          }
        : {
            code: 'STRETCHER',
            group: 'SUITABILITY',
            result: 'FAIL',
            reasonText:
              capability.lost.find((l) => l.startsWith('Stretcher')) ?? 'Vehicle has no stretcher',
            overridable: false,
          },
    );
  if (need.wheelchairs)
    suit.push(
      capability.wheelchairCapacity >= need.wheelchairs
        ? {
            code: 'WHEELCHAIR',
            group: 'SUITABILITY',
            result: 'PASS',
            reasonText: `Carries ${capability.wheelchairCapacity} wheelchair(s)`,
            overridable: false,
          }
        : {
            code: 'WHEELCHAIR',
            group: 'SUITABILITY',
            result: 'FAIL',
            reasonText: `Needs ${need.wheelchairs} wheelchair space(s); available ${capability.wheelchairCapacity}`,
            overridable: false,
          },
    );
  if (need.seats && v.seats < need.seats)
    suit.push({
      code: 'SEATS',
      group: 'SUITABILITY',
      result: 'FAIL',
      reasonText: `Needs ${need.seats} seats; vehicle has ${v.seats}`,
      overridable: false,
    });
  if (suit.length) {
    r.checks.push(...suit);
    if (suit.some((c) => c.result === 'FAIL')) r.state = 'BLOCKED';
  }
  return { ...r, capability, maintenance };
}

export async function equipmentReadinessFor(
  tx: TenantTx,
  a: { assetId: string; window: { start: Date; end: Date }; now: Date },
): Promise<Readiness> {
  const asset = await tx.equipmentAsset.findUniqueOrThrow({ where: { id: a.assetId } });
  const stopUse = await tx.defect.count({
    where: { assetId: asset.id, stopUse: true, status: OPEN_DEFECT },
  });
  return equipmentReadiness(
    {
      quarantined: asset.status !== 'AVAILABLE' || stopUse > 0,
      requirements: await requirementEntries(tx, 'EQUIPMENT', asset.id, 'EQUIPMENT', a.now),
    },
    a.window,
  );
}

/**
 * Creates instances for every published template marked `applicabilityRule.autoApply` for this
 * subject type (optionally narrowed by `applicabilityRule.types`), e.g. MOT, insurance and tax for
 * every vehicle. Idempotent.
 */
export async function applyAutoRequirements(
  tx: TenantTx,
  s: {
    subjectType: 'VEHICLE' | 'EQUIPMENT';
    subjectId: string;
    kind: string;
    locationId: string | null;
    organisationId: string;
    /** D1: a vehicle under three years old gets no MOT requirement yet. */
    age?: { firstRegisteredOn?: ISODate | null; year?: number | null };
  },
  actorUserId: string,
  now: Date,
): Promise<number> {
  const versions = await tx.requirementTemplateVersion.findMany({
    where: { status: 'EFFECTIVE', subjectType: s.subjectType, organisationId: s.organisationId },
    include: { template: { select: { code: true, title: true } } },
  });
  let n = 0;
  for (const v of versions) {
    const rule = (v.applicabilityRule ?? {}) as { autoApply?: boolean; types?: string[] };
    if (!rule.autoApply) continue;
    if (rule.types && rule.types.length > 0 && !rule.types.includes(s.kind)) continue;
    if (
      s.subjectType === 'VEHICLE' &&
      s.age &&
      (vehicleDocumentKind(v.template.code) ?? vehicleDocumentKind(v.template.title)) === 'MOT' &&
      !motRequired(s.age, londonDate(now))
    )
      continue;
    const exists = await tx.requirementInstance.findFirst({
      where: { templateId: v.templateId, subjectType: s.subjectType, subjectId: s.subjectId },
      select: { id: true },
    });
    if (exists) continue;
    const i = await tx.requirementInstance.create({
      data: {
        organisationId: s.organisationId,
        templateId: v.templateId,
        templateVersionId: v.id,
        subjectType: s.subjectType,
        subjectId: s.subjectId,
        locationId: s.locationId,
        createdBy: actorUserId,
      },
    });
    await recomputeInstance(tx, i.id, now);
    n += 1;
  }
  return n;
}

/** Raises the control-room alert for a stop-use defect (deduplicated per defect). */
export async function raiseDefectAlert(
  tx: TenantTx,
  d: {
    id: string;
    organisationId: string;
    severity: string;
    vehicleId: string | null;
    assetId: string | null;
  },
  label: string,
): Promise<void> {
  const existing = await tx.alert.findFirst({
    where: { sourceType: 'DEFECT', sourceId: d.id, state: { not: 'RESOLVED' } },
  });
  if (existing) return;
  await tx.alert.create({
    data: {
      organisationId: d.organisationId,
      sourceType: 'DEFECT',
      sourceId: d.id,
      severity: d.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
      reasonCode: d.vehicleId ? 'VEHICLE_BLOCKED' : 'ASSET_STOP_USE',
      reasonText: `Stop-use defect on ${label}: do not allocate until released`,
    },
  });
}

export async function resolveDefectAlert(tx: TenantTx, defectId: string, now: Date): Promise<void> {
  await tx.alert.updateMany({
    where: { sourceType: 'DEFECT', sourceId: defectId, state: { not: 'RESOLVED' } },
    data: { state: 'RESOLVED', resolvedAt: now },
  });
}

/**
 * Records an immutable odometer reading with plausibility flags (T13). A decreasing or
 * implausible reading is stored and flagged but never moves the vehicle's current odometer.
 */
export async function recordOdometer(
  tx: TenantTx,
  r: {
    vehicleId: string;
    organisationId: string;
    reading: number;
    readOn: ISODate;
    source: 'MANUAL' | 'VDI' | 'FUEL' | 'SERVICE' | 'TELEMATICS';
    by: string;
  },
): Promise<{ id: string; reading: number; flags: string[] }> {
  const prev = await tx.odometerReading.findFirst({
    where: {
      vehicleId: r.vehicleId,
      NOT: { flags: { hasSome: ['ODOMETER_DECREASED', 'ODOMETER_IMPLAUSIBLE_JUMP'] } },
    },
    orderBy: [{ readOn: 'desc' }, { createdAt: 'desc' }],
  });
  const { flags } = checkOdometer(prev ? { reading: prev.reading, on: iso(prev.readOn)! } : null, {
    reading: r.reading,
    on: r.readOn,
  });
  const row = await tx.odometerReading.create({
    data: {
      organisationId: r.organisationId,
      vehicleId: r.vehicleId,
      reading: r.reading,
      readOn: new Date(`${r.readOn}T00:00:00.000Z`),
      source: r.source,
      flags,
      recordedBy: r.by,
    },
  });
  if (!flags.includes('ODOMETER_DECREASED') && !flags.includes('ODOMETER_IMPLAUSIBLE_JUMP')) {
    const v = await tx.vehicle.findUniqueOrThrow({
      where: { id: r.vehicleId },
      select: { currentOdometer: true },
    });
    if (v.currentOdometer === null || r.reading > v.currentOdometer)
      await tx.vehicle.update({ where: { id: r.vehicleId }, data: { currentOdometer: r.reading } });
  }
  return row;
}
