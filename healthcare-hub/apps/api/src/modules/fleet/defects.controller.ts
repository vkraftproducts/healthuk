import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  affectedAllocations,
  raiseDefectAlert,
  recordOdometer,
  refreshVehicleStatus,
  resolveDefectAlert,
} from '@hub/domain';
import { canReleaseVehicle, londonDate } from '@hub/rules';
import {
  DefectCreate,
  DefectListQuery,
  DefectPatch,
  DefectReopen,
  ExpenseCreate,
  ExpenseDecision,
  ExpenseQuery,
  ReleaseInput,
  type DefectDto,
  type ExpenseDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import {
  assertNotFuture,
  audit,
  body,
  ifMatchVersion,
  requireAny,
  staleOrNotFound,
} from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { toCsv } from '../../common/csv.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { day, defectDto, defectDtos, toExpenseDto } from './fleet.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });

/**
 * Defects (FLT-06): a stop-use or critical defect blocks the vehicle immediately and alerts
 * control; repair is not return to service; release is a separate, authorised, immutable act.
 */
@Controller('defects')
export class DefectsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: DefectDto[] }> {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.defect.manage');
    const f = body(DefectListQuery, q);
    const data = await this.db.withTenant(tenantOf(hub), async (tx) =>
      defectDtos(
        tx,
        await tx.defect.findMany({
          where: {
            ...(f.status === 'ACTIVE' ? { status: { not: 'RELEASED' } } : { status: f.status }),
            ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
            ...(f.severity ? { severity: f.severity } : {}),
          },
          include: { release: true },
          orderBy:
            f.status === 'RELEASED'
              ? [{ updatedAt: 'desc' }]
              : [{ stopUse: 'desc' }, { discoveredAt: 'desc' }],
          take: 500,
        }),
      ),
    );
    return { data };
  }

  @RequirePermission('fleet.defect.create')
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<DefectDto> {
    const input = body(DefectCreate, raw);
    const now = new Date();
    const discovered = input.discoveredAt ? new Date(input.discoveredAt) : now;
    assertNotFuture(discovered, now);
    const stopUse = input.severity === 'CRITICAL' || input.stopUse;
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.clientSubmissionId) {
        const prior = await tx.defect.findFirst({
          where: { clientSubmissionId: input.clientSubmissionId },
          include: { release: true },
        });
        if (prior) {
          if (prior.reportedBy !== hub.user.id)
            throw new HubError(
              'CONFLICT',
              409,
              'That submission id was used for a different report',
            );
          return { ...(await defectDto(tx, prior)), replayed: true }; // offline retry: exactly one defect
        }
      }
      await ownEvidence(tx, hub, input.photoEvidenceItemIds);
      const subject = await subjectOf(tx, input.vehicleId, input.assetId);
      const d = await tx.defect.create({
        data: {
          organisationId: hub.orgId as string,
          vehicleId: input.vehicleId ?? null,
          assetId: input.assetId ?? null,
          severity: input.severity,
          stopUse,
          description: input.description,
          reportedBy: hub.user.id,
          discoveredAt: discovered,
          clientSubmissionId: input.clientSubmissionId ?? null,
          photoEvidenceItemIds: input.photoEvidenceItemIds,
        },
        include: { release: true },
      });
      let affected: string[] = [];
      if (stopUse) {
        await raiseDefectAlert(tx, d, subject.label);
        if (subject.vehicleId) {
          await refreshVehicleStatus(tx, subject.vehicleId);
          affected = await affectedAllocations(tx, subject.vehicleId, now);
        }
      }
      await audit(this.db, tx, hub, {
        action: 'fleet.defect.report',
        entity: 'defect',
        entityId: d.id,
        summary: { severity: d.severity, stopUse, vehicleId: d.vehicleId, assetId: d.assetId },
      });
      return defectDto(tx, d, affected);
    });
  }

  @OrgMember()
  @Get(':id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<DefectDto> {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.defect.manage', 'fleet.defect.create');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.defect.findUnique({ where: { id }, include: { release: true } });
      const canSeeAll =
        hub.permissions.has('fleet.vehicle.view') || hub.permissions.has('fleet.defect.manage');
      if (!d || (!canSeeAll && d.reportedBy !== hub.user.id)) throw notFound();
      return defectDto(tx, d);
    });
  }

  @RequirePermission('fleet.defect.manage')
  @Patch(':id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<DefectDto> {
    const expected = ifMatchVersion(req);
    const input = body(DefectPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.defect.findUnique({ where: { id } });
      if (!d) throw notFound();
      if (d.status === 'RELEASED')
        throw new HubError('CONFLICT', 409, 'The defect has been released');
      if (
        input.repairJobSheetEvidenceItemId &&
        !(await tx.evidenceItem.count({ where: { id: input.repairJobSheetEvidenceItemId } }))
      )
        throw new HubError('VALIDATION_FAILED', 400, 'Upload the job sheet first');
      const escalationOnly =
        input.status === undefined &&
        input.repairNotes === undefined &&
        input.repairDeadline === undefined &&
        input.repairJobSheetEvidenceItemId === undefined &&
        (input.severity === undefined || input.severity === 'CRITICAL');
      // A signed-off repair is a record: only making it more serious is allowed afterwards.
      if (d.status === 'REPAIRED' && !escalationOnly)
        throw new HubError(
          'CONFLICT',
          409,
          'The repair has been signed off. Return it to service, or send it back for repair.',
        );
      if (input.status === 'REPAIRED' && !(input.repairNotes ?? d.repairNotes)?.trim())
        throw new HubError('VALIDATION_FAILED', 400, 'Say what was repaired before signing it off');
      const severity = input.severity ?? d.severity;
      const stopUse = d.stopUse || input.stopUse === true || severity === 'CRITICAL';
      if (d.stopUse && input.severity && input.severity !== 'CRITICAL' && d.severity === 'CRITICAL')
        throw new HubError(
          'OVERRIDE_NOT_PERMITTED',
          422,
          'A critical defect cannot be downgraded; release it after repair',
        );
      if (!stopUse && severity === 'MINOR' && !(input.repairDeadline ?? d.repairDeadline))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'A minor defect needs a repair deadline when classified',
        );
      const now = new Date();
      const r = await tx.defect.updateMany({
        where: { id, version: expected },
        data: {
          severity,
          stopUse,
          ...(input.severity || input.repairDeadline ? { classifiedBy: hub.user.id } : {}),
          ...(input.repairDeadline ? { repairDeadline: day(input.repairDeadline) } : {}),
          ...(input.repairNotes
            ? { repairNotes: appendNote(d.repairNotes, input.repairNotes) }
            : {}),
          ...(input.repairJobSheetEvidenceItemId
            ? { repairJobSheetEvidenceItemId: input.repairJobSheetEvidenceItemId }
            : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.status === 'REPAIRED' ? { repairedAt: now, repairedBy: hub.user.id } : {}),
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      const u = await tx.defect.findUniqueOrThrow({ where: { id }, include: { release: true } });
      let affected: string[] = [];
      if (stopUse && !d.stopUse) {
        const subject = await subjectOf(tx, u.vehicleId ?? undefined, u.assetId ?? undefined);
        await raiseDefectAlert(tx, u, subject.label);
        if (u.vehicleId) affected = await affectedAllocations(tx, u.vehicleId, now);
      }
      if (u.vehicleId) await refreshVehicleStatus(tx, u.vehicleId);
      await audit(this.db, tx, hub, {
        action: 'fleet.defect.update',
        entity: 'defect',
        entityId: id,
        summary: { status: u.status, severity: u.severity, stopUse: u.stopUse },
      });
      return defectDto(tx, u, affected);
    });
  }

  /** The person checking the repair is not satisfied: back to REPAIRING, block and alert stay. */
  @RequirePermission('fleet.return_to_service')
  @Post(':id/reopen')
  async reopen(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<DefectDto> {
    const input = body(DefectReopen, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.defect.findUnique({ where: { id } });
      if (!d) throw notFound();
      if (d.status !== 'REPAIRED')
        throw new HubError('CONFLICT', 409, 'Only a signed-off repair can be sent back');
      await tx.defect.update({
        where: { id },
        data: {
          status: 'REPAIRING',
          repairedAt: null,
          repairedBy: null,
          repairNotes: appendNote(
            d.repairNotes,
            `Sent back for repair on ${londonDate(new Date())}: ${input.reason}`,
          ),
        },
      });
      if (d.vehicleId) await refreshVehicleStatus(tx, d.vehicleId);
      await audit(this.db, tx, hub, {
        action: 'fleet.defect.reopen',
        entity: 'defect',
        entityId: id,
        summary: { vehicleId: d.vehicleId, assetId: d.assetId, previousRepairer: d.repairedBy },
      });
      return defectDto(
        tx,
        await tx.defect.findUniqueOrThrow({ where: { id }, include: { release: true } }),
      );
    });
  }

  @RequirePermission('fleet.return_to_service')
  @Post(':id/release')
  async release(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<DefectDto> {
    const input = body(ReleaseInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.defect.findUnique({ where: { id } });
      if (!d) throw notFound();
      if (d.status === 'RELEASED') throw new HubError('CONFLICT', 409, 'Already released');
      // D4: no release without a repair record (what was repaired, signed off by the repairer).
      if (d.status === 'REPAIRED' && !d.repairNotes?.trim())
        throw new HubError('OVERRIDE_NOT_PERMITTED', 422, 'Record the repair before release');
      const ok = canReleaseVehicle({
        repairCompleted: d.status === 'REPAIRED',
        hasReturnToServicePermission: true,
        openStopUseDefects: 0,
      });
      if (!ok.ok) throw new HubError('OVERRIDE_NOT_PERMITTED', 422, ok.reason ?? undefined);
      // Separation of duties: the person who signed off the repair does not also release it.
      if (d.repairedBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          422,
          'Release must be by someone other than the repairer',
        );
      if (
        input.evidenceItemId &&
        !(await tx.evidenceItem.count({ where: { id: input.evidenceItemId } }))
      )
        throw notFound();
      const now = new Date();
      await tx.defectRelease.create({
        data: {
          organisationId: d.organisationId,
          defectId: id,
          releasedBy: hub.user.id,
          reason: input.reason,
          evidenceItemId: input.evidenceItemId ?? null,
        },
      });
      await tx.defect.update({ where: { id }, data: { status: 'RELEASED' } });
      await resolveDefectAlert(tx, id, now);
      if (d.vehicleId) await refreshVehicleStatus(tx, d.vehicleId);
      await audit(this.db, tx, hub, {
        action: 'fleet.defect.release',
        entity: 'defect',
        entityId: id,
        summary: { vehicleId: d.vehicleId, assetId: d.assetId },
      });
      return defectDto(
        tx,
        await tx.defect.findUniqueOrThrow({ where: { id }, include: { release: true } }),
      );
    });
  }
}

