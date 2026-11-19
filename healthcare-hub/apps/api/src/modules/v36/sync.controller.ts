import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@hub/db';
import { OrgMember } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequest, type HubRequestContext } from '../../common/context.js';
import { body } from '../../common/http.js';
import { HubError } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { V36_ADAPTERS, adapterFor } from './sync/registry.js';
import type { V36Adapter, V36Change, V36Ctx } from './sync/types.js';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Any JSON: records are usually objects, but some v36 collections hold numbers, strings or lists.
const Rec = z.unknown();
const SyncBody = z.object({
  act: z.string().max(60).nullable().default(null),
  today: Day,
  changes: z
    .array(
      z.object({
        key: z.string().max(40),
        id: z.string().min(1).max(80),
        before: Rec,
        after: Rec,
      }),
    )
    .min(1)
    .max(200),
});
const ImportBody = z.object({ today: Day, data: z.record(z.string(), z.unknown()) });
const StateQuery = z.object({ today: Day });
const READ_ONLY = (hub: HubRequestContext) =>
  hub.support || hub.roleKeys.every((r) => r === 'AUDITOR');

/**
 * v36 front end ↔ real tables (see ./sync/types.ts).
 *  GET  state   every connected collection in v36's shape, plus which ones still need importing;
 *  POST sync    the records one v36 button changed; returns those collections as now stored;
 *  POST import  one-time move of the organisation's saved v36 copy into empty tables.
 */
@Controller('v36')
export class V36SyncController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  private ctx(
    req: HubRequest,
    hub: HubRequestContext,
    today: string,
    act: string | null = null,
  ): V36Ctx {
    const app = this.host.httpAdapter.getInstance<FastifyInstance>();
    const headers: Record<string, string> = {};
    for (const h of ['authorization', 'x-org-id', 'user-agent', 'x-forwarded-for']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    return {
      hub,
      orgId: hub.orgId!,
      userId: hub.user.id,
      act,
      today,
      tx: (fn) => this.db.withTenant(tenantOf(hub), fn),
      api: async (method, path, payload, version) => {
        const res = await app.inject({
          method,
          url: path.startsWith('/api/') ? path : `/api/v1${path}`,
          headers: {
            ...headers,
            ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(version !== undefined ? { 'if-match': `"${version}"` } : {}),
          },
          payload: payload === undefined ? undefined : JSON.stringify(payload),
        });
        let json: Record<string, unknown> = {};
        try {
          json = res.body ? (res.json() as Record<string, unknown>) : {};
        } catch {
          /* not JSON */
        }
        if (res.statusCode >= 300)
          throw new HubError(
            (typeof json.code === 'string' ? json.code : 'INTERNAL') as never,
            res.statusCode,
            typeof json.detail === 'string' ? json.detail : undefined,
          );
        return json as never;
      },
    };
  }

  private async loadAll(ctx: V36Ctx, adapters: readonly V36Adapter[]) {
    const out: Record<string, unknown> = {};
    for (const a of adapters) {
      if (a.canRead && !a.canRead(ctx))
        out[a.key] = a.shape === 'map' ? {} : a.shape === 'list' ? [] : null;
      else out[a.key] = await a.load(ctx);
    }
    return out;
  }

  @OrgMember()
  @Get('state')
  async state(@Req() req: HubRequest, @Hub() hub: HubRequestContext, @Query() q: unknown) {
    const { today } = body(StateQuery, q);
    const ctx = this.ctx(req, hub, today);
    const needsImport: string[] = [];
    if (!READ_ONLY(hub))
      for (const a of V36_ADAPTERS)
        if (a.import && a.isEmpty && (await a.isEmpty(ctx))) needsImport.push(a.key);
    // Who v36 shows as "you": the signed-in person, and their staff code if they are staff.
    const staff = await ctx.tx(
      (tx) =>
        tx.$queryRaw<{ staff_no: string }[]>`
        SELECT staff_no FROM staff WHERE user_id = ${hub.user.id}::uuid LIMIT 1`,
    );
    const name = hub.user.displayName;
    const initials = name
      .replace(/^(Dr|Mr|Mrs|Ms|Miss)\.?\s+/i, '')
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
    return {
      me: { name, initials, staffNo: staff[0]?.staff_no ?? null },
      connected: V36_ADAPTERS.map((a) => ({
        key: a.key,
        shape: a.shape,
        idField: a.idField ?? 'id',
        writable: !!a.apply,
      })),
      needsImport,
      data: await this.loadAll(ctx, V36_ADAPTERS),
    };
  }

  @OrgMember()
  @Post('sync')
  async sync(@Req() req: HubRequest, @Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const b = body(SyncBody, raw);
    if (READ_ONLY(hub)) throw new HubError('FORBIDDEN', 403, 'This role is read-only');
    const ctx = this.ctx(req, hub, b.today, b.act);
    const touched = new Map<string, V36Adapter>();
    for (const c of b.changes) {
      const a = adapterFor(c.key);
      if (!a) throw new HubError('VALIDATION_FAILED', 400, `Not a connected collection: ${c.key}`);
      if (!a.apply) throw new HubError('FORBIDDEN', 403, `${c.key} cannot be changed here`);
      touched.set(a.key, a);
    }
    // In order, as v36 made them. Each change is its own transaction (most go through an
    // existing endpoint); on a refusal the screen reloads, so nothing half-applied is shown.
    for (const c of b.changes) await adapterFor(c.key)!.apply!(ctx, c as V36Change);
    return { data: await this.loadAll(ctx, [...touched.values()]) };
  }

  @OrgMember()
  @Post('import')
  async import(@Req() req: HubRequest, @Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const b = body(ImportBody, raw);
    if (READ_ONLY(hub)) throw new HubError('FORBIDDEN', 403, 'This role is read-only');
    const ctx = this.ctx(req, hub, b.today);
    const done: string[] = [];
    for (const a of V36_ADAPTERS) {
      if (!a.import || !a.isEmpty || !(a.key in b.data)) continue;
      if (!(await a.isEmpty(ctx))) continue;
      await a.import(ctx, b.data[a.key] as never, b.data);
      done.push(a.key);
    }
    return { imported: done, data: await this.loadAll(ctx, V36_ADAPTERS) };
  }
}
