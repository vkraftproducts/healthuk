import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  MAX_PUSH_DEVICES,
  NotificationPreferencesInput,
  PushDeviceRegisterInput,
  type NotificationPreferencesDto,
  type OrgSettings,
  type PushDeviceDto,
} from '@hub/contracts';
import { OrgMember } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });

const deviceDto = (d: {
  id: string;
  kind: string;
  createdAt: Date;
  lastRegisteredAt: Date;
  revokedAt: Date | null;
}): PushDeviceDto => ({
  id: d.id,
  kind: d.kind as PushDeviceDto['kind'],
  createdAt: d.createdAt.toISOString(),
  lastRegisteredAt: d.lastRegisteredAt.toISOString(),
  revokedAt: d.revokedAt?.toISOString() ?? null,
});

/** Support access reads an organisation; it never receives that organisation's escalations. */
function refuseSupport(hub: HubRequestContext): void {
  if (hub.support) throw new HubError('FORBIDDEN', 403, 'Support access cannot do this');
}

/**
 * Email and push delivery of escalations: a person's own push registrations and email/push
 * switches in the selected organisation. Self-scoped: every query is limited to the caller.
 */
@Controller('me')
export class NotificationDeliveryController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get('push-devices')
  async devices(@Hub() hub: HubRequestContext): Promise<{ data: PushDeviceDto[] }> {
    const rows = await this.db.withTenant(tenantOf(hub), (tx) =>
      tx.pushDevice.findMany({
        where: { userId: hub.user.id, revokedAt: null },
        orderBy: { lastRegisteredAt: 'desc' },
      }),
    );
    return { data: rows.map(deviceDto) };
  }

  @OrgMember()
  @Post('push-devices')
  async register(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<PushDeviceDto> {
    refuseSupport(hub);
    const input = body(PushDeviceRegisterInput, raw);
    const me = hub.user.id;
    const token = input.kind === 'EXPO' ? input.token : input.endpoint;
    const keys =
      input.kind === 'WEB_PUSH' && input.keys
        ? { p256dh: input.keys.p256dh, authSecret: input.keys.auth }
        : { p256dh: null, authSecret: null };
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const now = new Date();
      // A live token belongs to one person: a shared device moves to whoever registers it now.
      await tx.pushDevice.updateMany({
        where: { token, revokedAt: null, userId: { not: me } },
        data: { revokedAt: now },
      });
      const prior = await tx.pushDevice.findFirst({
        where: { token, userId: me, revokedAt: null },
      });
      if (prior) {
        const d = await tx.pushDevice.update({
          where: { id: prior.id },
          data: { lastRegisteredAt: now, ...keys },
        });
        return deviceDto(d);
      }
      const d = await tx.pushDevice.create({
        data: {
          organisationId: hub.orgId as string,
          userId: me,
          kind: input.kind,
          token,
          ...keys,
          createdBy: me,
          lastRegisteredAt: now,
        },
      });
      await this.capDevices(tx, me, now);
      await audit(this.db, tx, hub, {
        action: 'notifications.push_device.register',
        entity: 'push_device',
        entityId: d.id,
        summary: { kind: d.kind },
      });
      return deviceDto(d);
    });
  }

  @OrgMember()
  @Delete('push-devices/:id')
  async remove(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
  ): Promise<PushDeviceDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const d = await tx.pushDevice.findFirst({ where: { id, userId: hub.user.id } });
      if (!d) throw notFound();
      if (d.revokedAt) return deviceDto(d);
      const out = await tx.pushDevice.update({ where: { id }, data: { revokedAt: new Date() } });
      await audit(this.db, tx, hub, {
        action: 'notifications.push_device.remove',
        entity: 'push_device',
        entityId: id,
        summary: { kind: d.kind },
      });
      return deviceDto(out);
    });
  }

  @OrgMember()
  @Get('notification-preferences')
  async preferences(@Hub() hub: HubRequestContext): Promise<NotificationPreferencesDto> {
    return this.db.withTenant(tenantOf(hub), (tx) => this.readPreferences(tx, hub));
  }

  @OrgMember()
  @Put('notification-preferences')
  async updatePreferences(
    @Hub() hub: HubRequestContext,
    @Body() raw: unknown,
  ): Promise<NotificationPreferencesDto> {
    refuseSupport(hub);
    const input = body(NotificationPreferencesInput, raw);
    const me = hub.user.id;
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const p = await tx.notificationPreference.upsert({
        where: { organisationId_userId: { organisationId: hub.orgId as string, userId: me } },
        create: {
          organisationId: hub.orgId as string,
          userId: me,
          emailEnabled: input.email ?? true,
          pushEnabled: input.push ?? true,
          createdBy: me,
          updatedBy: me,
        },
        update: {
          ...(input.email === undefined ? {} : { emailEnabled: input.email }),
          ...(input.push === undefined ? {} : { pushEnabled: input.push }),
          updatedBy: me,
          updatedAt: new Date(),
        },
      });
      await audit(this.db, tx, hub, {
        action: 'notifications.preferences.update',
        entity: 'notification_preference',
        entityId: p.id,
        summary: { email: p.emailEnabled, push: p.pushEnabled },
      });
      return this.readPreferences(tx, hub);
    });
  }

  private async readPreferences(
    tx: TenantTx,
    hub: HubRequestContext,
  ): Promise<NotificationPreferencesDto> {
    const [p, org] = await Promise.all([
      tx.notificationPreference.findUnique({
        where: {
          organisationId_userId: { organisationId: hub.orgId as string, userId: hub.user.id },
        },
      }),
      tx.organisation.findUniqueOrThrow({
        where: { id: hub.orgId as string },
        select: { settings: true },
      }),
    ]);
    const s = (org.settings ?? {}) as Partial<Pick<OrgSettings, 'channels' | 'emailReminders'>>;
    return {
      email: p?.emailEnabled ?? true,
      push: p?.pushEnabled ?? true,
      organisation: {
        email: s.channels?.email !== false && s.emailReminders !== false,
        push: s.channels?.push !== false,
      },
    };
  }

  /** Keeps at most MAX_PUSH_DEVICES live registrations per person: the oldest are revoked. */
  private async capDevices(tx: TenantTx, userId: string, now: Date): Promise<void> {
    const live = await tx.pushDevice.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastRegisteredAt: 'desc' },
      select: { id: true },
    });
    const extra = live.slice(MAX_PUSH_DEVICES).map((d) => d.id);
    if (extra.length > 0)
      await tx.pushDevice.updateMany({ where: { id: { in: extra } }, data: { revokedAt: now } });
  }
}
