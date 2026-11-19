// A v36 register kept in its own table, one row per v36 record (step 2, 19 Nov 2026).
//
// Many v36 collections are plain registers (contractors, visitors, breaches, shifts …) with no
// endpoint behind them. Each gets a real table (organisation-scoped with RLS, a code column with
// v36's reference, typed columns for every field v36 shows, a version) and is described here
// once: which field goes in which column, who may change what (v36's own need() rules, repeated
// on the server with the signed-in person), and what else a change does. The engine does the
// rest the same way for all of them: load in v36's exact shape, apply one changed record (with
// a stale-copy check and an audit row), and move a saved copy in.
//
// Values v36 keeps that a typed column cannot hold (an empty string for a date, a name nobody
// here has, a field added later) are kept in the row's `extra` jsonb, so a record always loads
// back exactly as v36 wrote it.
import type { TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import { loadPeople, type People } from './lookup.js';
import { loadFleet, type Fleet } from './fleet-common.js';
import { auditRow, v36Role } from './governance-common.js';
import type { V36Adapter, V36Change, V36Ctx, V36Record } from './types.js';

export type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/**
 * text | num | bool | date ('YYYY-MM-DD' in a date column) | json (jsonb) | person (a name:
 * `<col>` user id + `<col>_name`) | staff (ST-0042 → staff id) | staffs (list of them) |
 * veh (AMB-01 → vehicle id).
 */
export type Kind = 'text' | 'num' | 'bool' | 'date' | 'json' | 'person' | 'staff' | 'staffs' | 'veh';
export interface Field {
  f: string;
  col: string;
  k?: Kind;
}
export interface Change {
  key: string;
  id: string;
  before: J | null;
  after: J | null;
  /** fields whose value changed (new: every field present; removed: none) */
  diff: Set<string>;
  isNew: boolean;
  isDel: boolean;
}
export interface Lookups {
  people: People;
  fleet: Fleet;
}
export interface RegDef {
  key: string;
  shape: 'list' | 'map';
  /** For lists: the record's id field (default 'id'). Kept in the `code` column. */
  idField?: string;
  /** The id is a number in v36 (e.g. the statement of purpose version `v`). */
  numericId?: boolean;
  /** Records are arrays (v36 tuples such as kpi rows); fields are positions '0', '1' … */
  tuple?: boolean;
  /** Map values are not objects (a number, a string, a list): kept whole in `value`. */
  scalar?: boolean;
  /** For lists without a v36 id: the engine adds `id` (prefix + number) so rows can be told apart. */
  synthId?: boolean;
  table: string;
  /** New codes: prefix + zero-padded number (v36 nextId); a proposed code of that shape is kept when free. */
  prefix?: string;
  width?: number;
  fields: Field[];
  /** SQL ORDER BY (default created order). */
  order?: string;
  canRead?: (ctx: V36Ctx) => boolean;
  /** Throws a HubError (v36's own words) when the change is not allowed. */
  check?: (ctx: V36Ctx, c: Change, l: Lookups, tx: TenantTx) => void | Promise<void>;
  /** Side effects in the same transaction, after the row is written. */
  then?: (ctx: V36Ctx, tx: TenantTx, c: Change, rowId: string | null, l: Lookups) => Promise<void>;
  /** v36 lets the record be removed (default: refused). */
  removable?: boolean;
  /** A column outside v36's record that scopes the collection (e.g. today's journeys): set on
   *  insert, and only matching rows load. */
  scope?: { col: string; cast: string; value: (ctx: V36Ctx) => unknown };
  /** Shapes a loaded record (e.g. v36 fields worked out from others). */
  shapeOut?: (r: J) => J;
}

const ID_COLS = new Set(['id', 'organisation_id', 'code', 'extra', 'version', 'created_at', 'created_by', 'updated_at']);
const sameJ = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as J)
        .sort()
        .map((k) => [k, sortKeys((v as J)[k])]),
    );
  return v;
}
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function refuse(detail: string, status = 403): never {
  throw new HubError(status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : 'VALIDATION_FAILED', status, detail);
}
/** v36's need(): the person's v36 role must be one of `roles` (read-only roles never write). */
export function need(ctx: V36Ctx, roles: string, what = 'not allowed'): void {
  const r = v36Role(ctx);
  if (ctx.hub.support || r === 'aud') refuse('this role is read-only');
  if (!roles.split(' ').includes(r)) refuse(what);
}
export const roleIs = (ctx: V36Ctx, roles: string) => roles.split(' ').includes(v36Role(ctx));
export const me = (ctx: V36Ctx) => ctx.hub.user.displayName;
export const sameName = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
/** Fields changed among `allowed` only, else refused. */
export function onlyFields(c: Change, allowed: string[], what = 'This change is not allowed here') {
  for (const f of c.diff) if (!allowed.includes(f)) refuse(`${what} (${f})`, 400);
}
export const changedTo = (c: Change, f: string, v: unknown) =>
  c.diff.has(f) && JSON.stringify(c.after?.[f]) === JSON.stringify(v);

