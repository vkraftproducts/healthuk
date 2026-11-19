// S.pol (policies, SOPs, guidance, critical instructions) ↔ policy_document, policy_version,
// policy_acknowledgement, policy_staff_ack; S.risk ↔ risk, risk_review (+ actions by source).
import type { TenantTx } from '@hub/db';
import { loadPeople, ymd, type People } from './lookup.js';
import type { V36Adapter, V36Change, V36Ctx, V36Record } from './types.js';
import {
  addDays,
  allocCode,
  auditRow,
  byCodeNo,
  dateCol,
  invalid,
  londonDay,
  londonToUtc,
  need,
  refuse,
  str,
  textLen,
  type J,
} from './governance-common.js';

// ---- policies -------------------------------------------------------------------------------------
const PCAT: Record<string, string> = {
  Policy: 'POLICY',
  SOP: 'SOP',
  Guidance: 'GUIDANCE',
  'Critical instruction': 'CRITICAL_INSTRUCTION',
};
const PCAT_LABEL = Object.fromEntries(Object.entries(PCAT).map(([k, v]) => [v, k]));
const jobKey = (t: string) => t.trim().toUpperCase().replace(/\s+/g, '_');
const jobLabel = (k: string) => {
  const s = k.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const addMonths = (iso: string, m: number) => {
  const [y, mo, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, mo - 1 + m, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};

interface PolRow {
  id: string;
  ref: string | null;
  code: string;
  title: string;
  category: string;
  owner_user_id: string;
  reader_roles: string[];
  reader_everyone: boolean;
  lv_id: string;
  lv_version: number;
  lv_status: string;
  lv_summary: string;
  lv_created_by: string;
  pv_id: string | null;
  pv_approved_by: string | null;
  pv_effective_from: Date | null;
  pv_review_date: Date | null;
}
const polRows = (tx: TenantTx, ref: string | null = null) =>
  tx.$queryRaw<PolRow[]>`
    SELECT d.id, d.ref, d.code, d.title, d.category, d.owner_user_id, d.reader_roles, d.reader_everyone,
           l.id AS lv_id, l.version AS lv_version, l.status::text AS lv_status, l.summary AS lv_summary,
           l.created_by AS lv_created_by, pv.id AS pv_id, pv.approved_by AS pv_approved_by,
           pv.effective_from AS pv_effective_from, pv.review_date AS pv_review_date
      FROM policy_document d
      JOIN LATERAL (SELECT * FROM policy_version v WHERE v.document_id = d.id AND v.status <> 'ARCHIVED'
                     ORDER BY v.version DESC LIMIT 1) l ON true
      LEFT JOIN LATERAL (SELECT * FROM policy_version v WHERE v.document_id = d.id
                          AND v.status = 'PUBLISHED' LIMIT 1) pv ON true
     WHERE (${ref}::text IS NULL OR coalesce(d.ref, d.code) = ${ref})`;

async function buildPol(tx: TenantTx, rows: PolRow[], p: People) {
  const pvs = rows.map((r) => r.pv_id).filter((x): x is string => !!x);
  const acks = await tx.$queryRaw<{ v: string; staff: string | null; on: Date }[]>`
    SELECT a.policy_version_id AS v,
           (SELECT s.staff_no FROM staff s WHERE s.user_id = a.user_id ORDER BY s.created_at LIMIT 1) AS staff,
           a.at AS on
      FROM policy_acknowledgement a WHERE a.policy_version_id = ANY (${pvs}::uuid[])
    UNION ALL
    SELECT k.policy_version_id, s.staff_no, k.acknowledged_on::timestamptz
      FROM policy_staff_ack k JOIN staff s ON s.id = k.staff_id
     WHERE k.policy_version_id = ANY (${pvs}::uuid[])`;
  const sortKey = (r: PolRow) => r.ref ?? r.code;
  return rows
    .sort((a, b) => byCodeNo(sortKey(a), sortKey(b)))
    .map((r) => {
      const published = r.lv_status === 'PUBLISHED';
      const o: J = {
        id: r.ref ?? r.code,
        code: r.code,
        t: r.title,
        type: PCAT_LABEL[r.category] ?? 'Policy',
        owner: p.nameOf(r.owner_user_id),
        v: r.lv_version,
        state: published ? 'Published' : 'Draft',
        roles: r.reader_everyone ? 'All' : r.reader_roles.map(jobLabel).join(','),
      };
      if (r.pv_id) {
        o.pub = p.nameOf(r.pv_approved_by);
        o.on = ymd(r.pv_effective_from);
        o.review = ymd(r.pv_review_date);
      }
      if (r.lv_summary) o.summary = r.lv_summary;
      if (!published) o.drafted = p.nameOf(r.lv_created_by);
      const ack: J = {};
      for (const a of acks.filter((a) => a.v === r.pv_id && a.staff).sort((x, y) => +x.on - +y.on))
        if (!(a.staff! in ack)) ack[a.staff!] = a.on instanceof Date ? londonDay(a.on) : String(a.on);
      o.ack = ack;
      return o as V36Record;
    });
}

function readers(roles: unknown) {
  const s = String(roles ?? 'All');
  if (s === 'All') return { every: true, list: [] as string[] };
  return { every: false, list: s.split(',').map(jobKey).filter(Boolean) };
}

async function applyPol(ctx: V36Ctx, c: V36Change) {
  const a = (c.after ?? {}) as J;
  const b = (c.before ?? {}) as J;
  await ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    if (!c.before) {
      need(ctx, 'gov rm dir hr', 'not allowed');
      const code = String(a.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code))
        invalid('Code: use capital letters, numbers and dashes (for example SG-01)');
      const dup = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM policy_document WHERE code = ${code}`;
      if (dup[0]!.n) invalid(`A document with code ${code} already exists`);
      const ref = await allocCode(tx, 'policy_document', c.id, 'POL-', { column: 'ref', width: 2 });
      const r = readers(a.roles);
      const [d] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO policy_document (organisation_id, code, title, category, owner_user_id, reader_roles,
                                     reader_everyone, created_by, ref)
        VALUES (${ctx.orgId}::uuid, ${code}, ${textLen(str(a.t), 'Title', 2, 200)},
                ${PCAT[String(a.type)] ?? 'POLICY'}, ${ctx.userId}::uuid, ${r.list}::text[], ${r.every},
                ${ctx.userId}::uuid, ${ref})
        RETURNING id`;
      await tx.$executeRaw`
        INSERT INTO policy_version (organisation_id, document_id, version, status, summary, created_by)
        VALUES (${ctx.orgId}::uuid, ${d!.id}::uuid, 1, 'DRAFT', ${String(a.summary ?? '').slice(0, 2000)},
                ${ctx.userId}::uuid)`;
      await auditRow(ctx, tx, 'compliance.policy.create', 'policy_document', d!.id, { code });
      return;
    }
    if (!c.after) refuse('Policies are archived, not deleted');
    const [r] = await polRows(tx, c.id);
    if (!r) invalid(`${c.id} was not found`);
    // New draft version (polNew).
    if (Number(a.v) > Number(b.v)) {
      need(ctx, 'gov rm dir hr', 'not allowed');
      if (r.lv_version !== Number(b.v)) refuse('This policy was changed by someone else; reload and retry', 409);
      const summary = textLen(str(a.summary), 'What changed', 1, 2000);
      if (r.lv_status !== 'PUBLISHED')
        await tx.$executeRaw`UPDATE policy_version SET status = 'ARCHIVED' WHERE id = ${r.lv_id}::uuid`;
      const [v] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO policy_version (organisation_id, document_id, version, status, summary, created_by)
        VALUES (${ctx.orgId}::uuid, ${r.id}::uuid, ${r.lv_version + 1}, 'DRAFT', ${summary}, ${ctx.userId}::uuid)
        RETURNING id`;
      await auditRow(ctx, tx, 'compliance.policy.version', 'policy_version', v!.id, {
        code: r.code,
        version: r.lv_version + 1,
      });
      return;
    }
    // Publish (polPub).
    if (a.state === 'Published' && b.state === 'Draft') {
      need(ctx, 'gov rm dir', 'only governance or a manager can publish');
      if (r.lv_status === 'PUBLISHED') refuse('This policy was changed by someone else; reload and retry', 409);
      if (r.lv_created_by === ctx.userId)
        refuse('you drafted this version, so a second person must publish it');
      const on = ctx.today;
      await tx.$executeRaw`
        UPDATE policy_version SET status = 'SUPERSEDED' WHERE document_id = ${r.id}::uuid AND status = 'PUBLISHED'`;
      await tx.$executeRaw`
        UPDATE policy_version SET status = 'PUBLISHED', approved_by = ${ctx.userId}::uuid, approved_at = now(),
               published_at = now(), effective_from = ${dateCol(on)}, review_date = ${dateCol(addMonths(on, 12))}
         WHERE id = ${r.lv_id}::uuid`;
      await auditRow(ctx, tx, 'compliance.policy.publish', 'policy_version', r.lv_id, {
        code: r.code,
        version: r.lv_version,
      });
      return;
    }
    // Acknowledge (polAck): a new key in ack for the signed-in person.
    const before = (b.ack ?? {}) as J;
    const added = Object.keys((a.ack ?? {}) as J).filter((k) => !(k in before));
    if (added.length) {
      need(ctx, 'crew', 'only staff acknowledge policies');
      if (!r.pv_id) invalid('Only a published version can be acknowledged');
      const mine = await tx.$queryRaw<{ staff_no: string }[]>`
        SELECT staff_no FROM staff WHERE user_id = ${ctx.userId}::uuid`;
      if (added.some((k) => !mine.some((m) => m.staff_no === k)))
        refuse('you can only acknowledge for yourself');
      const done = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM policy_acknowledgement
         WHERE policy_version_id = ${r.pv_id}::uuid AND user_id = ${ctx.userId}::uuid`;
      if (!done[0]!.n) {
        const [k] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO policy_acknowledgement (organisation_id, policy_version_id, user_id, device)
          VALUES (${ctx.orgId}::uuid, ${r.pv_id}::uuid, ${ctx.userId}::uuid, 'web')
          RETURNING id`;
        await auditRow(ctx, tx, 'compliance.policy.acknowledge', 'policy_acknowledgement', k!.id, {
          code: r.code,
        });
      }
      return;
    }
    if (Object.keys(before).some((k) => !(k in ((a.ack ?? {}) as J))))
      refuse('An acknowledgement cannot be withdrawn');
  });
}

export const polAdapter: V36Adapter = {
  key: 'pol',
  shape: 'list',
  load: (ctx) => ctx.tx(async (tx) => buildPol(tx, await polRows(tx), await loadPeople(tx))),
  apply: applyPol,
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM policy_document`)[0]!
          .n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      for (const raw of (Array.isArray(recs) ? recs : Object.values(recs)) as J[]) {
        const x = raw;
        const r = readers(x.roles);
        const owner = p.userIdOf(x.owner) ?? ctx.userId;
        const [d] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO policy_document (organisation_id, code, title, category, owner_user_id, reader_roles,
                                       reader_everyone, created_by, ref)
          VALUES (${ctx.orgId}::uuid, ${String(x.code)}, ${String(x.t)}, ${PCAT[String(x.type)] ?? 'POLICY'},
                  ${owner}::uuid, ${r.list}::text[], ${r.every}, ${owner}::uuid, ${String(x.id)})
          RETURNING id`;
        const pub = x.state === 'Published';
        const v = Number(x.v) || 1;
        let pvId: string | null = null;
        // A draft of a published policy: the earlier published version holds the acks.
        const pubVersion = pub ? v : x.pub ? v - 1 : null;
        if (pubVersion && pubVersion >= 1) {
          let creator = p.userIdOf(x.drafted) ?? owner;
          const approver = p.userIdOf(x.pub) ?? ctx.userId;
          if (creator === approver) creator = approver === ctx.userId ? owner : ctx.userId;
          const [pv] = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO policy_version (organisation_id, document_id, version, status, summary, material,
                                        effective_from, review_date, approved_by, approved_at, published_at,
                                        created_by, created_at)
            VALUES (${ctx.orgId}::uuid, ${d!.id}::uuid, ${pubVersion}, 'PUBLISHED',
                    ${pub ? String(x.summary ?? '') : ''}, true, ${dateCol(x.on)}, ${dateCol(x.review)},
                    ${creator === approver ? null : approver}::uuid, ${x.on ? londonToUtc(`${x.on} 09:00`) : new Date()},
                    ${x.on ? londonToUtc(`${x.on} 09:00`) : new Date()}, ${creator}::uuid,
                    ${x.on ? londonToUtc(`${x.on} 09:00`) : new Date()})
            RETURNING id`;
          pvId = pv!.id;
        }
        if (!pub)
          await tx.$executeRaw`
            INSERT INTO policy_version (organisation_id, document_id, version, status, summary, created_by)
            VALUES (${ctx.orgId}::uuid, ${d!.id}::uuid, ${v}, 'DRAFT', ${String(x.summary ?? '')},
                    ${p.userIdOf(x.drafted) ?? owner}::uuid)`;
        if (pvId)
          for (const [code, on] of Object.entries((x.ack ?? {}) as Record<string, string>)) {
            const s = p.staffIdOf(code);
            if (!s) continue;
            await tx.$executeRaw`
              INSERT INTO policy_staff_ack (organisation_id, policy_version_id, staff_id, acknowledged_on, recorded_by)
              VALUES (${ctx.orgId}::uuid, ${pvId}::uuid, ${s}::uuid, ${dateCol(on)}, ${ctx.userId}::uuid)
              ON CONFLICT DO NOTHING`;
          }
      }
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'policy_document', ctx.orgId, { key: 'pol' });
    }),
};