/** Repair notes are a running log; the column holds 2000 characters, so keep the newest. */
function appendNote(existing: string | null, note: string): string {
  const all = existing ? `${existing}\n\n${note}` : note;
  return all.length > 2000 ? all.slice(all.length - 2000) : all;
}

async function subjectOf(
  tx: TenantTx,
  vehicleId?: string,
  assetId?: string,
): Promise<{ label: string; vehicleId: string | null }> {
  if (vehicleId) {
    const v = await tx.vehicle.findUnique({ where: { id: vehicleId }, select: { callsign: true } });
    if (!v) throw notFound();
    return { label: v.callsign, vehicleId };
  }
  const a = await tx.equipmentAsset.findUnique({
    where: { id: assetId as string },
    select: { assetTag: true },
  });
  if (!a) throw notFound();
  return { label: a.assetTag, vehicleId: null };
}

/** Fuel and expenses with receipt, approval by someone else, duplicate flag, CSV export (FLT-07). */
@Controller('fuel-expenses')
export class ExpensesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: ExpenseDto[] }> {
    requireAny(hub, 'fleet.expense.approve', 'fleet.expense.submit');
    const f = body(ExpenseQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.fuelExpense.findMany({
        where: {
          ...this.scope(hub),
          ...(f.status ? { status: f.status } : {}),
          ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
          ...(f.from || f.to
            ? {
                spentOn: {
                  ...(f.from ? { gte: day(f.from) } : {}),
                  ...(f.to ? { lte: day(f.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
        take: 500,
        include: { vehicle: { select: { callsign: true, registration: true } } },
      });
      const names = await userNames(
        tx,
        rows.flatMap((e) => [e.submittedBy, e.decidedBy]),
      );
      return {
        data: rows.map(({ vehicle, ...e }) => ({
          ...toExpenseDto(e),
          vehicleLabel: `${vehicle.callsign} (${vehicle.registration})`,
          submittedByName: names.get(e.submittedBy) ?? null,
          decidedByName: e.decidedBy ? (names.get(e.decidedBy) ?? null) : null,
        })),
      };
    });
  }

  @RequirePermission('fleet.expense.submit')
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ExpenseDto> {
    const input = body(ExpenseCreate, raw);
    if (input.spentOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.clientSubmissionId) {
        const prior = await tx.fuelExpense.findFirst({
          where: { clientSubmissionId: input.clientSubmissionId },
        });
        if (prior) {
          if (prior.submittedBy !== hub.user.id)
            throw new HubError(
              'CONFLICT',
              409,
              'That submission id was used for a different claim',
            );
          return { ...toExpenseDto(prior), replayed: true };
        }
      }
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
      if (!v) throw notFound();
      if (input.receiptEvidenceItemId) await ownEvidence(tx, hub, [input.receiptEvidenceItemId]);
      // D7: a possible duplicate is the same receipt, or the same vehicle, date, amount and type.
      const dup = await tx.fuelExpense.findFirst({
        where: {
          status: { not: 'REJECTED' },
          OR: [
            {
              vehicleId: v.id,
              spentOn: day(input.spentOn),
              amountPence: input.amountPence,
              category: input.category,
            },
            ...(input.receiptEvidenceItemId
              ? [{ receiptEvidenceItemId: input.receiptEvidenceItemId }]
              : []),
          ],
        },
        select: { id: true },
      });
      const e = await tx.fuelExpense.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: v.id,
          submittedBy: hub.user.id,
          spentOn: day(input.spentOn),
          category: input.category,
          odometer: input.odometer ?? null,
          quantity: input.quantity ?? null,
          unit: input.unit ?? null,
          amountPence: input.amountPence,
          supplier: input.supplier ?? null,
          receiptEvidenceItemId: input.receiptEvidenceItemId ?? null,
          duplicateOf: dup?.id ?? null,
          clientSubmissionId: input.clientSubmissionId ?? null,
        },
      });
      if (input.odometer !== undefined)
        await recordOdometer(tx, {
          vehicleId: v.id,
          organisationId: v.organisationId,
          reading: input.odometer,
          readOn: input.spentOn,
          source: 'FUEL',
          by: hub.user.id,
        });
      await audit(this.db, tx, hub, {
        action: 'fleet.expense.submit',
        entity: 'fuel_expense',
        entityId: e.id,
        summary: { vehicleId: v.id, duplicate: !!dup },
      });
      return toExpenseDto(e);
    });
  }

