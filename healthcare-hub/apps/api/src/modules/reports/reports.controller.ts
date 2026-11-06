import { Body, Controller, Get, Inject, Param, Post, Query, StreamableFile } from '@nestjs/common';
import type { Db, Prisma } from '@hub/db';
import { computeReport, type ReportData } from '@hub/domain';
import {
  ManagementPackInput,
  ReportId,
  ReportQuery,
  type ExportDto,
  type ReportDataDto,
  type ReportDefinitionDto,
} from '@hub/contracts';
import { addDays, canRunReport, londonDate, monthPeriod, REPORTS, type ISODate } from '@hub/rules';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { toCsv } from '../../common/csv.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const NOTICE = 'Internal measure — not a CQC rating' as const;
const MAX_DAYS = 366;

/** Reports (PRD 4.10): every figure carries its denominator, period and inclusion rule. */
@Controller()
export class ReportsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Only the reports this role may run here: about areas it can see, in a sector that has them. */
  @RequirePermission('reports.view')
  @Get('reports')
  async list(@Hub() hub: HubRequestContext): Promise<{ data: ReportDefinitionDto[] }> {
    const packs = await this.packs(hub);
    return {
      data: REPORTS.filter((r) => canRunReport(r.id, hub.permissions, packs)).map((r) => ({
        ...r,
        measures: r.measures.map((m) => ({ ...m })),
      })),
    };
  }

  @RequirePermission('reports.view')
  @Get('reports/:id')
  async get(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Query() q: unknown,
  ): Promise<ReportDataDto> {
    return { ...(await this.run(hub, id, q)), notice: NOTICE };
  }

  /** CSV with the definitions first, then each table. Exports are audited (PRD 4.10). */
  @RequirePermission('reports.export')
  @Get('reports/:id/export')
  async export(
    @Hub() hub: HubRequestContext,
    @Param('id') id: string,
    @Query() q: unknown,
  ): Promise<StreamableFile> {
    const d = await this.run(hub, id, q, true);
    const rows: unknown[][] = [
      ['Report', d.title],
      ['Period', `${d.period.from} to ${d.period.to}`],
      ['Notice', NOTICE],
      [],
      [
        'Measure',
        'Value',
        'Numerator',
        'Denominator',
        'Numerator rule',
        'Denominator rule',
        'Period',
        'Inclusion',
      ],
      ...d.measures.map((m) => [
        m.label,
        m.value === null ? '' : m.unit === 'PERCENT' ? `${m.value}%` : m.value,
        m.numerator,
        m.denominator,
        m.definition.numerator,
        m.definition.denominator,
        m.definition.period,
        m.definition.inclusion,
      ]),
    ];
    for (const t of d.tables) rows.push([], [t.title], t.columns, ...t.rows);
    const csv = toCsv(['Healthcare Hub report', d.id], rows);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${d.id.toLowerCase()}-${d.period.from}-${d.period.to}.csv"`,
    });
  }

  @RequirePermission('reports.export')
  @Post('management-packs')
  async pack(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ExportDto> {
    const input = body(ManagementPackInput, raw);
    const period = monthPeriod(input.month);
    if (period.from > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'That month has not started yet');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      const pending = await tx.exportJob.count({
        where: { requestedBy: hub.user.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (pending >= 3)
        throw new HubError('RATE_LIMITED', 429, 'Wait for your earlier exports to finish');
      const j = await tx.exportJob.create({
        data: {
          organisationId: hub.orgId as string,
          kind: 'MANAGEMENT_PACK',
          params: { ...input, ...period } as Prisma.InputJsonObject,
          requestedBy: hub.user.id,
          requesterPermissions: [...hub.permissions],
        },
      });
      await audit(this.db, tx, hub, {
        action: 'reports.management_pack.request',
        entity: 'export_job',
        entityId: j.id,
        summary: { month: input.month },
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

  private async run(
    hub: HubRequestContext,
    rawId: string,
    q: unknown,
    exported = false,
  ): Promise<ReportData> {
    const id = ReportId.safeParse(rawId);
    if (!id.success) throw notFound();
    if (!canRunReport(id.data, hub.permissions, await this.packs(hub)))
      throw new HubError(
        'FORBIDDEN',
        403,
        'Your role cannot see what this report covers in this organisation',
      );
    const f = body(ReportQuery, q);
    const now = new Date();
    const today = londonDate(now);
    // Default: this month to date (London).
    const to: ISODate = f.to ?? today;
    const from: ISODate = f.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new HubError('VALIDATION_FAILED', 400, 'to must not be before from');
    if (addDays(from, MAX_DAYS) < to)
      throw new HubError('VALIDATION_FAILED', 400, `A report covers at most ${MAX_DAYS} days`);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (f.locationId && !(await tx.location.findUnique({ where: { id: f.locationId } })))
        throw notFound();
      const d = await computeReport(
        tx,
        id.data,
        { from, to, ...(f.locationId ? { locationId: f.locationId } : {}) },
        now,
      );
      if (exported)
        await audit(this.db, tx, hub, {
          action: 'reports.export',
          entity: 'report',
          entityId: id.data,
          summary: { report: id.data, from, to },
        });
      return d;
    });
  }

  private async packs(hub: HubRequestContext): Promise<string[] | null> {
    const org = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.organisation.findUnique({
        where: { id: hub.orgId as string },
        select: { sectorPacks: true },
      }),
    );
    return org?.sectorPacks ?? null;
  }
}
