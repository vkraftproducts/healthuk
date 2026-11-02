import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@hub/db';
import { SnoozeInput, type AlertDto } from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const MAX_SNOOZE_MS = 30 * 86_400_000;
const ListQuery = z.object({
  state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional(),
  severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
});

const toDto = (a: {
  id: string;
  sourceType: string;
  sourceId: string;
  severity: AlertDto['severity'];
  reasonCode: string;
  reasonText: string;
  ownerUserId: string | null;
  state: AlertDto['state'];
  snoozedUntil: Date | null;
  raisedAt: Date;
  version: number;
}): AlertDto => ({
  id: a.id,
  sourceType: a.sourceType,
  sourceId: a.sourceId,
  severity: a.severity,
  reasonCode: a.reasonCode,
  reasonText: a.reasonText,
  ownerUserId: a.ownerUserId,
  state: a.state,
  snoozedUntil: a.snoozedUntil?.toISOString() ?? null,
  raisedAt: a.raisedAt.toISOString(),
  version: a.version,
});

/** Alerts are derived from requirement state; these endpoints only change notification behaviour (ALERT-03). */
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('compliance.requirement.view')
  @Get()
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: AlertDto[] }> {
    const f = body(ListQuery, q);
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.alert.findMany({
        where: {
          state: f.state ?? { not: 'RESOLVED' },
          ...(f.severity ? { severity: f.severity } : {}),
        },
        orderBy: [{ severity: 'asc' }, { raisedAt: 'desc' }],
        take: 200,
      }),
    );
    return { data: rows.map(toDto) };
  }

  @RequirePermission('compliance.requirement.manage')
  @Post(':id/acknowledge')
  async acknowledge(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<AlertDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.alert.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.state === 'RESOLVED')
        throw new HubError('CONFLICT', 409, 'The alert is already resolved');
      const u = await tx.alert.update({
        where: { id },
        data: { state: 'ACKNOWLEDGED', acknowledgedBy: hub.user.id, acknowledgedAt: new Date() },
      });
      await audit(this.db, tx, hub, {
        action: 'alerts.acknowledge',
        entity: 'alert',
        entityId: id,
      });
      return toDto(u);
    });
  }

  @RequirePermission('compliance.requirement.manage')
  @Post(':id/snooze')
  async snooze(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<AlertDto> {
    const input = body(SnoozeInput, raw);
    const until = new Date(input.until);
    const now = Date.now();
    if (until.getTime() <= now || until.getTime() > now + MAX_SNOOZE_MS)
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'Snooze must end in the future and within 30 days',
      );
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const a = await tx.alert.findUnique({ where: { id } });
      if (!a) throw notFound();
      if (a.state === 'RESOLVED')
        throw new HubError('CONFLICT', 409, 'The alert is already resolved');
      // Notifications pause; the underlying requirement status and its due date are untouched.
      const u = await tx.alert.update({ where: { id }, data: { snoozedUntil: until } });
      await audit(this.db, tx, hub, {
        action: 'alerts.snooze',
        entity: 'alert',
        entityId: id,
        summary: { until: until.toISOString() },
      });
      return toDto(u);
    });
  }
}
