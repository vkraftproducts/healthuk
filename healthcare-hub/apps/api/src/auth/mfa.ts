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

let mfaSwitchedOff = false;

/** Local development only (DEV_DISABLE_MFA); loadConfig refuses it in production. */
export function switchOffMfaForDevelopment(): void {
  mfaSwitchedOff = true;
}

export const mfaRequiredFor = (roleKeys: readonly string[]): boolean =>
  !mfaSwitchedOff && roleKeys.some((k) => MFA_REQUIRED_ROLES.has(k));

/**
 * RFC 8176 `amr`: `mfa` from the IdP, or a password plus a one-time code (local sign-in issues
 * ['pwd', 'otp'] after a TOTP check). A one-time code alone is a single factor.
 */
export const mfaSatisfiedBy = (amr: readonly string[]): boolean =>
  amr.includes('mfa') || (amr.includes('pwd') && amr.includes('otp'));
