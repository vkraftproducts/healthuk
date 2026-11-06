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
} from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { ensureRetentionDefaults, nextCode, retentionCandidates } from '@hub/domain';
import {
  BreachAnswers,
  BreachAssessment,
  BreachClose,
  BreachContainment,
  BreachIcoReport,
  BreachInput,
  DISCLOSURE_METHODS,
  DisclosureInput,
  DisclosureQuery,
  DpComplaintAcknowledge,
  DpComplaintInput,
  DpComplaintResolve,
  LegalHoldInput,
  LegalHoldRelease,
  RetentionDecisionInput,
  RetentionLogQuery,
  RetentionReviewInput,
  RetentionRulePatch,
  SubjectRequestInput,
  SubjectRequestUpdate,
  draftDpAcknowledgement,
  type BreachDto,
  type DpComplaintDto,
  type ExportDto,
  type LegalHoldDto,
  type RetentionReviewDto,
  type RetentionRuleDto,
  type SubjectRequestDto,
} from '@hub/contracts';
import {
  addDays,
  breachClock,
  formatDate,
  identityPauseDays,
  londonDate,
  londonDateTime,
  retentionCutoff,
  subjectRequestDue,
  subjectRequestEffectiveDue,
  subjectRequestLatestExtension,
  suggestBreachRisk,
  type RetentionCategory,
} from '@hub/rules';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

type Names = Map<string, string>;
const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const P = 'privacy.manage';
const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

/**
 * Data protection workflows (SECURITY_COMPLIANCE §4): retention schedule with approval and dry
 * run, legal holds, data subject requests with the one-month clock, disclosure log and personal
 * data breach records with the 72-hour ICO clock. Everything here is audited.
 */
