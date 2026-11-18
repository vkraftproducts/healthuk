import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import {
  addDays,
  addMonths,
  compareDates,
  endOfLondonDay,
  londonDate,
} from '@hub/rules';
import {
  AbsenceQuery,
  AbsenceRecord,
  AbsenceReturn,
  LeaverCancel,
  LeaverStart,
  LeaverTick,
  ReviewCancel,
  ReviewQuery,
  ReviewRecord,
  ReviewSchedule,
  type LeaverDto,
  type ReviewDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import {
  assertActiveMember,
  day,
  escalationContext,
  idPipe,
  iso,
  myStaffId,
  nextRegisterCode,
  ymd,
} from './shared.js';

type ReviewRow = Prisma.StaffReviewGetPayload<object>;
type AbsenceRow = Prisma.StaffAbsenceGetPayload<object>;
type LeaverRow = Prisma.LeaverRecordGetPayload<object>;

const MANAGE = 'staff.profile.manage';
const SENSITIVE = 'staff.sensitive.view';
const LIFECYCLE = 'staff.lifecycle.transition';

/** Whole days from a to b (b later is positive). Both are London dates. */
function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

async function staffById(tx: TenantTx, ids: string[]) {
  const rows = await tx.staff.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, displayName: true, staffNo: true, userId: true, lifecycleState: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

async function liveStaff(tx: TenantTx, staffId: string) {
  const s = await tx.staff.findUnique({ where: { id: staffId } });
  if (!s) throw notFound();
  return s;
}

// ================================================================================================
/**
 * v36 screen 35, Probation & appraisals. Reviews are scheduled, then recorded once by someone
 * other than the person reviewed. Recording schedules the next one (6-month probation after a
 * passed 3-month one, the next appraisal a year on, a further review after an extension).
 */
@Controller('staff-reviews')
export class StaffReviewsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: ReviewDto[] }> {
    requireAny(hub, 'staff.profile.view_basic', 'staff.self.view');
    const f = body(ReviewQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const all = hub.permissions.has('staff.profile.view_basic');
      const mine = all ? null : await myStaffId(tx, hub.user.id);
      if (!all && !mine) return { data: [] };
      const rows = await tx.staffReview.findMany({
        where: {
          ...(all ? (f.staffId ? { staffId: f.staffId } : {}) : { staffId: mine! }),
          ...(f.status ? { status: f.status } : {}),
        },
        orderBy: [{ status: 'asc' }, { dueOn: 'asc' }],
        take: 1000,
      });
      return { data: await reviewDtos(tx, rows) };
    });
  }

  @RequirePermission(MANAGE)
  @Post()
  async schedule(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ReviewDto> {
    const input = body(ReviewSchedule, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await liveStaff(tx, input.staffId);
      if (s.lifecycleState === 'LEAVER')
        throw new HubError('VALIDATION_FAILED', 400, 'This person has left');
      const r = await tx.staffReview.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextRegisterCode(tx, hub.orgId as string, 'REV'),
          staffId: s.id,
          kind: input.kind,
          dueOn: day(input.dueOn),
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.review.schedule',
        entity: 'staff_review',
        entityId: r.id,
        summary: { staffId: s.id, kind: r.kind },
      });
      return (await reviewDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/record')
  async record(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ReviewDto> {
    const input = body(ReviewRecord, raw);
    if (input.reviewedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The review date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.staffReview.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status !== 'SCHEDULED')
        throw new HubError('CONFLICT', 409, 'This review is already recorded or cancelled');
      const allowed: Record<string, string[]> = {
        PROBATION_3M: ['PASSED', 'EXTENDED', 'NOT_PASSED'],
        PROBATION_6M: ['PASSED', 'EXTENDED', 'NOT_PASSED'],
        APPRAISAL: ['MEETS', 'EXCEEDS', 'NEEDS_SUPPORT'],
        OTHER: ['RECORDED'],
      };
      if (!allowed[r.kind]!.includes(input.outcome))
        throw new HubError('VALIDATION_FAILED', 400, 'That outcome does not fit this kind of review');
      if (r.kind === 'APPRAISAL' && !input.objectives)
        throw new HubError('VALIDATION_FAILED', 400, 'Record the objectives for the coming year');
      await assertActiveMember(tx, input.reviewerUserId, 'The reviewer');
      const s = await liveStaff(tx, r.staffId);
      if (s.userId && s.userId === input.reviewerUserId)
        throw new HubError('SELF_APPROVAL', 422, 'Someone else must review this person');
      if (s.userId && s.userId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'You cannot record your own review');
      await tx.staffReview.update({
        where: { id },
        data: {
          status: 'DONE',
          outcome: input.outcome,
          reviewedOn: day(input.reviewedOn),
          reviewerUserId: input.reviewerUserId,
          recordedBy: hub.user.id,
          notes: input.notes ?? null,
          objectives: input.objectives ?? null,
        },
      });
      // What comes next follows from the outcome.
      const next: { kind: string; dueOn: string } | null =
        r.kind === 'APPRAISAL'
          ? { kind: 'APPRAISAL', dueOn: addMonths(input.reviewedOn, 12) }
          : r.kind === 'PROBATION_3M' && input.outcome === 'PASSED'
            ? { kind: 'PROBATION_6M', dueOn: addMonths(input.reviewedOn, 3) }
            : r.kind.startsWith('PROBATION') && input.outcome === 'EXTENDED'
              ? { kind: r.kind, dueOn: addMonths(input.reviewedOn, 1) }
              : r.kind === 'PROBATION_6M' && input.outcome === 'PASSED'
                ? { kind: 'APPRAISAL', dueOn: addMonths(input.reviewedOn, 12) }
                : null;
      if (next && s.lifecycleState !== 'LEAVER')
        await tx.staffReview.create({
          data: {
            organisationId: r.organisationId,
            code: await nextRegisterCode(tx, r.organisationId, 'REV'),
            staffId: r.staffId,
            kind: next.kind,
            dueOn: day(next.dueOn),
            followsId: r.id,
            createdBy: hub.user.id,
          },
        });
      await audit(this.db, tx, hub, {
        action: 'staff.review.record',
        entity: 'staff_review',
        entityId: id,
        summary: { staffId: r.staffId, kind: r.kind, outcome: input.outcome, nextScheduled: !!next },
      });
      return (await reviewDtos(tx, [await tx.staffReview.findUniqueOrThrow({ where: { id } })]))[0]!;
    });
  }

  @RequirePermission(MANAGE)
  @Post(':id/cancel')
  async cancel(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ReviewDto> {
    const input = body(ReviewCancel, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.staffReview.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status !== 'SCHEDULED')
        throw new HubError('CONFLICT', 409, 'This review is already recorded or cancelled');
      const saved = await tx.staffReview.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: input.reason },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.review.cancel',
        entity: 'staff_review',
        entityId: id,
      });
      return (await reviewDtos(tx, [saved]))[0]!;
    });
  }
}

