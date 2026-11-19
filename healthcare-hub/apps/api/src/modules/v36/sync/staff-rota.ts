// v36 shifts and working rules connected to their tables: swaps (swaps), working-time exceptions
// (rotaEx), the person-level rota (rota), group training sessions (sessions), and the
// organisation's rules with their two-person change (rules, ruleProp). v36's rules for who may
// do what are repeated here with the signed-in person (see register-lib.ts for the engine).
import type { TenantTx } from '@hub/db';
import {
  changedTo,
  me,
  need,
  onlyFields,
  refuse,
  register,
  roleIs,
  sameName,
  type Change,
  type J,
  type Lookups,
} from './register-lib.js';
import type { V36Ctx } from './types.js';

const EDIT = 'rm dir hr disp';
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown): s is string => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
const hrs = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;
const dnum = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const addD = (d: string, n: number) => new Date((dnum(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** The signed-in person's staff code (v36 ME_PID), if they are staff. */
async function myCode(tx: TenantTx, ctx: V36Ctx): Promise<string | null> {
  const r = await tx.$queryRaw<{ c: string }[]>`SELECT staff_no AS c FROM staff WHERE user_id = ${ctx.userId}::uuid LIMIT 1`;
  return r[0]?.c ?? null;
}
/** A rule's value (S.rules[k].v), or v36's default. */
export async function ruleValue(tx: TenantTx, k: string, dflt: unknown): Promise<unknown> {
  const r = await tx.$queryRaw<{ v: unknown }[]>`SELECT value AS v FROM org_rule WHERE code = ${k}`;
  return r[0]?.v ?? dflt;
}

// ---- v36 rotaRules(pid), on the server ------------------------------------------------------
interface Sh {
  id: string;
  pid: string;
  date: string;
  start: string;
  end: string;
  drive: number;
}
const shiftLen = (s: Sh) => {
  const a = hrs(s.start);
  const b = hrs(s.end);
  return b > a ? b - a : b + 24 - a;
};
/** Warnings per shift of one person, exactly as v36 words them. */
export function rotaWarnings(all: Sh[], pid: string, optOut: boolean): Map<string, string[]> {
  const L = all.filter((s) => s.pid === pid).sort((a, b) => ((a.date + a.start) < (b.date + b.start) ? -1 : 1));
  const out = new Map<string, string[]>();
  L.forEach((s, i) => {
    const w: string[] = [];
    if (shiftLen(s) > 12) w.push('Shift over 12 hours');
    if (s.drive > 10) w.push('Driving over 10 hours (company policy)');
    const prev = L[i - 1];
    if (prev) {
      const endsNext = hrs(prev.end) <= hrs(prev.start);
      const gap = (dnum(s.date) - dnum(endsNext ? addD(prev.date, 1) : prev.date)) * 24 + hrs(s.start) - hrs(prev.end);
      if (gap < 11) w.push(`Only ${Math.max(0, Math.round(gap))}h rest since last shift (11h minimum)`);
    }
    const wk = L.filter((x) => {
      const dd = dnum(s.date) - dnum(x.date);
      return dd >= 0 && dd < 7;
    }).reduce((a, x) => a + shiftLen(x), 0);
    if (wk > 48 && !optOut) w.push(`${Math.round(wk)}h in 7 days – over 48 without an opt-out`);
    out.set(s.id, w);
  });
  return out;
}
async function rotaRows(tx: TenantTx): Promise<Sh[]> {
  return tx.$queryRaw<Sh[]>`
    SELECT r.code AS id, s.staff_no AS pid, to_char(r.shift_date, 'YYYY-MM-DD') AS date,
           r.start_time AS start, r.end_time AS "end", coalesce(r.drive_hours, 0)::float8 AS drive
      FROM rota_shift r JOIN staff s ON s.id = r.staff_id
     WHERE r.shift_date IS NOT NULL AND r.start_time IS NOT NULL AND r.end_time IS NOT NULL`;
}
async function optedOut(tx: TenantTx, pid: string): Promise<boolean> {
  const r = await tx.$queryRaw<{ o: boolean }[]>`SELECT wtd_opt_out AS o FROM staff WHERE staff_no = ${pid}`;
  return !!r[0]?.o;
}
async function exceptionFor(tx: TenantTx, sh: string, today: string): Promise<boolean> {
  const r = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM rota_exception WHERE shift_code = ${sh} AND until_on >= ${today}::date`;
  return r[0]!.n > 0;
}

// ---- swaps ------------------------------------------------------------------------------------
async function shiftRow(tx: TenantTx, code: unknown) {
  const r = await tx.$queryRaw<{ pid: string; state: string; date: string }[]>`
    SELECT s.staff_no AS pid, r.state, to_char(r.shift_date, 'YYYY-MM-DD') AS date
      FROM rota_shift r JOIN staff s ON s.id = r.staff_id WHERE r.code = ${String(code)}`;
  return r[0] ?? null;
}
const swaps = register({
  key: 'swaps',
  shape: 'list',
  table: 'rota_swap',
  prefix: 'SW-',
  width: 2,
  fields: [
    { f: 'from', col: 'from_staff_id', k: 'staff' },
    { f: 'to', col: 'to_staff_id', k: 'staff' },
    { f: 'shA', col: 'from_shift' },
    { f: 'on', col: 'requested_on', k: 'date' },
    { f: 'why', col: 'reason' },
    { f: 'state', col: 'state' },
    { f: 'shB', col: 'to_shift' },
    { f: 'note', col: 'note' },
  ],
  async check(ctx, c, _l, tx) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'crew', 'swaps are asked for from the crew phone (as Alex Morgan)');
      const mine = await myCode(tx, ctx);
      if (!mine || a.from !== mine) refuse('you can only ask to swap your own shift');
      const A = await shiftRow(tx, a.shA);
      const B = await shiftRow(tx, a.shB);
      if (!A || A.pid !== mine || A.state !== 'Planned' || A.date <= ctx.today)
        refuse('pick one of your own planned shifts after today', 400);
      if (!B || B.pid !== a.to || B.state !== 'Planned' || B.date <= ctx.today)
        refuse("pick a colleague's planned shift after today", 400);
      if (a.state !== 'Requested') refuse('a new swap starts as Requested', 400);
      return;
    }
    onlyFields(c, ['state', 'note']);
    const from = c.before!.state;
    if (changedTo(c, 'state', 'Colleague agreed')) {
      if (from !== 'Requested') refuse('only a requested swap can be agreed', 400);
      // v36 lets dispatch, HR and managers record the agreement; in the real app the colleague
      // agrees on their own phone.
      if (roleIs(ctx, 'crew')) {
        if ((await myCode(tx, ctx)) !== c.before!.to) refuse('only the colleague asked can agree');
      } else need(ctx, 'disp rm dir hr', 'not allowed');
      return;
    }
    if (changedTo(c, 'state', 'Approved') || changedTo(c, 'state', 'Refused')) {
      need(ctx, 'disp rm dir', c.after!.state === 'Approved' ? 'only the dispatcher or a manager' : 'not allowed');
      if (from !== 'Colleague agreed') refuse('the colleague must agree first', 400);
      if (c.after!.state === 'Approved') {
        const all = await rotaRows(tx);
        const A = all.find((s) => s.id === c.before!.shA);
        const B = all.find((s) => s.id === c.before!.shB);
        if (!A || !B || A.pid !== c.before!.from || B.pid !== c.before!.to)
          refuse('the shifts have changed since the swap was asked for', 409);
        A.pid = c.before!.to;
        B.pid = c.before!.from;
        const wa = rotaWarnings(all, A.pid, await optedOut(tx, A.pid)).get(A.id) ?? [];
        const wb = rotaWarnings(all, B.pid, await optedOut(tx, B.pid)).get(B.id) ?? [];
        if ((wa.length || wb.length) && (await ruleValue(tx, 'restMode', 'warn')) === 'block')
          refuse(`the swap would break a rest or hours rule: ${wa[0] ?? wb[0]}`);
      }
      return;
    }
    if (c.diff.has('state')) refuse('This change of state is not allowed here', 400);
    need(ctx, 'disp rm dir hr crew', 'not allowed');
  },
});

// ---- working-time exceptions ----------------------------------------------------------------
const rotaEx = register({
  key: 'rotaEx',
  shape: 'list',
  synthId: true,
  table: 'rota_exception',
  prefix: 'WTX-',
  fields: [
    { f: 'sh', col: 'shift_code' },
    { f: 'by', col: 'approved_by', k: 'person' },
    { f: 'why', col: 'reason' },
    { f: 'until', col: 'until_on', k: 'date' },
    { f: 'on', col: 'approved_on', k: 'date' },
  ],
  async check(ctx, c, _l, tx) {
    if (!c.isNew) refuse('An approved exception cannot be changed');
    need(ctx, 'rm dir', 'Only the Registered Manager or Director can approve an exception (decision D1).');
    const a = c.after!;
    if (!sameName(a.by, me(ctx))) refuse('the exception is recorded with your own name', 400);
    if (typeof a.why !== 'string' || !a.why.trim()) refuse('Give a reason', 400);
    if (!isDay(a.until)) refuse('Give the date the exception ends', 400);
    if (!(await shiftRow(tx, a.sh))) refuse(`No shift ${String(a.sh)}`, 404);
  },
});

// ---- rota -----------------------------------------------------------------------------------
async function gates(ctx: V36Ctx, tx: TenantTx, l: Lookups, s: J) {
  if (s.date !== ctx.today) refuse('shift start blocked – Rostered today: No shift today – contact control');
  const all = await rotaRows(tx);
  const w = rotaWarnings(all, s.pid, await optedOut(tx, s.pid)).get(s.id) ?? [];
  if (w.length && !(await exceptionFor(tx, s.id, ctx.today)) && (await ruleValue(tx, 'restMode', 'warn')) === 'block')
    refuse(`shift start blocked – Rest / hours warning: ${w[0]}`);
  if (!s.veh) return;
  const vid = l.fleet.idOf(s.veh);
  if (!vid) return;
  const r = await tx.$queryRaw<{ blocked: number; vdi: string | null; clean: number }[]>`
    SELECT (SELECT count(*)::int FROM defect WHERE vehicle_id = ${vid}::uuid AND stop_use
              AND status IN ('OPEN', 'REPAIRING')) AS blocked,
           (SELECT outcome::text FROM vdi WHERE vehicle_id = ${vid}::uuid
              AND (captured_at AT TIME ZONE 'Europe/London')::date = ${ctx.today}::date
            ORDER BY captured_at DESC LIMIT 1) AS vdi,
           (SELECT count(*)::int FROM cleaning_record WHERE vehicle_id = ${vid}::uuid AND type = 'PRE_SHIFT'
              AND (captured_at AT TIME ZONE 'Europe/London')::date = ${ctx.today}::date) AS clean`;
  const g = r[0]!;
  if (g.blocked) refuse(`shift start blocked – ${s.veh} not blocked: a stop-use defect is open`);
  if (g.vdi !== 'PASS') refuse(`shift start blocked – ${s.veh} daily check: ${g.vdi ? 'Fail' : 'Not done yet'}`);
  if (!g.clean) refuse(`shift start blocked – ${s.veh} pre-shift clean: Confirm the IPC clean`);
}
const rota = register({
  key: 'rota',
  shape: 'list',
  table: 'rota_shift',
  order: 'shift_date, start_time, code',
  fields: [
    { f: 'pid', col: 'staff_id', k: 'staff' },
    { f: 'date', col: 'shift_date', k: 'date' },
    { f: 'start', col: 'start_time' },
    { f: 'end', col: 'end_time' },
    { f: 'drive', col: 'drive_hours', k: 'num' },
    { f: 'veh', col: 'vehicle_id', k: 'veh' },
    { f: 'pat', col: 'pattern' },
    { f: 'brk', col: 'break_minutes', k: 'num' },
    { f: 'state', col: 'state' },
    { f: 'act', col: 'actual', k: 'json' },
  ],
  removable: true,
  async check(ctx, c, l, tx) {
    const a = c.after;
    const b = c.before;
    if (c.isNew) {
      need(ctx, EDIT, 'only HR, the dispatcher or a manager');
      if (!l.people.staffIdOf(a!.pid)) refuse(`No person ${String(a!.pid)}`, 404);
      if (!isDay(a!.date) || !isTime(a!.start) || !isTime(a!.end)) refuse('Give the date, start and end', 400);
      if (a!.veh && !l.fleet.idOf(a!.veh)) refuse(`Unknown vehicle ${String(a!.veh)}`, 400);
      if ((a!.state ?? 'Planned') !== 'Planned' || a!.act) refuse('a new shift starts as Planned', 400);
      if ((await rotaRows(tx)).some((x) => x.pid === a!.pid && x.date === a!.date))
        refuse(`${l.people.staffCodeOf(l.people.staffIdOf(a!.pid)) ?? ''} already has a shift that day`.trim(), 400);
      return;
    }
    if (c.isDel) {
      need(ctx, EDIT, 'not allowed');
      if (b!.state !== 'Planned') refuse('a shift that has started cannot be removed');
      const jobs = await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'v36_job'`,
      );
      if (jobs[0]!.n) {
        const used = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM v36_job j JOIN staff s ON s.id IN (j.crew_staff_id, j.crew2_staff_id)
           WHERE s.staff_no = ${String(b!.pid)} AND j.job_date = ${String(b!.date)}::date AND ${b!.date === ctx.today}`;
        if (used[0]!.n)
          refuse(`${String(b!.pid)} has ${used[0]!.n} journey${used[0]!.n > 1 ? 's' : ''} in this shift – move them first`);
      }
      return;
    }
    const crewFields = ['state', 'act'];
    if ([...c.diff].some((f) => crewFields.includes(f))) {
      onlyFields(c, crewFields, 'Only the shift state can change from the phone');
      if (!roleIs(ctx, 'crew')) refuse('only crew can submit from the phone app – switch to Alex Morgan');
      if ((await myCode(tx, ctx)) !== b!.pid) refuse('this is not your shift');
      const from = b!.state;
      const to = a!.state;
      const act = (a!.act ?? {}) as J;
      if (from === 'Planned' && to === 'Started') {
        if (!isTime(act.in)) refuse('the start time is missing', 400);
        await gates(ctx, tx, l, b!);
      } else if (from === 'Started' && to === 'On break') {
        if (!isTime(act.bs)) refuse('the break start time is missing', 400);
      } else if (from === 'On break' && to === 'Started') {
        if (typeof act.brks !== 'number' || act.brks < (b!.act?.brks ?? 0)) refuse('break minutes cannot go down', 400);
      } else if ((from === 'Started' || from === 'On break') && to === 'Ended') {
        if (typeof act.hand !== 'string' || !act.hand.trim()) refuse('Add a handover note before ending the shift', 400);
        if (!isTime(act.out)) refuse('the end time is missing', 400);
      } else if (!(from === to && from !== 'Planned' && from !== 'Ended')) refuse(`A shift cannot go from ${String(from)} to ${String(to)}`, 400);
      if (from !== 'Planned' && b!.act?.in !== act.in) refuse('the start time cannot change', 400);
      return;
    }
    onlyFields(c, ['pid', 'veh'], 'Only the person or the vehicle of a shift can change');
    need(ctx, EDIT, 'not allowed');
    if (b!.state !== 'Planned') refuse('a shift that has started cannot be changed');
    if (c.diff.has('veh') && a!.veh && !l.fleet.idOf(a!.veh)) refuse(`Unknown vehicle ${String(a!.veh)}`, 400);
    if (c.diff.has('pid')) {
      if (!l.people.staffIdOf(a!.pid)) refuse(`No person ${String(a!.pid)}`, 404);
      const swapped = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM rota_swap WHERE state = 'Approved' AND ${c.id} IN (from_shift, to_shift)`;
      if (!swapped[0]!.n && (await rotaRows(tx)).some((x) => x.pid === a!.pid && x.date === b!.date && x.id !== c.id))
        refuse(`${String(a!.pid)} already has a shift that day`, 400);
    }
  },
});

