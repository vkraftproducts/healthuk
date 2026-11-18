import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * DEV/DEMO ONLY: loads the Healthcare Hub UK v36 prototype's sample records (people, vehicles,
 * checks, defects, jobs, incidents, audits, premises, policies, risks, rota and so on) into the
 * seeded demo organisation, so the app shows what the v36 HTML shows. Synthetic data only.
 *
 * The records live in `v36-data.json` (generated from the v36 HTML by
 * `scripts/v36/build-v36-data.py`). Each entry is an insert (`i`) or a SQL statement (`q`):
 * - `always` entries run on every start (names the base seed would otherwise reset);
 * - `once` entries run the first time only, so later restarts never undo work done in the app.
 * Dates are written relative to the prototype's "today" (2026-11-17) and moved to the real today
 * when they are loaded, as the prototype itself does. Fixed IDs keep every insert idempotent.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface InsertOp {
  i: string;
  v: Record<string, Json>;
}
interface QueryOp {
  q: string;
  p?: Json[];
}
type Op = InsertOp | QueryOp;
interface V36Data {
  base: string;
  org: string;
  marker: string;
  /** A seeded date that shows where the records were placed, for loads made before rebasing. */
  anchor?: { table: string; id: string; column: string; base: string };
  always: Op[];
  once: Op[];
}

const ZONE = 'Europe/London';

/** Today's date in London as YYYY-MM-DD. */
function londonToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(now);
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayDiff(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000,
  );
}
/** A London wall-clock time as a UTC instant (handles GMT/BST). */
function londonToUtc(date: string, time: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
  );
  return new Date(guess.getTime() - (shown - guess.getTime())).toISOString();
}

export interface V36Lookups {
  templates: Map<string, { templateId: string; versionId: string }>;
  roles: Map<string, string>;
}

function resolver(offset: number, look: V36Lookups) {
  const one = (s: string): Json => {
    if (s.startsWith('@D:')) return addDays(s.slice(3), offset);
    if (s.startsWith('@T:')) {
      const [d, t] = s.slice(3).split(' ');
      return londonToUtc(addDays(d!, offset), t ?? '00:00');
    }
    if (s.startsWith('@TPL:') || s.startsWith('@TPLV:')) {
      const code = s.slice(s.indexOf(':') + 1);
      const t = look.templates.get(code);
      if (!t) throw new Error(`v36 seed: requirement template ${code} is missing`);
      return s.startsWith('@TPL:') ? t.templateId : t.versionId;
    }
    if (s.startsWith('@ROLE:')) {
      const id = look.roles.get(s.slice(6));
      if (!id) throw new Error(`v36 seed: role ${s.slice(6)} is missing`);
      return id;
    }
    return s;
  };
  const walk = (v: Json): unknown => {
    if (typeof v === 'string') return one(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if ('$json' in v) return JSON.stringify(walkJson(v.$json as Json));
      return v;
    }
    return v;
  };
  const walkJson = (v: Json): Json => {
    if (typeof v === 'string') return one(v);
    if (Array.isArray(v)) return v.map(walkJson);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkJson(x)]));
    return v;
  };
  return walk;
}

async function lookups(c: pg.Client, org: string): Promise<V36Lookups> {
  const t = await c.query<{ code: string; template_id: string; version_id: string }>(
    `SELECT DISTINCT ON (t.code) t.code, t.id AS template_id, v.id AS version_id
       FROM requirement_template t
       JOIN requirement_template_version v ON v.template_id = t.id
      WHERE t.organisation_id = $1
      ORDER BY t.code, (v.status = 'EFFECTIVE') DESC, v.version DESC`,
    [org],
  );
  const r = await c.query<{ key: string; id: string }>(
    `SELECT key, id FROM role WHERE organisation_id IS NULL`,
  );
  return {
    templates: new Map(
      t.rows.map((x) => [x.code, { templateId: x.template_id, versionId: x.version_id }]),
    ),
    roles: new Map(r.rows.map((x) => [x.key, x.id])),
  };
}

