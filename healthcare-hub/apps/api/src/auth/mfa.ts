/** Roles that must authenticate with MFA (SECURITY_COMPLIANCE §1). */
export const MFA_REQUIRED_ROLES: ReadonlySet<string> = new Set([
  'DIRECTOR',
  'REGISTERED_MANAGER',
  'HR_LEAD',
  'GOVERNANCE_LEAD',
  'ORG_ADMIN',
  'AUDITOR',
  'PLATFORM_SUPPORT',
]);

export const mfaRequiredFor = (roleKeys: readonly string[]): boolean =>
  roleKeys.some((k) => MFA_REQUIRED_ROLES.has(k));
