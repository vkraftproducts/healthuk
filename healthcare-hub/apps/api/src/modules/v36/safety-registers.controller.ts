import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import {
  affectedAllocations,
  defaultDefectOwnership,
  nextCode,
  raiseDefectAlert,
  refreshVehicleStatus,
} from '@hub/domain';
import { addDays, compareDates, londonDate, notificationTargetDate } from '@hub/rules';
import {
  AccidentClose,
  AccidentInsurer,
  AccidentLinkEvent,
  AccidentQuery,
  AccidentReport,
  CdCheckCreate,
  CdLinkEvent,
  CdWitness,
  SafeguardingNotReferred,
  SafeguardingOutcome,
  SafeguardingQuery,
  SafeguardingRaise,
  SafeguardingRefer,
  StockCheckCreate,
  StockItemCreate,
  StockItemRetire,
  type AccidentDto,
  type CdCheckDto,
  type SafeguardingReferralDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { assertNotFuture, audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import {
  assertActiveMember,
  assertVisibleEvent,
  day,
  eventCodes,
  idPipe,
  iso,
  nextRegisterCode,
  vehicleLabels,
  ymd,
} from './shared.js';

const SG_VIEW = 'events.safeguarding.view';
const SG_MANAGE = 'events.event.manage';

type ReferralRow = Prisma.SafeguardingReferralGetPayload<object>;
type AccidentRow = Prisma.VehicleAccidentGetPayload<object>;
type CdRow = Prisma.ControlledDrugCheckGetPayload<object>;

/**
 * v36 screen 37: the safeguarding referrals register. Every concern, which local authority it went
 * to with their reference, or why it was not referred, and the outcome. Visible only with
 * `events.safeguarding.view` (enforced by RLS too); changing it also needs `events.event.manage`.
 */
@Controller('safeguarding-referrals')
export class SafeguardingReferralsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(SG_VIEW)
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(SafeguardingQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.safeguardingReferral.findMany({
        where: f.status ? { status: f.status } : {},
        orderBy: { raisedOn: 'desc' },
        take: 500,
      });
      const data = await referralDtos(tx, rows);
      const all = f.status
        ? await tx.safeguardingReferral.findMany({ select: { status: true } })
        : rows;
      return {
        data,
        summary: {
          open: all.filter((r) => r.status !== 'CLOSED').length,
          undecided: all.filter((r) => r.status === 'RAISED').length,
        },
      };
    });
  }

  @RequirePermission(SG_VIEW)
  @Get(':id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<SafeguardingReferralDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.safeguardingReferral.findUnique({ where: { id } });
      if (!r) throw notFound();
      await audit(this.db, tx, hub, {
        action: 'safeguarding.referral.view',
        entity: 'safeguarding_referral',
        entityId: id,
      });
      return (await referralDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(SG_VIEW, SG_MANAGE)
  @Post()
  async raise(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(SafeguardingRaise, raw);
    if (input.raisedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date raised cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const orgId = hub.orgId as string;
      await assertActiveMember(tx, input.raisedByUserId, 'The person who raised it');
      if (input.eventId) await assertVisibleEvent(tx, input.eventId);
      const code = await nextRegisterCode(tx, orgId, 'SGR');
      let cqcNotificationId: string | null = null;
      if (input.abuseAllegation) {
        // Reg 18: an allegation of abuse is notified without delay. The hub only drafts it.
        const n = await tx.cqcNotification.create({
          data: {
            organisationId: orgId,
            code: await nextCode(tx, orgId, 'NTF'),
            kind: 'ABUSE_ALLEGATION',
            eventId: input.eventId ?? null,
            occurredOn: day(input.raisedOn),
            dueOn: day(notificationTargetDate('ABUSE_ALLEGATION', input.raisedOn)),
            summary:
              `Allegation of abuse recorded in the safeguarding register as ${code} ` +
              `(${input.about === 'CHILD' ? 'child' : 'adult'}). Check the details and submit the ` +
              'statutory notification to CQC.',
            preparedBy: hub.user.id,
          },
        });
        cqcNotificationId = n.id;
      }
      const r = await tx.safeguardingReferral.create({
        data: {
          organisationId: orgId,
          code,
          about: input.about,
          category: input.category,
          patientRef: input.patientRef,
          details: input.details,
          raisedByUserId: input.raisedByUserId,
          raisedOn: day(input.raisedOn),
          recordedBy: hub.user.id,
          eventId: input.eventId ?? null,
          abuseAllegation: input.abuseAllegation,
          cqcNotificationId,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'safeguarding.referral.raise',
        entity: 'safeguarding_referral',
        entityId: r.id,
        summary: {
          about: r.about,
          category: r.category,
          abuseAllegation: r.abuseAllegation,
          cqcNotificationDraft: !!cqcNotificationId,
        },
      });
      return (await referralDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(SG_VIEW, SG_MANAGE)
  @Post(':id/refer')
  async refer(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SafeguardingReferralDto> {
    const input = body(SafeguardingRefer, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await this.load(tx, id);
      if (r.status !== 'RAISED')
        throw new HubError('CONFLICT', 409, 'A referral decision is already recorded');
      if (input.referredOn < ymd(r.raisedOn)! || input.referredOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The referral date must be on or after the date raised and not in the future',
        );
      const saved = await tx.safeguardingReferral.update({
        where: { id },
        data: {
          status: 'REFERRED',
          referredOn: day(input.referredOn),
          agency: input.agency,
          agencyReference: input.agencyReference,
          decidedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'safeguarding.referral.refer',
        entity: 'safeguarding_referral',
        entityId: id,
      });
      return (await referralDtos(tx, [saved]))[0]!;
    });
  }

  /** The decision not to refer is recorded with its reasoning (it can be audited later). */
  @RequirePermission(SG_VIEW, SG_MANAGE)
  @Post(':id/not-referred')
  async notReferred(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SafeguardingReferralDto> {
    const input = body(SafeguardingNotReferred, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await this.load(tx, id);
      if (r.status !== 'RAISED')
        throw new HubError('CONFLICT', 409, 'A referral decision is already recorded');
      if (r.abuseAllegation)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'An allegation of abuse is always referred to the local authority',
        );
      const saved = await tx.safeguardingReferral.update({
        where: { id },
        data: { status: 'NOT_REFERRED', decisionReason: input.reason, decidedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'safeguarding.referral.not_referred',
        entity: 'safeguarding_referral',
        entityId: id,
      });
      return (await referralDtos(tx, [saved]))[0]!;
    });
  }

  @RequirePermission(SG_VIEW, SG_MANAGE)
  @Post(':id/outcome')
  async outcome(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SafeguardingReferralDto> {
    const input = body(SafeguardingOutcome, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await this.load(tx, id);
      if (r.status === 'RAISED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the referral, or the decision not to refer, first',
        );
      if (r.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'This referral is closed');
      if (input.outcomeOn < ymd(r.raisedOn)! || input.outcomeOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The outcome date must be on or after the date raised and not in the future',
        );
      const saved = await tx.safeguardingReferral.update({
        where: { id },
        data: {
          status: 'CLOSED',
          outcome: input.outcome,
          outcomeOn: day(input.outcomeOn),
          closedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'safeguarding.referral.close',
        entity: 'safeguarding_referral',
        entityId: id,
      });
      return (await referralDtos(tx, [saved]))[0]!;
    });
  }

  private async load(tx: TenantTx, id: string) {
    const r = await tx.safeguardingReferral.findUnique({ where: { id } });
    if (!r) throw notFound();
    return r;
  }
}

async function referralDtos(
  tx: TenantTx,
  rows: ReferralRow[],
): Promise<SafeguardingReferralDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.raisedByUserId, r.recordedBy, r.decidedBy, r.closedBy]),
  );
  const events = await eventCodes(
    tx,
    rows.map((r) => r.eventId),
  );
  const ntfIds = rows.map((r) => r.cqcNotificationId).filter((x): x is string => !!x);
  const ntf = ntfIds.length
    ? new Map(
        (
          await tx.cqcNotification.findMany({
            where: { id: { in: ntfIds } },
            select: { id: true, code: true },
          })
        ).map((n) => [n.id, n.code]),
      )
    : new Map<string, string>();
  const today = londonDate(new Date());
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    about: r.about as SafeguardingReferralDto['about'],
    category: r.category as SafeguardingReferralDto['category'],
    patientRef: r.patientRef,
    details: r.details,
    raisedByUserId: r.raisedByUserId,
    raisedByName: names.get(r.raisedByUserId) ?? null,
    raisedOn: ymd(r.raisedOn)!,
    recordedByName: names.get(r.recordedBy) ?? null,
    eventId: r.eventId,
    eventCode: r.eventId ? (events.get(r.eventId) ?? null) : null,
    abuseAllegation: r.abuseAllegation,
    cqcNotificationId: r.cqcNotificationId,
    cqcNotificationCode: r.cqcNotificationId ? (ntf.get(r.cqcNotificationId) ?? null) : null,
    status: r.status as SafeguardingReferralDto['status'],
    referredOn: ymd(r.referredOn),
    agency: r.agency,
    agencyReference: r.agencyReference,
    decisionReason: r.decisionReason,
    decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
    outcome: r.outcome,
    outcomeOn: ymd(r.outcomeOn),
    closedByName: r.closedBy ? (names.get(r.closedBy) ?? null) : null,
    daysUndecided:
      r.status === 'RAISED' ? Math.max(0, daysBetween(ymd(r.raisedOn)!, today)) : 0,
    version: r.version,
  }));
}

