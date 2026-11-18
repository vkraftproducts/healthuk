// Small helpers shared by the v36 register controllers (17 Nov 2026). Nothing here changes how the
// existing modules behave; they keep their own copies.
import { ParseUUIDPipe } from '@nestjs/common';
import type { TenantTx } from '@hub/db';
import type { ItemKind, OrgSettings } from '@hub/contracts';
import { addDays, coverActive, escalationStage, londonDate } from '@hub/rules';
import { HubError, notFound } from '../../common/problem.filter.js';

export const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound() });

/** `YYYY-MM-DD` → the Date Prisma stores in a `date` column. */
export const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** A `date` column back to `YYYY-MM-DD`. */
export const ymd = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);
export const iso = (x: Date | null | undefined) => (x ? x.toISOString() : null);

/**
 * Next organisation code such as SGR-12. Uses the database's `next_code` directly so these
 * registers need no change to the shared prefix list in @hub/domain.
 */
export async function nextRegisterCode(
  tx: TenantTx,
  orgId: string,
  prefix: string,
  start = 1,
): Promise<string> {
  const rows = await tx.$queryRaw<
    { code: string }[]
  >`SELECT next_code(${orgId}::uuid, ${prefix}, ${start}::int) AS code`;
  return rows[0]!.code;
}

/** The person must be an active member of this organisation (RLS scopes membership to it). */
export async function assertActiveMember(tx: TenantTx, userId: string, what = 'The person') {
  const n = await tx.membership.count({
    where: { userId, validTo: null, user: { status: 'ACTIVE' } },
  });
  if (!n) throw new HubError('VALIDATION_FAILED', 400, `${what} is not an active member`);
}

/** An event the caller can see (restricted events stay hidden and read as not found). */
export async function assertVisibleEvent(tx: TenantTx, eventId: string) {
  const e = await tx.event.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!e) throw notFound();
}

export async function eventCodes(tx: TenantTx, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map<string, string>();
  const rows = await tx.event.findMany({
    where: { id: { in: want } },
    select: { id: true, code: true },
  });
  return new Map(rows.map((r) => [r.id, r.code]));
}

export async function vehicleLabels(tx: TenantTx, ids: (string | null)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map<string, string>();
  const rows = await tx.vehicle.findMany({
    where: { id: { in: want } },
    select: { id: true, callsign: true },
  });
  return new Map(rows.map((r) => [r.id, r.callsign]));
}

/** The staff record linked to the signed-in user in this organisation, if any. */
export async function myStaffId(tx: TenantTx, userId: string): Promise<string | null> {
  const s = await tx.staff.findFirst({ where: { userId }, select: { id: true } });
  return s?.id ?? null;
}

// ---- v36 escalation words ("· Escalated to Dr. A. Vance" / "· Escalated to lead") ------------------
// The stage comes from the organisation's per-kind escalation rules (Settings › Escalation rules),
// falling back to the organisation default. Supervision is not a settings kind yet, so it keeps the
// v36 default (lead after 7 days, registered manager after 14).

export type EscalationKind = ItemKind | 'SUPERVISION';
export interface EscalationWords {
  stage: 'LEAD' | 'MANAGER';
  toName: string | null;
}
export interface EscalationContext {
  now: Date;
  /** Days overdue → the escalation shown beside the status, or null while it is with the owner. */
  of(kind: EscalationKind, overdueDays: number): EscalationWords | null;
}

const SUPERVISION_ESC = { leadAfterDays: 7, managerAfterDays: 14 };

export async function escalationContext(tx: TenantTx, now = new Date()): Promise<EscalationContext> {
  // The organisation of the current tenant transaction.
  const [org] = await tx.$queryRaw<{ settings: unknown }[]>`
    SELECT settings FROM organisation WHERE id = app_org_id()`;
  const cfg = (org?.settings ?? {}) as Partial<
    Pick<OrgSettings, 'escalation' | 'itemRules' | 'deputies'>
  >;
  const base = cfg.escalation ?? { leadAfterDays: 1, managerAfterDays: 7 };
  const [rm] = await tx.$queryRaw<{ user_id: string; display_name: string }[]>`
    SELECT u.id AS user_id, u.display_name
      FROM membership m
      JOIN role r ON r.id = m.role_id
      JOIN app_user u ON u.id = m.user_id
     WHERE r.key = 'REGISTERED_MANAGER' AND m.valid_to IS NULL AND u.status = 'ACTIVE'
     ORDER BY m.created_at
     LIMIT 1`;
  // A deputy covering for the registered manager today is the person told instead.
  const today = londonDate(now);
  const cover = rm
    ? (cfg.deputies ?? []).find((d) => d.leadUserId === rm.user_id && coverActive(d, today))
    : undefined;
  let toName = rm?.display_name ?? null;
  if (cover) {
    const dep = await tx.appUser.findUnique({
      where: { id: cover.deputyUserId },
      select: { displayName: true },
    });
    toName = dep?.displayName ?? toName;
  }
  return {
    now,
    of(kind, overdueDays) {
      if (overdueDays <= 0) return null;
      const rule =
        kind === 'SUPERVISION' ? undefined : (cfg.itemRules ?? []).find((r) => r.kind === kind);
      const esc =
        kind === 'SUPERVISION'
          ? SUPERVISION_ESC
          : {
              leadAfterDays: rule?.leadAfterDays ?? base.leadAfterDays,
              managerAfterDays: rule?.managerAfterDays ?? base.managerAfterDays,
            };
      // Counted from the due date, as the escalation engine counts from when an alert was raised.
      const dueOn = new Date(`${addDays(today, -overdueDays)}T12:00:00Z`);
      const stage = escalationStage(dueOn, now, esc, false);
      if (stage === 'MANAGER') return { stage, toName };
      if (stage === 'LEAD') return { stage, toName: null };
      return null;
    },
  };
}
