import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Db } from '@hub/db';
import { RecordsQuery, type EquipmentInspectionDto } from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { body } from '../../common/http.js';
import { DB } from '../../db.provider.js';

interface InspectionRow {
  id: string;
  created_at: Date;
  decision: string;
  asset_id: string;
  asset_tag: string;
  category: string;
  vehicle_id: string | null;
  check: string;
  reviewer_name: string | null;
}

/**
 * v36 Reports › Records by date: equipment inspections are the second-person decisions on evidence
 * for an equipment check (servicing, LOLER and so on). Read-only; RLS keeps it to the organisation.
 */
@Controller('records')
export class RecordsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('fleet.vehicle.view')
  @Get('equipment-inspections')
  async equipmentInspections(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<{ data: EquipmentInspectionDto[] }> {
    const f = body(RecordsQuery, q);
    const since = new Date(Date.now() - f.days * 86_400_000);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.$queryRaw<InspectionRow[]>`
        SELECT DISTINCT ON (v.id)
               v.id, v.created_at, v.decision, a.id AS asset_id, a.asset_tag, a.category::text AS category,
               a.vehicle_id, t.title AS check, u.display_name AS reviewer_name
          FROM verification v
          JOIN evidence_version ev ON ev.id = v.evidence_version_id
          JOIN evidence_link l ON l.item_id = ev.item_id
          JOIN requirement_instance ri ON ri.id = l.instance_id AND ri.subject_type = 'EQUIPMENT'
          JOIN equipment_asset a ON a.id = ri.subject_id
          JOIN requirement_template t ON t.id = ri.template_id
          LEFT JOIN app_user u ON u.id = v.reviewer_id
         WHERE v.created_at >= ${since}
         ORDER BY v.id, v.created_at DESC
         LIMIT 500`;
      return {
        data: rows
          .map((r) => ({
            id: r.id,
            verifiedAt: r.created_at.toISOString(),
            decision: (r.decision === 'REJECTED' ? 'REJECTED' : 'VERIFIED') as
              | 'VERIFIED'
              | 'REJECTED',
            assetId: r.asset_id,
            assetTag: r.asset_tag,
            category: r.category,
            vehicleId: r.vehicle_id,
            check: r.check,
            reviewerName: r.reviewer_name,
          }))
          .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt)),
      };
    });
  }
}
