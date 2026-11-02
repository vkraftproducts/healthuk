import type { EvidenceVersionDto } from '@hub/contracts';
import type { TenantTx } from '@hub/db';
import type { HubRequestContext } from '../../common/context.js';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

/**
 * Non-normal evidence (HR, clinical, safeguarding, criminal-offence data) is visible only to people
 * who can see sensitive staff data, to reviewers who must verify it, and to the person who uploaded it.
 */
export function canSeeEvidence(
  hub: HubRequestContext,
  sensitivity: string,
  uploadedBy: string,
): boolean {
  if (sensitivity === 'NORMAL') return true;
  return (
    hub.permissions.has('staff.sensitive.view') ||
    hub.permissions.has('compliance.evidence.verify') ||
    uploadedBy === hub.user.id
  );
}

type VersionRow = {
  id: string;
  itemId: string;
  versionNo: number;
  mime: string | null;
  sizeBytes: bigint | null;
  sha256: string | null;
  scanStatus: EvidenceVersionDto['scanStatus'];
  uploadedBy: string;
  uploadedAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  item: { title: string; sensitivity: string; links: { instanceId: string }[] };
  verification: {
    decision: 'ACCEPTED' | 'REJECTED';
    reason: string | null;
    reviewerId: string;
    createdAt: Date;
    confirmedValidTo: Date | null;
  } | null;
};

export const versionInclude = {
  item: { include: { links: { select: { instanceId: true } } } },
  verification: true,
} as const;

export function toEvidenceDto(v: VersionRow): EvidenceVersionDto {
  const state: EvidenceVersionDto['state'] =
    v.uploadedAt === null
      ? 'AWAITING_UPLOAD'
      : v.scanStatus === 'PENDING'
        ? 'SCANNING'
        : v.scanStatus !== 'CLEAN'
          ? 'QUARANTINED'
          : v.verification
            ? v.verification.decision === 'ACCEPTED'
              ? 'VERIFIED'
              : 'REJECTED'
            : 'PENDING_VERIFICATION';
  return {
    id: v.id,
    itemId: v.itemId,
    versionNo: v.versionNo,
    title: v.item.title,
    sensitivity: v.item.sensitivity,
    mime: v.mime,
    sizeBytes: v.sizeBytes === null ? null : Number(v.sizeBytes),
    sha256: v.sha256,
    scanStatus: v.scanStatus,
    state,
    uploadedBy: v.uploadedBy,
    uploadedAt: iso(v.uploadedAt),
    validFrom: day(v.validFrom),
    validTo: day(v.verification?.confirmedValidTo ?? v.validTo),
    decision: v.verification?.decision ?? null,
    decisionReason: v.verification?.reason ?? null,
    reviewerId: v.verification?.reviewerId ?? null,
    decidedAt: iso(v.verification?.createdAt),
    linkedInstanceIds: v.item.links.map((l) => l.instanceId),
  };
}

export async function evidenceForInstance(
  tx: TenantTx,
  instanceId: string,
  hub: HubRequestContext,
): Promise<EvidenceVersionDto[]> {
  const rows = await tx.evidenceVersion.findMany({
    where: { item: { links: { some: { instanceId } } } },
    include: versionInclude,
    orderBy: [{ createdAt: 'desc' }],
  });
  return rows
    .filter((r) => canSeeEvidence(hub, r.item.sensitivity, r.uploadedBy))
    .map(toEvidenceDto);
}
