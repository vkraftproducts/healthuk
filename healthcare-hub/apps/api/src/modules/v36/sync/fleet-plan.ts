// v36 fleet collections connected in part 3 (step 2, 19 Nov 2026):
//  - fjobs: journeys booked for later days ({ 'YYYY-MM-DD': [job, …] }). They are rows of the same
//    journeys table as S.jobs (v36_job, one row per journey with its job_date): when the day
//    comes they are that day's S.jobs, as v36's time machine rolls fjobs[TODAY] into jobs.
//    v36 buttons: jobNew for a later date (dispatcher or manager), wkMove (the week planner moves
//    a planned journey to another vehicle; blocked vehicles refused for today and tomorrow).
//  - med: medicines and gases on each vehicle ({ 'AMB-01': [[item, expected, found, expires]] });
//    medChk (Fleet Lead or manager) records an "all present" check: found = expected.
//  - dcEvery: deep clean every 28 days, a fixed v36 value (no button changes it).
import { allocationBlocks, JOBS } from './fleet-registers.js';
import {
  applyReg,
  lookups,
  need,
  onlyFields,
  refuse,
  register,
  single,
  toRec,
  type J,
  type RegDef,
} from './register-lib.js';
import type { V36Adapter, V36Change, V36Ctx } from './types.js';

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayNo = (d: string) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---- fjobs ------------------------------------------------------------------------------------
/** The journeys register for one later day: new rows get that job_date. */
function dayDef(day: string): RegDef {
  return {
    ...JOBS,
    scope: { ...JOBS.scope!, value: () => day },
    async check(ctx, c, l, tx) {
      if (c.isNew) return JOBS.check!(ctx, c, l, tx);
      // wkMove: only the vehicle of a planned journey changes.
      need(ctx, 'disp rm dir', 'only the dispatcher or a manager');
      onlyFields(c, ['veh'], 'Only the vehicle of a planned journey can change here');
      const to = c.after!.veh;
      if (typeof to !== 'string' || !l.fleet.idOf(to)) refuse(`Unknown vehicle ${String(to)}`, 400);
      if (dayNo(day) - dayNo(ctx.today) <= 1) {
        const b = await allocationBlocks(tx, l, { ...c.after!, crew: 'x', crew2: 'x' });
        if (b.length) refuse(`${to} is blocked – ${b[0]}`);
      }
    },
  };
}

const fjobs: V36Adapter = {
  key: 'fjobs',
  shape: 'map',
  load: (ctx) =>
    ctx.tx(async (tx) => {
      const l = await lookups(tx);
      const rows = await tx.$queryRaw<J[]>`
        SELECT * FROM v36_job WHERE job_date > ${ctx.today}::date ORDER BY job_date, pickup_time, code`;
      const out: Record<string, J[]> = {};
      for (const r of rows) {
        const d = (r.job_date as Date).toISOString().slice(0, 10);
        (out[d] ??= []).push(toRec(JOBS, r, l));
      }
      return out;
    }),
  async apply(ctx: V36Ctx, ch: V36Change) {
    const day = ch.id;
    if (!isDay(day)) refuse(`Not a day: ${day}`, 400);
    const before = (Array.isArray(ch.before) ? ch.before : []) as J[];
    const after = (Array.isArray(ch.after) ? ch.after : []) as J[];
    if (day <= ctx.today) {
      // v36's time machine moved this day into S.jobs: the rows are already today's journeys.
      if (!ch.after) return;
      refuse('Pick today or a future date', 400);
    }
    const d = dayDef(day);
    const prev = new Map(before.map((j) => [String(j.id), j]));
    for (const j of after) {
      const b = prev.get(String(j.id));
      prev.delete(String(j.id));
      if (b && same(b, j)) continue;
      await applyReg(ctx, d, { key: 'jobs', id: String(j.id), before: b ?? null, after: j });
    }
    for (const [id, b] of prev) await applyReg(ctx, d, { key: 'jobs', id, before: b, after: null });
  },
  isEmpty: (ctx) =>
    ctx.tx(
      async (tx) =>
        (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM v36_job WHERE job_date > ${ctx.today}::date`)[0]!
          .n === 0,
    ),
  async import(ctx, records) {
    // Every saved day is kept with its date: today's become S.jobs (as v36's time machine would
    // roll them), earlier ones stay on record as past journeys.
    for (const [day, list] of Object.entries((records ?? {}) as Record<string, unknown>)) {
      if (!isDay(day) || !Array.isArray(list)) continue;
      await register(dayDef(day)).import!(ctx, list as J[], {});
    }
  },
};

// ---- med --------------------------------------------------------------------------------------
type Item = [string, number, number, string];
const med = register({
  key: 'med',
  shape: 'map',
  scalar: true,
  table: 'v36_vehicle_stock',
  fields: [],
  order: 'code',
  check(ctx, c, l) {
    need(ctx, 'fleet rm dir', 'not allowed');
    if (c.isNew) refuse('Stock items are not added here', 400);
    if (!l.fleet.idOf(c.id)) refuse(`Unknown vehicle ${c.id}`, 400);
    const b = c.before as unknown as Item[];
    const a = c.after as unknown as Item[];
    const ok =
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((m, i) => {
        const o = b[i]!;
        return (
          Array.isArray(m) && m.length === o.length && m[0] === o[0] && m[1] === o[1] && m[3] === o[3] &&
          (m[2] === o[2] || m[2] === o[1])
        );
      });
    if (!ok) refuse('A stock check records items as present (found = expected); nothing else changes here', 400);
  },
});

// ---- dcEvery ----------------------------------------------------------------------------------
const dcEvery = single({ key: 'dcEvery', initial: 28 });

export const FLEET_PLAN_ADAPTERS: V36Adapter[] = [fjobs, med, dcEvery];
