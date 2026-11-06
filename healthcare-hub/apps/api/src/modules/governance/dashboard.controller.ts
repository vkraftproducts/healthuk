import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { dashboardRows, dashboardSummary, type BlobStore } from '@hub/domain';
import { visibleDashboardModules, visibleDashboardTiles } from '@hub/rules';
import {
  ActionRowsQuery,
  DashboardQuery,
  EvidencePackInput,
  GroupDashboardQuery,
  type DashboardSummary,
  type GroupDashboardSummary,
  type ExportDto,
} from '@hub/contracts';
import { CONFIG, type AppConfig } from '../../config.js';
import { AuthenticatedOnly, Public, RequirePermission } from '../../common/decorators.js';
import { mfaRequiredFor } from '../../auth/mfa.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body, dbNow } from '../../common/http.js';
import { toCsv } from '../../common/csv.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { BLOB_STORE } from '../../storage/blob-store.js';
import { signBlobToken, verifyBlobToken } from '../../storage/tokens.js';
import { SYSTEM_USER_ID } from '@hub/db';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const LINK_TTL_S = 5 * 60;

/**
 * Home dashboard (wireframe 01). Tiles and the action list come from one computation, so every
 * tile equals the number of rows in its drill-down (UAT-08).
 */
/** "All" means everything needing action; on-track rows (green) appear only under their own tile. */
const inTile = (r: { status: string; tiles: string[] }, tile: string): boolean =>
  tile === 'all' ? r.status !== 'GREEN' : r.tiles.includes(tile);

/**
 * Dashboard modules the caller may see: a role only gets rows and figures for areas it can open
 * (an HR lead sees no vehicles), and ambulance modules only where the ambulance pack is on.
 */
async function modulesFor(tx: TenantTx, orgId: string, permissions: Iterable<string>) {
  const org = await tx.organisation.findUnique({
    where: { id: orgId },
    select: { sectorPacks: true },
  });
  return visibleDashboardModules(permissions, org?.sectorPacks ?? null);
}

