import type { InstanceDto, TemplateDto, TemplateVersionDto } from '@hub/contracts';

const d = (x: Date | null | undefined): string | null => (x ? x.toISOString().slice(0, 10) : null);
const dt = (x: Date | null | undefined): string | null => (x ? x.toISOString() : null);

type VersionRow = {
  id: string;
  templateId: string;
  version: number;
  status: TemplateVersionDto['status'];
  basisType: TemplateVersionDto['basisType'];
  regulationRef: string | null;
  sourceUrl: string | null;
  sourceVersionDate: Date | null;
  effectiveFrom: Date | null;
  subjectType: TemplateVersionDto['subjectType'];
  applicabilityRule: unknown;
  evidenceType: string;
  recurrence: unknown;
  warningDays: number[];
  dueSoonDays: number;
  blocking: TemplateVersionDto['blocking'];
  deadlineKind: string;
  approvalRole: string | null;
  frameworkMappings: unknown;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdBy: string | null;
};

export function toVersionDto(v: VersionRow): TemplateVersionDto {
  return {
    id: v.id,
    templateId: v.templateId,
    version: v.version,
    status: v.status,
    basisType: v.basisType,
    ...(v.regulationRef ? { regulationRef: v.regulationRef } : {}),
    ...(v.sourceUrl ? { sourceUrl: v.sourceUrl } : {}),
    ...(v.sourceVersionDate ? { sourceVersionDate: d(v.sourceVersionDate) as string } : {}),
    effectiveFrom: d(v.effectiveFrom),
    subjectType: v.subjectType,
    applicabilityRule: (v.applicabilityRule ?? {}) as Record<string, unknown>,
    evidenceType: v.evidenceType,
    recurrence: v.recurrence as TemplateVersionDto['recurrence'],
    warningDays: v.warningDays,
    dueSoonDays: v.dueSoonDays,
    blocking: v.blocking,
    deadlineKind: v.deadlineKind as TemplateVersionDto['deadlineKind'],
    ...(v.approvalRole ? { approvalRole: v.approvalRole } : {}),
    frameworkMappings: (v.frameworkMappings ?? []) as TemplateVersionDto['frameworkMappings'],
    approvedBy: v.approvedBy,
    approvedAt: dt(v.approvedAt),
    createdBy: v.createdBy,
  };
}

export function toTemplateDto(t: {
  id: string;
  code: string;
  title: string;
  pack: string;
  organisationId: string | null;
  versions: VersionRow[];
}): TemplateDto {
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    pack: t.pack,
    isLibrary: t.organisationId === null,
    versions: [...t.versions].sort((a, b) => b.version - a.version).map(toVersionDto),
  };
}

type InstanceRow = {
  id: string;
  templateId: string;
  templateVersionId: string;
  subjectType: InstanceDto['subjectType'];
  subjectId: string;
  locationId: string | null;
  ownerUserId: string | null;
  deputyUserId: string | null;
  anchorDate: Date | null;
  dueDate: Date | null;
  expiryDate: Date | null;
  reviewDate: Date | null;
  applicability: InstanceDto['applicability'];
  status: InstanceDto['status'];
  reasonCode: string;
  reasonText: string;
  effect: string;
  currentlyVerified: boolean;
  computedAt: Date | null;
  version: number;
  template: { code: string; title: string };
  templateVersion: { deadlineKind: string; blocking: InstanceDto['blocking'] };
};

export const instanceInclude = {
  template: { select: { code: true, title: true } },
  templateVersion: { select: { deadlineKind: true, blocking: true } },
} as const;

export function toInstanceDto(i: InstanceRow): InstanceDto {
  return {
    id: i.id,
    templateId: i.templateId,
    templateCode: i.template.code,
    templateTitle: i.template.title,
    templateVersionId: i.templateVersionId,
    subjectType: i.subjectType,
    subjectId: i.subjectId,
    locationId: i.locationId,
    ownerUserId: i.ownerUserId,
    deputyUserId: i.deputyUserId,
    deadlineKind: i.templateVersion.deadlineKind as InstanceDto['deadlineKind'],
    blocking: i.templateVersion.blocking,
    anchorDate: d(i.anchorDate),
    dueDate: d(i.dueDate),
    expiryDate: d(i.expiryDate),
    reviewDate: d(i.reviewDate),
    applicability: i.applicability,
    status: i.status,
    reasonCode: i.reasonCode,
    reasonText: i.reasonText,
    effect: i.effect as InstanceDto['effect'],
    currentlyVerified: i.currentlyVerified,
    computedAt: dt(i.computedAt),
    version: i.version,
  };
}

export const toDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
