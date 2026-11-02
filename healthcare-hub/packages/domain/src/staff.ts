import type { TenantTx } from '@hub/db';
import {
  licenceCovers,
  readinessLifecycle,
  staffReadiness,
  type CheckGroup,
  type Readiness,
  type StaffLifecycle,
} from '@hub/rules';
import { evaluateInstanceDetail, recomputeInstance } from './recompute.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Roles the person currently holds (unrevoked and inside the approval's validity). */
export async function activeRoles(tx: TenantTx, staffId: string, at: Date): Promise<string[]> {
  const rows = await tx.staffRoleApproval.findMany({
    where: {
      staffId,
      revokedAt: null,
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    },
    select: { role: true },
  });
  return [...new Set(rows.map((r) => r.role))];
}

/** Restrictions in force at `at` (immediate effect on future allocations, PRD §4.3). */
export async function activeRestrictions(tx: TenantTx, staffId: string, at: Date) {
  return tx.staffRestriction.findMany({
    where: {
      staffId,
      liftedAt: null,
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
    },
  });
}

export interface RequiredSet {
  /** Templates the person's roles require. */
  required: Set<string>;
  /** Templates that some role maps (so "not required for this person" is meaningful). */
  mapped: Set<string>;
}

export async function requiredTemplates(
  tx: TenantTx,
  roles: readonly string[],
): Promise<RequiredSet> {
  const all = await tx.roleRequirement.findMany({ select: { role: true, templateId: true } });
  return {
    required: new Set(all.filter((r) => roles.includes(r.role)).map((r) => r.templateId)),
    mapped: new Set(all.map((r) => r.templateId)),
  };
}

/**
 * An instance counts for the person when their roles require it, or when it was added by hand
 * (its template is not mapped to any role). Mapped-but-not-required items stay on record and
 * visible, but do not block (HR-03: role change recalculates what is required).
 */
export const isRequired = (templateId: string, set: RequiredSet): boolean =>
  set.required.has(templateId) || !set.mapped.has(templateId);

/**
 * HR-03: creates any missing requirement instances for the templates the person's current roles
 * require (from each template's EFFECTIVE version). Idempotent. Returns the ids created.
 */
export async function syncStaffRequirements(
  tx: TenantTx,
  staffId: string,
  actorUserId: string,
  now: Date,
): Promise<string[]> {
  const staff = await tx.staff.findUniqueOrThrow({ where: { id: staffId } });
  if (staff.lifecycleState === 'LEAVER') return [];
  const roles = await activeRoles(tx, staffId, now);
  const { required } = await requiredTemplates(tx, roles);
  if (required.size === 0) return [];
  const existing = new Set(
    (
      await tx.requirementInstance.findMany({
        where: { subjectType: 'STAFF', subjectId: staffId },
        select: { templateId: true },
      })
    ).map((i) => i.templateId),
  );
  const created: string[] = [];
  for (const templateId of required) {
    if (existing.has(templateId)) continue;
    const v = await tx.requirementTemplateVersion.findFirst({
      where: { templateId, status: 'EFFECTIVE', subjectType: 'STAFF' },
    });
    if (!v) continue; // not published yet: created when it is (next sync)
    const i = await tx.requirementInstance.create({
      data: {
        organisationId: staff.organisationId,
        templateId,
        templateVersionId: v.id,
        subjectType: 'STAFF',
        subjectId: staffId,
        locationId: staff.primaryLocationId,
        ownerUserId: staff.userId,
        createdBy: actorUserId,
      },
    });
    await recomputeInstance(tx, i.id, now);
    created.push(i.id);
  }
  return created;
}

/** Re-syncs every non-leaver who holds `role` (after the role's requirements change). */
export async function syncRole(
  tx: TenantTx,
  role: string,
  actorUserId: string,
  now: Date,
): Promise<number> {
  const holders = await tx.staffRoleApproval.findMany({
    where: { role: role as never, revokedAt: null },
    select: { staffId: true },
    distinct: ['staffId'],
  });
  let n = 0;
  for (const h of holders)
    n += (await syncStaffRequirements(tx, h.staffId, actorUserId, now)).length;
  return n;
}

function groupFor(code: string): CheckGroup {
  if (/LICEN[CS]E|DRIV/.test(code)) return 'LICENCE';
  if (/TRAIN|COMPET|MANUAL|HANDLING|BLS|ILS/.test(code)) return 'COMPETENCE';
  return 'CLEARANCE';
}

export interface StaffReadinessArgs {
  staffId: string;
  role: string;
  window: { start: Date; end: Date };
  licenceCategory?: string;
  competencies?: readonly string[];
  now: Date;
}

/**
 * Readiness for one role across a job window (RULES_ENGINE §3). Status is evaluated live, so
 * the answer never depends on the reconciler having run.
 */