/** v36 Staff check / document defaults: lead at 3 days overdue, manager at 7. */
async function reviewDtos(tx: TenantTx, rows: ReviewRow[]): Promise<ReviewDto[]> {
  const staff = await staffById(
    tx,
    rows.map((r) => r.staffId),
  );
  const names = await userNames(
    tx,
    rows.map((r) => r.reviewerUserId),
  );
  const follows = rows.length
    ? await tx.staffReview.findMany({
        where: { followsId: { in: rows.map((r) => r.id) } },
        select: { id: true, followsId: true },
      })
    : [];
  const nextOf = new Map(follows.map((f) => [f.followsId!, f.id]));
  const today = londonDate(new Date());
  const esc = rows.length ? await escalationContext(tx) : null;
  return rows.map((r) => {
    const due = ymd(r.dueOn)!;
    const left = daysFrom(today, due);
    const overdue = r.status === 'SCHEDULED' && left < 0;
    const dueText =
      r.status === 'DONE'
        ? `Done ${ymd(r.reviewedOn)}`
        : r.status === 'CANCELLED'
          ? 'Cancelled'
          : left < 0
            ? `Overdue by ${-left} day${left === -1 ? '' : 's'}`
            : left === 0
              ? 'Due today'
              : `Due in ${left} day${left === 1 ? '' : 's'}`;
    // v36 scores reviews with the Supervision rule (lead after 7 days, manager after 14).
    const escalation = overdue && esc ? esc.of('SUPERVISION', -left) : null;
    const s = staff.get(r.staffId);
    return {
      id: r.id,
      code: r.code,
      staffId: r.staffId,
      staffName: s?.displayName ?? 'Unknown',
      staffNo: s?.staffNo ?? '',
      kind: r.kind as ReviewDto['kind'],
      dueOn: due,
      status: r.status as ReviewDto['status'],
      dueText,
      overdue,
      outcome: (r.outcome as ReviewDto['outcome']) ?? null,
      notes: r.notes,
      objectives: r.objectives,
      reviewedOn: ymd(r.reviewedOn),
      reviewerName: r.reviewerUserId ? (names.get(r.reviewerUserId) ?? null) : null,
      cancelReason: r.cancelReason,
      nextReviewId: nextOf.get(r.id) ?? null,
      escalation,
      version: r.version,
    };
  });
}

