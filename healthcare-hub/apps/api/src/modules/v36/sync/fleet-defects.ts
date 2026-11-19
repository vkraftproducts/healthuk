// v36 S.def (defects board) ↔ defect, defect_release (step 2, 18 Nov 2026).
import { randomUUID } from 'node:crypto';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople } from './lookup.js';
import {
  auditSql,
  bumpCounter,
  day,
  deny,
  fromLondon,
  loadFleet,
  lStamp,
  need,
  obj,
  same,
  scratchOf,
  str,
  ymd,
} from './fleet-common.js';
import type { V36Adapter, V36Ctx, V36Record } from './types.js';

const SEV: Record<string, string> = { CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' };
const SEV_IN: Record<string, 'CRITICAL' | 'MAJOR' | 'MINOR'> = {
  Critical: 'CRITICAL',
  Major: 'MAJOR',
  Minor: 'MINOR',
};
const STAGE: Record<string, string> = {
  OPEN: 'Reported',
  REPAIRING: 'In repair',
  REPAIRED: 'Signed off',
  RELEASED: 'Returned to service',
};
/** The release reason sent when v36's note is left empty. */
const NO_NOTE = 'Returned to service';

interface Extra {
  id: string;
  report_note: string | null;
  photo_count: number | null;
  repair_work: string | null;
  sent_back_at: Date | null;
  sent_back_by: string | null;
  sent_back_reason: string | null;
}

/** The work recorded at sign-off, for rows signed off before repair_work was kept apart. */
function workOf(notes: string | null, plan: string | null): string {
  const parts = (notes ?? '')
    .split(/\n\n/)
    .map((x) => x.trim())
    .filter((x) => x && x !== plan?.trim() && !/^Sent back for repair on /.test(x));
  return parts.at(-1) ?? '';
}

export const defAdapter: V36Adapter = {
  key: 'def',
  shape: 'map',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const rows = await tx.defect.findMany({
        where: { vehicleId: { not: null } },
        include: { release: true },
        orderBy: [{ discoveredAt: 'asc' }],
      });
      const extra = new Map(
        (rows.length
          ? await tx.$queryRaw<Extra[]>`
              SELECT id, report_note, photo_count, repair_work, sent_back_at, sent_back_by, sent_back_reason
                FROM defect WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`
          : []
        ).map((x) => [x.id, x]),
      );
      const vdis = rows.some((r) => r.sourceVdiId)
        ? new Map(
            (
              await tx.vdi.findMany({
                where: { id: { in: rows.flatMap((r) => (r.sourceVdiId ? [r.sourceVdiId] : [])) } },
                select: { id: true, code: true },
              })
            ).map((v) => [v.id, v.code]),
          )
        : new Map<string, string | null>();
      const out: Record<string, V36Record> = {};
      for (const d of rows) {
        const x = extra.get(d.id);
        const code = d.code ?? d.id;
        const r: V36Record = {
          id: code,
          veh: f.callsignOf(d.vehicleId),
          sev: SEV[d.severity] ?? d.severity,
          desc: d.description,
          by: p.nameOf(d.reportedBy) ?? '',
          on: lStamp(d.discoveredAt),
        };
        if (d.sourceVdiId) r.from = vdis.get(d.sourceVdiId) ?? null;
        r.stage = STAGE[d.status] ?? d.status;
        r.owner = p.nameOf(d.ownerUserId) ?? '';
        r.review = ymd(d.reviewBy);
        r.stop = d.stopUse;
        r.photos = x?.photo_count ?? d.photoEvidenceItemIds.length;
        if (x?.report_note) r.note = x.report_note;
        if (d.repairStartedAt || d.repairPlan)
          r.repair = {
            plan: d.repairPlan ?? '',
            by: p.nameOf(d.repairStartedBy) ?? '',
            on: lStamp(d.repairStartedAt),
          };
        if (d.repairedAt)
          r.sign = {
            work: x?.repair_work ?? workOf(d.repairNotes, d.repairPlan),
            sheet: d.jobSheetRef ?? '',
            by: p.nameOf(d.repairedBy) ?? '',
            on: lStamp(d.repairedAt),
          };
        if (d.release)
          r.rts = {
            by: p.nameOf(d.release.releasedBy) ?? '',
            on: lStamp(d.release.at),
            note: d.release.reason === NO_NOTE ? '' : d.release.reason,
          };
        if (x?.sent_back_at)
          r.back = {
            by: p.nameOf(x.sent_back_by) ?? '',
            on: lStamp(x.sent_back_at),
            why: x.sent_back_reason ?? '',
          };
        out[code] = r;
      }
      return out;
    });
  },
  async apply(ctx, c) {
    if (!c.after) throw new HubError('FORBIDDEN', 403, 'Defects are never deleted');
    if (!c.before) return report(ctx, c.after);
    const a = c.after;
    const b = c.before;
    const code = c.id;
    const d = await ctx.tx((tx) =>
      tx.defect.findFirst({ where: { code }, include: { release: true } }),
    );
    if (!d) throw new HubError('NOT_FOUND', 404, `${code} not found`);
    const was = str(b, 'stage');
    const now = str(a, 'stage');
    let done = false;
    // defStart: Reported → In repair, with the plan and a new review date.
    if (was === 'Reported' && now === 'In repair') {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can start a repair');
      const plan = str(obj(a, 'repair'), 'plan')?.trim();
      if (!plan) throw new HubError('VALIDATION_FAILED', 400, 'Required · repair plan');
      await ctx.api(
        'PATCH',
        `/defects/${d.id}`,
        { status: 'REPAIRING', repairNotes: plan, ...(a.review ? { reviewBy: a.review } : {}) },
        d.version,
      );
      done = true;
    }
    // defSign: In repair → Signed off (work done, optional job sheet).
    else if (was === 'In repair' && now === 'Signed off') {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can sign off a repair');
      const s = obj(a, 'sign');
      const work = str(s, 'work')?.trim();
      if (!work)
        throw new HubError('VALIDATION_FAILED', 400, 'Required · work done, and confirm it was tested');
      const sheet = str(s, 'sheet')?.trim();
      await ctx.api(
        'PATCH',
        `/defects/${d.id}`,
        {
          status: 'REPAIRED',
          repairNotes: work,
          ...(sheet ? { jobSheetRef: sheet.slice(0, 40) } : {}),
          ...(a.review ? { reviewBy: a.review } : {}),
        },
        d.version,
      );
      done = true;
    }
    // defRts: Signed off → Returned to service (a second person; managers only in v36).
    else if (now === 'Returned to service' && was !== now) {
      need(
        ctx,
        'rm dir',
        'only the Registered Manager or the Director (deputy) can return a vehicle to service',
      );
      if (d.repairedBy === ctx.userId)
        deny('you signed off this repair, so someone else must return it to service', 403);
      const note = str(obj(a, 'rts'), 'note')?.trim() ?? '';
      await ctx.api('POST', `/defects/${d.id}/release`, {
        reason: note.length >= 3 ? note.slice(0, 500) : note ? `${NO_NOTE}: ${note}` : NO_NOTE,
      });
      done = true;
    }
    // defBack: Signed off → In repair, with what still needs doing.
    else if (was === 'Signed off' && now === 'In repair') {
      need(ctx, 'rm dir', 'only the Registered Manager or Director can reject a sign-off');
      const why = str(obj(a, 'back'), 'why')?.trim() ?? '';
      if (!why) throw new HubError('VALIDATION_FAILED', 400, 'Say what still needs doing');
      await ctx.api('POST', `/defects/${d.id}/reopen`, {
        reason: why.length >= 3 ? why.slice(0, 500) : `Not done: ${why}`,
      });
      done = true;
    }
    // defOwner: owner and / or review date (any stage before release).
    if (!done && (a.owner !== b.owner || a.review !== b.review)) {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can change this');
      const ownerUserId =
        a.owner !== b.owner
          ? await ctx.tx(async (tx) => (await loadPeople(tx)).needUserId(str(a, 'owner'), 'The owner'))
          : undefined;
      await ctx.api(
        'PATCH',
        `/defects/${d.id}`,
        {
          ...(ownerUserId ? { ownerUserId } : {}),
          ...(a.review !== b.review && a.review ? { reviewBy: a.review } : {}),
        },
        d.version,
      );
      done = true;
    }
    if (done) return;
    const keep = ['id', 'veh', 'sev', 'desc', 'by', 'on', 'from', 'stop', 'photos', 'note'];
    if (keep.some((k) => !same(a[k], b[k])))
      deny('a reported defect cannot be edited; report a new one');
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.defect.count({ where: { vehicleId: { not: null } } })) === 0);
  },
  async import(ctx, records) {
    const list = Object.values(records as Record<string, V36Record>);
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const lead = await tx.membership.findFirst({
        where: { validTo: null, role: { key: 'FLEET_LEAD' } },
        select: { userId: true },
      });
      const at = (s: unknown) =>
        typeof s === 'string' && s.length >= 10
          ? fromLondon(s.slice(0, 10), s.slice(11, 16) || '12:00')
          : null;
      for (const r of list) {
        const vid = f.idOf(str(r, 'veh'));
        if (!vid) continue;
        const sev = SEV_IN[str(r, 'sev') ?? ''] ?? 'MAJOR';
        const stage = str(r, 'stage');
        const repair = obj(r, 'repair');
        const sign = obj(r, 'sign');
        const rts = obj(r, 'rts');
        const back = obj(r, 'back');
        const by = p.userIdOf(str(r, 'by')) ?? ctx.userId;
        const status =
          stage === 'In repair' ? 'REPAIRING' : stage === 'Signed off' || stage === 'Returned to service' ? 'REPAIRED' : 'OPEN';
        const from = str(r, 'from')
          ? await tx.vdi.findFirst({ where: { code: str(r, 'from')! }, select: { id: true } })
          : null;
        const id = randomUUID();
        const plan = str(repair, 'plan');
        const work = str(sign, 'work');
        await tx.$executeRaw`
          INSERT INTO defect (id, organisation_id, vehicle_id, severity, stop_use, description,
                              reported_by, discovered_at, source_vdi_id, status, owner_user_id,
                              review_by, repair_deadline, code, repair_plan, repair_started_at, repair_started_by,
                              repair_notes, repaired_at, repaired_by, job_sheet_ref, report_note,
                              photo_count, repair_work, sent_back_at, sent_back_by, sent_back_reason)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${vid}::uuid, ${sev}::defect_severity,
                  ${sev === 'CRITICAL' || r.stop === true}, ${str(r, 'desc') ?? '—'}, ${by}::uuid,
                  ${at(r.on) ?? new Date()}, ${from?.id ?? null}::uuid, ${status}::defect_status,
                  ${p.userIdOf(str(r, 'owner')) ?? lead?.userId ?? null}::uuid,
                  ${typeof r.review === 'string' ? day(r.review) : null}::date,
                  ${typeof r.review === 'string' && sev !== 'CRITICAL' ? day(r.review) : null}::date, ${String(r.id)},
                  ${plan}, ${at(repair?.on)}, ${p.userIdOf(str(repair, 'by'))}::uuid,
                  ${[plan, work].filter(Boolean).join('\n\n') || null},
                  ${sign ? at(sign.on) : null}, ${sign ? (p.userIdOf(str(sign, 'by')) ?? by) : null}::uuid,
                  ${str(sign, 'sheet') || null}, ${str(r, 'note') || null},
                  ${typeof r.photos === 'number' ? r.photos : Number(r.photos) || 0}::int, ${work},
                  ${at(back?.on)}, ${p.userIdOf(str(back, 'by'))}::uuid, ${str(back, 'why')})`;
        if (stage === 'Returned to service') {
          const note = str(rts, 'note')?.trim();
          await tx.$executeRaw`
            INSERT INTO defect_release (organisation_id, defect_id, released_by, reason, at)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${p.userIdOf(str(rts, 'by')) ?? ctx.userId}::uuid,
                    ${note && note.length >= 3 ? note : NO_NOTE}, ${at(rts?.on) ?? new Date()})`;
          await tx.$executeRaw`UPDATE defect SET status = 'RELEASED' WHERE id = ${id}::uuid`;
        }
        await auditSql(ctx, tx, 'fleet.defect.import', 'defect', id, { code: String(r.id) });
      }
      await bumpCounter(tx, ctx.orgId, 'DEF', list.map((r) => String(r.id)));
      const { refreshVehicleStatus } = await import('@hub/domain');
      for (const v of new Set(list.map((r) => f.idOf(str(r, 'veh'))).filter((x): x is string => !!x)))
        await refreshVehicleStatus(tx, v);
    });
  },
};

