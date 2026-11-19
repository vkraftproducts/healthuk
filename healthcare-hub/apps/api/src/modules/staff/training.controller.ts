import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { Db, Prisma, TenantTx } from '@hub/db';
import {
  BulkTrainingInput,
  RecordAckInput,
  SupervisionBookingInput,
  SupervisionCloseInput,
  SupervisionConfirmInput,
  SupervisionRequestInput,
  TrainingCourseCreate,
  TrainingCourseRetire,
  TrainingRecordVerifyInput,
  type RecordAckDto,
  type StaffRecordDto,
  type SupervisionBookingDto,
  type SupervisionNextDueDto,
  type TrainingCourseDto,
  type TrainingRecordQueueItem,
} from '@hub/contracts';
import { addDays, daysUntil, londonDate, trainingExpiry } from '@hub/rules';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { nextV36Code } from '../v36/sync/staff-lib.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { toDate } from '../requirements/requirements.mapper.js';
import { toRecordDto } from './staff.mapper.js';
import { escalationContext } from '../v36/shared.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound() });
const MANAGE = 'staff.profile.manage';
/** v36 supervision rule: every 8 weeks from the last supervision held. */
const SUPERVISION_EVERY_DAYS = 56;
const BookingQuery = z.object({
  staffId: z.string().uuid().optional(),
  status: z.enum(['REQUESTED', 'BOOKED', 'HELD', 'CANCELLED', 'MISSED']).optional(),
});
const toCourse = (c: {
  id: string;
  code: string;
  title: string;
  intervalMonths: number | null;
  basis: string;
  basisNote: string | null;
  deploymentCritical: boolean;
  retiredAt: Date | null;
  retireReason: string | null;
  version: number;
}): TrainingCourseDto => ({
  id: c.id,
  code: c.code,
  title: c.title,
  intervalMonths: c.intervalMonths,
  basis: c.basis as TrainingCourseDto['basis'],
  basisNote: c.basisNote,
  deploymentCritical: c.deploymentCritical,
  retired: c.retiredAt !== null,
  retireReason: c.retireReason,
  version: c.version,
});

/**
 * Training catalogue, group training records and the matrix export (C1), supervision bookings (C2)
 * and staff acknowledgements of supervision and appraisal records (C2, C3).
 */
