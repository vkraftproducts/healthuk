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
} from '@nestjs/common';
import { Prisma, type Db, type TenantTx } from '@hub/db';
import {
  allocationWindow,
  highestPermittedLoad,
  nextCode,
  overlapText,
  plainLicenceWords,
  queuePush,
  recheckAllocations,
  resolveJobAlerts,
  shiftCrewUserIds,
  shiftGateFor,
  staffReadinessFor,
  travelBufferMinutes,
  upsertJobAlert,
  validateJobOnShift,
} from '@hub/domain';
import {
  ALLOCATABLE,
  checkJobTransition,
  drivingCategoryFor,
  expandRecurrence,
  formatDate,
  londonDate,
  type JobState,
} from '@hub/rules';
import type { BookingDto, CrewReadinessDto, ShiftGateDto } from '@hub/contracts';
import {
  AllocateInput,
  BookingCreate,
  CrewEndInput,
  CrewInput,
  CrewReadinessQuery,
  CrewSwapInput,
  ReassignInput,
  ExceptionInput,
  ExceptionRequestCreate,
  ExceptionRequestDecision,
  ExceptionRequestQuery,
  JobPatch,
  JobPatchQuery,
  PlannerQuery,
  ShiftCancelInput,
  ShiftCreate,
  ShiftsQuery,
  StatusInput,
  ValidateInput,
  VehicleSwapInput,
  type ExceptionRequestDto,
  type JobDetailDto,
  type JobDto,
  type ShiftDto,
  type ValidationDto,
} from '@hub/contracts';
import { z } from 'zod';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { assertNotFuture, audit, body, ifMatchVersion, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MAX_OFFLINE_MS = 7 * 86_400_000;
const NOT_STARTED = ['ALLOCATED', 'OFFERED', 'ACKNOWLEDGED'];
const ts = (d: Date | null) => (d ? d.toISOString() : null);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftInclude = {
  crew: { orderBy: { startsAt: 'asc' } },
  allocations: {
    where: { active: true },
    include: { job: { select: { code: true, state: true } } },
    orderBy: { startsAt: 'asc' },
  },
  changes: { orderBy: { at: 'asc' } },
} as const;
type ShiftRow = Prisma.ShiftGetPayload<{ include: typeof shiftInclude }>;
type ContractTypeValue = z.infer<typeof BookingDto>['contractType'];

const CHECK_WORDS: Record<string, string> = {
  STAFF_CLEARANCE: 'crew clearance',
  LICENCE: 'driving licence',
  COMPETENCE: 'competence',
  VEHICLE_ROADWORTHY: 'vehicle roadworthiness',
  VEHICLE_SUITABILITY: 'vehicle suitability',
  EQUIPMENT: 'equipment',
  TIME_CONFLICT: 'time clash',
  SHIFT_GATE: 'vehicle check and cleaning',
};
function exceptionExpiry(expiresAt: string, now: Date): Date {
  const expires = new Date(expiresAt);
  if (expires <= now || expires.getTime() - now.getTime() > 7 * 86_400_000)
    throw new HubError('VALIDATION_FAILED', 400, 'An exception lasts at most 7 days');
  return expires;
}

async function exceptionRequestDtos(
  tx: TenantTx,
  rows: Prisma.AllocationExceptionRequestGetPayload<object>[],
): Promise<ExceptionRequestDto[]> {
  const jobs = new Map(
    (
      await tx.job.findMany({
        where: { id: { in: rows.map((r) => r.jobId) } },
        select: { id: true, code: true },
      })
    ).map((j) => [j.id, j.code]),
  );
  const shifts = await tx.shift.findMany({
    where: { id: { in: rows.map((r) => r.shiftId) } },
    select: { id: true, vehicleId: true },
  });
  const vehicles = new Map(
    (
      await tx.vehicle.findMany({
        where: { id: { in: shifts.map((s) => s.vehicleId) } },
        select: { id: true, callsign: true },
      })
    ).map((v) => [v.id, v.callsign]),
  );
  const callsign = new Map(shifts.map((s) => [s.id, vehicles.get(s.vehicleId) ?? null]));
  const names = await userNames(tx, [
    ...rows.map((r) => r.requestedBy),
    ...rows.map((r) => r.decidedBy),
  ]);
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    jobCode: jobs.get(r.jobId) ?? '',
    shiftId: r.shiftId,
    vehicleCallsign: callsign.get(r.shiftId) ?? null,
    checkCode: r.checkCode,
    reason: r.reason,
    expiresAt: r.expiresAt.toISOString(),
    requestedBy: r.requestedBy,
    requestedByName: names.get(r.requestedBy) ?? null,
    requestedAt: r.requestedAt.toISOString(),
    status: r.status as ExceptionRequestDto['status'],
    decidedBy: r.decidedBy,
    decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
    decidedAt: ts(r.decidedAt),
    decisionNote: r.decisionNote,
    exceptionId: r.exceptionId,
  }));
}

/** Failed checks in plain words for the problem detail; codes stay in the checks array. */
const failedText = (v: { blockers: string[]; exceptable: string[] }) =>
  [...v.blockers, ...v.exceptable].map((c) => CHECK_WORDS[c] ?? 'another check').join(', ');
type JobRow = Prisma.JobGetPayload<{ include: { allocations: true } }>;

function jobDto(j: JobRow): JobDto {
  return {
    id: j.id,
    code: j.code,
    bookingId: j.bookingId,
    seriesIndex: j.seriesIndex,
    detached: j.detached,
    locationId: j.locationId,
    journeyDate: iso(j.journeyDate),
    pickupFrom: j.pickupFrom.toISOString(),
    pickupTo: j.pickupTo.toISOString(),
    appointmentAt: ts(j.appointmentAt),
    plannedStart: j.plannedStart.toISOString(),
    plannedEnd: j.plannedEnd.toISOString(),
    pickupAddress: j.pickupAddress,
    destinationAddress: j.destinationAddress,
    accessNotes: j.accessNotes,
    accessPlanReviewed: j.accessPlanReviewed,
    patientRef: j.patientRef,
    mobility: j.mobility,
    weightKg: j.weightKg,
    stairs: j.stairs,
    escorts: j.escorts,
    infectionPrecautions: j.infectionPrecautions,
    commsNeeds: j.commsNeeds,
    requiredEquipment: j.requiredEquipment,
    requiredSkills: j.requiredSkills,
    crewSize: j.crewSize,
    blueLights: j.blueLights,
    returnOfJobId: j.returnOfJobId,
    state: j.state,
    shiftId: j.allocations.find((a) => a.active)?.shiftId ?? null,
    version: j.version,
  };
}

const checksOf = (v: ValidationDto) =>
  v.checks.map((c) => ({
    code: c.code,
    result: c.result,
    reasonText: c.reasonText,
    overridable: c.overridable,
    excepted: c.excepted,
    details: c.details,
    fix: c.fix ?? null,
  }));
const isExclusion = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  /23P01|exclusion|no_overlap/i.test(`${e.code} ${e.message}`);

