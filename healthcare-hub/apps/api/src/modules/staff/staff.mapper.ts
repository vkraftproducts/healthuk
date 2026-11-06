import type { CorrectionDto, StaffClearanceDto, StaffDto, StaffRecordDto } from '@hub/contracts';
import type { Prisma } from '@hub/db';
import { decryptField } from '../../common/field-crypto.js';

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const ts = (d: Date | null): string | null => (d ? d.toISOString() : null);

type StaffRow = Prisma.StaffGetPayload<object>;
export interface Summary {
  counts: { red: number; amber: number; grey: number; green: number };
  overall: StaffDto['overallStatus'];
  roles: string[];
}

export function toStaffDto(s: StaffRow, sum: Summary, restrictions: string[]): StaffDto {
  return {
    id: s.id,
    staffNo: s.staffNo,
    displayName: s.displayName,
    userId: s.userId,
    lifecycleState: s.lifecycleState,
    primaryLocationId: s.primaryLocationId,
    managerStaffId: s.managerStaffId,
    jobTitle: s.jobTitle,
    workingPattern: s.workingPattern,
    roles: sum.roles as StaffDto['roles'],
    activeRestrictions: restrictions as StaffDto['activeRestrictions'],
    overallStatus: sum.overall,
    counts: sum.counts,
    version: s.version,
  };
}

/** Dispatcher view: approved roles and restrictions only (PRD §4.3). */
export function toClearanceDto(
  s: StaffRow,
  roles: string[],
  restrictions: string[],
): StaffClearanceDto {
  return {
    id: s.id,
    staffNo: s.staffNo,
    displayName: s.displayName,
    lifecycleState: s.lifecycleState,
    roles: roles as StaffClearanceDto['roles'],
    activeRestrictions: restrictions as StaffClearanceDto['activeRestrictions'],
  };
}

type RecordRow = Prisma.StaffRecordGetPayload<{
  include: { supersededBy: { select: { id: true } } };
}>;

/** User ids the record names (checker, assessor, supervisor, ...): their fields end in UserId. */
export function userIdsIn(data: unknown): string[] {
  return Object.entries((data ?? {}) as Record<string, unknown>)
    .filter(([k, v]) => k.endsWith('UserId') && typeof v === 'string')
    .map(([, v]) => v as string);
}

export function toRecordDto(
  r: RecordRow,
  key: Buffer,
  names: ReadonlyMap<string, string> = new Map(),
): StaffRecordDto {
  const data = { ...(r.data as Record<string, unknown>) };
  if (r.kind === 'DBS' && typeof data.certificateNumber === 'string') {
    data.certificateNumber = decryptField(data.certificateNumber, key) ?? '[unreadable]';
  }
  return {
    id: r.id,
    staffId: r.staffId,
    kind: r.kind,
    data,
    validFrom: iso(r.validFrom),
    validTo: iso(r.validTo),
    requirementInstanceId: r.requirementInstanceId,
    supersedesId: r.supersedesId,
    supersededById: r.supersededBy?.id ?? null,
    current: !r.supersededBy,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    people: Object.fromEntries(
      userIdsIn(r.data).flatMap((id) => (names.has(id) ? [[id, names.get(id)!]] : [])),
    ),
  };
}

export function toCorrectionDto(c: Prisma.StaffCorrectionRequestGetPayload<object>): CorrectionDto {
  return {
    id: c.id,
    staffId: c.staffId,
    field: c.field,
    proposedValue: c.proposedValue,
    reason: c.reason,
    status: c.status,
    requestedBy: c.requestedBy,
    decidedBy: c.decidedBy,
    decidedAt: ts(c.decidedAt),
    decisionNote: c.decisionNote,
    createdAt: c.createdAt.toISOString(),
    version: c.version,
  };
}

export const roleApprovalDto = (a: Prisma.StaffRoleApprovalGetPayload<object>, now: Date) => ({
  id: a.id,
  role: a.role,
  reason: a.reason,
  approvedBy: a.approvedBy,
  validFrom: a.validFrom.toISOString(),
  validTo: ts(a.validTo),
  revokedAt: ts(a.revokedAt),
  revokeReason: a.revokeReason,
  active: !a.revokedAt && a.validFrom <= now && (!a.validTo || a.validTo > now),
});

export const restrictionDto = (r: Prisma.StaffRestrictionGetPayload<object>, now: Date) => ({
  id: r.id,
  type: r.type,
  detail: r.detail,
  reason: r.reason,
  appliedBy: r.appliedBy,
  validFrom: r.validFrom.toISOString(),
  validTo: ts(r.validTo),
  liftedAt: ts(r.liftedAt),
  liftReason: r.liftReason,
  active: !r.liftedAt && r.validFrom <= now && (!r.validTo || r.validTo > now),
});

/** Validity window derived from the typed payload (DBS has no expiry, HR-02). */
export function derivedValidity(
  kind: string,
  d: Record<string, unknown>,
): { validFrom: string | null; validTo: string | null } {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
  switch (kind) {
    case 'LICENCE':
      return { validFrom: null, validTo: s('photocardExpiry') };
    case 'RIGHT_TO_WORK':
      return { validFrom: s('checkedOn'), validTo: s('followUpOn') };
    case 'REGISTRATION':
      return { validFrom: null, validTo: s('expiresOn') };
    case 'TRAINING':
      return { validFrom: s('completedOn'), validTo: s('expiresOn') };
    case 'COMPETENCY':
      return { validFrom: s('assessedOn'), validTo: s('expiresOn') };
    case 'OH_CLEARANCE':
      return { validFrom: s('assessedOn'), validTo: s('reviewOn') };
    case 'DBS':
      return { validFrom: s('issueDate'), validTo: null };
    default:
      return { validFrom: null, validTo: null };
  }
}
