import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Db } from '@hub/db';
import { OrgMember } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const PATH = /^demo\/(meta|s[0-9]{1,3}|l[0-9]{1,3})$/;
const Put36 = z.object({ data: z.record(z.string(), z.unknown()) });
/** Read-only people: they see the organisation's copy but cannot change it. */
const READ_ONLY = new Set(['AUDITOR', 'PLATFORM_SUPPORT']);

/**
 * The v36 front end's working copy for the organisation (see migration 0060). v36 saves it in
 * chunks through its shared-copy seam; every member of the organisation sees the same copy.
 */
@Controller('v36/workspace')
export class V36WorkspaceController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @OrgMember()
  @Get('docs/:a/:b')
  async get(@Hub() hub: HubRequestContext, @Param('a') a: string, @Param('b') b: string) {
    const path = `${a}/${b}`;
    if (!PATH.test(path)) throw notFound();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.$queryRaw<{ data: unknown; version: number }[]>`
        SELECT data, version FROM v36_workspace_doc WHERE path = ${path}`;
      return rows[0] ? { exists: true, data: rows[0].data } : { exists: false, data: null };
    });
  }

  @OrgMember()
  @Put('docs/:a/:b')
  async put(
    @Hub() hub: HubRequestContext,
    @Param('a') a: string,
    @Param('b') b: string,
    @Body() raw: unknown,
  ) {
    const path = `${a}/${b}`;
    if (!PATH.test(path)) throw notFound();
    if (hub.support || hub.roleKeys.every((r) => READ_ONLY.has(r)))
      throw new HubError(
        'FORBIDDEN',
        403,
        'This role can view the organisation copy but not change it',
      );
    const { data } = body(Put36, raw);
    const json = JSON.stringify(data);
    if (json.length > 400_000) throw new HubError('VALIDATION_FAILED', 400, 'Chunk too large');
    const orgId = hub.orgId!;
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await tx.$executeRaw`
        INSERT INTO v36_workspace_doc (organisation_id, path, data, updated_by)
        VALUES (${orgId}::uuid, ${path}, ${json}::jsonb, ${hub.user.id}::uuid)
        ON CONFLICT (organisation_id, path)
        DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      return { ok: true };
    });
  }
}
