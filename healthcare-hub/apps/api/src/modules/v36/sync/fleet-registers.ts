// v36 fleet registers connected to their tables: today's journeys (jobs), accidents (acc),
// equipment and inspection regimes (eq), premises safety items (prem), oxygen store readings (o2)
// and controlled drug balance checks (cd). v36's rules for who may do what are repeated here with
// the signed-in person (see register-lib.ts for the engine).
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
  type RegDef,
} from './register-lib.js';
import type { V36Ctx } from './types.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const text = (v: unknown) => typeof v === 'string' && v.trim() !== '';

// ---- jobs -------------------------------------------------------------------------------------
/** v36 gatesFor(): the statutory and safety blocks of an allocation (no override exists). */
export async function allocationBlocks(tx: TenantTx, l: Lookups, j: J): Promise<string[]> {
  const out: string[] = [];
  const vid = l.fleet.idOf(j.veh);
  if (vid) {
    const d = await tx.$queryRaw<{ code: string | null }[]>`
      SELECT code FROM defect WHERE vehicle_id = ${vid}::uuid AND status IN ('OPEN', 'REPAIRING')
         AND (stop_use OR severity = 'CRITICAL') ORDER BY created_at`;
    for (const x of d) out.push(`Stop-use defect ${x.code ?? ''}`.trim());
    const v = await tx.$queryRaw<{ off: boolean }[]>`SELECT off_road AS off FROM vehicle WHERE id = ${vid}::uuid`;
    if (v[0]?.off) out.push('Vehicle off the road');
  }
  if (!(j.crew && j.crew2)) {
    for (const pid of [j.crew, j.crew2].filter(Boolean) as string[]) {
      const sid = l.people.staffIdOf(pid);
      if (!sid) continue;
      const r = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM staff_restriction WHERE staff_id = ${sid}::uuid AND type = 'NO_LONE_WORKING'
           AND lifted_at IS NULL AND (valid_to IS NULL OR valid_to > now())`;
      if (r[0]!.n) out.push('Restriction: No lone working');
    }
  }
  return out;
}
/** Journeys (one table for every day; S.jobs is today's, S.fjobs later days', see fleet-plan.ts). */
export const JOBS: RegDef = {
  key: 'jobs',
  shape: 'list',
  table: 'v36_job',
  prefix: 'J-',
  order: 'pickup_time, code',
  scope: { col: 'job_date', cast: 'date', value: (ctx) => ctx.today },
  fields: [
    { f: 'veh', col: 'vehicle_id', k: 'veh' },
    { f: 'time', col: 'pickup_time' },
    { f: 'dur', col: 'minutes', k: 'num' },
    { f: 'crew', col: 'crew_staff_id', k: 'staff' },
    { f: 'crew2', col: 'crew2_staff_id', k: 'staff' },
    { f: 'pt', col: 'patient_ref' },
    { f: 'mob', col: 'mobility' },
    { f: 'flag', col: 'flag', k: 'num' },
    { f: 'ret', col: 'return_of' },
  ],
  async check(ctx, c, l, tx) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'disp rm dir', a.veh ? 'only the dispatcher or a manager allocates jobs' : 'only the dispatcher or a manager can book journeys');
      if (typeof a.pt !== 'string' || !/^PT-\d+$/.test(a.pt)) refuse('Use a patient reference like PT-4521 – never a name', 400);
      if (typeof a.time !== 'string' || !/^\d{2}:\d{2}$/.test(a.time)) refuse('Give the pickup time', 400);
      if (a.veh && !l.fleet.idOf(a.veh)) refuse(`Unknown vehicle ${String(a.veh)}`, 400);
    } else {
      const alloc = ['veh', 'crew', 'crew2'];
      onlyFields(c, [...alloc, 'flag'], 'Only the allocation of a journey can change');
      if ([...c.diff].some((f) => alloc.includes(f))) {
        const onlyVeh = [...c.diff].every((f) => f === 'veh' || f === 'flag');
        if (onlyVeh) need(ctx, 'disp rm dir fleet', 'only the dispatcher or a manager can reallocate');
        else need(ctx, 'disp rm dir', 'only the dispatcher or a manager');
        if (a.veh && !l.fleet.idOf(a.veh)) refuse(`Unknown vehicle ${String(a.veh)}`, 400);
      } else need(ctx, 'fleet rm dir disp', 'only the Fleet Lead or a manager');
    }
    if (a.veh && (c.isNew || c.diff.has('veh') || c.diff.has('crew') || c.diff.has('crew2'))) {
      const b = await allocationBlocks(tx, l, a);
      if (b.length)
        refuse(`allocation refused – ${b[0]}${b.length > 1 ? ` (+${b.length - 1} more)` : ''}; no override exists`);
    }
  },
};
const jobs = register(JOBS);

// ---- accidents ----------------------------------------------------------------------------------
const acc = register({
  key: 'acc',
  shape: 'list',
  table: 'v36_accident',
  prefix: 'ACC-',
  width: 2,
  fields: [
    { f: 'veh', col: 'vehicle_id', k: 'veh' },
    { f: 'on', col: 'occurred_on', k: 'date' },
    { f: 'what', col: 'what' },
    { f: 'tp', col: 'third_party' },
    { f: 'police', col: 'police_ref' },
    { f: 'photos', col: 'photos', k: 'num' },
    { f: 'ins', col: 'insurer_ref' },
    { f: 'road', col: 'roadworthy', k: 'bool' },
    { f: 'state', col: 'state' },
    { f: 'rep', col: 'repair', k: 'json' },
    { f: 'by', col: 'reported_by', k: 'person' },
  ],
  check(ctx, c, l) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'rm dir hr fleet gov disp crew', 'read-only');
      if (!text(a.what)) refuse('Say what happened', 400);
      if (!l.fleet.idOf(a.veh)) refuse(`Unknown vehicle ${String(a.veh)}`, 400);
      if (!sameName(a.by, me(ctx))) refuse('the report is recorded with your own name', 400);
      if (a.state !== (a.road ? 'Awaiting repair' : 'Off the road')) refuse('the state follows from whether it is safe to drive', 400);
      return;
    }
    onlyFields(c, ['ins', 'road', 'state', 'rep']);
    need(ctx, 'fleet rm dir', 'not allowed');
    if (!changedTo(c, 'state', 'Repaired') || a.road !== true) refuse('This change is not allowed here', 400);
    if (c.before!.state === 'Repaired') refuse('already released', 409);
    if (sameName(c.before!.by, me(ctx)) && roleIs(ctx, 'fleet'))
      refuse('you reported this accident, so someone else must release the vehicle');
    const rep = (a.rep ?? {}) as J;
    if (!sameName(rep.rel, me(ctx)) || !text(rep.by)) refuse('the release is recorded with your own name and the repairer', 400);
  },
});

// ---- equipment ----------------------------------------------------------------------------------
async function contractorInsurance(tx: TenantTx, name: unknown): Promise<string | null> {
  const r = await tx.$queryRaw<{ d: string | null }[]>`
    SELECT to_char(insurance_valid_to, 'YYYY-MM-DD') AS d FROM contractor WHERE name = ${String(name)} LIMIT 1`;
  return r[0]?.d ?? null;
}
const eq = register({
  key: 'eq',
  shape: 'list',
  table: 'v36_equipment',
  fields: [
    { f: 'cat', col: 'category' },
    { f: 'where', col: 'location_label' },
    { f: 'swl', col: 'swl_kg', k: 'num' },
    { f: 'gives', col: 'gives' },
    { f: 'reg', col: 'regimes', k: 'json' },
    { f: 'q', col: 'quarantine', k: 'json' },
  ],
  async check(ctx, c: Change, _l, tx) {
    if (c.isNew) refuse('Equipment is added on the asset register, not here');
    onlyFields(c, ['reg', 'q']);
    const b = c.before!;
    const a = c.after!;
    if (c.diff.has('q')) {
      need(ctx, 'fleet rm dir', 'not allowed');
      if (a.q) {
        if (b.q) refuse('already quarantined', 409);
        if (!text(a.q.why) || !sameName(a.q.by, me(ctx))) refuse('Say why (recorded with your own name)', 400);
      } else if (sameName(b.q?.by, me(ctx)) && roleIs(ctx, 'fleet'))
        refuse('you quarantined it, so a manager must release it');
    }
    if (!c.diff.has('reg')) return;
    const rb = (b.reg ?? []) as J[];
    const ra = (a.reg ?? []) as J[];
    if (rb.length !== ra.length || ra.some((r, i) => r.k !== rb[i]!.k)) refuse('The inspection regimes cannot change here', 400);
    for (let i = 0; i < ra.length; i++) {
      const x = rb[i]!;
      const y = ra[i]!;
      if (same(x, y)) continue;
      const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => !same(x[k], y[k])));
      if (keys.size === 1 && keys.has('book')) {
        need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager');
        const ins = await contractorInsurance(tx, y.book?.ctr);
        if (ins && ins < ctx.today) refuse(`${String(y.book?.ctr)} has expired insurance – renew before booking`, 400);
        if (!isDay(y.book?.on)) refuse('Give the booking date', 400);
      } else if ([...keys].every((k) => k === 'ev') && x.ev?.s === 'rcv' && y.ev?.s === 'ok') {
        need(ctx, 'fleet rm dir gov', 'not allowed');
        if (sameName(x.ev.by, me(ctx))) refuse('you uploaded this certificate, so someone else must verify it');
        if (!sameName(y.ev.vby, me(ctx)) || !same({ ...x.ev, s: 'ok', vby: y.ev.vby }, y.ev))
          refuse('the verification is recorded with your own name', 400);
      } else if ([...keys].every((k) => ['ev', 'last', 'due', 'prevDue'].includes(k)) && y.ev?.s === 'rcv') {
        need(ctx, 'fleet rm dir', 'only the Fleet Lead or a manager');
        if (!sameName(y.ev.by, me(ctx)) || !isDay(y.last) || !isDay(y.due)) refuse('Record the date and certificate (with your own name)', 400);
      } else refuse('This change is not allowed here', 400);
    }
  },
});

// ---- premises -----------------------------------------------------------------------------------
const prem = register({
  key: 'prem',
  shape: 'list',
  table: 'v36_premises_item',
  prefix: 'PR-',
  width: 2,
  fields: [
    { f: 'area', col: 'area' },
    { f: 'item', col: 'item' },
    { f: 'freq', col: 'every_days', k: 'num' },
    { f: 'last', col: 'last_done', k: 'date' },
    { f: 'owner', col: 'owner_user_id', k: 'person' },
    { f: 'ev', col: 'evidence', k: 'json' },
  ],
  check(ctx, c) {
    const a = c.after!;
    if (c.isNew) {
      need(ctx, 'gov rm dir', 'not allowed');
      if (!text(a.item)) refuse('Name the item', 400);
      if (!(typeof a.freq === 'number' && a.freq > 0)) refuse('Give how often, in days', 400);
      return;
    }
    onlyFields(c, ['last', 'ev']);
    if (c.diff.has('last')) {
      need(ctx, 'gov rm dir', 'only the premises owner, governance or a manager');
      if (!isDay(a.last) || a.last > ctx.today) refuse('Give the date the check was done', 400);
    }
    if (c.diff.has('ev')) {
      need(ctx, 'gov rm dir', 'not allowed');
      const x = (c.before!.ev ?? {}) as J;
      const y = (a.ev ?? {}) as J;
      if (y.s === 'rcv') {
        if (!sameName(y.by, me(ctx)) || !text(y.file)) refuse('the upload is recorded with your own name', 400);
      } else if (y.s === 'ok' && x.s === 'rcv') {
        if (sameName(x.by, me(ctx))) refuse('you uploaded this, so someone else must verify it');
        if (!sameName(y.vby, me(ctx))) refuse('the verification is recorded with your own name', 400);
      } else refuse('This change is not allowed here', 400);
    }
  },
});

// ---- oxygen store ---------------------------------------------------------------------------------
const o2 = register({
  key: 'o2',
  shape: 'list',
  synthId: true,
  table: 'v36_oxygen_reading',
  prefix: 'O2-',
  order: 'read_on, created_at',
  fields: [
    { f: 'd', col: 'read_on', k: 'date' },
    { f: 'temp', col: 'temperature_c', k: 'num' },
    { f: 'full', col: 'full_cylinders', k: 'num' },
    { f: 'inuse', col: 'in_use', k: 'num' },
    { f: 'empty', col: 'empty_cylinders', k: 'num' },
    { f: 'sign', col: 'signage_ok', k: 'bool' },
    { f: 'vent', col: 'ventilation_ok', k: 'bool' },
    { f: 'by', col: 'read_by', k: 'person' },
  ],
  check(ctx, c) {
    if (!c.isNew) refuse('A reading cannot be changed once saved');
    need(ctx, 'gov rm dir', 'not allowed');
    const a = c.after!;
    if (a.d !== ctx.today) refuse("A reading is for today's date", 400);
    if (!sameName(a.by, me(ctx))) refuse('the reading is recorded with your own name', 400);
    for (const k of ['temp', 'full', 'inuse', 'empty']) if (typeof a[k] !== 'number' || Number.isNaN(a[k])) refuse(`Enter a number for ${k}`, 400);
  },
});

// ---- controlled drugs -----------------------------------------------------------------------------
const cd = register({
  key: 'cd',
  shape: 'list',
  table: 'v36_cd_check',
  prefix: 'CDR-',
  fields: [
    { f: 'on', col: 'checked_on', k: 'date' },
    { f: 'drug', col: 'drug' },
    { f: 'where', col: 'store' },
    { f: 'bal', col: 'counted', k: 'num' },
    { f: 'exp', col: 'expected', k: 'num' },
    { f: 'by', col: 'checked_by', k: 'person' },
    { f: 'wit', col: 'witness', k: 'person' },
  ],
  async check(ctx, c, _l, tx) {
    if (!c.isNew) refuse('A signed balance check cannot be changed');
    need(ctx, 'rm dir gov crew', 'not allowed');
    const a = c.after!;
    if (!sameName(a.by, me(ctx))) refuse('the check is signed with your own name', 400);
    if (!text(a.wit) || sameName(a.wit, a.by)) refuse('the witness must be a different person', 400);
    if (typeof a.bal !== 'number' || Number.isNaN(a.bal)) refuse('Enter the count', 400);
    const last = await tx.$queryRaw<{ e: number | null }[]>`
      SELECT expected::float8 AS e FROM v36_cd_check ORDER BY created_at DESC LIMIT 1`;
    if (last[0] && last[0].e !== null && a.exp !== last[0].e) refuse('the expected balance comes from the register', 400);
  },
});

export const FLEET_REGISTER_ADAPTERS = [jobs, acc, eq, prem, o2, cd];