// ================================================================================================
/**
 * v36 screen 35, Sickness & return to work. Only a broad category is kept. While someone is off,
 * a restriction shows them as not available; a phased return adds its own time-limited one.
 * Visible to HR (sensitive staff data) and to the person themselves (RLS too).
 */
@Controller('staff-absences')
export class StaffAbsencesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, SENSITIVE, 'staff.self.view');
    const f = body(AbsenceQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.staffAbsence.findMany({
        where: f.staffId ? { staffId: f.staffId } : {},
        orderBy: { firstDay: 'desc' },
        take: 2000,
      });
      const staff = await staffById(
        tx,
        rows.map((r) => r.staffId),
      );
      const names = await userNames(
        tx,
        rows.map((r) => r.rtwByUserId),
      );
      const today = londonDate(new Date());
      const data = rows.map((r) => absenceDto(r, staff, names, today));
      // Triggers: three or more episodes starting in 6 months; Bradford factor over 12 months.
      const since6 = addMonths(today, -6);
      const since12 = addMonths(today, -12);
      const byStaff = new Map<string, typeof data>();
      for (const a of data) byStaff.set(a.staffId, [...(byStaff.get(a.staffId) ?? []), a]);
      const triggers = hub.permissions.has(SENSITIVE)
        ? [...byStaff.entries()]
            .map(([staffId, list]) => {
              const e6 = list.filter((a) => compareDates(a.firstDay, since6) >= 0).length;
              const in12 = list.filter((a) => compareDates(a.firstDay, since12) >= 0);
              const days = in12.reduce((n, a) => n + a.days, 0);
              return {
                staffId,
                staffName: list[0]!.staffName,
                episodes6m: e6,
                bradford12m: in12.length * in12.length * days,
                reached: e6 >= 3,
              };
            })
            .filter((t) => t.reached || t.bradford12m >= 200)
        : [];
      return { data, triggers };
    });
  }

  @RequirePermission(SENSITIVE, MANAGE)
  @Post()
  async record(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(AbsenceRecord, raw);
    const today = londonDate(new Date());
    if (input.firstDay > today)
      throw new HubError('VALIDATION_FAILED', 400, 'Record absence once it has started');
    if (input.lastDay && (input.lastDay < input.firstDay || input.lastDay > today))
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'The last day off must be on or after the first day and not in the future',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await liveStaff(tx, input.staffId);
      if (s.lifecycleState === 'LEAVER')
        throw new HubError('VALIDATION_FAILED', 400, 'This person has left');
      if (!input.lastDay) {
        const open = await tx.staffAbsence.count({ where: { staffId: s.id, lastDay: null } });
        if (open) throw new HubError('CONFLICT', 409, 'This person already has an open absence');
      }
      const code = await nextRegisterCode(tx, hub.orgId as string, 'ABS');
      let offRestrictionId: string | null = null;
      if (!input.lastDay) {
        const r = await tx.staffRestriction.create({
          data: {
            organisationId: hub.orgId as string,
            staffId: s.id,
            type: 'OTHER',
            detail: 'Off sick – not available for shifts',
            reason: `Sickness absence ${code}`,
            appliedBy: hub.user.id,
          },
        });
        offRestrictionId = r.id;
      }
      const a = await tx.staffAbsence.create({
        data: {
          organisationId: hub.orgId as string,
          code,
          staffId: s.id,
          firstDay: day(input.firstDay),
          lastDay: input.lastDay ? day(input.lastDay) : null,
          category: input.category,
          offRestrictionId,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.absence.record',
        entity: 'staff_absence',
        entityId: a.id,
        summary: { staffId: s.id, open: !input.lastDay },
      });
      return absenceDto(a, await staffById(tx, [s.id]), new Map(), today);
    });
  }

  /** Back at work: the last day off (if still open) and the return-to-work interview. */
  @RequirePermission(SENSITIVE, MANAGE)
  @Post(':id/return')
  async returnToWork(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(AbsenceReturn, raw);
    const today = londonDate(new Date());
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.staffAbsence.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.rtwOn) throw new HubError('CONFLICT', 409, 'The interview is already recorded');
      const lastDay = ymd(a.lastDay) ?? input.lastDay;
      if (!lastDay)
        throw new HubError('VALIDATION_FAILED', 400, 'Give the last day the person was off');
      if (lastDay < ymd(a.firstDay)! || lastDay > today)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The last day off must be on or after the first day and not in the future',
        );
      if (input.rtwOn <= lastDay || input.rtwOn > today)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The interview is on the first day back or later, and not in the future',
        );
      if (input.phased && (!input.phasedTerms || !input.phasedUntil))
        throw new HubError('VALIDATION_FAILED', 400, 'Give the phased return terms and end date');
      if (input.phased && input.phasedUntil! <= input.rtwOn)
        throw new HubError('VALIDATION_FAILED', 400, 'The phased return must end after it starts');
      await assertActiveMember(tx, input.rtwByUserId, 'The interviewer');
      const s = await liveStaff(tx, a.staffId);
      if (s.userId && s.userId === input.rtwByUserId)
        throw new HubError('SELF_APPROVAL', 422, 'Someone else holds the interview');
      const now = new Date();
      if (a.offRestrictionId)
        await tx.staffRestriction.updateMany({
          where: { id: a.offRestrictionId, liftedAt: null },
          data: { liftedAt: now, liftedBy: hub.user.id, liftReason: `Back at work (${a.code})` },
        });
      let phasedRestrictionId: string | null = null;
      if (input.phased) {
        const r = await tx.staffRestriction.create({
          data: {
            organisationId: a.organisationId,
            staffId: a.staffId,
            type: 'OTHER',
            detail: `Phased return: ${input.phasedTerms}`.slice(0, 200),
            reason: `Phased return after absence ${a.code}`,
            appliedBy: hub.user.id,
            validTo: endOfLondonDay(input.phasedUntil!),
          },
        });
        phasedRestrictionId = r.id;
      }
      const saved = await tx.staffAbsence.update({
        where: { id },
        data: {
          lastDay: day(lastDay),
          rtwOn: day(input.rtwOn),
          rtwByUserId: input.rtwByUserId,
          rtwRecordedBy: hub.user.id,
          rtwNote: input.note ?? null,
          phased: input.phased,
          phasedTerms: input.phased ? input.phasedTerms! : null,
          phasedUntil: input.phased ? day(input.phasedUntil!) : null,
          phasedRestrictionId,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.absence.return',
        entity: 'staff_absence',
        entityId: id,
        summary: { staffId: a.staffId, phased: input.phased },
      });
      return absenceDto(
        saved,
        await staffById(tx, [a.staffId]),
        await userNames(tx, [input.rtwByUserId]),
        today,
      );
    });
  }
}

