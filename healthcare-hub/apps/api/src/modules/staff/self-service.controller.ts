import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { Db, TenantTx } from '@hub/db';
import { recomputeInstance, staffReadinessFor } from '@hub/domain';
import {
  MyReadinessQuery,
  SelfRequestDecision,
  SelfRequestInput,
  SelfRequestStatus,
  StaffRequestInput,
  type ReadinessDto,
  type SelfRequestDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MAX_OPEN = 10;
const DUE = 'compliance.due_date.change';
const MANAGE = 'staff.profile.manage';
const VERIFY = 'compliance.evidence.verify';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const ListQuery = z.strictObject({ status: SelfRequestStatus.optional() });

type Row = {
  id: string;
  staffId: string;
  kind: string;
  instanceId: string | null;
  proposedDate: Date | null;
  supervisorUserId: string | null;
  reason: string;
  status: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  bookedFor: Date | null;
  createdAt: Date;
  version: number;
};

async function requestDtos(tx: TenantTx, rows: Row[]): Promise<SelfRequestDto[]> {
  const staff = new Map(
    (
      await tx.staff.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.staffId))] } },
        select: { id: true, displayName: true },
      })
    ).map((s) => [s.id, s.displayName]),
  );
  const ids = rows.map((r) => r.instanceId).filter((x): x is string => !!x);
  const instances = new Map(
    (
      await tx.requirementInstance.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          dueDate: true,
          reviewDate: true,
          template: { select: { title: true } },
          templateVersion: { select: { deadlineKind: true } },
        },
      })
    ).map((i) => [i.id, i]),
  );
  const names = await userNames(
    tx,
    rows.flatMap((r) => [r.supervisorUserId, r.decidedBy]),
  );
  return rows.map((r) => {
    const i = r.instanceId ? instances.get(r.instanceId) : undefined;
    const current = i
      ? i.templateVersion.deadlineKind === 'REVIEW'
        ? i.reviewDate
        : i.dueDate
      : null;
    return {
      id: r.id,
      staffId: r.staffId,
      staffName: staff.get(r.staffId) ?? 'Former member of staff',
      kind: r.kind as SelfRequestDto['kind'],
      instanceId: r.instanceId,
      requirementTitle: i?.template.title ?? null,
      currentDate: isoDay(current),
      proposedDate: isoDay(r.proposedDate),
      supervisorUserId: r.supervisorUserId,
      supervisorName: r.supervisorUserId ? (names.get(r.supervisorUserId) ?? null) : null,
      reason: r.reason,
      status: r.status as SelfRequestDto['status'],
      requestedBy: r.requestedBy,
      decidedBy: r.decidedBy,
      decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      bookedFor: r.bookedFor?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      version: r.version,
    };
  });
}

/**
 * Staff self-service from "My record" (task 25): readiness for a window, and requests for a
 * due-date change, a review or a supervision session. The member of staff asks; someone else
 * decides. Nothing here makes a requirement green.
 */