function daysBetween(from: string, to: string): number {
  let n = 0;
  let d = from;
  while (compareDates(d, to) < 0 && n < 3660) {
    d = addDays(d, 1);
    n++;
  }
  return n;
}

// ================================================================================================
/**
 * v36 screen 42, Accidents & damage. A vehicle reported as not safe to drive gets a critical
 * stop-use defect at once, so allocation and shift start are blocked by the existing gates and it
 * returns to service only through the existing defect release (someone other than the repairer).
 */
@Controller('vehicle-accidents')
export class VehicleAccidentsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: AccidentDto[] }> {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.defect.manage');
    const f = body(AccidentQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.vehicleAccident.findMany({
        where: {
          ...(f.vehicleId ? { vehicleId: f.vehicleId } : {}),
          ...(f.status ? { status: f.status } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: 500,
      });
      return { data: await accidentDtos(tx, rows) };
    });
  }

  @OrgMember()
  @Get(':id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<AccidentDto> {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.defect.manage', 'fleet.defect.create');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.vehicleAccident.findUnique({ where: { id } });
      if (!a) throw notFound();
      // Crew who reported it can see their own report; everyone else needs fleet view.
      if (
        a.reportedBy !== hub.user.id &&
        !hub.permissions.has('fleet.vehicle.view') &&
        !hub.permissions.has('fleet.defect.manage')
      )
        throw notFound();
      return (await accidentDtos(tx, [a]))[0]!;
    });
  }

  @RequirePermission('fleet.defect.create')
  @Post()
  async report(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<AccidentDto> {
    const input = body(AccidentReport, raw);
    const now = new Date();
    const occurred = new Date(input.occurredAt);
    assertNotFuture(occurred, now);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const orgId = hub.orgId as string;
      const v = await tx.vehicle.findUnique({
        where: { id: input.vehicleId },
        select: { id: true, callsign: true },
      });
      if (!v) throw notFound();
      if (input.eventId) await assertVisibleEvent(tx, input.eventId);
      if (input.photoEvidenceItemIds.length) {
        const mine = await tx.evidenceItem.count({
          where: { id: { in: input.photoEvidenceItemIds }, createdBy: hub.user.id },
        });
        if (mine !== new Set(input.photoEvidenceItemIds).size) throw notFound();
      }
      const code = await nextRegisterCode(tx, orgId, 'ACC');
      let defectId: string | null = null;
      if (!input.roadworthy) {
        const ownership = await defaultDefectOwnership(tx, orgId, 'CRITICAL', occurred);
        const d = await tx.defect.create({
          data: {
            organisationId: orgId,
            vehicleId: v.id,
            severity: 'CRITICAL',
            stopUse: true,
            description: `Accident damage (${code}): not safe to drive until repaired and released.`,
            reportedBy: hub.user.id,
            discoveredAt: occurred,
            photoEvidenceItemIds: input.photoEvidenceItemIds,
            ownerUserId: ownership.ownerUserId,
            reviewBy: ownership.reviewBy,
            repairDeadline: ownership.repairDeadline,
          },
        });
        defectId = d.id;
        await raiseDefectAlert(tx, d, v.callsign);
        await refreshVehicleStatus(tx, v.id);
        await affectedAllocations(tx, v.id, now);
        await audit(this.db, tx, hub, {
          action: 'fleet.defect.report',
          entity: 'defect',
          entityId: d.id,
          summary: { severity: 'CRITICAL', stopUse: true, vehicleId: v.id, source: 'ACCIDENT' },
        });
      }
      const a = await tx.vehicleAccident.create({
        data: {
          organisationId: orgId,
          code,
          vehicleId: v.id,
          occurredAt: occurred,
          place: input.place ?? null,
          description: input.description,
          thirdParty: input.thirdParty,
          policeRef: input.policeRef ?? null,
          injuries: input.injuries,
          eventId: input.eventId ?? null,
          photoEvidenceItemIds: input.photoEvidenceItemIds,
          roadworthy: input.roadworthy,
          defectId,
          reportedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.accident.report',
        entity: 'vehicle_accident',
        entityId: a.id,
        summary: { vehicleId: v.id, roadworthy: a.roadworthy, injuries: a.injuries, defectId },
      });
      return (await accidentDtos(tx, [a]))[0]!;
    });
  }

  @RequirePermission('fleet.defect.manage')
  @Post(':id/insurer')
  async insurer(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AccidentDto> {
    const input = body(AccidentInsurer, raw);
    if (input.insurerNotifiedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await this.openOne(tx, id);
      const saved = await tx.vehicleAccident.update({
        where: { id: a.id },
        data: { insurerRef: input.insurerRef, insurerNotifiedOn: day(input.insurerNotifiedOn) },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.accident.insurer',
        entity: 'vehicle_accident',
        entityId: id,
      });
      return (await accidentDtos(tx, [saved]))[0]!;
    });
  }

  @RequirePermission('fleet.defect.manage')
  @Post(':id/link-event')
  async linkEvent(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AccidentDto> {
    const input = body(AccidentLinkEvent, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await this.openOne(tx, id);
      if (a.eventId) throw new HubError('CONFLICT', 409, 'An incident is already linked');
      await assertVisibleEvent(tx, input.eventId);
      const saved = await tx.vehicleAccident.update({
        where: { id: a.id },
        data: { eventId: input.eventId },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.accident.link_event',
        entity: 'vehicle_accident',
        entityId: id,
        summary: { eventId: input.eventId },
      });
      return (await accidentDtos(tx, [saved]))[0]!;
    });
  }

  /** Closing is the record-keeping end: the vehicle itself is released through its defect. */
  @RequirePermission('fleet.defect.manage')
  @Post(':id/close')
  async close(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AccidentDto> {
    const input = body(AccidentClose, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await this.openOne(tx, id);
      if (a.defectId) {
        const d = await tx.defect.findUnique({
          where: { id: a.defectId },
          select: { status: true },
        });
        if (d?.status !== 'RELEASED')
          throw new HubError(
            'TRANSITION_NOT_ALLOWED',
            422,
            'The vehicle has not been released after repair yet',
          );
      }
      if (a.injuries && !a.eventId)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Someone was hurt: link the incident report before closing',
        );
      const saved = await tx.vehicleAccident.update({
        where: { id: a.id },
        data: {
          status: 'CLOSED',
          closeNote: input.note,
          closedBy: hub.user.id,
          closedAt: new Date(),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.accident.close',
        entity: 'vehicle_accident',
        entityId: id,
      });
      return (await accidentDtos(tx, [saved]))[0]!;
    });
  }

  private async openOne(tx: TenantTx, id: string) {
    const a = await tx.vehicleAccident.findUnique({ where: { id } });
    if (!a) throw notFound();
    if (a.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'This accident is closed');
    return a;
  }
}