function absenceDto(
  r: AbsenceRow,
  staff: Map<string, { displayName: string }>,
  names: Map<string, string>,
  today: string,
) {
  const first = ymd(r.firstDay)!;
  const last = ymd(r.lastDay);
  return {
    id: r.id,
    code: r.code,
    staffId: r.staffId,
    staffName: staff.get(r.staffId)?.displayName ?? 'Unknown',
    firstDay: first,
    lastDay: last,
    stillOff: !last,
    category: r.category as
      | 'MUSCULOSKELETAL'
      | 'RESPIRATORY'
      | 'GASTROINTESTINAL'
      | 'MENTAL_HEALTH'
      | 'INJURY_AT_WORK'
      | 'INFECTION'
      | 'OTHER',
    days: daysFrom(first, last ?? today) + 1,
    rtwOn: ymd(r.rtwOn),
    rtwByName: r.rtwByUserId ? (names.get(r.rtwByUserId) ?? null) : null,
    rtwNote: r.rtwNote,
    rtwMissing: !!last && !r.rtwOn && compareDates(addDays(last, 1), today) <= 0,
    phased: r.phased,
    phasedTerms: r.phasedTerms,
    phasedUntil: ymd(r.phasedUntil),
    version: r.version,
  };
}

// ================================================================================================
const LEAVER_ITEMS: { item: LeaverDto['checklist'][number]['item']; label: string }[] = [
  { item: 'ACCESS', label: 'Moved to leaver – sign-in and phone access ended' },
  { item: 'BADGE', label: 'ID badge returned' },
  { item: 'KIT', label: 'Uniform and equipment returned' },
  { item: 'PAYROLL', label: 'Payroll told (no calculation here)' },
  { item: 'EXIT_INTERVIEW', label: 'Exit interview offered' },
];

