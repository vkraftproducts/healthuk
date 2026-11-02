import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { ensureRetentionDefaults, nextCode, retentionCandidates } from '@hub/domain';
import {
  BreachAssessment,
  BreachIcoReport,
  BreachInput,
  DisclosureInput,
  LegalHoldInput,
  LegalHoldRelease,
  RetentionRulePatch,
  SubjectRequestInput,
  SubjectRequestUpdate,
  type BreachDto,
  type ExportDto,
  type LegalHoldDto,
  type RetentionRuleDto,
  type SubjectRequestDto,
} from '@hub/contracts';
import {
  breachClock,
  londonDate,
  retentionCutoff,
  subjectRequestDue,
  subjectRequestLatestExtension,
  type RetentionCategory,
} from '@hub/rules';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

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
      return { data: await Promise.all(rules.map((r) => this.ruleDto(tx, r, now))) };
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
        data: { ...input, status: 'REQUIRES_APPROVAL', approvedBy: null, approvedAt: null },
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
  async log(@Hub() hub: HubRequestContext) {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.retentionLog.findMany({ orderBy: { runAt: 'desc' }, take: 200 }),
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
  @RequirePermission(P)
  @Get('legal-holds')
  async holds(@Hub() hub: HubRequestContext): Promise<{ data: LegalHoldDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.legalHold.findMany({ orderBy: { placedAt: 'desc' } }),
    );
    return { data: rows.map(holdDto) };
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
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.hold.place',
        entity: 'legal_hold',
        entityId: h.id,
        summary: { scope: input.scopeType },
      });
      return holdDto(h);
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
      return holdDto(u);
    });
  }

  // ---- data subject requests -----------------------------------------------------------------
  @RequirePermission(P)
  @Get('subject-requests')
  async requests(@Hub() hub: HubRequestContext): Promise<{ data: SubjectRequestDto[] }> {
    const now = new Date();
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.subjectRequest.findMany({ orderBy: { dueOn: 'asc' } }),
    );
    return { data: rows.map((r) => dsrDto(r, now)) };
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
      return dsrDto(r, now);
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
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.dsr.update',
        entity: 'subject_request',
        entityId: id,
        summary: { status: input.status ?? r.status, extended: !!input.extendedTo },
      });
      return dsrDto(u, new Date());
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
  async disclosures(@Hub() hub: HubRequestContext) {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.disclosure.findMany({ orderBy: { disclosedOn: 'desc' }, take: 500 }),
    );
    return { data: rows.map(discDto) };
  }

  @RequirePermission(P)
  @Post('disclosures')
  async disclose(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(DisclosureInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (
        input.subjectRequestId &&
        !(await tx.subjectRequest.findUnique({ where: { id: input.subjectRequestId } }))
      )
        throw notFound();
      const x = await tx.disclosure.create({
        data: {
          ...input,
          subjectRequestId: input.subjectRequestId ?? null,
          organisationId: hub.orgId as string,
          disclosedOn: startOfLondonDayUtc(input.disclosedOn),
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.disclosure.record',
        entity: 'disclosure',
        entityId: x.id,
      });
      return discDto(x);
    });
  }

  // ---- breaches ----------------------------------------------------------------------------------
  @RequirePermission(P)
  @Get('breaches')
  async breaches(@Hub() hub: HubRequestContext): Promise<{ data: BreachDto[] }> {
    const now = new Date();
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.breachRecord.findMany({ orderBy: { discoveredAt: 'desc' } }),
    );
    return { data: rows.map((b) => breachDto(b, now)) };
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
          recordedBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'privacy.breach.record',
        entity: 'breach_record',
        entityId: b.id,
      });
      return breachDto(await tx.breachRecord.findUniqueOrThrow({ where: { id: b.id } }), now);
    });
  }

  @RequirePermission(P)
  @Post('breaches/:id/assessment')
  async assess(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<BreachDto> {
    const input = body(BreachAssessment, raw);
    return this.breachStep(hub, id, 'privacy.breach.assess', (b) => {
      if (b.status === 'REPORTED' || b.status === 'CLOSED')
        throw new HubError('CONFLICT', 409, 'Already reported or closed');
      return { ...input, decidedBy: hub.user.id, decidedAt: new Date(), status: 'ASSESSED' };
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
  async close(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<BreachDto> {
    return this.breachStep(hub, id, 'privacy.breach.close', (b) => {
      if (b.icoReportable === null)
        throw new HubError(
          'TRANSITION_NOT_ALLOWED',
          422,
          'Record the reportability decision first',
        );
      if (b.icoReportable && !b.icoReportedAt)
        throw new HubError('TRANSITION_NOT_ALLOWED', 422, 'Record the ICO report first');
      return { status: 'CLOSED' };
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
      return breachDto(u, new Date());
    });
  }

  private async ruleDto(
    tx: TenantTx,
    r: Prisma.RetentionRuleGetPayload<object>,
    now: Date,
  ): Promise<RetentionRuleDto> {
    const cutoff = retentionCutoff(now, r.retainMonths);
    const c = await retentionCandidates(tx, r.category as RetentionCategory, cutoff);
    return {
      id: r.id,
      category: r.category as RetentionRuleDto['category'],
      retainMonths: r.retainMonths,
      triggerDesc: r.triggerDesc,
      basis: r.basis,
      action: r.action as RetentionRuleDto['action'],
      status: r.status as RetentionRuleDto['status'],
      approvedBy: r.approvedBy,
      approvedAt: r.approvedAt?.toISOString() ?? null,
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

function holdDto(h: Prisma.LegalHoldGetPayload<object>): LegalHoldDto {
  return {
    id: h.id,
    scopeType: h.scopeType,
    scopeId: h.scopeId,
    reason: h.reason,
    placedBy: h.placedBy,
    placedAt: h.placedAt.toISOString(),
    releasedAt: h.releasedAt?.toISOString() ?? null,
    releaseReason: h.releaseReason,
  };
}

function dsrDto(r: Prisma.SubjectRequestGetPayload<object>, now: Date): SubjectRequestDto {
  const due = d(r.extendedTo) ?? d(r.dueOn)!;
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    subjectType: r.subjectType,
    staffId: r.staffId,
    patientRef: r.patientRef,
    description: r.description,
    receivedOn: d(r.receivedOn)!,
    dueOn: d(r.dueOn)!,
    extendedTo: d(r.extendedTo),
    status: r.status,
    outcome: r.outcome,
    exportJobId: r.exportJobId,
    overdue: !['COMPLETED', 'REFUSED'].includes(r.status) && due < londonDate(now),
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
    recordedBy: x.recordedBy,
    recordedAt: x.recordedAt.toISOString(),
  };
}

function breachDto(b: Prisma.BreachRecordGetPayload<object>, now: Date): BreachDto {
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
    discoveredAt: b.discoveredAt.toISOString(),
    icoDeadline: c.deadline.toISOString(),
    clock: c.state,
    hoursLeft: c.hoursLeft,
    risk: b.risk,
    icoReportable: b.icoReportable,
    decisionReason: b.decisionReason,
    icoReportedAt: b.icoReportedAt?.toISOString() ?? null,
    icoReference: b.icoReference,
    status: b.status,
    version: b.version,
  };
}
