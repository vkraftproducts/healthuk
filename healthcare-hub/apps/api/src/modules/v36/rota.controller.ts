import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Prisma, type Db, type TenantTx } from '@hub/db';
import { overlapText, recheckAllocations } from '@hub/domain';
import { addDays, londonDateTime, rotaWarnings, startOfLondonDay } from '@hub/rules';
import {
  ClockIn,
  ClockOut,
  HoursQuery,
  OpenShiftCancel,
  OpenShiftFill,
  OpenShiftPost,
  PatternCreate,
  PatternDatesQuery,
  StaffRole,
  SwapDecide,
  SwapRequest,
  TimeCorrect,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { idPipe, iso, myStaffId, nextRegisterCode, vehicleLabels } from './shared.js';
import { nextV36Code } from './sync/staff-lib.js';

const ALLOCATE = 'jobs.allocate';
const PLAN_VIEW = 'jobs.job.view';
const CREW = 'crew.today.view';
const MIN = 60_000;

const isExclusion = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  /23P01|exclusion|no_overlap/i.test(`${e.code} ${e.message}`);
const doubleBooked = (e: unknown): never => {
  if (isExclusion(e))
    throw new HubError(
      'CONFLICT',
      409,
      'That person is already booked on another shift at an overlapping time',
    );
  throw e;
};

/** A shift that has not started, ended or been cancelled. */
async function plannedShift(tx: TenantTx, id: string) {
  const s = await tx.shift.findUnique({ where: { id } });
  if (!s) throw notFound();
  if (s.state !== 'PLANNED')
    throw new HubError('CONFLICT', 409, 'The shift has started, ended or been cancelled');
  return s;
}

/**
 * Puts a person on a shift the same way the planner does (jobs.controller `addCrew`): no leavers,
 * inside the shift window, not twice on the same shift, and never double-booked (the database's
 * exclusion constraint on resource_booking is the final check).
 */
async function assignCrew(
  tx: TenantTx,
  by: string,
  s: { id: string; organisationId: string; startsAt: Date; endsAt: Date },
  c: { staffId: string; role: string; startsAt: Date; endsAt: Date },
) {
  const staff = await tx.staff.findUnique({ where: { id: c.staffId } });
  if (!staff) throw notFound();
  if (staff.lifecycleState === 'LEAVER')
    throw new HubError('VALIDATION_FAILED', 400, 'A leaver cannot be rostered');
  if (c.startsAt < s.startsAt || c.endsAt > s.endsAt || c.endsAt <= c.startsAt)
    throw new HubError('VALIDATION_FAILED', 400, 'Crew time must fall within the shift');
  const already = await tx.crewAssignment.count({
    where: {
      shiftId: s.id,
      staffId: c.staffId,
      active: true,
      startsAt: { lt: c.endsAt },
      endsAt: { gt: c.startsAt },
    },
  });
  if (already)
    throw new HubError(
      'VALIDATION_FAILED',
      400,
      `${staff.displayName} is already on this shift at that time`,
    );
  const clash = await overlapText(tx, {
    resourceType: 'STAFF',
    resourceId: c.staffId,
    start: c.startsAt,
    end: c.endsAt,
    ignoreShiftId: s.id,
  });
  if (clash) throw new HubError('CONFLICT', 409, clash);
  const a = await tx.crewAssignment.create({
    data: {
      organisationId: s.organisationId,
      shiftId: s.id,
      staffId: c.staffId,
      role: c.role as never,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      createdBy: by,
    },
  });
  await tx.resourceBooking.create({
    data: {
      organisationId: s.organisationId,
      resourceType: 'STAFF',
      resourceId: c.staffId,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      sourceType: 'CREW',
      sourceId: a.id,
    },
  });
  await tx.shiftChange.create({
    data: {
      organisationId: s.organisationId,
      shiftId: s.id,
      kind: 'CREW_ADD',
      details: { staffId: c.staffId, role: c.role },
      byUserId: by,
    },
  });
  return a;
}

/** Withdraws an assignment that has not started yet (history kept), as the planner does. */
async function withdrawAssignment(
  tx: TenantTx,
  by: string,
  a: { id: string; organisationId: string; shiftId: string; staffId: string; role: string },
  reason: string,
  swappedFor: string,
) {
  await tx.crewAssignment.update({
    where: { id: a.id },
    data: { active: false, endedReason: reason },
  });
  await tx.resourceBooking.updateMany({
    where: { sourceType: 'CREW', sourceId: a.id, active: true },
    data: { active: false },
  });
  await tx.shiftChange.create({
    data: {
      organisationId: a.organisationId,
      shiftId: a.shiftId,
      kind: 'CREW_END',
      details: { staffId: a.staffId, role: a.role, swappedFor },
      reason,
      byUserId: by,
    },
  });
}

async function staffNames(tx: TenantTx, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, { name: string; userId: string | null }>();
  const rows = await tx.staff.findMany({
    where: { id: { in: want } },
    select: { id: true, displayName: true, userId: true },
  });
  return new Map(rows.map((r) => [r.id, { name: r.displayName, userId: r.userId }]));
}

// ================================================================================================
type OpenRow = Prisma.OpenShiftGetPayload<{ include: { offers: true } }>;

/**
 * v36 screen 34, Open shifts. Control posts a gap on a planned shift; staff offer to cover it;
 * control fills it, which puts the person on the shift with the planner's own checks.
 */
@Controller('open-shifts')
export class OpenShiftsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, PLAN_VIEW, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const planner = hub.permissions.has(PLAN_VIEW);
      const rows = await tx.openShift.findMany({
        where: planner
          ? { endsAt: { gt: new Date(Date.now() - 14 * 24 * 60 * MIN) } }
          : { status: 'OPEN', startsAt: { gt: new Date() } },
        include: { offers: true },
        orderBy: [{ status: 'asc' }, { startsAt: 'asc' }],
        take: 500,
      });
      return { data: await this.dtos(tx, rows, hub, planner) };
    });
  }

  @RequirePermission(ALLOCATE)
  @Post()
  async post(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(OpenShiftPost, raw);
    const role = StaffRole.safeParse(input.role);
    if (!role.success) throw new HubError('VALIDATION_FAILED', 400, 'Choose a valid role');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await plannedShift(tx, input.shiftId);
      const start = input.startsAt ? new Date(input.startsAt) : s.startsAt;
      const end = input.endsAt ? new Date(input.endsAt) : s.endsAt;
      if (start < s.startsAt || end > s.endsAt || end <= start)
        throw new HubError('VALIDATION_FAILED', 400, 'The open time must fall within the shift');
      if (end <= new Date())
        throw new HubError('VALIDATION_FAILED', 400, 'This time has already passed');
      const o = await tx.openShift.create({
        data: {
          organisationId: s.organisationId,
          code: await nextRegisterCode(tx, s.organisationId, 'OS'),
          shiftId: s.id,
          role: role.data as never,
          startsAt: start,
          endsAt: end,
          note: input.note ?? null,
          postedBy: hub.user.id,
        },
        include: { offers: true },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.open_shift.post',
        entity: 'open_shift',
        entityId: o.id,
        summary: { shiftId: s.id, role: role.data },
      });
      return (await this.dtos(tx, [o], hub, true))[0]!;
    });
  }

  /** Staff offer to cover an open shift (their own staff record only). */
  @OrgMember()
  @Post(':id/offer')
  async offer(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    requireAny(hub, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await this.openOne(tx, id);
      const me = await myStaffId(tx, hub.user.id);
      if (!me) throw new HubError('VALIDATION_FAILED', 400, 'You have no staff record here');
      const onShift = await tx.crewAssignment.count({
        where: { shiftId: o.shiftId, staffId: me, active: true },
      });
      if (onShift) throw new HubError('CONFLICT', 409, 'You are already on this shift');
      const prior = o.offers.find((x) => x.staffId === me);
      if (prior)
        throw new HubError(
          'CONFLICT',
          409,
          prior.withdrawnAt ? 'You withdrew your offer for this shift' : 'You have already offered',
        );
      await tx.openShiftOffer.create({
        data: {
          organisationId: o.organisationId,
          openShiftId: o.id,
          staffId: me,
          offeredBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.open_shift.offer',
        entity: 'open_shift',
        entityId: id,
      });
      const fresh = await tx.openShift.findUniqueOrThrow({ where: { id }, include: { offers: true } });
      return (await this.dtos(tx, [fresh], hub, hub.permissions.has(PLAN_VIEW)))[0]!;
    });
  }

  @OrgMember()
  @Post(':id/withdraw-offer')
  async withdrawOffer(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    requireAny(hub, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const o = await this.openOne(tx, id);
      const me = await myStaffId(tx, hub.user.id);
      const mine = o.offers.find((x) => x.staffId === me && !x.withdrawnAt);
      if (!mine) throw notFound();
      await tx.openShiftOffer.update({ where: { id: mine.id }, data: { withdrawnAt: new Date() } });
      await audit(this.db, tx, hub, {
        action: 'rota.open_shift.withdraw_offer',
        entity: 'open_shift',
        entityId: id,
      });
      const fresh = await tx.openShift.findUniqueOrThrow({ where: { id }, include: { offers: true } });
      return (await this.dtos(tx, [fresh], hub, hub.permissions.has(PLAN_VIEW)))[0]!;
    });
  }

  @RequirePermission(ALLOCATE)
  @Post(':id/fill')
  async fill(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(OpenShiftFill, raw);
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const o = await this.openOne(tx, id);
        const s = await plannedShift(tx, o.shiftId);
        const a = await assignCrew(tx, hub.user.id, s, {
          staffId: input.staffId,
          role: String(o.role),
          startsAt: o.startsAt,
          endsAt: o.endsAt,
        });
        const saved = await tx.openShift.update({
          where: { id },
          data: {
            status: 'FILLED',
            filledStaffId: input.staffId,
            filledAssignmentId: a.id,
            filledBy: hub.user.id,
            filledAt: new Date(),
          },
          include: { offers: true },
        });
        await audit(this.db, tx, hub, {
          action: 'rota.open_shift.fill',
          entity: 'open_shift',
          entityId: id,
          summary: { staffId: input.staffId, shiftId: s.id },
        });
        return (await this.dtos(tx, [saved], hub, true))[0]!;
      })
      .catch(doubleBooked);
  }

  @RequirePermission(ALLOCATE)
  @Post(':id/cancel')
  async cancel(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(OpenShiftCancel, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.openOne(tx, id);
      const saved = await tx.openShift.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: input.reason },
        include: { offers: true },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.open_shift.cancel',
        entity: 'open_shift',
        entityId: id,
      });
      return (await this.dtos(tx, [saved], hub, true))[0]!;
    });
  }

  private async openOne(tx: TenantTx, id: string) {
    const o = await tx.openShift.findUnique({ where: { id }, include: { offers: true } });
    if (!o) throw notFound();
    if (o.status !== 'OPEN')
      throw new HubError('CONFLICT', 409, 'This open shift is already filled or cancelled');
    return o;
  }

  private async dtos(tx: TenantTx, rows: OpenRow[], hub: HubRequestContext, planner: boolean) {
    const shifts = await tx.shift.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.shiftId))] } },
      select: { id: true, vehicleId: true },
    });
    const vehicleOf = new Map(shifts.map((s) => [s.id, s.vehicleId]));
    const vehicles = await vehicleLabels(
      tx,
      shifts.map((s) => s.vehicleId),
    );
    const staff = await staffNames(tx, [
      ...rows.flatMap((r) => r.offers.map((o) => o.staffId)),
      ...rows.map((r) => r.filledStaffId),
    ]);
    const users = await userNames(
      tx,
      rows.flatMap((r) => [r.postedBy, r.filledBy]),
    );
    const me = await myStaffId(tx, hub.user.id);
    return rows.map((r) => {
      const live = r.offers.filter((o) => !o.withdrawnAt);
      return {
        id: r.id,
        code: r.code,
        shiftId: r.shiftId,
        vehicleLabel: vehicles.get(vehicleOf.get(r.shiftId) ?? '') ?? 'Vehicle',
        role: String(r.role),
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        note: r.note,
        status: r.status as 'OPEN' | 'FILLED' | 'CANCELLED',
        postedByName: users.get(r.postedBy) ?? null,
        offers: (planner ? live : live.filter((o) => o.staffId === me)).map((o) => ({
          staffId: o.staffId,
          staffName: staff.get(o.staffId)?.name ?? 'Unknown',
          offeredAt: o.offeredAt.toISOString(),
          mine: o.staffId === me,
        })),
        filledStaffName: r.filledStaffId ? (staff.get(r.filledStaffId)?.name ?? null) : null,
        filledByName: r.filledBy ? (users.get(r.filledBy) ?? null) : null,
        filledAt: iso(r.filledAt),
        cancelReason: r.cancelReason,
        offeredByMe: live.some((o) => o.staffId === me),
      };
    });
  }
}