function colsOf(d: RegDef): { name: string; k: Kind }[] {
  const out: { name: string; k: Kind }[] = [];
  for (const x of d.fields) {
    out.push({ name: x.col, k: x.k ?? 'text' });
    if (x.k === 'person') out.push({ name: `${x.col}_name`, k: 'text' });
  }
  return out;
}
const CAST: Record<Kind, string> = {
  text: 'text',
  num: 'numeric',
  bool: 'boolean',
  date: 'date',
  json: 'jsonb',
  person: 'uuid',
  staff: 'uuid',
  staffs: 'uuid[]',
  veh: 'uuid',
};

/** v36 record → column values + extra. */
function toRow(d: RegDef, rec: J, l: Lookups): { vals: Record<string, unknown>; extra: J } {
  const vals: Record<string, unknown> = {};
  const extra: J = {};
  const known = new Set(d.fields.map((x) => x.f));
  if (!d.tuple) for (const [k, v] of Object.entries(rec)) if (!known.has(k) && k !== idf(d)) extra[k] = v;
  for (const x of d.fields) {
    const k = x.k ?? 'text';
    const v = rec[x.f];
    vals[x.col] = null;
    if (k === 'person') vals[`${x.col}_name`] = null;
    if (v === undefined) continue;
    let ok = true;
    if (v === null) ok = false;
    else if (k === 'text') ok = typeof v === 'string' ? ((vals[x.col] = v), true) : false;
    else if (k === 'num') ok = typeof v === 'number' && Number.isFinite(v) ? ((vals[x.col] = v), true) : false;
    else if (k === 'bool') ok = typeof v === 'boolean' ? ((vals[x.col] = v), true) : false;
    else if (k === 'date') ok = isDay(v) ? ((vals[x.col] = v), true) : false;
    else if (k === 'json') vals[x.col] = JSON.stringify(v);
    else if (k === 'person') {
      if (typeof v !== 'string') ok = false;
      else {
        vals[x.col] = l.people.userIdOf(v);
        vals[`${x.col}_name`] = v;
      }
    } else if (k === 'staff') {
      const id = typeof v === 'string' ? l.people.staffIdOf(v) : null;
      ok = id ? ((vals[x.col] = id), true) : false;
    } else if (k === 'staffs') {
      const ids = Array.isArray(v) ? v.map((c) => (typeof c === 'string' ? l.people.staffIdOf(c) : null)) : [null];
      ok = ids.every((i) => i) ? ((vals[x.col] = ids), true) : false;
    } else if (k === 'veh') {
      const id = typeof v === 'string' ? l.fleet.idOf(v) : null;
      ok = id ? ((vals[x.col] = id), true) : false;
    }
    if (!ok) extra[x.f] = v;
  }
  return { vals, extra };
}
/** Audit action words (lower case letters only): register.rota_ex.create. */
const act = (d: RegDef, verb: string) =>
  `register.${d.key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/[^a-z_]/g, '')}.${verb}`;
const idf = (d: RegDef) => (d.shape === 'map' ? '' : d.idField ?? 'id');

