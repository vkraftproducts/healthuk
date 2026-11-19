// v36 S.clean (pre-shift IPC cleans), S.clean2 (deep cleans) and S.dcNeed (infectious-transfer
// blocks) ↔ cleaning_record, vehicle.quarantined, vehicle_status_change (step 2, 18 Nov 2026).
// S.dcEvery (28) is a fixed v36 rule with no button that changes it: it stays in the saved copy.
import { randomUUID } from 'node:crypto';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople } from './lookup.js';
import {
  addDays,
  auditSql,
  deny,
  fromLondon,
  lDate,
  loadFleet,
  lTimeS,
  need,
  same,
  str,
  v36Roles,
} from './fleet-common.js';
import type { V36Adapter, V36Ctx, V36Record } from './types.js';

export const INFECTIOUS_REASON = 'Deep clean needed after infectious transfer';
const ENHANCED = 'Enhanced deep clean (after infection)';
const SCHEDULED = 'Scheduled deep clean';
const HISTORY_DAYS = 35;
const realToday = () => lDate(new Date())!;

function crewOnly(ctx: V36Ctx) {
  if (!v36Roles(ctx).has('crew'))
    throw new HubError('FORBIDDEN', 403, 'only crew can submit from the phone app');
}

export const cleanAdapter: V36Adapter = {
  key: 'clean',
  shape: 'map',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const rows = await tx.cleaningRecord.findMany({
        where: {
          type: 'PRE_SHIFT',
          capturedAt: { gte: fromLondon(addDays(ctx.today, -HISTORY_DAYS), '00:00') },
        },
        orderBy: { capturedAt: 'asc' },
      });
      const out: Record<string, V36Record> = {};
      for (const r of rows) {
        const cs = f.callsignOf(r.vehicleId);
        if (!cs) continue;
        out[`${cs}|${lDate(r.capturedAt)}`] = { t: lTimeS(r.capturedAt), by: p.nameOf(r.cleanedBy) ?? '' };
      }
      return out;
    });
  },
  // phClean: the crew confirm today's pre-shift clean of their vehicle.
  async apply(ctx, c) {
    if (!c.after) deny('a clean record is never removed', 403);
    crewOnly(ctx);
    const [veh, date] = c.id.split('|');
    if (date !== realToday()) deny('only today’s clean can be confirmed');
    const vehicleId = await ctx.tx(async (tx) => (await loadFleet(tx)).need(veh));
    await ctx.api('POST', '/cleaning-records', {
      clientSubmissionId: randomUUID(),
      vehicleId,
      type: 'PRE_SHIFT',
      capturedAt: new Date().toISOString(),
    });
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.cleaningRecord.count({ where: { type: 'PRE_SHIFT' } })) === 0);
  },
  async import(ctx, records) {
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      for (const [k, r] of Object.entries(records as Record<string, V36Record>)) {
        const [veh, date] = k.split('|');
        const vid = f.idOf(veh);
        if (!vid || !date) continue;
        const id = randomUUID();
        const at = fromLondon(date, (str(r, 't') ?? '07:00').slice(0, 8));
        await tx.$executeRaw`
          INSERT INTO cleaning_record (id, organisation_id, vehicle_id, type, cleaned_by, client_submission_id, captured_at, received_at)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${vid}::uuid, 'PRE_SHIFT'::cleaning_type,
                  ${p.userIdOf(str(r, 'by')) ?? ctx.userId}::uuid, ${randomUUID()}::uuid, ${at}, ${at})`;
        await auditSql(ctx, tx, 'fleet.cleaning.import', 'cleaning_record', id, { type: 'PRE_SHIFT' });
      }
    });
  },
};