// ================================================================================================
type SwapRow = Prisma.ShiftSwapRequestGetPayload<object>;

/**
 * v36 screen 34, Swaps. Crew ask to swap one of their planned shifts with a colleague's; the
 * colleague agrees on their own account; control or a manager approves (never anyone in the
 * swap). Approval swaps both assignments at once with the planner's checks; working-time prompts
 * for both people are shown and kept.
 */
@Controller('shift-swaps')
export class ShiftSwapsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, PLAN_VIEW, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const planner = hub.permissions.has(PLAN_VIEW);
      const me = await myStaffId(tx, hub.user.id);
      if (!planner && !me) return { data: [] };
      const rows = await tx.shiftSwapRequest.findMany({
        where: planner ? {} : { OR: [{ fromStaffId: me! }, { toStaffId: me! }] },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      return { data: await this.dtos(tx, rows, hub) };
    });
  }

  /** What the caller could swap: their planned shifts and colleagues' in the next 28 days. */
  @RequirePermission(CREW)
  @Get('options')
  async options(@Hub() hub: HubRequestContext) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const me = await myStaffId(tx, hub.user.id);
      if (!me) return { mine: [], colleagues: [] };
      const now = new Date();
      const rows = await tx.crewAssignment.findMany({
        where: {
          active: true,
          startsAt: { gt: now, lt: new Date(now.getTime() + 28 * 24 * 60 * MIN) },
          shift: { state: 'PLANNED' },
        },
        include: { shift: { select: { vehicleId: true } } },
        orderBy: { startsAt: 'asc' },
        take: 1000,
      });
      const vehicles = await vehicleLabels(
        tx,
        rows.map((r) => r.shift.vehicleId),
      );
      const staff = await staffNames(
        tx,
        rows.map((r) => r.staffId),
      );
      const dto = (a: (typeof rows)[number]) => ({
        assignmentId: a.id,
        staffId: a.staffId,
        staffName: staff.get(a.staffId)?.name ?? 'Unknown',
        role: String(a.role),
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
        vehicleLabel: vehicles.get(a.shift.vehicleId) ?? 'Vehicle',
      });
      return {
        mine: rows.filter((r) => r.staffId === me).map(dto),
        colleagues: rows.filter((r) => r.staffId !== me).map(dto),
      };
    });
  }

  @OrgMember()
  @Post()
  async request(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    requireAny(hub, CREW);
    const input = body(SwapRequest, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const me = await myStaffId(tx, hub.user.id);
      if (!me) throw new HubError('VALIDATION_FAILED', 400, 'You have no staff record here');
      const [a, b] = await Promise.all([
        tx.crewAssignment.findUnique({ where: { id: input.fromAssignmentId } }),
        tx.crewAssignment.findUnique({ where: { id: input.toAssignmentId } }),
      ]);
      if (!a || !b) throw notFound();
      if (a.staffId !== me)
        throw new HubError('FORBIDDEN', 403, 'You can only offer one of your own shifts');
      if (b.staffId === me) throw new HubError('VALIDATION_FAILED', 400, 'Choose a colleague’s shift');
      await this.assertSwappable(tx, a);
      await this.assertSwappable(tx, b);
      const open = await tx.shiftSwapRequest.count({
        where: { fromAssignmentId: a.id, status: { in: ['REQUESTED', 'AGREED'] } },
      });
      if (open) throw new HubError('CONFLICT', 409, 'You have already asked to swap this shift');
      const r = await tx.shiftSwapRequest.create({
        data: {
          organisationId: a.organisationId,
          code: await nextV36Code(tx, a.organisationId, 'SW', 'shift_swap_request', 2),
          fromAssignmentId: a.id,
          toAssignmentId: b.id,
          fromStaffId: a.staffId,
          toStaffId: b.staffId,
          reason: input.reason,
          requestedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.swap.request',
        entity: 'shift_swap_request',
        entityId: r.id,
      });
      return (await this.dtos(tx, [r], hub))[0]!;
    });
  }

  /** The colleague agrees (or declines) on their own account. */
  @OrgMember()
  @Post(':id/agree')
  async agree(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.colleague(hub, id, true);
  }

  @OrgMember()
  @Post(':id/decline')
  async decline(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.colleague(hub, id, false);
  }

  @OrgMember()
  @Post(':id/withdraw')
  async withdraw(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    requireAny(hub, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await this.live(tx, id);
      if (r.requestedBy !== hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'Only the person who asked can withdraw it');
      const saved = await tx.shiftSwapRequest.update({ where: { id }, data: { status: 'WITHDRAWN' } });
      await audit(this.db, tx, hub, {
        action: 'rota.swap.withdraw',
        entity: 'shift_swap_request',
        entityId: id,
      });
      return (await this.dtos(tx, [saved], hub))[0]!;
    });
  }

  @RequirePermission(ALLOCATE)
  @Post(':id/decide')
  async decide(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(SwapDecide, raw);
    if (!input.approve && !input.note)
      throw new HubError('VALIDATION_FAILED', 400, 'Say why the swap is refused');
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const r = await this.live(tx, id);
        const people = await staffNames(tx, [r.fromStaffId, r.toStaffId]);
        if (
          r.requestedBy === hub.user.id ||
          people.get(r.fromStaffId)?.userId === hub.user.id ||
          people.get(r.toStaffId)?.userId === hub.user.id
        )
          throw new HubError('SELF_APPROVAL', 422, 'Someone not in the swap must decide it');
        if (!input.approve) {
          const saved = await tx.shiftSwapRequest.update({
            where: { id },
            data: {
              status: 'REFUSED',
              decidedBy: hub.user.id,
              decidedAt: new Date(),
              decisionNote: input.note!,
            },
          });
          await audit(this.db, tx, hub, {
            action: 'rota.swap.refuse',
            entity: 'shift_swap_request',
            entityId: id,
          });
          return (await this.dtos(tx, [saved], hub))[0]!;
        }
        if (r.status !== 'AGREED')
          throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'The colleague has not agreed yet');
        const [a, b] = await Promise.all([
          tx.crewAssignment.findUniqueOrThrow({ where: { id: r.fromAssignmentId } }),
          tx.crewAssignment.findUniqueOrThrow({ where: { id: r.toAssignmentId } }),
        ]);
        const sa = await this.assertSwappable(tx, a);
        const sb = await this.assertSwappable(tx, b);
        const reason = `Shift swap ${r.code}`;
        await withdrawAssignment(tx, hub.user.id, a, reason, b.staffId);
        await withdrawAssignment(tx, hub.user.id, b, reason, a.staffId);
        await assignCrew(tx, hub.user.id, sa, {
          staffId: b.staffId,
          role: String(a.role),
          startsAt: a.startsAt,
          endsAt: a.endsAt,
        });
        await assignCrew(tx, hub.user.id, sb, {
          staffId: a.staffId,
          role: String(b.role),
          startsAt: b.startsAt,
          endsAt: b.endsAt,
        });
        const now = new Date();
        await recheckAllocations(tx, a.organisationId, now, { shiftId: sa.id });
        await recheckAllocations(tx, a.organisationId, now, { shiftId: sb.id });
        const warnings = await workingTimeWarnings(tx, [a.staffId, b.staffId], a.startsAt, b.startsAt);
        const saved = await tx.shiftSwapRequest.update({
          where: { id },
          data: {
            status: 'APPROVED',
            decidedBy: hub.user.id,
            decidedAt: now,
            decisionNote: input.note ?? null,
            warnings,
          },
        });
        await audit(this.db, tx, hub, {
          action: 'rota.swap.approve',
          entity: 'shift_swap_request',
          entityId: id,
          summary: { warnings: warnings.length },
        });
        return (await this.dtos(tx, [saved], hub))[0]!;
      })
      .catch(doubleBooked);
  }

  private async colleague(hub: HubRequestContext, id: string, agree: boolean) {
    requireAny(hub, CREW);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await this.live(tx, id);
      const me = await myStaffId(tx, hub.user.id);
      if (r.toStaffId !== me)
        throw new HubError('FORBIDDEN', 403, 'Only the colleague asked can answer');
      if (r.status !== 'REQUESTED') throw new HubError('CONFLICT', 409, 'Already answered');
      const saved = await tx.shiftSwapRequest.update({
        where: { id },
        data: agree
          ? { status: 'AGREED', agreedAt: new Date() }
          : { status: 'DECLINED', declinedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: agree ? 'rota.swap.agree' : 'rota.swap.decline',
        entity: 'shift_swap_request',
        entityId: id,
      });
      return (await this.dtos(tx, [saved], hub))[0]!;
    });
  }

  private async live(tx: TenantTx, id: string) {
    const r = await tx.shiftSwapRequest.findUnique({ where: { id } });
    if (!r) throw notFound();
    if (!['REQUESTED', 'AGREED'].includes(r.status))
      throw new HubError('CONFLICT', 409, 'This swap is already decided');
    return r;
  }

  private async assertSwappable(
    tx: TenantTx,
    a: { active: boolean; startsAt: Date; shiftId: string },
  ) {
    if (!a.active) throw new HubError('CONFLICT', 409, 'That assignment is no longer on the rota');
    if (a.startsAt <= new Date())
      throw new HubError('CONFLICT', 409, 'Only shifts that have not started can be swapped');
    return plannedShift(tx, a.shiftId);
  }

  private async dtos(tx: TenantTx, rows: SwapRow[], hub: HubRequestContext) {
    const ids = rows.flatMap((r) => [r.fromAssignmentId, r.toAssignmentId]);
    const assignments = ids.length
      ? await tx.crewAssignment.findMany({
          where: { id: { in: ids } },
          include: { shift: { select: { vehicleId: true } } },
        })
      : [];
    const byId = new Map(assignments.map((a) => [a.id, a]));
    const vehicles = await vehicleLabels(
      tx,
      assignments.map((a) => a.shift.vehicleId),
    );
    const staff = await staffNames(
      tx,
      rows.flatMap((r) => [r.fromStaffId, r.toStaffId]),
    );
    const users = await userNames(
      tx,
      rows.flatMap((r) => [r.requestedBy, r.decidedBy]),
    );
    const me = await myStaffId(tx, hub.user.id);
    const side = (assignmentId: string, staffId: string) => {
      const a = byId.get(assignmentId);
      return {
        assignmentId,
        staffId,
        staffName: staff.get(staffId)?.name ?? 'Unknown',
        startsAt: (a?.startsAt ?? new Date(0)).toISOString(),
        endsAt: (a?.endsAt ?? new Date(0)).toISOString(),
        vehicleLabel: a ? (vehicles.get(a.shift.vehicleId) ?? 'Vehicle') : 'Vehicle',
      };
    };
    const allocate = hub.permissions.has(ALLOCATE);
    return rows.map((r) => {
      const inSwap =
        r.requestedBy === hub.user.id ||
        staff.get(r.fromStaffId)?.userId === hub.user.id ||
        staff.get(r.toStaffId)?.userId === hub.user.id;
      return {
        id: r.id,
        code: r.code,
        status: r.status as
          | 'REQUESTED'
          | 'AGREED'
          | 'DECLINED'
          | 'APPROVED'
          | 'REFUSED'
          | 'WITHDRAWN',
        reason: r.reason,
        from: side(r.fromAssignmentId, r.fromStaffId),
        to: side(r.toAssignmentId, r.toStaffId),
        requestedByName: users.get(r.requestedBy) ?? null,
        decidedByName: r.decidedBy ? (users.get(r.decidedBy) ?? null) : null,
        decisionNote: r.decisionNote,
        warnings: (r.warnings as string[]) ?? [],
        canAgree: r.status === 'REQUESTED' && r.toStaffId === me,
        canDecide: allocate && !inSwap && ['REQUESTED', 'AGREED'].includes(r.status),
        canWithdraw: r.requestedBy === hub.user.id && ['REQUESTED', 'AGREED'].includes(r.status),
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
}

/** Working Time Regulations prompts for these people around two dates (8 days either side). */
async function workingTimeWarnings(
  tx: TenantTx,
  staffIds: string[],
  ...around: Date[]
): Promise<string[]> {
  const from = new Date(Math.min(...around.map((d) => d.getTime())) - 8 * 24 * 60 * MIN);
  const to = new Date(Math.max(...around.map((d) => d.getTime())) + 8 * 24 * 60 * MIN);
  const rows = await tx.crewAssignment.findMany({
    where: { staffId: { in: staffIds }, active: true, startsAt: { lt: to }, endsAt: { gt: from } },
    select: { id: true, staffId: true, startsAt: true, endsAt: true },
  });
  const names = await staffNames(tx, staffIds);
  return rotaWarnings(rows).map((w) => {
    const a = rows.find((r) => r.id === w.shiftId);
    return `${names.get(a?.staffId ?? '')?.name ?? 'Someone'}: ${w.text}`;
  });
}

// ================================================================================================
type EntryRow = Prisma.ShiftTimeEntryGetPayload<object>;
const entryDto = (e: EntryRow, corrected: boolean) => ({
  id: e.id,
  assignmentId: e.assignmentId,
  shiftId: e.shiftId,
  staffId: e.staffId,
  clockIn: e.clockIn.toISOString(),
  clockOut: iso(e.clockOut),
  breakMinutes: e.breakMinutes,
  source: e.source as 'CREW_APP' | 'MANAGER',
  corrected,
  reason: e.reason,
});

/** The entry that counts for each assignment: the latest in its correction chain. */
function currentEntries(entries: EntryRow[]) {
  const superseded = new Set(entries.map((e) => e.supersedesId).filter((x): x is string => !!x));
  const out = new Map<string, { entry: EntryRow; corrected: boolean }>();
  for (const e of entries)
    if (!superseded.has(e.id)) out.set(e.assignmentId, { entry: e, corrected: !!e.supersedesId });
  return out;
}

/**
 * v36 screen 34, Hours. Planned against actual hours: crew clock in and out against their own
 * assignment; a manager records or corrects with a reason (a new entry; history kept). This is
 * not a pay calculation.
 */
@Controller('shift-time')
export class ShiftTimeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The caller's assignments from 14 days ago to tomorrow, with their time entries. */
  @RequirePermission(CREW)
  @Get('mine')
  async mine(@Hub() hub: HubRequestContext) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const me = await myStaffId(tx, hub.user.id);
      if (!me) return { data: [] };
      const now = Date.now();
      const rows = await tx.crewAssignment.findMany({
        where: {
          staffId: me,
          active: true,
          startsAt: { lt: new Date(now + 36 * 60 * MIN) },
          endsAt: { gt: new Date(now - 14 * 24 * 60 * MIN) },
        },
        include: { shift: { select: { vehicleId: true } } },
        orderBy: { startsAt: 'desc' },
      });
      const entries = currentEntries(
        await tx.shiftTimeEntry.findMany({ where: { assignmentId: { in: rows.map((r) => r.id) } } }),
      );
      const vehicles = await vehicleLabels(
        tx,
        rows.map((r) => r.shift.vehicleId),
      );
      return {
        data: rows.map((a) => {
          const e = entries.get(a.id);
          return {
            assignmentId: a.id,
            shiftId: a.shiftId,
            vehicleLabel: vehicles.get(a.shift.vehicleId) ?? 'Vehicle',
            plannedStart: a.startsAt.toISOString(),
            plannedEnd: a.endsAt.toISOString(),
            entry: e ? entryDto(e.entry, e.corrected) : null,
          };
        }),
      };
    });
  }

  @RequirePermission(CREW)
  @Post('clock-in')
  async clockIn(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(ClockIn, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const me = await myStaffId(tx, hub.user.id);
      const a = await tx.crewAssignment.findUnique({ where: { id: input.assignmentId } });
      if (!a || !me || a.staffId !== me || !a.active) throw notFound();
      const now = new Date();
      if (now.getTime() < a.startsAt.getTime() - 60 * MIN || now > a.endsAt)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'You can clock in from an hour before the shift until it ends',
        );
      const existing = await tx.shiftTimeEntry.count({ where: { assignmentId: a.id } });
      if (existing) throw new HubError('CONFLICT', 409, 'You have already clocked in');
      const e = await tx.shiftTimeEntry.create({
        data: {
          organisationId: a.organisationId,
          assignmentId: a.id,
          shiftId: a.shiftId,
          staffId: a.staffId,
          clockIn: now,
          source: 'CREW_APP',
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.time.clock_in',
        entity: 'shift_time_entry',
        entityId: e.id,
      });
      return entryDto(e, false);
    });
  }

  @RequirePermission(CREW)
  @Post(':id/clock-out')
  async clockOut(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(ClockOut, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const e = await tx.shiftTimeEntry.findUnique({ where: { id } });
      const me = await myStaffId(tx, hub.user.id);
      if (!e || !me || e.staffId !== me || e.source !== 'CREW_APP') throw notFound();
      if (e.clockOut) throw new HubError('CONFLICT', 409, 'You have already clocked out');
      const now = new Date();
      const worked = Math.floor((now.getTime() - e.clockIn.getTime()) / MIN);
      if (worked < 1) throw new HubError('VALIDATION_FAILED', 400, 'You have only just clocked in');
      if (input.breakMinutes >= worked)
        throw new HubError('VALIDATION_FAILED', 400, 'Breaks cannot be longer than the time worked');
      if (worked > 24 * 60)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Over 24 hours since clocking in: ask your manager to record the time',
        );
      const saved = await tx.shiftTimeEntry.update({
        where: { id },
        data: { clockOut: now, breakMinutes: input.breakMinutes },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.time.clock_out',
        entity: 'shift_time_entry',
        entityId: id,
      });
      return entryDto(saved, false);
    });
  }

  /** A manager records or corrects the time for an assignment, with a reason. */
  @RequirePermission(ALLOCATE)
  @Post('correct')
  async correct(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(TimeCorrect, raw);
    const inAt = new Date(input.clockIn);
    const outAt = new Date(input.clockOut);
    if (outAt <= inAt || outAt.getTime() - inAt.getTime() > 24 * 60 * MIN)
      throw new HubError('VALIDATION_FAILED', 400, 'The end must be after the start, within 24 hours');
    if (outAt.getTime() > Date.now() + 5 * MIN)
      throw new HubError('VALIDATION_FAILED', 400, 'The end cannot be in the future');
    if (input.breakMinutes >= (outAt.getTime() - inAt.getTime()) / MIN)
      throw new HubError('VALIDATION_FAILED', 400, 'Breaks cannot be longer than the time worked');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.crewAssignment.findUnique({ where: { id: input.assignmentId } });
      if (!a) throw notFound();
      const staff = await tx.staff.findUnique({ where: { id: a.staffId }, select: { userId: true } });
      if (staff?.userId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Someone else must correct your own hours');
      const current = currentEntries(
        await tx.shiftTimeEntry.findMany({ where: { assignmentId: a.id } }),
      ).get(a.id);
      const e = await tx.shiftTimeEntry.create({
        data: {
          organisationId: a.organisationId,
          assignmentId: a.id,
          shiftId: a.shiftId,
          staffId: a.staffId,
          clockIn: inAt,
          clockOut: outAt,
          breakMinutes: input.breakMinutes,
          source: 'MANAGER',
          supersedesId: current?.entry.id ?? null,
          reason: input.reason,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: current ? 'rota.time.correct' : 'rota.time.record',
        entity: 'shift_time_entry',
        entityId: e.id,
        summary: { assignmentId: a.id },
      });
      return entryDto(e, !!current);
    });
  }

  /** Planned against actual by person for a date range (at most 31 days). */
  @OrgMember()
  @Get('hours')
  async hours(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, ALLOCATE, 'reports.view');
    const f = body(HoursQuery, q);
    if (f.to < f.from || Date.parse(f.to) - Date.parse(f.from) > 31 * 86_400_000)
      throw new HubError('VALIDATION_FAILED', 400, 'Choose a range of up to 31 days');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const start = startOfLondonDay(f.from);
      const end = startOfLondonDay(addDays(f.to, 1));
      // Active assignments only: one withdrawn before it started was never worked.
      const live = await tx.crewAssignment.findMany({
        where: { startsAt: { gte: start, lt: end }, active: true },
        include: { shift: { select: { vehicleId: true } } },
        orderBy: { startsAt: 'asc' },
        take: 5000,
      });
      const entries = currentEntries(
        await tx.shiftTimeEntry.findMany({ where: { assignmentId: { in: live.map((a) => a.id) } } }),
      );
      const staff = await staffNames(
        tx,
        live.map((a) => a.staffId),
      );
      const vehicles = await vehicleLabels(
        tx,
        live.map((a) => a.shift.vehicleId),
      );
      const now = new Date();
      const per = new Map<
        string,
        { shifts: number; plannedMinutes: number; actualMinutes: number; missing: number; overrunShifts: number }
      >();
      const out = live.map((a) => {
          const e = entries.get(a.id);
          const plannedMin = Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / MIN);
          const actualMin =
            e?.entry.clockOut
              ? Math.round((e.entry.clockOut.getTime() - e.entry.clockIn.getTime()) / MIN) -
                e.entry.breakMinutes
              : 0;
          const p = per.get(a.staffId) ?? {
            shifts: 0,
            plannedMinutes: 0,
            actualMinutes: 0,
            missing: 0,
            overrunShifts: 0,
          };
          p.shifts++;
          p.plannedMinutes += plannedMin;
          p.actualMinutes += actualMin;
          if (a.endsAt < now && !e?.entry.clockOut) p.missing++;
          if (e?.entry.clockOut && actualMin > plannedMin + 15) p.overrunShifts++;
          per.set(a.staffId, p);
          return {
            assignmentId: a.id,
            shiftId: a.shiftId,
            staffId: a.staffId,
            staffName: staff.get(a.staffId)?.name ?? 'Unknown',
            vehicleLabel: vehicles.get(a.shift.vehicleId) ?? 'Vehicle',
            plannedStart: a.startsAt.toISOString(),
            plannedEnd: a.endsAt.toISOString(),
            entry: e ? entryDto(e.entry, e.corrected) : null,
          };
        });
      return {
        from: f.from,
        to: f.to,
        people: [...per.entries()].map(([staffId, p]) => ({
          staffId,
          staffName: staff.get(staffId)?.name ?? 'Unknown',
          ...p,
        })),
        entries: out,
        note: 'Planned against actual hours. This is not a pay calculation – payroll is outside this system.',
      };
    });
  }
}

