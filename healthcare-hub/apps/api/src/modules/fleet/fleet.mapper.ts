import type { DefectDto, EquipmentDto, ExpenseDto, VdiDto, VehicleDto } from '@hub/contracts';
import type { Prisma } from '@hub/db';
import { planStatus } from '@hub/domain';

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const ts = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toVehicleDto(v: Prisma.VehicleGetPayload<object>, openDefects: number): VehicleDto {
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
    status: v.status,
    statusReason: v.statusReason,
    currentOdometer: v.currentOdometer,
    openDefects,
    version: v.version,
  };
}

export function toPlanDto(
  p: Prisma.MaintenancePlanGetPayload<object>,
  odometer: number | null,
  now: Date,
) {
  const s = planStatus(p, odometer, now);
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
export function toDefectDto(d: DefectRow, affected: string[] = []): DefectDto {
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    assetId: d.assetId,
    severity: d.severity,
    stopUse: d.stopUse,
    description: d.description,
    reportedBy: d.reportedBy,
    discoveredAt: d.discoveredAt.toISOString(),
    sourceVdiId: d.sourceVdiId,
    status: d.status,
    classifiedBy: d.classifiedBy,
    repairDeadline: iso(d.repairDeadline),
    repairNotes: d.repairNotes,
    repairedAt: ts(d.repairedAt),
    release: d.release
      ? {
          releasedBy: d.release.releasedBy,
          reason: d.release.reason,
          at: d.release.at.toISOString(),
        }
      : null,
    affectedAllocationIds: affected,
    photoEvidenceItemIds: d.photoEvidenceItemIds,
    version: d.version,
  };
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
