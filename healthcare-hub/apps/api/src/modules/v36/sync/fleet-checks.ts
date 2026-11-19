// v36 S.cl (daily check list versions) and S.checks (daily vehicle checks) ↔ vdi_template, vdi,
// vdi_item_result, vdi_amendment, vdi_note (step 2, 18 Nov 2026).
import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople } from './lookup.js';
import {
  addDays,
  auditSql,
  deny,
  fromLondon,
  lDate,
  loadFleet,
  lStamp,
  lTime,
  need,
  same,
  scratchOf,
} from './fleet-common.js';
import type { V36Adapter, V36Ctx, V36Record } from './types.js';

type Item = { code: string; label: string; critical: boolean };
interface Tpl {
  id: string;
  name: string;
  version: number;
  items: Item[];
  status: string;
  active: boolean;
  created_by: string | null;
  created_at: Date;
  published_by: string | null;
  published_at: Date | null;
}
const STATE: Record<string, string> = {
  PUBLISHED: 'Published',
  DRAFT: 'Draft',
  RETIRED: 'Retired',
};

/**
 * The organisation's daily check list: every version of the checklist family in use (the name of
 * the newest version), so v36's version numbers are unique.
 */
export async function checklist(tx: TenantTx): Promise<Tpl[]> {
  const all = await tx.$queryRaw<Tpl[]>`
    SELECT id, name, version, items, status, active, created_by, created_at, published_by, published_at
      FROM vdi_template ORDER BY version DESC, created_at DESC`;
  const fam = all[0]?.name;
  return all.filter((t) => t.name === fam).reverse();
}