/** defNew / phDefect / raiseDefect: a new defect through POST /defects. */
async function report(ctx: V36Ctx, r: V36Record) {
  const from = str(r, 'from');
  // Raised by a daily check this same button just submitted: POST /vdis already made it.
  if (from) {
    const s = scratchOf(ctx);
    if (!s.checks.has(from)) deny('a defect from a daily check is raised by submitting the check');
    const photos = Number(r.photos) || 0;
    const vdiCode = s.checks.get(from)!;
    if (photos)
      await ctx.tx(async (tx) => {
        const v = await tx.vdi.findFirst({ where: { code: vdiCode }, select: { id: true } });
        if (v)
          await tx.$executeRaw`
            UPDATE defect SET photo_count = ${photos} WHERE source_vdi_id = ${v.id}::uuid AND photo_count IS NULL`;
      });
    return;
  }
  need(
    ctx,
    'crew fleet rm dir gov',
    'only crew, the Fleet Lead, governance or a manager can report a defect',
  );
  const desc = str(r, 'desc')?.trim() ?? '';
  if (!desc) throw new HubError('VALIDATION_FAILED', 400, 'Required · what is wrong');
  const vehicleId = await ctx.tx(async (tx) => (await loadFleet(tx)).need(str(r, 'veh')));
  const severity = SEV_IN[str(r, 'sev') ?? ''] ?? 'MAJOR';
  const note = str(r, 'note')?.trim();
  const photos = Number(r.photos);
  await ctx.api('POST', '/defects', {
    vehicleId,
    severity,
    stopUse: r.stop === true || severity === 'CRITICAL',
    description: desc.length >= 3 ? desc.slice(0, 1000) : `Defect: ${desc}`,
    clientSubmissionId: randomUUID(),
    ...(note ? { note: note.slice(0, 1000) } : {}),
    ...(Number.isFinite(photos) ? { photoCount: Math.max(0, Math.min(50, Math.trunc(photos))) } : {}),
  });
}
