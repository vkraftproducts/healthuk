// S.tpl (audit templates), S.aud (audits), S.prog (audit programme) and S.act (actions from
// audits, events, risks and governance) ↔ audit_template(+_version), audit_run, audit_response,
// audit_review, audit_plan_month, action, action_history.
import type { TenantTx } from '@hub/db';
import { loadPeople, stamp, ymd, type People } from './lookup.js';
import type { V36Adapter, V36Change, V36Ctx, V36Record } from './types.js';
import {
  allocCode,
  auditRow,
  byCodeNo,
  dateCol,
  invalid,
  londonToUtc,
  need,
  refuse,
  str,
  textLen,
  v36Role,
  type J,
} from './governance-common.js';

const KQ: Record<string, string> = {
  Safe: 'SAFE',
  Effective: 'EFFECTIVE',
  Caring: 'CARING',
  Responsive: 'RESPONSIVE',
  'Well-led': 'WELL_LED',
};
const KQ_LABEL = Object.fromEntries(Object.entries(KQ).map(([k, v]) => [v, k]));
const RES: Record<string, string> = { Pass: 'COMPLIANT', Fail: 'NON_COMPLIANT', 'N/A': 'NOT_APPLICABLE' };
const RES_LABEL: Record<string, string> = {
  COMPLIANT: 'Pass',
  NON_COMPLIANT: 'Fail',
  PARTIAL: 'Fail',
  NOT_APPLICABLE: 'N/A',
  NOT_ASSESSED: 'N/A',
};
const ro = (ctx: V36Ctx) => {
  if (ctx.hub.support || v36Role(ctx) === 'aud') refuse('read-only');
};

// ---- templates ----------------------------------------------------------------------------------
interface TplRow {
  id: string;
  code: string;
  title: string;
  domain: string;
  vid: string;
  version: number;
  status: string;
  controls: J[];
  created_by: string | null;
  approved_by: string | null;
  pub_by: string | null;
}
const tplRows = (tx: TenantTx) =>
  tx.$queryRaw<TplRow[]>`
    SELECT t.id, t.code, t.title, t.domain::text, v.id AS vid, v.version, v.status, v.controls,
           v.created_by, v.approved_by,
           (SELECT p.approved_by FROM audit_template_version p
             WHERE p.template_id = t.id AND p.status = 'PUBLISHED' ORDER BY p.version DESC LIMIT 1) AS pub_by
      FROM audit_template t
      JOIN LATERAL (SELECT * FROM audit_template_version v WHERE v.template_id = t.id
                     ORDER BY v.version DESC LIMIT 1) v ON true
     WHERE t.retired_at IS NULL
     ORDER BY t.code`;

function tplRecord(t: TplRow, p: People): V36Record {
  const r: J = {
    n: t.title,
    kq: KQ_LABEL[t.domain] ?? t.domain,
    v: t.version,
    state: t.status === 'PUBLISHED' ? 'Published' : 'Draft',
    by: p.nameOf(t.created_by),
  };
  if (t.status === 'PUBLISHED' && t.approved_by) r.pub = p.nameOf(t.approved_by);
  r.ctl = (t.controls ?? []).map((c) => String(c.question ?? ''));
  return r;
}

