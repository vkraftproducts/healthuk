import type { DefectDto, EquipmentDto, ExpenseDto, VdiDto, VehicleDto } from '@hub/contracts';
import type { Prisma, TenantTx } from '@hub/db';
import { planStatus } from '@hub/domain';
import { firstLimit, licenceNeededText, repairDueState } from '@hub/rules';
import { userNames } from '../evidence/evidence.mapper.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const ts = (d: Date | null): string | null => (d ? d.toISOString() : null);

export type LatestReading = VehicleDto['latestReading'];

export function toVehicleDto(
  v: Prisma.VehicleGetPayload<object>,
  openDefects: number,
  latestReading: LatestReading = null,
): VehicleDto {
  return {
    id: v.id,
    registration: v.registration,
    callsign: v.callsign,
    vin: v.vin,
    type: v.type,
    ownership: v.ownership,
    baseLocationId: v.baseLocationId,
    seats: v.seats,
    wheelchairCapacity: v.wheelchairCapacity,
    stretcher: v.stretcher,
    permittedLoads: v.permittedLoads,
    licenceCategory: v.licenceCategory as VehicleDto['licenceCategory'],
    grossWeightKg: v.grossWeightKg,
    status: v.status,
    statusReason: v.statusReason,
    offRoad: v.offRoad,
    quarantined: v.quarantined,
    // The odometer shown is always backed by a recorded reading (finding 41).
    currentOdometer: latestReading ? v.currentOdometer : null,
    latestReading,
    openDefects,
    make: v.make,
    model: v.model,
    year: v.year,
    firstRegisteredOn: iso(v.firstRegisteredOn),
    en1789Type: v.en1789Type as VehicleDto['en1789Type'],
    conversionCompany: v.conversionCompany,
    conversionCertificateRef: v.conversionCertificateRef,
    ownershipEndsOn: iso(v.ownershipEndsOn),
    serviceIds: v.serviceIds,
    blueLightAuthorised: v.blueLightAuthorised,
    bariatricLimitKg: v.bariatricLimitKg,
    licenceNeeded: licenceNeededText(v.licenceCategory, v.grossWeightKg),
    expectedReturnOn: iso(v.expectedReturnOn),
    version: v.version,
  };
}

export function toPlanDto(
  p: Prisma.MaintenancePlanGetPayload<object>,
  odometer: number | null,
  now: Date,
  readings: { reading: number; on: string }[] = [],
) {
  const s = planStatus(p, odometer, now);
  const first = firstLimit({ dueDate: s.dueDate, dueOdometer: s.dueOdometer, readings }, now);
  return {
    id: p.id,
    title: p.title,
    intervalDays: p.intervalDays,
    intervalMiles: p.intervalMiles,
    lastDoneOn: iso(p.lastDoneOn),
    lastDoneOdometer: p.lastDoneOdometer,
    dueDate: s.dueDate,
    dueOdometer: s.dueOdometer,
    state: s.state,
    by: s.by,
    text: s.text,
    firstLimit: first.first,
    firstLimitText: first.text,
    mileageDueOn: first.mileageDueOn,
    version: p.version,
  };
}

type AssetRow = Prisma.EquipmentAssetGetPayload<{ include: { regimes: true } }>;
export function toEquipmentDto(
  a: AssetRow,
  instances: { id: string; status: string; reasonText: string }[],
): EquipmentDto {
  return {
    id: a.id,
    assetTag: a.assetTag,
    category: a.category,
    model: a.model,
    serial: a.serial,
    manufacturer: a.manufacturer,
    swlKg: a.swlKg === null ? null : Number(a.swlKg),
    vehicleId: a.vehicleId,
    locationId: a.locationId,
    capability: a.capability,
    status: a.status,
    quarantineReason: a.quarantineReason,
    instructions: a.instructions,
    quarantinedBy: a.quarantinedBy,
    regimes: a.regimes.map((r) => {
      const i = instances.find((x) => x.id === r.requirementInstanceId);
      return {
        regime: r.regime,
        requirementInstanceId: r.requirementInstanceId,
        status: i?.status ?? 'GREY',
        reasonText: i?.reasonText ?? 'Not evaluated',
      };
    }),
    version: a.version,
  };
}

type VdiRow = Prisma.VdiGetPayload<{
  include: { items: true; amendments: true; defects: { select: { id: true } } };
}>;
export function toVdiDto(
  v: VdiRow,
  extra: { duplicate: boolean; odometerFlags: string[] },
): VdiDto {
  const amendedCodes = new Set(v.amendments.map((a) => a.itemCode));
  const latest = new Map<string, string>();
  for (const a of [...v.amendments].sort((x, y) => x.at.getTime() - y.at.getTime()))
    latest.set(a.itemCode, a.newResult);
  return {
    id: v.id,
    vehicleId: v.vehicleId,
    templateId: v.templateId,
    checkerUserId: v.checkerUserId,
    odometer: v.odometer,
    outcome: v.outcome as 'PASS' | 'FAIL',
    capturedAt: v.capturedAt.toISOString(),
    receivedAt: v.receivedAt.toISOString(),
    results: v.items.map((i) => ({
      code: i.itemCode,
      critical: i.critical,
      result: (latest.get(i.itemCode) ?? i.result) as 'PASS' | 'FAIL' | 'NA',
      reason: i.reason,
      amended: amendedCodes.has(i.itemCode),
    })),
    amendments: v.amendments.map((a) => ({
      code: a.itemCode,
      newResult: a.newResult,
      reason: a.reason,
      amendedBy: a.amendedBy,
      at: a.at.toISOString(),
    })),
    defectIds: v.defects.map((d) => d.id),
    odometerFlags: extra.odometerFlags,
    duplicate: extra.duplicate,
  };
}

