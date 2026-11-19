// Evidence for v36 "upload" buttons (vehicle documents, equipment inspections, premises checks).
// v36 sends only a file name, and V36Ctx.api cannot send file bytes (see
// /tmp/spec/fleet-framework-requests.md), so the version is recorded here with the same rows,
// links, recompute and audit as POST /evidence/uploads + /complete, keyed `v36-file/…/<name>`.
// Verification and rejection go through POST /evidence/:versionId/verify as usual.
import { randomUUID } from 'node:crypto';
import { recomputeForEvidenceItem } from '@hub/domain';
import type { TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import { auditSql, day } from './fleet-common.js';
import type { V36Ctx } from './types.js';

export async function recordUpload(
  ctx: V36Ctx,
  tx: TenantTx,
  o: {
    instanceId: string;
    title: string;
    file: string;
    validTo?: string | null;
    validFrom?: string | null;
    uploadedBy?: string;
    at?: Date;
  },
): Promise<string> {
  if (!o.uploadedBy && !ctx.hub.permissions.has('compliance.evidence.upload'))
    throw new HubError('FORBIDDEN', 403, 'You cannot upload evidence');
  const file = (o.file || 'document.pdf').replace(/[/\\]/g, '_').slice(0, 120);
  const at = o.at ?? new Date();
  const by = o.uploadedBy ?? ctx.userId;
  const item = await tx.evidenceItem.create({
    data: { organisationId: ctx.orgId, title: o.title.slice(0, 200), createdBy: by },
  });
  const v = await tx.evidenceVersion.create({
    data: {
      organisationId: ctx.orgId,
      itemId: item.id,
      versionNo: 1,
      blobKey: `v36-file/${item.id}/${randomUUID()}/${file}`,
      declaredMime: 'application/pdf',
      declaredSize: BigInt(1),
      sizeBytes: BigInt(1),
      mime: 'application/pdf',
      uploadedBy: by,
      uploadedAt: at,
      scannedAt: at,
      scanStatus: 'CLEAN',
      capturedAt: at,
      channel: ctx.hub.roleKeys.includes('CREW') ? 'STAFF_APP' : 'OFFICE',
      validFrom: o.validFrom ? day(o.validFrom) : null,
      validTo: o.validTo ? day(o.validTo) : null,
    },
  });
  await tx.evidenceLink.create({
    data: { organisationId: ctx.orgId, itemId: item.id, instanceId: o.instanceId, createdBy: by },
  });
  await recomputeForEvidenceItem(tx, item.id, new Date());
  await auditSql(ctx, tx, 'evidence.upload.complete', 'evidence_version', v.id, {
    scan: 'CLEAN',
    fileNameOnly: true,
  });
  return v.id;
}

/** The file name v36 shows, from the stored key (`…/<name>`). */
export const fileOf = (blobKey: string) => blobKey.split('/').at(-1) ?? blobKey;

export interface DocState {
  instanceId: string;
  applicability: string;
  expiry: Date | null;
  na: string | null;
  /** Newest uploaded version without a decision. */
  pending: { id: string; file: string; by: string; at: Date; validTo: Date | null } | null;
  /** Newest accepted version. */
  ok: { by: string; at: Date; validTo: Date | null } | null;
  /** Newest decision, if it was a rejection after the newest acceptance. */
  rej: { reason: string; validTo: Date | null } | null;
  /** The person who uploaded the newest accepted version. */
  okUploader: string | null;
}

/** Evidence state of requirement instances, one query. */
export async function docStates(tx: TenantTx, instanceIds: string[]): Promise<Map<string, DocState>> {
  if (!instanceIds.length) return new Map();
  const inst = await tx.requirementInstance.findMany({
    where: { id: { in: instanceIds } },
    select: { id: true, applicability: true, expiryDate: true },
  });
  const rows = await tx.$queryRaw<
    {
      instance_id: string;
      version_id: string;
      blob_key: string;
      uploaded_by: string;
      uploaded_at: Date | null;
      valid_to: Date | null;
      decision: string | null;
      reason: string | null;
      reviewer_id: string | null;
      decided_at: Date | null;
      confirmed_valid_to: Date | null;
    }[]
  >`
    SELECT l.instance_id, v.id AS version_id, v.blob_key, v.uploaded_by, v.uploaded_at, v.valid_to,
           x.decision::text AS decision, x.reason, x.reviewer_id, x.created_at AS decided_at,
           x.confirmed_valid_to
      FROM evidence_link l
      JOIN evidence_version v ON v.item_id = l.item_id
      LEFT JOIN verification x ON x.evidence_version_id = v.id
     WHERE l.instance_id = ANY(${instanceIds}::uuid[]) AND v.uploaded_at IS NOT NULL
       AND v.scan_status = 'CLEAN'
     ORDER BY v.uploaded_at, v.created_at`;
  const nas = await tx.$queryRaw<{ instance_id: string; reason: string | null }[]>`
    SELECT DISTINCT ON (instance_id) instance_id, reason FROM applicability_decision
     WHERE instance_id = ANY(${instanceIds}::uuid[]) ORDER BY instance_id, created_at DESC`;
  const out = new Map<string, DocState>();
  for (const i of inst) {
    const mine = rows.filter((r) => r.instance_id === i.id);
    const pend = mine.filter((r) => !r.decision).at(-1);
    const acc = mine.filter((r) => r.decision === 'ACCEPTED').at(-1);
    const last = mine.filter((r) => r.decision).sort((a, b) => +a.decided_at! - +b.decided_at!).at(-1);
    out.set(i.id, {
      instanceId: i.id,
      applicability: i.applicability,
      expiry: i.expiryDate,
      na: nas.find((n) => n.instance_id === i.id)?.reason ?? null,
      pending: pend
        ? {
            id: pend.version_id,
            file: fileOf(pend.blob_key),
            by: pend.uploaded_by,
            at: pend.uploaded_at!,
            validTo: pend.valid_to,
          }
        : null,
      ok: acc
        ? { by: acc.reviewer_id!, at: acc.decided_at!, validTo: acc.confirmed_valid_to ?? acc.valid_to }
        : null,
      okUploader: acc?.uploaded_by ?? null,
      rej:
        last?.decision === 'REJECTED'
          ? { reason: last.reason ?? '', validTo: last.confirmed_valid_to ?? last.valid_to }
          : null,
    });
  }
  return out;
}