@Controller()
export class PrivacyController {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- retention ---------------------------------------------------------------------------
  @RequirePermission(P)
  @Get('retention-rules')
  async rules(@Hub() hub: HubRequestContext): Promise<{ data: RetentionRuleDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await ensureRetentionDefaults(tx, hub.orgId as string);
      const rules = await tx.retentionRule.findMany({ orderBy: { category: 'asc' } });
      const now = new Date();
      const names = await userNames(
        tx,
        rules.flatMap((r) => [r.approvedBy, r.changedBy]),
      );
      return { data: await Promise.all(rules.map((r) => this.ruleDto(tx, r, now, names))) };
    });
  }

  @RequirePermission(P)
  @Patch('retention-rules/:id')
  async patchRule(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    const input = body(RetentionRulePatch, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.retentionRule.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (input.action === 'ANONYMISE' && r.category !== 'PATIENT_CONTACT')
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Only patient contact details can be anonymised automatically',
        );
      const u = await tx.retentionRule.update({
        where: { id },
        data: {
          ...input,
          status: 'REQUIRES_APPROVAL',
          approvedBy: null,
          approvedAt: null,
          changedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.retention.change',
        entity: 'retention_rule',
        entityId: id,
        summary: { category: r.category, ...input },
      });
      return this.ruleDto(tx, u, new Date());
    });
  }

  @RequirePermission(P)
  @Post('retention-rules/:id/approve')
  async approveRule(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.retentionRule.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status === 'APPROVED') throw new HubError('CONFLICT', 409, 'Already approved');
      if (r.changedBy === hub.user.id)
        throw new HubError(
          'FOUR_EYES_REQUIRED',
          422,
          'Someone other than the person who changed the rule must approve it',
        );
      if (r.basis.startsWith('Placeholder'))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Record the basis from your approved schedule before approving',
        );
      const u = await tx.retentionRule.update({
        where: { id },
        data: { status: 'APPROVED', approvedBy: hub.user.id, approvedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.retention.approve',
        entity: 'retention_rule',
        entityId: id,
        summary: { category: r.category, months: r.retainMonths, action: r.action },
      });
      return this.ruleDto(tx, u, new Date());
    });
  }

  @RequirePermission(P)
  @Get('retention-log')
  async log(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(RetentionLogQuery, q);
    const runAt = {
      ...(f.from ? { gte: londonDateTime(f.from, '00:00') } : {}),
      ...(f.to ? { lt: londonDateTime(addDays(f.to, 1), '00:00') } : {}),
    };
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.retentionLog.findMany({
        where: {
          ...(f.category ? { category: f.category } : {}),
          ...(f.from || f.to ? { runAt } : {}),
        },
        orderBy: { runAt: 'desc' },
        take: 200,
      }),
    );
    return {
      data: rows.map((r) => ({
        ...r,
        cutoff: d(r.cutoff)!,
        runAt: r.runAt.toISOString(),
        organisationId: undefined,
        ruleId: undefined,
      })),
    };
  }

  // ---- legal holds -------------------------------------------------------------------------
  // ---- K4: monthly retention reviews ----------------------------------------------------------
  @RequirePermission(P)
  @Get('retention-reviews')
  async reviews(@Hub() hub: HubRequestContext): Promise<{ data: RetentionReviewDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.retentionReview.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
      return { data: await reviewDtos(tx, rows) };
    });
  }

  /** Opens this month's review for one approved rule, with the dry-run counts frozen in. */
  @RequirePermission(P)
  @Post('retention-reviews')
  async openReview(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<RetentionReviewDto> {
    const { ruleId } = body(RetentionReviewInput, raw);
    const now = new Date();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rule = await tx.retentionRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw notFound();
      if (rule.status !== 'APPROVED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Only an approved retention rule can be reviewed',
        );
      const period = londonDate(now).slice(0, 7);
      if (await tx.retentionReview.findFirst({ where: { ruleId, period } }))
        throw new HubError('CONFLICT', 409, 'This month’s review for this rule is already open');
      const cutoff = retentionCutoff(now, rule.retainMonths);
      const c = await retentionCandidates(tx, rule.category as RetentionCategory, cutoff);
      const r = await tx.retentionReview.create({
        data: {
          organisationId: hub.orgId as string,
          ruleId,
          period,
          cutoff: startOfLondonDayUtc(cutoff),
          candidates: c.candidates,
          held: c.held,
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.retention.review_open',
        entity: 'retention_review',
        entityId: r.id,
        summary: { category: rule.category, period, candidates: c.candidates, held: c.held },
      });
      return (await reviewDtos(tx, [r]))[0]!;
    });
  }

  /** Keep (with a reason and a date to look again) or act. Decisions are never edited. */
  @RequirePermission(P)
  @Post('retention-reviews/:id/decisions')
  async decide(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<RetentionReviewDto> {
    const input = body(RetentionDecisionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.retentionReview.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'This review is closed');
      if (input.recordType === 'BATCH' && input.recordId !== id)
        throw new HubError('VALIDATION_FAILED', 400, 'A batch decision is for this review');
      if (input.keepUntil && input.keepUntil <= londonDate(new Date()))
        throw new HubError('VALIDATION_FAILED', 400, 'Choose a future date to look again');
      const exists = await tx.retentionDecision.findFirst({
        where: { reviewId: id, recordType: input.recordType, recordId: input.recordId },
      });
      if (exists) throw new HubError('CONFLICT', 409, 'A decision has already been recorded');
      const x = await tx.retentionDecision.create({
        data: {
          organisationId: hub.orgId as string,
          reviewId: id,
          recordType: input.recordType,
          recordId: input.recordId,
          decision: input.decision,
          reason: input.reason ?? null,
          keepUntil: input.keepUntil ? startOfLondonDayUtc(input.keepUntil) : null,
          decidedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.retention.decide',
        entity: 'retention_review',
        entityId: id,
        summary: {
          decisionId: x.id,
          recordType: x.recordType,
          decision: x.decision,
          reason: x.reason,
          keepUntil: input.keepUntil ?? null,
        },
      });
      return (await reviewDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(P)
  @Post('retention-reviews/:id/close')
  async closeReview(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<RetentionReviewDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.retentionReview.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'Already closed');
      const decided = await tx.retentionDecision.count({ where: { reviewId: id } });
      if (r.candidates > 0 && decided === 0)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record a decision (keep or act) before closing the review',
        );
      const u = await tx.retentionReview.update({
        where: { id },
        data: { status: 'CLOSED', closedBy: hub.user.id, closedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.retention.review_close',
        entity: 'retention_review',
        entityId: id,
        summary: { decisions: decided },
      });
      return (await reviewDtos(tx, [u]))[0]!;
    });
  }

  @RequirePermission(P)
  @Get('legal-holds')
  async holds(@Hub() hub: HubRequestContext): Promise<{ data: LegalHoldDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.legalHold.findMany({ orderBy: { placedAt: 'desc' } });
      const names = await userNames(
        tx,
        rows.map((h) => h.placedBy),
      );
      return { data: rows.map((h) => holdDto(h, names)) };
    });
  }

  @RequirePermission(P)
  @Post('legal-holds')
  async hold(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<LegalHoldDto> {
    const input = body(LegalHoldInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.scopeId && !(await scopeExists(tx, input.scopeType, input.scopeId)))
        throw notFound();
      const h = await tx.legalHold.create({
        data: {
          organisationId: hub.orgId as string,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          reason: input.reason,
          placedBy: hub.user.id,
          rangeFrom: input.rangeFrom ? startOfLondonDayUtc(input.rangeFrom) : null,
          rangeTo: input.rangeTo ? startOfLondonDayUtc(input.rangeTo) : null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.hold.place',
        entity: 'legal_hold',
        entityId: h.id,
        summary: {
          scope: input.scopeType,
          rangeFrom: input.rangeFrom ?? null,
          rangeTo: input.rangeTo ?? null,
        },
      });
      return holdDto(h, await userNames(tx, [h.placedBy]));
    });
  }

  @RequirePermission(P)
  @Post('legal-holds/:id/release')
  async release(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<LegalHoldDto> {
    const input = body(LegalHoldRelease, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const h = await tx.legalHold.findUnique({ where: { id } });
      if (!h) throw notFound();
      if (h.releasedAt) throw new HubError('CONFLICT', 409, 'This hold has already been released');
      const u = await tx.legalHold.update({
        where: { id },
        data: { releasedAt: new Date(), releasedBy: hub.user.id, releaseReason: input.reason },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.hold.release',
        entity: 'legal_hold',
        entityId: id,
      });
      return holdDto(u, await userNames(tx, [u.placedBy]));
    });
  }

  // ---- data subject requests -----------------------------------------------------------------
  @RequirePermission(P)
  @Get('subject-requests')
  async requests(@Hub() hub: HubRequestContext): Promise<{ data: SubjectRequestDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.subjectRequest.findMany({ orderBy: { dueOn: 'asc' } });
      return { data: await dsrDtos(tx, rows) };
    });
  }

  @RequirePermission(P)
  @Post('subject-requests')
  async request(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<SubjectRequestDto> {
    const input = body(SubjectRequestInput, raw);
    const now = new Date();
    if (input.receivedOn > londonDate(now))
      throw new HubError('VALIDATION_FAILED', 400, 'The received date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (
        input.staffId &&
        !(await tx.staff.findUnique({ where: { id: input.staffId }, select: { id: true } }))
      )
        throw notFound();
      const r = await tx.subjectRequest.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'DSR'),
          type: input.type,
          subjectType: input.subjectType,
          staffId: input.subjectType === 'STAFF' ? input.staffId! : null,
          patientRef: input.subjectType === 'PATIENT' ? input.patientRef! : null,
          description: input.description,
          receivedOn: startOfLondonDayUtc(input.receivedOn),
          dueOn: startOfLondonDayUtc(subjectRequestDue(input.receivedOn)),
          handledBy: hub.user.id,
        },
      });
      // Codes and types only in the audit trail: the description can name people.
      await audit(this.db, tx, hub, {
        action: 'privacy.dsr.create',
        entity: 'subject_request',
        entityId: r.id,
        summary: { type: r.type, subjectType: r.subjectType },
      });
      return (await dsrDtos(tx, [r]))[0]!;
    });
  }

  @RequirePermission(P)
  @Post('subject-requests/:id/update')
  async updateRequest(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SubjectRequestDto> {
    const input = body(SubjectRequestUpdate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.subjectRequest.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.status === 'COMPLETED' || r.status === 'REFUSED')
        throw new HubError('CONFLICT', 409, 'This request is closed');
      if (
        r.status === 'RECEIVED' &&
        (input.status === 'IN_PROGRESS' || input.status === 'COMPLETED')
      )
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Verify the requester’s identity before working on or completing the request',
        );
      if (input.status === 'IDENTITY_VERIFIED' && r.status !== 'RECEIVED')
        throw new HubError('CONFLICT', 409, 'Identity has already been verified');
      const today = londonDate(new Date());
      if (input.identityRequestedOn) {
        if (r.status !== 'RECEIVED')
          throw new HubError('CONFLICT', 409, 'Identity has already been verified');
        if (input.identityRequestedOn < d(r.receivedOn)! || input.identityRequestedOn > today)
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            'The date identity was asked for must be on or after receipt and not in the future',
          );
      }
      const requestedOn = input.identityRequestedOn ?? d(r.identityRequestedOn);
      const verifiedOn =
        input.status === 'IDENTITY_VERIFIED' ? (input.identityVerifiedOn ?? today) : null;
      if (verifiedOn && (verifiedOn > today || (requestedOn && verifiedOn < requestedOn)))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The date identity was confirmed must be after it was asked for and not in the future',
        );
      if (input.extendedTo) {
        const latest = subjectRequestLatestExtension(d(r.receivedOn)!);
        if (input.extendedTo > latest || input.extendedTo <= d(r.dueOn)!)
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            `An extension must be after the due date and no later than ${latest}`,
          );
      }
      const closing = input.status === 'COMPLETED' || input.status === 'REFUSED';
      const u = await tx.subjectRequest.update({
        where: { id },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
          ...(input.extendedTo ? { extendedTo: startOfLondonDayUtc(input.extendedTo) } : {}),
          ...(closing ? { completedAt: new Date() } : {}),
          ...(input.identityRequestedOn
            ? { identityRequestedOn: startOfLondonDayUtc(input.identityRequestedOn) }
            : {}),
          ...(verifiedOn
            ? {
                identityVerifiedOn: startOfLondonDayUtc(verifiedOn),
                pausedDays: identityPauseDays(requestedOn, verifiedOn),
              }
            : {}),
          ...(input.status === 'REFUSED' ? { exemption: input.exemption ?? null } : {}),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.dsr.update',
        entity: 'subject_request',
        entityId: id,
        summary: {
          status: input.status ?? r.status,
          extended: !!input.extendedTo,
          identityRequested: !!input.identityRequestedOn,
          pausedDays: verifiedOn ? identityPauseDays(requestedOn, verifiedOn) : r.pausedDays,
        },
      });
      return (await dsrDtos(tx, [u]))[0]!;
    });
  }

  /** K2: where a staff member's data is held, so nothing is missed when gathering it. */
  @RequirePermission(P)
  @Get('subject-requests/:id/sources')
  async sources(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string) {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.subjectRequest.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.subjectType !== 'STAFF' || !r.staffId)
        return {
          sources: [],
          note:
            r.subjectType === 'PATIENT'
              ? 'Search job and patient records by the patient reference. Patient details are ' +
                'never copied into this request.'
              : 'Gather this person’s information manually and list what was searched.',
        };
      const staffId = r.staffId;
      const [records, roles, lifecycle, requirements, restrictions, events] = await Promise.all([
        tx.staffRecord.groupBy({ by: ['kind'], where: { staffId }, _count: { _all: true } }),
        tx.staffRoleApproval.count({ where: { staffId } }),
        tx.staffLifecycleEvent.count({ where: { staffId } }),
        tx.requirementInstance.count({ where: { subjectType: 'STAFF', subjectId: staffId } }),
        tx.staffRestriction.count({ where: { staffId } }),
        tx.auditLog.count({ where: { entity: 'staff', entityId: staffId } }),
      ]);
      return {
        sources: [
          ...records.map((g) => ({
            label: `Staff records: ${g.kind.toLowerCase().replace(/_/g, ' ')}`,
            count: g._count._all,
          })),
          { label: 'Role approvals', count: roles },
          { label: 'Joining, leaving and status changes', count: lifecycle },
          { label: 'Compliance requirements', count: requirements },
          { label: 'Restrictions', count: restrictions },
          { label: 'Audit entries about the staff record', count: events },
        ],
        note:
          'The access request export gathers these. Also check email, shared drives and paper ' +
          'files, and record what was searched in the outcome.',
      };
    });
  }

  @RequirePermission(P, 'reports.export')
  @Post('subject-requests/:id/export')
  async sarExport(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<ExportDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = await tx.subjectRequest.findUnique({ where: { id } });
      if (!r) throw notFound();
      if (r.type !== 'ACCESS')
        throw new HubError('VALIDATION_FAILED', 400, 'Exports are for access requests');
      if (r.status === 'RECEIVED')
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Verify the requester’s identity first');
      if (r.subjectType === 'OTHER')
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Gather other data subjects’ information manually',
        );
      const j = await tx.exportJob.create({
        data: {
          organisationId: hub.orgId as string,
          kind: 'SAR',
          params: { requestId: id } as Prisma.InputJsonObject,
          requestedBy: hub.user.id,
          requesterPermissions: [...hub.permissions],
        },
      });
      await tx.subjectRequest.update({ where: { id }, data: { exportJobId: j.id } });
      await audit(this.db, tx, hub, {
        action: 'privacy.dsr.export',
        entity: 'subject_request',
        entityId: id,
        summary: { exportJobId: j.id },
      });
      return {
        id: j.id,
        kind: j.kind,
        status: j.status,
        bytes: null,
        error: null,
        createdAt: j.createdAt.toISOString(),
        finishedAt: null,
        download: null,
      };
    });
  }

  // ---- disclosure log ----------------------------------------------------------------------------
  @RequirePermission(P)
  @Get('disclosures')
  async disclosures(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(DisclosureQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const words = f.q
        ? {
            OR: (['disclosedTo', 'purpose', 'subjectDescription', 'requestedBy'] as const).map(
              (k) => ({ [k]: { contains: f.q, mode: 'insensitive' as const } }),
            ),
          }
        : {};
      const rows = await tx.disclosure.findMany({
        where: {
          ...words,
          ...(f.from || f.to
            ? {
                disclosedOn: {
                  ...(f.from ? { gte: startOfLondonDayUtc(f.from) } : {}),
                  ...(f.to ? { lte: startOfLondonDayUtc(f.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ disclosedOn: 'desc' }, { recordedAt: 'desc' }],
        take: 500,
      });
      return { data: await this.discDtos(tx, rows) };
    });
  }

  private async discDtos(tx: TenantTx, rows: Prisma.DisclosureGetPayload<object>[]) {
    const names = await userNames(
      tx,
      rows.flatMap((r) => [r.recordedBy, r.approvedBy]),
    );
    const requestIds = [...new Set(rows.flatMap((r) => r.subjectRequestId ?? []))];
    const requests = requestIds.length
      ? await tx.subjectRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, code: true },
        })
      : [];
    const codes = new Map(requests.map((r) => [r.id, r.code]));
    return rows.map((r) => ({
      ...discDto(r),
      subjectRequestCode: r.subjectRequestId ? (codes.get(r.subjectRequestId) ?? null) : null,
      recordedByName: names.get(r.recordedBy) ?? null,
      approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
    }));
  }

  @RequirePermission(P)
  @Post('disclosures')
  async disclose(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(DisclosureInput, raw);
    if (input.disclosedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The disclosure date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (
        input.subjectRequestId &&
        !(await tx.subjectRequest.findUnique({ where: { id: input.subjectRequestId } }))
      )
        throw notFound();
      // K5: the approver is another current member; nobody approves their own disclosure.
      if (input.approvedBy === hub.user.id)
        throw new HubError(
          'SELF_APPROVAL',
          422,
          'Another person must approve a disclosure you record',
        );
      if (
        input.approvedBy &&
        !(await tx.membership.count({
          where: {
            userId: input.approvedBy,
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
          },
        }))
      )
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The approver is not a current member of this organisation',
        );
      const x = await tx.disclosure.create({
        data: {
          ...input,
          subjectRequestId: input.subjectRequestId ?? null,
          subjectDescription: input.subjectDescription ?? null,
          requestedBy: input.requestedBy ?? null,
          approvedBy: input.approvedBy ?? null,
          method: input.method ?? null,
          organisationId: hub.orgId as string,
          disclosedOn: startOfLondonDayUtc(input.disclosedOn),
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.disclosure.record',
        entity: 'disclosure',
        entityId: x.id,
        summary: { approvedBy: x.approvedBy, method: x.method },
      });
      return (await this.discDtos(tx, [x]))[0]!;
    });
  }

  // ---- breaches ----------------------------------------------------------------------------------
  @RequirePermission(P)
  @Get('breaches')
  async breaches(@Hub() hub: HubRequestContext): Promise<{ data: BreachDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.breachRecord.findMany({ orderBy: { discoveredAt: 'desc' } });
      return { data: await breachDtos(tx, rows) };
    });
  }

  @RequirePermission(P)
  @Post('breaches')
  async breach(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<BreachDto> {
    const input = body(BreachInput, raw);
    const now = new Date();
    const discovered = new Date(input.discoveredAt);
    if (discovered.getTime() > now.getTime() + 5 * 60_000)
      throw new HubError('VALIDATION_FAILED', 400, 'The discovery time is in the future');
    if (input.occurredAt && new Date(input.occurredAt) > discovered)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'It cannot have occurred after it was discovered',
      );
    if (input.containedAt) assertContained(input.containedAt, input.occurredAt ?? null, now);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.breachRecord.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'BRE'),
          title: input.title,
          description: input.description,
          discoveredAt: discovered,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
          dataCategories: input.dataCategories,
          subjectsEstimate: input.subjectsEstimate ?? null,
          containment: input.containment ?? null,
          containedAt: input.containedAt ? new Date(input.containedAt) : null,
          peopleAffected: input.peopleAffected ?? null,
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.breach.record',
        entity: 'breach_record',
        entityId: b.id,
      });
      const saved = await tx.breachRecord.findUniqueOrThrow({ where: { id: b.id } });
      return (await breachDtos(tx, [saved], now))[0]!;
    });
  }

  @RequirePermission(P)
  @Post('breaches/:id/assessment')
  async assess(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<BreachDto> {
    const { answers, ...input } = body(BreachAssessment, raw);
    return this.breachStep(hub, id, 'privacy.breach.assess', (b) => {
      if (b.status === 'REPORTED' || b.status === 'CLOSED')
        throw new HubError('CONFLICT', 409, 'Already reported or closed');
      return {
        ...input,
        ...(answers ? { assessment: answers as Prisma.InputJsonObject } : {}),
        decidedBy: hub.user.id,
        decidedAt: new Date(),
        status: 'ASSESSED',
      };
    });
  }

  /** K1: record how it was stopped and when. Allowed until the breach is closed. */
  @RequirePermission(P)
  @Post('breaches/:id/containment')
  async contain(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<BreachDto> {
    const input = body(BreachContainment, raw);
    return this.breachStep(hub, id, 'privacy.breach.contain', (b) => {
      if (b.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'This breach is closed');
      assertContained(input.containedAt, b.occurredAt?.toISOString() ?? null, new Date());
      return {
        containment: input.containment,
        containedAt: new Date(input.containedAt),
        ...(input.peopleAffected !== undefined ? { peopleAffected: input.peopleAffected } : {}),
      };
    });
  }

  @RequirePermission(P)
  @Post('breaches/:id/ico-report')
  async report(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<BreachDto> {
    const input = body(BreachIcoReport, raw);
    return this.breachStep(hub, id, 'privacy.breach.ico_report', (b) => {
      if (!b.icoReportable)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the assessment that it is reportable first',
        );
      const at = new Date(input.reportedAt);
      if (at < b.discoveredAt || at.getTime() > Date.now() + 5 * 60_000)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The report time must be after discovery and not in the future',
        );
      if (at.getTime() > b.discoveredAt.getTime() + 72 * 3_600_000 && !input.lateReason)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Reported after 72 hours: give the reasons for the delay',
        );
      return {
        icoReportedAt: at,
        icoReference: input.reference,
        lateReason: input.lateReason ?? null,
        subjectsNotifiedAt: input.subjectsNotifiedAt ? new Date(input.subjectsNotifiedAt) : null,
        status: 'REPORTED',
      };
    });
  }

  @RequirePermission(P)
  @Post('breaches/:id/close')
  async close(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<BreachDto> {
    const input = body(BreachClose, raw ?? {});
    return this.breachStep(hub, id, 'privacy.breach.close', (b) => {
      if (b.status === 'CLOSED') throw new HubError('CONFLICT', 409, 'Already closed');
      if (b.icoReportable === null)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the reportability decision first',
        );
      if (b.icoReportable && !b.icoReportedAt)
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Record the ICO report first');
      if (!b.containedAt)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record when the breach was contained first',
        );
      if (!input.lessons)
        throw new HubError('VALIDATION_FAILED', 400, 'Record the lessons learned before closing');
      return {
        status: 'CLOSED',
        lessons: input.lessons,
        closedBy: hub.user.id,
        closedAt: new Date(),
      };
    });
  }

  // ---- data protection complaints ----------------------------------------------------------------
  @RequirePermission(P)
  @Get('dp-complaints')
  async complaints(@Hub() hub: HubRequestContext): Promise<{ data: DpComplaintDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.dpComplaint.findMany({
        orderBy: [{ status: 'asc' }, { acknowledgeDue: 'asc' }],
      });
      return { data: await complaintDtos(tx, rows) };
    });
  }

  @RequirePermission(P)
  @Post('dp-complaints')
  async complaint(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<DpComplaintDto> {
    const input = body(DpComplaintInput, raw);
    if (input.receivedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The received date is in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (!(await tx.membership.count({ where: { userId: input.ownerUserId } })))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The owner is not a member of this organisation',
        );
      if (
        input.subjectRequestId &&
        !(await tx.subjectRequest.count({ where: { id: input.subjectRequestId } }))
      )
        throw notFound();
      if (input.breachId && !(await tx.breachRecord.count({ where: { id: input.breachId } })))
        throw notFound();
      const c = await tx.dpComplaint.create({
        data: {
          organisationId: hub.orgId as string,
          code: await nextCode(tx, hub.orgId as string, 'DPC'),
          source: input.source,
          summary: input.summary,
          receivedOn: startOfLondonDayUtc(input.receivedOn),
          acknowledgeDue: startOfLondonDayUtc(addDays(input.receivedOn, 30)),
          ownerUserId: input.ownerUserId,
          subjectRequestId: input.subjectRequestId ?? null,
          breachId: input.breachId ?? null,
          icoCaseRef: input.icoCaseRef ?? null,
          recordedBy: hub.user.id,
        },
      });
      // Codes only in the audit trail: the summary can describe people.
      await audit(this.db, tx, hub, {
        action: 'privacy.complaint.record',
        entity: 'dp_complaint',
        entityId: c.id,
        summary: { source: c.source },
      });
      return (await complaintDtos(tx, [c]))[0]!;
    });
  }

  @RequirePermission(P)
  @Post('dp-complaints/:id/acknowledge')
  async acknowledgeComplaint(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<DpComplaintDto> {
    const input = body(DpComplaintAcknowledge, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.dpComplaint.findUnique({ where: { id } });
      if (!c) throw notFound();
      if (c.status !== 'RECEIVED')
        throw new HubError('CONFLICT', 409, 'This complaint has already been acknowledged');
      if (input.acknowledgedOn < d(c.receivedOn)! || input.acknowledgedOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The acknowledgement date must be on or after receipt and not in the future',
        );
      const u = await tx.dpComplaint.update({
        where: { id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedOn: startOfLondonDayUtc(input.acknowledgedOn),
          draftAcknowledgement: input.text ?? null,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.complaint.acknowledge',
        entity: 'dp_complaint',
        entityId: id,
        summary: { late: input.acknowledgedOn > d(c.acknowledgeDue)! },
      });
      return (await complaintDtos(tx, [u]))[0]!;
    });
  }

  @RequirePermission(P)
  @Post('dp-complaints/:id/resolve')
  async resolveComplaint(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<DpComplaintDto> {
    const input = body(DpComplaintResolve, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const c = await tx.dpComplaint.findUnique({ where: { id } });
      if (!c) throw notFound();
      if (c.status === 'RESOLVED') throw new HubError('CONFLICT', 409, 'Already resolved');
      if (c.status === 'RECEIVED')
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the acknowledgement before the outcome',
        );
      if (input.resolvedOn < d(c.acknowledgedOn)! || input.resolvedOn > londonDate(new Date()))
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'The outcome date must be on or after the acknowledgement and not in the future',
        );
      const u = await tx.dpComplaint.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          outcome: input.outcome,
          resolvedOn: startOfLondonDayUtc(input.resolvedOn),
          resolvedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.complaint.resolve',
        entity: 'dp_complaint',
        entityId: id,
      });
      return (await complaintDtos(tx, [u]))[0]!;
    });
  }

  // ---- helpers -----------------------------------------------------------------------------
  private breachStep(
    hub: HubRequestContext,
    id: string,
    action: string,
    change: (b: Prisma.BreachRecordGetPayload<object>) => Prisma.BreachRecordUpdateInput,
  ): Promise<BreachDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const b = await tx.breachRecord.findUnique({ where: { id } });
      if (!b) throw notFound();
      const u = await tx.breachRecord.update({ where: { id }, data: change(b) });
      await audit(this.db, tx, hub, {
        action,
        entity: 'breach_record',
        entityId: id,
        summary: { status: u.status },
      });
      return (await breachDtos(tx, [u]))[0]!;
    });
  }

  private async ruleDto(
    tx: TenantTx,
    r: Prisma.RetentionRuleGetPayload<object>,
    now: Date,
    known?: Names,
  ): Promise<RetentionRuleDto> {
    const cutoff = retentionCutoff(now, r.retainMonths);
    const c = await retentionCandidates(tx, r.category as RetentionCategory, cutoff);
    const names = known ?? (await userNames(tx, [r.approvedBy, r.changedBy]));
    return {
      id: r.id,
      category: r.category as RetentionRuleDto['category'],
      retainMonths: r.retainMonths,
      triggerDesc: r.triggerDesc,
      basis: r.basis,
      action: r.action as RetentionRuleDto['action'],
      status: r.status as RetentionRuleDto['status'],
      approvedBy: r.approvedBy,
      approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      changedBy: r.changedBy,
      changedByName: r.changedBy ? (names.get(r.changedBy) ?? null) : null,
      version: r.version,
      ...c,
      cutoff,
    };
  }
}