/**
 * v36 screen 35, Leavers. The checklist for someone leaving. Access is ended by the existing
 * lifecycle move to LEAVER (which also flags their future shifts); the record completes only
 * after that and every item is done. Records are kept for six years after the last day.
 */
@Controller('leavers')
export class LeaversController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('staff.profile.view_basic')
  @Get()
  async list(@Hub() hub: HubRequestContext): Promise<{ data: LeaverDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.leaverRecord.findMany({
        orderBy: [{ status: 'asc' }, { lastDay: 'asc' }],
        take: 500,
      });
      return { data: await leaverDtos(tx, rows) };
    });
  }

  @RequirePermission(LIFECYCLE)
  @Post()
  async start(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<LeaverDto> {
    const input = body(LeaverStart, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await liveStaff(tx, input.staffId);
      if (s.userId && s.userId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Someone else records your leaving');
      const open = await tx.leaverRecord.count({ where: { staffId: s.id, status: 'OPEN' } });
      if (open) throw new HubError('CONFLICT', 409, 'A leaver checklist is already open');
      const l = await tx.leaverRecord.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextRegisterCode(tx, hub.orgId as string, 'LV'),
          staffId: s.id,
          lastDay: day(input.lastDay),
          reason: input.reason,
          reasonNote: input.reasonNote ?? null,
          startedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.leaver.start',
        entity: 'leaver_record',
        entityId: l.id,
        summary: { staffId: s.id, reason: l.reason },
      });
      return (await leaverDtos(tx, [l]))[0]!;
    });
  }

  @RequirePermission(LIFECYCLE)
  @Post(':id/tick')
  async tick(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<LeaverDto> {
    const input = body(LeaverTick, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const l = await this.open(tx, id);
      const now = new Date();
      const by = hub.user.id;
      const data: Prisma.LeaverRecordUpdateInput =
        input.item === 'BADGE'
          ? l.badgeReturnedAt
            ? {}
            : { badgeReturnedAt: now, badgeReturnedBy: by }
          : input.item === 'KIT'
            ? l.kitReturnedAt
              ? {}
              : { kitReturnedAt: now, kitReturnedBy: by }
            : input.item === 'PAYROLL'
              ? l.payrollToldAt
                ? {}
                : { payrollToldAt: now, payrollToldBy: by }
              : l.exitInterview
                ? {}
                : {
                    exitInterview: input.exitInterview ?? 'DONE',
                    exitInterviewAt: now,
                    exitInterviewBy: by,
                  };
      if (Object.keys(data).length === 0)
        throw new HubError('CONFLICT', 409, 'This item is already done');
      const saved = await tx.leaverRecord.update({ where: { id }, data });
      await audit(this.db, tx, hub, {
        action: 'staff.leaver.tick',
        entity: 'leaver_record',
        entityId: id,
        summary: { item: input.item },
      });
      return (await leaverDtos(tx, [saved]))[0]!;
    });
  }

  @RequirePermission(LIFECYCLE)
  @Post(':id/complete')
  async complete(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<LeaverDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const l = await this.open(tx, id);
      const s = await liveStaff(tx, l.staffId);
      const missing: string[] = [];
      if (s.lifecycleState !== 'LEAVER') missing.push('Move the person to leaver first');
      if (!l.badgeReturnedAt) missing.push('ID badge');
      if (!l.kitReturnedAt) missing.push('Uniform and equipment');
      if (!l.payrollToldAt) missing.push('Payroll');
      if (!l.exitInterview) missing.push('Exit interview');
      if (missing.length)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          `Still to do: ${missing.join('; ')}`,
        );
      const saved = await tx.leaverRecord.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedBy: hub.user.id,
          keepUntil: day(addMonths(ymd(l.lastDay)!, 72)),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.leaver.complete',
        entity: 'leaver_record',
        entityId: id,
        summary: { staffId: l.staffId },
      });
      return (await leaverDtos(tx, [saved]))[0]!;
    });
  }

  @RequirePermission(LIFECYCLE)
  @Post(':id/cancel')
  async cancel(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<LeaverDto> {
    const input = body(LeaverCancel, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const l = await this.open(tx, id);
      const s = await liveStaff(tx, l.staffId);
      if (s.lifecycleState === 'LEAVER')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'This person has already been moved to leaver; finish the checklist instead',
        );
      const saved = await tx.leaverRecord.update({
        where: { id },
        data: { status: 'CANCELLED', cancelReason: input.reason },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.leaver.cancel',
        entity: 'leaver_record',
        entityId: id,
      });
      return (await leaverDtos(tx, [saved]))[0]!;
    });
  }

  private async open(tx: TenantTx, id: string) {
    const l = await tx.leaverRecord.findUnique({ where: { id } });
    if (!l) throw notFound();
    if (l.status !== 'OPEN')
      throw new HubError('CONFLICT', 409, 'This leaver record is completed or cancelled');
    return l;
  }
}