// ================================================================================================
type PatternRow = Prisma.ShiftPatternGetPayload<object>;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function patternDto(p: PatternRow) {
  const s = toMin(p.startTime);
  const e = toMin(p.endTime);
  const overnight = e <= s;
  const length = (overnight ? e + 1440 - s : e - s) / 60;
  const rest = 24 - length;
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    startTime: p.startTime,
    endTime: p.endTime,
    paidBreakMinutes: p.paidBreakMinutes,
    onDays: p.onDays,
    offDays: p.offDays,
    lengthHours: Math.round(length * 10) / 10,
    overnight,
    active: p.active,
    restWarning:
      p.onDays > 1 && rest < 11
        ? `Only ${Math.round(rest * 10) / 10}h rest between consecutive shifts (11h minimum)`
        : length * Math.min(p.onDays, 7) > 48 && p.offDays < 7 - Math.min(p.onDays, 7) + 1
          ? 'Can exceed 48 hours in 7 days; check opt-outs'
          : null,
  };
}

/** v36 screen 34, Patterns: named shift times with a rotation, used when planning shifts. */
@Controller('shift-patterns')
export class ShiftPatternsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext) {
    requireAny(hub, PLAN_VIEW, ALLOCATE);
    return this.db.withTenant(tenantOf(hub), async (tx) => ({
      data: (
        await tx.shiftPattern.findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] })
      ).map(patternDto),
    }));
  }

  @RequirePermission(ALLOCATE)
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(PatternCreate, raw);
    if (input.startTime === input.endTime)
      throw new HubError('VALIDATION_FAILED', 400, 'Start and end cannot be the same time');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const dup = await tx.shiftPattern.count({ where: { code: input.code, active: true } });
      if (dup) throw new HubError('CONFLICT', 409, 'A pattern with that code already exists');
      const p = await tx.shiftPattern.create({
        data: { organisationId: hub.orgId as string, ...input, createdBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.pattern.create',
        entity: 'shift_pattern',
        entityId: p.id,
      });
      return patternDto(p);
    });
  }

  @RequirePermission(ALLOCATE)
  @Post(':id/retire')
  async retire(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.shiftPattern.findUnique({ where: { id } });
      if (!p) throw notFound();
      if (!p.active) throw new HubError('CONFLICT', 409, 'Already retired');
      const saved = await tx.shiftPattern.update({
        where: { id },
        data: { active: false, retiredBy: hub.user.id, retiredAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'rota.pattern.retire',
        entity: 'shift_pattern',
        entityId: id,
      });
      return patternDto(saved);
    });
  }

  /** The working days a pattern gives from a start date (for planning; it creates nothing). */
  @OrgMember()
  @Get(':id/dates')
  async dates(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Query() q: unknown,
  ) {
    requireAny(hub, PLAN_VIEW, ALLOCATE);
    const f = body(PatternDatesQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.shiftPattern.findUnique({ where: { id } });
      if (!p) throw notFound();
      const cycle = p.onDays + p.offDays;
      const overnight = toMin(p.endTime) <= toMin(p.startTime);
      const out: { date: string; startsAt: string; endsAt: string }[] = [];
      for (let i = 0; i < f.weeks * 7; i++) {
        if (i % cycle >= p.onDays) continue;
        const d = addDays(f.from, i);
        out.push({
          date: d,
          startsAt: londonDateTime(d, p.startTime).toISOString(),
          endsAt: londonDateTime(overnight ? addDays(d, 1) : d, p.endTime).toISOString(),
        });
      }
      return { patternId: p.id, dates: out };
    });
  }
}