/** Date-only columns are stored as the London date (midnight UTC of that date). */
const startOfLondonDayUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function scopeExists(tx: TenantTx, type: string, id: string): Promise<boolean> {
  const sel = { where: { id }, select: { id: true } };
  if (type === 'STAFF') return !!(await tx.staff.findUnique(sel));
  if (type === 'JOB') return !!(await tx.job.findUnique(sel));
  if (type === 'EVENT') return !!(await tx.event.findUnique(sel));
  if (type === 'VEHICLE') return !!(await tx.vehicle.findUnique(sel));
  return false;
}

function holdDto(h: Prisma.LegalHoldGetPayload<object>, names: Names): LegalHoldDto {
  return {
    id: h.id,
    scopeType: h.scopeType,
    scopeId: h.scopeId,
    reason: h.reason,
    placedBy: h.placedBy,
    placedByName: names.get(h.placedBy) ?? null,
    placedAt: h.placedAt.toISOString(),
    releasedAt: h.releasedAt?.toISOString() ?? null,
    releaseReason: h.releaseReason,
    rangeFrom: d(h.rangeFrom),
    rangeTo: d(h.rangeTo),
  };
}

type ReviewRow = Prisma.RetentionReviewGetPayload<object>;
async function reviewDtos(tx: TenantTx, rows: ReviewRow[]): Promise<RetentionReviewDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [rules, decisions] = await Promise.all([
    tx.retentionRule.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.ruleId))] } },
      select: { id: true, category: true },
    }),
    tx.retentionDecision.findMany({
      where: { reviewId: { in: ids } },
      orderBy: { decidedAt: 'asc' },
    }),
  ]);
  const names = await userNames(tx, [
    ...rows.flatMap((r) => [r.createdBy, r.closedBy]),
    ...decisions.map((x) => x.decidedBy),
  ]);
  const category = new Map(rules.map((r) => [r.id, r.category]));
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.ruleId,
    category: category.get(r.ruleId) ?? 'Unknown',
    period: r.period,
    cutoff: d(r.cutoff)!,
    candidates: r.candidates,
    held: r.held,
    status: r.status as RetentionReviewDto['status'],
    createdByName: names.get(r.createdBy) ?? null,
    closedByName: r.closedBy ? (names.get(r.closedBy) ?? null) : null,
    closedAt: r.closedAt?.toISOString() ?? null,
    decisions: decisions
      .filter((x) => x.reviewId === r.id)
      .map((x) => ({
        id: x.id,
        recordType: x.recordType,
        recordId: x.recordId,
        decision: x.decision as 'KEEP' | 'ACT',
        reason: x.reason,
        keepUntil: d(x.keepUntil),
        decidedByName: names.get(x.decidedBy) ?? null,
        decidedAt: x.decidedAt.toISOString(),
      })),
    version: r.version,
  }));
}

