import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Db } from '@hub/db';
import { AuditListQuery, type AuditListResponse, type VerifyChainResponse } from '@hub/contracts';
import { Audited, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { parse } from '../../common/zod.js';
import { DB } from '../../db.provider.js';

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
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.auditLog.findMany({
        where: {
          ...(q.entity ? { entity: q.entity } : {}),
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
        },
        orderBy: { seq: 'desc' },
        take: q.limit + 1,
      }),
    );
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => ({
        id: r.id,
        seq: r.seq.toString(),
        occurredAt: r.occurredAt.toISOString(),
        actorUserId: r.actorUserId,
        actorType: r.actorType,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        hash: r.hash,
      })),
      nextCursor: rows.length > q.limit && last ? last.seq.toString() : null,
    };
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
}
