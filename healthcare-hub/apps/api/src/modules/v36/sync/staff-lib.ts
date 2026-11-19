// Shared words and conversions for the staff area of v36 (people, checks, registers). The v36
// words are the specification: labels, codes and date formats exactly as the prototype writes them.
import { appendAudit, type TenantTx } from '@hub/db';
import { endOfLondonDay, londonDate } from '@hub/rules';
import { HubError } from '../../../common/problem.filter.js';
import type { V36Ctx, V36Record } from './types.js';

/** v36 check code → requirement template code (as the v36 sample data was loaded). */
export const CHECK_TEMPLATE: Record<string, string> = {
  ID: 'AMB-STF-03',
  DBS: 'AMB-STF-02',
  REF: 'AMB-STF-04',
  EMP: 'ORG-STF-01',
  RTW: 'ORG-STF-02',
  OH: 'ORG-STF-03',
  QUAL: 'ORG-STF-04',
  HCPC: 'ORG-STF-05',
  DL: 'AMB-STF-01',
  DA: 'AMB-DRV-01',
  MH: 'AMB-STF-05',
  BLS: 'AMB-STF-06',
  SG: 'AMB-STF-07',
  IPC: 'AMB-STF-08',
  IG: 'ORG-STF-06',
  IND: 'AMB-STF-09',
};
export const TEMPLATE_CHECK: Record<string, string> = Object.fromEntries(
  Object.entries(CHECK_TEMPLATE).map(([c, t]) => [t, c]),
);
/** v36 REQ[c].n (the check's name) and m (months it lasts). */
export const CHECK_NAME: Record<string, { n: string; m?: number }> = {
  ID: { n: 'Proof of identity with recent photo' },
  DBS: { n: 'Enhanced DBS with barred lists' },
  REF: { n: 'Two references, incl. last employer' },
  EMP: { n: 'Full employment history, gaps explained' },
  RTW: { n: 'Right to work in the UK' },
  OH: { n: 'Occupational health – fit for the role' },
  QUAL: { n: 'Qualifications for the role' },
  HCPC: { n: 'HCPC registration (paramedic)', m: 24 },
  DL: { n: 'Driving licence incl. C1, checked with DVLA', m: 6 },
  DA: { n: 'Driving assessment (emergency response)', m: 36 },
  MH: { n: 'Manual handling', m: 12 },
  BLS: { n: 'Basic life support', m: 12 },
  SG: { n: 'Safeguarding adults & children (level 2)', m: 36 },
  IPC: { n: 'Infection prevention & control', m: 12 },
  IG: { n: 'Information governance & data security', m: 12 },
  IND: { n: 'Induction completed and signed' },
};
/** Checks whose documents are HR-sensitive (v36 shows "Restricted" to others). */
export const SENSITIVE_CHECKS = new Set(['DBS', 'OH']);

export const JOB_ROLE: Record<string, string> = {
  Driver: 'DRIVER',
  'Care assistant': 'CARE_ASSISTANT',
  'Emergency care assistant': 'EMERGENCY_CARE_ASSISTANT',
  Technician: 'TECHNICIAN',
  Paramedic: 'PARAMEDIC',
};
export const ROLE_JOB: Record<string, string> = Object.fromEntries(
  Object.entries(JOB_ROLE).map(([j, r]) => [r, j]),
);
/** Any other StaffRole, in words (agency workers, approvals for roles v36 has no job for). */
export const ROLE_WORDS: Record<string, string> = {
  ...ROLE_JOB,
  NURSE: 'Nurse',
  CONTROL_ROOM: 'Control room',
  MANAGER: 'Manager',
  OTHER: 'Other',
};

export const STAGE: Record<string, string> = {
  CANDIDATE: 'Candidate',
  CHECKS_IN_PROGRESS: 'Checks in progress',
  READY_FOR_REVIEW: 'Ready for review',
  APPROVED_FOR_ROLE: 'Approved for role',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  LEAVER: 'Left',
};
export const STAGE_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE).map(([s, w]) => [w, s]),
);
export const CONTRACT: Record<string, string> = {
  PERMANENT: 'Permanent',
  FIXED_TERM: 'Fixed term',
  BANK: 'Bank',
  AGENCY: 'Agency',
};
export const CONTRACT_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(CONTRACT).map(([c, w]) => [w, c]),
);

/** The restrictions v36 offers, and the restriction type each one is. */
export const RESTRICTION_TYPE: Record<string, string> = {
  'No lone working': 'NO_LONE_WORKING',
  'No blue-light driving': 'NO_BLUE_LIGHT',
};
export const RESTRICTION_WORDS: Record<string, string> = {
  NO_DRIVING: 'No driving',
  NO_BLUE_LIGHT: 'No blue-light driving',
  NO_LONE_WORKING: 'No lone working',
  NO_PATIENT_CONTACT: 'No patient contact',
  NO_CHILDREN: 'No work with children',
  NO_NIGHT_SHIFTS: 'No night shifts',
  OTHER: 'Other (see reason)',
};