// ---- group training sessions ----------------------------------------------------------------
const sessions = register({
  key: 'sessions',
  shape: 'list',
  table: 'training_session',
  prefix: 'TS-0',
  fields: [
    { f: 'course', col: 'course' },
    { f: 'date', col: 'held_on', k: 'date' },
    { f: 'prov', col: 'provider' },
    { f: 'reg', col: 'register_ref' },
    { f: 'att', col: 'attendee_ids', k: 'staffs' },
    { f: 'by', col: 'recorded_by', k: 'person' },
    { f: 'on', col: 'recorded_at' },
    { f: 'state', col: 'state' },
    { f: 'vby', col: 'verified_by', k: 'person' },
    { f: 'von', col: 'verified_at' },
    { f: 'why', col: 'reject_reason' },
  ],
  check(ctx, c: Change, l) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'hr rm dir', 'only HR or the Registered Manager can record group training');
      if (!sameName(a.by, me(ctx))) refuse('the session is recorded with your own name', 400);
      if (a.state !== 'Awaiting verification') refuse('a new session awaits verification', 400);
      if (!Array.isArray(a.att) || !a.att.length) refuse('Tick at least one attendee', 400);
      for (const p of a.att as unknown[]) if (!l.people.staffIdOf(p as string)) refuse(`No person ${String(p)}`, 404);
      if (!isDay(a.date)) refuse('Give the session date', 400);
      return;
    }
    onlyFields(c, ['state', 'vby', 'von', 'why']);
    const verify = changedTo(c, 'state', 'Verified');
    if (!verify && !changedTo(c, 'state', 'Rejected')) refuse('This change is not allowed here', 400);
    need(
      ctx,
      'hr gov rm dir',
      `only HR, governance or the Registered Manager can ${verify ? 'verify' : 'reject'} training`,
    );
    if (c.before!.state !== 'Awaiting verification') refuse('this session has already been decided', 409);
    if (sameName(c.before!.by, me(ctx)))
      refuse(`you recorded this session, so someone else must ${verify ? 'verify it' : 'decide'}`);
    if (verify && !sameName(a.vby, me(ctx))) refuse('the verification is recorded with your own name', 400);
    if (!verify && (typeof a.why !== 'string' || !a.why.trim())) refuse('Give a reason', 400);
  },
});

