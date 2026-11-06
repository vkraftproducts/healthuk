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
import {
  ackState,
  isOverdue,
  londonDate,
  notificationTargetDate,
  riskBandText,
  riskRating,
} from '@hub/rules';
import {
  AckInput,
  CorrespondenceInput,
  CorrespondencePatch,
  EventActionInput,
  PolicyCreate,
  PolicyReadersInput,
  PolicyTransitionInput,
  PolicyVersionInput,
  RegistrationInput,
  RegistrationLocationInput,
  RiskInput,
  RiskPatch,
  type PolicyDto,
  type PolicyReadersDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { audit, body, ifMatchVersion, requireAny, staleOrNotFound } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';
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

type ReaderGroups = {
  readerRoles: string[];
  readerLocationIds: string[];
  readerEveryone: boolean;
};
/** Required readers (G4): everyone, or members in a reader role or at a reader location. */
function readerWhere(d: ReaderGroups): Prisma.MembershipWhereInput {
  if (d.readerEveryone || (!d.readerRoles.length && !d.readerLocationIds.length)) return {};
  return {
    OR: [
      ...(d.readerRoles.length ? [{ role: { key: { in: d.readerRoles } } }] : []),
      ...(d.readerLocationIds.length ? [{ locationId: { in: d.readerLocationIds } }] : []),
    ],
  };
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
          readerLocationIds: input.readerLocationIds,
          readerEveryone: input.readerEveryone,
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
        if (!hub.permissions.has('compliance.policy.approve'))
          throw new HubError(
            'FORBIDDEN',
            403,
            'Policies are approved by the registered manager (or a director)',
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
          where: { validTo: null, ...readerWhere(doc) },
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
      if (!current || !(await this.isReader(tx, hub, d))) throw notFound();
      const critical = d.category === 'CRITICAL_INSTRUCTION';
      if (critical && input.confirmCritical !== true)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Confirm you have read and understood this critical instruction',
        );
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
          summary: { critical },
        });
      }
      return this.dto(tx, hub, id);
    });
  }

  @RequirePermission(MANAGE)
  @Get('policies/:id/readers')
  async readers(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<PolicyReadersDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.policyDocument.findUnique({
        where: { id },
        include: { versions: { orderBy: { version: 'desc' } } },
      });
      if (!d) throw notFound();
      const chain = this.ackChain(d.versions);
      const acks = await tx.policyAcknowledgement.findMany({
        where: { policyVersionId: { in: chain.map((c) => c.id) } },
      });
      const members = await tx.membership.findMany({
        where: { validTo: null, user: { status: 'ACTIVE' }, ...readerWhere(d) },
        select: {
          userId: true,
          user: { select: { displayName: true } },
          role: { select: { name: true } },
        },
      });
      const people = new Map<string, { displayName: string; roleNames: string[] }>();
      for (const m of members) {
        const p = people.get(m.userId) ?? { displayName: m.user.displayName, roleNames: [] };
        if (!p.roleNames.includes(m.role.name)) p.roleNames.push(m.role.name);
        people.set(m.userId, p);
      }
      const data = [...people.entries()].map(([userId, p]) => {
        const mine = acks.filter((a) => a.userId === userId);
        const state = ackState(chain, new Set(mine.map((a) => a.policyVersionId)));
        const latest = mine.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
        return {
          userId,
          ...p,
          state,
          acknowledgedAt:
            state === 'CURRENT' || state === 'CARRIED_FORWARD'
              ? (latest?.at.toISOString() ?? null)
              : null,
        };
      });
      // People who still need to read it come first.
      data.sort(
        (a, b) =>
          Number(a.state !== 'REQUIRED') - Number(b.state !== 'REQUIRED') ||
          a.displayName.localeCompare(b.displayName),
      );
      return { data };
    });
  }

  /** Change who must read the policy: roles, locations or everyone (G4). */
  @RequirePermission(MANAGE)
  @Patch('policies/:id/readers')
  async setReaders(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<PolicyDto> {
    const input = body(PolicyReadersInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.policyDocument.count({ where: { id } }))) throw notFound();
      if (input.readerLocationIds?.length) {
        const n = await tx.location.count({ where: { id: { in: input.readerLocationIds } } });
        if (n !== new Set(input.readerLocationIds).size) throw notFound();
      }
      await tx.policyDocument.update({ where: { id }, data: input });
      await audit(this.db, tx, hub, {
        action: 'compliance.policy.readers',
        entity: 'policy_document',
        entityId: id,
        summary: { fields: Object.keys(input).join(',') },
      });
      return this.dto(tx, hub, id);
    });
  }

  /** Reminds everyone who has not acknowledged the current version (outstanding list). */
  @RequirePermission(MANAGE)
  @Post('policies/:id/chase')
  async chase(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<{ chased: number }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.policyDocument.findUnique({
        where: { id },
        include: { versions: { orderBy: { version: 'desc' } } },
      });
      if (!d) throw notFound();
      const current = d.versions.find((v) => v.status === 'PUBLISHED');
      if (!current)
        throw new HubError('CONFLICT', 409, 'There is no published version to acknowledge');
      const chain = this.ackChain(d.versions);
      const acks = await tx.policyAcknowledgement.findMany({
        where: { policyVersionId: { in: chain.map((c) => c.id) } },
      });
      const members = await tx.membership.findMany({
        where: { validTo: null, user: { status: 'ACTIVE' }, ...readerWhere(d) },
        select: { userId: true },
        distinct: ['userId'],
      });
      const outstanding = members
        .map((m) => m.userId)
        .filter((u) => {
          const mine = new Set(acks.filter((a) => a.userId === u).map((a) => a.policyVersionId));
          return ackState(chain, mine) === 'REQUIRED';
        });
      if (outstanding.length)
        await queuePush(tx, {
          orgId: d.organisationId,
          userIds: outstanding,
          kind: 'POLICY_ACK',
          refId: current.id,
          // At most one reminder per person per day.
          event: `reminder-${londonDate(new Date())}`,
        });
      await audit(this.db, tx, hub, {
        action: 'compliance.policy.chase',
        entity: 'policy_version',
        entityId: current.id,
        summary: { chased: outstanding.length },
      });
      return { chased: outstanding.length };
    });
  }

  // ---- risk register --------------------------------------------------------------------
  @OrgMember()
  @Get('risks')
  async risks(@Hub() hub: HubRequestContext) {
    requireAny(hub, 'compliance.risk.manage', 'compliance.audit.view');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.risk.findMany({ orderBy: [{ status: 'asc' }, { reviewDate: 'asc' }] });
      return { data: await riskDtos(tx, rows) };
    });
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
      return (await riskDtos(tx, [r]))[0]!;
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
    const { reason, ...input } = body(RiskPatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const before = await tx.risk.findUnique({ where: { id } });
      if (!before) throw notFound();
      if (before.status !== 'OPEN' && (!input.status || input.status !== 'OPEN'))
        throw new HubError('CONFLICT', 409, 'Reopen the risk before changing it');
      if (input.ownerUserId) await assertMember(tx, input.ownerUserId);
      await this.assertRiskRefs(tx, input);
      const closing = input.status === 'CLOSED' || input.status === 'ARCHIVED';
      const r = await tx.risk.updateMany({
        where: { id, version: expected },
        data: {
          ...input,
          ...(input.reviewDate ? { reviewDate: day(input.reviewDate) } : {}),
          ...(closing
            ? { closedReason: reason ?? null, closedAt: new Date(), closedBy: hub.user.id }
            : {}),
          ...(input.status === 'OPEN'
            ? { closedReason: null, closedAt: null, closedBy: null }
            : {}),
        },
      });
      if (r.count === 0) throw staleOrNotFound(true);
      const after = await tx.risk.findUniqueOrThrow({ where: { id } });
      // Every change to the residual scores, controls or review date is kept as a review (H4).
      if (
        after.residualLikelihood !== before.residualLikelihood ||
        after.residualImpact !== before.residualImpact ||
        after.controls !== before.controls ||
        after.reviewDate.getTime() !== before.reviewDate.getTime()
      )
        await tx.riskReview.create({
          data: {
            organisationId: after.organisationId,
            riskId: id,
            residualLikelihood: after.residualLikelihood,
            residualImpact: after.residualImpact,
            controls: after.controls,
            note: reason ?? null,
            nextReviewOn: after.reviewDate,
            reviewedBy: hub.user.id,
          },
        });
      await audit(this.db, tx, hub, {
        action: closing ? 'compliance.risk.close' : 'compliance.risk.update',
        entity: 'risk',
        entityId: id,
        summary: { fields: Object.keys(input).join(','), status: input.status ?? before.status },
      });
      return (await riskDtos(tx, [await tx.risk.findUniqueOrThrow({ where: { id } })]))[0]!;
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
    const { reason, effectiveFrom, insuranceExpiresOn, bcpReviewedOn, bcpNextReviewOn, ...input } =
      body(RegistrationInput, raw);
    const dates = {
      ...(insuranceExpiresOn !== undefined
        ? { insuranceExpiresOn: insuranceExpiresOn ? day(insuranceExpiresOn) : null }
        : {}),
      ...(bcpReviewedOn !== undefined
        ? { bcpReviewedOn: bcpReviewedOn ? day(bcpReviewedOn) : null }
        : {}),
      ...(bcpNextReviewOn !== undefined
        ? { bcpNextReviewOn: bcpNextReviewOn ? day(bcpNextReviewOn) : null }
        : {}),
    };
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.registeredManagerUserId) await assertMember(tx, input.registeredManagerUserId);
      for (const k of ['statementOfPurposeItemId', 'insuranceItemId', 'bcpItemId'] as const)
        await this.assertItem(tx, input[k] ?? undefined);
      const orgId = hub.orgId as string;
      const before = await tx.registrationRecord.findUnique({ where: { organisationId: orgId } });
      // Changing the registered manager or nominated individual is a change CQC must hear of.
      const keyChange =
        !!before &&
        ((input.registeredManagerUserId !== undefined &&
          input.registeredManagerUserId !== before.registeredManagerUserId) ||
          (input.nominatedIndividual !== undefined &&
            input.nominatedIndividual !== before.nominatedIndividual));
      const saved = await tx.registrationRecord.upsert({
        where: { organisationId: orgId },
        create: { organisationId: orgId, ...input, ...dates, updatedBy: hub.user.id },
        update: { ...input, ...dates, updatedBy: hub.user.id },
      });
      const changed = [
        ...(Object.keys(input) as (keyof typeof input)[]).filter(
          (k) => (before?.[k] ?? null) !== (saved[k] ?? null),
        ),
        ...(Object.keys(dates) as (keyof typeof dates)[]).filter(
          (k) => (before?.[k]?.getTime() ?? null) !== (saved[k]?.getTime() ?? null),
        ),
      ];
      let notificationDraftId: string | null = null;
      if (keyChange) {
        const on = effectiveFrom ?? londonDate(new Date());
        const n = await tx.cqcNotification.create({
          data: {
            organisationId: orgId,
            code: await nextCode(tx, orgId, 'NTF'),
            kind: 'CHANGE_OF_DETAILS',
            occurredOn: day(on),
            dueOn: day(notificationTargetDate('CHANGE_OF_DETAILS', on)),
            summary:
              'Change of registered manager or nominated individual recorded in the hub. ' +
              'Check the details and submit the statutory notification to CQC.',
            preparedBy: hub.user.id,
          },
        });
        notificationDraftId = n.id;
      }
      await tx.registrationHistory.create({
        data: {
          organisationId: orgId,
          snapshot: {
            providerRef: saved.providerRef,
            registeredManagerUserId: saved.registeredManagerUserId,
            nominatedIndividual: saved.nominatedIndividual,
            conditions: saved.conditions,
            statementOfPurposeItemId: saved.statementOfPurposeItemId,
            insuranceItemId: saved.insuranceItemId,
            bcpItemId: saved.bcpItemId,
            insuranceExpiresOn: iso(saved.insuranceExpiresOn),
            bcpReviewedOn: iso(saved.bcpReviewedOn),
            bcpNextReviewOn: iso(saved.bcpNextReviewOn),
            effectiveFrom: effectiveFrom ?? londonDate(new Date()),
          },
          changedFields: changed,
          reason: reason ?? null,
          changedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.registration.update',
        entity: 'registration_record',
        entityId: orgId,
        summary: { fields: changed.join(','), notificationDraft: !!notificationDraftId },
      });
      return { ...(await this.regDto(tx, orgId)), notificationDraftId };
    });
  }

  /** A registered location's manager, activities and conditions from a date (append-only). */
  @RequirePermission('compliance.registration.manage')
  @Post('registration/locations')
  async saveRegistrationLocation(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(RegistrationLocationInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const orgId = hub.orgId as string;
      if (!(await tx.location.findUnique({ where: { id: input.locationId } }))) throw notFound();
      if (input.registeredManagerUserId) await assertMember(tx, input.registeredManagerUserId);
      const prior = await tx.registrationLocation.findFirst({
        where: { locationId: input.locationId },
        orderBy: [{ effectiveFrom: 'desc' }, { recordedAt: 'desc' }],
      });
      const row = await tx.registrationLocation.create({
        data: {
          organisationId: orgId,
          locationId: input.locationId,
          cqcLocationId: input.cqcLocationId ?? null,
          registeredManagerUserId: input.registeredManagerUserId ?? null,
          managerStartOn: input.managerStartOn ? day(input.managerStartOn) : null,
          activities: input.activities,
          conditions: input.conditions ?? null,
          effectiveFrom: day(input.effectiveFrom),
          reason: input.reason,
          recordedBy: hub.user.id,
        },
      });
      let notificationDraftId: string | null = null;
      if (prior && (input.registeredManagerUserId ?? null) !== prior.registeredManagerUserId) {
        const n = await tx.cqcNotification.create({
          data: {
            organisationId: orgId,
            code: await nextCode(tx, orgId, 'NTF'),
            kind: 'CHANGE_OF_DETAILS',
            occurredOn: day(input.effectiveFrom),
            dueOn: day(notificationTargetDate('CHANGE_OF_DETAILS', input.effectiveFrom)),
            summary:
              'Change of registered manager at a location recorded in the hub. ' +
              'Check the details and submit the statutory notification to CQC.',
            preparedBy: hub.user.id,
          },
        });
        notificationDraftId = n.id;
      }
      await audit(this.db, tx, hub, {
        action: 'compliance.registration.location',
        entity: 'registration_location',
        entityId: row.id,
        summary: { locationId: input.locationId, notificationDraft: !!notificationDraftId },
      });
      return { ...(await this.regDto(tx, orgId)), notificationDraftId };
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
    i: { locationId?: string; linkedEventIds?: string[]; linkedAuditRunIds?: string[] },
  ) {
    if (i.locationId && !(await tx.location.findUnique({ where: { id: i.locationId } })))
      throw notFound();
    if (
      i.linkedAuditRunIds?.length &&
      (await tx.auditRun.count({ where: { id: { in: i.linkedAuditRunIds } } })) !==
        new Set(i.linkedAuditRunIds).size
    )
      throw notFound();
    if (
      i.linkedEventIds?.length &&
      (await tx.event.count({ where: { id: { in: i.linkedEventIds } } })) !==
        new Set(i.linkedEventIds).size
    )
      throw notFound();
  }

  private async isReader(tx: TenantTx, hub: HubRequestContext, d: ReaderGroups): Promise<boolean> {
    const where = readerWhere(d);
    if (!where.OR) return true;
    const n = await tx.membership.count({
      where: { userId: hub.user.id, validTo: null, ...where },
    });
    return n > 0;
  }

  /** Every version that has been published, newest first, up to the current one (for `ackState`). */
  private ackChain(versions: Prisma.PolicyVersionGetPayload<object>[]) {
    const current = versions.find((v) => v.status === 'PUBLISHED') ?? null;
    return versions
      .filter(
        (v) =>
          v.status === 'PUBLISHED' ||
          v.status === 'SUPERSEDED' ||
          (v.status === 'ARCHIVED' && v.publishedAt),
      )
      .filter((v) => !current || v.version <= current.version)
      .map((v) => ({ id: v.id, material: v.material }));
  }

  private async dto(tx: TenantTx, hub: HubRequestContext, id: string): Promise<PolicyDto> {
    const d = await tx.policyDocument.findUniqueOrThrow({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    const current = d.versions.find((v) => v.status === 'PUBLISHED') ?? null;
    const chain = this.ackChain(d.versions);
    const names = await userNames(tx, [
      d.ownerUserId,
      ...d.versions.flatMap((v) => [v.createdBy, v.approvedBy]),
    ]);
    const name = (u: string | null) => (u ? (names.get(u) ?? null) : null);
    const currentReview = iso(current?.reviewDate ?? null);
    const file = current?.evidenceItemId
      ? await tx.evidenceVersion.findFirst({
          where: { itemId: current.evidenceItemId, uploadedAt: { not: null } },
          orderBy: { versionNo: 'desc' },
          select: { id: true },
        })
      : null;
    const acks = await tx.policyAcknowledgement.findMany({
      where: { policyVersionId: { in: chain.map((c) => c.id) } },
    });
    const byUser = new Map<string, Set<string>>();
    for (const a of acks)
      byUser.set(a.userId, (byUser.get(a.userId) ?? new Set()).add(a.policyVersionId));
    const members = await tx.membership.findMany({
      where: { validTo: null, user: { status: 'ACTIVE' }, ...readerWhere(d) },
      select: { userId: true },
      distinct: ['userId'],
    });
    const okStates = new Set(['CURRENT', 'CARRIED_FORWARD']);
    const acknowledged = current
      ? members.filter((m) => okStates.has(ackState(chain, byUser.get(m.userId) ?? new Set())))
          .length
      : 0;
    const reader = await this.isReader(tx, hub, d);
    return {
      id: d.id,
      code: d.code,
      title: d.title,
      category: d.category,
      ownerUserId: d.ownerUserId,
      ownerName: name(d.ownerUserId),
      readerRoles: d.readerRoles,
      readerLocationIds: d.readerLocationIds,
      readerEveryone: d.readerEveryone,
      currentVersion: current
        ? {
            id: current.id,
            version: current.version,
            effectiveFrom: iso(current.effectiveFrom),
            reviewDate: currentReview,
            reviewOverdue: !!currentReview && isOverdue(currentReview, new Date()),
            material: current.material,
            evidenceItemId: current.evidenceItemId,
            documentEvidenceVersionId: file?.id ?? null,
          }
        : null,
      versions: d.versions.map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        summary: v.summary,
        material: v.material,
        evidenceItemId: v.evidenceItemId,
        reviewDate: iso(v.reviewDate),
        effectiveFrom: iso(v.effectiveFrom),
        createdBy: v.createdBy,
        createdByName: name(v.createdBy),
        approvedBy: v.approvedBy,
        approvedByName: name(v.approvedBy),
        approvedAt: v.approvedAt?.toISOString() ?? null,
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
    const today = day(londonDate(new Date()));
    const entries = await tx.registrationLocation.findMany({
      where: { effectiveFrom: { lte: today } },
      orderBy: [{ effectiveFrom: 'desc' }, { recordedAt: 'desc' }],
    });
    const current = [...new Map(entries.reverse().map((e) => [e.locationId, e])).values()];
    const locs = await tx.location.findMany({
      where: { id: { in: current.map((e) => e.locationId) } },
      select: { id: true, name: true },
    });
    const names = await userNames(tx, [
      ...current.map((e) => e.registeredManagerUserId),
      ...current.map((e) => e.recordedBy),
    ]);
    return {
      insuranceExpiresOn: iso(r?.insuranceExpiresOn ?? null),
      bcpReviewedOn: iso(r?.bcpReviewedOn ?? null),
      bcpNextReviewOn: iso(r?.bcpNextReviewOn ?? null),
      locations: current.map((e) => ({
        id: e.id,
        locationId: e.locationId,
        locationName: locs.find((l) => l.id === e.locationId)?.name ?? null,
        cqcLocationId: e.cqcLocationId,
        registeredManagerUserId: e.registeredManagerUserId,
        registeredManagerName: e.registeredManagerUserId
          ? (names.get(e.registeredManagerUserId) ?? null)
          : null,
        managerStartOn: iso(e.managerStartOn),
        activities: e.activities,
        conditions: e.conditions,
        effectiveFrom: iso(e.effectiveFrom) as string,
        reason: e.reason,
        recordedByName: names.get(e.recordedBy) ?? null,
        recordedAt: e.recordedAt.toISOString(),
      })),
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

type RiskRow = Prisma.RiskGetPayload<object>;
type RiskCtx = {
  names: Map<string, string>;
  events: Map<string, { id: string; code: string; title: string }>;
  open: Map<string, number>;
  reviews: Prisma.RiskReviewGetPayload<object>[];
};

async function riskDtos(tx: TenantTx, rows: RiskRow[], now = new Date()) {
  const ids = rows.map((r) => r.id);
  const [events, open, reviews] = await Promise.all([
    tx.event.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => r.linkedEventIds))] } },
      select: { id: true, code: true, title: true },
    }),
    tx.action.groupBy({
      by: ['sourceId'],
      where: { sourceType: 'RISK', sourceId: { in: ids }, status: { not: 'VERIFIED' } },
      _count: { _all: true },
    }),
    tx.riskReview.findMany({ where: { riskId: { in: ids } }, orderBy: { reviewedAt: 'desc' } }),
  ]);
  const names = await userNames(tx, [
    ...rows.map((r) => r.ownerUserId),
    ...reviews.map((v) => v.reviewedBy),
  ]);
  const ctx: RiskCtx = {
    names,
    events: new Map(events.map((e) => [e.id, e])),
    open: new Map(open.map((o) => [o.sourceId, o._count._all])),
    reviews,
  };
  return rows.map((r) => riskDto(r, now, ctx));
}