// ---- dates ---------------------------------------------------------------------------------------
/** A date column as v36 writes it. */
export const d10 = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);
/** An instant as a London date. */
export const ld = (x: Date | null | undefined) => (x ? londonDate(x) : null);
/** `YYYY-MM-DD` → the Date stored in a `date` column. */
export const dcol = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const isDay = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** A v36 stamp `YYYY-MM-DD HH:MM` (London) → instant. A bare date is 09:00. */
export function fromStamp(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const [, date, hh = '09', mm = '00'] = m;
  // London offset on that day: compare the wall clock of a UTC guess.
  const guess = new Date(`${date}T${hh}:${mm}:00Z`);
  const wall = guess.toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 16);
  const diff = new Date(`${wall.replace(' ', 'T')}:00Z`).getTime() - guess.getTime();
  return new Date(guess.getTime() - diff);
}
export const endOfDay = (s: string) => endOfLondonDay(s);

// ---- record helpers -------------------------------------------------------------------------------
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function rec(v: unknown): V36Record {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as V36Record) : {};
}
export function arr<T = V36Record>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
/** Drops undefined fields (v36 records simply lack a field that is not set). */
export function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export const refuse = (detail: string, status = 422) =>
  new HubError(status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED', status, detail);

/** A list endpoint the person may not read gives an empty collection instead of failing the page. */
export async function listOrEmpty<T>(ctx: V36Ctx, path: string): Promise<T[]> {
  try {
    const r = await ctx.api<{ data: T[] }>('GET', path);
    return r.data ?? [];
  } catch (e) {
    if (e instanceof HubError && (e.getStatus() === 403 || e.getStatus() === 404)) return [];
    throw e;
  }
}

/** Organisation counter: make sure the next code after an import continues from the highest one. */
export async function bumpCounter(tx: TenantTx, orgId: string, prefix: string, codes: string[]) {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const c of codes) {
    const m = re.exec(c);
    if (m) max = Math.max(max, Number(m[1]));
  }
  if (!max) return;
  await tx.$executeRaw`
    INSERT INTO org_counter (organisation_id, prefix, value) VALUES (${orgId}::uuid, ${prefix}, ${max})
    ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, ${max})`;
}

/** `PREFIX-n` from next_code, written with v36's zero-padding (LV-04, AG-03, TS-032). */
export function padCode(code: string, width: number): string {
  const m = /^([A-Z]+)-(\d+)$/.exec(code);
  return m ? `${m[1]}-${m[2]!.padStart(width, '0')}` : code;
}

/** Audit row for a write made here with SQL (no endpoint), same shape as common/http.ts audit(). */
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
    afterSummary: { ...summary, via: 'v36' },
    ipHash: ctx.hub.ipHash,
  });
}

/** Tables whose `code` column holds v36 references (allow-list for nextV36Code). */
const CODE_TABLES = {
  staff_review: 'staff_review',
  staff_absence: 'staff_absence',
  leaver_record: 'leaver_record',
  agency_worker: 'agency_worker',
  training_plan: 'training_plan',
  shift_swap_request: 'shift_swap_request',
  supervision_booking: 'supervision_booking',
  staff_correction_request: 'staff_correction_request',
} as const;

/**
 * The next v36 reference (LV-04, SUP-303, COR-08): the organisation counter is first moved past
 * the highest reference already in the table (moved-in or seeded rows), so numbering continues
 * after them, then padded the way v36 writes it.
 */
export async function nextV36Code(
  tx: TenantTx,
  orgId: string,
  prefix: string,
  table: keyof typeof CODE_TABLES,
  width = 0,
): Promise<string> {
  const t = CODE_TABLES[table];
  const rows = await tx.$queryRawUnsafe<{ n: number | null }[]>(
    `SELECT max(substring(code from '^${prefix}-([0-9]+)$')::int) AS n FROM ${t}
      WHERE organisation_id = $1::uuid AND code ~ '^${prefix}-[0-9]+$'`,
    orgId,
  );
  const max = rows[0]?.n ?? 0;
  if (max > 0)
    await tx.$executeRaw`
      INSERT INTO org_counter (organisation_id, prefix, value) VALUES (${orgId}::uuid, ${prefix}, ${max})
      ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, ${max})`;
  const r = await tx.$queryRaw<{ code: string }[]>`
    SELECT next_code(${orgId}::uuid, ${prefix}, 1) AS code`;
  return width ? padCode(r[0]!.code, width) : r[0]!.code;
}
