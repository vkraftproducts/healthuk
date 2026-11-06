import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Db, Prisma, TenantTx } from '@hub/db';
import { createAction } from '@hub/domain';
import { londonDate } from '@hub/rules';
import {
  FeedbackActionInput,
  FeedbackCreate,
  FeedbackQuery,
  type FeedbackDto,
  type FeedbackThemesDto,
} from '@hub/contracts';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body, requireAny } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { toActionDto } from './audits.controller.js';

export const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const VIEW = 'events.event.view';
const MANAGE = 'events.event.manage';

/** Locations the caller may see: null = all (feedback with no location is then included). */
const scope = (hub: HubRequestContext): Prisma.FeedbackItemWhereInput =>
  hub.locationIds ? { locationId: { in: [...hub.locationIds] } } : {};

const dto = (f: Prisma.FeedbackItemGetPayload<object>, openActions: number): FeedbackDto => ({
  id: f.id,
  kind: f.kind as FeedbackDto['kind'],
  receivedOn: iso(f.receivedOn),
  locationId: f.locationId,
  source: f.source,
  summary: f.summary,
  rating: f.rating,
  themes: f.themes,
  openActions,
});

async function openActionCounts(tx: TenantTx, ids: string[]): Promise<Map<string, number>> {
  const rows = ids.length
    ? await tx.action.findMany({
        where: { sourceType: 'FEEDBACK', sourceId: { in: ids }, status: { not: 'VERIFIED' } },
        select: { sourceId: true },
      })
    : [];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.sourceId, (m.get(r.sourceId) ?? 0) + 1);
  return m;
}

/**
 * EVT-04: compliments, staff feedback and patient surveys with thematic analysis and actions.
 * Complaints stay events; the themes report reads both so a recurring theme is visible once.
 */