export const tplAdapter: V36Adapter = {
  key: 'tpl',
  shape: 'map',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const out: Record<string, V36Record> = {};
      for (const t of await tplRows(tx)) out[t.code] = tplRecord(t, p);
      return out;
    }),
  apply: async (ctx, c) => {
    const a = (c.after ?? {}) as J;
    const b = (c.before ?? {}) as J;
    if (!c.before || !c.after) refuse('Audit templates are added and removed in the library');
    if (a.state === 'Published' && b.state !== 'Published') {
      need(ctx, 'gov rm dir', 'only governance or a manager can publish');
      await ctx.tx(async (tx) => {
        const t = (await tplRows(tx)).find((t) => t.code === c.id);
        if (!t) invalid(`${c.id} was not found`);
        if (t.status !== 'DRAFT') refuse('This template was changed by someone else; reload and retry', 409);
        if (t.created_by === ctx.userId)
          refuse('you drafted this template, so a second person must publish it');
        await tx.$executeRaw`
          UPDATE audit_template_version SET status = 'RETIRED'
           WHERE template_id = ${t.id}::uuid AND status = 'PUBLISHED'`;
        await tx.$executeRaw`
          UPDATE audit_template_version SET status = 'PUBLISHED', approved_by = ${ctx.userId}::uuid,
                 approved_at = now() WHERE id = ${t.vid}::uuid`;
        await tx.$executeRaw`UPDATE audit_template SET active = true WHERE id = ${t.id}::uuid`;
        await auditRow(ctx, tx, 'compliance.audit_template.publish', 'audit_template', t.id, {
          code: t.code,
          version: t.version,
        });
      });
      return;
    }
    // Nothing else on a template is edited from v36.
  },
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_template`)[0]!
          .n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      for (const [code, raw] of Object.entries(recs as Record<string, J>)) {
        const t = raw;
        const pub = t.state === 'Published';
        const by = p.userIdOf(t.by) ?? ctx.userId;
        let approver = pub ? (p.userIdOf(t.pub) ?? ctx.userId) : null;
        // The database keeps the four-eyes rule: an unknown or same-person publisher is not kept.
        if (approver === by) approver = by === ctx.userId ? null : ctx.userId;
        const [tpl] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO audit_template (organisation_id, code, title, domain, active, created_by)
          VALUES (${ctx.orgId}::uuid, ${code}, ${String(t.n)}, ${KQ[t.kq] ?? 'SAFE'}::quality_domain,
                  ${pub && !!approver}, ${by}::uuid)
          RETURNING id`;
        const controls = ((t.ctl ?? []) as string[]).map((q, i) => ({
          code: `${code}-${String.fromCharCode(65 + i)}`,
          question: q,
          failureAction: 'Raise an action with an owner and a date',
          critical: false,
        }));
        await tx.$executeRaw`
          INSERT INTO audit_template_version (organisation_id, template_id, version, status, controls,
                                              approved_by, approved_at, created_by)
          VALUES (${ctx.orgId}::uuid, ${tpl!.id}::uuid, ${Number(t.v) || 1},
                  ${pub && approver ? 'PUBLISHED' : 'DRAFT'}, ${JSON.stringify(controls)}::jsonb,
                  ${approver}::uuid, ${approver ? new Date() : null}, ${by}::uuid)`;
      }
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'audit_template', ctx.orgId, { key: 'tpl' });
    }),
};