export const clean2Adapter: V36Adapter = {
  key: 'clean2',
  shape: 'list',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const rows = await tx.$queryRaw<
        { id: string; code: string | null; vehicle_id: string; cleaned_by: string; checked_by: string | null; captured_at: Date; notes: string | null }[]
      >`SELECT id, code, vehicle_id, cleaned_by, checked_by, captured_at, notes
          FROM cleaning_record WHERE type = 'ENHANCED' ORDER BY captured_at, code`;
      return rows.map((r) => {
        const x: V36Record = {
          id: r.code ?? r.id,
          veh: f.callsignOf(r.vehicle_id),
          on: lDate(r.captured_at),
          by: p.nameOf(r.cleaned_by) ?? '',
          type: /enhanced/i.test(r.notes ?? '') ? ENHANCED : SCHEDULED,
        };
        if (r.checked_by) x.vby = p.nameOf(r.checked_by) ?? '';
        return x;
      });
    });
  },
  // dcRec: the deep clean, done by the named cleaner, checked by the person recording it.
  async apply(ctx, c) {
    if (!c.after || c.before) deny('a deep clean record is never changed or removed', 403);
    need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager');
    const r = c.after;
    const { vehicleId, cleanedBy } = await ctx.tx(async (tx) => ({
      vehicleId: (await loadFleet(tx)).need(str(r, 'veh')),
      cleanedBy: (await loadPeople(tx)).needUserId(str(r, 'by'), 'The cleaner'),
    }));
    if (cleanedBy === ctx.userId) deny('someone other than the cleaner must check the deep clean', 409);
    const type = str(r, 'type') === ENHANCED ? ENHANCED : SCHEDULED;
    await ctx.api('POST', '/cleaning-records/deep', {
      vehicleId,
      cleanedOn: str(r, 'on') && str(r, 'on')! <= realToday() ? str(r, 'on') : realToday(),
      cleanedBy,
      checkedBy: ctx.userId,
      note: type,
    });
  },
  async isEmpty(ctx) {
    return ctx.tx(async (tx) => (await tx.cleaningRecord.count({ where: { type: 'ENHANCED' } })) === 0);
  },
  async import(ctx, records) {
    const list = (Array.isArray(records) ? records : Object.values(records)) as V36Record[];
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      for (const r of list) {
        const vid = f.idOf(str(r, 'veh'));
        if (!vid || !str(r, 'on')) continue;
        const id = randomUUID();
        const at = fromLondon(str(r, 'on')!, '12:00');
        const chk = p.userIdOf(str(r, 'vby') ?? str(r, 'rec'));
        await tx.$executeRaw`
          INSERT INTO cleaning_record (id, organisation_id, vehicle_id, type, cleaned_by, checked_by,
                                       client_submission_id, captured_at, received_at, notes, code)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${vid}::uuid, 'ENHANCED'::cleaning_type,
                  ${p.userIdOf(str(r, 'by')) ?? ctx.userId}::uuid, ${chk}::uuid, ${randomUUID()}::uuid,
                  ${at}, ${at}, ${str(r, 'type') ?? SCHEDULED}, ${str(r, 'id')})`;
        await auditSql(ctx, tx, 'fleet.cleaning.import', 'cleaning_record', id, { code: str(r, 'id') });
      }
      const max = Math.max(0, ...list.map((r) => Number(/(\d+)$/.exec(String(r.id))?.[1] ?? 0)));
      if (max)
        await tx.$executeRaw`
          INSERT INTO org_counter (organisation_id, prefix, value) VALUES (${ctx.orgId}::uuid, 'DC', ${max})
          ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value)`;
    });
  },
};

export const dcNeedAdapter: V36Adapter = {
  key: 'dcNeed',
  shape: 'map',
  async load(ctx) {
    return ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const vs = await tx.vehicle.findMany({
        where: { quarantined: true, quarantineReason: INFECTIOUS_REASON },
        select: { id: true, callsign: true, updatedAt: true, updatedBy: true },
      });
      const out: Record<string, V36Record> = {};
      for (const v of vs) {
        const [h] = await tx.$queryRaw<{ changed_at: Date; changed_by: string; journey_ref: string | null }[]>`
          SELECT changed_at, changed_by, journey_ref FROM vehicle_status_change
           WHERE vehicle_id = ${v.id}::uuid AND flag = 'QUARANTINE' AND set_on
           ORDER BY changed_at DESC LIMIT 1`;
        out[v.callsign] = {
          on: lDate(h?.changed_at ?? v.updatedAt),
          by: p.nameOf(h?.changed_by ?? v.updatedBy) ?? '',
          j: h?.journey_ref ?? '',
        };
      }
      return out;
    });
  },
  async apply(ctx, c) {
    const vehicleId = await ctx.tx(async (tx) => (await loadFleet(tx)).need(c.id));
    // dcFlag: block the vehicle until an enhanced deep clean.
    if (!c.before && c.after) {
      const j = str(c.after, 'j')?.trim();
      await ctx.api('POST', `/vehicles/${vehicleId}/infectious-transfer`, j ? { journey: j.slice(0, 40) } : {});
      return;
    }
    // dcRec with an enhanced clean lifts it: the clean2 change that follows does that (a
    // scheduled clean leaves the block, and the reload shows it still there).
    if (c.before && !c.after) {
      if (ctx.act !== 'dcRec') deny('record an enhanced deep clean to lift the block');
      return;
    }
    if (!same(c.before, c.after)) deny('the infectious-transfer record cannot be changed');
  },
  /** Fleet care never used yet: no deep clean and no quarantine on record. */
  async isEmpty(ctx) {
    return ctx.tx(
      async (tx) =>
        (await tx.cleaningRecord.count({ where: { type: 'ENHANCED' } })) === 0 &&
        (await tx.vehicleStatusChange.count({ where: { flag: 'QUARANTINE' } })) === 0,
    );
  },
  async import(ctx, records) {
    await ctx.tx(async (tx) => {
      const p = await loadPeople(tx);
      const f = await loadFleet(tx);
      const { refreshVehicleStatus } = await import('@hub/domain');
      for (const [veh, r] of Object.entries(records as Record<string, V36Record>)) {
        const vid = f.idOf(veh);
        if (!vid) continue;
        await tx.vehicle.update({
          where: { id: vid },
          data: { quarantined: true, quarantineReason: INFECTIOUS_REASON },
        });
        await tx.$executeRaw`
          INSERT INTO vehicle_status_change (organisation_id, vehicle_id, flag, set_on, reason, changed_by, changed_at, journey_ref)
          VALUES (${ctx.orgId}::uuid, ${vid}::uuid, 'QUARANTINE', true, ${INFECTIOUS_REASON},
                  ${p.userIdOf(str(r, 'by')) ?? ctx.userId}::uuid,
                  ${str(r, 'on') ? fromLondon(str(r, 'on')!, '12:00') : new Date()}, ${str(r, 'j') || null})`;
        await refreshVehicleStatus(tx, vid);
        await auditSql(ctx, tx, 'fleet.vehicle.infectious.import', 'vehicle', vid);
      }
    });
  },
};
