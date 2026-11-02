import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'hub:public';
export const AUTH_ONLY_KEY = 'hub:auth-only';
export const ORG_MEMBER_KEY = 'hub:org-member';
export const PERMISSION_KEY = 'hub:permission';
export const AUDIT_KEY = 'hub:audit';

/** No authentication (health probes, OpenAPI). Use sparingly. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Any authenticated user, no organisation or permission needed (e.g. /me). */
export const AuthenticatedOnly = () => SetMetadata(AUTH_ONLY_KEY, true);
/** Any member of the selected organisation (X-Org-Id required); no specific permission. */
export const OrgMember = () => SetMetadata(ORG_MEMBER_KEY, true);
/**
 * Declares the permission key (`module.resource.action`) required to call the route.
 * Server-side authorisation is mandatory; UI hiding is cosmetic only (CLAUDE.md #1).
 */
export const RequirePermission = (...keys: string[]) => SetMetadata(PERMISSION_KEY, keys);

export interface AuditSpec {
  action: string;
  entity: string;
  /** Route param holding the entity id, default `id`. */
  idParam?: string;
}
/** Emits a tamper-evident audit event after the handler succeeds. */
export const Audited = (spec: AuditSpec) => SetMetadata(AUDIT_KEY, spec);