/** Table row → v36 record. */
export function toRec(d: RegDef, row: J, l: Lookups): J {
  const extra = (row.extra ?? {}) as J;
  if (d.scalar) return extra.__v !== undefined ? extra.__v : (row.value as J);
  const rec: J = d.tuple ? [] : {};
  if (!d.tuple && d.shape === 'list') rec[idf(d)] = d.numericId ? Number(row.code) : row.code;
  for (const x of d.fields) {
    const k = x.k ?? 'text';
    const v = row[x.col];
    let out: unknown = undefined;
    if (k === 'person' && (v === null || v === undefined) && row[`${x.col}_name`] != null) out = row[`${x.col}_name`];
    else if (v !== null && v !== undefined) {
      if (k === 'num') out = Number(v);
      else if (k === 'date') out = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      else if (k === 'person') out = l.people.nameOf(v as string) ?? row[`${x.col}_name`];
      else if (k === 'staff') out = l.people.staffCodeOf(v as string);
      else if (k === 'staffs') out = (v as string[]).map((s) => l.people.staffCodeOf(s));
      else if (k === 'veh') out = l.fleet.callsignOf(v as string);
      else out = v;
    } else if (x.f in extra) out = extra[x.f];
    if (out !== undefined) rec[x.f] = out;
  }
  if (!d.tuple) for (const [k, v] of Object.entries(extra)) if (!(k in rec)) rec[k] = v;
  return d.shapeOut ? d.shapeOut(rec) : rec;
}

export async function lookups(tx: TenantTx): Promise<Lookups> {
  return { people: await loadPeople(tx), fleet: await loadFleet(tx) };
}

async function rows(ctx: V36Ctx, tx: TenantTx, d: RegDef): Promise<J[]> {
  if (d.scope)
    return tx.$queryRawUnsafe<J[]>(
      `SELECT * FROM ${d.table} WHERE ${d.scope.col} = $1::${d.scope.cast} ORDER BY ${d.order ?? 'created_at, id'}`,
      d.scope.value(ctx),
    );
  return tx.$queryRawUnsafe<J[]>(`SELECT * FROM ${d.table} ORDER BY ${d.order ?? 'created_at, id'}`);
}

/** The code for a new record: v36's own when free and of the right shape, else the next free one. */
async function newCode(tx: TenantTx, d: RegDef, proposed: string): Promise<string> {
  const all = await tx.$queryRawUnsafe<{ code: string }[]>(`SELECT code FROM ${d.table}`);
  const taken = new Set(all.map((r) => r.code));
  let prefix = d.prefix;
  if (!prefix) {
    if (!taken.has(proposed)) return proposed;
    const m = /^(.*?)(\d+)$/.exec(proposed);
    if (d.shape === 'map' || !m) refuse(`${proposed} already exists – reloaded`, 409);
    prefix = m[1]!;
  }
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`);
  if (re.test(proposed) && !taken.has(proposed)) return proposed;
  let max = 0;
  for (const c of taken) {
    const m = re.exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + String(max + 1).padStart(d.width ?? 0, '0');
}

async function writeRow(ctx: V36Ctx, tx: TenantTx, d: RegDef, code: string, rec: J, l: Lookups, rowId?: string) {
  let vals: Record<string, unknown>;
  let extra: J;
  if (d.scalar) {
    vals = { value: JSON.stringify(rec ?? null) };
    extra = rec === null ? { __v: null } : {};
  } else ({ vals, extra } = toRow(d, rec, l));
  const kinds = new Map(colsOf(d).map((c) => [c.name, c.k]));
  if (d.scalar) kinds.set('value', 'json');
  if (d.scope && !rowId) {
    vals[d.scope.col] = d.scope.value(ctx);
    kinds.set(d.scope.col, d.scope.cast as Kind);
  }
  const names = Object.keys(vals);
  const params = names.map((n) => vals[n]);
  const cast = (n: string, i: number) => `$${i + 1}::${CAST[kinds.get(n) ?? 'text'] ?? kinds.get(n)}`;
  if (rowId) {
    const set = names.map((n, i) => `${n} = ${cast(n, i)}`).join(', ');
    await tx.$executeRawUnsafe(
      `UPDATE ${d.table} SET ${set}${set ? ', ' : ''}extra = $${names.length + 1}::jsonb, updated_at = now() WHERE id = $${names.length + 2}::uuid`,
      ...params,
      JSON.stringify(extra),
      rowId,
    );
    return rowId;
  }
  const r = await tx.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO ${d.table} (organisation_id, code, created_by, created_at, extra${names.map((n) => `, ${n}`).join('')})
     VALUES ($1::uuid, $2, $3::uuid, clock_timestamp(), $4::jsonb${names.map((n, i) => `, ${cast(n, i + 4)}`).join('')}) RETURNING id`,
    ctx.orgId,
    code,
    ctx.userId,
    JSON.stringify(extra),
    ...params,
  );
  return r[0]!.id;
}