async function leaverDtos(tx: TenantTx, rows: LeaverRow[]): Promise<LeaverDto[]> {
  const staff = await staffById(
    tx,
    rows.map((r) => r.staffId),
  );
  const names = await userNames(
    tx,
    rows.flatMap((r) => [
      r.startedBy,
      r.badgeReturnedBy,
      r.kitReturnedBy,
      r.payrollToldBy,
      r.exitInterviewBy,
    ]),
  );
  const when = (at: Date | null, by: string | null) =>
    at ? `${londonDate(at)} by ${(by && names.get(by)) || 'unknown'}` : null;
  return rows.map((r) => {
    const s = staff.get(r.staffId);
    const left = s?.lifecycleState === 'LEAVER';
    const done: Record<string, string | null> = {
      ACCESS: left ? 'Done' : null,
      BADGE: when(r.badgeReturnedAt, r.badgeReturnedBy),
      KIT: when(r.kitReturnedAt, r.kitReturnedBy),
      PAYROLL: when(r.payrollToldAt, r.payrollToldBy),
      EXIT_INTERVIEW: r.exitInterview
        ? `${r.exitInterview === 'DECLINED' ? 'Declined' : 'Held'} – ${when(r.exitInterviewAt, r.exitInterviewBy)}`
        : null,
    };
    const checklist = LEAVER_ITEMS.map((i) => ({
      item: i.item,
      label: i.label,
      done: done[i.item] !== null,
      doneText: done[i.item] ?? null,
    }));
    return {
      id: r.id,
      code: r.code,
      staffId: r.staffId,
      staffName: s?.displayName ?? 'Unknown',
      lifecycleState: String(s?.lifecycleState ?? ''),
      lastDay: ymd(r.lastDay)!,
      reason: r.reason as LeaverDto['reason'],
      reasonNote: r.reasonNote,
      status: r.status as LeaverDto['status'],
      checklist,
      doneCount: checklist.filter((c) => c.done).length,
      keepUntil: ymd(r.keepUntil),
      completedAt: iso(r.completedAt),
      startedByName: names.get(r.startedBy) ?? null,
      version: r.version,
    };
  });
}