export const clAdapter: V36Adapter = {
  key: 'cl',
  shape: 'list',
  idField: 'v',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      return (await checklist(tx)).map((t) => {
        const r: V36Record = { v: t.version, state: STATE[t.status] ?? t.status };
        r.by = p.nameOf(t.created_by) ?? '';
        if (t.published_by) r.pub = p.nameOf(t.published_by) ?? '';
        r.on = lDate(t.status === 'DRAFT' ? t.created_at : (t.published_at ?? t.created_at));
        r.items = t.items.map((i) => [i.label, i.critical ? 1 : 0]);
        return r;
      });
    });
  },
  async apply(ctx, c) {
    const tpls = await ctx.tx((tx) => checklist(tx));
    const v = Number(c.id);
    const cur = tpls.find((t) => t.version === v);
    if (!c.after) throw new HubError('FORBIDDEN', 403, 'A check list version cannot be removed');
    // clNew: a new draft.
    if (!c.before || !cur) {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can draft a check list');
      if (tpls.some((t) => t.status === 'DRAFT'))
        deny('a draft is already waiting to be published');
      const lines = (c.after.items as [string, number][]) ?? [];
      if (lines.length < 3) throw new HubError('VALIDATION_FAILED', 400, 'Give at least 3 items');
      const latest = [...tpls].reverse().find((t) => t.status === 'PUBLISHED') ?? tpls.at(-1);
      const known = new Map((latest?.items ?? []).map((i) => [i.label, i.code]));
      const used = new Set<string>(tpls.flatMap((t) => t.items.map((i) => i.code)));
      const mine = new Set<string>();
      let n = 0;
      const items = lines.map(([label, crit]) => {
        let code = known.get(label);
        if (!code || mine.has(code)) {
          do code = `C${String(++n).padStart(2, '0')}`;
          while (used.has(code) || mine.has(code));
        }
        mine.add(code);
        return { code, label: String(label).slice(0, 200), critical: !!crit };
      });
      await ctx.api('POST', '/vdi-templates', {
        name: latest?.name ?? 'Daily vehicle check',
        items,
      });
      return;
    }
    const was = c.before.state;
    const now = c.after.state;
    if (was === now) {
      if (!same(c.before.items, c.after.items))
        deny('a check list version cannot be changed; draft a new version');
      return;
    }
    // clPub: the draft becomes the list in use (the endpoint retires the previous one).
    if (was === 'Draft' && now === 'Published') {
      need(ctx, 'rm dir gov fleet', 'only a manager or governance lead can publish');
      if (cur.created_by === ctx.userId)
        deny('you drafted this version, so a second person must publish it', 403);
      await ctx.api('POST', `/vdi-templates/${cur.id}/publish`);
      return;
    }
    // The previous version retires as part of publishing the next (same button).
    if (was === 'Published' && now === 'Retired') return;
    deny('that change to a check list version is not possible');
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.vdiTemplate.count()) === 0);
  },
  async import(ctx, records) {
    const list = (Array.isArray(records) ? records : Object.values(records)) as V36Record[];
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const codes = new Map<string, string>();
      for (const r of [...list].sort((a, b) => Number(a.v) - Number(b.v))) {
        const items = ((r.items as [string, number][]) ?? []).map(([label, crit]) => {
          if (!codes.has(label)) codes.set(label, `C${String(codes.size + 1).padStart(2, '0')}`);
          return { code: codes.get(label)!, label, critical: !!crit };
        });
        const status =
          r.state === 'Published' ? 'PUBLISHED' : r.state === 'Draft' ? 'DRAFT' : 'RETIRED';
        const on = typeof r.on === 'string' ? fromLondon(r.on, '09:00') : new Date();
        const by = p.userIdOf(r.by as string);
        const pub = status === 'DRAFT' ? null : p.userIdOf(r.pub as string);
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO vdi_template (id, organisation_id, name, version, items, active, status,
                                    created_by, created_at, published_by, published_at)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, 'Daily vehicle check', ${Number(r.v)}::int,
                  ${JSON.stringify(items)}::jsonb, ${status === 'PUBLISHED'}, ${status},
                  ${by}::uuid, ${on}, ${pub}::uuid, ${status === 'DRAFT' ? null : on})`;
        await auditSql(ctx, tx, 'fleet.vdi_template.import', 'vdi_template', id, {
          version: Number(r.v),
        });
      }
    });
  },
};

// ---- checks ---------------------------------------------------------------------------------
const RES: Record<string, string> = { PASS: 'Pass', FAIL: 'Fail', NA: 'N/A' };
const RES_IN: Record<string, 'PASS' | 'FAIL' | 'NA'> = { Pass: 'PASS', Fail: 'FAIL', 'N/A': 'NA' };
/** How far back v36's check history reaches (its History tab shows the last ten days). */
const HISTORY_DAYS = 35;

export const checksAdapter: V36Adapter = {
  key: 'checks',
  shape: 'list',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const since = fromLondon(addDays(ctx.today, -HISTORY_DAYS), '00:00');
      const rows = await tx.vdi.findMany({
        where: { capturedAt: { gte: since } },
        include: {
          items: true,
          amendments: { orderBy: { at: 'asc' } },
          defects: { select: { code: true } },
          template: { select: { version: true, items: true } },
        },
        orderBy: [{ capturedAt: 'asc' }],
      });
      const notes = rows.length
        ? await tx.$queryRaw<{ vdi_id: string; text: string; by_user_id: string; at: Date }[]>`
            SELECT vdi_id, text, by_user_id, at FROM vdi_note
             WHERE vdi_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY at`
        : [];
      return rows.map((v) => {
        const tItems = v.template.items as Item[];
        const res: Record<string, string> = {};
        const nts: Record<string, string> = {};
        const byCode = new Map(v.items.map((i) => [i.itemCode, i]));
        let fail = false;
        let crit = false;
        tItems.forEach((it, i) => {
          const r = byCode.get(it.code);
          res[String(i)] = RES[r?.result ?? 'PASS'] ?? 'Pass';
          if (r?.result === 'FAIL') {
            fail = true;
            if (r.critical) crit = true;
            if (r.reason) nts[String(i)] = r.reason;
          }
        });
        const rec: V36Record = {
          id: v.code ?? v.id,
          veh: f.callsignOf(v.vehicleId),
          date: lDate(v.capturedAt),
          time: lTime(v.capturedAt),
          by: p.nameOf(v.checkerUserId) ?? '',
          v: v.template.version,
          odo: v.odometer,
          res,
          out: crit ? 'Fail – critical' : fail ? 'Fail' : 'Pass',
        };
        if (Object.keys(nts).length) rec.notes = nts;
        const defs = v.defects.map((d) => d.code).filter((x): x is string => !!x);
        if (defs.length) rec.def = defs.sort().join(', ');
        const label = (code: string) => tItems.find((t) => t.code === code)?.label ?? code;
        const amend = [
          ...v.amendments.map((a) => ({
            at: a.at,
            on: lStamp(a.at),
            by: p.nameOf(a.amendedBy) ?? '',
            t: `${label(a.itemCode)} → ${RES[a.newResult] ?? a.newResult}: ${a.reason}`,
          })),
          ...notes
            .filter((n) => n.vdi_id === v.id)
            .map((n) => ({ at: n.at, on: lStamp(n.at), by: p.nameOf(n.by_user_id) ?? '', t: n.text })),
        ]
          .sort((a, b) => a.at.getTime() - b.at.getTime())
          .map(({ on, by, t }) => ({ on, by, t }));
        if (amend.length) rec.amend = amend;
        return rec;
      });
    });
  },
  async apply(ctx, c) {
    if (!c.after) throw new HubError('FORBIDDEN', 403, 'A daily check is never deleted');
    if (!c.before) return submitCheck(ctx, c.after);
    // chkView › Add amendment: the record stays as it was; the correction is added beside it.
    const { amend: a0, ...b } = c.before;
    const { amend: a1, ...a } = c.after;
    if (!same(a, b)) deny('the original record is never changed; add an amendment');
    const old = (a0 as unknown[] | undefined) ?? [];
    const now = ((a1 as V36Record[] | undefined) ?? []).slice(old.length);
    if (!now.length) return;
    const code = String(c.after.id);
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const v = await tx.vdi.findFirst({ where: { code }, select: { id: true, checkerUserId: true } });
      if (!v) throw new HubError('NOT_FOUND', 404, `${code} not found`);
      if (v.checkerUserId !== ctx.userId)
        deny(`Only ${p.nameOf(v.checkerUserId) ?? 'the checker'} can amend their own check.`, 403);
      for (const n of now) {
        const text = typeof n.t === 'string' ? n.t.trim() : '';
        if (!text) throw new HubError('VALIDATION_FAILED', 400, 'Required · amendment text');
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO vdi_note (id, organisation_id, vdi_id, text, by_user_id)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${v.id}::uuid, ${text.slice(0, 2000)}, ${ctx.userId}::uuid)`;
        await auditSql(ctx, tx, 'fleet.vdi.amend', 'vdi', v.id, { note: id });
      }
    });
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.vdi.count()) === 0);
  },
  async import(ctx, records) {
    const list = (Array.isArray(records) ? records : Object.values(records)) as V36Record[];
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const tpls = await checklist(tx);
      for (const r of list) {
        const vid = f.idOf(r.veh as string);
        const tpl = tpls.find((t) => t.version === Number(r.v)) ?? tpls.at(-1);
        if (!vid || !tpl || typeof r.date !== 'string') continue;
        const by = p.userIdOf(r.by as string) ?? ctx.userId;
        const at = fromLondon(r.date, typeof r.time === 'string' ? r.time : '07:00');
        const res = (r.res ?? {}) as Record<string, string>;
        const notes = (r.notes ?? {}) as Record<string, string>;
        const fail = tpl.items.some((_, i) => res[String(i)] === 'Fail');
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO vdi (id, organisation_id, vehicle_id, template_id, checker_user_id, odometer,
                           outcome, client_submission_id, captured_at, received_at, code)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${vid}::uuid, ${tpl.id}::uuid, ${by}::uuid,
                  ${Number(r.odo) || 0}::int, ${fail ? 'FAIL' : 'PASS'}::check_result, ${randomUUID()}::uuid,
                  ${at}, ${at}, ${String(r.id)})`;
        for (const [i, it] of tpl.items.entries()) {
          const result = RES_IN[res[String(i)] ?? 'Pass'] ?? 'PASS';
          await tx.$executeRaw`
            INSERT INTO vdi_item_result (organisation_id, vdi_id, item_code, critical, result, reason)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${it.code}, ${it.critical},
                    ${result}::check_result, ${notes[String(i)] ?? null})`;
        }
        for (const a of (r.amend as V36Record[] | undefined) ?? []) {
          const on = typeof a.on === 'string' ? a.on : `${r.date} ${r.time ?? '07:00'}`;
          await tx.$executeRaw`
            INSERT INTO vdi_note (organisation_id, vdi_id, text, by_user_id, at)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${String(a.t ?? '').slice(0, 2000) || '—'},
                    ${p.userIdOf(a.by as string) ?? by}::uuid, ${fromLondon(on.slice(0, 10), on.slice(11, 16) || '12:00')})`;
        }
        await auditSql(ctx, tx, 'fleet.vdi.import', 'vdi', id, { code: String(r.id) });
      }
      // New checks continue after the imported numbers (VDI-5523 …).
      const max = Math.max(0, ...list.map((r) => Number(/(\d+)$/.exec(String(r.id))?.[1] ?? 0)));
      if (max)
        await tx.$executeRaw`
          INSERT INTO org_counter (organisation_id, prefix, value) VALUES (${ctx.orgId}::uuid, 'VDI', ${max})
          ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value)`;
    });
  },
};

/** chkStart / phSubmit (doCheck): one new daily check, submitted through POST /vdis. */
async function submitCheck(ctx: V36Ctx, r: V36Record) {
  need(ctx, 'crew fleet rm dir', 'only crew, the Fleet Lead or a manager can do a daily check');
  const veh = String(r.veh ?? '');
  const { vehicleId, tpl, odo } = await ctx.tx(async (tx) => {
    const f = await loadFleet(tx);
    const vehicleId = f.need(veh);
    const v = await tx.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    const stop = await tx.defect.findFirst({
      where: { vehicleId, status: { not: 'RELEASED' }, OR: [{ stopUse: true }, { severity: 'CRITICAL' }] },
      select: { code: true },
    });
    if (stop || v.offRoad) deny(`${veh} is blocked; it cannot be checked into use`);
    const tpls = await checklist(tx);
    const tpl = [...tpls].reverse().find((t) => t.status === 'PUBLISHED' && t.active);
    if (!tpl) deny('there is no published check list');
    if (Number(r.v) !== tpl.version)
      deny(`check list v${String(r.v)} has been replaced by v${tpl.version}; reload and check again`, 409);
    return { vehicleId, tpl, odo: v.currentOdometer ?? 0 };
  });
  const reading = Number(r.odo);
  if (!Number.isFinite(reading) || reading < odo)
    throw new HubError(
      'VALIDATION_FAILED',
      400,
      `Check the odometer – it is lower than the last reading (${odo.toLocaleString('en-GB')})`,
    );
  const res = (r.res ?? {}) as Record<string, string>;
  const notes = (r.notes ?? {}) as Record<string, string>;
  const results = tpl.items.map((it, i) => {
    const result = RES_IN[res[String(i)] ?? 'Pass'] ?? 'PASS';
    const reason = notes[String(i)]?.trim();
    if (result === 'FAIL' && !reason)
      throw new HubError('VALIDATION_FAILED', 400, 'Add a note for each failed item');
    return { code: it.code, result, ...(reason ? { reason: reason.slice(0, 500) } : {}) };
  });
  const out = await ctx.api<{ code: string | null; id: string }>('POST', '/vdis', {
    clientSubmissionId: randomUUID(),
    vehicleId,
    templateId: tpl.id,
    odometer: reading,
    capturedAt: new Date().toISOString(),
    results,
    // v36 raises a non-critical failure as a Major defect (critical ones are Critical, stop use).
    failedSeverity: 'MAJOR',
  });
  const s = scratchOf(ctx);
  s.checks.set(String(r.id), out.code ?? out.id);
  s.odo.add(veh);
}