/** Bookings, jobs, allocation and status (JOB-01..04, wireframe 04). */
@Controller()
export class JobsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('jobs.job.view')
  @Get('bookings')
  async bookings(@Hub() hub: HubRequestContext) {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.booking.findMany({
        include: { jobs: { include: { allocations: true }, orderBy: { plannedStart: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
    return {
      data: rows.map((b) => ({
        id: b.id,
        customer: b.customer,
        reference: b.reference,
        contractType: b.contractType as ContractTypeValue,
        jobs: b.jobs.map(jobDto),
      })),
    };
  }

  @RequirePermission('jobs.booking.manage')
  @Post('bookings')
  async book(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(BookingCreate, raw);
    const j = input.job;
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.location.findUnique({ where: { id: j.locationId } }))) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(j.locationId)) throw notFound();
      const orgId = hub.orgId as string;
      const b = await tx.booking.create({
        data: {
          organisationId: orgId,
          customer: input.customer,
          reference: input.reference ?? null,
          recurrence: (input.recurrence ?? undefined) as Prisma.InputJsonObject | undefined,
          contractType: input.contractType ?? null,
          ...(input.contractType === 'NHS' && input.nhsEligibility
            ? {
                nhsEligibilityMet: input.nhsEligibility.met,
                nhsEligibilityCriteria: input.nhsEligibility.criteria,
                nhsEligibilityAssessedBy: input.nhsEligibility.assessedBy,
              }
            : {}),
          createdBy: hub.user.id,
        },
      });
      const warnings: string[] = [];
      if (j.weightKg) {
        const highest = await highestPermittedLoad(tx);
        if (highest !== null && j.weightKg > highest)
          warnings.push(
            `The recorded weight (${j.weightKg} kg) is above the permitted load of every ` +
              `vehicle (highest ${highest} kg). Arrange suitable equipment before allocating.`,
          );
      }
      const firstDay = londonDate(new Date(j.plannedStart));
      const days = input.recurrence ? expandRecurrence(firstDay, input.recurrence) : [firstDay];
      if (days.length === 0)
        throw new HubError('VALIDATION_FAILED', 400, 'The recurrence produces no journeys');
      const base = new Date(`${firstDay}T00:00:00.000Z`).getTime();
      const jobs = [];
      for (const [i, d] of days.entries()) {
        // Each instance keeps the same local clock times (Europe/London) shifted by whole days.
        const delta = new Date(`${d}T00:00:00.000Z`).getTime() - base;
        const at = (s: string) => new Date(new Date(s).getTime() + delta);
        const shared = {
          organisationId: orgId,
          bookingId: b.id,
          seriesIndex: input.recurrence ? i : null,
          locationId: j.locationId,
          journeyDate: new Date(`${d}T00:00:00.000Z`),
          accessNotes: j.accessNotes ?? null,
          accessPlanReviewed: j.accessPlanReviewed,
          patientRef: j.patientRef,
          blueLights: j.blueLights,
          mobility: j.mobility,
          weightKg: j.weightKg ?? null,
          stairs: j.stairs,
          escorts: j.escorts,
          infectionPrecautions: j.infectionPrecautions,
          commsNeeds: j.commsNeeds ?? null,
          requiredEquipment: j.requiredEquipment,
          requiredSkills: j.requiredSkills,
          crewSize: j.crewSize,
          createdBy: hub.user.id,
        };
        const legs = [];
        const row = await tx.job.create({
          data: {
            ...shared,
            code: await nextCode(tx, orgId, 'J'),
            pickupFrom: at(j.pickupFrom),
            pickupTo: at(j.pickupTo),
            appointmentAt: j.appointmentAt ? at(j.appointmentAt) : null,
            plannedStart: at(j.plannedStart),
            plannedEnd: at(j.plannedEnd),
            pickupAddress: j.pickupAddress,
            destinationAddress: j.destinationAddress,
          },
          include: { allocations: true },
        });
        legs.push(row);
        // E1: the return journey is its own job, addresses swapped, linked to the outward leg.
        const r = input.returnJourney;
        if (r)
          legs.push(
            await tx.job.create({
              data: {
                ...shared,
                code: await nextCode(tx, orgId, 'J'),
                returnOfJobId: row.id,
                pickupFrom: at(r.pickupFrom),
                pickupTo: at(r.pickupTo),
                appointmentAt: null,
                plannedStart: at(r.plannedStart),
                plannedEnd: at(r.plannedEnd),
                pickupAddress: j.destinationAddress,
                destinationAddress: j.pickupAddress,
              },
              include: { allocations: true },
            }),
          );
        for (const leg of legs) {
          await tx.jobStatusEvent.create({
            data: {
              organisationId: orgId,
              jobId: leg.id,
              fromState: null,
              toState: 'BOOKED',
              actorUserId: hub.user.id,
              capturedAt: new Date(),
            },
          });
          if (input.patientContact)
            await tx.patientContact.createMany({
              data: [
                {
                  jobId: leg.id,
                  organisationId: orgId,
                  name: input.patientContact.name,
                  phone: input.patientContact.phone ?? null,
                },
              ],
            });
          jobs.push(leg);
        }
      }
      // IDs and counts only: no patient details in the audit trail.
      await audit(this.db, tx, hub, {
        action: 'jobs.booking.create',
        entity: 'booking',
        entityId: b.id,
        summary: {
          jobs: jobs.length,
          contractType: b.contractType,
          returnJourney: !!input.returnJourney,
        },
      });
      return {
        id: b.id,
        customer: b.customer,
        reference: b.reference,
        contractType: b.contractType as ContractTypeValue,
        jobs: jobs.map(jobDto),
        warnings,
      };
    });
  }

  @RequirePermission('jobs.job.view')
  @Get('jobs')
  async jobs(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        locationId: z.string().uuid().optional(),
      }),
      q,
    );
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.job.findMany({
        where: {
          journeyDate: new Date(`${f.date}T00:00:00.000Z`),
          ...(f.locationId ? { locationId: f.locationId } : {}),
        },
        include: { allocations: true },
        orderBy: { plannedStart: 'asc' },
      }),
    );
    return { data: rows.map(jobDto) };
  }

  /** Control sees all jobs; crew only the jobs on their own shift (UAT-05: anything else is 404). */
  @OrgMember()
  @Get('jobs/:id')
  async job(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<JobDetailDto> {
    requireAny(hub, 'jobs.job.view', 'crew.today.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.job.count({ where: { id } }))) throw notFound();
      if (!hub.permissions.has('jobs.job.view') && !(await this.isCrewOn(tx, hub, id)))
        throw notFound();
      return this.detail(tx, hub, id);
    });
  }

  @RequirePermission('jobs.booking.manage')
  @Patch('jobs/:id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Query() q: unknown,
    @Body() raw: unknown,
  ) {
    const expected = ifMatchVersion(req);
    const { scope } = body(JobPatchQuery, q);
    const input = body(JobPatch, raw);
    const absolute = [
      'pickupFrom',
      'pickupTo',
      'appointmentAt',
      'plannedStart',
      'plannedEnd',
    ].filter((k) => k in input);
    if (scope === 'following' && absolute.length)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'For this-and-following, move times with timeShiftMinutes',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const j = await tx.job.findUnique({ where: { id } });
      if (!j) throw notFound();
      if (j.version !== expected)
        throw new HubError(
          'STALE_VERSION',
          409,
          'The job was changed by someone else; reload and retry',
        );
      const targets =
        scope === 'following' && j.seriesIndex !== null
          ? await tx.job.findMany({
              where: {
                bookingId: j.bookingId,
                seriesIndex: { gte: j.seriesIndex },
                detached: false,
                state: { in: ['BOOKED', 'ASSESSED', 'REASSIGNED', 'REFUSED'] },
              },
              orderBy: { seriesIndex: 'asc' },
            })
          : [j];
      if (!(ALLOCATABLE as readonly string[]).includes(j.state))
        throw new HubError(
          'CONFLICT',
          409,
          'Release the allocation before changing an allocated job',
        );
      const { timeShiftMinutes, ...fields } = input;
      const shift = (d: Date | null) =>
        d && timeShiftMinutes ? new Date(d.getTime() + timeShiftMinutes * 60_000) : d;
      const updated = [];
      for (const t of targets) {
        const data: Prisma.JobUpdateInput = {
          ...fields,
          ...(timeShiftMinutes
            ? {
                pickupFrom: shift(t.pickupFrom)!,
                pickupTo: shift(t.pickupTo)!,
                plannedStart: shift(t.plannedStart)!,
                plannedEnd: shift(t.plannedEnd)!,
                appointmentAt: shift(t.appointmentAt),
              }
            : {}),
          ...(input.pickupFrom ? { pickupFrom: new Date(input.pickupFrom) } : {}),
          ...(input.pickupTo ? { pickupTo: new Date(input.pickupTo) } : {}),
          ...(input.plannedStart ? { plannedStart: new Date(input.plannedStart) } : {}),
          ...(input.plannedEnd ? { plannedEnd: new Date(input.plannedEnd) } : {}),
          ...(input.appointmentAt ? { appointmentAt: new Date(input.appointmentAt) } : {}),
          // An instance edited on its own leaves the series (later series edits skip it).
          ...(scope === 'this' && t.seriesIndex !== null ? { detached: true } : {}),
        };
        updated.push(
          await tx.job.update({ where: { id: t.id }, data, include: { allocations: true } }),
        );
      }
      for (const u of updated)
        if (u.plannedEnd <= u.plannedStart || u.pickupTo <= u.pickupFrom)
          throw new HubError('VALIDATION_FAILED', 400, 'Windows must end after they start');
      await audit(this.db, tx, hub, {
        action: 'jobs.job.update',
        entity: 'job',
        entityId: id,
        summary: { scope, jobs: updated.length, fields: Object.keys(input).join(',') },
      });
      return { data: updated.map(jobDto) };
    });
  }

  @RequirePermission('jobs.allocate')
  @Post('jobs/:id/validate')
  async validate(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ValidationDto> {
    const { shiftId } = body(ValidateInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.assertJobAndShift(tx, id, shiftId);
      const current = await tx.jobAllocation.findFirst({
        where: { jobId: id, active: true, shiftId },
      });
      const v = await validateJobOnShift(tx, {
        jobId: id,
        shiftId,
        now: new Date(),
        ignoreAllocationId: current?.id,
      });
      return { jobId: id, shiftId, ...v };
    });
  }

  @RequirePermission('jobs.allocate')
  @Post('jobs/:id/allocate')
  async allocate(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<JobDetailDto> {
    const { shiftId } = body(AllocateInput, raw);
    const out = await this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const { job } = await this.assertJobAndShift(tx, id, shiftId);
        if (!(ALLOCATABLE as readonly string[]).includes(job.state))
          throw new HubError(
            'CONFLICT',
            409,
            `A ${job.state.toLowerCase()} job cannot be allocated`,
          );
        const now = new Date();
        const v = await validateJobOnShift(tx, { jobId: id, shiftId, now });
        if (!v.allowed) {
          await audit(this.db, tx, hub, {
            action: 'jobs.allocation.blocked',
            entity: 'job',
            entityId: id,
            summary: { shiftId, blockers: v.blockers.join(',') },
          });
          return { blocked: v };
        }
        const w = allocationWindow(job, await travelBufferMinutes(tx, job.organisationId));
        const exceptions = await tx.allocationException.findMany({
          where: { jobId: id, expiresAt: { gt: now } },
          select: { id: true },
        });
        await tx.jobAllocation.create({
          data: {
            organisationId: job.organisationId,
            jobId: id,
            shiftId,
            startsAt: w.start,
            endsAt: w.end,
            validatedAt: now,
            validationResult: checksOf({ jobId: id, shiftId, ...v }) as Prisma.InputJsonArray,
            exceptionIds: exceptions.map((e) => e.id),
            allocatedBy: hub.user.id,
          },
        });
        await tx.jobStatusEvent.create({
          data: {
            organisationId: job.organisationId,
            jobId: id,
            fromState: job.state,
            toState: 'ALLOCATED',
            actorUserId: hub.user.id,
            capturedAt: now,
          },
        });
        await tx.job.update({ where: { id }, data: { state: 'ALLOCATED' } });
        await resolveJobAlerts(tx, id, now);
        await audit(this.db, tx, hub, {
          action: 'jobs.allocate',
          entity: 'job',
          entityId: id,
          summary: { shiftId, exceptions: exceptions.length },
        });
        return { detail: await this.detail(tx, hub, id) };
      })
      .catch((e: unknown) => {
        // Two dispatchers racing for the same slot: the database exclusion constraint decides.
        if (isExclusion(e))
          throw new HubError(
            'ALLOCATION_BLOCKED',
            409,
            'Another job was just allocated to that shift at an overlapping time',
            [{ code: 'TIME_CONFLICT', result: 'FAIL', reasonText: 'Overlaps another booking' }],
          );
        throw e;
      });
    // Blocked: nothing was written except the audit event; the response lists every check.
    if (out.blocked)
      throw new HubError(
        'ALLOCATION_BLOCKED',
        409,
        `Cannot allocate: ${failedText(out.blocked)}`,
        checksOf({ jobId: id, shiftId, ...out.blocked }),
      );
    return out.detail as JobDetailDto;
  }

  /** Re-checks at dispatch (PRD 4.8) before offering the job to the crew. */
  @RequirePermission('jobs.allocate')
  @Post('jobs/:id/offer')
  async offer(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<JobDetailDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job) throw notFound();
      if (job.state !== 'ALLOCATED')
        throw new HubError('CONFLICT', 409, 'Only an allocated job can be offered');
      const al = await tx.jobAllocation.findFirstOrThrow({ where: { jobId: id, active: true } });
      const now = new Date();
      const v = await validateJobOnShift(tx, {
        jobId: id,
        shiftId: al.shiftId,
        now,
        ignoreAllocationId: al.id,
      });
      if (!v.allowed)
        throw new HubError(
          'ALLOCATION_BLOCKED',
          409,
          `No longer valid: ${failedText(v)}`,
          checksOf({ jobId: id, shiftId: al.shiftId, ...v }),
        );
      await tx.jobStatusEvent.create({
        data: {
          organisationId: job.organisationId,
          jobId: id,
          fromState: 'ALLOCATED',
          toState: 'OFFERED',
          actorUserId: hub.user.id,
          capturedAt: now,
        },
      });
      await tx.job.update({ where: { id }, data: { state: 'OFFERED' } });
      await queuePush(tx, {
        orgId: job.organisationId,
        userIds: await shiftCrewUserIds(tx, al.shiftId),
        kind: 'JOB_OFFERED',
        refId: id,
        event: `offer:${al.id}`,
      });
      await audit(this.db, tx, hub, { action: 'jobs.offer', entity: 'job', entityId: id });
      return this.detail(tx, hub, id);
    });
  }

  @OrgMember()
  @Post('jobs/:id/status')
  async status(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<JobDetailDto> {
    requireAny(hub, 'crew.job.progress', 'jobs.allocate', 'jobs.booking.manage');
    const input = body(StatusInput, raw);
    const now = new Date();
    const captured = new Date(input.capturedAt);
    assertNotFuture(captured, now);
    if (now.getTime() - captured.getTime() > MAX_OFFLINE_MS)
      throw new HubError('VALIDATION_FAILED', 400, 'Updates older than 7 days cannot be submitted');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job) throw notFound();
      const crew = await this.isCrewOn(tx, hub, id);
      const control =
        hub.permissions.has('jobs.allocate') || hub.permissions.has('jobs.booking.manage');
      if (!crew && !control) throw notFound();
      const dup = await tx.jobStatusEvent.findFirst({
        where: { clientSubmissionId: input.clientSubmissionId },
      });
      if (dup) {
        if (dup.jobId !== id || dup.actorUserId !== hub.user.id || dup.toState !== input.state)
          throw new HubError('CONFLICT', 409, 'That submission id was used for a different update');
        return this.detail(tx, hub, id); // retried from the offline outbox: exactly one record
      }
      const actor: 'CREW' | 'CONTROL' =
        crew && hub.permissions.has('crew.job.progress') ? 'CREW' : 'CONTROL';
      if (input.state === 'ALLOCATED' || input.state === 'OFFERED')
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Use the allocate and offer actions');
      const refusal = checkJobTransition({
        from: job.state as JobState,
        to: input.state,
        actor,
        reason: input.reason,
      });
      if (refusal === 'REASON_REQUIRED')
        throw new HubError('VALIDATION_FAILED', 400, 'A reason is required');
      if (refusal)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          `Cannot move a ${job.state.toLowerCase()} job to ${input.state.toLowerCase()}`,
        );
      // E1: a job is assessed only once its access plan has been reviewed.
      if (input.state === 'ASSESSED' && !job.accessPlanReviewed)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Tick "access plan reviewed" before marking the job as assessed',
        );
      // E5: after a vehicle swap the replacement needs its own check and cleaning first.
      if (input.state === 'EN_ROUTE') await this.assertSwappedVehicleReady(tx, id);
      await tx.jobStatusEvent.create({
        data: {
          organisationId: job.organisationId,
          jobId: id,
          fromState: job.state,
          toState: input.state,
          actorUserId: hub.user.id,
          capturedAt: captured,
          reason: input.reason ?? null,
          clientSubmissionId: input.clientSubmissionId,
        },
      });
      await tx.job.update({ where: { id }, data: { state: input.state } });
      if (['CANCELLED', 'REFUSED', 'REASSIGNED'].includes(input.state)) {
        const held = await tx.jobAllocation.findFirst({ where: { jobId: id, active: true } });
        if (held && actor === 'CONTROL')
          await queuePush(tx, {
            orgId: job.organisationId,
            userIds: await shiftCrewUserIds(tx, held.shiftId),
            kind: 'JOB_CHANGED',
            refId: id,
            event: `${input.state}:${input.clientSubmissionId}`,
          });
        await tx.jobAllocation.updateMany({
          where: { jobId: id, active: true },
          data: { active: false, releasedAt: now, releaseReason: input.reason ?? input.state },
        });
      }
      if (input.state === 'CANCELLED' || input.state === 'COMPLETED')
        await resolveJobAlerts(tx, id, now);
      // Reasons can mention circumstances: only codes go to the audit trail.
      await audit(this.db, tx, hub, {
        action: 'jobs.status',
        entity: 'job',
        entityId: id,
        summary: { from: job.state, to: input.state, actor },
      });
      return this.detail(tx, hub, id);
    });
  }

  /** Only policy-level failures can be excepted; statutory and safety failures have no path (JOB-03). */
  @RequirePermission('allocation.exception.approve')
  @Post('allocation-exceptions')
  async exception(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(ExceptionInput, raw);
    const now = new Date();
    const expires = exceptionExpiry(input.expiresAt, now);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const job = await this.assertExceptable(tx, input, now);
      const e = await tx.allocationException.create({
        data: {
          organisationId: job.organisationId,
          jobId: job.id,
          checkCode: input.checkCode,
          approverId: hub.user.id,
          reason: input.reason,
          expiresAt: expires,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'allocation.exception.approve',
        entity: 'job',
        entityId: job.id,
        summary: { checkCode: input.checkCode, expiresAt: input.expiresAt },
      });
      return {
        id: e.id,
        jobId: e.jobId,
        checkCode: e.checkCode,
        approverId: e.approverId,
        reason: e.reason,
        expiresAt: e.expiresAt.toISOString(),
      };
    });
  }

  /**
   * A dispatcher asks; a different person with approval rights decides (finding 69). Only a
   * failing policy-level check can be asked about; statutory and safety checks have no path.
   */
  @RequirePermission('jobs.allocate')
  @Post('allocation-exception-requests')
  async requestException(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<ExceptionRequestDto> {
    const input = body(ExceptionRequestCreate, raw);
    const now = new Date();
    const expires = exceptionExpiry(input.expiresAt, now);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const job = await this.assertExceptable(tx, input, now);
      const open = await tx.allocationExceptionRequest.findFirst({
        where: { jobId: job.id, checkCode: input.checkCode, status: 'REQUESTED' },
        select: { id: true },
      });
      if (open)
        throw new HubError('CONFLICT', 409, 'An exception has already been asked for this check');
      const r = await tx.allocationExceptionRequest.create({
        data: {
          organisationId: job.organisationId,
          jobId: job.id,
          shiftId: input.shiftId,
          checkCode: input.checkCode,
          reason: input.reason,
          expiresAt: expires,
          requestedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'allocation.exception.request',
        entity: 'job',
        entityId: job.id,
        summary: { requestId: r.id, checkCode: input.checkCode },
      });
      return (await exceptionRequestDtos(tx, [r]))[0]!;
    });
  }

  @OrgMember()
  @Get('allocation-exception-requests')
  async exceptionRequests(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, 'jobs.allocate', 'allocation.exception.approve');
    const f = body(ExceptionRequestQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.allocationExceptionRequest.findMany({
        where: {
          ...(f.status ? { status: f.status } : {}),
          ...(f.jobId ? { jobId: f.jobId } : {}),
        },
        orderBy: { requestedAt: 'desc' },
        take: 200,
      });
      return { data: await exceptionRequestDtos(tx, rows) };
    });
  }

  @RequirePermission('allocation.exception.approve')
  @Post('allocation-exception-requests/:id/decide')
  async decideException(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ExceptionRequestDto> {
    const input = body(ExceptionRequestDecision, raw);
    const now = new Date();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.allocationExceptionRequest.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status !== 'REQUESTED')
        throw new HubError('CONFLICT', 409, 'This request has already been decided');
      if (r.requestedBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          403,
          'Someone other than the person who asked must decide this exception',
        );
      let exceptionId: string | null = null;
      if (input.decision === 'APPROVED') {
        if (r.expiresAt <= now)
          throw new HubError('CONFLICT', 409, 'This request has expired; ask again');
        // Re-checked at decision time: the failure must still exist and still be policy-level.
        const job = await this.assertExceptable(
          tx,
          { jobId: r.jobId, shiftId: r.shiftId, checkCode: r.checkCode },
          now,
        );
        const e = await tx.allocationException.create({
          data: {
            organisationId: job.organisationId,
            jobId: job.id,
            checkCode: r.checkCode,
            approverId: hub.user.id,
            reason: r.reason,
            expiresAt: r.expiresAt,
          },
        });
        exceptionId = e.id;
      }
      const done = await tx.allocationExceptionRequest.update({
        where: { id },
        data: {
          status: input.decision,
          decidedBy: hub.user.id,
          decidedAt: now,
          decisionNote: input.note ?? null,
          exceptionId,
        },
      });
      await audit(this.db, tx, hub, {
        action:
          input.decision === 'APPROVED'
            ? 'allocation.exception.approve'
            : 'allocation.exception.reject',
        entity: 'job',
        entityId: r.jobId,
        summary: { requestId: id, checkCode: r.checkCode },
      });
      return (await exceptionRequestDtos(tx, [done]))[0]!;
    });
  }

  /**
   * E5: move a job to another shift. The checks run again for the new shift; the old allocation
   * ends with the reason, and the old crew is told. Blocked moves change nothing.
   */
  @RequirePermission('jobs.allocate')
  @Post('jobs/:id/reassign')
  async reassign(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<JobDetailDto> {
    const input = body(ReassignInput, raw);
    const out = await this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const { job } = await this.assertJobAndShift(tx, id, input.shiftId);
        const held = await tx.jobAllocation.findFirst({ where: { jobId: id, active: true } });
        const movable = [...ALLOCATABLE, ...NOT_STARTED] as string[];
        if (!movable.includes(job.state))
          throw new HubError(
            'CONFLICT',
            409,
            `A ${job.state.toLowerCase().replace(/_/g, ' ')} job cannot be moved`,
          );
        if (held?.shiftId === input.shiftId)
          throw new HubError('CONFLICT', 409, 'The job is already on that shift');
        const now = new Date();
        const v = await validateJobOnShift(tx, {
          jobId: id,
          shiftId: input.shiftId,
          now,
          ignoreAllocationId: held?.id,
        });
        if (!v.allowed) {
          await audit(this.db, tx, hub, {
            action: 'jobs.reassign.blocked',
            entity: 'job',
            entityId: id,
            summary: { shiftId: input.shiftId, blockers: v.blockers.join(',') },
          });
          return { blocked: v };
        }
        if (held) {
          await tx.jobAllocation.update({
            where: { id: held.id },
            data: { active: false, releasedAt: now, releaseReason: input.reason },
          });
          await queuePush(tx, {
            orgId: job.organisationId,
            userIds: await shiftCrewUserIds(tx, held.shiftId),
            kind: 'JOB_CHANGED',
            refId: id,
            event: `reassign:${held.id}`,
          });
        }
        const w = allocationWindow(job, await travelBufferMinutes(tx, job.organisationId));
        const exceptions = await tx.allocationException.findMany({
          where: { jobId: id, expiresAt: { gt: now } },
          select: { id: true },
        });
        await tx.jobAllocation.create({
          data: {
            organisationId: job.organisationId,
            jobId: id,
            shiftId: input.shiftId,
            startsAt: w.start,
            endsAt: w.end,
            validatedAt: now,
            validationResult: checksOf({
              jobId: id,
              shiftId: input.shiftId,
              ...v,
            }) as Prisma.InputJsonArray,
            exceptionIds: exceptions.map((e) => e.id),
            allocatedBy: hub.user.id,
          },
        });
        if (held)
          await tx.jobStatusEvent.create({
            data: {
              organisationId: job.organisationId,
              jobId: id,
              fromState: job.state,
              toState: 'REASSIGNED',
              actorUserId: hub.user.id,
              capturedAt: now,
              reason: input.reason,
            },
          });
        await tx.jobStatusEvent.create({
          data: {
            organisationId: job.organisationId,
            jobId: id,
            fromState: held ? 'REASSIGNED' : job.state,
            toState: 'ALLOCATED',
            actorUserId: hub.user.id,
            capturedAt: now,
            reason: held ? null : input.reason,
          },
        });
        await tx.job.update({ where: { id }, data: { state: 'ALLOCATED' } });
        await resolveJobAlerts(tx, id, now);
        await audit(this.db, tx, hub, {
          action: 'jobs.reassign',
          entity: 'job',
          entityId: id,
          summary: { fromShiftId: held?.shiftId ?? null, shiftId: input.shiftId },
        });
        return { detail: await this.detail(tx, hub, id) };
      })
      .catch((e: unknown) => {
        if (isExclusion(e))
          throw new HubError(
            'ALLOCATION_BLOCKED',
            409,
            'Another job was just allocated to that shift at an overlapping time',
            [{ code: 'TIME_CONFLICT', result: 'FAIL', reasonText: 'Overlaps another booking' }],
          );
        throw e;
      });
    if (out.blocked)
      throw new HubError(
        'ALLOCATION_BLOCKED',
        409,
        `Cannot move: ${failedText(out.blocked)}`,
        checksOf({ jobId: id, shiftId: input.shiftId, ...out.blocked }),
      );
    return out.detail as JobDetailDto;
  }

  // ---- helpers ------------------------------------------------------------------------
  /** E5: the vehicle now on the shift, if swapped in, needs a passed VDI and cleaning. */
  private async assertSwappedVehicleReady(tx: TenantTx, jobId: string) {
    const al = await tx.jobAllocation.findFirst({ where: { jobId, active: true } });
    if (!al) return;
    const shift = await tx.shift.findUniqueOrThrow({ where: { id: al.shiftId } });
    const swapped = await tx.shiftChange.count({
      where: { shiftId: shift.id, kind: 'VEHICLE_SWAP' },
    });
    if (!swapped) return;
    const vdi = await tx.vdi.findFirst({
      where: { shiftId: shift.id, vehicleId: shift.vehicleId },
      orderBy: { capturedAt: 'desc' },
      include: { items: true },
    });
    const cleaned = await tx.cleaningRecord.count({
      where: { shiftId: shift.id, vehicleId: shift.vehicleId },
    });
    const missing = [
      ...(!vdi || vdi.items.some((i) => i.critical && i.result === 'FAIL')
        ? ['a passed vehicle check']
        : []),
      ...(cleaned ? [] : ['a cleaning record']),
    ];
    if (missing.length)
      throw new HubError(
        'SHIFT_GATE_BLOCKED',
        422,
        `The replacement vehicle needs ${missing.join(' and ')} before the crew sets off`,
      );
  }

  /** The named check must be failing now and be policy-level (JOB-03). */
  private async assertExceptable(
    tx: TenantTx,
    input: { jobId: string; shiftId: string; checkCode: string },
    now: Date,
  ) {
    const { job } = await this.assertJobAndShift(tx, input.jobId, input.shiftId);
    const v = await validateJobOnShift(tx, { jobId: job.id, shiftId: input.shiftId, now });
    const c = v.checks.find((x) => x.code === input.checkCode);
    if (!c || c.result !== 'FAIL')
      throw new HubError('VALIDATION_FAILED', 400, 'That check is not failing');
    if (!c.overridable)
      throw new HubError(
        'OVERRIDE_NOT_PERMITTED',
        422,
        'Statutory and safety-critical checks cannot be overridden',
      );
    return job;
  }

  private async assertJobAndShift(tx: TenantTx, jobId: string, shiftId: string) {
    const job = await tx.job.findUnique({ where: { id: jobId } });
    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!job || !shift) throw notFound();
    if (shift.state === 'ENDED' || shift.state === 'CANCELLED')
      throw new HubError('CONFLICT', 409, 'The shift is not running');
    return { job, shift };
  }

  private async isCrewOn(tx: TenantTx, hub: HubRequestContext, jobId: string): Promise<boolean> {
    const staff = await tx.staff.findFirst({
      where: { userId: hub.user.id },
      select: { id: true },
    });
    if (!staff) return false;
    const al = await tx.jobAllocation.findFirst({ where: { jobId, active: true } });
    if (!al) return false;
    return (
      (await tx.crewAssignment.count({
        where: { shiftId: al.shiftId, staffId: staff.id, active: true },
      })) > 0
    );
  }

  private async detail(tx: TenantTx, hub: HubRequestContext, id: string): Promise<JobDetailDto> {
    const j = await tx.job.findUniqueOrThrow({
      where: { id },
      include: { allocations: true, events: { orderBy: { receivedAt: 'asc' } } },
    });
    let contact: JobDetailDto['patientContact'] = null;
    if (hub.permissions.has('jobs.patient.view')) {
      const c = await tx.patientContact.findUnique({ where: { jobId: id } });
      if (c) {
        contact = { name: c.name, phone: c.phone };
        await audit(this.db, tx, hub, { action: 'jobs.patient.view', entity: 'job', entityId: id });
      }
    }
    const actors = await userNames(
      tx,
      j.events.map((e) => e.actorUserId),
    );
    return {
      ...jobDto(j),
      patientContact: contact,
      events: j.events.map((e) => ({
        fromState: e.fromState,
        toState: e.toState,
        actorUserId: e.actorUserId,
        actorName: actors.get(e.actorUserId) ?? null,
        capturedAt: e.capturedAt.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
        reason: e.reason,
      })),
    };
  }
}

