import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import {
  activeRestrictions,
  activeRoles,
  isRequired,
  requiredTemplates,
  staffReadinessFor,
  staffStatusSummary,
  syncRole,
  syncStaffRequirements,
} from '@hub/domain';
import { allowedTransitions, checkStaffTransition, type StaffLifecycle } from '@hub/rules';
import {
  CloseInput,
  CorrectionDecision,
  CorrectionInput,
  RECORD_SLUGS,
  ReadinessQuery,
  RecordCreate,
  RecordPayloads,
  RestrictionInput,
  RoleApprovalInput,
  RoleRequirementInput,
  SENSITIVE_RECORD_KINDS,
  StaffCreate,
  StaffListQuery,
  StaffPatch,
  TransitionInput,
  type CorrectionDto,
  type MatrixDto,
  type MyStaffDto,
  type ReadinessDto,
  type RecordKind,
  type RoleRequirementDto,
  type StaffClearanceDto,
  type StaffDetailDto,
  type StaffDto,
  type StaffRecordDto,
} from '@hub/contracts';
import { CONFIG, type AppConfig } from '../../config.js';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, dbNow, ifMatchVersion, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { encryptField, fieldKey } from '../../common/field-crypto.js';
import { DB } from '../../db.provider.js';
import { instanceInclude, toDate, toInstanceDto } from '../requirements/requirements.mapper.js';
import {
  derivedValidity,
  restrictionDto,
  roleApprovalDto,
  toClearanceDto,
  toCorrectionDto,
  toRecordDto,
  toStaffDto,
} from './staff.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const BASIC = 'staff.profile.view_basic';
const CLEARANCE = 'staff.profile.view_clearance';
const SENSITIVE = 'staff.sensitive.view';

function requireAny(hub: HubRequestContext, ...keys: string[]): void {
  if (!keys.some((k) => hub.permissions.has(k))) throw new HubError('FORBIDDEN', 403);
}

function kindOf(slug: string): RecordKind {
  const k = RECORD_SLUGS[slug];
  if (!k) throw notFound();
  return k;
}

const encodeCursor = (s: { displayName: string; id: string }) =>
  Buffer.from(JSON.stringify([s.displayName, s.id])).toString('base64url');
function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
      return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw new HubError('VALIDATION_FAILED', 400, 'Invalid cursor');
}