// ---- audit programme ----------------------------------------------------------------------------
export const progAdapter: V36Adapter = {
  key: 'prog',
  shape: 'list',
  idField: '0',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const rows = await tx.$queryRaw<{ code: string; months: string[] }[]>`
        SELECT t.code, array_agg(m.month ORDER BY m.month) AS months, min(m.position) AS pos
          FROM audit_plan_month m JOIN audit_template t ON t.id = m.template_id
         GROUP BY t.code ORDER BY min(m.position), t.code`;
      return rows.map((r) => [r.code, r.months] as unknown as V36Record);
    }),
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_plan_month`)[0]!
          .n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      const list = (Array.isArray(recs) ? recs : Object.values(recs)) as unknown as [string, string[]][];
      let pos = 0;
      for (const [code, months] of list) {
        pos++;
        for (const m of months ?? [])
          await tx.$executeRaw`
            INSERT INTO audit_plan_month (organisation_id, template_id, month, position, created_by)
            SELECT ${ctx.orgId}::uuid, id, ${m}, ${pos}, ${ctx.userId}::uuid
              FROM audit_template WHERE code = ${code}
            ON CONFLICT DO NOTHING`;
      }
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'audit_plan_month', ctx.orgId, { key: 'prog' });
    }),
};

// ---- audits ---------------------------------------------------------------------------------------
interface RunRow {
  id: string;
  code: string;
  tpl: string;
  controls: J[];
  title: string;
  auditor_user_id: string;
  owner_user_id: string;
  due_date: Date;
  status: string;
  review_state: string | null;
  submitted_at: Date | null;
  submitted_by: string | null;
  method_note: string | null;
  submission_no: number;
}
const runRows = (tx: TenantTx, code: string | null = null) =>
  tx.$queryRaw<RunRow[]>`
    SELECT r.id, r.code, t.code AS tpl, v.controls, r.title, r.auditor_user_id, r.owner_user_id,
           r.due_date, r.status::text, r.review_state, r.submitted_at, r.submitted_by, r.method_note,
           r.submission_no
      FROM audit_run r JOIN audit_template_version v ON v.id = r.template_version_id
      JOIN audit_template t ON t.id = v.template_id
     WHERE (${code}::text IS NULL OR r.code = ${code})`;

function stageOf(r: RunRow): string {
  if (r.status === 'SCHEDULED' || r.status === 'IN_PROGRESS')
    return r.review_state === 'RETURNED' ? 'Returned to auditor' : 'Scheduled';
  if (r.review_state === 'RETURNED') return 'Returned to auditor';
  if (r.status === 'CLOSED') return 'Closed';
  if (!r.review_state) return 'Submitted – awaiting owner';
  return 'Submitted – actions open';
}

async function buildAud(tx: TenantTx, runs: RunRow[], p: People) {
  const ids = runs.map((r) => r.id);
  const resp = await tx.$queryRaw<
    { run_id: string; control_code: string; result: string; note: string | null }[]
  >`SELECT DISTINCT ON (run_id, control_code) run_id, control_code, result::text, note
      FROM audit_response WHERE run_id = ANY (${ids}::uuid[])
     ORDER BY run_id, control_code, recorded_at DESC, id DESC`;
  const acts = await tx.$queryRaw<{ run_id: string; code: string }[]>`
    SELECT a.source_id AS run_id, a.code FROM action a
     WHERE a.source_type = 'AUDIT' AND a.source_id = ANY (${ids}::uuid[])
    UNION
    SELECT f.run_id, a.code FROM action a JOIN audit_finding f ON f.id = a.source_id
     WHERE a.source_type = 'FINDING' AND f.run_id = ANY (${ids}::uuid[])`;
  const rev = await tx.$queryRaw<
    { run_id: string; decision: string; reason: string; reviewed_by: string; reviewed_at: Date }[]
  >`SELECT DISTINCT ON (run_id) run_id, decision, reason, reviewed_by, reviewed_at
      FROM audit_review WHERE run_id = ANY (${ids}::uuid[])
     ORDER BY run_id, reviewed_at DESC, id DESC`;
  const out: Record<string, V36Record> = {};
  for (const r of runs.sort((a, b) => byCodeNo(a.code, b.code))) {
    const a: J = {
      id: r.code,
      tpl: r.tpl,
      t: r.title,
      auditor: p.nameOf(r.auditor_user_id),
      owner: p.nameOf(r.owner_user_id),
      due: ymd(r.due_date),
      stage: stageOf(r),
    };
    const mine = resp.filter((x) => x.run_id === r.id);
    if (mine.length) {
      const res: J = {};
      const notes: J = {};
      (r.controls ?? []).forEach((c, i) => {
        const x = mine.find((m) => m.control_code === c.code);
        if (!x) return;
        res[i] = RES_LABEL[x.result] ?? 'N/A';
        if (x.note) notes[i] = x.note;
      });
      a.res = res;
      if (Object.keys(notes).length) a.notes = notes;
    }
    if (r.method_note !== null) a.method = r.method_note;
    if (r.submitted_by) a.sub = { by: p.nameOf(r.submitted_by), on: stamp(r.submitted_at) };
    const codes = acts
      .filter((x) => x.run_id === r.id)
      .map((x) => x.code)
      .sort(byCodeNo);
    if (codes.length || r.status !== 'SCHEDULED') a.acts = codes;
    const d = rev.find((x) => x.run_id === r.id);
    if (d) {
      a.dec = {
        k: d.decision === 'ACCEPTED' ? 'Accepted' : 'Returned',
        by: p.nameOf(d.reviewed_by),
        on: stamp(d.reviewed_at),
      };
      if (d.decision === 'RETURNED') a.dec.why = d.reason;
    }
    out[r.code] = a;
  }
  return out;
}

async function publishedVersion(tx: TenantTx, tpl: string) {
  const [v] = await tx.$queryRaw<{ id: string }[]>`
    SELECT v.id FROM audit_template_version v JOIN audit_template t ON t.id = v.template_id
     WHERE t.code = ${tpl} AND v.status = 'PUBLISHED' ORDER BY v.version DESC LIMIT 1`;
  return v?.id ?? null;
}

async function applyAud(ctx: V36Ctx, c: V36Change) {
  const a = (c.after ?? {}) as J;
  const b = (c.before ?? {}) as J;
  await ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    if (!c.before) {
      need(ctx, 'gov rm dir', 'only governance or a manager can schedule audits');
      const auditor = p.needUserId(a.auditor, 'Auditor');
      const owner = p.needUserId(a.owner, 'Area owner');
      if (auditor === owner) refuse('the auditor cannot be the owner of the area being audited');
      const vid = await publishedVersion(tx, String(a.tpl));
      if (!vid) invalid('Choose a published template');
      const due = dateCol(a.due);
      if (!due) invalid('Choose the due date');
      const code = await allocCode(tx, 'audit_run', c.id, 'AUD-', { counter: 'AUD', start: 100 });
      const [r] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO audit_run (organisation_id, code, template_version_id, title, auditor_user_id,
                               owner_user_id, reviewer_user_id, due_date, status, created_by)
        VALUES (${ctx.orgId}::uuid, ${code}, ${vid}::uuid,
                ${textLen(str(a.t), 'Title', 2, 200)}, ${auditor}::uuid, ${owner}::uuid,
                ${owner}::uuid, ${due}, 'SCHEDULED', ${ctx.userId}::uuid)
        RETURNING id`;
      await auditRow(ctx, tx, 'compliance.audit.schedule', 'audit_run', r!.id, { code });
      return;
    }
    if (!c.after) refuse('Audits cannot be deleted');
    const [r] = await runRows(tx, c.id);
    if (!r) invalid(`${c.id} was not found`);
    if (a.stage === b.stage) return;
    if (stageOf(r) !== b.stage)
      refuse('This audit was changed by someone else; reload and retry', 409);
    if (a.stage === 'Submitted – awaiting owner' && (b.stage === 'Scheduled' || b.stage === 'Returned to auditor')) {
      ro(ctx);
      if (r.auditor_user_id !== ctx.userId)
        refuse(`only the named auditor (${p.nameOf(r.auditor_user_id)}) can conduct this audit`);
      const res = (a.res ?? {}) as J;
      const notes = (a.notes ?? {}) as J;
      const controls = r.controls ?? [];
      for (let i = 0; i < controls.length; i++) {
        const result = RES[String(res[i])];
        if (!result) invalid('Answer every control');
        const note = String(notes[i] ?? '');
        if (result === 'NON_COMPLIANT' && !note.trim()) invalid('Add a note for each failed control');
        await tx.$executeRaw`
          INSERT INTO audit_response (organisation_id, run_id, control_code, result, method, note, recorded_by)
          VALUES (${ctx.orgId}::uuid, ${r.id}::uuid, ${String(controls[i]!.code)},
                  ${result}::audit_result, 'RECORDS', ${result === 'COMPLIANT' && !note ? null : note},
                  ${ctx.userId}::uuid)`;
      }
      await tx.$executeRaw`
        UPDATE audit_run SET status = 'SUBMITTED', review_state = NULL, submitted_at = now(),
               submitted_by = ${ctx.userId}::uuid, submission_no = submission_no + 1,
               method_note = ${str(a.method)} WHERE id = ${r.id}::uuid`;
      await auditRow(ctx, tx, 'compliance.audit.submit', 'audit_run', r.id, {
        code: r.code,
        fails: Object.values(res).filter((x) => x === 'Fail').length,
      });
      return;
    }
    if (
      (a.stage === 'Submitted – actions open' || a.stage === 'Closed' || a.stage === 'Returned to auditor') &&
      b.stage === 'Submitted – awaiting owner'
    ) {
      ro(ctx);
      if (r.owner_user_id !== ctx.userId)
        refuse(`only the area owner (${p.nameOf(r.owner_user_id)}) accepts or returns findings`);
      const ret = a.stage === 'Returned to auditor';
      const why = ret ? textLen(str((a.dec as J | undefined)?.why), 'Reason', 3, 1000) : 'Findings accepted';
      const open = (
        await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM action WHERE source_type = 'AUDIT' AND source_id = ${r.id}::uuid`
      )[0]!.n;
      await tx.$executeRaw`
        INSERT INTO audit_review (organisation_id, run_id, submission_no, decision, reason, reviewed_by)
        VALUES (${ctx.orgId}::uuid, ${r.id}::uuid, ${Math.max(1, r.submission_no)},
                ${ret ? 'RETURNED' : 'ACCEPTED'}, ${why}, ${ctx.userId}::uuid)`;
      const status = ret ? 'SUBMITTED' : open ? 'ACTIONS_OPEN' : 'CLOSED';
      await tx.$executeRaw`
        UPDATE audit_run SET review_state = ${ret ? 'RETURNED' : 'ACCEPTED'},
               status = ${status}::audit_run_status WHERE id = ${r.id}::uuid`;
      await auditRow(ctx, tx, 'compliance.audit.review', 'audit_run', r.id, {
        code: r.code,
        decision: ret ? 'RETURNED' : 'ACCEPTED',
      });
      return;
    }
    // 'Submitted – actions open' → 'Closed' happens on the server when the last action is verified.
    if (a.stage === 'Closed' && b.stage === 'Submitted – actions open') return;
    refuse('not allowed');
  });
}

export const audAdapter: V36Adapter = {
  key: 'aud',
  shape: 'map',
  load: (ctx) => ctx.tx(async (tx) => buildAud(tx, await runRows(tx), await loadPeople(tx))),
  apply: applyAud,
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_run`)[0]!.n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      for (const [code, raw] of Object.entries(recs as Record<string, J>)) {
        const a = raw;
        const [v] = await tx.$queryRaw<{ id: string; controls: J[] }[]>`
          SELECT v.id, v.controls FROM audit_template_version v JOIN audit_template t ON t.id = v.template_id
           WHERE t.code = ${String(a.tpl)} ORDER BY (v.status = 'PUBLISHED') DESC, v.version DESC LIMIT 1`;
        if (!v) continue;
        const auditor = p.userIdOf(a.auditor) ?? ctx.userId;
        const owner = p.userIdOf(a.owner) ?? ctx.userId;
        const stage = String(a.stage);
        const submitted = stage !== 'Scheduled';
        const review = a.dec ? (a.dec.k === 'Returned' ? 'RETURNED' : 'ACCEPTED') : null;
        const status =
          stage === 'Scheduled'
            ? 'SCHEDULED'
            : stage === 'Closed'
              ? 'CLOSED'
              : stage === 'Submitted – actions open'
                ? 'ACTIONS_OPEN'
                : 'SUBMITTED';
        const subAt = a.sub?.on ? londonToUtc(a.sub.on) : submitted ? londonToUtc(`${a.due} 16:00`) : null;
        const [r] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO audit_run (organisation_id, code, template_version_id, title, auditor_user_id,
                                 owner_user_id, reviewer_user_id, due_date, status, review_state,
                                 submitted_at, submitted_by, submission_no, method_note, created_by)
          VALUES (${ctx.orgId}::uuid, ${code}, ${v.id}::uuid, ${String(a.t)}, ${auditor}::uuid,
                  ${owner}::uuid, ${owner === auditor ? null : owner}::uuid, ${dateCol(a.due)},
                  ${status}::audit_run_status, ${review}, ${subAt},
                  ${a.sub ? (p.userIdOf(a.sub.by) ?? auditor) : null}::uuid, ${submitted ? 1 : 0},
                  ${str(a.method) ?? (typeof a.method === 'string' ? a.method : null)}, ${ctx.userId}::uuid)
          RETURNING id`;
        const res = (a.res ?? {}) as J;
        const notes = (a.notes ?? {}) as J;
        if (submitted && Object.keys(res).length) {
          // Responses are only accepted while a run is open: record them first, then the state.
          await tx.$executeRaw`UPDATE audit_run SET status = 'IN_PROGRESS', review_state = NULL WHERE id = ${r!.id}::uuid`;
          for (const [i, label] of Object.entries(res)) {
            const ctl = v.controls[Number(i)];
            const result = RES[String(label)];
            if (!ctl || !result) continue;
            const note = notes[i] ?? (result === 'COMPLIANT' ? null : '');
            await tx.$executeRaw`
              INSERT INTO audit_response (organisation_id, run_id, control_code, result, method, note,
                                          recorded_by, recorded_at)
              VALUES (${ctx.orgId}::uuid, ${r!.id}::uuid, ${String(ctl.code)}, ${result}::audit_result,
                      'RECORDS', ${note}, ${auditor}::uuid, ${subAt ?? new Date()})`;
          }
          await tx.$executeRaw`
            UPDATE audit_run SET status = ${status}::audit_run_status, review_state = ${review}
             WHERE id = ${r!.id}::uuid`;
        }
        if (a.dec) {
          await tx.$executeRaw`
            INSERT INTO audit_review (organisation_id, run_id, submission_no, decision, reason, reviewed_by, reviewed_at)
            VALUES (${ctx.orgId}::uuid, ${r!.id}::uuid, 1, ${review}, ${str(a.dec.why) ?? 'Findings accepted'},
                    ${p.userIdOf(a.dec.by) ?? owner}::uuid,
                    ${a.dec.on ? londonToUtc(a.dec.on) : new Date()})`;
        }
        const n = Number(/(\d+)$/.exec(code)?.[1] ?? 0);
        await tx.$executeRaw`
          INSERT INTO org_counter (organisation_id, prefix, value) VALUES (app_org_id(), 'AUD', ${Math.max(n, 100)})
          ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)`;
      }
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'audit_run', ctx.orgId, { key: 'aud' });
    }),
};

// ---- actions --------------------------------------------------------------------------------------
const ASTATE: Record<string, string> = {
  OPEN: 'Open',
  EVIDENCE_SUBMITTED: 'Ready for verification',
  REJECTED: 'Evidence rejected',
  VERIFIED: 'Verified',
};
interface ActRow {
  id: string;
  code: string;
  title: string;
  source_type: string;
  source_label: string | null;
  src_code: string | null;
  owner_user_id: string;
  deadline: Date;
  status: string;
  next_step: string | null;
  evidence_file: string | null;
  evidence_note: string | null;
  evidence_at: Date | null;
  evidence_by: string | null;
  ev_items: number;
  ev_title: string | null;
  rejected_reason: string | null;
  verifier_user_id: string | null;
  verified_at: Date | null;
  version: number;
}
const actRows = (tx: TenantTx, code: string | null = null) =>
  tx.$queryRaw<ActRow[]>`
    SELECT a.id, a.code, a.title, a.source_type, a.source_label,
           CASE a.source_type
             WHEN 'EVENT' THEN (SELECT code FROM event WHERE id = a.source_id)
             WHEN 'AUDIT' THEN (SELECT code FROM audit_run WHERE id = a.source_id)
             WHEN 'FINDING' THEN (SELECT r.code FROM audit_finding f JOIN audit_run r ON r.id = f.run_id
                                   WHERE f.id = a.source_id)
             WHEN 'RISK' THEN (SELECT code FROM risk WHERE id = a.source_id)
           END AS src_code,
           a.owner_user_id, a.deadline, a.status::text, a.next_step, a.evidence_file, a.evidence_note,
           coalesce(a.evidence_at, (SELECT max(h.at) FROM action_history h WHERE h.action_id = a.id
                                     AND h.to_status = 'EVIDENCE_SUBMITTED')) AS evidence_at,
           a.evidence_by, cardinality(a.evidence_item_ids) AS ev_items,
           (SELECT i.title FROM evidence_item i WHERE i.id = a.evidence_item_ids[1]) AS ev_title, a.rejected_reason,
           a.verifier_user_id, a.verified_at, a.version
      FROM action a WHERE (${code}::text IS NULL OR a.code = ${code})`;

function actRecord(a: ActRow, p: People): V36Record {
  const label =
    a.source_label ??
    (a.src_code
      ? `${a.source_type === 'EVENT' ? 'Event' : a.source_type === 'RISK' ? 'Risk' : 'Audit'} ${a.src_code}`
      : a.source_type === 'MEETING'
        ? 'Governance meeting'
        : a.source_type === 'CONTINUITY'
          ? 'Business continuity'
          : 'Action');
  const r: J = {
    id: a.code,
    t: a.title,
    src: label,
    owner: p.nameOf(a.owner_user_id),
    due: ymd(a.deadline),
    state: ASTATE[a.status] ?? 'Open',
  };
  if (a.next_step !== null) r.next = a.next_step;
  if (a.status !== 'OPEN' && (a.evidence_file || a.ev_items || a.evidence_by)) {
    r.ev = { file: a.evidence_file ?? a.ev_title ?? 'Evidence', by: p.nameOf(a.evidence_by), on: stamp(a.evidence_at) };
    if (a.evidence_note) r.ev.note = a.evidence_note;
  }
  if (a.status === 'REJECTED' && a.rejected_reason) r.rej = a.rejected_reason;
  if (a.status === 'VERIFIED')
    r.ver = { by: p.nameOf(a.verifier_user_id), on: stamp(a.verified_at) };
  return r;
}

/** Works out where a v36 action comes from: 'Event EVT-…', 'Audit AUD-…', 'Risk RSK-…' or free text. */
async function sourceOf(ctx: V36Ctx, tx: TenantTx, src: string) {
  const m = /^(Event|Audit|Risk) (\S+)/.exec(src);
  if (m) {
    const table = m[1] === 'Event' ? 'event' : m[1] === 'Audit' ? 'audit_run' : 'risk';
    const rows = await tx.$queryRawUnsafe<{ id: string; auditor: string | null }[]>(
      `SELECT id, ${table === 'audit_run' ? 'auditor_user_id' : 'NULL::uuid'} AS auditor FROM ${table} WHERE code = $1`,
      m[2],
    );
    if (!rows[0]) invalid(`${m[2]} was not found`);
    return {
      type: m[1] === 'Event' ? 'EVENT' : m[1] === 'Audit' ? 'AUDIT' : 'RISK',
      id: rows[0].id,
      auditor: rows[0].auditor,
    };
  }
  const type = /^Governance meeting/.test(src)
    ? 'MEETING'
    : /^Regulator/.test(src)
      ? 'CORRESPONDENCE'
      : /^Feedback/.test(src)
        ? 'FEEDBACK'
        : 'MANUAL';
  return { type, id: ctx.orgId, auditor: null };
}

async function history(ctx: V36Ctx, tx: TenantTx, id: string, from: string | null, to: string, note: string) {
  await tx.$executeRaw`
    INSERT INTO action_history (organisation_id, action_id, from_status, to_status, note, by_user_id)
    VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${from}::action_status, ${to}::action_status, ${note},
            ${ctx.userId}::uuid)`;
}

async function applyAct(ctx: V36Ctx, c: V36Change) {
  const a = (c.after ?? {}) as J;
  const b = (c.before ?? {}) as J;
  await ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    if (!c.before) {
      const src = String(a.src ?? '');
      const s = await sourceOf(ctx, tx, src);
      if (s.type === 'AUDIT') {
        ro(ctx);
        if (s.auditor !== ctx.userId) refuse('only the named auditor can raise actions from this audit');
      } else if (/^BCP test/.test(src))
        need(ctx, 'rm dir fleet gov disp', 'not allowed');
      else need(ctx, 'gov rm dir', 'only governance or a manager can raise actions');
      const owner = p.needUserId(a.owner, 'Owner');
      const due = dateCol(a.due);
      if (!due) invalid('Choose the due date');
      const code = await allocCode(tx, 'action', c.id, 'ACT-', { counter: 'ACT', start: 200 });
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO action (organisation_id, code, source_type, source_id, title, severity, owner_user_id,
                            deadline, status, created_by, source_label, next_step)
        VALUES (${ctx.orgId}::uuid, ${code}, ${s.type}, ${s.id}::uuid,
                ${textLen(str(a.t), 'Action', 3, 300)}, ${s.type === 'AUDIT' ? 'HIGH' : 'MEDIUM'}::alert_severity,
                ${owner}::uuid, ${due}, 'OPEN', ${ctx.userId}::uuid, ${src.slice(0, 200)}, ${str(a.next)})
        RETURNING id`;
      await history(ctx, tx, row!.id, null, 'OPEN', 'Created');
      await auditRow(ctx, tx, 'compliance.action.create', 'action', row!.id, { code, source: s.type });
      return;
    }
    if (!c.after) refuse('Actions cannot be deleted');
    const [r] = await actRows(tx, c.id);
    if (!r) invalid(`${c.id} was not found`);
    const owner = p.nameOf(r.owner_user_id);
    if (a.state !== b.state) {
      if ((ASTATE[r.status] ?? 'Open') !== b.state)
        refuse('This action was changed by someone else; reload and retry', 409);
      if (a.state === 'Ready for verification') {
        ro(ctx);
        if (r.owner_user_id !== ctx.userId) refuse(`only the action owner (${owner}) uploads evidence`);
        const ev = (a.ev ?? {}) as J;
        const file = textLen(str(ev.file), 'Evidence file', 1, 255);
        const note = textLen(str(ev.note), 'What was done', 1, 2000);
        await tx.$executeRaw`
          UPDATE action SET status = 'EVIDENCE_SUBMITTED', evidence_file = ${file}, evidence_note = ${note},
                 evidence_by = ${ctx.userId}::uuid, evidence_at = now(), rejected_reason = NULL
           WHERE id = ${r.id}::uuid`;
        await history(ctx, tx, r.id, r.status, 'EVIDENCE_SUBMITTED', note);
        await auditRow(ctx, tx, 'compliance.action.evidence', 'action', r.id, { code: r.code });
      } else if (a.state === 'Verified' && r.status === 'EVIDENCE_SUBMITTED') {
        need(ctx, 'gov rm dir', 'only governance or a manager can verify action evidence');
        if (r.owner_user_id === ctx.userId || r.evidence_by === ctx.userId)
          refuse('you own this action, so someone else must verify it');
        await tx.$executeRaw`
          UPDATE action SET status = 'VERIFIED', verifier_user_id = ${ctx.userId}::uuid, verified_at = now()
           WHERE id = ${r.id}::uuid`;
        await history(ctx, tx, r.id, r.status, 'VERIFIED', 'Evidence checked');
        await auditRow(ctx, tx, 'compliance.action.verify', 'action', r.id, { code: r.code, decision: 'ACCEPTED' });
        // v36: an audit whose actions are now all verified closes.
        if (r.source_type === 'AUDIT') {
          const closed = await tx.$queryRaw<{ id: string }[]>`
            UPDATE audit_run ar SET status = 'CLOSED'
             WHERE ar.id = (SELECT source_id FROM action WHERE id = ${r.id}::uuid)
               AND ar.status = 'ACTIONS_OPEN' AND ar.review_state = 'ACCEPTED'
               AND NOT EXISTS (SELECT 1 FROM action x WHERE x.source_type = 'AUDIT'
                                AND x.source_id = ar.id AND x.status <> 'VERIFIED')
            RETURNING ar.id`;
          for (const x of closed)
            await auditRow(ctx, tx, 'compliance.audit.close', 'audit_run', x.id, { reason: 'actions verified' });
        }
      } else if (a.state === 'Evidence rejected' && r.status === 'EVIDENCE_SUBMITTED') {
        need(ctx, 'gov rm dir', 'only governance or a manager');
        if (r.owner_user_id === ctx.userId) refuse('you own this action, so someone else must decide');
        const why = textLen(str(a.rej), 'Reason', 1, 2000);
        await tx.$executeRaw`
          UPDATE action SET status = 'REJECTED', rejected_reason = ${why} WHERE id = ${r.id}::uuid`;
        await history(ctx, tx, r.id, r.status, 'REJECTED', why);
        await auditRow(ctx, tx, 'compliance.action.verify', 'action', r.id, { code: r.code, decision: 'REJECTED' });
      } else refuse('not allowed');
    }
    if (a.owner !== b.owner || a.due !== b.due) {
      need(ctx, 'gov rm dir', 'only governance or a manager');
      const nOwner = p.needUserId(a.owner, 'Owner');
      const due = dateCol(a.due);
      if (!due) invalid('Choose the due date');
      await tx.$executeRaw`
        UPDATE action SET owner_user_id = ${nOwner}::uuid, deadline = ${due} WHERE id = ${r.id}::uuid`;
      const [cur] = await tx.$queryRaw<{ s: string }[]>`SELECT status::text AS s FROM action WHERE id = ${r.id}::uuid`;
      await history(ctx, tx, r.id, cur!.s, cur!.s, 'Owner or deadline changed');
      await auditRow(ctx, tx, 'compliance.action.update', 'action', r.id, {
        code: r.code,
        owner: a.owner !== b.owner,
        deadline: a.due !== b.due,
      });
    }
  });
}