async function accidentDtos(tx: TenantTx, rows: AccidentRow[]): Promise<AccidentDto[]> {
  const defectIds = rows.map((r) => r.defectId).filter((x): x is string => !!x);
  const defects = defectIds.length
    ? await tx.defect.findMany({
        where: { id: { in: defectIds } },
        select: { id: true, status: true, release: { select: { releasedBy: true } } },
      })
    : [];
  const dmap = new Map(defects.map((d) => [d.id, d]));
  const names = await userNames(tx, [
    ...rows.flatMap((r) => [r.reportedBy, r.closedBy]),
    ...defects.map((d) => d.release?.releasedBy ?? null),
  ]);
  const vehicles = await vehicleLabels(
    tx,
    rows.map((r) => r.vehicleId),
  );
  const events = await eventCodes(
    tx,
    rows.map((r) => r.eventId),
  );
  return rows.map((r) => {
    const d = r.defectId ? dmap.get(r.defectId) : undefined;
    const defectStatus = d ? String(d.status) : null;
    const stateText =
      r.status === 'CLOSED'
        ? 'Closed'
        : !r.defectId
          ? 'Safe to drive – damage recorded'
          : defectStatus === 'RELEASED'
            ? 'Repaired and released – ready to close'
            : defectStatus === 'REPAIRED'
              ? 'Repaired – waiting for someone else to release'
              : defectStatus === 'REPAIRING'
                ? 'Off the road – being repaired'
                : 'Off the road – awaiting repair';
    return {
      id: r.id,
      code: r.code,
      vehicleId: r.vehicleId,
      vehicleLabel: vehicles.get(r.vehicleId) ?? 'Vehicle',
      occurredAt: r.occurredAt.toISOString(),
      place: r.place,
      description: r.description,
      thirdParty: r.thirdParty,
      policeRef: r.policeRef,
      injuries: r.injuries,
      eventId: r.eventId,
      eventCode: r.eventId ? (events.get(r.eventId) ?? null) : null,
      photoCount: r.photoEvidenceItemIds.length,
      roadworthy: r.roadworthy,
      defectId: r.defectId,
      defectStatus,
      releasedByName: d?.release ? (names.get(d.release.releasedBy) ?? null) : null,
      insurerRef: r.insurerRef,
      insurerNotifiedOn: ymd(r.insurerNotifiedOn),
      reportedByName: names.get(r.reportedBy) ?? null,
      status: r.status as AccidentDto['status'],
      stateText,
      closeNote: r.closeNote,
      closedByName: r.closedBy ? (names.get(r.closedBy) ?? null) : null,
      closedAt: iso(r.closedAt),
      version: r.version,
    };
  });
}