@Controller()
export class TrainingController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- C1: course catalogue -----------------------------------------------------------------
  @OrgMember()
  @Get('training-courses')
  async courses(@Hub() hub: HubRequestContext): Promise<{ data: TrainingCourseDto[] }> {
    requireAny(hub, 'staff.profile.view_basic', 'staff.self.view');
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.trainingCourse.findMany({ orderBy: [{ retiredAt: 'asc' }, { title: 'asc' }] }),
    );
    return { data: rows.map(toCourse) };
  }

  /** A course not in the catalogue is added by HR with its interval and basis. */
  @RequirePermission(MANAGE)
  @Post('training-courses')
  async addCourse(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<TrainingCourseDto> {
    const input = body(TrainingCourseCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (await tx.trainingCourse.findFirst({ where: { code: input.code } }))
        throw new HubError('CONFLICT', 409, `A course with the code ${input.code} already exists`);
      const c = await tx.trainingCourse.create({
        data: {
          organisationId: hub.orgId as string,
          code: input.code,
          title: input.title,
          intervalMonths: input.intervalMonths,
          basis: input.basis,
          basisNote: input.basisNote ?? null,
          deploymentCritical: input.deploymentCritical,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.course.create',
        entity: 'training_course',
        entityId: c.id,
        summary: { code: c.code, intervalMonths: c.intervalMonths, basis: c.basis },
      });
      return toCourse(c);
    });
  }

  /** Courses are retired with a reason, never deleted: earlier records still point at them. */
  @RequirePermission(MANAGE)
  @Post('training-courses/:id/retire')
  @HttpCode(200)
  async retireCourse(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<TrainingCourseDto> {
    const { reason } = body(TrainingCourseRetire, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.trainingCourse.updateMany({
        where: { id, version, retiredAt: null },
        data: { retiredAt: new Date(), retiredBy: hub.user.id, retireReason: reason },
      });
      if (r.count === 0) {
        const c = await tx.trainingCourse.findUnique({ where: { id } });
        if (c?.retiredAt) throw new HubError('CONFLICT', 409, 'The course is already retired');
        throw staleOrNotFound(c !== null);
      }
      await audit(this.db, tx, hub, {
        action: 'staff.course.retire',
        entity: 'training_course',
        entityId: id,
        summary: { reason },
      });
      return toCourse(await tx.trainingCourse.findUniqueOrThrow({ where: { id } }));
    });
  }

  /**
   * Bulk record after a group session: one TRAINING record per attendee, each awaiting
   * verification like any other record. Expiry comes from the course interval when left blank.
   */
  @RequirePermission(MANAGE)
  @Post('training-records/bulk')
  async bulk(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<{ created: number; recordIds: string[] }> {
    const input = body(BulkTrainingInput, raw);
    if (input.completedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The session date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const course = await tx.trainingCourse.findUnique({ where: { id: input.courseId } });
      if (!course) throw notFound();
      if (course.retiredAt)
        throw new HubError('CONFLICT', 409, 'That course is retired. Choose a current course.');
      const staff = await tx.staff.findMany({
        where: { id: { in: input.staffIds } },
        select: { id: true, userId: true, lifecycleState: true, displayName: true },
      });
      const missing = input.staffIds.filter((id) => !staff.some((s) => s.id === id));
      if (missing.length) throw notFound();
      const problems = staff
        .filter((s) => s.userId === hub.user.id || s.lifecycleState === 'LEAVER')
        .map((s) =>
          s.userId === hub.user.id
            ? `${s.displayName}: you cannot record your own training`
            : `${s.displayName}: has left`,
        );
      if (problems.length)
        throw new HubError('VALIDATION_FAILED', 400, `Not recorded: ${problems.join('; ')}`);
      const expiresOn = trainingExpiry(
        input.completedOn,
        course.intervalMonths,
        input.expiresOn ?? null,
      );
      const ids: string[] = [];
      for (const s of staff) {
        const data: Record<string, unknown> = {
          courseCode: course.code,
          title: course.title,
          completedOn: input.completedOn,
          sessionRef: input.sessionRef,
          ...(expiresOn ? { expiresOn } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
        };
        const r = await tx.staffRecord.create({
          data: {
            organisationId: hub.orgId as string,
            staffId: s.id,
            kind: 'TRAINING',
            data: data as Prisma.InputJsonObject,
            validFrom: toDate(input.completedOn),
            validTo: expiresOn ? toDate(expiresOn) : null,
            createdBy: hub.user.id,
          },
        });
        ids.push(r.id);
      }
      await audit(this.db, tx, hub, {
        action: 'staff.training.bulk_record',
        entity: 'training_course',
        entityId: course.id,
        summary: { attendees: ids.length, sessionRef: input.sessionRef },
      });
      return { created: ids.length, recordIds: ids };
    });
  }

  @RequirePermission(MANAGE)
  @Get('training-records/awaiting-verification')
  async trainingAwaiting(
    @Hub() hub: HubRequestContext,
  ): Promise<{ data: TrainingRecordQueueItem[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.staffRecord.findMany({
        where: {
          kind: 'TRAINING',
          supersededBy: null,
          verification: null,
        },
        include: { staff: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      const names = await userNames(
        tx,
        rows.map((r) => r.createdBy),
      );
      const data: TrainingRecordQueueItem[] = rows.map((r) => {
        const d = r.data as Record<string, unknown>;
        return {
          id: r.id,
          staffId: r.staffId,
          staffName: r.staff.displayName,
          courseCode: String(d.courseCode ?? ''),
          title: String(d.title ?? ''),
          completedOn: String(d.completedOn ?? ''),
          sessionRef: typeof d.sessionRef === 'string' ? d.sessionRef : null,
          provider: typeof d.provider === 'string' ? d.provider : null,
          recordedBy: r.createdBy,
          recordedByName: names.get(r.createdBy) ?? 'Unknown',
          createdAt: r.createdAt.toISOString(),
        };
      });
      return { data };
    });
  }

  /** Four-eyes: the person who recorded the training cannot verify it. */
  @RequirePermission(MANAGE)
  @Post('training-records/:id/verify')
  async verifyTraining(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<StaffRecordDto> {
    const input = body(TrainingRecordVerifyInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rec = await tx.staffRecord.findUnique({
        where: { id },
        include: { supersededBy: { select: { id: true } }, verification: true, staff: true },
      });
      if (!rec || rec.kind !== 'TRAINING' || rec.supersededBy) throw notFound();
      if (rec.verification)
        throw new HubError('CONFLICT', 409, 'This training record is already verified');
      if (rec.createdBy === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'You cannot verify training you recorded');
      const data = rec.data as Record<string, unknown>;
      const sessionRef = typeof data.sessionRef === 'string' ? data.sessionRef : null;
      if (input.registerRef && sessionRef && input.registerRef !== sessionRef)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The register reference does not match the recorded session',
        );
      await tx.staffRecordVerification.create({
        data: {
          organisationId: rec.organisationId,
          recordId: rec.id,
          verifiedBy: hub.user.id,
          registerRef: input.registerRef ?? sessionRef,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.training.verify',
        entity: 'staff_record',
        entityId: rec.id,
        summary: { staffId: rec.staffId, courseCode: String(data.courseCode ?? '') },
      });
      const full = await tx.staffRecord.findUniqueOrThrow({
        where: { id },
        include: { supersededBy: { select: { id: true } } },
      });
      const vRow = await tx.staffRecordVerification.findUniqueOrThrow({ where: { recordId: id } });
      return toRecordDto(full, Buffer.alloc(0), vRow);
    });
  }

  /**
   * v36 Supervision › Next due: for everyone working, the last supervision held, the next due
   * (56 days on, or 90 days after starting if none held; London dates), any upcoming booking and, when overdue, who it has escalated to.
   */
  @RequirePermission('staff.profile.view_basic')
  @Get('supervision/next-due')
  async nextDue(@Hub() hub: HubRequestContext): Promise<{ data: SupervisionNextDueDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      const staff = await tx.staff.findMany({
        where: { lifecycleState: 'ACTIVE' },
        select: { id: true, displayName: true, jobTitle: true, startDate: true },
      });
      const ids = staff.map((s) => s.id);
      const held = await tx.supervisionBooking.findMany({
        where: { staffId: { in: ids }, status: 'HELD' },
        orderBy: { scheduledAt: 'desc' },
        distinct: ['staffId'],
        select: { staffId: true, scheduledAt: true },
      });
      const booked = await tx.supervisionBooking.findMany({
        where: { staffId: { in: ids }, status: 'BOOKED', scheduledAt: { gte: now } },
        orderBy: { scheduledAt: 'asc' },
        distinct: ['staffId'],
        select: { staffId: true, scheduledAt: true },
      });
      const lastHeld = new Map(held.map((h) => [h.staffId, londonDate(h.scheduledAt)]));
      const nextBooked = new Map(booked.map((b) => [b.staffId, b.scheduledAt.toISOString()]));
      const esc = await escalationContext(tx, now);
      const rows = staff.map((s) => {
        const last = lastHeld.get(s.id) ?? null;
        // v36: never supervised → due 90 days after starting.
        const start = s.startDate ? s.startDate.toISOString().slice(0, 10) : null;
        const next = last
          ? addDays(last, SUPERVISION_EVERY_DAYS)
          : start
            ? addDays(start, 90)
            : null;
        const bookedAt = nextBooked.get(s.id) ?? null;
        const overdueDays = next ? -daysUntil(next, now) : null;
        return {
          staffId: s.id,
          staffName: s.displayName,
          jobTitle: s.jobTitle,
          lastHeldOn: last,
          nextDueOn: next,
          bookedAt,
          overdueDays,
          escalation:
            bookedAt || overdueDays === null ? null : esc.of('SUPERVISION', overdueDays),
        };
      });
      // v36 order: not booked first, by next due (earliest first); booked people last.
      rows.sort(
        (a, b) =>
          Number(!!a.bookedAt) - Number(!!b.bookedAt) ||
          (a.nextDueOn ?? '9999').localeCompare(b.nextDueOn ?? '9999'),
      );
      return { data: rows };
    });
  }

  // ---- C2: supervision bookings ---------------------------------------------------------------
  @OrgMember()
  @Get('supervision-bookings')
  async bookings(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: SupervisionBookingDto[] }> {
    const f = body(BookingQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const manager = hub.permissions.has(MANAGE);
      const mine = await tx.staff.findFirst({
        where: { userId: hub.user.id },
        select: { id: true },
      });
      // Staff see their own bookings and the ones they supervise; HR sees all.
      const visible: Prisma.SupervisionBookingWhereInput[] = [
        { supervisorUserId: hub.user.id },
        ...(mine ? [{ staffId: mine.id }] : []),
      ];
      const where: Prisma.SupervisionBookingWhereInput = {
        ...(f.staffId ? { staffId: f.staffId } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(manager ? {} : { OR: visible }),
      };
      const rows = await tx.supervisionBooking.findMany({
        where,
        take: 200,
      });
      // REQUESTED first, then BOOKED by date desc, then MISSED, then HELD by date desc.
      const rank = (s: string) =>
        s === 'REQUESTED' ? 0 : s === 'BOOKED' ? 1 : s === 'MISSED' ? 2 : s === 'HELD' ? 3 : 4;
      rows.sort((a, b) => {
        const d = rank(a.status) - rank(b.status);
        if (d) return d;
        return b.scheduledAt.getTime() - a.scheduledAt.getTime();
      });
      return { data: await this.bookingDtos(tx, rows) };
    });
  }

  @RequirePermission(MANAGE)
  @Post('staff/:id/supervision-bookings')
  async book(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) staffId: string,
    @Body() raw: unknown,
  ): Promise<SupervisionBookingDto> {
    const input = body(SupervisionBookingInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await this.createBooking(tx, hub, staffId, input);
      return (await this.bookingDtos(tx, [b]))[0]!;
    });
  }

  /** Crew self-service: ask for a supervision booking (supervisor confirmed later). */
  @OrgMember()
  @Post('staff/me/supervision-requests')
  async requestMine(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<SupervisionBookingDto> {
    const input = body(SupervisionRequestInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const mine = await tx.staff.findFirst({ where: { userId: hub.user.id } });
      if (!mine) throw new HubError('VALIDATION_FAILED', 400, 'You do not have a staff record');
      if (mine.lifecycleState === 'LEAVER')
        throw new HubError('CONFLICT', 409, 'The record is closed (leaver)');
      const at = new Date(input.scheduledAt);
      const b = await tx.supervisionBooking.create({
        data: {
          organisationId: mine.organisationId,
          staffId: mine.id,
          supervisorUserId: null,
          scheduledAt: at,
          kind: input.kind,
          topics: input.topics ?? null,
          status: 'REQUESTED',
          bookedBy: hub.user.id,
          requestedBy: hub.user.id,
        },
      });
      await this.giveCode(tx, b.id, b.organisationId);
      await audit(this.db, tx, hub, {
        action: 'staff.supervision.request',
        entity: 'supervision_booking',
        entityId: b.id,
        summary: { kind: input.kind, on: londonDate(at) },
      });
      return (await this.bookingDtos(tx, [b]))[0]!;
    });
  }

  /** Confirm a requested booking: set supervisor and time (REQUESTED → BOOKED). */
  @RequirePermission(MANAGE)
  @Post('supervision-bookings/:id/confirm')
  async confirm(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SupervisionBookingDto> {
    const input = body(SupervisionConfirmInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.supervisionBooking.findUnique({ where: { id } });
      if (!b) throw notFound();
      if (b.status !== 'REQUESTED')
        throw new HubError('CONFLICT', 409, 'Only a requested booking can be confirmed');
      const s = await tx.staff.findUnique({ where: { id: b.staffId } });
      if (s?.userId === input.supervisorUserId)
        throw new HubError('VALIDATION_FAILED', 400, 'A person cannot supervise themselves');
      const current = await tx.membership.count({
        where: { userId: input.supervisorUserId, validTo: null },
      });
      if (!current)
        throw new HubError('VALIDATION_FAILED', 400, 'The supervisor is not a current member');
      const at = new Date(input.scheduledAt);
      await tx.supervisionBooking.update({
        where: { id },
        data: {
          supervisorUserId: input.supervisorUserId,
          scheduledAt: at,
          status: 'BOOKED',
          updatedAt: new Date(),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.supervision.confirm',
        entity: 'supervision_booking',
        entityId: id,
        summary: { on: londonDate(at) },
      });
      const fresh = await tx.supervisionBooking.findUniqueOrThrow({ where: { id } });
      return (await this.bookingDtos(tx, [fresh]))[0]!;
    });
  }

  /**
   * Record the outcome. Held: an immutable SUPERVISION record is written and linked. Cancelled or
   * missed: the reason is kept and the session can be rebooked in the same step.
   */
  @OrgMember()
  @Post('supervision-bookings/:id/close')
  @HttpCode(200)
  async close(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SupervisionBookingDto> {
    const input = body(SupervisionCloseInput, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.supervisionBooking.findUnique({ where: { id } });
      if (!b) throw notFound();
      // v36 (supHeld / supMissed): the supervisor, HR, the managers and the governance lead.
      const governance =
        hub.permissions.has('staff.profile.view_basic') &&
        hub.permissions.has('compliance.evidence.verify');
      if (b.supervisorUserId !== hub.user.id && !hub.permissions.has(MANAGE) && !governance)
        throw new HubError('FORBIDDEN', 403);
      const s = await tx.staff.findUniqueOrThrow({ where: { id: b.staffId } });
      if (s.userId === hub.user.id) throw new HubError('SELF_APPROVAL', 422);
      if (b.status !== 'BOOKED')
        throw new HubError('CONFLICT', 409, 'This supervision has already been recorded');
      let recordId: string | null = null;
      let rebookedAs: string | null = null;
      if (input.status === 'HELD') {
        const heldOn = londonDate(b.scheduledAt);
        const data: Record<string, unknown> = {
          heldOn,
          supervisorUserId: b.supervisorUserId,
          bookingId: b.id,
          type: b.kind,
          attended: input.attended,
          wellbeingChecked: input.wellbeingChecked,
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.competenceConcerns ? { competenceConcerns: input.competenceConcerns } : {}),
          ...(input.agreedActions ? { agreedActions: input.agreedActions } : {}),
          ...(input.nextDueOn ? { nextDueOn: input.nextDueOn } : {}),
        };
        const r = await tx.staffRecord.create({
          data: {
            organisationId: b.organisationId,
            staffId: b.staffId,
            kind: 'SUPERVISION',
            data: data as Prisma.InputJsonObject,
            createdBy: hub.user.id,
          },
        });
        recordId = r.id;
      } else if (input.rebookAt) {
        if (!b.supervisorUserId)
          throw new HubError('VALIDATION_FAILED', 400, 'Confirm a supervisor before rebooking');
        const next = await this.createBooking(tx, hub, b.staffId, {
          supervisorUserId: b.supervisorUserId,
          scheduledAt: input.rebookAt,
          kind: b.kind as z.infer<typeof SupervisionBookingInput>['kind'],
          ...(b.topics ? { topics: b.topics } : {}),
        });
        rebookedAs = next.id;
      }
      const r = await tx.supervisionBooking.updateMany({
        where: { id, version },
        data: {
          status: input.status,
          statusReason: input.status === 'HELD' ? null : input.reason,
          recordId,
          rebookedAs,
          closedBy: hub.user.id,
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      if (input.status === 'MISSED') {
        const existing = await tx.alert.findFirst({
          where: { sourceType: 'SUPERVISION', sourceId: id, state: { not: 'RESOLVED' } },
        });
        if (!existing) {
          await tx.alert.create({
            data: {
              organisationId: b.organisationId,
              sourceType: 'SUPERVISION',
              sourceId: id,
              ownerUserId: b.supervisorUserId,
              severity: 'HIGH',
              reasonCode: 'SUPERVISION_MISSED',
              reasonText: `Missed supervision (${b.kind.replace(/_/g, ' ').toLowerCase()})`,
            },
          });
        }
      }
      await audit(this.db, tx, hub, {
        action: 'staff.supervision.close',
        entity: 'supervision_booking',
        entityId: id,
        summary: {
          status: input.status,
          staffId: b.staffId,
          recordId,
          rebookedAs,
          ...(input.status === 'HELD' ? {} : { reason: input.reason }),
        },
      });
      const fresh = await tx.supervisionBooking.findUniqueOrThrow({ where: { id } });
      return (await this.bookingDtos(tx, [fresh]))[0]!;
    });
  }

  // ---- C2/C3: the staff member acknowledges or comments -------------------------------------
  @OrgMember()
  @Get('staff-records/:id/acknowledgements')
  async acks(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<{ data: RecordAckDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rec = await this.ackableRecord(tx, hub, id, false);
      const rows = await tx.staffRecordAck.findMany({
        where: { recordId: rec.id },
        orderBy: { createdAt: 'asc' },
      });
      const names = await userNames(
        tx,
        rows.map((r) => r.userId),
      );
      return {
        data: rows.map((r) => ({
          id: r.id,
          recordId: r.recordId,
          agreed: r.agreed,
          comment: r.comment,
          userName: names.get(r.userId) ?? 'Unknown',
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  /** Only the person the record is about can acknowledge it; a later comment is a new row. */
  @RequirePermission('staff.self.update')
  @Post('staff-records/:id/acknowledgements')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<RecordAckDto> {
    const input = body(RecordAckInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rec = await this.ackableRecord(tx, hub, id, true);
      const a = await tx.staffRecordAck.create({
        data: {
          organisationId: rec.organisationId,
          recordId: rec.id,
          staffId: rec.staffId,
          userId: hub.user.id,
          agreed: input.agreed,
          comment: input.comment ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.record.acknowledge',
        entity: 'staff_record',
        entityId: rec.id,
        summary: { agreed: input.agreed, commented: input.comment !== undefined },
      });
      return {
        id: a.id,
        recordId: a.recordId,
        agreed: a.agreed,
        comment: a.comment,
        userName: hub.user.displayName,
        createdAt: a.createdAt.toISOString(),
      };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------
  private async ackableRecord(tx: TenantTx, hub: HubRequestContext, id: string, own: boolean) {
    const rec = await tx.staffRecord.findUnique({ where: { id } });
    if (!rec || (rec.kind !== 'SUPERVISION' && rec.kind !== 'APPRAISAL')) throw notFound();
    const s = await tx.staff.findUniqueOrThrow({ where: { id: rec.staffId } });
    const isSubject = s.userId === hub.user.id;
    if (own && !isSubject)
      throw new HubError(
        'FORBIDDEN',
        403,
        'Only the person the record is about can acknowledge it',
      );
    if (!isSubject && !hub.permissions.has('staff.profile.view_basic')) throw notFound();
    return rec;
  }

  /** v36 reference SUP-303…, continuing after the highest one on record. */
  private async giveCode(tx: TenantTx, id: string, orgId: string) {
    const code = await nextV36Code(tx, orgId, 'SUP', 'supervision_booking');
    await tx.$executeRaw`UPDATE supervision_booking SET code = ${code} WHERE id = ${id}::uuid`;
  }

  private async createBooking(
    tx: TenantTx,
    hub: HubRequestContext,
    staffId: string,
    input: z.infer<typeof SupervisionBookingInput>,
  ) {
    const s = await tx.staff.findUnique({ where: { id: staffId } });
    if (!s) throw notFound();
    if (s.lifecycleState === 'LEAVER')
      throw new HubError('CONFLICT', 409, 'The record is closed (leaver)');
    if (s.userId === input.supervisorUserId)
      throw new HubError('VALIDATION_FAILED', 400, 'A person cannot supervise themselves');
    const current = await tx.membership.count({
      where: { userId: input.supervisorUserId, validTo: null },
    });
    if (!current)
      throw new HubError('VALIDATION_FAILED', 400, 'The supervisor is not a current member');
    const at = new Date(input.scheduledAt);
    if (at.getTime() < Date.now() - 86_400_000)
      throw new HubError('VALIDATION_FAILED', 400, 'Book a date from today onwards');
    const b = await tx.supervisionBooking.create({
      data: {
        organisationId: s.organisationId,
        staffId,
        supervisorUserId: input.supervisorUserId,
        scheduledAt: at,
        kind: input.kind,
        topics: input.topics ?? null,
        bookedBy: hub.user.id,
      },
    });
    await this.giveCode(tx, b.id, s.organisationId);
    await audit(this.db, tx, hub, {
      action: 'staff.supervision.book',
      entity: 'supervision_booking',
      entityId: b.id,
      summary: { staffId, kind: input.kind, on: londonDate(at) },
    });
    return b;
  }

  private async bookingDtos(
    tx: TenantTx,
    rows: {
      id: string;
      staffId: string;
      supervisorUserId: string | null;
      scheduledAt: Date;
      kind: string;
      topics: string | null;
      status: string;
      statusReason: string | null;
      recordId: string | null;
      rebookedAs: string | null;
      requestedBy?: string | null;
      version: number;
    }[],
  ): Promise<SupervisionBookingDto[]> {
    const staff = await tx.staff.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
      select: { id: true, displayName: true },
    });
    const names = await userNames(tx, [
      ...rows.map((r) => r.supervisorUserId),
      ...rows.map((r) => r.requestedBy ?? null),
    ]);
    return rows.map((r) => ({
      id: r.id,
      code: (r as { code?: string | null }).code ?? null,
      staffId: r.staffId,
      staffName: staff.find((s) => s.id === r.staffId)?.displayName ?? 'Unknown',
      supervisorUserId: r.supervisorUserId,
      supervisorName: r.supervisorUserId ? (names.get(r.supervisorUserId) ?? null) : null,
      scheduledAt: r.scheduledAt.toISOString(),
      kind: r.kind,
      topics: r.topics,
      status: r.status as SupervisionBookingDto['status'],
      statusReason: r.statusReason,
      recordId: r.recordId,
      rebookedAs: r.rebookedAs,
      requestedByName: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null,
      version: r.version,
    }));
  }
}