export async function staffReadinessFor(
  tx: TenantTx,
  a: StaffReadinessArgs,
): Promise<Readiness & { restrictions: string[] }> {
  const staff = await tx.staff.findUniqueOrThrow({ where: { id: a.staffId } });
  const roles = await activeRoles(tx, a.staffId, a.window.start);
  const set = await requiredTemplates(tx, roles);
  const instances = await tx.requirementInstance.findMany({
    where: { subjectType: 'STAFF', subjectId: a.staffId },
    include: { template: { select: { code: true } } },
  });
  const requirements = [];
  for (const i of instances) {
    if (!isRequired(i.templateId, set)) continue;
    const { result, verified } = await evaluateInstanceDetail(tx, i.id, a.now);
    requirements.push({
      instanceId: i.id,
      code: i.template.code,
      group: groupFor(i.template.code),
      result,
      validFrom: verified?.validFrom ?? null,
      expiryDate: verified?.validTo ?? iso(i.expiryDate),
    });
  }

  const records = await tx.staffRecord.findMany({
    where: { staffId: a.staffId, kind: { in: ['LICENCE', 'COMPETENCY'] }, supersededBy: null },
    orderBy: { createdAt: 'desc' },
  });
  let licenceCategoryCovers: boolean | null = null;
  if (a.licenceCategory) {
    const lic = records.find((r) => r.kind === 'LICENCE');
    const cats = ((lic?.data as { categories?: string[] } | undefined)?.categories ??
      []) as string[];
    licenceCategoryCovers = licenceCovers(cats, a.licenceCategory);
  }
  const endDay = iso(a.window.end) as string;
  const held = new Set(
    records
      .filter((r) => r.kind === 'COMPETENCY')
      .map((r) => r.data as { code: string; outcome: string; expiresOn?: string })
      .filter((d) => d.outcome === 'COMPETENT' && (!d.expiresOn || d.expiresOn >= endDay))
      .map((d) => d.code),
  );
  const restrictions = (await activeRestrictions(tx, a.staffId, a.window.start)).map((r) => r.type);
  const r = staffReadiness(
    {
      lifecycle: readinessLifecycle(staff.lifecycleState as StaffLifecycle),
      roleApproved: roles.includes(a.role),
      licenceCategoryCovers,
      requirements,
      missingCompetencies: (a.competencies ?? []).filter((c) => !held.has(c)),
      restrictions,
    },
    a.window,
  );
  // A NO_DRIVING restriction is a hard block for a driving role, not just a "restricted" flag.
  if (a.role === 'DRIVER' && restrictions.includes('NO_DRIVING')) {
    r.checks.push({
      code: 'RESTRICTION_NO_DRIVING',
      group: 'CLEARANCE',
      result: 'FAIL',
      reasonText: 'Restricted from driving',
      overridable: false,
    });
    r.state = 'BLOCKED';
  }
  return { ...r, restrictions };
}

/** Worst live status across the person's required items, plus counts (list and profile). */
export async function staffStatusSummary(tx: TenantTx, staffIds: readonly string[], now: Date) {
  const instances = await tx.requirementInstance.findMany({
    where: { subjectType: 'STAFF', subjectId: { in: [...staffIds] } },
    select: { id: true, subjectId: true, templateId: true, status: true },
  });
  const approvals = await tx.staffRoleApproval.findMany({
    where: {
      staffId: { in: [...staffIds] },
      revokedAt: null,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gt: now } }],
    },
    select: { staffId: true, role: true },
  });
  const map = await tx.roleRequirement.findMany({ select: { role: true, templateId: true } });
  const mapped = new Set(map.map((m) => m.templateId));
  const out = new Map<
    string,
    {
      counts: { red: number; amber: number; grey: number; green: number };
      overall: 'RED' | 'AMBER' | 'GREY' | 'GREEN' | 'NOT_APPLICABLE';
      roles: string[];
    }
  >();
  for (const id of staffIds) {
    const roles = [
      ...new Set(approvals.filter((a) => a.staffId === id).map((a) => a.role as string)),
    ];
    const required = new Set(map.filter((m) => roles.includes(m.role)).map((m) => m.templateId));
    const counts = { red: 0, amber: 0, grey: 0, green: 0 };
    for (const i of instances) {
      if (i.subjectId !== id) continue;
      if (!(required.has(i.templateId) || !mapped.has(i.templateId))) continue;
      if (i.status === 'RED') counts.red += 1;
      else if (i.status === 'AMBER') counts.amber += 1;
      else if (i.status === 'GREY') counts.grey += 1;
      else if (i.status === 'GREEN') counts.green += 1;
    }
    const overall = counts.red
      ? 'RED'
      : counts.amber
        ? 'AMBER'
        : counts.grey
          ? 'GREY'
          : counts.green
            ? 'GREEN'
            : 'NOT_APPLICABLE';
    out.set(id, { counts, overall, roles });
  }
  return out;
}