// ================================================================================================
/**
 * v36 screen 42, Medicines & gases. What each vehicle should carry, and stock checks against it:
 * quantity, earliest expiry and seals. Giving medicines to patients is outside the system.
 */
@Controller('vehicle-stock')
export class VehicleStockController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.vdi.submit');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [vehicles, items, checks] = await Promise.all([
        tx.vehicle.findMany({
          select: { id: true, callsign: true },
          orderBy: { callsign: 'asc' },
        }),
        tx.vehicleStockItem.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
        tx.vehicleStockCheck.findMany({ orderBy: { checkedAt: 'desc' }, take: 1000 }),
      ]);
      const latest = new Map<string, (typeof checks)[number]>();
      for (const c of checks) if (!latest.has(c.vehicleId)) latest.set(c.vehicleId, c);
      const names = await userNames(
        tx,
        [...latest.values()].map((c) => c.checkedBy),
      );
      const today = londonDate(new Date());
      return {
        data: vehicles.map((v) => {
          const last = latest.get(v.id);
          const lines = (last?.lines ?? []) as unknown as StoredLine[];
          return {
            vehicleId: v.id,
            vehicleLabel: v.callsign,
            items: items
              .filter((i) => i.vehicleId === v.id)
              .map((i) => itemDto(i, lines.find((l) => l.itemId === i.id), last, today)),
            lastCheck: last
              ? {
                  id: last.id,
                  checkedAt: last.checkedAt.toISOString(),
                  checkedByName: names.get(last.checkedBy) ?? null,
                  shortCount: last.shortCount,
                  expiredCount: last.expiredCount,
                  sealBrokenCount: last.sealBrokenCount,
                }
              : null,
          };
        }),
      };
    });
  }

  @RequirePermission('fleet.vehicle.manage')
  @Post('items')
  async addItem(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(StockItemCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId }, select: { id: true } });
      if (!v) throw notFound();
      const dup = await tx.vehicleStockItem.count({
        where: {
          vehicleId: v.id,
          active: true,
          name: { equals: input.name, mode: 'insensitive' },
        },
      });
      if (dup) throw new HubError('CONFLICT', 409, 'This vehicle already has an item with that name');
      const i = await tx.vehicleStockItem.create({
        data: {
          organisationId: hub.orgId as string,
          vehicleId: v.id,
          kind: input.kind,
          name: input.name,
          expectedQty: input.expectedQty,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.stock.item_add',
        entity: 'vehicle_stock_item',
        entityId: i.id,
        summary: { vehicleId: v.id, kind: i.kind, expectedQty: i.expectedQty },
      });
      return itemDto(i, undefined, undefined, londonDate(new Date()));
    });
  }

  @RequirePermission('fleet.vehicle.manage')
  @Post('items/:id/retire')
  async retireItem(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    body(StockItemRetire, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const i = await tx.vehicleStockItem.findUnique({ where: { id } });
      if (!i) throw notFound();
      if (!i.active) throw new HubError('CONFLICT', 409, 'This item is already removed');
      const saved = await tx.vehicleStockItem.update({
        where: { id },
        data: { active: false, retiredBy: hub.user.id, retiredAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.stock.item_retire',
        entity: 'vehicle_stock_item',
        entityId: id,
      });
      return itemDto(saved, undefined, undefined, londonDate(new Date()));
    });
  }

  @OrgMember()
  @Get('checks')
  async checks(@Hub() hub: HubRequestContext, @Query('vehicleId') vehicleId?: string) {
    requireAny(hub, 'fleet.vehicle.view', 'fleet.vdi.submit');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.vehicleStockCheck.findMany({
        where: vehicleId && /^[0-9a-f-]{36}$/i.test(vehicleId) ? { vehicleId } : {},
        orderBy: { checkedAt: 'desc' },
        take: 200,
      });
      const names = await userNames(
        tx,
        rows.map((r) => r.checkedBy),
      );
      return { data: rows.map((r) => checkDto(r, names)) };
    });
  }

  /** Crew and the fleet lead record a check of every listed item on one vehicle. */
  @OrgMember()
  @Post('checks')
  async check(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    requireAny(hub, 'fleet.vdi.submit', 'fleet.vehicle.manage');
    const input = body(StockCheckCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId }, select: { id: true } });
      if (!v) throw notFound();
      const items = await tx.vehicleStockItem.findMany({
        where: { vehicleId: v.id, active: true },
      });
      if (items.length === 0)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'This vehicle has no medicines or gases listed to check',
        );
      const given = new Map(input.lines.map((l) => [l.itemId, l]));
      if (given.size !== input.lines.length)
        throw new HubError('VALIDATION_FAILED', 400, 'Each item can be counted only once');
      const missing = items.filter((i) => !given.has(i.id));
      if (missing.length || given.size !== items.length)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Count every item listed for this vehicle, and only those',
        );
      const today = londonDate(new Date());
      const lines: StoredLine[] = items.map((i) => {
        const l = given.get(i.id)!;
        return {
          itemId: i.id,
          name: i.name,
          kind: i.kind,
          expected: i.expectedQty,
          found: l.found,
          expiresOn: l.expiresOn,
          sealIntact: i.kind === 'MEDICINE' ? true : l.sealIntact,
        };
      });
      const c = await tx.vehicleStockCheck.create({
        data: {
          organisationId: hub.orgId as string,
          vehicleId: v.id,
          checkedBy: hub.user.id,
          lines: lines as unknown as Prisma.InputJsonValue,
          shortCount: lines.filter((l) => l.found < l.expected).length,
          expiredCount: lines.filter((l) => compareDates(l.expiresOn, today) < 0).length,
          sealBrokenCount: lines.filter((l) => !l.sealIntact).length,
          note: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.stock.check',
        entity: 'vehicle_stock_check',
        entityId: c.id,
        summary: {
          vehicleId: v.id,
          short: c.shortCount,
          expired: c.expiredCount,
          sealBroken: c.sealBrokenCount,
        },
      });
      return checkDto(c, await userNames(tx, [c.checkedBy]));
    });
  }
}