/** Shifts, crew assignments (time-bounded) and the day planner. */
@Controller()
export class ShiftsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('jobs.job.view')
  @Get('planner')
  async planner(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(PlannerQuery, q);
    const from = new Date(`${f.date}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 36 * 3_600_000);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const shifts = await tx.shift.findMany({
        where: {
          startsAt: { lt: to },
          endsAt: { gt: new Date(from.getTime() - 12 * 3_600_000) },
          state: { not: 'CANCELLED' },
          ...(f.locationId ? { locationId: f.locationId } : {}),
        },
        include: shiftInclude,
        orderBy: { startsAt: 'asc' },
      });
      const unallocated = await tx.job.findMany({
        where: {
          journeyDate: from,
          state: { in: [...ALLOCATABLE] as JobState[] },
          ...(f.locationId ? { locationId: f.locationId } : {}),
        },
        include: { allocations: true },
        orderBy: { plannedStart: 'asc' },
      });
      return {
        date: f.date,
        shifts: await Promise.all(shifts.map((s) => this.dto(tx, s))),
        unallocated: unallocated.map(jobDto),
      };
    });
  }

  @RequirePermission('jobs.job.view')
  @Get('shifts')
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(ShiftsQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const day = f.date ? new Date(`${f.date}T00:00:00.000Z`) : null;
      const rows = await tx.shift.findMany({
        where: {
          ...(day
            ? {
                startsAt: {
                  gte: new Date(day.getTime() - 12 * 3_600_000),
                  lt: new Date(day.getTime() + 36 * 3_600_000),
                },
              }
            : {}),
          ...(f.locationId ? { locationId: f.locationId } : {}),
        },
        include: shiftInclude,
        orderBy: { startsAt: 'asc' },
        take: 300,
      });
      return { data: await Promise.all(rows.map((s) => this.dto(tx, s))) };
    });
  }

  @RequirePermission('jobs.allocate')
  @Post('shifts')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ShiftDto> {
    const input = body(ShiftCreate, raw);
    if (new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime() > 16 * 3_600_000)
      throw new HubError('VALIDATION_FAILED', 400, 'A shift is at most 16 hours');
    if (new Set(input.crew.map((c) => c.staffId)).size !== input.crew.length)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'The same person cannot fill two crew places on one shift',
      );
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        if (!(await tx.location.findUnique({ where: { id: input.locationId } }))) throw notFound();
        if (hub.locationIds && !hub.locationIds.includes(input.locationId)) throw notFound();
        await this.assertUsableVehicle(tx, input.vehicleId);
        const vehicleClash = await overlapText(tx, {
          resourceType: 'VEHICLE',
          resourceId: input.vehicleId,
          start: new Date(input.startsAt),
          end: new Date(input.endsAt),
        });
        if (vehicleClash) throw new HubError('CONFLICT', 409, vehicleClash);
        const orgId = hub.orgId as string;
        const s = await tx.shift.create({
          data: {
            organisationId: orgId,
            locationId: input.locationId,
            vehicleId: input.vehicleId,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            createdBy: hub.user.id,
          },
        });
        await tx.resourceBooking.create({
          data: {
            organisationId: orgId,
            resourceType: 'VEHICLE',
            resourceId: input.vehicleId,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            sourceType: 'SHIFT',
            sourceId: s.id,
          },
        });
        await tx.shiftChange.create({
          data: {
            organisationId: orgId,
            shiftId: s.id,
            kind: 'CREATED',
            details: { vehicleId: input.vehicleId },
            byUserId: hub.user.id,
          },
        });
        for (const c of input.crew) await this.addCrew(tx, hub, s, c);
        await audit(this.db, tx, hub, {
          action: 'jobs.shift.create',
          entity: 'shift',
          entityId: s.id,
          summary: { crew: input.crew.length },
        });
        return this.dto(
          tx,
          await tx.shift.findUniqueOrThrow({ where: { id: s.id }, include: shiftInclude }),
        );
      })
      .catch(this.doubleBooked);
  }

  /** E2: a person's readiness for a crew role, shown as they are picked (declared before :id). */
  @RequirePermission('jobs.allocate')
  @Get('shifts/crew-readiness')
  async crewReadiness(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<z.infer<typeof CrewReadinessDto>> {
    const f = body(CrewReadinessQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.staff.count({ where: { id: f.staffId } }))) throw notFound();
      const vehicle = f.vehicleId
        ? await tx.vehicle.findUnique({ where: { id: f.vehicleId } })
        : null;
      if (f.vehicleId && !vehicle) throw notFound();
      const window = { start: new Date(f.from), end: new Date(f.to) };
      const r = await staffReadinessFor(tx, {
        staffId: f.staffId,
        role: f.role,
        window,
        licenceCategory: f.role === 'DRIVER' ? (vehicle?.licenceCategory ?? 'B') : undefined,
        vehicleGrossWeightKg: vehicle?.grossWeightKg ?? null,
        competencies: [],
        now: new Date(),
      });
      if (f.role === 'DRIVER')
        plainLicenceWords(
          r,
          drivingCategoryFor(vehicle?.licenceCategory ?? 'B', vehicle?.grossWeightKg ?? null),
        );
      const clash = await overlapText(tx, {
        resourceType: 'STAFF',
        resourceId: f.staffId,
        start: window.start,
        end: window.end,
      });
      const checks = r.checks.map((c) => ({
        code: c.code,
        result: c.result,
        reasonText: c.reasonText,
        group: c.group as string,
      }));
      if (clash)
        checks.push({ code: 'TIME_CONFLICT', result: 'FAIL', reasonText: clash, group: 'TIME' });
      return {
        staffId: f.staffId,
        state: clash ? 'BLOCKED' : r.state,
        checks,
      };
    });
  }

  @OrgMember()
  @Get('shifts/:id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<ShiftDto> {
    requireAny(hub, 'jobs.job.view', 'crew.today.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.shift.findUnique({ where: { id }, include: shiftInclude });
      if (!s) throw notFound();
      if (!hub.permissions.has('jobs.job.view') && !(await this.myAssignment(tx, hub, id)))
        throw notFound();
      return this.dto(tx, s);
    });
  }

  @RequirePermission('jobs.allocate')
  @Post('shifts/:id/crew')
  async crew(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ShiftDto> {
    const input = body(CrewInput, raw);
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const s = await this.openShift(tx, id);
        await this.addCrew(tx, hub, s, input);
        await this.tellCrew(tx, s.organisationId, id, 'crew-add');
        await audit(this.db, tx, hub, {
          action: 'jobs.shift.crew_add',
          entity: 'shift',
          entityId: id,
          summary: { staffId: input.staffId, role: input.role },
        });
        return this.dto(
          tx,
          await tx.shift.findUniqueOrThrow({ where: { id }, include: shiftInclude }),
        );
      })
      .catch(this.doubleBooked);
  }

  @RequirePermission('jobs.allocate')
  @Post('shifts/:id/crew/:assignmentId/end')
  async endCrew(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('assignmentId', idPipe) assignmentId: string,
    @Body() raw: unknown,
  ): Promise<ShiftDto> {
    const input = body(CrewEndInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.openShift(tx, id);
      const a = await tx.crewAssignment.findFirst({
        where: { id: assignmentId, shiftId: id, active: true },
      });
      if (!a) throw notFound();
      const now = new Date();
      // Before it starts the assignment is withdrawn; once running it ends now (history kept).
      const withdraw = now <= a.startsAt;
      await tx.crewAssignment.update({
        where: { id: a.id },
        data: withdraw
          ? { active: false, endedReason: input.reason }
          : { endsAt: now, endedReason: input.reason },
      });
      await tx.resourceBooking.updateMany({
        where: { sourceType: 'CREW', sourceId: a.id, active: true },
        data: withdraw ? { active: false } : { endsAt: now },
      });
      await tx.shiftChange.create({
        data: {
          organisationId: a.organisationId,
          shiftId: id,
          kind: 'CREW_END',
          details: { staffId: a.staffId, role: a.role },
          reason: input.reason,
          byUserId: hub.user.id,
        },
      });
      const leaving = await tx.staff.findUnique({ where: { id: a.staffId } });
      await this.tellCrew(tx, a.organisationId, id, `crew-end:${a.id}`, leaving?.userId);
      await audit(this.db, tx, hub, {
        action: 'jobs.shift.crew_end',
        entity: 'shift',
        entityId: id,
        summary: { staffId: a.staffId },
      });
      return this.dto(
        tx,
        await tx.shift.findUniqueOrThrow({ where: { id }, include: shiftInclude }),
      );
    });
  }

  /**
   * E2: swap one crew member for another for the rest of the assignment. The leaving person's
   * assignment ends (or is withdrawn before it starts) with the reason; history is kept.
   */
  @RequirePermission('jobs.allocate')
  @Post('shifts/:id/crew/:assignmentId/swap')
  async swapCrew(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('assignmentId', idPipe) assignmentId: string,
    @Body() raw: unknown,
  ): Promise<ShiftDto> {
    const input = body(CrewSwapInput, raw);
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const s = await this.openShift(tx, id);
        const a = await tx.crewAssignment.findFirst({
          where: { id: assignmentId, shiftId: id, active: true },
        });
        if (!a) throw notFound();
        if (a.staffId === input.staffId)
          throw new HubError('CONFLICT', 409, 'Choose a different person');
        const now = new Date();
        if (a.endsAt <= now)
          throw new HubError('CONFLICT', 409, 'This assignment has already ended');
        const withdraw = now <= a.startsAt;
        const from = withdraw ? a.startsAt : now;
        await tx.crewAssignment.update({
          where: { id: a.id },
          data: withdraw
            ? { active: false, endedReason: input.reason }
            : { endsAt: now, endedReason: input.reason },
        });
        await tx.resourceBooking.updateMany({
          where: { sourceType: 'CREW', sourceId: a.id, active: true },
          data: withdraw ? { active: false } : { endsAt: now },
        });
        await tx.shiftChange.create({
          data: {
            organisationId: a.organisationId,
            shiftId: id,
            kind: 'CREW_END',
            details: { staffId: a.staffId, role: a.role, swappedFor: input.staffId },
            reason: input.reason,
            byUserId: hub.user.id,
          },
        });
        await this.addCrew(tx, hub, s, {
          staffId: input.staffId,
          role: a.role as z.infer<typeof CrewInput>['role'],
          startsAt: from.toISOString(),
          endsAt: a.endsAt.toISOString(),
        });
        const leaving = await tx.staff.findUnique({ where: { id: a.staffId } });
        await this.tellCrew(tx, a.organisationId, id, `crew-swap:${a.id}`, leaving?.userId);
        // The jobs on the shift are checked again with the new crew; failures go red to control.
        await recheckAllocations(tx, a.organisationId, now, { shiftId: id });
        await audit(this.db, tx, hub, {
          action: 'jobs.shift.crew_swap',
          entity: 'shift',
          entityId: id,
          summary: { from: a.staffId, to: input.staffId, role: a.role },
        });
        return this.dto(
          tx,
          await tx.shift.findUniqueOrThrow({ where: { id }, include: shiftInclude }),
        );
      })
      .catch(this.doubleBooked);
  }

  /** Cancel a shift that has not started: crew are stood down and its jobs need a new crew. */
  @RequirePermission('jobs.allocate')
  @Post('shifts/:id/cancel')
  async cancelShift(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ShiftDto> {
    const input = body(ShiftCancelInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.openShift(tx, id);
      if (s.state !== 'PLANNED')
        throw new HubError('CONFLICT', 409, 'Only a shift that has not started can be cancelled');
      const allocations = await tx.jobAllocation.findMany({
        where: { shiftId: id, active: true },
        include: { job: true },
      });
      if (allocations.some((a) => !NOT_STARTED.includes(a.job.state)))
        throw new HubError('CONFLICT', 409, 'A job on this shift is already under way');
      const now = new Date();
      // Told before the crew assignments are withdrawn, while they still resolve to people.
      await this.tellCrew(tx, s.organisationId, id, 'cancelled');
      for (const al of allocations) {
        await tx.jobAllocation.update({
          where: { id: al.id },
          data: { active: false, releasedAt: now, releaseReason: input.reason },
        });
        await tx.jobStatusEvent.create({
          data: {
            organisationId: al.organisationId,
            jobId: al.jobId,
            fromState: al.job.state,
            toState: 'REASSIGNED',
            actorUserId: hub.user.id,
            capturedAt: now,
            reason: input.reason,
          },
        });
        await tx.job.update({ where: { id: al.jobId }, data: { state: 'REASSIGNED' } });
        // Job code only: no patient details in alerts.
        await upsertJobAlert(tx, {
          orgId: al.organisationId,
          jobId: al.jobId,
          reasonCode: 'JOB_NEEDS_REASSIGNMENT',
          severity: 'HIGH',
          text: `${al.job.code} needs a new crew: its shift was cancelled`,
        });
      }
      const crew = await tx.crewAssignment.findMany({
        where: { shiftId: id, active: true },
        select: { id: true },
      });
      await tx.crewAssignment.updateMany({
        where: { shiftId: id, active: true },
        data: { active: false, endedReason: input.reason },
      });
      await tx.resourceBooking.updateMany({
        where: {
          active: true,
          OR: [
            { sourceType: 'SHIFT', sourceId: id },
            { sourceType: 'CREW', sourceId: { in: crew.map((c) => c.id) } },
          ],
        },
        data: { active: false },
      });
      await tx.shift.update({ where: { id }, data: { state: 'CANCELLED' } });
      await tx.shiftChange.create({
        data: {
          organisationId: s.organisationId,
          shiftId: id,
          kind: 'CANCELLED',
          details: { jobsReleased: allocations.length, crewStoodDown: crew.length },
          reason: input.reason,
          byUserId: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'jobs.shift.cancel',
        entity: 'shift',
        entityId: id,
        summary: { jobsReleased: allocations.length, crewStoodDown: crew.length },
      });
      return this.dto(
        tx,
        await tx.shift.findUniqueOrThrow({ where: { id }, include: shiftInclude }),
      );
    });
  }

  /** Vehicle swap: the replacement needs its own VDI and cleaning before the shift can run (UAT-03). */
  @RequirePermission('jobs.allocate')
  @Post('shifts/:id/vehicle')
  async swap(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<ShiftDto> {
    const input = body(VehicleSwapInput, raw);
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const s = await this.openShift(tx, id);
        if (s.vehicleId === input.vehicleId)
          throw new HubError('CONFLICT', 409, 'That vehicle is already on the shift');
        await this.assertUsableVehicle(tx, input.vehicleId);
        const now = new Date();
        const from = now > s.startsAt ? now : s.startsAt;
        const vehicleClash = await overlapText(tx, {
          resourceType: 'VEHICLE',
          resourceId: input.vehicleId,
          start: from,
          end: s.endsAt,
          ignoreShiftId: id,
        });
        if (vehicleClash) throw new HubError('CONFLICT', 409, vehicleClash);
        await tx.resourceBooking.updateMany({
          where: { sourceType: 'SHIFT', sourceId: id, resourceType: 'VEHICLE', active: true },
          data: now > s.startsAt ? { endsAt: now } : { active: false },
        });
        await tx.resourceBooking.create({
          data: {
            organisationId: s.organisationId,
            resourceType: 'VEHICLE',
            resourceId: input.vehicleId,
            startsAt: from,
            endsAt: s.endsAt,
            sourceType: 'SHIFT',
            sourceId: id,
          },
        });
        await tx.shift.update({ where: { id }, data: { vehicleId: input.vehicleId } });
        await tx.shiftChange.create({
          data: {
            organisationId: s.organisationId,
            shiftId: id,
            kind: 'VEHICLE_SWAP',
            details: { from: s.vehicleId, to: input.vehicleId },
            reason: input.reason,
            byUserId: hub.user.id,
          },
        });
        await this.tellCrew(tx, s.organisationId, id, `swap:${input.vehicleId}`);
        await audit(this.db, tx, hub, {
          action: 'jobs.shift.vehicle_swap',
          entity: 'shift',
          entityId: id,
          summary: { from: s.vehicleId, to: input.vehicleId },
        });
        return this.dto(
          tx,
          await tx.shift.findUniqueOrThrow({ where: { id }, include: shiftInclude }),
        );
      })
      .catch(this.doubleBooked);
  }

  /** Generic "shift updated" push to the crew (and to anyone just removed from it). */
  private async tellCrew(
    tx: TenantTx,
    orgId: string,
    shiftId: string,
    event: string,
    extraUserId?: string | null,
  ) {
    const users = await shiftCrewUserIds(tx, shiftId);
    await queuePush(tx, {
      orgId,
      userIds: extraUserId ? [...users, extraUserId] : users,
      kind: 'SHIFT_CHANGED',
      refId: shiftId,
      event: `${event}:${Date.now()}`,
    });
  }

  @OrgMember()
  @Get('shifts/:id/gate')
  async gate(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<z.infer<typeof ShiftGateDto>> {
    requireAny(hub, 'crew.today.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const mine = await this.myAssignment(tx, hub, id);
      if (!mine) throw notFound();
      const s = await tx.shift.findUniqueOrThrow({ where: { id } });
      const g = await shiftGateFor(tx, id, mine.staffId, new Date());
      return { shiftId: id, canStart: g.canStart, checks: g.checks, state: s.state };
    });
  }

  @RequirePermission('crew.today.view')
  @Post('shifts/:id/start')
  async start(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db
      .withTenant(tenantOf(hub), async (tx) => {
        const mine = await this.myAssignment(tx, hub, id);
        if (!mine) throw notFound();
        const s = await tx.shift.findUniqueOrThrow({ where: { id } });
        if (s.state !== 'PLANNED' && s.state !== 'STARTED')
          throw new HubError('CONFLICT', 409, 'The shift is not running');
        const now = new Date();
        const g = await shiftGateFor(tx, id, mine.staffId, now);
        if (!g.canStart) {
          await audit(this.db, tx, hub, {
            action: 'jobs.shift.start_blocked',
            entity: 'shift',
            entityId: id,
            summary: {
              failing: g.checks
                .filter((c) => c.result !== 'PASS')
                .map((c) => c.code)
                .join(','),
            },
          });
          return { blocked: g };
        }
        if (s.state === 'PLANNED') {
          await tx.shift.update({ where: { id }, data: { state: 'STARTED', startedAt: now } });
          await tx.shiftChange.create({
            data: {
              organisationId: s.organisationId,
              shiftId: id,
              kind: 'STARTED',
              details: { staffId: mine.staffId },
              byUserId: hub.user.id,
            },
          });
          // E3: its jobs are checked again at shift start; failures go red to control.
          await recheckAllocations(tx, s.organisationId, now, { shiftId: id });
        }
        await audit(this.db, tx, hub, {
          action: 'jobs.shift.start',
          entity: 'shift',
          entityId: id,
        });
        return { shiftId: id, canStart: true, checks: g.checks, state: 'STARTED' as const };
      })
      .then((r) => {
        if (r.blocked)
          throw new HubError(
            'SHIFT_GATE_BLOCKED',
            422,
            'The shift cannot start yet',
            r.blocked.checks as unknown as Record<string, unknown>[],
          );
        return r;
      });
  }

  // ---- helpers ----------------------------------------------------------------------------
  private doubleBooked = (e: unknown): never => {
    if (isExclusion(e))
      throw new HubError(
        'CONFLICT',
        409,
        'That vehicle or person is already booked on another shift at an overlapping time',
      );
    throw e;
  };

  /** Only an available vehicle can be put on a shift; a blocked one has no override (finding 67). */
  private async assertUsableVehicle(tx: TenantTx, vehicleId: string) {
    const v = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      select: { callsign: true, status: true, statusReason: true, expectedReturnOn: true },
    });
    if (!v) throw notFound();
    if (v.status === 'AVAILABLE') return;
    const state =
      v.status === 'OFF_ROAD' ? 'off road' : v.status === 'QUARANTINED' ? 'quarantined' : 'blocked';
    // E2: the dialog says why, and when the vehicle is due back if fleet gave a date.
    const back = v.expectedReturnOn
      ? `; expected back ${formatDate(v.expectedReturnOn.toISOString().slice(0, 10))}`
      : '';
    throw new HubError(
      'OVERRIDE_NOT_PERMITTED',
      422,
      `${v.callsign} is ${state}${v.statusReason ? ` (${v.statusReason}${back})` : back} ` +
        'and cannot be put on a shift until it is returned to service',
    );
  }

  private async openShift(tx: TenantTx, id: string) {
    const s = await tx.shift.findUnique({ where: { id } });
    if (!s) throw notFound();
    if (s.state === 'ENDED' || s.state === 'CANCELLED')
      throw new HubError('CONFLICT', 409, 'The shift is not running');
    return s;
  }

  private async myAssignment(tx: TenantTx, hub: HubRequestContext, shiftId: string) {
    const staff = await tx.staff.findFirst({
      where: { userId: hub.user.id },
      select: { id: true },
    });
    if (!staff) return null;
    return tx.crewAssignment.findFirst({ where: { shiftId, staffId: staff.id, active: true } });
  }

  private async addCrew(
    tx: TenantTx,
    hub: HubRequestContext,
    s: { id: string; organisationId: string; startsAt: Date; endsAt: Date },
    c: z.infer<typeof CrewInput>,
  ) {
    const staff = await tx.staff.findUnique({ where: { id: c.staffId } });
    if (!staff) throw notFound();
    if (staff.lifecycleState === 'LEAVER')
      throw new HubError('VALIDATION_FAILED', 400, 'A leaver cannot be rostered');
    const start = c.startsAt ? new Date(c.startsAt) : s.startsAt;
    const end = c.endsAt ? new Date(c.endsAt) : s.endsAt;
    if (start < s.startsAt || end > s.endsAt || end <= start)
      throw new HubError('VALIDATION_FAILED', 400, 'Crew time must fall within the shift');
    const already = await tx.crewAssignment.count({
      where: {
        shiftId: s.id,
        staffId: c.staffId,
        active: true,
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
    });
    if (already)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        `${staff.displayName} is already on this shift at that time`,
      );
    // E2: say who is booked where, e.g. "Sam Taylor is already on AMB-02 from 07:00 to 19:00".
    const clash = await overlapText(tx, {
      resourceType: 'STAFF',
      resourceId: c.staffId,
      start,
      end,
      ignoreShiftId: s.id,
    });
    if (clash) throw new HubError('CONFLICT', 409, clash);
    const a = await tx.crewAssignment.create({
      data: {
        organisationId: s.organisationId,
        shiftId: s.id,
        staffId: c.staffId,
        role: c.role,
        startsAt: start,
        endsAt: end,
        createdBy: hub.user.id,
      },
    });
    await tx.resourceBooking.create({
      data: {
        organisationId: s.organisationId,
        resourceType: 'STAFF',
        resourceId: c.staffId,
        startsAt: start,
        endsAt: end,
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
        byUserId: hub.user.id,
      },
    });
  }

  private async dto(tx: TenantTx, s: ShiftRow): Promise<ShiftDto> {
    const v = await tx.vehicle.findUniqueOrThrow({
      where: { id: s.vehicleId },
      select: { callsign: true, status: true },
    });
    const staff = await tx.staff.findMany({
      where: { id: { in: s.crew.map((c) => c.staffId) } },
      select: { id: true, staffNo: true, displayName: true },
    });
    return {
      id: s.id,
      locationId: s.locationId,
      vehicleId: s.vehicleId,
      vehicleCallsign: v.callsign,
      vehicleStatus: v.status,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      state: s.state,
      crew: s.crew.map((c) => {
        const p = staff.find((x) => x.id === c.staffId);
        return {
          id: c.id,
          staffId: c.staffId,
          staffNo: p?.staffNo ?? '',
          displayName: p?.displayName ?? '',
          role: c.role,
          startsAt: c.startsAt.toISOString(),
          endsAt: c.endsAt.toISOString(),
          active: c.active,
        };
      }),
      jobs: s.allocations.map((a) => ({
        jobId: a.jobId,
        code: a.job.code,
        state: a.job.state,
        startsAt: a.startsAt.toISOString(),
        endsAt: a.endsAt.toISOString(),
      })),
      changes: s.changes.map((c) => ({
        kind: c.kind,
        details: c.details as Record<string, unknown>,
        reason: c.reason,
        at: c.at.toISOString(),
      })),
      version: s.version,
    };
  }
}