// ---- rules and their two-person change --------------------------------------------------------
const rules = register({
  key: 'rules',
  shape: 'map',
  table: 'org_rule',
  order: 'created_at, code',
  fields: [
    { f: 'v', col: 'value', k: 'json' },
    { f: 'by', col: 'set_by', k: 'person' },
    { f: 'on', col: 'set_on', k: 'date' },
    { f: 'conf', col: 'confirmed', k: 'bool' },
  ],
  async check(ctx, c, _l, tx) {
    need(ctx, 'rm dir', 'not allowed');
    if (c.isDel) refuse('A rule cannot be removed');
    const p = await tx.$queryRaw<{ v: unknown; by: string | null; byName: string | null }[]>`
      SELECT new_value AS v, proposed_by AS by, proposed_by_name AS "byName"
        FROM org_rule_proposal WHERE rule_key = ${c.id} AND state = 'Proposed' ORDER BY created_at DESC LIMIT 1`;
    const prop = p[0];
    if (!prop) refuse('a rule changes only when a second person approves a proposal', 400);
    if (prop.by === ctx.userId || sameName(prop.byName, me(ctx)))
      refuse('you proposed this change, so someone else must approve it');
    if (JSON.stringify(prop.v) !== JSON.stringify(c.after!.v)) refuse('the new value differs from the proposal', 400);
    if (!sameName(c.after!.by, me(ctx))) refuse('the change is recorded with your own name', 400);
  },
});
const ruleProp = register({
  key: 'ruleProp',
  shape: 'list',
  synthId: true,
  table: 'org_rule_proposal',
  prefix: 'RP-',
  fields: [
    { f: 'k', col: 'rule_key' },
    { f: 'old', col: 'old_value', k: 'json' },
    { f: 'v', col: 'new_value', k: 'json' },
    { f: 'why', col: 'reason' },
    { f: 'by', col: 'proposed_by', k: 'person' },
    { f: 'on', col: 'proposed_on', k: 'date' },
    { f: 'state', col: 'state' },
    { f: 'dby', col: 'decided_by', k: 'person' },
  ],
  async check(ctx, c, _l, tx) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'rm dir', 'only the Registered Manager or Director');
      if (!sameName(a.by, me(ctx))) refuse('the proposal is recorded with your own name', 400);
      if (a.state !== 'Proposed') refuse('a new change starts as Proposed', 400);
      if (typeof a.why !== 'string' || !a.why.trim()) refuse('Say why', 400);
      if (typeof a.v === 'number' && !(a.v > 0)) refuse('Enter a number above 0', 400);
      const open = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM org_rule_proposal WHERE rule_key = ${String(a.k)} AND state = 'Proposed'`;
      if (open[0]!.n) refuse('a change to this rule is already waiting for a second person', 409);
      return;
    }
    onlyFields(c, ['state', 'dby']);
    need(ctx, 'rm dir', 'not allowed');
    if (c.before!.state !== 'Proposed') refuse('this change has already been decided', 409);
    if (!sameName(a.dby, me(ctx))) refuse('the decision is recorded with your own name', 400);
    if (a.state === 'Approved') {
      if (sameName(c.before!.by, me(ctx))) refuse('you proposed this change, so someone else must approve it');
      const r = await tx.$queryRaw<{ v: unknown }[]>`SELECT value AS v FROM org_rule WHERE code = ${String(a.k)}`;
      if (JSON.stringify(r[0]?.v) !== JSON.stringify(a.v)) refuse('the rule itself has not been changed', 400);
    } else if (a.state !== 'Rejected') refuse('This change is not allowed here', 400);
  },
});

/** In this order: a swap is decided before the shifts it moves; a rule before its proposal. */
export const ROTA_ADAPTERS = [swaps, rotaEx, rota, sessions, rules, ruleProp];