type DsrRow = Prisma.SubjectRequestGetPayload<object>;
async function dsrDtos(tx: TenantTx, rows: DsrRow[], now = new Date()) {
  const staffIds = [...new Set(rows.flatMap((r) => (r.staffId ? [r.staffId] : [])))];
  const [staff, names] = await Promise.all([
    staffIds.length
      ? tx.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, displayName: true },
        })
      : Promise.resolve([]),
    userNames(
      tx,
      rows.map((r) => r.handledBy),
    ),
  ]);
  const staffNames = new Map(staff.map((s) => [s.id, s.displayName]));
  return rows.map((r) => dsrDto(r, now, staffNames, names));
}

function dsrDto(r: DsrRow, now: Date, staff: Names, names: Names): SubjectRequestDto {
  // K2: still waiting for identity, the clock is paused up to today.
  const pausing =
    r.status === 'RECEIVED' && r.identityRequestedOn
      ? identityPauseDays(d(r.identityRequestedOn), londonDate(now))
      : r.pausedDays;
  const due = subjectRequestEffectiveDue(d(r.dueOn)!, d(r.extendedTo), pausing);
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    subjectType: r.subjectType,
    staffId: r.staffId,
    staffName: r.staffId ? (staff.get(r.staffId) ?? null) : null,
    patientRef: r.patientRef,
    description: r.description,
    receivedOn: d(r.receivedOn)!,
    dueOn: d(r.dueOn)!,
    extendedTo: d(r.extendedTo),
    latestExtension: subjectRequestLatestExtension(d(r.receivedOn)!),
    status: r.status,
    outcome: r.outcome,
    exportJobId: r.exportJobId,
    handledByName: names.get(r.handledBy) ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    overdue: !['COMPLETED', 'REFUSED'].includes(r.status) && due < londonDate(now),
    identityRequestedOn: d(r.identityRequestedOn),
    identityVerifiedOn: d(r.identityVerifiedOn),
    pausedDays: pausing,
    effectiveDueOn: due,
    exemption: r.exemption,
    version: r.version,
  };
}

