// Shared helpers for the governance adapters (incidents, audits, actions, policies, risks and the
// registers). v36 checks permissions by its own role keys and the person's name; the adapters
// repeat those checks on the server with the real signed-in user, then write through the tables
// with an audit row per change.
import { appendAudit, type TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import type { V36Ctx, V36Record } from './types.js';

export type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---- roles ----------------------------------------------------------------------------------
/** Our system roles → v36's role key. The first match wins (same order as V36Frame). */
const ROLE_MAP: [string, string][] = [
  ['REGISTERED_MANAGER', 'rm'],
  ['ORG_ADMIN', 'rm'],
  ['DIRECTOR', 'dir'],
  ['GOVERNANCE_LEAD', 'gov'],
  ['HR_LEAD', 'hr'],
  ['FLEET_LEAD', 'fleet'],
  ['PREMISES_LEAD', 'fleet'],
  ['DISPATCHER', 'disp'],
  ['CREW', 'crew'],
  ['AUDITOR', 'aud'],
];
export function v36Role(ctx: V36Ctx): string {
  for (const [k, r] of ROLE_MAP) if (ctx.hub.roleKeys.includes(k)) return r;
  return 'aud';
}
export const isRole = (ctx: V36Ctx, keys: string) => keys.split(' ').includes(v36Role(ctx));
/** v36's need(): refuses with v36's own words when the role is not one of `keys`. */
export function need(ctx: V36Ctx, keys: string, what: string): void {
  if (ctx.hub.support || v36Role(ctx) === 'aud') refuse('this role is read-only');
  if (!isRole(ctx, keys)) refuse(what);
}
export function refuse(detail: string, status = 403): never {
  throw new HubError(status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED', status, detail);
}
export function invalid(detail: string): never {
  return refuse(detail, 400);
}
/** The signed-in person's name, as v36 shows "you" (ME().n). */
export const meName = (ctx: V36Ctx) => ctx.hub.user.displayName;
export const sameName = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

// ---- audit ----------------------------------------------------------------------------------
/** One audit row in the change's own transaction (same chain as every endpoint). */
export function auditRow(
  ctx: V36Ctx,
  tx: TenantTx,
  action: string,
  entity: string,
  entityId: string,
  summary: Record<string, string | number | boolean | null> = {},
) {
  return appendAudit(tx, {
    orgId: ctx.orgId,
    actorUserId: ctx.userId,
    actorType: ctx.hub.support ? 'SUPPORT' : 'USER',
    action,
    entity,
    entityId,
    afterSummary: { ...summary, via: 'v36', ...(ctx.act ? { act: ctx.act } : {}) },
    ipHash: ctx.hub.ipHash,
  });
}

// ---- dates ----------------------------------------------------------------------------------
const ZONE = 'Europe/London';
/** London wall-clock 'YYYY-MM-DD HH:MM' (or a date alone) → the UTC instant. */
export function londonToUtc(s: string): Date {
  const [d, t = '12:00'] = s.trim().replace('T', ' ').split(' ');
  const guess = new Date(`${d}T${t.slice(0, 5)}:00Z`);
  if (Number.isNaN(guess.getTime())) invalid(`Not a valid date and time: ${s}`);
  const shown = new Date(guess.toLocaleString('en-US', { timeZone: ZONE }));
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess.getTime() - (shown.getTime() - asUtc.getTime()));
}
/** London calendar date of an instant. */
export const londonDay = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(d) : null;
/** A `date` column (UTC midnight) from 'YYYY-MM-DD'. */
export function dateCol(s: unknown): Date | null {
  if (typeof s !== 'string' || !s) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) invalid(`Not a valid date: ${s}`);
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}
export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---- values ---------------------------------------------------------------------------------
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;
export const changed = (a: V36Record | null, b: V36Record | null, k: string) =>
  JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null);
/** Drops keys whose value is undefined or null (v36 records leave unset fields out). */
export function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k];
  return o;
}
export function textLen(v: string | null, what: string, min: number, max: number) {
  if (v === null || v.trim().length < min)
    invalid(`${what}: write at least ${min} characters`);
  if (v.length > max) invalid(`${what}: at most ${max} characters`);
  return v;
}

// ---- codes ----------------------------------------------------------------------------------
const CODE_TABLES = new Set([
  'event',
  'action',
  'audit_run',
  'risk',
  'cqc_notification',
  'governance_meeting',
  'speak_up_concern',
  'safeguarding_referral',
  'feedback',
  'policy_document',
  'feedback_item',
  'contractor',
  'visitor_log',
]);
/**
 * v36 makes its own codes (nextId: highest trailing number + 1). The proposed code is kept when it
 * is free and has the same shape; otherwise (someone else took it, or the proposer could not see
 * every record) the next free number in the same shape is used. The API's own counter is moved
 * past it, so codes made by other screens never collide.
 */
export async function allocCode(
  tx: TenantTx,
  table: string,
  proposed: string,
  prefix: string,
  o: { column?: string; width?: number; counter?: string; start?: number } = {},
): Promise<string> {
  if (!CODE_TABLES.has(table)) throw new Error(`allocCode: ${table}`);
  const col = o.column ?? 'code';
  const re = new RegExp(`^${prefix.replace(/[-]/g, '\\-')}(\\d+)$`);
  let code = proposed;
  const used = async (c: string) =>
    (
      await tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`,
        c,
      )
    )[0]!.n > 0;
  if (!re.test(code) || (await used(code))) {
    const rows = await tx.$queryRawUnsafe<{ c: string }[]>(
      `SELECT ${col} AS c FROM ${table} WHERE ${col} LIKE $1`,
      `${prefix}%`,
    );
    let max = o.start ?? 0;
    for (const r of rows) {
      const m = re.exec(r.c);
      if (m) max = Math.max(max, Number(m[1]));
    }
    code = prefix + String(max + 1).padStart(o.width ?? 0, '0');
  }
  if (o.counter) {
    const n = Number(re.exec(code)![1]);
    await tx.$executeRaw`
      INSERT INTO org_counter (organisation_id, prefix, value)
      VALUES (app_org_id(), ${o.counter}, ${n})
      ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, ${n})`;
  }
  return code;
}

/** The organisation's Registered Manager (default incident lead before triage). */
export async function registeredManager(tx: TenantTx, fallback: string): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT m.user_id AS id FROM membership m JOIN role r ON r.id = m.role_id
     WHERE r.key = 'REGISTERED_MANAGER' AND m.valid_to IS NULL ORDER BY m.valid_from LIMIT 1`;
  return rows[0]?.id ?? fallback;
}

/** Sorts codes by their trailing number (ACT-99 before ACT-100). */
export const byCodeNo = (a: string, b: string) =>
  Number(/(\d+)$/.exec(a)?.[1] ?? 0) - Number(/(\d+)$/.exec(b)?.[1] ?? 0) || a.localeCompare(b);
