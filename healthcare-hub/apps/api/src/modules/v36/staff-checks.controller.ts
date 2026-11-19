import { randomUUID } from 'node:crypto';
import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Db, TenantTx } from '@hub/db';
import { recomputeForEvidenceItem } from '@hub/domain';
import { londonDate } from '@hub/rules';
import { OrgMember, RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { BLOB_STORE, sha256, type BlobStore } from '../../storage/blob-store.js';
import { SCANNER, type Scanner } from '../../storage/scanner.js';
import { idPipe } from './shared.js';
import { CHECK_TEMPLATE, SENSITIVE_CHECKS } from './sync/staff-lib.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const note = z.string().trim().max(1000).optional();
const RequestInput = z.strictObject({ due: day, note });
const ChaseInput = z.strictObject({ due: day, note });
const FollowUpInput = z.strictObject({ due: day.nullable(), note });
const ReceivedInput = z.strictObject({
  fileName: z.string().trim().min(1).max(200),
  validTo: day.nullable().optional(),
  note,
  /** Who supplied it when that is not a member (e.g. the occupational health provider). */
  suppliedBy: z.string().trim().min(1).max(120).optional(),
});
const CommentInput = z.strictObject({ text: z.string().trim().min(1).max(2000) });
const LineManagerInput = z.strictObject({
  userId: z.string().uuid().nullable(),
  /** Kept as words when the line manager is not a member of the organisation. */
  name: z.string().trim().min(1).max(120).nullable().optional(),
});
const OptOutInput = z.strictObject({ optOut: z.boolean(), signedOn: day.optional() });

const CHASE_KIND: Record<string, string> = { REF: 'REFERENCE', DBS: 'DBS', RTW: 'RIGHT_TO_WORK' };

function checkCode(raw: string): string {
  const c = raw.toUpperCase();
  if (!CHECK_TEMPLATE[c]) throw notFound();
  return c;
}

/**
 * v36 Staff › person file › one check (data-act itReq, itChase, itUp, itRej, itCom): ask for a
 * document, chase it, record it as received, set the re-upload date, comment. Verifying uses the
 * evidence review endpoint (POST /evidence/{versionId}/verify) as every other screen does.
 *
 * A document "received" here is recorded as evidence for the check: v36 records receipt of the
 * document by name (the original is seen by HR), so the evidence file is a short receipt note
 * naming the document, who received it and when. A second person still verifies it.
 */
@Controller('staff/:id')
export class StaffChecksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BLOB_STORE) private readonly store: BlobStore,
    @Inject(SCANNER) private readonly scanner: Scanner,
  ) {}

  private async person(tx: TenantTx, hub: HubRequestContext, id: string, self = false) {
    const s = await tx.staff.findUnique({ where: { id } });
    if (!s) throw notFound();
    if (!self && s.userId === hub.user.id)
      throw new HubError('SELF_APPROVAL', 422, 'You cannot change checks on your own record');
    if (s.lifecycleState === 'LEAVER')
      throw new HubError('CONFLICT', 409, 'The record is closed (leaver)');
    return s;
  }

  private async instance(tx: TenantTx, staffId: string, code: string) {
    const rows = await tx.$queryRaw<{ id: string; title: string; location_id: string | null }[]>`
      SELECT ri.id, t.title, ri.location_id
        FROM requirement_instance ri JOIN requirement_template t ON t.id = ri.template_id
       WHERE ri.subject_type = 'STAFF' AND ri.subject_id = ${staffId}::uuid
         AND t.code = ${CHECK_TEMPLATE[code]!}`;
    if (!rows[0])
      throw new HubError(
        'VALIDATION_FAILED',
        400,
        'This check is not set up for the person yet – start checks for their role first',
      );
    return rows[0];
  }

  private async latestChase(tx: TenantTx, staffId: string, code: string) {
    const rows = await tx.$queryRaw<{ id: string; received_on: Date | null }[]>`
      SELECT id, received_on FROM staff_chase_log
       WHERE staff_id = ${staffId}::uuid AND check_code = ${code}
       ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  @RequirePermission('staff.profile.manage')
  @Post('checks/:code/request')
  async request(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('code') raw: string,
    @Body() b: unknown,
  ) {
    const code = checkCode(raw);
    const input = body(RequestInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.person(tx, hub, id);
      const inst = await this.instance(tx, id, code);
      const today = londonDate(new Date());
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO staff_chase_log (organisation_id, staff_id, kind, subject, requested_on, note,
                                     created_by, check_code, due_on)
        VALUES (${hub.orgId}::uuid, ${id}::uuid, ${CHASE_KIND[code] ?? 'OTHER'}, ${inst.title},
                ${today}::date, ${input.note ?? null}, ${hub.user.id}::uuid, ${code}, ${input.due}::date)
        RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.chase.create',
        entity: 'staff_chase_log',
        entityId: rows[0]!.id,
        summary: { staffId: id, check: code, due: input.due },
      });
      return { id: rows[0]!.id };
    });
  }

  @RequirePermission('staff.profile.manage')
  @Post('checks/:code/chase')
  async chase(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('code') raw: string,
    @Body() b: unknown,
  ) {
    const code = checkCode(raw);
    const input = body(ChaseInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.person(tx, hub, id);
      const row = await this.latestChase(tx, id, code);
      if (!row || row.received_on)
        throw new HubError('CONFLICT', 409, 'Record the request before chasing it');
      const today = londonDate(new Date());
      await tx.$executeRaw`
        UPDATE staff_chase_log
           SET chased_on = ${today}::date, chased_dates = chased_dates || ${today}::date,
               due_on = ${input.due}::date, note = coalesce(${input.note ?? null}, note),
               updated_at = now()
         WHERE id = ${row.id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.chase.chase',
        entity: 'staff_chase_log',
        entityId: row.id,
        summary: { staffId: id, check: code, due: input.due },
      });
      return { id: row.id };
    });
  }

  /** The date a rejected document must be uploaded again by (and any note about it). */
  @RequirePermission('staff.profile.manage')
  @Post('checks/:code/follow-up')
  async followUp(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('code') raw: string,
    @Body() b: unknown,
  ) {
    const code = checkCode(raw);
    const input = body(FollowUpInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.person(tx, hub, id);
      const inst = await this.instance(tx, id, code);
      const row = await this.latestChase(tx, id, code);
      let chaseId: string;
      if (row) {
        chaseId = row.id;
        await tx.$executeRaw`
          UPDATE staff_chase_log SET due_on = ${input.due}::date,
                 note = coalesce(${input.note ?? null}, note), updated_at = now()
           WHERE id = ${row.id}::uuid`;
      } else {
        const r = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO staff_chase_log (organisation_id, staff_id, kind, subject, note, created_by,
                                       check_code, due_on)
          VALUES (${hub.orgId}::uuid, ${id}::uuid, ${CHASE_KIND[code] ?? 'OTHER'}, ${inst.title},
                  ${input.note ?? null}, ${hub.user.id}::uuid, ${code}, ${input.due}::date)
          RETURNING id`;
        chaseId = r[0]!.id;
      }
      await audit(this.db, tx, hub, {
        action: 'staff.chase.follow_up',
        entity: 'staff_chase_log',
        entityId: chaseId,
        summary: { staffId: id, check: code, due: input.due },
      });
      return { id: chaseId };
    });
  }

  /**
   * A document for the check was received. HR or a manager records it for anyone else; the person
   * may record their own (v36: "only HR, the Registered Manager or the person themselves").
   */
  @RequirePermission('compliance.evidence.upload')
  @Post('checks/:code/received')
  async received(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('code') raw: string,
    @Body() b: unknown,
  ) {
    const code = checkCode(raw);
    const input = body(ReceivedInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await this.person(tx, hub, id, true);
      const own = s.userId === hub.user.id;
      if (!own && !hub.permissions.has('staff.profile.manage'))
        throw new HubError(
          'FORBIDDEN',
          403,
          'Only HR, the Registered Manager or the person themselves can upload',
        );
      const inst = await this.instance(tx, id, code);
      const now = new Date();
      const today = londonDate(now);
      const text =
        `Document received for "${inst.title}" – ${s.displayName} (${s.staffNo}).\n` +
        `Document: ${input.fileName}\n` +
        `Received on ${today} and recorded by ${hub.user.displayName}` +
        (input.suppliedBy ? `, supplied by ${input.suppliedBy}` : '') +
        '.\n' +
        (input.validTo ? `Valid until ${input.validTo}.\n` : '') +
        'The original document was seen by the person recording it; a second person verifies it.\n';
      const bytes = Buffer.from(text, 'utf8');
      const item = await tx.evidenceItem.create({
        data: {
          organisationId: hub.orgId as string,
          title: `${inst.title} – ${s.displayName}`.slice(0, 200),
          sensitivity: SENSITIVE_CHECKS.has(code) ? 'HR' : 'NORMAL',
          createdBy: hub.user.id,
        },
      });
      const roles = [...hub.roleKeys];
      const v = await tx.evidenceVersion.create({
        data: {
          organisationId: hub.orgId as string,
          itemId: item.id,
          versionNo: 1,
          blobKey: `${hub.orgId}/${item.id}/1-${randomUUID()}`,
          declaredMime: 'text/plain',
          declaredSize: BigInt(bytes.length),
          uploadedBy: hub.user.id,
          channel: roles.includes('CANDIDATE')
            ? 'CANDIDATE_PORTAL'
            : roles.includes('CREW')
              ? 'STAFF_APP'
              : 'OFFICE',
          validFrom: new Date(`${today}T00:00:00.000Z`),
          validTo: input.validTo ? new Date(`${input.validTo}T00:00:00.000Z`) : null,
        },
      });
      await this.store.put(v.blobKey, bytes);
      const scan = await this.scanner.scan(bytes, 'text/plain');
      await tx.evidenceVersion.update({
        where: { id: v.id },
        data: {
          uploadedAt: now,
          scannedAt: now,
          scanStatus: scan.status,
          sha256: sha256(bytes),
          sizeBytes: BigInt(bytes.length),
          mime: scan.status === 'CLEAN' ? 'text/plain' : null,
        },
      });
      await tx.evidenceLink.create({
        data: {
          organisationId: hub.orgId as string,
          itemId: item.id,
          instanceId: inst.id,
          createdBy: hub.user.id,
        },
      });
      await tx.$executeRaw`
        INSERT INTO staff_check_receipt (organisation_id, staff_id, check_code, evidence_version_id,
                                         file_name, supplied_by, note, created_by)
        VALUES (${hub.orgId}::uuid, ${id}::uuid, ${code}, ${v.id}::uuid, ${input.fileName},
                ${input.suppliedBy ?? null}, ${input.note || null}, ${hub.user.id}::uuid)`;
      await tx.$executeRaw`
        UPDATE staff_chase_log SET received_on = ${today}::date, updated_at = now()
         WHERE staff_id = ${id}::uuid AND check_code = ${code} AND received_on IS NULL`;
      await recomputeForEvidenceItem(tx, item.id, now);
      await audit(this.db, tx, hub, {
        action: 'evidence.upload.complete',
        entity: 'evidence_version',
        entityId: v.id,
        summary: { scan: scan.status, staffId: id, check: code },
      });
      return { evidenceVersionId: v.id };
    });
  }

  @OrgMember()
  @Post('checks/:code/comments')
  async comment(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('code') raw: string,
    @Body() b: unknown,
  ) {
    const code = checkCode(raw);
    const input = body(CommentInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const s = await tx.staff.findUnique({ where: { id } });
      if (!s) throw notFound();
      const may =
        hub.permissions.has('staff.profile.manage') ||
        hub.permissions.has('compliance.evidence.verify') ||
        s.userId === hub.user.id;
      if (!may) throw new HubError('FORBIDDEN', 403);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO staff_check_comment (organisation_id, staff_id, check_code, body, created_by)
        VALUES (${hub.orgId}::uuid, ${id}::uuid, ${code}, ${input.text}, ${hub.user.id}::uuid)
        RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'staff.check.comment',
        entity: 'staff_check_comment',
        entityId: rows[0]!.id,
        summary: { staffId: id, check: code },
      });
      return { id: rows[0]!.id };
    });
  }

  @RequirePermission('staff.profile.manage')
  @Post('line-manager')
  async lineManager(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() b: unknown,
  ) {
    const input = body(LineManagerInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.person(tx, hub, id, true);
      if (input.userId) {
        const n = await tx.membership.count({ where: { userId: input.userId } });
        if (!n)
          throw new HubError(
            'VALIDATION_FAILED',
            400,
            'The line manager is not a member of this organisation',
          );
      }
      await tx.$executeRaw`
        UPDATE staff SET line_manager_user_id = ${input.userId}::uuid,
               line_manager_name = ${input.userId ? null : (input.name ?? null)},
               updated_by = ${hub.user.id}::uuid
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.profile.update',
        entity: 'staff',
        entityId: id,
        summary: { fields: 'lineManager' },
      });
      return { id };
    });
  }

  /** The 48-hour week opt-out (Working Time Regulations 1998, reg 5). */
  @RequirePermission('staff.profile.manage')
  @Post('working-time-opt-out')
  async optOut(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() b: unknown,
  ) {
    const input = body(OptOutInput, b);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      await this.person(tx, hub, id);
      const on = input.optOut ? (input.signedOn ?? londonDate(new Date())) : null;
      await tx.$executeRaw`
        UPDATE staff SET wtd_opt_out = ${input.optOut}, wtd_opt_out_on = ${on}::date,
               updated_by = ${hub.user.id}::uuid
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'staff.profile.update',
        entity: 'staff',
        entityId: id,
        summary: { fields: 'workingTimeOptOut', optOut: input.optOut },
      });
      return { id, optOut: input.optOut };
    });
  }
}