function diffOf(before: J | null, after: J | null): Set<string> {
  const s = new Set<string>();
  if (after == null) return s;
  if (before == null || typeof after !== 'object' || Array.isArray(after) || typeof before !== 'object' || Array.isArray(before)) {
    if (after && typeof after === 'object' && !Array.isArray(after)) for (const k of Object.keys(after)) s.add(k);
    else if (Array.isArray(after) && Array.isArray(before)) after.forEach((v, i) => !sameJ(v, before[i]) && s.add(String(i)));
    else if (!sameJ(before, after)) s.add('*');
    return s;
  }
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!sameJ(before[k], after[k])) s.add(k);
  return s;
}

/** Applies one changed record of a register (used by the adapter and by other adapters' side effects). */
export async function applyReg(ctx: V36Ctx, d: RegDef, ch: V36Change): Promise<void> {
  await ctx.tx(async (tx) => {
    const l = await lookups(tx);
    const c: Change = {
      key: ch.key,
      id: ch.id,
      before: ch.before as J | null,
      after: ch.after as J | null,
      diff: diffOf((ch.before ?? null) as J | null, (ch.after ?? null) as J | null),
      // a scalar record may be '' or 0: only null (or missing) means new / removed
      isNew: ch.before == null,
      isDel: ch.after == null,
    };
    if (!c.isNew && !c.isDel && c.diff.size === 0) return;
    if (c.isDel && !d.removable) refuse('Records cannot be removed here');
    await d.check?.(ctx, c, l, tx);
    const cur = (
      await tx.$queryRawUnsafe<J[]>(`SELECT * FROM ${d.table} WHERE code = $1 FOR UPDATE`, String(ch.id))
    )[0];
    if (!c.isNew) {
      if (!cur) refuse(`${ch.id} is no longer on record – reloaded`, 409);
      if (!sameJ(toRec(d, cur, l), c.before)) refuse(`${ch.id} was changed by someone else – reloaded`, 409);
    }
    let rowId: string | null = cur?.id ?? null;
    let code = String(ch.id);
    if (c.isDel) {
      await tx.$executeRawUnsafe(`DELETE FROM ${d.table} WHERE id = $1::uuid`, rowId);
    } else if (c.isNew) {
      code = await newCode(tx, d, code);
      rowId = await writeRow(ctx, tx, d, code, c.after!, l);
    } else {
      rowId = await writeRow(ctx, tx, d, code, c.after!, l, rowId!);
    }
    await auditRow(ctx, tx, act(d, c.isNew ? 'create' : c.isDel ? 'delete' : 'update'), d.table, rowId!, {
      code,
      fields: [...c.diff].join(',').slice(0, 300) || null,
    });
    if (d.then) await d.then(ctx, tx, { ...c, id: code }, c.isDel ? null : rowId, l);
  });
}

