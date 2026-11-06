import { Controller, Get, HttpCode, Inject, Post, Query, StreamableFile } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  AuditExportQuery,
  AuditListQuery,
  type AuditEntryDto,
  type AuditListResponse,
  type VerifyChainResponse,
} from '@hub/contracts';
import { Audited, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit } from '../../common/http.js';
import { toCsv } from '../../common/csv.js';
import { parse } from '../../common/zod.js';
import { DB } from '../../db.provider.js';
import { userNames } from '../evidence/evidence.mapper.js';

const EXPORT_CAP = 5000;
type Filters = Omit<AuditListQuery, 'cursor' | 'limit'> & { cursor?: string };
type Row = Awaited<ReturnType<TenantTx['auditLog']['findMany']>>[number];

function where(q: Filters) {
  return {
    ...(q.entity ? { entity: q.entity } : {}),
    ...(q.entityId ? { entityId: q.entityId } : {}),
    ...(q.action
      ? q.action.endsWith('.')
        ? { action: { startsWith: q.action } }
        : { action: q.action }
      : {}),
    ...(q.actorId ? { actorUserId: q.actorId } : {}),
    ...(q.from || q.to
      ? {
          occurredAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
    ...(q.cursor ? { seq: { lt: BigInt(q.cursor) } } : {}),
  };
}

/** Plain, short values only: nested objects and long text are left out of the view. */
function plainSummary(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'reason') continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

const reasonOf = (raw: unknown): string | null => {
  const r = (raw as { reason?: unknown } | null)?.reason;
  return typeof r === 'string' ? r : null;
};

@Controller('audit-log')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('admin.audit.view')
  @Get()
  async list(
    @Hub() hub: HubRequestContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<AuditListResponse> {
    const q = parse(AuditListQuery, rawQuery);
    const { rows, names, roles } = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: where(q),
        orderBy: { seq: 'desc' },
        take: q.limit + 1,
      });
      return this.enrich(tx, rows);
    });
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => toEntry(r, names, roles)),
      nextCursor: rows.length > q.limit && last ? last.seq.toString() : null,
    };
  }

  /** L4: the filtered log as CSV. The export itself is audited. */
  @RequirePermission('admin.audit.view')
  @Get('export')
  async export(
    @Hub() hub: HubRequestContext,
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<StreamableFile> {
    const q = parse(AuditExportQuery, rawQuery);
    const csv = await this.db.withTenant(tenantOf(hub), async (tx) => {
      const found = await tx.auditLog.findMany({
        where: where(q),
        orderBy: { seq: 'desc' },
        take: EXPORT_CAP,
      });
      const { names, roles } = await this.enrich(tx, found);
      const entries = found.map((r) => toEntry(r, names, roles));
      await audit(this.db, tx, hub, {
        action: 'admin.audit.export',
        entity: 'audit_log',
        entityId: hub.orgId as string,
        summary: {
          rows: entries.length,
          filters: Object.keys(q)
            .filter((k) => q[k as keyof typeof q] !== undefined)
            .join(','),
        },
      });
      return toCsv(
        ['When', 'Who', 'Role', 'Action', 'Record type', 'Record', 'Reason', 'Details'],
        entries.map((e) => [
          e.occurredAt,
          e.actorName ?? (e.actorType === 'SYSTEM' ? 'System' : 'Unknown'),
          e.actorRole ?? '',
          e.action,
          e.entity,
          e.entityId,
          e.reason ?? '',
          Object.entries(e.summary ?? {})
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('; '),
        ]),
      );
    });
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="audit-log.csv"',
    });
  }

  @RequirePermission('admin.audit.verify')
  @Audited({ action: 'admin.audit.verify', entity: 'audit_log', idParam: '' })
  @Post('verify-chain')
  @HttpCode(200)
  async verify(@Hub() hub: HubRequestContext): Promise<VerifyChainResponse> {
    const ctx = tenantOf(hub);
    const broken = await this.db.withTenant(ctx, (tx) => this.db.verifyAuditChain(tx, ctx.orgId));
    return {
      intact: broken === null,
      brokenSeq: broken ? broken.brokenSeq.toString() : null,
      reason: broken?.reason ?? null,
      verifiedAt: new Date().toISOString(),
    };
  }

  private async enrich(tx: TenantTx, rows: Row[]) {
    const ids = rows.map((r) => r.actorUserId);
    const names = await userNames(tx, ids);
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    const memberships = want.length
      ? await tx.membership.findMany({
          where: {
            userId: { in: want },
            OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
          },
          select: { userId: true, role: { select: { name: true } } },
        })
      : [];
    const roles = new Map<string, string>();
    for (const m of memberships) {
      const prev = roles.get(m.userId);
      roles.set(m.userId, prev ? `${prev}, ${m.role.name}` : m.role.name);
    }
    return { rows, names, roles };
  }
}

function toEntry(r: Row, names: Map<string, string>, roles: Map<string, string>): AuditEntryDto {
  return {
    id: r.id,
    seq: r.seq.toString(),
    occurredAt: r.occurredAt.toISOString(),
    actorUserId: r.actorUserId,
    actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
    actorRole: r.actorUserId
      ? (roles.get(r.actorUserId) ?? (r.actorType === 'SUPPORT' ? 'Platform support' : null))
      : null,
    actorType: r.actorType,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    reason: reasonOf(r.afterSummary),
    summary: plainSummary(r.afterSummary),
    hash: r.hash,
  };
}