/** Staff module (HR-01..04, wireframe 02). Every handler is org-, location- and permission-scoped. */
@Controller('staff')
export class StaffController {
  private readonly key: Buffer;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.key = fieldKey(config.FIELD_ENCRYPTION_KEY);
  }

  // ---- list / create ------------------------------------------------------
  @OrgMember()
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    requireAny(hub, BASIC, CLEARANCE);
    const f = body(StaffListQuery, q);
    const now = new Date();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const where: Prisma.StaffWhereInput = {
        ...(f.lifecycle ? { lifecycleState: f.lifecycle } : { lifecycleState: { not: 'LEAVER' } }),
        ...(f.locationId ? { primaryLocationId: f.locationId } : {}),
        ...(f.q
          ? {
              OR: [
                { displayName: { contains: f.q, mode: 'insensitive' } },
                { staffNo: { contains: f.q.toUpperCase() } },
              ],
            }
          : {}),
        ...(f.role
          ? {
              roles: {
                some: {
                  role: f.role,
                  revokedAt: null,
                  validFrom: { lte: now },
                  OR: [{ validTo: null }, { validTo: { gt: now } }],
                },
              },
            }
          : {}),
      };
      if (f.cursor) {
        const [name, id] = decodeCursor(f.cursor);
        where.AND = [
          { OR: [{ displayName: { gt: name } }, { displayName: name, id: { gt: id } }] },
        ];
      }
      const rows = await tx.staff.findMany({
        where,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: f.limit + 1,
      });
      const pageRows = rows.slice(0, f.limit);
      const last = pageRows[pageRows.length - 1];
      const nextCursor = rows.length > f.limit && last ? encodeCursor(last) : null;
      const ids = pageRows.map((s) => s.id);
      const restr = await tx.staffRestriction.findMany({
        where: {
          staffId: { in: ids },
          liftedAt: null,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: { staffId: true, type: true },
      });
      const rOf = (id: string) => restr.filter((r) => r.staffId === id).map((r) => r.type);
      const sum = await staffStatusSummary(tx, ids, now);
      if (!hub.permissions.has(BASIC)) {
        return {
          data: pageRows.map((s) => toClearanceDto(s, sum.get(s.id)?.roles ?? [], rOf(s.id))),
          nextCursor,
        };
      }
      return {
        data: pageRows.map((s) => toStaffDto(s, sum.get(s.id)!, rOf(s.id))),
        nextCursor,
      };
    });
  }

  @RequirePermission('staff.profile.manage')
  @Post()
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<StaffDto> {
    const input = body(StaffCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.assertRefs(tx, hub, input);
      if (await tx.staff.findFirst({ where: { staffNo: input.staffNo }, select: { id: true } }))
        throw new HubError('CONFLICT', 409, 'That staff number is already in use');
      const s = await tx.staff.create({
        data: {
          organisationId: hub.orgId as string,
          staffNo: input.staffNo,
          displayName: input.displayName,
          primaryLocationId: input.primaryLocationId,
          userId: input.userId ?? null,
          managerStaffId: input.managerStaffId ?? null,
          jobTitle: input.jobTitle ?? null,
          workingPattern: input.workingPattern ?? null,
          createdBy: hub.user.id,
          updatedBy: hub.user.id,
        },
      });
      await tx.staffLifecycleEvent.create({
        data: {
          organisationId: s.organisationId,
          staffId: s.id,
          fromState: null,
          toState: 'CANDIDATE',
          reason: 'Record created',
          actorUserId: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.profile.create',
        entity: 'staff',
        entityId: s.id,
        summary: { staffNo: s.staffNo },
      });
      return this.dto(tx, s.id);
    });
  }

  // ---- self-service -------------------------------------------------------
  @RequirePermission('staff.self.view')
  @Get('me')
  async me(@Hub() hub: HubRequestContext): Promise<MyStaffDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findFirst({ where: { userId: hub.user.id } });
      if (!s) throw notFound();
      const now = new Date();
      const roles = await activeRoles(tx, s.id, now);
      const restr = (await activeRestrictions(tx, s.id, now)).map((r) => r.type);
      return {
        profile: { ...toClearanceDto(s, roles, restr), jobTitle: s.jobTitle },
        requirements: await this.requirements(tx, s.id, roles),
        corrections: (
          await tx.staffCorrectionRequest.findMany({
            where: { staffId: s.id },
            orderBy: { createdAt: 'desc' },
            take: 50,
          })
        ).map(toCorrectionDto),
      };
    });
  }

  @RequirePermission('staff.self.update')
  @Post('me/corrections')
  async requestCorrection(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<CorrectionDto> {
    const input = body(CorrectionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findFirst({ where: { userId: hub.user.id } });
      if (!s) throw notFound();
      const open = await tx.staffCorrectionRequest.count({
        where: { staffId: s.id, status: 'OPEN' },
      });
      if (open >= 10) throw new HubError('CONFLICT', 409, 'Too many open correction requests');
      const c = await tx.staffCorrectionRequest.create({
        data: {
          organisationId: s.organisationId,
          staffId: s.id,
          field: input.field,
          proposedValue: input.proposedValue,
          reason: input.reason,
          requestedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.self.correction_request',
        entity: 'staff_correction_request',
        entityId: c.id,
        summary: { field: input.field },
      });
      return toCorrectionDto(c);
    });
  }

  @RequirePermission('staff.profile.manage')
  @Get('corrections')
  async corrections(@Hub() hub: HubRequestContext): Promise<{ data: CorrectionDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.staffCorrectionRequest.findMany({
        where: { status: 'OPEN' },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    );
    return { data: rows.map(toCorrectionDto) };
  }

  @RequirePermission('staff.profile.manage')
  @Post('corrections/:id/decide')
  async decide(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<CorrectionDto> {
    const input = body(CorrectionDecision, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.staffCorrectionRequest.findUnique({
        where: { id },
        include: { staff: { select: { userId: true } } },
      });
      if (!c) throw notFound();
      if (c.status !== 'OPEN') throw new HubError('CONFLICT', 409, 'Already decided');
      if (c.staff.userId === hub.user.id) throw new HubError('SELF_APPROVAL', 422);
      const r = await tx.staffCorrectionRequest.update({
        where: { id },
        data: {
          status: input.decision,
          decidedBy: hub.user.id,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.correction.decide',
        entity: 'staff_correction_request',
        entityId: id,
        summary: { decision: input.decision },
      });
      return toCorrectionDto(r);
    });
  }

  // ---- role → requirements (HR-03) ------------------------------------------
  @RequirePermission(BASIC)
  @Get('role-requirements')
  async roleRequirements(@Hub() hub: HubRequestContext): Promise<{ data: RoleRequirementDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.roleRequirement.findMany({
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      const t = await tx.requirementTemplate.findMany({
        where: { id: { in: rows.map((r) => r.templateId) } },
      });
      return {
        data: rows.map((r) => {
          const tt = t.find((x) => x.id === r.templateId);
          return {
            id: r.id,
            role: r.role,
            templateId: r.templateId,
            templateCode: tt?.code ?? '',
            templateTitle: tt?.title ?? '',
          };
        }),
      };
    });
  }

  @RequirePermission('staff.profile.manage', 'compliance.requirement.manage')
  @Post('role-requirements')
  async addRoleRequirement(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<RoleRequirementDto> {
    const input = body(RoleRequirementInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const t = await tx.requirementTemplate.findFirst({
        where: { id: input.templateId, organisationId: hub.orgId },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!t) throw notFound();
      if (t.versions[0]?.subjectType !== 'STAFF')
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Only staff requirements can be required for a role',
        );
      if (await tx.roleRequirement.findFirst({ where: { role: input.role, templateId: t.id } }))
        throw new HubError('CONFLICT', 409, 'Already required for this role');
      const r = await tx.roleRequirement.create({
        data: {
          organisationId: hub.orgId as string,
          role: input.role,
          templateId: t.id,
          createdBy: hub.user.id,
        },
      });
      const created = await syncRole(tx, input.role, hub.user.id, new Date());
      await audit(this.db, tx, hub, {
        action: 'staff.role_requirement.add',
        entity: 'role_requirement',
        entityId: r.id,
        summary: { role: input.role, templateId: t.id, instancesCreated: created },
      });
      return {
        id: r.id,
        role: r.role,
        templateId: t.id,
        templateCode: t.code,
        templateTitle: t.title,
      };
    });
  }

  @RequirePermission('staff.profile.manage', 'compliance.requirement.manage')
  @Delete('role-requirements/:id')
  async removeRoleRequirement(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.roleRequirement.findUnique({ where: { id } });
      if (!r) throw notFound();
      await tx.roleRequirement.delete({ where: { id } });
      // Instances stay on record (history); they simply stop counting for people in this role.
      await audit(this.db, tx, hub, {
        action: 'staff.role_requirement.remove',
        entity: 'role_requirement',
        entityId: id,
        summary: { role: r.role, templateId: r.templateId },
      });
      return { removed: true as const };
    });
  }

  @RequirePermission(BASIC)
  @Get('training-matrix')
  async matrix(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<MatrixDto> {
    const f = body(StaffListQuery.pick({ locationId: true, role: true }), q);
    const now = new Date();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const map = await tx.roleRequirement.findMany({ where: f.role ? { role: f.role } : {} });
      const templateIds = [...new Set(map.map((m) => m.templateId))];
      const templates = await tx.requirementTemplate.findMany({
        where: { id: { in: templateIds } },
        orderBy: { code: 'asc' },
      });
      const staff = await tx.staff.findMany({
        where: {
          lifecycleState: { not: 'LEAVER' },
          ...(f.locationId ? { primaryLocationId: f.locationId } : {}),
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: 500,
      });
      const instances = await tx.requirementInstance.findMany({
        where: {
          subjectType: 'STAFF',
          subjectId: { in: staff.map((s) => s.id) },
          templateId: { in: templateIds },
        },
      });
      const sum = await staffStatusSummary(
        tx,
        staff.map((s) => s.id),
        now,
      );
      const rows = staff
        .map((s) => {
          const roles = sum.get(s.id)?.roles ?? [];
          const required = new Set(
            map.filter((m) => roles.includes(m.role)).map((m) => m.templateId),
          );
          return {
            staffId: s.id,
            staffNo: s.staffNo,
            displayName: s.displayName,
            roles: roles as MatrixDto['rows'][number]['roles'],
            cells: templates.map((t) => {
              const i = instances.find((x) => x.subjectId === s.id && x.templateId === t.id);
              const next = i ? (i.dueDate ?? i.expiryDate ?? i.reviewDate) : null;
              return {
                templateId: t.id,
                required: required.has(t.id),
                instanceId: i?.id ?? null,
                status: i ? i.status : null,
                reasonText: i ? i.reasonText : null,
                nextDate: next ? next.toISOString().slice(0, 10) : null,
              };
            }),
          };
        })
        .filter((r) => !f.role || r.roles.includes(f.role));
      return {
        columns: templates.map((t) => ({ templateId: t.id, code: t.code, title: t.title })),
        rows,
      };
    });
  }

  // ---- one person -----------------------------------------------------------
  @OrgMember()
  @Get(':id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<StaffDetailDto | StaffClearanceDto> {
    requireAny(hub, BASIC, CLEARANCE);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findUnique({ where: { id } });
      if (!s) throw notFound();
      const now = new Date();
      const roles = await activeRoles(tx, id, now);
      const restr = (await activeRestrictions(tx, id, now)).map((r) => r.type);
      if (!hub.permissions.has(BASIC)) return toClearanceDto(s, roles, restr);
      return this.detail(tx, s.id);
    });
  }

  @RequirePermission('staff.profile.manage')
  @Patch(':id')
  async patch(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<StaffDto> {
    const expected = ifMatchVersion(req);
    const input = body(StaffPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.assertRefs(tx, hub, { ...input, selfId: id });
      const r = await tx.staff.updateMany({
        where: { id, version: expected },
        data: { ...input, updatedBy: hub.user.id },
      });
      if (r.count === 0) throw staleOrNotFound((await tx.staff.count({ where: { id } })) > 0);
      if (input.primaryLocationId) {
        await tx.requirementInstance.updateMany({
          where: { subjectType: 'STAFF', subjectId: id },
          data: { locationId: input.primaryLocationId },
        });
      }
      await audit(this.db, tx, hub, {
        action: 'staff.profile.update',
        entity: 'staff',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.dto(tx, id);
    });
  }

  @RequirePermission('staff.lifecycle.transition')
  @Post(':id/transition')
  async transition(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<StaffDto> {
    const input = body(TransitionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findUnique({ where: { id } });
      if (!s) throw notFound();
      const now = new Date();
      const refusal = checkStaffTransition({
        from: s.lifecycleState as StaffLifecycle,
        to: input.to,
        approvedRoles: (await activeRoles(tx, id, now)).length,
        actorIsSubject: s.userId === hub.user.id,
      });
      if (refusal === 'SELF_APPROVAL') throw new HubError('SELF_APPROVAL', 422);
      if (refusal === 'NO_ROLE_APPROVED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Approve the person for at least one role first',
        );
      if (refusal)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          `Cannot move from ${s.lifecycleState} to ${input.to}`,
        );
      await tx.staffLifecycleEvent.create({
        data: {
          organisationId: s.organisationId,
          staffId: id,
          fromState: s.lifecycleState,
          toState: input.to,
          reason: input.reason,
          actorUserId: hub.user.id,
        },
      });
      await tx.staff.update({
        where: { id },
        data: { lifecycleState: input.to, updatedBy: hub.user.id },
      });
      if (input.to === 'LEAVER' && s.userId) {
        // Leavers lose access immediately (SEC: joiner/mover/leaver).
        await tx.membership.updateMany({
          where: { userId: s.userId, validTo: null },
          data: { validTo: await dbNow(tx), updatedBy: hub.user.id },
        });
      }
      if (input.to === 'ACTIVE') await syncStaffRequirements(tx, id, hub.user.id, now);
      await audit(this.db, tx, hub, {
        action: 'staff.lifecycle.transition',
        entity: 'staff',
        entityId: id,
        summary: { from: s.lifecycleState, to: input.to },
      });
      return this.dto(tx, id);
    });
  }

  @OrgMember()
  @Get(':id/readiness')
  async readiness(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Query() q: unknown,
  ): Promise<ReadinessDto> {
    requireAny(hub, BASIC, CLEARANCE);
    const f = body(ReadinessQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.staff.count({ where: { id } }))) throw notFound();
      const r = await staffReadinessFor(tx, {
        staffId: id,
        role: f.role,
        window: { start: new Date(f.from), end: new Date(f.to) },
        licenceCategory: f.licenceCategory,
        competencies: f.competencies,
        now: new Date(),
      });
      return {
        staffId: id,
        role: f.role,
        state: r.state,
        checks: r.checks,
        restrictions: r.restrictions as ReadinessDto['restrictions'],
      };
    });
  }

  @RequirePermission('staff.approve_role')
  @Post(':id/role-approvals')
  async approveRole(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(RoleApprovalInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.subjectForChange(tx, hub, id);
      if (
        await tx.staffRoleApproval.findFirst({
          where: { staffId: id, role: input.role, revokedAt: null },
        })
      )
        throw new HubError('CONFLICT', 409, 'Already approved for this role');
      const now = new Date();
      if (input.validTo && new Date(input.validTo) <= now)
        throw new HubError('VALIDATION_FAILED', 400, 'validTo must be in the future');
      const a = await tx.staffRoleApproval.create({
        data: {
          organisationId: s.organisationId,
          staffId: id,
          role: input.role,
          reason: input.reason,
          approvedBy: hub.user.id,
          validFrom: now, // same instant used for the HR-03 recalculation below
          validTo: input.validTo ? new Date(input.validTo) : null,
        },
      });
      const created = await syncStaffRequirements(tx, id, hub.user.id, now);
      await audit(this.db, tx, hub, {
        action: 'staff.role.approve',
        entity: 'staff_role_approval',
        entityId: a.id,
        summary: { staffId: id, role: input.role, instancesCreated: created.length },
      });
      return roleApprovalDto(a, now);
    });
  }

  @RequirePermission('staff.approve_role')
  @Post(':id/role-approvals/:approvalId/revoke')
  async revokeRole(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('approvalId', idPipe) approvalId: string,
    @Body() raw: unknown,
  ) {
    const input = body(CloseInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.subjectForChange(tx, hub, id);
      const a = await tx.staffRoleApproval.findFirst({ where: { id: approvalId, staffId: id } });
      if (!a) throw notFound();
      if (a.revokedAt) throw new HubError('CONFLICT', 409, 'Already revoked');
      const now = new Date();
      const r = await tx.staffRoleApproval.update({
        where: { id: approvalId },
        data: { revokedAt: now, revokedBy: hub.user.id, revokeReason: input.reason },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.role.revoke',
        entity: 'staff_role_approval',
        entityId: approvalId,
        summary: { staffId: id, role: a.role },
      });
      return roleApprovalDto(r, now);
    });
  }

  @RequirePermission('staff.restrict')
  @Post(':id/restrictions')
  async restrict(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(RestrictionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.subjectForChange(tx, hub, id);
      const now = new Date();
      const from = input.validFrom ? new Date(input.validFrom) : now;
      if (input.validTo && new Date(input.validTo) <= from)
        throw new HubError('VALIDATION_FAILED', 400, 'validTo must be after validFrom');
      const r = await tx.staffRestriction.create({
        data: {
          organisationId: s.organisationId,
          staffId: id,
          type: input.type,
          detail: input.detail ?? null,
          reason: input.reason,
          appliedBy: hub.user.id,
          validFrom: from,
          validTo: input.validTo ? new Date(input.validTo) : null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.restriction.apply',
        entity: 'staff_restriction',
        entityId: r.id,
        summary: { staffId: id, type: input.type },
      });
      return restrictionDto(r, now);
    });
  }

  @RequirePermission('staff.restrict')
  @Post(':id/restrictions/:restrictionId/lift')
  async lift(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('restrictionId', idPipe) restrictionId: string,
    @Body() raw: unknown,
  ) {
    const input = body(CloseInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.subjectForChange(tx, hub, id);
      const r = await tx.staffRestriction.findFirst({ where: { id: restrictionId, staffId: id } });
      if (!r) throw notFound();
      if (r.liftedAt) throw new HubError('CONFLICT', 409, 'Already lifted');
      const now = new Date();
      const u = await tx.staffRestriction.update({
        where: { id: restrictionId },
        data: { liftedAt: now, liftedBy: hub.user.id, liftReason: input.reason },
      });
      await audit(this.db, tx, hub, {
        action: 'staff.restriction.lift',
        entity: 'staff_restriction',
        entityId: restrictionId,
        summary: { staffId: id, type: r.type },
      });
      return restrictionDto(u, now);
    });
  }

  // ---- typed records --------------------------------------------------------
  @RequirePermission(BASIC)
  @Get(':id/:kind')
  async records(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('kind') slug: string,
  ): Promise<{ data: StaffRecordDto[] }> {
    const kind = kindOf(slug);
    const sensitive = SENSITIVE_RECORD_KINDS.includes(kind);
    if (sensitive && !hub.permissions.has(SENSITIVE)) throw new HubError('FORBIDDEN', 403);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.staff.count({ where: { id } }))) throw notFound();
      const rows = await tx.staffRecord.findMany({
        where: { staffId: id, kind },
        include: { supersededBy: { select: { id: true } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      // Viewing restricted data is itself audited (SECURITY_COMPLIANCE §3).
      if (sensitive)
        await audit(this.db, tx, hub, {
          action: 'staff.sensitive.view',
          entity: 'staff',
          entityId: id,
          summary: { kind },
        });
      return { data: rows.map((r) => toRecordDto(r, this.key)) };
    });
  }

  @RequirePermission('staff.profile.manage')
  @Post(':id/:kind')
  async addRecord(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('kind') slug: string,
    @Body() raw: unknown,
  ): Promise<StaffRecordDto> {
    const kind = kindOf(slug);
    const sensitive = SENSITIVE_RECORD_KINDS.includes(kind);
    if (sensitive && !hub.permissions.has(SENSITIVE)) throw new HubError('FORBIDDEN', 403);
    const input = body(RecordCreate, raw);
    const data = body(RecordPayloads[kind], input.data) as Record<string, unknown>;
    const v = derivedValidity(kind, data);
    if (v.validFrom && v.validTo && v.validTo < v.validFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'The end date is before the start date');
    if (kind === 'REFERENCE' && data.outcome === 'SATISFACTORY' && !data.receivedOn)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'A satisfactory reference needs the date it was received',
      );
    if (kind === 'DBS')
      data.certificateNumber = encryptField(data.certificateNumber as string, this.key);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.subjectForChange(tx, hub, id);
      if (input.supersedesId) {
        const old = await tx.staffRecord.findFirst({
          where: { id: input.supersedesId, staffId: id, kind },
          include: { supersededBy: { select: { id: true } } },
        });
        if (!old) throw notFound();
        if (old.supersededBy)
          throw new HubError('CONFLICT', 409, 'That record has already been corrected');
      }
      if (input.requirementInstanceId) {
        const i = await tx.requirementInstance.findFirst({
          where: { id: input.requirementInstanceId, subjectType: 'STAFF', subjectId: id },
        });
        if (!i) throw notFound();
      }
      for (const k of [
        'checkerUserId',
        'assessorUserId',
        'supervisorUserId',
        'appraiserUserId',
        'signedOffByUserId',
      ]) {
        const uid = data[k];
        if (typeof uid === 'string' && !(await tx.membership.count({ where: { userId: uid } })))
          throw new HubError('VALIDATION_FAILED', 400, `${k} is not a member of this organisation`);
      }
      const r = await tx.staffRecord.create({
        data: {
          organisationId: s.organisationId,
          staffId: id,
          kind,
          data: data as Prisma.InputJsonObject,
          validFrom: v.validFrom ? toDate(v.validFrom) : null,
          validTo: v.validTo ? toDate(v.validTo) : null,
          requirementInstanceId: input.requirementInstanceId ?? null,
          supersedesId: input.supersedesId ?? null,
          createdBy: hub.user.id,
        },
        include: { supersededBy: { select: { id: true } } },
      });
      await audit(this.db, tx, hub, {
        action: input.supersedesId ? 'staff.record.correct' : 'staff.record.add',
        entity: 'staff_record',
        entityId: r.id,
        summary: { staffId: id, kind, supersedesId: input.supersedesId ?? null },
      });
      return toRecordDto(r, this.key);
    });
  }

  // ---- helpers --------------------------------------------------------------
  /** The record must be visible; nobody approves, restricts or edits their own record. */
  private async subjectForChange(tx: TenantTx, hub: HubRequestContext, id: string) {
    const s = await tx.staff.findUnique({ where: { id } });
    if (!s) throw notFound();
    if (s.userId === hub.user.id) throw new HubError('SELF_APPROVAL', 422);
    if (s.lifecycleState === 'LEAVER')
      throw new HubError('CONFLICT', 409, 'The record is closed (leaver)');
    return s;
  }

  private async assertRefs(
    tx: TenantTx,
    hub: HubRequestContext,
    i: {
      primaryLocationId?: string;
      userId?: string | null;
      managerStaffId?: string | null;
      selfId?: string;
    },
  ): Promise<void> {
    if (i.primaryLocationId) {
      if (!(await tx.location.findUnique({ where: { id: i.primaryLocationId } }))) throw notFound();
      if (hub.locationIds && !hub.locationIds.includes(i.primaryLocationId)) throw notFound();
    }
    if (i.userId) {
      if (!(await tx.membership.count({ where: { userId: i.userId, validTo: null } })))
        throw new HubError('VALIDATION_FAILED', 400, 'The linked user is not an active member');
      const taken = await tx.staff.findFirst({
        where: { userId: i.userId, ...(i.selfId ? { id: { not: i.selfId } } : {}) },
      });
      if (taken)
        throw new HubError('CONFLICT', 409, 'That user is already linked to a staff record');
    }
    if (i.managerStaffId) {
      if (i.managerStaffId === i.selfId)
        throw new HubError('VALIDATION_FAILED', 400, 'A person cannot be their own manager');
      if (!(await tx.staff.count({ where: { id: i.managerStaffId } }))) throw notFound();
    }
  }

  private async requirements(tx: TenantTx, staffId: string, roles: string[]) {
    const set = await requiredTemplates(tx, roles);
    const rows = await tx.requirementInstance.findMany({
      where: { subjectType: 'STAFF', subjectId: staffId },
      include: instanceInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((i) => ({ ...toInstanceDto(i), required: isRequired(i.templateId, set) }));
  }

  private async dto(tx: TenantTx, id: string): Promise<StaffDto> {
    const s = await tx.staff.findUniqueOrThrow({ where: { id } });
    const now = new Date();
    const sum = (await staffStatusSummary(tx, [id], now)).get(id)!;
    const restr = (await activeRestrictions(tx, id, now)).map((r) => r.type);
    return toStaffDto(s, sum, restr);
  }

  private async detail(tx: TenantTx, id: string): Promise<StaffDetailDto> {
    const base = await this.dto(tx, id);
    const now = new Date();
    const [approvals, restrictions, events] = await Promise.all([
      tx.staffRoleApproval.findMany({ where: { staffId: id }, orderBy: { createdAt: 'desc' } }),
      tx.staffRestriction.findMany({ where: { staffId: id }, orderBy: { createdAt: 'desc' } }),
      tx.staffLifecycleEvent.findMany({ where: { staffId: id }, orderBy: { at: 'desc' } }),
    ]);
    return {
      ...base,
      roleApprovals: approvals.map((a) => roleApprovalDto(a, now)),
      restrictions: restrictions.map((r) => restrictionDto(r, now)),
      events: events.map((e) => ({
        id: e.id,
        fromState: e.fromState,
        toState: e.toState,
        reason: e.reason,
        actorUserId: e.actorUserId,
        at: e.at.toISOString(),
      })),
      requirements: await this.requirements(tx, id, base.roles),
      allowedTransitions: [...allowedTransitions(base.lifecycleState as StaffLifecycle)],
    };
  }
}
