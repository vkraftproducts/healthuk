import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { createAction, nextCode, queuePush } from '@hub/domain';
import { ackState, isOverdue, londonDate, riskRating } from '@hub/rules';
import {
  AckInput,
  CorrespondenceInput,
  CorrespondencePatch,
  EventActionInput,
  PolicyCreate,
  PolicyTransitionInput,
  PolicyVersionInput,
  RegistrationInput,
  RiskInput,
  RiskPatch,
  type PolicyDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { toActionDto } from './audits.controller.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const MANAGE = 'compliance.policy.manage';

/** Allowed policy moves (COMP-04): DRAFT → IN_REVIEW → APPROVED → PUBLISHED → SUPERSEDED / ARCHIVED. */
const NEXT: Record<string, string[]> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: ['ARCHIVED'],
};

async function assertMember(tx: TenantTx, userId: string): Promise<void> {
  if (
    !(await tx.membership.count({ where: { userId, validTo: null, user: { status: 'ACTIVE' } } }))
  )
    throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
}

/** Policies and SOPs with versioned acknowledgement; risk register; registration record. */
@Controller()
export class PoliciesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get('policies')
  async list(@Hub() hub: HubRequestContext): Promise<{ data: PolicyDto[] }> {
    requireAny(hub, MANAGE, 'compliance.policy.acknowledge');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const docs = await tx.policyDocument.findMany({
        orderBy: { code: 'asc' },
        select: { id: true },
      });
      const out: PolicyDto[] = [];
      for (const d of docs) {
        const dto = await this.dto(tx, hub, d.id);
        // Readers see the policies they must read; managers see everything (drafts included).
        if (
          hub.permissions.has(MANAGE) ||
          (dto.myAcknowledgement !== 'NOT_A_READER' && dto.currentVersion)
        )
          out.push(dto);
      }
      return { data: out };
    });
  }

  @RequirePermission(MANAGE)
  @Post('policies')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<PolicyDto> {
    const input = body(PolicyCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (await tx.policyDocument.findFirst({ where: { code: input.code } }))
        throw new HubError('CONFLICT', 409, 'That code is already used');
      await assertMember(tx, input.ownerUserId);
      await this.assertItem(tx, input.evidenceItemId);
      const d = await tx.policyDocument.create({
        data: {
          organisationId: hub.orgId as string,
          code: input.code,
          title: input.title,
          category: input.category,
          ownerUserId: input.ownerUserId,
          readerRoles: input.readerRoles,
          createdBy: hub.user.id,
        },
      });
      await tx.policyVersion.create({
        data: {
          organisationId: d.organisationId,
          documentId: d.id,
          version: 1,
          summary: input.summary,
          material: true,
          evidenceItemId: input.evidenceItemId ?? null,
          reviewDate: input.reviewDate ? day(input.reviewDate) : null,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.policy.create',
        entity: 'policy_document',
        entityId: d.id,
      });
      return this.dto(tx, hub, d.id);
    });
  }

  @OrgMember()
  @Get('policies/:id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<PolicyDto> {
    requireAny(hub, MANAGE, 'compliance.policy.acknowledge');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.policyDocument.count({ where: { id } }))) throw notFound();
      const dto = await this.dto(tx, hub, id);
      if (
        !hub.permissions.has(MANAGE) &&
        (dto.myAcknowledgement === 'NOT_A_READER' || !dto.currentVersion)
      )
        throw notFound();
      return dto;
    });
  }

  @RequirePermission(MANAGE)
  @Post('policies/:id/versions')
  async newVersion(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<PolicyDto> {
    const input = body(PolicyVersionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.policyDocument.findUnique({ where: { id }, include: { versions: true } });
      if (!d) throw notFound();
      if (d.versions.some((v) => ['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(v.status)))
        throw new HubError('CONFLICT', 409, 'A new version is already in progress');
      await this.assertItem(tx, input.evidenceItemId);
      const next = Math.max(...d.versions.map((v) => v.version)) + 1;
      await tx.policyVersion.create({
        data: {
          organisationId: d.organisationId,
          documentId: id,
          version: next,
          summary: input.summary,
          material: input.material,
          evidenceItemId: input.evidenceItemId ?? null,
          reviewDate: input.reviewDate ? day(input.reviewDate) : null,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.policy.version',
        entity: 'policy_document',
        entityId: id,
        summary: { version: next, material: input.material },
      });
      return this.dto(tx, hub, id);
    });
  }

  @RequirePermission(MANAGE)
  @Post('policies/:id/versions/:versionId/transition')
  async transition(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('versionId', idPipe) versionId: string,
    @Body() raw: unknown,
  ): Promise<PolicyDto> {
    const input = body(PolicyTransitionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.policyVersion.findFirst({ where: { id: versionId, documentId: id } });
      if (!v) throw notFound();
      if (!(NEXT[v.status] ?? []).includes(input.to))
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          `Cannot move a ${v.status.toLowerCase()} version to ${input.to.toLowerCase()}`,
        );
      const now = new Date();
      const data: Prisma.PolicyVersionUpdateInput = { status: input.to };
      if (input.to === 'APPROVED') {
        if (v.createdBy === hub.user.id)
          throw new HubError(
            'FOUR_EYES_REQUIRED',
            422,
            'The author cannot approve their own version',
          );
        data.approvedBy = hub.user.id;
        data.approvedAt = now;
      }
      if (input.to === 'DRAFT') {
        data.approvedBy = null;
        data.approvedAt = null;
      }
      if (input.to === 'PUBLISHED') {
        await tx.policyVersion.updateMany({
          where: { documentId: id, status: 'PUBLISHED' },
          data: { status: 'SUPERSEDED' },
        });
        data.publishedAt = now;
        data.effectiveFrom = day(input.effectiveFrom ?? londonDate(now));
      }
      await tx.policyVersion.update({ where: { id: versionId }, data });
      if (input.to === 'PUBLISHED' && v.material) {
        // Readers must (re-)acknowledge: a generic push to everyone in the reader roles.
        const doc = await tx.policyDocument.findUniqueOrThrow({ where: { id } });
        const readers = await tx.membership.findMany({
          where: {
            validTo: null,
            ...(doc.readerRoles.length ? { role: { key: { in: doc.readerRoles } } } : {}),
          },
          select: { userId: true },
        });
        await queuePush(tx, {
          orgId: doc.organisationId,
          userIds: readers.map((r) => r.userId),
          kind: 'POLICY_ACK',
          refId: versionId,
          event: 'published',
        });
      }
      await audit(this.db, tx, hub, {
        action: 'compliance.policy.transition',
        entity: 'policy_version',
        entityId: versionId,
        summary: { from: v.status, to: input.to },
      });
      return this.dto(tx, hub, id);
    });
  }

  @RequirePermission('compliance.policy.acknowledge')
  @Post('policies/:id/acknowledge')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<PolicyDto> {
    const input = body(AckInput, raw ?? {});
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.policyDocument.findUnique({ where: { id } });
      if (!d) throw notFound();
      const current = await tx.policyVersion.findFirst({
        where: { documentId: id, status: 'PUBLISHED' },
      });
      if (!current || !(await this.isReader(tx, hub, d.readerRoles))) throw notFound();
      const existing = await tx.policyAcknowledgement.findFirst({
        where: { policyVersionId: current.id, userId: hub.user.id },
      });
      if (!existing) {
        await tx.policyAcknowledgement.create({
          data: {
            organisationId: d.organisationId,
            policyVersionId: current.id,
            userId: hub.user.id,
            device: input.device ?? null,
          },
        });
        await audit(this.db, tx, hub, {
          action: 'compliance.policy.acknowledge',
          entity: 'policy_version',
          entityId: current.id,
        });
      }
      return this.dto(tx, hub, id);
    });
  }

  // ---- risk register --------------------------------------------------------------------
  @OrgMember()
  @Get('risks')
  async risks(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.risk.manage', 'compliance.audit.view');
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.risk.findMany({ orderBy: [{ status: 'asc' }, { reviewDate: 'asc' }] }),
    );
    const now = new Date();
    return { data: rows.map((r) => riskDto(r, now)) };
  }

  @RequirePermission('compliance.risk.manage')
  @Post('risks')
  async createRisk(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(RiskInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertMember(tx, input.ownerUserId);
      await this.assertRiskRefs(tx, input);
      const r = await tx.risk.create({
        data: {
          ...input,
          reviewDate: day(input.reviewDate),
          locationId: input.locationId ?? null,
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'RSK'),
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.risk.create',
        entity: 'risk',
        entityId: r.id,
        summary: { residual: riskRating(r.residualLikelihood, r.residualImpact).score },
      });
      return riskDto(r, new Date());
    });
  }

  @RequirePermission('compliance.risk.manage')
  @Patch('risks/:id')
  async patchRisk(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const expected = ifMatchVersion(req);
    const input = body(RiskPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.ownerUserId) await assertMember(tx, input.ownerUserId);
      await this.assertRiskRefs(tx, input);
      const r = await tx.risk.updateMany({
        where: { id, version: expected },
        data: { ...input, ...(input.reviewDate ? { reviewDate: day(input.reviewDate) } : {}) },
      });
      if (r.count === 0) throw staleOrNotFound((await tx.risk.count({ where: { id } })) > 0);
      await audit(this.db, tx, hub, {
        action: 'compliance.risk.update',
        entity: 'risk',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return riskDto(await tx.risk.findUniqueOrThrow({ where: { id } }), new Date());
    });
  }

  @RequirePermission('compliance.risk.manage')
  @Post('risks/:id/actions')
  async riskAction(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(EventActionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.risk.findUnique({ where: { id } });
      if (!r) throw notFound();
      await assertMember(tx, input.ownerUserId);
      const sev = riskRating(r.residualLikelihood, r.residualImpact).rating;
      const a = await createAction(tx, {
        organisationId: r.organisationId,
        sourceType: 'RISK',
        sourceId: id,
        title: input.title,
        severity:
          input.severity ?? (sev === 'EXTREME' ? 'CRITICAL' : sev === 'HIGH' ? 'HIGH' : 'MEDIUM'),
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { riskId: id },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }

  // ---- registration (COMP-03) -----------------------------------------------------------------
  @OrgMember()
  @Get('registration')
  async registration(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.registration.manage', 'compliance.audit.view');
    return this.db.withTenant(tenantOf(hub), (tx) => this.regDto(tx, hub.orgId as string));
  }

  @RequirePermission('compliance.registration.manage')
  @Post('registration')
  async saveRegistration(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(RegistrationInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.registeredManagerUserId) await assertMember(tx, input.registeredManagerUserId);
      for (const k of ['statementOfPurposeItemId', 'insuranceItemId', 'bcpItemId'] as const)
        await this.assertItem(tx, input[k] ?? undefined);
      const orgId = hub.orgId as string;
      await tx.registrationRecord.upsert({
        where: { organisationId: orgId },
        create: { organisationId: orgId, ...input, updatedBy: hub.user.id },
        update: { ...input, updatedBy: hub.user.id },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.registration.update',
        entity: 'registration_record',
        entityId: orgId,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.regDto(tx, orgId);
    });
  }

  @OrgMember()
  @Get('regulatory-correspondence')
  async correspondence(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.registration.manage', 'compliance.audit.view');
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.regulatoryCorrespondence.findMany({ orderBy: [{ status: 'asc' }, { deadline: 'asc' }] }),
    );
    const now = new Date();
    return { data: rows.map((c) => corrDto(c, now)) };
  }

  @RequirePermission('compliance.registration.manage')
  @Post('regulatory-correspondence')
  async addCorrespondence(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(CorrespondenceInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await assertMember(tx, input.ownerUserId);
      await this.assertItem(tx, input.evidenceItemId);
      const c = await tx.regulatoryCorrespondence.create({
        data: {
          organisationId: hub.orgId as string,
          regulator: input.regulator,
          subject: input.subject,
          receivedOn: day(input.receivedOn),
          deadline: input.deadline ? day(input.deadline) : null,
          ownerUserId: input.ownerUserId,
          evidenceItemId: input.evidenceItemId ?? null,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.correspondence.log',
        entity: 'regulatory_correspondence',
        entityId: c.id,
        summary: { regulator: input.regulator },
      });
      return corrDto(c, new Date());
    });
  }

  @RequirePermission('compliance.registration.manage')
  @Patch('regulatory-correspondence/:id')
  async patchCorrespondence(
    @Hub() hub: HubRequestContext,
    @Req() req: HubRequest,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const expected = ifMatchVersion(req);
    const input = body(CorrespondencePatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.regulatoryCorrespondence.updateMany({
        where: { id, version: expected },
        data: {
          status: input.status,
          ...(input.status === 'RESPONDED'
            ? { respondedOn: day(input.respondedOn ?? londonDate(new Date())) }
            : {}),
        },
      });
      if (r.count === 0)
        throw staleOrNotFound((await tx.regulatoryCorrespondence.count({ where: { id } })) > 0);
      await audit(this.db, tx, hub, {
        action: 'compliance.correspondence.update',
        entity: 'regulatory_correspondence',
        entityId: id,
        summary: { status: input.status },
      });
      return corrDto(
        await tx.regulatoryCorrespondence.findUniqueOrThrow({ where: { id } }),
        new Date(),
      );
    });
  }

  // ---- helpers ----------------------------------------------------------------------------------
  private async assertItem(tx: TenantTx, id: string | undefined | null) {
    if (id && !(await tx.evidenceItem.count({ where: { id } }))) throw notFound();
  }

  private async assertRiskRefs(
    tx: TenantTx,
    i: { locationId?: string; linkedEventIds?: string[] },
  ) {
    if (i.locationId && !(await tx.location.findUnique({ where: { id: i.locationId } })))
      throw notFound();
    if (
      i.linkedEventIds?.length &&
      (await tx.event.count({ where: { id: { in: i.linkedEventIds } } })) !==
        new Set(i.linkedEventIds).size
    )
      throw notFound();
  }

  private async isReader(tx: TenantTx, hub: HubRequestContext, roles: string[]): Promise<boolean> {
    if (roles.length === 0) return true;
    const m = await tx.membership.findMany({
      where: { userId: hub.user.id, validTo: null },
      include: { role: { select: { key: true } } },
    });
    return m.some((x) => roles.includes(x.role.key));
  }

  private async dto(tx: TenantTx, hub: HubRequestContext, id: string): Promise<PolicyDto> {
    const d = await tx.policyDocument.findUniqueOrThrow({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const published = d.versions.filter(
      (v) =>
        v.status === 'PUBLISHED' ||
        v.status === 'SUPERSEDED' ||
        (v.status === 'ARCHIVED' && v.publishedAt),
    );
    const current = d.versions.find((v) => v.status === 'PUBLISHED') ?? null;
    const chain = published
      .filter((v) => !current || v.version <= current.version)
      .map((v) => ({ id: v.id, material: v.material }));
    const acks = await tx.policyAcknowledgement.findMany({
      where: { policyVersionId: { in: chain.map((c) => c.id) } },
    });
    const byUser = new Map<string, Set<string>>();
    for (const a of acks)
      byUser.set(a.userId, (byUser.get(a.userId) ?? new Set()).add(a.policyVersionId));
    const members = await tx.membership.findMany({
      where: {
        validTo: null,
        user: { status: 'ACTIVE' },
        ...(d.readerRoles.length ? { role: { key: { in: d.readerRoles } } } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    const okStates = new Set(['CURRENT', 'CARRIED_FORWARD']);
    const acknowledged = current
      ? members.filter((m) => okStates.has(ackState(chain, byUser.get(m.userId) ?? new Set())))
          .length
      : 0;
    const reader = await this.isReader(tx, hub, d.readerRoles);
    return {
      id: d.id,
      code: d.code,
      title: d.title,
      category: d.category,
      ownerUserId: d.ownerUserId,
      readerRoles: d.readerRoles,
      currentVersion: current
        ? {
            id: current.id,
            version: current.version,
            effectiveFrom: iso(current.effectiveFrom),
            reviewDate: iso(current.reviewDate),
            material: current.material,
          }
        : null,
      versions: d.versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        summary: v.summary,
        material: v.material,
        createdBy: v.createdBy,
        approvedBy: v.approvedBy,
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
      acknowledgement: { acknowledged, required: current ? members.length : 0 },
      myAcknowledgement: reader
        ? ackState(current ? chain : [], byUser.get(hub.user.id) ?? new Set())
        : 'NOT_A_READER',
    };
  }

  private async regDto(tx: TenantTx, orgId: string) {
    const r = await tx.registrationRecord.findUnique({ where: { organisationId: orgId } });
    const acts = await tx.registeredActivity.findMany({ where: { archivedAt: null } });
    return {
      providerRef: r?.providerRef ?? null,
      registeredManagerUserId: r?.registeredManagerUserId ?? null,
      nominatedIndividual: r?.nominatedIndividual ?? null,
      conditions: r?.conditions ?? null,
      statementOfPurposeItemId: r?.statementOfPurposeItemId ?? null,
      insuranceItemId: r?.insuranceItemId ?? null,
      bcpItemId: r?.bcpItemId ?? null,
      registeredActivities: acts.map((a) => ({ locationId: a.locationId, activity: a.name })),
      version: r?.version ?? 0,
    };
  }
}

function riskDto(r: Prisma.RiskGetPayload<object>, now: Date) {
  const inh = riskRating(r.inherentLikelihood, r.inherentImpact);
  const res = riskRating(r.residualLikelihood, r.residualImpact);
  return {
    id: r.id,
    code: r.code,
    hazard: r.hazard,
    peopleAffected: r.peopleAffected,
    inherent: { likelihood: r.inherentLikelihood, impact: r.inherentImpact, ...inh },
    residual: { likelihood: r.residualLikelihood, impact: r.residualImpact, ...res },
    controls: r.controls,
    ownerUserId: r.ownerUserId,
    reviewDate: iso(r.reviewDate) as string,
    reviewOverdue: r.status === 'OPEN' && isOverdue(iso(r.reviewDate) as string, now),
    locationId: r.locationId,
    status: r.status,
    linkedEventIds: r.linkedEventIds,
    version: r.version,
  };
}

function corrDto(c: Prisma.RegulatoryCorrespondenceGetPayload<object>, now: Date) {
  return {
    id: c.id,
    regulator: c.regulator,
    subject: c.subject,
    receivedOn: iso(c.receivedOn) as string,
    deadline: iso(c.deadline),
    status: c.status,
    respondedOn: iso(c.respondedOn),
    ownerUserId: c.ownerUserId,
    overdue: c.status === 'OPEN' && !!c.deadline && isOverdue(iso(c.deadline) as string, now),
    version: c.version,
  };
}
