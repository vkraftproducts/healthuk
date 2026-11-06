import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Db } from '@hub/db';
import { evidenceCoverage, type RequirementResult } from '@hub/rules';
import { InspectionQuery, type InspectionOverviewDto } from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';

const DOMAINS = ['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED'] as const;
const DOMAIN_LABEL: Record<(typeof DOMAINS)[number], string> = {
  SAFE: 'Safe',
  EFFECTIVE: 'Effective',
  CARING: 'Caring',
  RESPONSIVE: 'Responsive',
  WELL_LED: 'Well-led',
};

/**
 * Inspection view (WORKFLOWS L5): the auditor's home page. Read-only, by CQC key question, built
 * from verified evidence only. Staff gaps never name the person or show DBS or health detail.
 * Every view is written to the audit log.
 */
@Controller()
export class InspectionController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission('inspection.view')
  @Get('inspection/overview')
  async overview(
    @Hub() hub: HubRequestContext,
    @Query() q: unknown,
  ): Promise<InspectionOverviewDto> {
    const f = body(InspectionQuery, q);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const loc = f.locationId
        ? await tx.location.findUnique({ where: { id: f.locationId } })
        : null;
      if (f.locationId && !loc) throw notFound();
      const instances = await tx.requirementInstance.findMany({
        where: f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {},
        include: {
          template: { select: { title: true } },
          templateVersion: { select: { frameworkMappings: true } },
        },
      });
      const domainsOf = (maps: unknown): string[] =>
        Array.isArray(maps)
          ? maps.flatMap((m) => {
              const d = (m as { domain?: string }).domain;
              return d ? [d] : [];
            })
          : [];
      const results: RequirementResult[] = instances.map((i) => ({
        status: i.status,
        reasonCode: i.reasonCode as RequirementResult['reasonCode'],
        reasonText: i.reasonText,
        effect: i.effect as RequirementResult['effect'],
        currentlyVerified: i.currentlyVerified,
        daysUntil: null,
      }));
      const runs = await tx.auditRun.findMany({
        where: {
          submittedAt: { not: null },
          ...(f.locationId ? { OR: [{ locationId: f.locationId }, { locationId: null }] } : {}),
        },
        include: { templateVersion: { include: { template: { select: { domain: true } } } } },
        orderBy: { submittedAt: 'desc' },
        take: 200,
      });
      const findings = await tx.auditFinding.findMany({
        where: { runId: { in: runs.map((r) => r.id) } },
        select: { id: true, runId: true },
      });
      const open = await tx.action.findMany({
        where: {
          sourceType: 'FINDING',
          sourceId: { in: findings.map((x) => x.id) },
          status: { not: 'VERIFIED' },
        },
        select: { sourceId: true },
      });
      const runOfFinding = new Map(findings.map((x) => [x.id, x.runId]));
      const policies = await tx.policyDocument.findMany({
        include: { versions: { where: { status: 'PUBLISHED' }, select: { version: true } } },
        orderBy: { code: 'asc' },
      });
      const rating = await tx.cqcRatingRecord.findFirst({
        where: f.locationId ? { locationId: f.locationId } : {},
        orderBy: { publishedOn: 'desc' },
      });
      const ratingLoc = rating?.locationId
        ? await tx.location.findUnique({ where: { id: rating.locationId } })
        : null;
      await audit(this.db, tx, hub, {
        action: 'inspection.view',
        entity: 'organisation',
        entityId: hub.orgId as string,
        summary: { locationId: f.locationId ?? 'all' },
      });
      const cov = evidenceCoverage(results);
      return {
        generatedAt: new Date().toISOString(),
        publishedRating: rating
          ? {
              rating: rating.overall,
              publishedOn: rating.publishedOn.toISOString().slice(0, 10),
              locationName: ratingLoc?.name ?? 'Provider',
            }
          : null,
        coverage: {
          numerator: cov.numerator,
          denominator: cov.denominator,
          percent: cov.percent,
          label: 'Internal measure — not a CQC rating',
        },
        keyQuestions: DOMAINS.map((d) => {
          const mine = instances.filter((i) =>
            domainsOf(i.templateVersion.frameworkMappings).includes(d),
          );
          const applicable = mine.filter((i) => i.status !== 'NOT_APPLICABLE');
          const domainRuns = runs.filter((r) => r.templateVersion.template.domain === d);
          const runIds = new Set(domainRuns.map((r) => r.id));
          return {
            domain: d,
            label: DOMAIN_LABEL[d],
            verified: applicable.filter((i) => i.status === 'GREEN' && i.currentlyVerified).length,
            applicable: applicable.length,
            gaps: applicable
              .filter((i) => i.status !== 'GREEN' || !i.currentlyVerified)
              .slice(0, 50)
              .map((i) =>
                i.subjectType === 'STAFF'
                  ? { title: 'Staff record (details hidden)', reasonText: 'Not verified' }
                  : { title: i.template.title, reasonText: i.reasonText },
              ),
            audits: domainRuns.slice(0, 20).map((r) => ({
              id: r.id,
              code: r.code,
              title: r.title,
              submittedAt: r.submittedAt?.toISOString() ?? null,
              outcome: r.outcome,
            })),
            openActions: open.filter((a) => runIds.has(runOfFinding.get(a.sourceId) ?? '')).length,
            policies:
              d === 'WELL_LED'
                ? policies.map((p) => ({
                    code: p.code,
                    title: p.title,
                    version: p.versions.reduce<number | null>(
                      (m, v) => (m === null || v.version > m ? v.version : m),
                      null,
                    ),
                  }))
                : [],
          };
        }),
      };
    });
  }
}
