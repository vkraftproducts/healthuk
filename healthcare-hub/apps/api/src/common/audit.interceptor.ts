import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mergeMap, type Observable } from 'rxjs';
import type { Db } from '@hub/db';
import { DB } from '../db.provider.js';
import { AUDIT_KEY, type AuditSpec } from './decorators.js';
import { tenantOf, type HubRequest } from './context.js';

/**
 * Emits an audit event after an @Audited handler succeeds (sensitive reads, exports,
 * verifications). State-changing services should also append their audit event inside their own
 * transaction so the change and its record commit atomically.
 * Summaries contain IDs and status only - never names or other PII.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<AuditSpec | undefined>(AUDIT_KEY, ctx.getHandler());
    if (!spec) return next.handle();
    const req = ctx.switchToHttp().getRequest<HubRequest>();
    return next.handle().pipe(
      mergeMap(async (result) => {
        const hub = req.hub;
        if (hub?.orgId) {
          const params = (req.params ?? {}) as Record<string, string | undefined>;
          const entityId = (spec.idParam ? params[spec.idParam] : undefined) ?? 'n/a';
          await this.db.withTenant(tenantOf(hub), (tx) =>
            this.db.appendAudit(tx, {
              orgId: hub.orgId as string,
              actorUserId: hub.user.id,
              action: spec.action,
              entity: spec.entity,
              entityId,
              afterSummary: { method: req.method, outcome: 'success' },
              ipHash: hub.ipHash,
            }),
          );
        }
        return result;
      }),
    );
  }
}