interface StoredLine {
  itemId: string;
  name: string;
  kind: string;
  expected: number;
  found: number;
  expiresOn: string;
  sealIntact: boolean;
}

function itemDto(
  i: Prisma.VehicleStockItemGetPayload<object>,
  line: StoredLine | undefined,
  last: { checkedAt: Date } | undefined,
  today: string,
) {
  const soon = addDays(today, 30);
  const state = !line
    ? 'NOT_CHECKED'
    : !line.sealIntact
      ? 'SEAL_BROKEN'
      : compareDates(line.expiresOn, today) < 0
        ? 'EXPIRED'
        : line.found < i.expectedQty
          ? 'SHORT'
          : compareDates(line.expiresOn, soon) <= 0
            ? 'EXPIRING'
            : 'OK';
  const text: Record<string, string> = {
    NOT_CHECKED: 'Not checked yet',
    SEAL_BROKEN: 'Seal broken – replace',
    EXPIRED: 'Expired – replace',
    SHORT: line ? `Short – ${line.found} of ${i.expectedQty}` : 'Short',
    EXPIRING: 'Expires within 30 days',
    OK: 'Present and in date',
  };
  return {
    id: i.id,
    vehicleId: i.vehicleId,
    kind: i.kind as 'MEDICAL_GAS' | 'MEDICINE' | 'SEALED_POUCH',
    name: i.name,
    expectedQty: i.expectedQty,
    lastFound: line?.found ?? null,
    lastExpiresOn: line?.expiresOn ?? null,
    lastSealIntact: line ? line.sealIntact : null,
    lastCheckedAt: line && last ? last.checkedAt.toISOString() : null,
    state: state as
      | 'NOT_CHECKED'
      | 'OK'
      | 'SHORT'
      | 'EXPIRING'
      | 'EXPIRED'
      | 'SEAL_BROKEN',
    stateText: text[state]!,
  };
}