export function register(d: RegDef): V36Adapter {
  const a: V36Adapter = {
    key: d.key,
    shape: d.shape,
    ...(d.shape === 'list' ? { idField: d.idField ?? 'id' } : {}),
    ...(d.canRead ? { canRead: d.canRead } : {}),
    load: (ctx) =>
      ctx.tx(async (tx) => {
        const l = await lookups(tx);
        const rs = await rows(ctx, tx, d);
        if (d.shape === 'map') return Object.fromEntries(rs.map((r) => [r.code as string, toRec(d, r, l)]));
        return rs.map((r) => toRec(d, r, l));
      }),
    apply: (ctx, ch) => applyReg(ctx, d, ch),
    isEmpty: (ctx) =>
      ctx.tx(async (tx) => (await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${d.table}`))[0]!.n === 0),
    import: (ctx, records) =>
      ctx.tx(async (tx) => {
        const l = await lookups(tx);
        const list: [string, J][] =
          d.shape === 'map'
            ? Object.entries((records ?? {}) as J)
            : ((records ?? []) as J[]).map((r, i) => [
                r[idf(d)] === undefined && d.synthId ? `${d.prefix ?? ''}${i + 1}` : String(r[idf(d)]),
                r,
              ]);
        const seen = new Set<string>();
        for (const [code, rec] of list) {
          if (seen.has(code)) continue;
          seen.add(code);
          await writeRow(ctx, tx, d, code, rec, l);
        }
        if (list.length)
          await auditRow(ctx, tx, act(d, 'import'), d.table, ctx.orgId, { count: seen.size });
      }),
  };
  if (process.env.V36_DEBUG)
    for (const m of ['load', 'apply', 'import', 'isEmpty'] as const) {
      const f = a[m] as ((...x: unknown[]) => Promise<unknown>) | undefined;
      if (f)
        (a as unknown as J)[m] = (...x: unknown[]) =>
          f(...x).catch((e: unknown) => {
            if (!(e instanceof HubError)) console.error(`[v36 ${d.key}.${m}]`, e);
            throw e;
          });
    }
  return a;
}

// ---- one value (shape 'value') ---------------------------------------------------------------
// A v36 collection that is a single value (S.dcEvery = 28, S.guardian = 'Sarah Jenkins',
// S.dspt = {...}, S.cqSub = null or {by, on}) is kept as one row of v36_value, its code the S key.
export interface ValDef {
  key: string;
  /** v36's starting value, loaded while the organisation has none of its own yet. */
  initial?: unknown;
  canRead?: (ctx: V36Ctx) => boolean;
  /** Missing = read-only (no v36 button changes it). Throws a HubError when not allowed. */
  check?: (ctx: V36Ctx, before: unknown, after: unknown, tx: TenantTx) => void | Promise<void>;
}
const valAct = (d: ValDef, verb: string) => act({ key: d.key } as RegDef, verb);
export function single(d: ValDef): V36Adapter {
  const read = async (tx: TenantTx) =>
    (await tx.$queryRaw<{ id: string; value: unknown }[]>`SELECT id, value FROM v36_value WHERE code = ${d.key} FOR UPDATE`)[0];
  const a: V36Adapter = {
    key: d.key,
    shape: 'value',
    ...(d.canRead ? { canRead: d.canRead } : {}),
    load: (ctx) =>
      ctx.tx(async (tx) => {
        const r = (await tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM v36_value WHERE code = ${d.key}`)[0];
        return r ? r.value : (d.initial ?? null);
      }),
    isEmpty: (ctx) =>
      ctx.tx(async (tx) => (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM v36_value WHERE code = ${d.key}`)[0]!.n === 0),
    import: (ctx, value) =>
      ctx.tx(async (tx) => {
        const r = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO v36_value (organisation_id, code, value, created_by)
          VALUES (${ctx.orgId}::uuid, ${d.key}, ${JSON.stringify(value ?? null)}::jsonb, ${ctx.userId}::uuid)
          ON CONFLICT (organisation_id, code) DO NOTHING RETURNING id`;
        if (r[0]) await auditRow(ctx, tx, valAct(d, 'import'), 'v36_value', r[0].id, { code: d.key });
      }),
  };
  if (d.check) {
    const check = d.check;
    a.apply = (ctx, ch) =>
      ctx.tx(async (tx) => {
        const before = ch.before ?? null;
        const after = ch.after ?? null;
        if (sameJ(before, after)) return;
        await check(ctx, before, after, tx);
        const cur = await read(tx);
        if (!sameJ(cur ? cur.value : (d.initial ?? null), before)) refuse(`${d.key} was changed by someone else – reloaded`, 409);
        const v = JSON.stringify(after);
        const id = cur
          ? (await tx.$executeRaw`UPDATE v36_value SET value = ${v}::jsonb, updated_at = now() WHERE id = ${cur.id}::uuid`, cur.id)
          : (
              await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO v36_value (organisation_id, code, value, created_by)
                VALUES (${ctx.orgId}::uuid, ${d.key}, ${v}::jsonb, ${ctx.userId}::uuid) RETURNING id`
            )[0]!.id;
        await auditRow(ctx, tx, valAct(d, 'update'), 'v36_value', id, { code: d.key });
      });
  }
  return a;
}

/** Makes a register read-only from v36 (no button changes it): changes are refused. */
export function readOnly(a: V36Adapter): V36Adapter {
  const { apply: _apply, ...rest } = a; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
}
