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
import type { Db, Prisma } from '@hub/db';
import { dashboardRows, dashboardSummary, type BlobStore } from '@hub/domain';
import {
  ActionRowsQuery,
  DashboardQuery,
  EvidencePackInput,
  type DashboardSummary,
  type ExportDto,
} from '@hub/contracts';
import { CONFIG, type AppConfig } from '../../config.js';
import { Public, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
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

@Controller()
export class DashboardController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BLOB_STORE) private readonly store: BlobStore,
  ) {}

  @RequirePermission('dashboard.view')
  @Get('dashboard/summary')
  async summary(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<DashboardSummary> {
    const f = body(DashboardQuery, q);
    const now = new Date();
    const s = await this.db.withTenant(tenantOf(hub), (tx) => dashboardSummary(tx, f, now));
    return {
      tiles: s.tiles,
      modules: s.modules,
      operations: s.operations,
      criticalOpen: s.criticalOpen,
      coverage: s.coverage,
      lastRefreshedAt: now.toISOString(),
      sources: [
        { name: 'requirements', ok: true },
        { name: 'fleet', ok: true },
        { name: 'jobs', ok: true },
      ],
    };
  }

  @RequirePermission('dashboard.view')
  @Get('dashboard/actions')
  async actions(@Hub() hub: HubRequestContext, @Query() q: unknown) {
    const f = body(ActionRowsQuery, q);
    const { rows } = await this.db.withTenant(tenantOf(hub), (tx) =>
      dashboardRows(tx, f, new Date()),
    );
    return { data: rows.filter((r) => inTile(r, f.tile)) };
  }

  @RequirePermission('dashboard.view', 'reports.export')
  @Get('dashboard/actions/export')
  async export(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<StreamableFile> {
    const f = body(ActionRowsQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const r = (await dashboardRows(tx, f, new Date())).rows.filter((x) => inTile(x, f.tile));
      await audit(this.db, tx, hub, {
        action: 'reports.dashboard.export',
        entity: 'organisation',
        entityId: hub.orgId as string,
        summary: { rows: r.length, tile: f.tile },
      });
      return r;
    });
    const csv = toCsv(
      ['Module', 'Item', 'Owner id', 'Deadline', 'State', 'Reason'],
      rows.map((r) => [
        r.module,
        r.item,
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
        summary: { from: input.from, to: input.to },
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