@Controller('staff')
export class StaffSelfServiceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async myStaff(tx: TenantTx, hub: HubRequestContext) {
    const s = await tx.staff.findFirst({ where: { userId: hub.user.id } });
    if (!s) throw notFound();
    return s;
  }

  @RequirePermission('staff.self.view')
  @Get('me/readiness')
  async readiness(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<ReadinessDto> {
    const f = body(MyReadinessQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.myStaff(tx, hub);
      const r = await staffReadinessFor(tx, {
        staffId: s.id,
        role: f.role,
        window: { start: new Date(f.from), end: new Date(f.to) },
        competencies: [],
        now: new Date(),
      });
      return {
        staffId: s.id,
        role: f.role,
        state: r.state,
        checks: r.checks,
        restrictions: r.restrictions as ReadinessDto['restrictions'],
      };
    });
  }

  @RequirePermission('staff.self.view')
  @Get('me/requests')
  async mine(@Hub() hub: HubRequestContext): Promise<{ data: SelfRequestDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.myStaff(tx, hub);
      const rows = await tx.staffSelfRequest.findMany({
        where: { staffId: s.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return { data: await requestDtos(tx, rows) };
    });
  }

  @RequirePermission('staff.self.update')
  @Post('me/requests')
  async ask(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<SelfRequestDto> {
    const input = body(SelfRequestInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.myStaff(tx, hub);
      const open = await tx.staffSelfRequest.count({ where: { staffId: s.id, status: 'OPEN' } });
      if (open >= MAX_OPEN)
        throw new HubError('CONFLICT', 409, 'You already have 10 open requests');
      let instanceId: string | null = null;
      if (input.kind !== 'SUPERVISION') {
        const i = await tx.requirementInstance.findUnique({
          where: { id: input.instanceId },
          include: { templateVersion: { select: { deadlineKind: true } } },
        });
        // Only your own requirements: anything else looks like it does not exist.
        if (!i || i.subjectType !== 'STAFF' || i.subjectId !== s.id) throw notFound();
        if (input.kind === 'DUE_DATE_CHANGE') {
          const kind = i.templateVersion.deadlineKind;
          if (kind === 'EXPIRY')
            throw new HubError(
              'OVERRIDE_NOT_PERMITTED',
              422,
              'Expiry dates come from verified evidence and cannot be changed',
            );
          const current = isoDay(kind === 'REVIEW' ? i.reviewDate : i.dueDate);
          if (current === input.proposedDate)
            throw new HubError('VALIDATION_FAILED', 400, 'That is already the date');
        }
        const dup = await tx.staffSelfRequest.count({
          where: { staffId: s.id, kind: input.kind, instanceId: i.id, status: 'OPEN' },
        });
        if (dup > 0)
          throw new HubError('CONFLICT', 409, 'You already have an open request for this item');
        instanceId = i.id;
      } else if (input.supervisorUserId) {
        if (input.supervisorUserId === hub.user.id)
          throw new HubError('VALIDATION_FAILED', 400, 'Choose someone else to supervise you');
        const active = await tx.membership.count({
          where: { userId: input.supervisorUserId, validTo: null, user: { status: 'ACTIVE' } },
        });
        if (active === 0)
          throw new HubError('VALIDATION_FAILED', 400, 'The supervisor must be an active member');
      }
      const r = await tx.staffSelfRequest.create({
        data: {
          organisationId: s.organisationId,
          staffId: s.id,
          kind: input.kind,
          instanceId,
          proposedDate: input.kind === 'REVIEW' ? null : day(input.proposedDate),
          supervisorUserId: input.kind === 'SUPERVISION' ? (input.supervisorUserId ?? null) : null,
          reason: input.reason,
          requestedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.self.request',
        entity: 'staff_self_request',
        entityId: r.id,
        summary: { kind: input.kind },
      });
      return (await requestDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission('staff.self.update')
  @Post('me/requests/:id/withdraw')
  async withdraw(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
  ): Promise<SelfRequestDto> {
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.myStaff(tx, hub);
      const r = await tx.staffSelfRequest.findUnique({ where: { id } });
      if (!r || r.staffId !== s.id) throw notFound();
      if (r.status !== 'OPEN') throw new HubError('CONFLICT', 409, 'The request is already closed');
      if (r.requestedBy !== hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'Your manager raised this request; ask them about it');
      const u = await tx.staffSelfRequest.updateMany({
        where: { id, version, status: 'OPEN' },
        data: { status: 'WITHDRAWN' },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'staff.self.request_withdraw',
        entity: 'staff_self_request',
        entityId: id,
        summary: { kind: r.kind },
      });
      const fresh = await tx.staffSelfRequest.findUniqueOrThrow({ where: { id } });
      return (await requestDtos(tx, [fresh]))[0]!;
    });
  }

  /** Requests about one person (theirs and those raised for them), newest first. */
  @RequirePermission(MANAGE)
  @Get(':id/requests')
  async forStaff(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<{ data: SelfRequestDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.staff.count({ where: { id } }))) throw notFound();
      const rows = await tx.staffSelfRequest.findMany({
        where: { staffId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return { data: await requestDtos(tx, rows) };
    });
  }

  /**
   * A manager asks for a review or books a supervision for someone (finding 15). It joins the same
   * queue as the person's own requests, and the requester cannot decide it.
   */
  @RequirePermission(MANAGE)
  @Post(':id/requests')
  async askFor(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SelfRequestDto> {
    const input = body(StaffRequestInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findUnique({ where: { id } });
      if (!s) throw notFound();
      if (s.userId === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Use My record for requests about yourself');
      if (s.lifecycleState === 'LEAVER')
        throw new HubError('CONFLICT', 409, 'The record is closed (leaver)');
      const open = await tx.staffSelfRequest.count({ where: { staffId: id, status: 'OPEN' } });
      if (open >= MAX_OPEN)
        throw new HubError('CONFLICT', 409, 'This person already has 10 open requests');
      let instanceId: string | null = null;
      if (input.kind === 'REVIEW') {
        const i = await tx.requirementInstance.findUnique({ where: { id: input.instanceId } });
        if (!i || i.subjectType !== 'STAFF' || i.subjectId !== id) throw notFound();
        const dup = await tx.staffSelfRequest.count({
          where: { staffId: id, kind: 'REVIEW', instanceId: i.id, status: 'OPEN' },
        });
        if (dup > 0)
          throw new HubError('CONFLICT', 409, 'There is already an open review for this item');
        instanceId = i.id;
      } else if (input.supervisorUserId) {
        if (input.supervisorUserId === s.userId)
          throw new HubError('VALIDATION_FAILED', 400, 'A person cannot supervise themselves');
        const active = await tx.membership.count({
          where: { userId: input.supervisorUserId, validTo: null, user: { status: 'ACTIVE' } },
        });
        if (active === 0)
          throw new HubError('VALIDATION_FAILED', 400, 'The supervisor must be an active member');
      }
      const r = await tx.staffSelfRequest.create({
        data: {
          organisationId: s.organisationId,
          staffId: id,
          kind: input.kind,
          instanceId,
          proposedDate: input.kind === 'SUPERVISION' ? day(input.proposedDate) : null,
          supervisorUserId: input.kind === 'SUPERVISION' ? (input.supervisorUserId ?? null) : null,
          reason: input.reason,
          requestedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.request.raise',
        entity: 'staff_self_request',
        entityId: r.id,
        summary: { kind: input.kind, staffId: id },
      });
      return (await requestDtos(tx, [r]))[0]!;
    });
  }

  @OrgMember()
  @Get('self-requests')
  async queue(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: SelfRequestDto[] }> {
    requireAny(hub, MANAGE, DUE, VERIFY);
    const f = body(ListQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.staffSelfRequest.findMany({
        where: { status: f.status ?? 'OPEN' },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      return { data: await requestDtos(tx, rows) };
    });
  }

  @OrgMember()
  @Post('self-requests/:id/decide')
  async decide(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SelfRequestDto> {
    const input = body(SelfRequestDecision, raw);
    const version = ifMatchVersion(req);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.staffSelfRequest.findUnique({ where: { id } });
      if (!r) throw notFound();
      // Who decides depends on what was asked for; a named supervisor may answer their own booking.
      if (r.kind === 'DUE_DATE_CHANGE') requireAny(hub, DUE);
      else if (r.kind === 'REVIEW') requireAny(hub, MANAGE, VERIFY);
      else if (r.supervisorUserId !== hub.user.id) requireAny(hub, MANAGE);
      if (r.status !== 'OPEN') throw new HubError('CONFLICT', 409, 'The request is already closed');
      if (r.requestedBy === hub.user.id)
        throw new HubError('SELF_APPROVAL', 422, 'Someone else must decide your own request');
      const accepted = input.decision === 'ACCEPTED';
      const bookedFor = accepted && input.bookedFor ? new Date(input.bookedFor) : null;
      if (accepted && r.kind === 'SUPERVISION' && !bookedFor)
        throw new HubError('VALIDATION_FAILED', 400, 'Say when the supervision will happen');
      if (bookedFor && r.kind !== 'SUPERVISION')
        throw new HubError('VALIDATION_FAILED', 400, 'Only supervision requests are booked');

      if (accepted && r.kind === 'DUE_DATE_CHANGE') {
        const i = await tx.requirementInstance.findUniqueOrThrow({
          where: { id: r.instanceId as string },
          include: { templateVersion: { select: { deadlineKind: true } } },
        });
        const kind = i.templateVersion.deadlineKind;
        if (kind === 'EXPIRY')
          throw new HubError(
            'OVERRIDE_NOT_PERMITTED',
            422,
            'Expiry dates come from verified evidence and cannot be changed',
          );
        const field = kind === 'REVIEW' ? 'REVIEW' : 'DUE';
        await tx.dueDateChange.create({
          data: {
            organisationId: i.organisationId,
            instanceId: i.id,
            field,
            oldDate: field === 'REVIEW' ? i.reviewDate : i.dueDate,
            newDate: r.proposedDate as Date,
            reason: r.reason,
            approverId: hub.user.id,
            createdBy: hub.user.id,
          },
        });
        await tx.requirementInstance.update({
          where: { id: i.id },
          data: {
            [field === 'REVIEW' ? 'reviewDate' : 'dueDate']: r.proposedDate,
            updatedBy: hub.user.id,
          },
        });
        await recomputeInstance(tx, i.id, new Date());
      }

      const u = await tx.staffSelfRequest.updateMany({
        where: { id, version, status: 'OPEN' },
        data: {
          status: input.decision,
          decidedBy: hub.user.id,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
          bookedFor,
        },
      });
      if (u.count === 0) throw staleOrNotFound(true);
      await audit(this.db, tx, hub, {
        action: 'staff.self.request_decide',
        entity: 'staff_self_request',
        entityId: id,
        summary: { kind: r.kind, decision: input.decision },
      });
      const fresh = await tx.staffSelfRequest.findUniqueOrThrow({ where: { id } });
      return (await requestDtos(tx, [fresh]))[0]!;
    });
  }
}