function riskDto(r: RiskRow, now: Date, ctx: RiskCtx) {
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
    ownerName: ctx.names.get(r.ownerUserId) ?? null,
    reviewDate: iso(r.reviewDate) as string,
    reviewOverdue: r.status === 'OPEN' && isOverdue(iso(r.reviewDate) as string, now),
    locationId: r.locationId,
    status: r.status,
    linkedEventIds: r.linkedEventIds,
    linkedEvents: r.linkedEventIds.flatMap((id) => {
      const e = ctx.events.get(id);
      return e ? [e] : [];
    }),
    openActions: ctx.open.get(r.id) ?? 0,
    title: r.title,
    category: r.category,
    bandText: riskBandText(r.residualLikelihood, r.residualImpact),
    linkedAuditRunIds: r.linkedAuditRunIds,
    closedReason: r.closedReason,
    closedAt: r.closedAt?.toISOString() ?? null,
    reviews: ctx.reviews
      .filter((v) => v.riskId === r.id)
      .map((v) => ({
        residualScore: riskRating(v.residualLikelihood, v.residualImpact).score,
        bandText: riskBandText(v.residualLikelihood, v.residualImpact),
        note: v.note ?? '',
        byName: ctx.names.get(v.reviewedBy) ?? null,
        at: v.reviewedAt.toISOString(),
      })),
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
