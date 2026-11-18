import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Db, TenantTx } from '@hub/db';
import {
  CQC_SELF_AUDIT,
  SelfAuditAnswerSet,
  SelfAuditReview,
  type SelfAuditDto,
} from '@hub/contracts';
import { RequirePermission } from '../../common/decorators.js';
import { Hub, tenantOf, type HubRequestContext } from '../../common/context.js';
import { audit, body } from '../../common/http.js';
import { HubError, notFound } from '../../common/problem.filter.js';
import { DB } from '../../db.provider.js';
import { idPipe } from './shared.js';

const VIEW = 'compliance.audit.view';
const RUN = 'compliance.audit.run';
const KEYS = new Set(CQC_SELF_AUDIT.flatMap((k) => k.questions.map((q) => q.key)));

interface AuditRow {
  id: string;
  code: string;
  status: 'OPEN' | 'SUBMITTED' | 'REVIEWED';
  started_by: string;
  started_at: Date;
  submitted_by: string | null;
  submitted_at: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  version: number;
}
interface AnswerRow {
  question_key: string;
  answer: 'PASS' | 'PARTIAL' | 'FAIL' | 'NA';
  note: string | null;
  answered_by: string;
  answered_at: Date;
}

async function load(tx: TenantTx, id: string): Promise<SelfAuditDto> {
  const [a] = await tx.$queryRaw<AuditRow[]>`SELECT * FROM cqc_self_audit WHERE id = ${id}::uuid`;
  if (!a) throw notFound();
  const answers = await tx.$queryRaw<AnswerRow[]>`
    SELECT question_key, answer, note, answered_by, answered_at
      FROM cqc_self_audit_answer WHERE self_audit_id = ${id}::uuid ORDER BY question_key`;
  const ids = [
    ...new Set(
      [a.started_by, a.submitted_by, a.reviewed_by, ...answers.map((x) => x.answered_by)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const users = await tx.appUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  const name = new Map(users.map((u) => [u.id, u.displayName]));
  return {
    id: a.id,
    code: a.code,
    status: a.status,
    startedAt: a.started_at.toISOString(),
    startedByName: name.get(a.started_by) ?? null,
    submittedAt: a.submitted_at?.toISOString() ?? null,
    submittedBy: a.submitted_by,
    submittedByName: a.submitted_by ? (name.get(a.submitted_by) ?? null) : null,
    reviewedAt: a.reviewed_at?.toISOString() ?? null,
    reviewedByName: a.reviewed_by ? (name.get(a.reviewed_by) ?? null) : null,
    reviewNote: a.review_note,
    answers: answers.map((x) => ({
      questionKey: x.question_key,
      answer: x.answer,
      note: x.note,
      answeredByName: name.get(x.answered_by) ?? null,
      answeredAt: x.answered_at.toISOString(),
    })),
    version: a.version,
  };
}

/**
 * v36 Compliance › Audits & actions › CQC self-audit. The organisation assesses itself against the
 * CQC key questions; a second person signs off the review. Internal measure, not a CQC rating.
 */
@Controller('cqc-self-audit')
export class CqcSelfAuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @RequirePermission(VIEW)
  @Get()
  current(@Hub() hub: HubRequestContext): Promise<{ audit: SelfAuditDto | null }> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [a] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cqc_self_audit ORDER BY (status = 'OPEN') DESC, started_at DESC LIMIT 1`;
      return { audit: a ? await load(tx, a.id) : null };
    });
  }

  @RequirePermission(RUN)
  @Post()
  start(@Hub() hub: HubRequestContext): Promise<SelfAuditDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [open] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM cqc_self_audit WHERE status = 'OPEN' LIMIT 1`;
      if (open) throw new HubError('CONFLICT', 409, 'A self-audit is already open');
      const [c] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM cqc_self_audit`;
      const code = `SA-${String(Number(c?.n ?? 0) + 1).padStart(2, '0')}`;
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO cqc_self_audit (organisation_id, code, started_by)
        VALUES (${hub.orgId}::uuid, ${code}, ${hub.user.id}::uuid) RETURNING id`;
      await audit(this.db, tx, hub, {
        action: 'compliance.selfaudit.create',
        entity: 'cqc_self_audit',
        entityId: row!.id,
        summary: { code },
      });
      return load(tx, row!.id);
    });
  }

  @RequirePermission(RUN)
  @Post(':id/answers/:key')
  answer(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Param('key') key: string,
    @Body() raw: unknown,
  ): Promise<SelfAuditDto> {
    const input = body(SelfAuditAnswerSet, raw);
    if (!KEYS.has(key)) throw notFound();
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [a] = await tx.$queryRaw<AuditRow[]>`SELECT * FROM cqc_self_audit WHERE id = ${id}::uuid`;
      if (!a) throw notFound();
      if (a.status !== 'OPEN')
        throw new HubError('CONFLICT', 409, 'The self-audit has been submitted; answers cannot change');
      await tx.$executeRaw`
        INSERT INTO cqc_self_audit_answer (organisation_id, self_audit_id, question_key, answer, note, answered_by)
        VALUES (${hub.orgId}::uuid, ${id}::uuid, ${key}, ${input.answer}, ${input.note ?? null}, ${hub.user.id}::uuid)
        ON CONFLICT (self_audit_id, question_key) DO UPDATE
          SET answer = EXCLUDED.answer, note = EXCLUDED.note,
              answered_by = EXCLUDED.answered_by, answered_at = now(), updated_at = now()`;
      await audit(this.db, tx, hub, {
        action: 'compliance.selfaudit.update',
        entity: 'cqc_self_audit',
        entityId: id,
        summary: { question: key, answer: input.answer },
      });
      return load(tx, id);
    });
  }

  @RequirePermission(RUN)
  @Post(':id/submit')
  submit(@Hub() hub: HubRequestContext, @Param('id', idPipe) id: string): Promise<SelfAuditDto> {
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [a] = await tx.$queryRaw<AuditRow[]>`SELECT * FROM cqc_self_audit WHERE id = ${id}::uuid`;
      if (!a) throw notFound();
      if (a.status !== 'OPEN') throw new HubError('CONFLICT', 409, 'Already submitted');
      const [c] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM cqc_self_audit_answer WHERE self_audit_id = ${id}::uuid`;
      const n = Number(c?.n ?? 0);
      if (n < KEYS.size)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          `Answer every statement first (${n} of ${KEYS.size} answered)`,
        );
      await tx.$executeRaw`
        UPDATE cqc_self_audit SET status = 'SUBMITTED', submitted_by = ${hub.user.id}::uuid,
               submitted_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'compliance.selfaudit.publish',
        entity: 'cqc_self_audit',
        entityId: id,
      });
      return load(tx, id);
    });
  }

  @RequirePermission(RUN)
  @Post(':id/review')
  review(
    @Hub() hub: HubRequestContext,
    @Param('id', idPipe) id: string,
    @Body() raw: unknown,
  ): Promise<SelfAuditDto> {
    const input = body(SelfAuditReview, raw);
    return this.db.withTenant(tenantOf(hub), async (tx) => {
      const [a] = await tx.$queryRaw<AuditRow[]>`SELECT * FROM cqc_self_audit WHERE id = ${id}::uuid`;
      if (!a) throw notFound();
      if (a.status !== 'SUBMITTED') throw new HubError('CONFLICT', 409, 'Submit it for review first');
      if (a.submitted_by === hub.user.id)
        throw new HubError(
          'FORBIDDEN',
          403,
          'Someone other than the person who submitted it must sign off the review',
        );
      await tx.$executeRaw`
        UPDATE cqc_self_audit SET status = 'REVIEWED', reviewed_by = ${hub.user.id}::uuid,
               reviewed_at = now(), review_note = ${input.note}, updated_at = now()
         WHERE id = ${id}::uuid`;
      await audit(this.db, tx, hub, {
        action: 'compliance.selfaudit.approve',
        entity: 'cqc_self_audit',
        entityId: id,
      });
      return load(tx, id);
    });
  }
}