function checkDto(r: Prisma.VehicleStockCheckGetPayload<object>, names: Map<string, string>) {
  return {
    id: r.id,
    vehicleId: r.vehicleId,
    checkedAt: r.checkedAt.toISOString(),
    checkedByName: names.get(r.checkedBy) ?? null,
    shortCount: r.shortCount,
    expiredCount: r.expiredCount,
    sealBrokenCount: r.sealBrokenCount,
    note: r.note,
    lines: ((r.lines ?? []) as unknown as StoredLine[]).map((l) => ({
      itemId: l.itemId,
      name: l.name,
      expected: l.expected,
      found: l.found,
      expiresOn: l.expiresOn,
      sealIntact: l.sealIntact,
    })),
  };
}

// ================================================================================================
const CD_RECORD = ['fleet.vdi.submit', 'compliance.audit.run', 'fleet.vehicle.manage'];
const CD_VIEW = [...CD_RECORD, 'compliance.audit.view'];

/**
 * v36 screen 42, Controlled drugs – balance checks. The person counting records the check and
 * names a witness; the witness signs it themselves. A difference (or a refused witness) stays
 * flagged until an incident is linked.
 */
@Controller('controlled-drug-checks')
export class ControlledDrugChecksController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext): Promise<{ data: CdCheckDto[] }> {
    requireAny(hub, ...CD_VIEW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.controlledDrugCheck.findMany({
        orderBy: { checkedAt: 'desc' },
        take: 500,
      });
      return { data: await cdDtos(tx, rows, hub.user.id) };
    });
  }

  @OrgMember()
  @Post()
  async record(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<CdCheckDto> {
    requireAny(hub, ...CD_RECORD);
    const input = body(CdCheckCreate, raw);
    if (input.witnessUserId === hub.user.id)
      throw new HubError('FOUR_EYES_REQUIRED', 422, 'The witness must be a different person');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertActiveMember(tx, input.witnessUserId, 'The witness');
      if (input.vehicleId) {
        const v = await tx.vehicle.count({ where: { id: input.vehicleId } });
        if (!v) throw notFound();
      }
      const c = await tx.controlledDrugCheck.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextRegisterCode(tx, hub.orgId as string, 'CDR'),
          drug: input.drug,
          store: input.store,
          vehicleId: input.vehicleId ?? null,
          registerBalance: input.registerBalance,
          countedBalance: input.countedBalance,
          checkedBy: hub.user.id,
          witnessUserId: input.witnessUserId,
          note: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'cd.check.record',
        entity: 'controlled_drug_check',
        entityId: c.id,
        summary: { discrepancy: c.registerBalance !== c.countedBalance },
      });
      return (await cdDtos(tx, [c], hub.user.id))[0]!;
    });
  }

  /** Only the named witness can sign; agreeing confirms the count, refusing needs a reason. */
  @OrgMember()
  @Post(':id/witness')
  async witness(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CdCheckDto> {
    requireAny(hub, ...CD_VIEW);
    const input = body(CdWitness, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.controlledDrugCheck.findUnique({ where: { id } });
      if (!c) throw notFound();
      if (c.witnessUserId !== hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'Only the named witness can sign this check');
      if (c.status !== 'AWAITING_WITNESS')
        throw new HubError('CONFLICT', 409, 'The witness has already signed');
      if (!input.agree && !input.note)
        throw new HubError('VALIDATION_FAILED', 400, 'Say why you cannot witness this count');
      const saved = await tx.controlledDrugCheck.update({
        where: { id },
        data: {
          status: input.agree ? 'WITNESSED' : 'WITNESS_REFUSED',
          witnessedAt: new Date(),
          witnessNote: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: input.agree ? 'cd.check.witness' : 'cd.check.witness_refuse',
        entity: 'controlled_drug_check',
        entityId: id,
      });
      return (await cdDtos(tx, [saved], hub.user.id))[0]!;
    });
  }

  @OrgMember()
  @Post(':id/link-event')
  async linkEvent(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CdCheckDto> {
    requireAny(hub, 'events.event.manage', 'compliance.audit.run');
    const input = body(CdLinkEvent, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.controlledDrugCheck.findUnique({ where: { id } });
      if (!c) throw notFound();
      if (c.eventId) throw new HubError('CONFLICT', 409, 'An incident is already linked');
      await assertVisibleEvent(tx, input.eventId);
      const saved = await tx.controlledDrugCheck.update({
        where: { id },
        data: { eventId: input.eventId },
      });
      await audit(this.db, tx, hub, {
        action: 'cd.check.link_event',
        entity: 'controlled_drug_check',
        entityId: id,
        summary: { eventId: input.eventId },
      });
      return (await cdDtos(tx, [saved], hub.user.id))[0]!;
    });
  }
}

