// v36 S.veh (vehicle register: documents, service, odometer, off the road) ↔ vehicle,
// requirement_instance + evidence (MOT / insurance / tax), maintenance_plan, odometer_reading,
// vehicle_status_change (step 2, 18 Nov 2026).
import { randomUUID } from 'node:crypto';
import type { TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople, type People } from './lookup.js';
import {
  addDays,
  addMonths,
  auditSql,
  deny,
  fmtReg,
  fromLondon,
  lDate,
  lStamp,
  need,
  obj,
  same,
  scratchOf,
  str,
  v36Roles,
  ymd,
} from './fleet-common.js';
import { docStates, recordUpload, type DocState } from './fleet-evidence.js';
import type { V36Adapter, V36Ctx, V36Record } from './types.js';

/** v36 document keys ↔ the library templates for vehicles. */
export const DOC_CODE: Record<string, string> = {
  MOT: 'AMB-VEH-01',
  INS: 'AMB-VEH-02',
  VED: 'AMB-VEH-03',
  LOLER: 'AMB-VEH-04',
};
const DOC_OF = Object.fromEntries(Object.entries(DOC_CODE).map(([k, v]) => [v, k]));
const DOC_NAME: Record<string, string> = {
  MOT: 'MOT',
  INS: 'Insurance',
  VED: 'Vehicle tax',
  LOLER: 'LOLER',
};
const SERVICE = 'Scheduled service';
const daysBetween = (a: string, b: string | null) => {
  if (!b) return null;
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  return n > 0 && n <= 1100 ? n : null;
};
const BACK_ON_ROAD = 'Returned to the road';

function typeText(type: string, en1789: string | null): string {
  if (type === 'AMBULANCE') return `Emergency ambulance (Type ${en1789 ?? 'B'})`;
  if (type === 'PTS_VEHICLE') return 'Patient transport vehicle';
  if (type === 'WAV') return 'Wheelchair accessible vehicle';
  if (type === 'CAR') return 'Rapid response car';
  return type;
}
function typeIn(t: string): { type: string; en1789: string | null } {
  const m = /Type ([A-C]\d?)/.exec(t);
  if (/ambulance/i.test(t) && !/transport/i.test(t)) return { type: 'AMBULANCE', en1789: m?.[1] ?? 'B' };
  if (/wheelchair/i.test(t)) return { type: 'WAV', en1789: null };
  if (/car/i.test(t)) return { type: 'CAR', en1789: null };
  return { type: 'PTS_VEHICLE', en1789: null };
}
/** A plan's due date: the last service plus the plan's interval. */
const dueOn = (last: string, days: number) => addDays(last, days);

function docRecord(s: DocState, p: People): V36Record {
  if (s.applicability !== 'APPLICABLE') {
    const r: V36Record = { exp: ymd(s.expiry), s: 'na' };
    if (s.na) r.note = s.na;
    return r;
  }
  const okExp = ymd(s.ok?.validTo ?? null);
  if (s.pending) {
    const r: V36Record = {
      exp: ymd(s.pending.validTo),
      s: 'rcv',
      by: p.nameOf(s.pending.by) ?? '',
      file: s.pending.file,
      on: lDate(s.pending.at),
    };
    if (okExp) r.prevExp = okExp;
    return r;
  }
  if (s.rej && !(s.ok && okExp)) return { exp: ymd(s.rej.validTo), s: 'rej', rej: s.rej.reason };
  if (s.ok) {
    const r: V36Record = { exp: okExp ?? ymd(s.expiry), s: 'ok', vby: p.nameOf(s.ok.by) ?? '' };
    if (s.rej) r.rej = s.rej.reason;
    return r;
  }
  return { exp: ymd(s.expiry), s: 'none' };
}

async function vehicleDocs(tx: TenantTx, vehicleIds: string[]) {
  const inst = await tx.requirementInstance.findMany({
    where: { subjectType: 'VEHICLE', subjectId: { in: vehicleIds } },
    select: { id: true, subjectId: true, template: { select: { code: true } } },
  });
  const states = await docStates(
    tx,
    inst.filter((i) => DOC_OF[i.template.code]).map((i) => i.id),
  );
  return inst
    .filter((i) => DOC_OF[i.template.code])
    .map((i) => ({ vehicleId: i.subjectId, key: DOC_OF[i.template.code]!, state: states.get(i.id)! }));
}

