// Shared helpers for the fleet / dispatch / premises v36 adapters (step 2, 18 Nov 2026).
import { appendAudit, type TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';
import type { V36Ctx, V36Record } from './types.js';

/** v36's role letters for the signed-in person (ROLE in the prototype). */
const ROLE_OF: Record<string, string> = {
  REGISTERED_MANAGER: 'rm',
  DIRECTOR: 'dir',
  HR_LEAD: 'hr',
  FLEET_LEAD: 'fleet',
  GOVERNANCE_LEAD: 'gov',
  DISPATCHER: 'disp',
  CREW: 'crew',
  AUDITOR: 'aud',
};
export function v36Roles(ctx: V36Ctx): Set<string> {
  return new Set(ctx.hub.roleKeys.map((k) => ROLE_OF[k]).filter((x): x is string => !!x));
}
/** v36 `need('crew fleet rm dir', '…')`: refuses with v36's own words. */
export function need(ctx: V36Ctx, keys: string, what: string): void {
  const mine = v36Roles(ctx);
  if (!keys.split(' ').some((k) => mine.has(k))) throw new HubError('FORBIDDEN', 403, what);
}
/** v36 `deny(...)`: a rule refusal with v36's words. */
export function deny(what: string, status = 422): never {
  throw new HubError(status === 403 ? 'FORBIDDEN' : 'CONFLICT', status, what);
}

// ---- time ----------------------------------------------------------------------------------
const SV = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Europe/London' }); // 2026-11-17 06:10:00
export const lDate = (d: Date | null | undefined) => (d ? SV(d).slice(0, 10) : null);
export const lTime = (d: Date | null | undefined) => (d ? SV(d).slice(11, 16) : null);
export const lTimeS = (d: Date | null | undefined) => (d ? SV(d).slice(11, 19) : null);
export const lStamp = (d: Date | null | undefined) => (d ? SV(d).slice(0, 16) : null);
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
export const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** A v36 'YYYY-MM-DD[ HH:MM[:SS]]' London wall-clock value as an instant. */
export function fromLondon(date: string, time = '12:00'): Date {
  const t = time.length === 5 ? `${time}:00` : time;
  const guess = new Date(`${date}T${t}Z`);
  // London is UTC or UTC+1: find the offset at that instant.
  for (const off of [0, -60]) {
    const d = new Date(guess.getTime() + off * 60_000);
    if (SV(d) === `${date} ${t}`) return d;
  }
  return guess;
}
export function addDays(s: string, n: number): string {
  const d = day(s);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d)!;
}
export function addMonths(s: string, months: number): string {
  const [y, m, dd] = s.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
}

// ---- vehicles ------------------------------------------------------------------------------
export interface Fleet {
  idOf(callsign: string | null | undefined): string | null;
  need(callsign: string | null | undefined): string;
  callsignOf(id: string | null | undefined): string | null;
}
export async function loadFleet(tx: TenantTx): Promise<Fleet> {
  const rows = await tx.$queryRaw<{ id: string; callsign: string }[]>`
    SELECT id, callsign FROM vehicle`;
  const byCs = new Map(rows.map((r) => [r.callsign, r.id]));
  const byId = new Map(rows.map((r) => [r.id, r.callsign]));
  return {
    idOf: (c) => (c ? (byCs.get(c) ?? null) : null),
    need: (c) => {
      const id = c ? byCs.get(c) : undefined;
      if (!id) throw new HubError('VALIDATION_FAILED', 400, `Unknown vehicle ${c ?? ''}`.trim());
      return id;
    },
    callsignOf: (id) => (id ? (byId.get(id) ?? null) : null),
  };
}

/** Per-request scratch: what earlier changes of the same v36 button already did. */
export interface Scratch {
  /** v36 check ids (VDI-5523) submitted in this request → the server's code. */
  checks: Map<string, string>;
  /** Vehicles whose odometer this request already recorded. */
  odo: Set<string>;
}
const scratch = new WeakMap<V36Ctx, Scratch>();
export function scratchOf(ctx: V36Ctx): Scratch {
  let s = scratch.get(ctx);
  if (!s) scratch.set(ctx, (s = { checks: new Map(), odo: new Set() }));
  return s;
}

/** Audit row for a write made with SQL (same shape as the endpoints' `audit`). */
export function auditSql(
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
    afterSummary: { ...summary, via: 'v36', act: ctx.act },
    ipHash: ctx.hub.ipHash,
  });
}

/** Plain JSON compare of two record fields. */
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const str = (r: V36Record | null | undefined, k: string) =>
  r && typeof r[k] === 'string' ? (r[k] as string) : null;
export const obj = (r: V36Record | null | undefined, k: string) =>
  r && r[k] && typeof r[k] === 'object' ? (r[k] as V36Record) : null;
/** v36 registrations carry a space before the last three characters ("SY21 ABC"). */
export const fmtReg = (r: string) => {
  const s = r.replace(/\s+/g, '').toUpperCase();
  return s.length > 3 ? `${s.slice(0, -3)} ${s.slice(-3)}` : s;
};
/** v36 codes keep their number; the next one continues after the highest (DEF-083). */
export async function bumpCounter(tx: TenantTx, orgId: string, prefix: string, codes: string[]) {
  const max = Math.max(0, ...codes.map((c) => Number(/(\d+)$/.exec(c)?.[1] ?? 0)));
  if (!max) return;
  await tx.$executeRaw`
    INSERT INTO org_counter (organisation_id, prefix, value) VALUES (${orgId}::uuid, ${prefix}, ${max})
    ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value)`;
}