// ---- risks ----------------------------------------------------------------------------------------
interface RiskRow {
  id: string;
  code: string;
  hazard: string;
  people_affected: string;
  inherent_likelihood: number;
  inherent_impact: number;
  controls: string;
  residual_likelihood: number;
  residual_impact: number;
  owner_user_id: string;
  review_date: Date;
  status: string;
  category: string | null;
  version: number;
}
const riskRows = (tx: TenantTx, code: string | null = null) =>
  tx.$queryRaw<RiskRow[]>`
    SELECT id, code, hazard, people_affected, inherent_likelihood, inherent_impact, controls,
           residual_likelihood, residual_impact, owner_user_id, review_date, status, category, version
      FROM risk WHERE (${code}::text IS NULL OR code = ${code})`;

async function buildRisk(tx: TenantTx, rows: RiskRow[], p: People) {
  const ids = rows.map((r) => r.id);
  const rev = await tx.$queryRaw<{ risk_id: string; l: number; i: number; at: Date }[]>`
    SELECT risk_id, residual_likelihood AS l, residual_impact AS i, reviewed_at AS at
      FROM risk_review WHERE risk_id = ANY (${ids}::uuid[]) ORDER BY reviewed_at, id`;
  const acts = await tx.$queryRaw<{ source_id: string; code: string }[]>`
    SELECT source_id, code FROM action WHERE source_type = 'RISK' AND source_id = ANY (${ids}::uuid[])
    UNION
    SELECT r.id, a.code FROM risk r JOIN action a ON a.id = ANY (r.linked_action_ids)
     WHERE r.id = ANY (${ids}::uuid[])`;
  return rows
    .sort((a, b) => byCodeNo(a.code, b.code))
    .map((r) => {
      const o: J = {
        id: r.code,
        h: r.hazard,
        who: r.people_affected,
        l0: r.inherent_likelihood,
        i0: r.inherent_impact,
        ctl: r.controls,
        l1: r.residual_likelihood,
        i1: r.residual_impact,
        owner: p.nameOf(r.owner_user_id),
        review: ymd(r.review_date),
        acts: acts
          .filter((a) => a.source_id === r.id)
          .map((a) => a.code)
          .sort(byCodeNo),
        state: r.status === 'OPEN' ? 'Open' : 'Closed',
      };
      if (r.category === 'HARASSMENT') o.harass = true;
      const h = rev.filter((x) => x.risk_id === r.id);
      if (h.length) o.hist = h.map((x) => ({ on: londonDay(x.at), s: x.l * x.i }));
      return o as V36Record;
    });
}
const lvl = (v: unknown, what: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) invalid(`${what}: choose 1 to 5`);
  return n;
};
/** A review score as likelihood × impact, keeping the impact where it divides. */
function factor(s: number, impact: number): [number, number] {
  if (s % impact === 0 && s / impact >= 1 && s / impact <= 5) return [s / impact, impact];
  for (let i = 5; i >= 1; i--) if (s % i === 0 && s / i <= 5) return [s / i, i];
  return [1, Math.min(5, Math.max(1, s))];
}