type DefectRow = Prisma.DefectGetPayload<{ include: { release: true } }>;
interface DefectContext {
  names: Map<string, string>;
  labels: Map<string, string>;
  now: Date;
}
export function toDefectDto(
  d: DefectRow,
  ctx: DefectContext,
  affected: string[] = [],
  affectedCodes: string[] = [],
): DefectDto {
  const name = (id: string | null) => (id ? (ctx.names.get(id) ?? null) : null);
  const repairDeadline = iso(d.repairDeadline);
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    assetId: d.assetId,
    subjectLabel: ctx.labels.get((d.vehicleId ?? d.assetId) as string) ?? null,
    severity: d.severity,
    stopUse: d.stopUse,
    description: d.description,
    reportedBy: d.reportedBy,
    reportedByName: name(d.reportedBy),
    discoveredAt: d.discoveredAt.toISOString(),
    sourceVdiId: d.sourceVdiId,
    status: d.status,
    classifiedBy: d.classifiedBy,
    classifiedByName: name(d.classifiedBy),
    repairDeadline,
    repairDue: repairDueState({ status: d.status, repairDeadline }, ctx.now).state,
    repairNotes: d.repairNotes,
    repairedAt: ts(d.repairedAt),
    repairedBy: d.repairedBy,
    repairedByName: name(d.repairedBy),
    release: d.release
      ? {
          releasedBy: d.release.releasedBy,
          releasedByName: name(d.release.releasedBy),
          reason: d.release.reason,
          evidenceItemId: d.release.evidenceItemId,
          at: d.release.at.toISOString(),
        }
      : null,
    affectedAllocationIds: affected,
    affectedJobCodes: affectedCodes,
    repairJobSheetEvidenceItemId: d.repairJobSheetEvidenceItemId,
    photoEvidenceItemIds: d.photoEvidenceItemIds,
    version: d.version,
  };
}

/** Loads the people's names and vehicle/asset labels the defect DTOs show. */
export async function defectContext(tx: TenantTx, rows: DefectRow[]): Promise<DefectContext> {
  const vehicleIds = [...new Set(rows.flatMap((d) => (d.vehicleId ? [d.vehicleId] : [])))];
  const assetIds = [...new Set(rows.flatMap((d) => (d.assetId ? [d.assetId] : [])))];
  const [names, vehicles, assets] = await Promise.all([
    userNames(
      tx,
      rows.flatMap((d) => [
        d.reportedBy,
        d.classifiedBy,
        d.repairedBy,
        d.release?.releasedBy ?? null,
      ]),
    ),
    vehicleIds.length
      ? tx.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, callsign: true },
        })
      : [],
    assetIds.length
      ? tx.equipmentAsset.findMany({
          where: { id: { in: assetIds } },
          select: { id: true, assetTag: true },
        })
      : [],
  ]);
  const labels = new Map<string, string>([
    ...vehicles.map((v) => [v.id, v.callsign] as [string, string]),
    ...assets.map((a) => [a.id, a.assetTag] as [string, string]),
  ]);
  return { names, labels, now: new Date() };
}

export async function defectDtos(tx: TenantTx, rows: DefectRow[]): Promise<DefectDto[]> {
  const ctx = await defectContext(tx, rows);
  return rows.map((d) => toDefectDto(d, ctx));
}

export async function defectDto(
  tx: TenantTx,
  row: DefectRow,
  affected: string[] = [],
): Promise<DefectDto> {
  // D4: the person reporting sees which jobs went back for reassignment, by job code only.
  const codes = affected.length
    ? (
        await tx.job.findMany({
          where: { id: { in: affected } },
          select: { code: true },
          orderBy: { plannedStart: 'asc' },
        })
      ).map((j) => j.code)
    : [];
  return toDefectDto(row, await defectContext(tx, [row]), affected, codes);
}

export function toExpenseDto(e: Prisma.FuelExpenseGetPayload<object>): ExpenseDto {
  return {
    id: e.id,
    vehicleId: e.vehicleId,
    submittedBy: e.submittedBy,
    spentOn: iso(e.spentOn) as string,
    category: e.category,
    odometer: e.odometer,
    quantity: e.quantity === null ? null : Number(e.quantity),
    unit: e.unit,
    amountPence: e.amountPence,
    currency: 'GBP',
    supplier: e.supplier,
    receiptEvidenceItemId: e.receiptEvidenceItemId,
    duplicateOf: e.duplicateOf,
    status: e.status,
    decidedBy: e.decidedBy,
    decisionNote: e.decisionNote,
    version: e.version,
  };
}

export const day = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