async function cdDtos(tx: TenantTx, rows: CdRow[], me: string): Promise<CdCheckDto[]> {
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.checkedBy, r.witnessUserId]),
  );
  const vehicles = await vehicleLabels(
    tx,
    rows.map((r) => r.vehicleId),
  );
  const events = await eventCodes(
    tx,
    rows.map((r) => r.eventId),
  );
  return rows.map((r) => {
    const discrepancy = r.registerBalance !== r.countedBalance;
    return {
      id: r.id,
      code: r.code,
      drug: r.drug,
      store: r.store,
      vehicleId: r.vehicleId,
      vehicleLabel: r.vehicleId ? (vehicles.get(r.vehicleId) ?? null) : null,
      registerBalance: r.registerBalance,
      countedBalance: r.countedBalance,
      discrepancy,
      checkedByName: names.get(r.checkedBy) ?? null,
      checkedAt: r.checkedAt.toISOString(),
      witnessUserId: r.witnessUserId,
      witnessName: names.get(r.witnessUserId) ?? null,
      status: r.status as CdCheckDto['status'],
      witnessedAt: iso(r.witnessedAt),
      witnessNote: r.witnessNote,
      eventId: r.eventId,
      eventCode: r.eventId ? (events.get(r.eventId) ?? null) : null,
      needsIncident: (discrepancy || r.status === 'WITNESS_REFUSED') && !r.eventId,
      note: r.note,
      awaitingMe: r.status === 'AWAITING_WITNESS' && r.witnessUserId === me,
    };
  });
}