async function applyRisk(ctx: V36Ctx, c: V36Change) {
  const a = (c.after ?? {}) as J;
  const b = (c.before ?? {}) as J;
  need(ctx, 'gov rm dir', 'only governance or a manager');
  await ctx.tx(async (tx) => {
    const p = await loadPeople(tx);
    if (!c.before) {
      const code = await allocCode(tx, 'risk', c.id, 'RSK-', { width: 2, counter: 'RSK' });
      const h = textLen(str(a.h), 'Hazard or risk', 3, 500);
      const [r] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO risk (organisation_id, code, title, hazard, people_affected, inherent_likelihood,
                          inherent_impact, controls, residual_likelihood, residual_impact, owner_user_id,
                          review_date, status, category, created_by)
        VALUES (${ctx.orgId}::uuid, ${code}, ${h.slice(0, 200)}, ${h},
                ${textLen(str(a.who), 'Who could be harmed', 2, 300)}, ${lvl(a.l0, 'Likelihood before')},
                ${lvl(a.i0, 'Impact before')}, ${textLen(str(a.ctl), 'Controls in place', 3, 4000)},
                ${lvl(a.l1, 'Likelihood with controls')}, ${lvl(a.i1, 'Impact with controls')},
                ${p.needUserId(a.owner, 'Owner')}::uuid, ${dateCol(a.review) ?? dateCol(addDays(ctx.today, 90))},
                'OPEN', ${a.harass ? 'HARASSMENT' : 'OTHER'}, ${ctx.userId}::uuid)
        RETURNING id`;
      await auditRow(ctx, tx, 'compliance.risk.create', 'risk', r!.id, { code });
      return;
    }
    if (!c.after) refuse('Risks are closed, not deleted');
    const [r] = await riskRows(tx, c.id);
    if (!r) invalid(`${c.id} was not found`);
    const reviewed = ['ctl', 'l1', 'i1', 'review'].some((k) => a[k] !== b[k]);
    if (!reviewed) return; // actions are linked from the action itself (rkAct)
    if (r.version && (r.residual_likelihood !== Number(b.l1) || r.residual_impact !== Number(b.i1)))
      refuse('This risk was changed by someone else; reload and retry', 409);
    const l1 = lvl(a.l1, 'Likelihood with controls');
    const i1 = lvl(a.i1, 'Impact with controls');
    const ctl = textLen(str(a.ctl), 'Controls in place', 3, 4000);
    const next = dateCol(a.review);
    if (!next) invalid('Choose the next review date');
    await tx.$executeRaw`
      UPDATE risk SET controls = ${ctl}, residual_likelihood = ${l1}, residual_impact = ${i1},
             review_date = ${next} WHERE id = ${r.id}::uuid`;
    const [rv] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO risk_review (organisation_id, risk_id, residual_likelihood, residual_impact, controls,
                               note, next_review_on, reviewed_by)
      VALUES (${ctx.orgId}::uuid, ${r.id}::uuid, ${l1}, ${i1}, ${ctl},
              ${`Reviewed: ${r.residual_likelihood * r.residual_impact} → ${l1 * i1}`}, ${next},
              ${ctx.userId}::uuid)
      RETURNING id`;
    await auditRow(ctx, tx, 'compliance.risk.review', 'risk', r.id, {
      code: r.code,
      reviewId: rv!.id,
      score: l1 * i1,
    });
  });
}

export const riskAdapter: V36Adapter = {
  key: 'risk',
  shape: 'list',
  load: (ctx) => ctx.tx(async (tx) => buildRisk(tx, await riskRows(tx), await loadPeople(tx))),
  apply: applyRisk,
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM risk`)[0]!.n === 0,
    ),
  import: (ctx, recs) =>
    ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      let max = 0;
      for (const raw of (Array.isArray(recs) ? recs : Object.values(recs)) as J[]) {
        const x = raw;
        const owner = p.userIdOf(x.owner) ?? ctx.userId;
        const [r] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO risk (organisation_id, code, title, hazard, people_affected, inherent_likelihood,
                            inherent_impact, controls, residual_likelihood, residual_impact, owner_user_id,
                            review_date, status, category, created_by)
          VALUES (${ctx.orgId}::uuid, ${String(x.id)}, ${String(x.h).slice(0, 200)}, ${String(x.h)},
                  ${String(x.who)}, ${Number(x.l0)}, ${Number(x.i0)}, ${String(x.ctl)}, ${Number(x.l1)},
                  ${Number(x.i1)}, ${owner}::uuid, ${dateCol(x.review)},
                  ${x.state === 'Open' || !x.state ? 'OPEN' : 'CLOSED'}, ${x.harass ? 'HARASSMENT' : 'OTHER'},
                  ${owner}::uuid)
          RETURNING id`;
        for (const h of (x.hist ?? []) as J[]) {
          const [l, i] = factor(Number(h.s), Number(x.i1));
          await tx.$executeRaw`
            INSERT INTO risk_review (organisation_id, risk_id, residual_likelihood, residual_impact, controls,
                                     note, next_review_on, reviewed_by, reviewed_at)
            VALUES (${ctx.orgId}::uuid, ${r!.id}::uuid, ${l}, ${i}, ${String(x.ctl)},
                    ${`Reviewed – score ${h.s}`}, ${dateCol(x.review)}, ${owner}::uuid,
                    ${londonToUtc(`${h.on} 11:00`)})`;
        }
        max = Math.max(max, Number(/(\d+)$/.exec(String(x.id))?.[1] ?? 0));
      }
      await tx.$executeRaw`
        INSERT INTO org_counter (organisation_id, prefix, value) VALUES (app_org_id(), 'RSK', ${Math.max(1, max)})
        ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)`;
      await auditRow(ctx, tx, 'governance.saved_copy.import', 'risk', ctx.orgId, { key: 'risk' });
    }),
};