function discDto(x: Prisma.DisclosureGetPayload<object>) {
  return {
    id: x.id,
    subjectRequestId: x.subjectRequestId,
    disclosedTo: x.disclosedTo,
    purpose: x.purpose,
    lawfulBasis: x.lawfulBasis,
    dataDescription: x.dataDescription,
    disclosedOn: d(x.disclosedOn)!,
    subjectDescription: x.subjectDescription,
    requestedBy: x.requestedBy,
    approvedBy: x.approvedBy,
    method: x.method as (typeof DISCLOSURE_METHODS)[number] | null,
    recordedBy: x.recordedBy,
    recordedAt: x.recordedAt.toISOString(),
  };
}

type BreachRow = Prisma.BreachRecordGetPayload<object>;
async function breachDtos(tx: TenantTx, rows: BreachRow[], now = new Date()) {
  const names = await userNames(
    tx,
    rows.flatMap((b) => [b.decidedBy, b.recordedBy, b.closedBy]),
  );
  return rows.map((b) => breachDto(b, now, names));
}

function breachDto(b: BreachRow, now: Date, names: Names): BreachDto {
  const parsed = BreachAnswers.safeParse(b.assessment);
  const answers = parsed.success ? parsed.data : null;
  const c = breachClock({
    discoveredAt: b.discoveredAt,
    icoReportable: b.icoReportable,
    icoReportedAt: b.icoReportedAt,
    now,
  });
  return {
    id: b.id,
    code: b.code,
    title: b.title,
    description: b.description,
    discoveredAt: b.discoveredAt.toISOString(),
    occurredAt: b.occurredAt?.toISOString() ?? null,
    dataCategories: b.dataCategories,
    subjectsEstimate: b.subjectsEstimate,
    containment: b.containment,
    icoDeadline: c.deadline.toISOString(),
    clock: c.state,
    hoursLeft: c.hoursLeft,
    risk: b.risk,
    icoReportable: b.icoReportable,
    decisionReason: b.decisionReason,
    decidedByName: b.decidedBy ? (names.get(b.decidedBy) ?? null) : null,
    decidedAt: b.decidedAt?.toISOString() ?? null,
    icoReportedAt: b.icoReportedAt?.toISOString() ?? null,
    icoReference: b.icoReference,
    lateReason: b.lateReason,
    subjectsNotifiedAt: b.subjectsNotifiedAt?.toISOString() ?? null,
    recordedByName: names.get(b.recordedBy) ?? null,
    containedAt: b.containedAt?.toISOString() ?? null,
    peopleAffected: b.peopleAffected,
    answers,
    suggestedRisk: answers ? suggestBreachRisk(answers) : null,
    lessons: b.lessons,
    closedByName: b.closedBy ? (names.get(b.closedBy) ?? null) : null,
    closedAt: b.closedAt?.toISOString() ?? null,
    status: b.status,
    version: b.version,
  };
}

