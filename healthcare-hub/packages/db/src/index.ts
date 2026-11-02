import { PrismaPg } from '@prisma/adapter-pg';
import { appendAudit, verifyAuditChain } from './audit.js';
import { withIdentity, withTenant } from './context.js';
import type { TenantContext, TenantTx } from './context.js';
import { PrismaClient } from './generated/client.js';
import type { UserStatus } from './generated/client.js';

export type { TenantContext, TenantTx } from './context.js';
export type { AuditEventInput, ChainBreak } from './audit.js';
export { appendAudit, verifyAuditChain } from './audit.js';
export { assertUuid } from './context.js';
export { UserStatus, Prisma } from './generated/client.js';
export type {
  ActorType,
  LocationType,
  StaffLifecycle,
  StaffRole,
  StaffRecordKind,
  StaffRestrictionType,
  CorrectionStatus,
} from './generated/client.js';
export type {
  Applicability,
  AlertSeverity,
  AlertState,
  NotificationChannel,
  NotificationStatus,
  RagStatus,
  RequirementBlocking,
  RequirementSubjectType,
  ScanStatus,
  TemplateVersionStatus,
  VerificationDecision,
} from './generated/enums.js';

/** Actor id used by background jobs (reconciler, notifications). Never a real user. */
export const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000000';

export interface ResolvedUser {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
}

export interface Db {
  /** The only way request handlers touch tenant data. */
  withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Identity-only context for lookups that precede organisation selection. */
  withIdentity<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Maps a verified IdP subject to a user via a narrow SECURITY DEFINER function. */
  resolveUser(idpSubject: string): Promise<ResolvedUser | null>;
  /** Links a verified IdP subject to a pending invitation (email must be IdP-verified). */
  linkInvitedUser(idpSubject: string, verifiedEmail: string): Promise<ResolvedUser | null>;
  /** Resolves an ACTIVE platform-support account by email (id only; nothing else is exposed). */
  findSupportUser(email: string): Promise<string | null>;
  appendAudit: typeof appendAudit;
  verifyAuditChain: typeof verifyAuditChain;
  /** Organisation ids to reconcile (worker only; ids, nothing else). */
  listOrganisations(): Promise<string[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Creates the scoped database facade. Connects as the (non-owner) application role. */
export function createDb(connectionString: string): Db {
  // The raw client stays private to this module: callers only get scoped helpers.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return {
    withTenant: (ctx, fn) => withTenant(prisma, ctx, fn),
    withIdentity: (userId, fn) => withIdentity(prisma, userId, fn),
    async resolveUser(idpSubject) {
      const rows = await prisma.$queryRaw<
        { id: string; email: string; display_name: string; status: UserStatus }[]
      >`SELECT id, email, display_name, status FROM auth_resolve_user(${idpSubject})`;
      const r = rows[0];
      return r ? { id: r.id, email: r.email, displayName: r.display_name, status: r.status } : null;
    },
    async linkInvitedUser(idpSubject, verifiedEmail) {
      const rows = await prisma.$queryRaw<
        { id: string; email: string; display_name: string; status: UserStatus }[]
      >`SELECT id, email, display_name, status FROM auth_link_invited(${idpSubject}, ${verifiedEmail})`;
      const r = rows[0];
      return r ? { id: r.id, email: r.email, displayName: r.display_name, status: r.status } : null;
    },
    async findSupportUser(email) {
      const rows = await prisma.$queryRaw<
        { id: string | null }[]
      >`SELECT find_support_user(${email}) AS id`;
      return rows[0]?.id ?? null;
    },
    appendAudit,
    verifyAuditChain,
    async listOrganisations() {
      const rows = await prisma.$queryRaw<
        { id: string }[]
      >`SELECT worker_list_organisations() AS id`;
      return rows.map((r) => r.id);
    },
    async ping() {
      await prisma.$queryRaw`SELECT 1`;
    },
    close: () => prisma.$disconnect(),
  };
}
