import { Controller, Get, Inject } from '@nestjs/common';
import type { Db } from '@hub/db';
import type { InboxItemDto, MeResponse } from '@hub/contracts';
import { AuthenticatedOnly, OrgMember } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { dbNow } from '../../common/http.js';
import { DB } from '../../db.provider.js';

@Controller('me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @AuthenticatedOnly()
  @Get()
  async me(@Hub() hub: HubRequestContext): Promise<MeResponse> {
    const memberships = await this.db.withIdentity(hub.user.id, async (tx) => {
      const now = await dbNow(tx);
      return tx.membership.findMany({
        where: {
          userId: hub.user.id,
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        include: {
          organisation: { select: { name: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
    });
    return {
      user: { id: hub.user.id, email: hub.user.email, displayName: hub.user.displayName },
      memberships: memberships.map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        locationId: m.locationId,
        roleKey: m.role.key,
        roleName: m.role.name,
      })),
      permissions: [...hub.permissions].sort(),
      activeOrganisationId: hub.orgId,
      mfa: { required: hub.mfaRequired, satisfied: hub.mfaSatisfied },
    };
  }

  /**
   * Work sent back to me with a reason, and decisions only I can make. Built from my open alerts
   * of those kinds; each links to the record to act on. Names and dates only, never patient data.
   */
  @OrgMember()
  @Get('inbox')
  async inbox(@Hub() hub: HubRequestContext): Promise<{ data: InboxItemDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const alerts = await tx.alert.findMany({
        where: {
          ownerUserId: hub.user.id,
          state: { not: 'RESOLVED' },
          sourceType: { in: ['EVIDENCE_RETURNED', 'EXCEPTION_REQUEST', 'EXCEPTION_DECLINED'] },
        },
        orderBy: { raisedAt: 'desc' },
        take: 50,
      });
      const data: InboxItemDto[] = [];
      for (const a of alerts) {
        const base = { id: a.id, reasonText: a.reasonText, raisedAt: a.raisedAt.toISOString() };
        if (a.sourceType === 'EVIDENCE_RETURNED') {
          const v = await tx.evidenceVersion.findUnique({
            where: { id: a.sourceId },
            select: { item: { select: { title: true, links: { select: { instanceId: true } } } } },
          });
          const instanceId = v?.item.links[0]?.instanceId;
          const i = instanceId
            ? await tx.requirementInstance.findUnique({
                where: { id: instanceId },
                select: {
                  id: true,
                  subjectType: true,
                  subjectId: true,
                  template: { select: { title: true } },
                },
              })
            : null;
          if (!v || !i) continue;
          data.push({
            ...base,
            kind: 'SENT_BACK',
            title: `${i.template.title}: ${v.item.title}`,
            link: {
              type: 'REQUIREMENT',
              id: i.id,
              subjectType: i.subjectType,
              subjectId: i.subjectId,
            },
          });
        } else {
          const r = await tx.allocationExceptionRequest.findUnique({ where: { id: a.sourceId } });
          const job = r
            ? await tx.job.findUnique({
                where: { id: r.jobId },
                select: { id: true, code: true, plannedStart: true },
              })
            : null;
          if (!r || !job) continue;
          data.push({
            ...base,
            kind: a.sourceType === 'EXCEPTION_REQUEST' ? 'EXCEPTION_REQUEST' : 'EXCEPTION_DECLINED',
            title: `${a.sourceType === 'EXCEPTION_REQUEST' ? 'Exception to decide' : 'Exception declined'}: ${job.code}`,
            link: { type: 'JOB', id: job.id, date: job.plannedStart.toISOString().slice(0, 10) },
          });
        }
      }
      return { data };
    });
  }
}