/** K1: contained after it happened (or was found) and not in the future. */
function assertContained(containedAt: string, occurredAt: string | null, now: Date): void {
  const at = new Date(containedAt);
  if (at.getTime() > now.getTime() + 5 * 60_000)
    throw new HubError('VALIDATION_FAILED', 400, 'The containment time is in the future');
  if (occurredAt && at < new Date(occurredAt))
    throw new HubError('VALIDATION_FAILED', 400, 'It cannot be contained before it happened');
}

type ComplaintRow = Prisma.DpComplaintGetPayload<object>;
async function complaintDtos(tx: TenantTx, rows: ComplaintRow[], now = new Date()) {
  const want = (k: 'subjectRequestId' | 'breachId') =>
    rows.flatMap((r) => (r[k] ? [r[k] as string] : []));
  const [names, dsrs, breaches] = await Promise.all([
    userNames(
      tx,
      rows.flatMap((r) => [r.ownerUserId, r.resolvedBy]),
    ),
    tx.subjectRequest.findMany({
      where: { id: { in: want('subjectRequestId') } },
      select: { id: true, code: true },
    }),
    tx.breachRecord.findMany({
      where: { id: { in: want('breachId') } },
      select: { id: true, code: true },
    }),
  ]);
  const dsrCode = new Map(dsrs.map((x) => [x.id, x.code]));
  const breachCode = new Map(breaches.map((x) => [x.id, x.code]));
  return rows.map((r): DpComplaintDto => ({
    id: r.id,
    code: r.code,
    source: r.source as DpComplaintDto['source'],
    summary: r.summary,
    receivedOn: d(r.receivedOn)!,
    acknowledgeDue: d(r.acknowledgeDue)!,
    acknowledgedOn: d(r.acknowledgedOn),
    acknowledgeOverdue: !r.acknowledgedOn && d(r.acknowledgeDue)! < londonDate(now),
    subjectRequestId: r.subjectRequestId,
    subjectRequestCode: r.subjectRequestId ? (dsrCode.get(r.subjectRequestId) ?? null) : null,
    breachId: r.breachId,
    breachCode: r.breachId ? (breachCode.get(r.breachId) ?? null) : null,
    ownerUserId: r.ownerUserId,
    ownerName: names.get(r.ownerUserId) ?? null,
    status: r.status as DpComplaintDto['status'],
    outcome: r.outcome,
    resolvedOn: d(r.resolvedOn),
    resolvedByName: r.resolvedBy ? (names.get(r.resolvedBy) ?? null) : null,
    icoCaseRef: r.icoCaseRef,
    draftAcknowledgement:
      r.draftAcknowledgement ??
      draftDpAcknowledgement(
        r.code,
        formatDate(d(r.receivedOn)!),
        formatDate(addDays(d(r.receivedOn)!, 30)),
      ),
    version: r.version,
  }));
}