  @RequirePermission('fleet.expense.approve')
  @Get('export')
  async export(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<StreamableFile> {
    const f = body(ExpenseQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.fuelExpense.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
          ...(f.from || f.to
            ? {
                spentOn: {
                  ...(f.from ? { gte: day(f.from) } : {}),
                  ...(f.to ? { lte: day(f.to) } : {}),
                },
              }
            : {}),
        },
        include: { vehicle: { select: { callsign: true, registration: true } } },
        orderBy: [{ spentOn: 'asc' }, { createdAt: 'asc' }],
        take: 50_000,
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.expense.export',
        entity: 'fuel_expense',
        entityId: hub.orgId as string,
        summary: { rows: r.length },
      });
      return r;
    });
    const csv = toCsv(
      [
        'Date',
        'Callsign',
        'Registration',
        'Category',
        'Quantity',
        'Unit',
        'Amount (GBP)',
        'Supplier',
        'Odometer',
        'Status',
        'Possible duplicate',
        'Expense id',
      ],
      rows.map((e) => [
        e.spentOn.toISOString().slice(0, 10),
        e.vehicle.callsign,
        e.vehicle.registration,
        e.category,
        e.quantity === null ? '' : Number(e.quantity).toFixed(2),
        e.unit ?? '',
        (e.amountPence / 100).toFixed(2),
        e.supplier ?? '',
        e.odometer ?? '',
        e.status,
        e.duplicateOf ? 'yes' : 'no',
        e.id,
      ]),
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="fuel-expenses.csv"',
    });
  }

  @RequirePermission('fleet.expense.approve')
  @Post(':id/approve')
  async decide(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ExpenseDto> {
    const input = body(ExpenseDecision, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.fuelExpense.findUnique({ where: { id } });
      if (!e) throw notFound();
      if (e.status !== 'SUBMITTED') throw new HubError('CONFLICT', 409, 'Already decided');
      if (e.submittedBy === hub.user.id) throw new HubError('SELF_APPROVAL', 422);
      const u = await tx.fuelExpense.update({
        where: { id },
        data: {
          status: input.decision,
          decidedBy: hub.user.id,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.expense.decide',
        entity: 'fuel_expense',
        entityId: id,
        summary: { decision: input.decision },
      });
      return toExpenseDto(u);
    });
  }

  /** Submitters see their own claims; approvers see everyone's. */
  private scope(hub: HubRequestContext) {
    return hub.permissions.has('fleet.expense.approve') ? {} : { submittedBy: hub.user.id };
  }
}

/** Photos and receipts must be evidence the submitter uploaded themselves. */
async function ownEvidence(tx: TenantTx, hub: HubRequestContext, ids: readonly string[]) {
  if (ids.length === 0) return;
  const items = await tx.evidenceItem.findMany({
    where: { id: { in: [...ids] }, createdBy: hub.user.id },
    select: { id: true },
  });
  if (items.length !== new Set(ids).size) throw notFound();
}