export const actAdapter: V36Adapter = {
  key: 'act',
  shape: 'map',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const out: Record<string, V36Record> = {};
      for (const a of (await actRows(tx)).sort((x, y) => byCodeNo(x.code, y.code)))
        out[a.code] = actRecord(a, p);
      return out;
    }),
  apply: applyAct,
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM action`)[0]!.n === 0,
    ),
  import: (ctx, recs, all) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const SOF: Record<string, string> = {
        Open: 'OPEN',
        'Ready for verification': 'EVIDENCE_SUBMITTED',
        'Evidence rejected': 'REJECTED',
        Verified: 'VERIFIED',
      };
      for (const [code, raw] of Object.entries(recs as Record<string, J>)) {
        const a = raw;
        const src = String(a.src ?? 'Action');
        let s: { type: string; id: string };
        try {
          s = await sourceOf(ctx, tx, src);
        } catch {
          s = { type: 'MANUAL', id: ctx.orgId };
        }
        const st = SOF[String(a.state)] ?? 'OPEN';
        const ev = a.ev as J | undefined;
        const evBy = ev ? (p.userIdOf(ev.by) ?? null) : null;
        let ver = a.ver ? (p.userIdOf(a.ver.by) ?? ctx.userId) : null;
        if (ver && ver === evBy) ver = null;
        const status = st === 'VERIFIED' && !ver ? 'EVIDENCE_SUBMITTED' : st;
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO action (organisation_id, code, source_type, source_id, kind, title, severity,
                              owner_user_id, deadline, status, evidence_by, verifier_user_id, verified_at,
                              created_by, source_label, next_step, evidence_file, evidence_note,
                              evidence_at, rejected_reason)
          VALUES (${ctx.orgId}::uuid, ${code}, ${s.type}, ${s.id}::uuid,
                  ${/^re-audit/i.test(String(a.t)) ? 'REAUDIT' : 'ACTION'}, ${String(a.t)},
                  ${s.type === 'AUDIT' ? 'HIGH' : 'MEDIUM'}::alert_severity,
                  ${p.userIdOf(a.owner) ?? ctx.userId}::uuid, ${dateCol(a.due)},
                  ${status}::action_status, ${evBy}::uuid, ${status === 'VERIFIED' ? ver : null}::uuid,
                  ${status === 'VERIFIED' && a.ver?.on ? londonToUtc(a.ver.on) : null}, ${ctx.userId}::uuid,
                  ${src}, ${str(a.next)}, ${ev ? (str(ev.file) ?? 'Evidence') : null},
                  ${ev ? str(ev.note) : null}, ${ev?.on ? londonToUtc(ev.on) : null}, ${str(a.rej)})
          RETURNING id`;
        await tx.$executeRaw`
          INSERT INTO action_history (organisation_id, action_id, from_status, to_status, note, by_user_id)
          VALUES (${ctx.orgId}::uuid, ${row!.id}::uuid, NULL, ${status}::action_status,
                  'Moved in from the saved v36 record', ${ctx.userId}::uuid)`;
        const n = Number(/(\d+)$/.exec(code)?.[1] ?? 0);
        await tx.$executeRaw`
          INSERT INTO org_counter (organisation_id, prefix, value) VALUES (app_org_id(), 'ACT', ${Math.max(n, 200)})
          ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)`;
      }
      // Risks list the actions that treat them, also those raised from an incident or audit.
      for (const r of (Array.isArray(all.risk) ? all.risk : []) as J[])
        for (const code of (r.acts ?? []) as string[])
          await tx.$executeRaw`
            UPDATE risk SET linked_action_ids = array_append(linked_action_ids, a.id)
              FROM action a
             WHERE risk.code = ${String(r.id)} AND a.code = ${code}
               AND NOT (a.source_type = 'RISK' AND a.source_id = risk.id)
               AND NOT (a.id = ANY (risk.linked_action_ids))`;
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'action', ctx.orgId, { key: 'act' });
    }),
};