export const vehAdapter: V36Adapter = {
  key: 'veh',
  shape: 'map',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const vs = await tx.vehicle.findMany({ orderBy: { callsign: 'asc' } });
      const ids = vs.map((v) => v.id);
      const locs = new Map((await tx.location.findMany({ select: { id: true, name: true } })).map((l) => [l.id, l.name]));
      const plans = await tx.maintenancePlan.findMany({
        where: { vehicleId: { in: ids }, active: true },
        orderBy: { createdAt: 'asc' },
      });
      const hist = await tx.vehicleStatusChange.findMany({
        where: { vehicleId: { in: ids }, flag: 'OFF_ROAD' },
        orderBy: { changedAt: 'asc' },
      });
      const docs = await vehicleDocs(tx, ids);
      const out: Record<string, V36Record> = {};
      for (const v of vs) {
        const d: Record<string, V36Record> = {};
        for (const k of ['MOT', 'INS', 'VED', 'LOLER']) {
          const x = docs.find((y) => y.vehicleId === v.id && y.key === k);
          if (x) d[k] = docRecord(x.state, p);
        }
        const plan =
          plans.find((x) => x.vehicleId === v.id && x.title === SERVICE) ??
          plans.find((x) => x.vehicleId === v.id);
        const last = ymd(plan?.lastDoneOn ?? null);
        const svc: V36Record = plan
          ? {
              due: last && plan.intervalDays ? dueOn(last, plan.intervalDays) : null,
              dueMi:
                plan.intervalMiles && plan.lastDoneOdometer !== null
                  ? plan.lastDoneOdometer + plan.intervalMiles
                  : null,
              last,
              lastMi: plan.lastDoneOdometer,
            }
          : {};
        const h = hist.filter((x) => x.vehicleId === v.id);
        const r: V36Record = {
          id: v.callsign,
          reg: fmtReg(v.registration),
          type: typeText(v.type, v.en1789Type),
          base: locs.get(v.baseLocationId) ?? '',
          odo: v.currentOdometer ?? 0,
          docs: d,
          svc,
          status: h.map((x) => ({
            on: lStamp(x.changedAt),
            by: p.nameOf(x.changedBy) ?? '',
            t: x.setOn ? 'Taken off the road' : 'Returned to the road',
            why: !x.setOn && x.reason === BACK_ON_ROAD ? '' : x.reason,
          })),
        };
        if (v.offRoad) {
          const on = h.filter((x) => x.setOn).at(-1);
          r.off = {
            on: lStamp(on?.changedAt ?? v.updatedAt),
            by: p.nameOf(on?.changedBy ?? v.updatedBy) ?? '',
            reason: v.offRoadReason ?? on?.reason ?? '',
          };
        }
        out[v.callsign] = r;
      }
      return out;
    });
  },
  async apply(ctx, c) {
    if (!c.before || !c.after)
      deny('vehicles are added and removed in Settings, not here', 403);
    const a = c.after;
    const b = c.before;
    const v = await ctx.tx((tx) => tx.vehicle.findFirst({ where: { callsign: c.id } }));
    if (!v) throw new HubError('NOT_FOUND', 404, `${c.id} not found`);
    let handled = false;
    // ---- documents: docUp / docVer / docRej
    const da = (obj(a, 'docs') ?? {}) as Record<string, V36Record>;
    const db = (obj(b, 'docs') ?? {}) as Record<string, V36Record>;
    for (const k of Object.keys(da)) {
      if (same(da[k], db[k])) continue;
      await applyDoc(ctx, v.id, c.id, k, db[k] ?? null, da[k]!);
      handled = true;
    }
    // ---- svcRec
    const svcChanged = !same(a.svc, b.svc);
    if (svcChanged) {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can record a service');
      const s = obj(a, 'svc') ?? {};
      const last = str(s, 'last');
      if (!last) throw new HubError('VALIDATION_FAILED', 400, 'Give the service date');
      const mi = Number(s.lastMi);
      const plan = await ctx.tx((tx) =>
        tx.maintenancePlan.findFirst({
          where: { vehicleId: v.id, active: true },
          orderBy: [{ createdAt: 'asc' }],
        }),
      );
      if (plan) {
        await ctx.api('POST', `/vehicles/${v.id}/maintenance/${plan.id}/done`, {
          doneOn: last,
          ...(Number.isFinite(mi) && mi >= 0 ? { odometer: Math.trunc(mi) } : {}),
        });
        // v36: the next service is due six calendar months later (181–184 days).
        const days = daysBetween(last, addMonths(last, 6));
        if (days && plan.intervalDays !== days)
          await ctx.tx(async (tx) => {
            await tx.maintenancePlan.update({
              where: { id: plan.id },
              data: { intervalDays: days, updatedBy: ctx.userId },
            });
            await auditSql(ctx, tx, 'fleet.maintenance.plan', 'maintenance_plan', plan.id, {
              intervalDays: days,
            });
          });
      }
      else
        await ctx.api('POST', `/vehicles/${v.id}/maintenance`, {
          title: SERVICE,
          intervalDays: daysBetween(last, addMonths(last, 6)) ?? 183,
          intervalMiles: 12000,
          lastDoneOn: last,
          ...(Number.isFinite(mi) && mi >= 0 ? { lastDoneOdometer: Math.trunc(mi) } : {}),
        });
      handled = true;
    }
    // ---- odoRec / miRec (a check or a service already recorded its own reading)
    // chkStart / phSubmit: the daily check records its own reading (POST /vdis).
    const viaCheck = ctx.act === 'chkStart' || ctx.act === 'phSubmit' || scratchOf(ctx).odo.has(c.id);
    if (a.odo !== b.odo && !svcChanged && !viaCheck) {
      if (ctx.act === 'miRec') need(ctx, 'fleet rm dir', 'not allowed');
      else need(ctx, 'fleet rm dir crew', 'not allowed');
      const r = Number(a.odo);
      const cur = v.currentOdometer ?? 0;
      if (!Number.isFinite(r) || r < cur)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          `Flagged · lower than the last reading (${cur.toLocaleString('en-GB')}), so it was not applied`,
        );
      if (r > cur)
        await ctx.api('POST', `/vehicles/${v.id}/odometer`, {
          reading: Math.trunc(r),
          readOn: lDate(new Date()),
        });
      handled = true;
    }
    // ---- offStart / offEnd
    const offA = obj(a, 'off');
    const offB = obj(b, 'off');
    if (!!offA !== !!offB) {
      need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager');
      if (offA) {
        const why = str(offA, 'reason')?.trim() ?? '';
        if (!why) throw new HubError('VALIDATION_FAILED', 400, 'Give the reason');
        await ctx.api('POST', `/vehicles/${v.id}/off-road`, {
          on: true,
          reason: why.length >= 3 ? why.slice(0, 500) : `Off the road: ${why}`,
        });
      } else {
        const roles = v36Roles(ctx);
        const took = await ctx.tx((tx) =>
          tx.vehicleStatusChange.findFirst({
            where: { vehicleId: v.id, flag: 'OFF_ROAD', setOn: true },
            orderBy: { changedAt: 'desc' },
            select: { changedBy: true },
          }),
        );
        if (took?.changedBy === ctx.userId && roles.has('fleet') && !roles.has('rm') && !roles.has('dir'))
          deny('you took it off the road, so a manager must return it', 403);
        const st = (a.status as V36Record[] | undefined) ?? [];
        const why = str(st.at(-1), 'why')?.trim() ?? '';
        await ctx.api('POST', `/vehicles/${v.id}/off-road`, {
          on: false,
          reason: why.length >= 3 ? why.slice(0, 500) : why ? `${BACK_ON_ROAD}: ${why}` : BACK_ON_ROAD,
        });
      }
      handled = true;
    }
    if (handled) return;
    const fixed = ['id', 'reg', 'type', 'base'];
    if (fixed.some((k) => !same(a[k], b[k])))
      deny('vehicle details are changed in Settings › Vehicles');
    // status[] alone (e.g. the history line of an off-road change) needs nothing more.
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.vehicle.count()) === 0);
  },
  async import(ctx, records) {
    const list = Object.values(records as Record<string, V36Record>);
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const { applyAutoRequirements, refreshVehicleStatus } = await import('@hub/domain');
      const locs = await tx.location.findMany({ select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
      if (!locs.length) return;
      const now = new Date();
      const lead = await tx.membership.findFirst({
        where: { validTo: null, role: { key: 'FLEET_LEAD' } },
        select: { userId: true },
      });
      const members = [
        ...new Set([
          ...(lead ? [lead.userId] : []),
          ...(await tx.membership.findMany({ where: { validTo: null }, select: { userId: true } })).map((m) => m.userId),
        ]),
      ];
      for (const r of list) {
        const callsign = str(r, 'id');
        if (!callsign) continue;
        const t = typeIn(str(r, 'type') ?? '');
        const loc = locs.find((l) => l.name === str(r, 'base')) ?? locs[0]!;
        const id = randomUUID();
        await tx.$executeRaw`
          INSERT INTO vehicle (id, organisation_id, registration, callsign, type, en1789_type,
                               base_location_id, current_odometer, stretcher, seats, created_by, updated_by)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${(str(r, 'reg') ?? callsign).replace(/\s+/g, '').toUpperCase()},
                  ${callsign}, ${t.type}::vehicle_type, ${t.en1789}, ${loc.id}::uuid,
                  ${Number(r.odo) || 0}::int, ${t.type === 'AMBULANCE'}, 2, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`;
        if (Number(r.odo))
          await tx.$executeRaw`
            INSERT INTO odometer_reading (organisation_id, vehicle_id, reading, read_on, source, recorded_by)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${Number(r.odo)}::int, ${ymd(now)}::date,
                    'MANUAL'::odometer_source, ${ctx.userId}::uuid)`;
        await applyAutoRequirements(
          tx,
          { subjectType: 'VEHICLE', subjectId: id, kind: t.type, locationId: loc.id, organisationId: ctx.orgId },
          ctx.userId,
          now,
        );
        // Documents: the verified copy (and any renewal waiting for verification).
        const inst = await tx.requirementInstance.findMany({
          where: { subjectType: 'VEHICLE', subjectId: id },
          select: { id: true, template: { select: { code: true } } },
        });
        const docs = (obj(r, 'docs') ?? {}) as Record<string, V36Record>;
        for (const [k, d] of Object.entries(docs)) {
          const i = inst.find((x) => x.template.code === DOC_CODE[k]);
          if (!i) continue;
          const s = str(d, 's');
          const okExp = s === 'rcv' ? str(d, 'prevExp') : str(d, 'exp');
          if ((s === 'ok' || (s === 'rcv' && okExp)) && okExp) {
            // The verified copy: uploaded by someone other than its verifier (four eyes).
            let rev = p.userIdOf(str(d, 'vby'));
            let by = s === 'ok' ? p.userIdOf(str(d, 'by')) : null;
            if (!by || by === rev) by = members.find((m) => m !== rev) ?? ctx.userId;
            if (!rev || rev === by) rev = members.find((m) => m !== by) ?? null;
            const vid = await recordUpload(ctx, tx, {
              instanceId: i.id,
              title: `${k} – ${callsign}`,
              file: `${k}.pdf`,
              validTo: okExp,
              uploadedBy: by,
              at: fromLondon(addDays(okExp, -365), '09:00'),
            });
            if (rev)
              await tx.$executeRaw`
                INSERT INTO verification (organisation_id, evidence_version_id, decision, reviewer_id, confirmed_valid_to)
                VALUES (${ctx.orgId}::uuid, ${vid}::uuid, 'ACCEPTED'::verification_decision, ${rev}::uuid, ${okExp}::date)`;
            await tx.$executeRaw`UPDATE requirement_instance SET expiry_date = ${okExp}::date WHERE id = ${i.id}::uuid`;
          }
          if (s === 'rcv')
            await recordUpload(ctx, tx, {
              instanceId: i.id,
              title: `${k} – ${callsign} (renewal)`,
              file: str(d, 'file') ?? `${k}.pdf`,
              validTo: str(d, 'exp'),
              uploadedBy: p.userIdOf(str(d, 'by')) ?? ctx.userId,
              at: typeof d.on === 'string' ? fromLondon(d.on, '09:00') : now,
            });
          const { recomputeInstance } = await import('@hub/domain');
          await recomputeInstance(tx, i.id, now);
        }
        const svc = obj(r, 'svc');
        if (svc && str(svc, 'last'))
          await tx.$executeRaw`
            INSERT INTO maintenance_plan (organisation_id, vehicle_id, title, interval_days, interval_miles,
                                          last_done_on, last_done_odometer, created_by, updated_by)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, ${SERVICE},
                    ${daysBetween(str(svc, 'last')!, str(svc, 'due')) ?? 183}::int,
                    ${Number(svc.dueMi) - Number(svc.lastMi) > 0 ? Number(svc.dueMi) - Number(svc.lastMi) : 12000}::int,
                    ${str(svc, 'last')}::date, ${Number(svc.lastMi) || null}::int, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`;
        for (const st of (r.status as V36Record[] | undefined) ?? []) {
          const on = str(st, 'on') ?? '';
          await tx.$executeRaw`
            INSERT INTO vehicle_status_change (organisation_id, vehicle_id, flag, set_on, reason, changed_by, changed_at)
            VALUES (${ctx.orgId}::uuid, ${id}::uuid, 'OFF_ROAD', ${str(st, 't') === 'Taken off the road'},
                    ${str(st, 'why') || BACK_ON_ROAD}, ${p.userIdOf(str(st, 'by')) ?? ctx.userId}::uuid,
                    ${on ? fromLondon(on.slice(0, 10), on.slice(11, 16) || '12:00') : now})`;
        }
        const off = obj(r, 'off');
        if (off)
          await tx.$executeRaw`
            UPDATE vehicle SET off_road = true, off_road_reason = ${str(off, 'reason') ?? 'Off the road'}
             WHERE id = ${id}::uuid`;
        await refreshVehicleStatus(tx, id);
        await auditSql(ctx, tx, 'fleet.vehicle.import', 'vehicle', id, { callsign });
      }
    });
  },
};

