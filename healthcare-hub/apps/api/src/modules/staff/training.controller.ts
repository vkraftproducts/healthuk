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
  TrainingCourseCreate,
  TrainingCourseRetire,
  type RecordAckDto,
  type SupervisionBookingDto,
  type TrainingCourseDto,
} from '@hub/contracts';
import { londonDate, trainingExpiry } from '@hub/rules';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
import { toDate } from '../requirements/requirements.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MANAGE = 'staff.profile.manage';
const BookingQuery = z.object({
  staffId: z.string().uuid().optional(),
  status: z.enum(['BOOKED', 'HELD', 'CANCELLED', 'MISSED']).optional(),
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
        orderBy: { scheduledAt: 'desc' },
        take: 200,
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
      if (b.supervisorUserId !== hub.user.id && !hub.permissions.has(MANAGE))
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
      supervisorUserId: string;
      scheduledAt: Date;
      kind: string;
      topics: string | null;
      status: string;
      statusReason: string | null;
      recordId: string | null;
      rebookedAs: string | null;
      version: number;
    }[],
  ): Promise<SupervisionBookingDto[]> {
    const staff = await tx.staff.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
      select: { id: true, displayName: true },
    });
    const names = await userNames(
      tx,
      rows.map((r) => r.supervisorUserId),
    );
    return rows.map((r) => ({
      id: r.id,
      staffId: r.staffId,
      staffName: staff.find((s) => s.id === r.staffId)?.displayName ?? 'Unknown',
      supervisorUserId: r.supervisorUserId,
      supervisorName: names.get(r.supervisorUserId) ?? 'Unknown',
      scheduledAt: r.scheduledAt.toISOString(),
      kind: r.kind,
      topics: r.topics,
      status: r.status as SupervisionBookingDto['status'],
      statusReason: r.statusReason,
      recordId: r.recordId,
      rebookedAs: r.rebookedAs,
      version: r.version,
    }));
  }
}
