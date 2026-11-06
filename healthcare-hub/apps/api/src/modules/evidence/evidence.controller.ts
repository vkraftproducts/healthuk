import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  StreamableFile,
} from '@nestjs/common';
import {
  advanceDeadlineAfterVerification,
  recomputeForEvidenceItem,
  recomputeInstance,
} from '@hub/domain';
import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import {
  LinkInput,
  MAX_EVIDENCE_BYTES,
  UploadRequest,
  VerifyInput,
  type EvidenceVersionDto,
  type ReviewQueueItemDto,
} from '@hub/contracts';
import { Public, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { CONFIG, type AppConfig } from '../../config.js';
import { DB } from '../../db.provider.js';
import { BLOB_STORE, sha256, type BlobStore } from '../../storage/blob-store.js';
import { SCANNER, type Scanner } from '../../storage/scanner.js';
import { signBlobToken, verifyBlobToken } from '../../storage/tokens.js';
import { canSeeEvidence, toEvidenceDto, versionInclude, withNames } from './evidence.mapper.js';

const idPipe = new ParseUUIDPipe({ version: '7', exceptionFactory: () => notFound() });
const UPLOAD_TTL_S = 15 * 60;
const DOWNLOAD_TTL_S = 60;
const d = (s: string | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);

@Controller('evidence')
export class EvidenceController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BLOB_STORE) private readonly store: BlobStore,
    @Inject(SCANNER) private readonly scanner: Scanner,
  ) {}

  @RequirePermission('compliance.evidence.upload')
  @Post('uploads')
  async requestUpload(@Hub() hub: HubRequestContext, @Body() raw: unknown) {
    const input = body(UploadRequest, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const orgId = hub.orgId as string;
      let itemId = input.itemId;
      if (itemId) {
        const item = await tx.evidenceItem.findUnique({ where: { id: itemId } });
        if (!item || !canSeeEvidence(hub, item.sensitivity, item.createdBy)) throw notFound();
      } else {
        itemId = (
          await tx.evidenceItem.create({
            data: {
              organisationId: orgId,
              title: input.title,
              sensitivity: input.sensitivity,
              createdBy: hub.user.id,
            },
          })
        ).id;
      }
      if (input.requirementInstanceIds.length > 0)
        await assertLinkable(tx, hub, input.requirementInstanceIds);
      const last = await tx.evidenceVersion.aggregate({
        where: { itemId },
        _max: { versionNo: true },
      });
      const versionNo = (last._max.versionNo ?? 0) + 1;
      const v = await tx.evidenceVersion.create({
        data: {
          organisationId: orgId,
          itemId,
          versionNo,
          blobKey: `${orgId}/${itemId}/${versionNo}-${randomUUID()}`,
          declaredMime: input.mime,
          declaredSize: BigInt(input.sizeBytes),
          uploadedBy: hub.user.id,
          validFrom: d(input.validFrom),
          validTo: d(input.validTo),
        },
      });
      if (input.requirementInstanceIds.length > 0) {
        await tx.evidenceLink.createMany({
          data: input.requirementInstanceIds.map((instanceId) => ({
            organisationId: orgId,
            itemId: itemId as string,
            instanceId,
            createdBy: hub.user.id,
          })),
          skipDuplicates: true,
        });
      }
      const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_S;
      const token = signBlobToken(
        { v: v.id, o: orgId, m: 'PUT', e: exp, max: input.sizeBytes },
        this.config.BLOB_SIGNING_SECRET,
      );
      await audit(this.db, tx, hub, {
        action: 'evidence.upload.request',
        entity: 'evidence_version',
        entityId: v.id,
        summary: { versionNo, sensitivity: input.sensitivity },
      });
      return {
        evidenceItemId: itemId,
        evidenceVersionId: v.id,
        method: 'PUT' as const,
        maxBytes: input.sizeBytes,
        uploadUrl: `${this.config.PUBLIC_API_URL}/api/v1/evidence/blob/${token}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    });
  }

  /** Bytes land in quarantine only. Authorisation is the signed, short-lived token. */
  @Public()
  @Put('blob/:token')
  async putBlob(
    @Param('token') token: string,
    @Body() raw: unknown,
  ): Promise<{ received: number }> {
    const claims = verifyBlobToken(token, this.config.BLOB_SIGNING_SECRET, new Date());
    if (claims?.m !== 'PUT' || claims.k !== undefined)
      throw new HubError('FORBIDDEN', 403, 'Upload link is invalid or has expired');
    if (!Buffer.isBuffer(raw) || raw.length === 0)
      throw new HubError('UPLOAD_REJECTED', 422, 'No file content received');
    if (raw.length > Math.min(claims.max ?? MAX_EVIDENCE_BYTES, MAX_EVIDENCE_BYTES))
      throw new HubError('UPLOAD_REJECTED', 422, 'File is larger than declared');
    const key = await this.db.withTenant(
      { orgId: claims.o, userId: SYSTEM_USER_ID },
      async (tx) => {
        const v = await tx.evidenceVersion.findUnique({
          where: { id: claims.v },
          select: { blobKey: true, uploadedAt: true },
        });
        if (!v || v.uploadedAt) return null; // unknown, or already completed (evidence is immutable)
        return v.blobKey;
      },
    );
    if (!key) throw new HubError('FORBIDDEN', 403, 'Upload link is invalid or has expired');
    await this.store.put(key, raw);
    return { received: raw.length };
  }

  @RequirePermission('compliance.evidence.upload')
  @Post(':versionId/complete')
  async complete(
    @Hub() hub: HubRequestContext,
    @Param('versionId', idPipe) versionId: string,
  ): Promise<EvidenceVersionDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.evidenceVersion.findUnique({
        where: { id: versionId },
        include: versionInclude,
      });
      if (!v || v.uploadedBy !== hub.user.id) throw notFound();
      if (v.uploadedAt) return toEvidenceDto(v); // idempotent
      const bytes = await this.store.get(v.blobKey);
      if (!bytes)
        throw new HubError('UPLOAD_REJECTED', 422, 'No file has been uploaded for this version');
      const now = new Date();
      const hash = sha256(bytes);
      let status: 'CLEAN' | 'MALICIOUS' | 'FAILED';
      let mime: string | null = null;
      let reason: string | null;
      if (BigInt(bytes.length) !== v.declaredSize) {
        status = 'FAILED';
        reason = 'Size does not match the declared size';
      } else {
        const r = await this.scanner.scan(bytes, v.declaredMime);
        status = r.status;
        mime = r.detectedMime;
        reason = r.reason;
      }
      await tx.evidenceVersion.update({
        where: { id: versionId },
        data: {
          uploadedAt: now,
          scannedAt: now,
          scanStatus: status,
          sha256: hash,
          sizeBytes: BigInt(bytes.length),
          mime: status === 'CLEAN' ? mime : null,
        },
      });
      if (status !== 'CLEAN') {
        await this.store.delete(v.blobKey);
        await tx.alert.create({
          data: {
            organisationId: v.organisationId,
            sourceType: 'EVIDENCE',
            sourceId: v.id,
            severity: 'HIGH',
            reasonCode: status === 'MALICIOUS' ? 'MALWARE_DETECTED' : 'UPLOAD_FAILED',
            reasonText: `Upload ${status === 'MALICIOUS' ? 'quarantined' : 'failed'}: ${reason ?? 'check failed'}`,
            ownerUserId: hub.user.id,
            raisedAt: now,
          },
        });
      }
      await recomputeForEvidenceItem(tx, v.itemId, now);
      await audit(this.db, tx, hub, {
        action: 'evidence.upload.complete',
        entity: 'evidence_version',
        entityId: v.id,
        summary: { scan: status },
      });
      return toEvidenceDto(
        await tx.evidenceVersion.findUniqueOrThrow({
          where: { id: versionId },
          include: versionInclude,
        }),
      );
    });
  }

  /**
   * B4 review queue: scanned, clean, linked documents with no decision yet, oldest first, with what
   * each one is evidence for. Location-scoped reviewers see their locations and organisation items.
   */
  @RequirePermission('compliance.evidence.verify')
  @Get('review-queue')
  async reviewQueue(@Hub() hub: HubRequestContext): Promise<{ data: ReviewQueueItemDto[] }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const rows = await tx.evidenceVersion.findMany({
        where: {
          uploadedAt: { not: null },
          scanStatus: 'CLEAN',
          verification: null,
          item: { links: { some: {} } },
        },
        include: versionInclude,
        orderBy: { uploadedAt: 'asc' },
        take: 200,
      });
      const visible = rows.filter((r) => canSeeEvidence(hub, r.item.sensitivity, r.uploadedBy));
      const instanceIds = [
        ...new Set(visible.flatMap((r) => r.item.links.map((l) => l.instanceId))),
      ];
      const instances = await tx.requirementInstance.findMany({
        where: { id: { in: instanceIds } },
        include: {
          template: { select: { title: true } },
          templateVersion: { select: { deadlineKind: true } },
        },
      });
      const ids = (t: string) =>
        instances.filter((i) => i.subjectType === t).map((i) => i.subjectId);
      const label = new Map<string, string>();
      for (const s of await tx.staff.findMany({ where: { id: { in: ids('STAFF') } } }))
        label.set(s.id, `${s.displayName} (${s.staffNo})`);
      for (const v of await tx.vehicle.findMany({ where: { id: { in: ids('VEHICLE') } } }))
        label.set(v.id, `${v.callsign} ${v.registration}`);
      for (const a of await tx.equipmentAsset.findMany({ where: { id: { in: ids('EQUIPMENT') } } }))
        label.set(a.id, `${a.category} ${a.assetTag}`);
      for (const l of await tx.location.findMany({ where: { id: { in: ids('PREMISES') } } }))
        label.set(l.id, l.name);
      const inScope = (i: (typeof instances)[number]) =>
        !hub.locationIds || !i.locationId || hub.locationIds.includes(i.locationId);
      const named = await withNames(tx, visible.map(toEvidenceDto));
      const data: ReviewQueueItemDto[] = [];
      named.forEach((dto, n) => {
        const reqs = instances.filter(
          (i) => visible[n]!.item.links.some((l) => l.instanceId === i.id) && inScope(i),
        );
        if (reqs.length === 0) return;
        data.push({
          ...dto,
          mine: dto.uploadedBy === hub.user.id,
          requirements: reqs.map((i) => ({
            instanceId: i.id,
            templateTitle: i.template.title,
            deadlineKind: i.templateVersion.deadlineKind,
            subjectType: i.subjectType,
            subjectId: i.subjectId,
            subjectLabel:
              label.get(i.subjectId) ?? (i.subjectType === 'ORGANISATION' ? 'Organisation' : '—'),
          })),
        });
      });
      return { data };
    });
  }

  @RequirePermission('compliance.evidence.verify')
  @Post(':versionId/verify')
  async verify(
    @Hub() hub: HubRequestContext,
    @Param('versionId', idPipe) versionId: string,
    @Body() raw: unknown,
  ): Promise<EvidenceVersionDto> {
    const input = body(VerifyInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.evidenceVersion.findUnique({
        where: { id: versionId },
        include: versionInclude,
      });
      if (!v || !canSeeEvidence(hub, v.item.sensitivity, v.uploadedBy)) throw notFound();
      if (v.uploadedBy === hub.user.id)
        throw new HubError('FORBIDDEN', 403, 'You cannot verify evidence you uploaded');
      if (!v.uploadedAt || v.scanStatus !== 'CLEAN')
        throw new HubError(
          'EVIDENCE_NOT_VERIFIED',
          409,
          'Only scanned, clean evidence can be verified',
        );
      if (v.verification)
        throw new HubError('CONFLICT', 409, 'This version already has a decision');
      const instanceIds = v.item.links.map((l) => l.instanceId);
      if (instanceIds.length === 0)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          'Link the evidence to a requirement before verifying it',
        );
      const now = new Date();

      if (input.decision === 'ACCEPTED') {
        const instances = await tx.requirementInstance.findMany({
          where: { id: { in: instanceIds } },
          include: { templateVersion: true },
        });
        for (const i of instances) {
          const hasEnd = Boolean(input.confirmedValidTo ?? v.validTo?.toISOString());
          const rec = i.templateVersion.recurrence as { interval?: unknown };
          if (i.templateVersion.deadlineKind === 'EXPIRY' && !hasEnd && !rec.interval) {
            throw new HubError(
              'VALIDATION_FAILED',
              400,
              'An expiry date is required to verify this evidence',
            );
          }
        }
      }
      await tx.verification.create({
        data: {
          organisationId: v.organisationId,
          evidenceVersionId: v.id,
          decision: input.decision,
          reason: input.reason ?? null,
          reviewerId: hub.user.id,
          confirmedValidTo: input.decision === 'ACCEPTED' ? d(input.confirmedValidTo) : null,
        },
      });
      if (input.decision === 'ACCEPTED') {
        const validTo = input.confirmedValidTo ?? v.validTo?.toISOString().slice(0, 10) ?? null;
        for (const id of instanceIds) {
          await advanceDeadlineAfterVerification(
            tx,
            id,
            {
              validFrom: v.validFrom?.toISOString().slice(0, 10) ?? null,
              validTo,
              capturedAt: v.capturedAt,
            },
            hub.user.id,
            now,
          );
        }
      }
      for (const id of instanceIds) await recomputeInstance(tx, id, now);
      await audit(this.db, tx, hub, {
        action: 'evidence.verify',
        entity: 'evidence_version',
        entityId: v.id,
        summary: { decision: input.decision },
      });
      return toEvidenceDto(
        await tx.evidenceVersion.findUniqueOrThrow({
          where: { id: versionId },
          include: versionInclude,
        }),
      );
    });
  }

  @RequirePermission('compliance.evidence.upload')
  @Post(':itemId/links')
  async link(
    @Hub() hub: HubRequestContext,
    @Param('itemId', idPipe) itemId: string,
    @Body() raw: unknown,
  ): Promise<{ linked: number }> {
    const input = body(LinkInput, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const item = await tx.evidenceItem.findUnique({ where: { id: itemId } });
      if (!item || !canSeeEvidence(hub, item.sensitivity, item.createdBy)) throw notFound();
      const ids = [...new Set(input.requirementInstanceIds)];
      await assertLinkable(tx, hub, ids);
      const r = await tx.evidenceLink.createMany({
        data: ids.map((instanceId) => ({
          organisationId: item.organisationId,
          itemId,
          instanceId,
          createdBy: hub.user.id,
        })),
        skipDuplicates: true,
      });
      await recomputeForEvidenceItem(tx, itemId, new Date());
      await audit(this.db, tx, hub, {
        action: 'evidence.link',
        entity: 'evidence_item',
        entityId: itemId,
        summary: { linked: r.count },
      });
      return { linked: r.count };
    });
  }

  @RequirePermission('compliance.requirement.view')
  @Get(':versionId/download')
  async download(
    @Hub() hub: HubRequestContext,
    @Param('versionId', idPipe) versionId: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const v = await tx.evidenceVersion.findUnique({
        where: { id: versionId },
        include: { item: true },
      });
      if (!v || !canSeeEvidence(hub, v.item.sensitivity, v.uploadedBy)) throw notFound();
      // Unscanned, quarantined or failed files are never downloadable.
      if (!v.uploadedAt || v.scanStatus !== 'CLEAN')
        throw new HubError('EVIDENCE_NOT_VERIFIED', 409, 'This file has not passed scanning');
      const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_S;
      const token = signBlobToken(
        { v: v.id, o: v.organisationId, m: 'GET', e: exp },
        this.config.BLOB_SIGNING_SECRET,
      );
      await audit(this.db, tx, hub, {
        action: 'evidence.download',
        entity: 'evidence_version',
        entityId: v.id,
      });
      return {
        url: `${this.config.PUBLIC_API_URL}/api/v1/evidence/blob/${token}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    });
  }

  @Public()
  @Get('blob/:token')
  async getBlob(@Param('token') token: string): Promise<StreamableFile> {
    const claims = verifyBlobToken(token, this.config.BLOB_SIGNING_SECRET, new Date());
    if (claims?.m !== 'GET' || claims.k !== undefined)
      throw new HubError('FORBIDDEN', 403, 'Download link is invalid or has expired');
    const v = await this.db.withTenant({ orgId: claims.o, userId: SYSTEM_USER_ID }, (tx) =>
      tx.evidenceVersion.findUnique({
        where: { id: claims.v },
        select: { blobKey: true, mime: true, scanStatus: true },
      }),
    );
    if (v?.scanStatus !== 'CLEAN') throw notFound();
    const bytes = await this.store.get(v.blobKey);
    if (!bytes) throw notFound();
    return new StreamableFile(bytes, {
      type: v.mime ?? 'application/octet-stream',
      disposition: 'attachment; filename="evidence"',
    });
  }
}

/**
 * Evidence may be linked only to requirements the caller can see. Staff requirements of OTHER
 * people additionally need a staff-management permission: self-service users (crew) can only
 * attach evidence to their own items (PRD §4.3 self-service). Unknown or forbidden ids are 404.
 */
async function assertLinkable(tx: TenantTx, hub: HubRequestContext, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await tx.requirementInstance.findMany({
    where: { id: { in: unique } },
    select: { subjectType: true, subjectId: true },
  });
  if (rows.length !== unique.length) throw notFound();
  const manager =
    hub.permissions.has('staff.profile.manage') ||
    hub.permissions.has('compliance.requirement.manage');
  if (manager) return;
  const staffIds = [
    ...new Set(rows.filter((r) => r.subjectType === 'STAFF').map((r) => r.subjectId)),
  ];
  if (staffIds.length === 0) return;
  const own = await tx.staff.count({ where: { id: { in: staffIds }, userId: hub.user.id } });
  if (own !== staffIds.length) throw notFound();
}