/** docUp / docVer / docRej on one vehicle document. */
async function applyDoc(
  ctx: V36Ctx,
  vehicleId: string,
  callsign: string,
  k: string,
  b: V36Record | null,
  a: V36Record,
) {
  const code = DOC_CODE[k];
  const inst = code
    ? await ctx.tx((tx) =>
        tx.requirementInstance.findFirst({
          where: { subjectType: 'VEHICLE', subjectId: vehicleId, template: { code } },
          select: { id: true },
        }),
      )
    : null;
  if (!inst) deny(`${DOC_NAME[k] ?? k} is not a requirement for ${callsign}`);
  const was = str(b, 's');
  const now = str(a, 's');
  const name = DOC_NAME[k] ?? k;
  if (now === 'rcv' && (was !== 'rcv' || str(a, 'file') !== str(b, 'file'))) {
    need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager can upload vehicle documents');
    const exp = str(a, 'exp');
    if (!exp) throw new HubError('VALIDATION_FAILED', 400, 'Give the date it is valid until');
    await ctx.tx((tx) =>
      recordUpload(ctx, tx, {
        instanceId: inst.id,
        title: `${k} – ${callsign} (renewal)`,
        file: str(a, 'file') ?? `${k}_Renewal_${callsign}.pdf`,
        validTo: exp,
      }),
    );
    return;
  }
  if (was !== 'rcv') deny(`that change to ${name} is not possible here`);
  const st = (await ctx.tx((tx) => docStates(tx, [inst.id]))).get(inst.id);
  const pend = st?.pending;
  if (!pend) deny(`${name} has nothing waiting for verification`, 409);
  const verb = now === 'rej' || (str(a, 'rej') && str(a, 'rej') !== str(b, 'rej')) ? 'reject' : 'verify';
  need(ctx, 'rm dir gov fleet', `only a manager, governance or the Fleet Lead can ${verb}`);
  if (pend.by === ctx.userId)
    deny(
      verb === 'verify'
        ? 'you uploaded this, so someone else must verify it'
        : 'you uploaded this, so someone else must decide',
      403,
    );
  if (verb === 'verify') {
    const exp = str(a, 'exp');
    await ctx.api('POST', `/evidence/${pend.id}/verify`, {
      decision: 'ACCEPTED',
      ...(exp ? { confirmedValidTo: exp } : {}),
    });
  } else {
    const why = str(a, 'rej')?.trim() ?? '';
    if (!why) throw new HubError('VALIDATION_FAILED', 400, 'Give the reason');
    await ctx.api('POST', `/evidence/${pend.id}/verify`, {
      decision: 'REJECTED',
      reason: why.length >= 3 ? why.slice(0, 1000) : `Rejected: ${why}`,
    });
  }
}