@Controller()
export class DashboardController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BLOB_STORE) private readonly store: BlobStore,
  ) {}

  /**
   * Group dashboard: for every organisation where the caller holds `dashboard.view`, the same tile
   * counts as that organisation's own dashboard, computed under that organisation's tenant context
   * with the caller's permissions and location scope there. Counts only; a failing organisation is
   * shown as unavailable, never as zero.
   */
  @AuthenticatedOnly()
  @Get('dashboard/group')
  async group(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<GroupDashboardSummary> {
    const f = body(GroupDashboardQuery, q);
    if (f.dateFrom && f.dateTo && f.dateTo < f.dateFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'dateTo must not be before dateFrom');
    const memberships = await this.db.withIdentity(hub.user.id, async (tx) => {
      const t = await dbNow(tx);
      return tx.membership.findMany({
        where: {
          userId: hub.user.id,
          validFrom: { lte: t },
          OR: [{ validTo: null }, { validTo: { gt: t } }],
        },
        include: {
          organisation: { select: { name: true } },
          role: { select: { key: true, rolePermissions: true } },
        },
      });
    });
    const orgIds = [...new Set(memberships.map((m) => m.organisationId))];
    const now = new Date();
    const organisations: GroupDashboardSummary['organisations'][number][] = [];
    for (const orgId of orgIds) {
      const mine = memberships.filter((m) => m.organisationId === orgId);
      const permissions = [
        ...new Set(mine.flatMap((m) => m.role.rolePermissions.map((p) => p.permissionKey))),
      ];
      if (!permissions.includes('dashboard.view')) continue;
      const base = { organisationId: orgId, organisationName: mine[0]!.organisation.name };
      if (mfaRequiredFor(mine.map((m) => m.role.key)) && !hub.mfaSatisfied) {
        organisations.push({
          ...base,
          ok: false,
          unavailableReason: 'MFA required',
          tiles: null,
          criticalOpen: null,
          worstStatus: null,
        });
        continue;
      }
      const locationIds = mine.some((m) => m.locationId === null)
        ? null
        : [...new Set(mine.map((m) => m.locationId as string))];
      try {
        const s = await this.db.withTenant(
          { orgId, userId: hub.user.id, permissions, locationIds },
          async (tx) => {
            const modules = await modulesFor(tx, orgId, permissions);
            return dashboardSummary(tx, { ...f, modules }, now);
          },
        );
        const rank = { RED: 0, AMBER: 1, GREY: 2, GREEN: 3, NOT_APPLICABLE: 4 } as const;
        const worst = s.modules.reduce<(typeof s.modules)[number]['status'] | null>(
          (w, m) => (w === null || rank[m.status] < rank[w] ? m.status : w),
          null,
        );
        organisations.push({
          ...base,
          ok: true,
          unavailableReason: null,
          tiles: s.tiles,
          criticalOpen: s.criticalOpen,
          worstStatus: s.criticalOpen > 0 ? 'RED' : worst,
        });
      } catch {
        organisations.push({
          ...base,
          ok: false,
          unavailableReason: 'Source unavailable',
          tiles: null,
          criticalOpen: null,
          worstStatus: null,
        });
      }
    }
    const sum = (k: 'overdue' | 'dueSoon' | 'blockedVehicles' | 'jobsToday' | 'unverified') =>
      organisations.reduce((n, o) => n + (o.tiles?.[k] ?? 0), 0);
    return {
      organisations,
      totals: {
        overdue: sum('overdue'),
        dueSoon: sum('dueSoon'),
        blockedVehicles: sum('blockedVehicles'),
        jobsToday: sum('jobsToday'),
        unverified: sum('unverified'),
        criticalOpen: organisations.reduce((n, o) => n + (o.criticalOpen ?? 0), 0),
      },
      lastRefreshedAt: now.toISOString(),
    };
  }

  @RequirePermission('dashboard.view')
  @Get('dashboard/summary')
  async summary(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<DashboardSummary> {
    const f = body(DashboardQuery, q);
    if (f.dateFrom && f.dateTo && f.dateTo < f.dateFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'dateTo must not be before dateFrom');
    const now = new Date();
    const { s, modules, packs } = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const modules = await modulesFor(tx, hub.orgId as string, hub.permissions);
      const org = await tx.organisation.findUnique({
        where: { id: hub.orgId as string },
        select: { sectorPacks: true },
      });
      return {
        s: await dashboardSummary(tx, { ...f, modules }, now),
        modules,
        packs: org?.sectorPacks ?? null,
      };
    });
    return {
      tiles: s.tiles,
      notSetUp: s.notSetUp,
      modules: s.modules,
      operations: s.operations,
      criticalOpen: s.criticalOpen,
      coverage: s.coverage,
      lastRefreshedAt: now.toISOString(),
      sources: [
        { name: 'requirements', ok: true },
        ...(modules.includes('FLEET') ? [{ name: 'fleet', ok: true }] : []),
        ...(modules.includes('JOBS') ? [{ name: 'jobs', ok: true }] : []),
      ],
      visibleModules: modules,
      visibleTiles: visibleDashboardTiles(modules, packs),
    };
  }

  @RequirePermission('dashboard.view')
  @Get('dashboard/actions')
  async actions(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(ActionRowsQuery, q);
    if (f.dateFrom && f.dateTo && f.dateTo < f.dateFrom)
      throw new HubError('VALIDATION_FAILED', 400, 'dateTo must not be before dateFrom');
    const { rows } = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const modules = await modulesFor(tx, hub.orgId as string, hub.permissions);
      return dashboardRows(tx, { ...f, modules }, new Date());
    });
    return { data: rows.filter((r) => inTile(r, f.tile)) };
  }

  @RequirePermission('dashboard.view', 'reports.export')
  @Get('dashboard/actions/export')
  async export(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<StreamableFile> {
    const f = body(ActionRowsQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const modules = await modulesFor(tx, hub.orgId as string, hub.permissions);
      const r = (await dashboardRows(tx, { ...f, modules }, new Date())).rows.filter((x) =>
        inTile(x, f.tile),
      );
      await audit(this.db, tx, hub, {
        action: 'reports.dashboard.export',
        entity: 'organisation',
        entityId: hub.orgId as string,
        summary: { rows: r.length, tile: f.tile },
      });
      return r;
    });
    const csv = toCsv(
      ['Module', 'Item', 'Owner', 'Owner id', 'Deadline', 'State', 'Reason'],
      rows.map((r) => [
        r.module,
        r.item,
        r.ownerName ?? (r.ownerUserId ? 'Not a current member' : 'Unassigned'),
        r.ownerUserId ?? '',
        r.deadline ?? '',
        r.status,
        r.reasonText,
      ]),
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="action-required.csv"',
    });
  }

  // ---- exports ------------------------------------------------------------------------------
  @RequirePermission('reports.export', 'compliance.audit.view')
  @Post('evidence-packs')
  async pack(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<ExportDto> {
    const input = body(EvidencePackInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.locationId && !(await tx.location.findUnique({ where: { id: input.locationId } })))
        throw notFound();
      if (input.serviceId && !(await tx.serviceType.findUnique({ where: { id: input.serviceId } })))
        throw new HubError('VALIDATION_FAILED', 400, 'Unknown service');
      const pending = await tx.exportJob.count({
        where: { requestedBy: hub.user.id, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (pending >= 3)
        throw new HubError('RATE_LIMITED', 429, 'Wait for your earlier exports to finish');
      const j = await tx.exportJob.create({
        data: {
          organisationId: hub.orgId as string,
          kind: 'EVIDENCE_PACK',
          params: input as Prisma.InputJsonObject,
          requestedBy: hub.user.id,
          requesterPermissions: [...hub.permissions],
        },
      });
      await audit(this.db, tx, hub, {
        action: 'reports.evidence_pack.request',
        entity: 'export_job',
        entityId: j.id,
        summary: {
          from: input.from,
          to: input.to,
          purpose: input.purpose,
          sections: input.sections.join(','),
          includeFiles: input.includeFiles,
          gapsOnly: input.gapsOnly,
        },
      });
      return this.dto(j, null);
    });
  }

  @RequirePermission('reports.export')
  @Get('exports')
  async list(@Hub() hub: HubRequestContext): Promise<{ data: ExportDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.exportJob.findMany({
        where: { requestedBy: hub.user.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
    return { data: rows.map((j) => this.dto(j, null)) };
  }

  /** Only the requester can fetch their export; each link is short-lived and the fetch is audited. */
  @RequirePermission('reports.export')
  @Get('exports/:id')
  async get(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<ExportDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const j = await tx.exportJob.findUnique({ where: { id } });
      if (!j || j.requestedBy !== hub.user.id) throw notFound();
      let link: ExportDto['download'] = null;
      if (j.status === 'DONE' && j.blobKey) {
        const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
        const token = signBlobToken(
          { v: j.id, o: j.organisationId, m: 'GET', e: exp, k: 'EXPORT' },
          this.config.BLOB_SIGNING_SECRET,
        );
        link = {
          url: `${this.config.PUBLIC_API_URL}/api/v1/exports/blob/${token}`,
          expiresAt: new Date(exp * 1000).toISOString(),
        };
        await audit(this.db, tx, hub, {
          action: 'reports.export.download',
          entity: 'export_job',
          entityId: j.id,
        });
      }
      return this.dto(j, link);
    });
  }

  @Public()
  @Get('exports/blob/:token')
  async blob(@Param('token') token: string): Promise<StreamableFile> {
    const c = verifyBlobToken(token, this.config.BLOB_SIGNING_SECRET, new Date());
    if (c?.m !== 'GET' || c.k !== 'EXPORT')
      throw new HubError('FORBIDDEN', 403, 'Download link is invalid or has expired');
    const j = await this.db.withTenant({ orgId: c.o, userId: SYSTEM_USER_ID }, (tx) =>
      tx.exportJob.findUnique({ where: { id: c.v } }),
    );
    if (!j?.blobKey) throw notFound();
    const bytes = await this.store.get(j.blobKey);
    if (!bytes) throw notFound();
    const pdf = j.blobKey.endsWith('.pdf');
    const name =
      j.kind === 'MANAGEMENT_PACK' ? 'management-pack' : j.kind.toLowerCase().replace(/_/g, '-');
    return new StreamableFile(bytes, {
      type: pdf ? 'application/pdf' : 'application/zip',
      disposition: `attachment; filename="${name}.${pdf ? 'pdf' : 'zip'}"`,
    });
  }

  private dto(j: Prisma.ExportJobGetPayload<object>, download: ExportDto['download']): ExportDto {
    return {
      id: j.id,
      kind: j.kind,
      status: j.status,
      bytes: j.bytes === null ? null : Number(j.bytes),
      error: j.error,
      createdAt: j.createdAt.toISOString(),
      finishedAt: j.finishedAt?.toISOString() ?? null,
      download,
    };
  }
}
