import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Db } from '@hub/db';
import type { CleaningDto, DeepCleanStatusDto } from '@hub/contracts';
import { DeepCleanCreate } from '@hub/contracts';
import { addDays, daysUntil, londonDate, londonDateTime } from '@hub/rules';
import type { z } from 'zod';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { assertActiveMember, escalationContext, idPipe } from './shared.js';

const INFECTIOUS_REASON = 'Deep clean needed after infectious transfer';
const FLEET = 'fleet.vehicle.manage';
const VIEW = 'fleet.vdi.view';
/** v36: vehicles are deep cleaned every 28 days. */
const DEEP_EVERY_DAYS = 28;
type CleaningDtoT = z.infer<typeof CleaningDto>;

/**
 * v36 Fleet care: office deep cleans (four-eyes) and infectious-transfer quarantine.
 */
@Controller()
export class FleetCareController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Deep clean status per vehicle: the last ENHANCED clean, the next due (28 days on, London dates)
   * and, when overdue, who it has escalated to under the Vehicle document rule.
   */
  @RequirePermission(VIEW)
  @Get('deep-cleans/status')
  status(@Hub() hub: HubRequestContext): Promise<{ data: DeepCleanStatusDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      const vehicles = await tx.vehicle.findMany({
        select: { id: true, callsign: true },
        orderBy: { callsign: 'asc' },
      });
      const cleans = await tx.cleaningRecord.findMany({
        where: { type: 'ENHANCED', vehicleId: { in: vehicles.map((v) => v.id) } },
        orderBy: { capturedAt: 'desc' },
        distinct: ['vehicleId'],
      });
      const last = new Map(cleans.map((c) => [c.vehicleId, c]));
      const ids = [
        ...new Set(cleans.flatMap((c) => [c.cleanedBy, c.checkedBy]).filter((x): x is string => !!x)),
      ];
      const names = new Map(
        (
          await tx.appUser.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true },
          })
        ).map((u) => [u.id, u.displayName]),
      );
      const esc = await escalationContext(tx, now);
      return {
        data: vehicles.map((v) => {
          const c = last.get(v.id);
          if (!c)
            return {
              vehicleId: v.id,
              callsign: v.callsign,
              lastId: null,
              lastOn: null,
              cleanedByName: null,
              checkedByName: null,
              note: null,
              nextDueOn: null,
              daysUntil: null,
              escalation: null,
            };
          const on = londonDate(c.capturedAt);
          const next = addDays(on, DEEP_EVERY_DAYS);
          const left = daysUntil(next, now);
          return {
            vehicleId: v.id,
            callsign: v.callsign,
            lastId: c.id,
            lastOn: on,
            cleanedByName: names.get(c.cleanedBy) ?? null,
            checkedByName: c.checkedBy ? (names.get(c.checkedBy) ?? null) : null,
            note: c.notes,
            nextDueOn: next,
            daysUntil: left,
            escalation: esc.of('VEHICLE_DOCUMENT', -left),
          };
        }),
      };
    });
  }

  @RequirePermission(FLEET)
  @Post('cleaning-records/deep')
  deep(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<CleaningDtoT> {
    const input = body(DeepCleanCreate, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.cleanedBy === input.checkedBy)
        throw new HubError(
          'FOUR_EYES_REQUIRED',
          409,
          'Someone other than the cleaner must check the deep clean',
        );
      await assertActiveMember(tx, input.cleanedBy, 'The cleaner');
      await assertActiveMember(tx, input.checkedBy, 'The checker');
      const v = await tx.vehicle.findUnique({ where: { id: input.vehicleId } });
      if (!v) throw notFound();
      const captured = londonDateTime(input.cleanedOn, '12:00');
      const c = await tx.cleaningRecord.create({
        data: {
          organisationId: v.organisationId,
          vehicleId: v.id,
          type: 'ENHANCED',
          cleanedBy: input.cleanedBy,
          checkedBy: input.checkedBy,
          clientSubmissionId: randomUUID(),
          capturedAt: captured,
          notes: input.note ?? 'Scheduled deep clean',
        },
      });
      // A deep clean clears an infectious-transfer quarantine.
      if (v.quarantined && v.quarantineReason === INFECTIOUS_REASON) {
        await tx.vehicle.update({
          where: { id: v.id },
          data: { quarantined: false, quarantineReason: null, updatedAt: new Date() },
        });
      }
      await audit(this.db, tx, hub, {
        action: 'fleet.cleaning.deep',
        entity: 'cleaning_record',
        entityId: c.id,
        summary: { vehicleId: v.id },
      });
      const names = await tx.appUser.findMany({
        where: { id: { in: [c.cleanedBy, c.checkedBy!] } },
        select: { id: true, displayName: true },
      });
      const name = new Map(names.map((u) => [u.id, u.displayName]));
      return {
        id: c.id,
        vehicleId: c.vehicleId,
        type: c.type,
        cleanedBy: c.cleanedBy,
        cleanedByName: name.get(c.cleanedBy) ?? null,
        checkedBy: c.checkedBy,
        checkedByName: c.checkedBy ? (name.get(c.checkedBy) ?? null) : null,
        capturedAt: c.capturedAt.toISOString(),
        receivedAt: c.receivedAt.toISOString(),
        notes: c.notes,
        duplicate: false,
      };
    });
  }

  @RequirePermission(FLEET)
  @Post('vehicles/:id/infectious-transfer')
  infectious(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<{ id: string; quarantined: boolean; quarantineReason: string | null }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.vehicle.findUnique({ where: { id } });
      if (!v) throw notFound();
      const updated = await tx.vehicle.update({
        where: { id },
        data: {
          quarantined: true,
          quarantineReason: INFECTIOUS_REASON,
          updatedAt: new Date(),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'fleet.vehicle.infectious',
        entity: 'vehicle',
        entityId: id,
        summary: { reason: INFECTIOUS_REASON },
      });
      return {
        id: updated.id,
        quarantined: updated.quarantined,
        quarantineReason: updated.quarantineReason,
      };
    });
  }
}