@Controller()
export class FeedbackController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get('feedback')
  async list(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<{ data: FeedbackDto[] }> {
    const f = body(FeedbackQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.feedbackItem.findMany({
        where: {
          ...scope(hub),
          ...(f.kind ? { kind: f.kind } : {}),
          ...(f.from || f.to
            ? {
                receivedOn: {
                  ...(f.from ? { gte: day(f.from) } : {}),
                  ...(f.to ? { lte: day(f.to) } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      });
      const open = await openActionCounts(
        tx,
        rows.map((r) => r.id),
      );
      return { data: rows.map((r) => dto(r, open.get(r.id) ?? 0)) };
    });
  }

  @RequirePermission(MANAGE)
  @Post('feedback')
  async create(@Hub() hub: HubRequestContext, @Body() raw: unknown): Promise<FeedbackDto> {
    const input = body(FeedbackCreate, raw);
    if (input.receivedOn > londonDate(new Date()))
      throw new HubError('VALIDATION_FAILED', 400, 'The received date cannot be in the future');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      if (input.locationId) {
        const loc = await tx.location.findUnique({ where: { id: input.locationId } });
        if (!loc || (hub.locationIds && !hub.locationIds.includes(loc.id))) throw notFound();
      }
      const row = await tx.feedbackItem.create({
        data: {
          organisationId: hub.orgId as string,
          locationId: input.locationId ?? null,
          kind: input.kind,
          receivedOn: day(input.receivedOn),
          source: input.source,
          summary: input.summary,
          rating: input.rating ?? null,
          themes: [...new Set(input.themes)],
          createdBy: hub.user.id,
        },
      });
      await audit(this.db, tx, hub, {
        action: 'events.feedback.create',
        entity: 'feedback_item',
        entityId: row.id,
        summary: { kind: input.kind },
      });
      return dto(row, 0);
    });
  }

  /** Counts by theme over a period (default: the last 90 days), feedback and complaints together. */
  @RequirePermission(VIEW)
  @Get('feedback/themes')
  async themes(@Hub() hub: HubRequestContext, @Query() q: unknown): Promise<FeedbackThemesDto> {
    const f = body(FeedbackQuery, q);
    const to = f.to ?? londonDate(new Date());
    const from = f.from ?? iso(new Date(day(to).getTime() - 90 * 86_400_000));
    if (to < from) throw new HubError('VALIDATION_FAILED', 400, 'to must not be before from');
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const feedback = await tx.feedbackItem.findMany({
        where: { ...scope(hub), receivedOn: { gte: day(from), lte: day(to) } },
        select: { kind: true, themes: true, rating: true },
      });
      // Complaint events by occurrence day (London). Restricted safeguarding is hidden by RLS.
      const complaints = await tx.event.findMany({
        where: {
          types: { has: 'COMPLAINT' },
          occurredAt: { gte: day(from), lt: new Date(day(to).getTime() + 86_400_000) },
          ...(hub.locationIds ? { locationId: { in: [...hub.locationIds] } } : {}),
        },
        select: { themes: true },
      });
      type Acc = {
        compliments: number;
        staffFeedback: number;
        patientSurveys: number;
        complaints: number;
        ratings: number[];
      };
      const by = new Map<string, Acc>();
      const slot = (t: string): Acc => {
        let a = by.get(t);
        if (!a)
          by.set(
            t,
            (a = {
              compliments: 0,
              staffFeedback: 0,
              patientSurveys: 0,
              complaints: 0,
              ratings: [],
            }),
          );
        return a;
      };
      let untagged = 0;
      for (const r of feedback) {
        if (r.themes.length === 0) untagged++;
        for (const t of new Set(r.themes.map((x) => x.trim().toLowerCase()))) {
          const a = slot(t);
          if (r.kind === 'COMPLIMENT') a.compliments++;
          else if (r.kind === 'STAFF_FEEDBACK') a.staffFeedback++;
          else a.patientSurveys++;
          if (r.rating !== null) a.ratings.push(r.rating);
        }
      }
      for (const c of complaints) {
        if (c.themes.length === 0) untagged++;
        for (const t of new Set(c.themes.map((x) => x.trim().toLowerCase()))) slot(t).complaints++;
      }
      const themes = [...by.entries()]
        .map(([theme, a]) => ({
          theme,
          compliments: a.compliments,
          staffFeedback: a.staffFeedback,
          patientSurveys: a.patientSurveys,
          complaints: a.complaints,
          total: a.compliments + a.staffFeedback + a.patientSurveys + a.complaints,
          averageRating: a.ratings.length
            ? Math.round((a.ratings.reduce((s, n) => s + n, 0) / a.ratings.length) * 10) / 10
            : null,
        }))
        .sort((x, y) => y.total - x.total || x.theme.localeCompare(y.theme));
      return {
        from,
        to,
        themes,
        totals: { feedback: feedback.length, complaints: complaints.length, untagged },
      };
    });
  }

  @OrgMember()
  @Post('feedback/:id/actions')
  async action(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ) {
    requireAny(hub, MANAGE, 'compliance.action.manage');
    const input = body(FeedbackActionInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const fb = await tx.feedbackItem.findFirst({ where: { id, ...scope(hub) } });
      if (!fb) throw notFound();
      if (
        !(await tx.membership.count({
          where: { userId: input.ownerUserId, validTo: null, user: { status: 'ACTIVE' } },
        }))
      )
        throw new HubError('VALIDATION_FAILED', 400, 'The person is not an active member');
      const a = await createAction(tx, {
        organisationId: fb.organisationId,
        sourceType: 'FEEDBACK',
        sourceId: id,
        title: input.title,
        severity: input.severity ?? 'LOW',
        ownerUserId: input.ownerUserId,
        deadline: input.deadline,
        by: hub.user.id,
      });
      await audit(this.db, tx, hub, {
        action: 'compliance.action.create',
        entity: 'action',
        entityId: a.id,
        summary: { feedbackId: id },
      });
      return toActionDto(
        await tx.action.findUniqueOrThrow({ where: { id: a.id }, include: { history: true } }),
      );
    });
  }
}
