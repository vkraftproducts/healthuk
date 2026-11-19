// Shared lookups for the adapters: v36 refers to people by name and staff by code (ST-0042);
// the tables use ids. One query per load, then plain maps.
import type { TenantTx } from '@hub/db';
import { HubError } from '../../../common/problem.filter.js';

export interface People {
  /** user id → display name */
  nameOf(userId: string | null | undefined): string | null;
  /** display name → user id (members of this organisation only) */
  userIdOf(name: string | null | undefined): string | null;
  /** Same, but refuses an unknown name (for writes). */
  needUserId(name: string | null | undefined, what?: string): string;
  /** staff code (staff_no) → staff id, and back */
  staffIdOf(code: string | null | undefined): string | null;
  staffCodeOf(staffId: string | null | undefined): string | null;
}

export async function loadPeople(tx: TenantTx): Promise<People> {
  const users = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT DISTINCT u.id, u.display_name AS name
      FROM membership m JOIN app_user u ON u.id = m.user_id`;
  const staff = await tx.$queryRaw<
    { id: string; code: string }[]
  >`SELECT id, staff_no AS code FROM staff`;
  const byId = new Map(users.map((u) => [u.id, u.name]));
  const byName = new Map(users.map((u) => [u.name.trim().toLowerCase(), u.id]));
  const sByCode = new Map(staff.map((s) => [s.code, s.id]));
  const sById = new Map(staff.map((s) => [s.id, s.code]));
  const userIdOf = (n: string | null | undefined) =>
    n ? (byName.get(n.trim().toLowerCase()) ?? null) : null;
  return {
    nameOf: (id) => (id ? (byId.get(id) ?? null) : null),
    userIdOf,
    needUserId: (n, what = 'The person') => {
      const id = userIdOf(n);
      if (!id)
        throw new HubError(
          'VALIDATION_FAILED',
          400,
          `${what} (${n ?? 'nobody'}) is not a member of this organisation`,
        );
      return id;
    },
    staffIdOf: (c) => (c ? (sByCode.get(c) ?? null) : null),
    staffCodeOf: (id) => (id ? (sById.get(id) ?? null) : null),
  };
}

/** `YYYY-MM-DD` from a date column; v36 keeps dates as strings. */
export const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** `YYYY-MM-DD HH:MM` London time, as v36 stamps (on/at fields). */
export function stamp(d: Date | null | undefined): string | null {
  if (!d) return null;
  const s = d.toLocaleString('sv-SE', { timeZone: 'Europe/London' });
  return s.slice(0, 16);
}