async function run(c: pg.Client, ops: Op[], offset: number, org: string): Promise<number> {
  let n = 0;
  for (const [i, op] of ops.entries()) {
    // Templates created earlier in the same run become visible to later statements.
    const walk = resolver(offset, await cachedLookups(c, org, op));
    try {
      if ('i' in op) {
        const cols = Object.keys(op.v);
        const vals = cols.map((k) => walk(op.v[k] as Json));
        await c.query(
          `INSERT INTO ${op.i} (${cols.join(', ')}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(', ')})
           ON CONFLICT DO NOTHING`,
          vals,
        );
      } else {
        await c.query(op.q, (op.p ?? []).map(walk));
      }
      n += 1;
    } catch (e) {
      const what = 'i' in op ? `insert into ${op.i}` : op.q.slice(0, 120);
      throw new Error(`v36 seed step ${i} (${what}) failed: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }
  return n;
}

let cache: { key: string; value: V36Lookups } | null = null;
async function cachedLookups(c: pg.Client, org: string, op: Op): Promise<V36Lookups> {
  const text = JSON.stringify(op);
  const needs = text.includes('"@TPL') || text.includes('"@ROLE:');
  if (!needs && cache) return cache.value;
  // Re-read only when a template may have been added since the last read.
  const count = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM requirement_template WHERE organisation_id = $1`,
    [org],
  );
  if (cache && cache.key === count.rows[0]!.n) return cache.value;
  cache = { key: count.rows[0]!.n, value: await lookups(c, org) };
  return cache.value;
}

export function loadV36Data(file?: URL | string): V36Data {
  const at = file ?? new URL('./v36-data.json', import.meta.url);
  return JSON.parse(readFileSync(at, 'utf8')) as V36Data;
}

/**
 * Loads the v36 sample records. Run after `seed` and `seed:sectors`. Returns what it did.
 * `force` re-runs the first-time records too (inserts stay idempotent; updates re-apply).
 */
export async function seedV36(
  adminUrl: string,
  opts: { now?: Date; force?: boolean; data?: V36Data } = {},
): Promise<{
  always: number;
  once: number;
  skippedOnce: boolean;
  offsetDays: number;
  movedDays: number;
  stuck: string[];
}> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The v36 demo data never loads in production');
  const data = opts.data ?? loadV36Data();
  const offset = dayDiff(londonToday(opts.now ?? new Date()), data.base);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  cache = null;
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.org_id', $1, true)`, [data.org]);
    // Restricted registers (absence, safeguarding…) check the acting person's permissions.
    await c.query(
      `SELECT set_config('app.permissions', (SELECT string_agg(key, ',') FROM permission), true)`,
    );
    const done = await c.query(`SELECT 1 FROM staff WHERE id = $1`, [data.marker]);
    const skippedOnce = !!done.rowCount && !opts.force;
    // Move what is already there to today first, so records added below are not moved twice.
    const moved = await rebase(c, data, londonToday(opts.now ?? new Date()), !skippedOnce);
    let once = skippedOnce ? 0 : await run(c, data.once, offset, data.org);
    if (skippedOnce) once = await catchUp(c, data, offset);
    const always = await run(c, data.always, offset, data.org);
    await c.query('COMMIT');
    return { always, once, skippedOnce, offsetDays: offset, movedDays: moved.days, stuck: moved.stuck };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

/**
 * Sample records added to the data file after a database was first loaded: when the file has
 * changed, its fixed-ID inserts run again (each is ON CONFLICT DO NOTHING, so nothing already
 * there changes). A row that cannot go in yet is skipped, never half-written.
 */
async function catchUp(c: pg.Client, data: V36Data, offset: number): Promise<number> {
  const key = `v36:${createHash('sha1').update(JSON.stringify(data.once)).digest('hex').slice(0, 16)}`;
  const seen = await c.query(
    `SELECT 1 FROM demo_seed_state WHERE organisation_id = $1 AND key = $2`,
    [data.org, key],
  );
  if (seen.rowCount) return 0;
  let n = 0;
  for (const op of data.once) {
    if (!('i' in op) || typeof op.v.id !== 'string') continue;
    const walk = resolver(offset, await cachedLookups(c, data.org, op));
    const cols = Object.keys(op.v);
    await c.query('SAVEPOINT catchup');
    try {
      const r = await c.query(
        `INSERT INTO ${op.i} (${cols.join(', ')}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(', ')})
         ON CONFLICT DO NOTHING`,
        cols.map((k) => walk(op.v[k] as Json)),
      );
      await c.query('RELEASE SAVEPOINT catchup');
      n += r.rowCount ?? 0;
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT catchup');
    }
  }
  await c.query(
    `INSERT INTO demo_seed_state (organisation_id, key, placed_on) VALUES ($1, $2, current_date)
     ON CONFLICT (organisation_id, key) DO NOTHING`,
    [data.org, key],
  );
  return n;
}

/**
 * Keeps the sample records on "today", as the v36 prototype does: on each start every date and
 * time the loader wrote is moved forward by the days since the records were last placed. Only the
 * loader's own rows (fixed IDs) move; anything created in the app is left alone. A table whose
 * rows may not change (append-only records, closed registers) is skipped and named in `stuck`.
 */
async function rebase(
  c: pg.Client,
  data: V36Data,
  today: string,
  freshLoad: boolean,
): Promise<{ days: number; stuck: string[] }> {
  const stateKey = 'v36';
  const put = (on: string) =>
    c.query(
      `INSERT INTO demo_seed_state (organisation_id, key, placed_on) VALUES ($1, $2, $3)
       ON CONFLICT (organisation_id, key) DO UPDATE SET placed_on = EXCLUDED.placed_on, updated_at = now()`,
      [data.org, stateKey, on],
    );
  if (freshLoad) {
    await put(today);
    return { days: 0, stuck: [] };
  }
  await put(today);
  // Which columns of which tables the loader dated, and which rows it wrote.
  const plan = new Map<
    string,
    { cols: Set<string>; ids: string[]; probe: { id: string; col: string; tag: string } }
  >();
  for (const op of [...data.once, ...data.always]) {
    if (!('i' in op) || typeof op.v.id !== 'string') continue;
    const cols = Object.entries(op.v)
      .filter(([, v]) => typeof v === 'string' && (v.startsWith('@D:') || v.startsWith('@T:')))
      .map(([k]) => k);
    if (cols.length === 0) continue;
    const p = plan.get(op.i) ?? {
      cols: new Set<string>(),
      ids: [],
      probe: { id: op.v.id, col: cols[0]!, tag: op.v[cols[0]!] as string },
    };
    cols.forEach((k) => p.cols.add(k));
    p.ids.push(op.v.id);
    plan.set(op.i, p);
  }
  // Each table is measured on its own: where its first sample row should be today, against where
  // it is. A table that missed an earlier move (or moved twice) is put right, never pushed further.
  const offset = dayDiff(today, data.base);
  const where = resolver(offset, { templates: new Map(), roles: new Map() });
  const stuck: string[] = [];
  let moved = 0;
  for (const [table, p] of plan) {
    const isDate = p.probe.tag.startsWith('@D:');
    const cur = await c.query<{ v: string | null }>(
      isDate
        ? `SELECT ${p.probe.col}::date::text AS v FROM ${table} WHERE id = $1`
        : `SELECT (extract(epoch from ${p.probe.col}) * 1000)::bigint::text AS v FROM ${table} WHERE id = $1`,
      [p.probe.id],
    );
    const now = cur.rows[0]?.v;
    if (now === undefined || now === null) continue;
    const want = where(p.probe.tag) as string;
    const days = isDate
      ? dayDiff(want, now)
      : Math.round((Date.parse(want) - Number(now)) / 86_400_000);
    if (days === 0) continue;
    moved = days;
    const sets = [...p.cols].map((k) => `${k} = ${k} + make_interval(days => $2)`).join(', ');
    await c.query('SAVEPOINT rebase');
    try {
      await c.query(`UPDATE ${table} SET ${sets} WHERE id = ANY($1::uuid[])`, [p.ids, days]);
      await c.query('RELEASE SAVEPOINT rebase');
    } catch {
      await c.query('ROLLBACK TO SAVEPOINT rebase');
      // Append-only and closed records refuse edits (their guard triggers). These are the loader's
      // own synthetic rows, so lift the guards for this one statement, inside this transaction.
      await c.query('SAVEPOINT rebase');
      try {
        await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
        await c.query(`UPDATE ${table} SET ${sets} WHERE id = ANY($1::uuid[])`, [p.ids, days]);
        await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
        await c.query('RELEASE SAVEPOINT rebase');
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT rebase');
        stuck.push(table);
      }
    }
  }
  return { days: moved, stuck };
}
