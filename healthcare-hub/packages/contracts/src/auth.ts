import { z } from 'zod';

/**
 * Local username + password sign-in (AUTH_MODE=local, ADR 0006). Production uses Entra External
 * ID (ADR 0003); these endpoints answer 404 in any other mode.
 */

/** Exact messages (WORKFLOWS A1 and ADR 0006). The API and the web use the same text. */
export const AUTH_MESSAGES = {
  /** Unknown username, wrong password: always the same words. */
  invalid: 'Username or password is incorrect.',
  /** Once the account (or that username) is locked, whatever the password was. */
  locked: 'Too many attempts. Try again later.',
  /** Only after a correct password: revoked, suspended, leaver or no current membership. */
  ended: 'Your access to this organisation has ended.',
  /** A1: a valid sign-in that matches no account or invitation. */
  unknownAccount: 'No account found for this sign-in. Ask your administrator to invite you.',
  /** A1: the API cannot be reached; the screen adds when data was last refreshed. */
  offline: 'We cannot reach the server. Try again',
  mfaNeeded: 'Your role needs multi-factor sign-in',
  badCode: 'That code is not right. Check your authenticator app and try again.',
  challengeExpired: 'Your sign-in has timed out. Sign in again.',
  wrongCurrentPassword: 'Your current password is incorrect.',
  /** Refresh refused: no session, expired, signed out elsewhere, or revoked. */
  sessionEnded: 'Your session has ended. Sign in again.',
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

/** A short list of passwords that pass the length rule but are guessed first. Compared lower-case. */
export const COMMON_PASSWORDS: readonly string[] = [
  '123456789012',
  '1234567890123',
  'password1234',
  'password12345',
  'password123!',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopasdf',
  'letmein12345',
  'welcome12345',
  'welcome2026!',
  'changeme1234',
  'iloveyou1234',
  'administrator',
  'healthcarehub',
  'healthcarehub1',
  'ambulance1234',
  'monkey123456',
  'football1234',
  'abcdefghijkl',
  'aaaaaaaaaaaa',
];

/** Why a new password is refused, or null when it is acceptable. Same rule on web and API. */
export function passwordProblem(username: string, password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (lower === username.trim().toLowerCase())
    return 'Your password must not be the same as your username.';
  if (COMMON_PASSWORDS.includes(lower)) return 'This password is too common. Choose another.';
  return null;
}

const username = z.string().trim().toLowerCase().min(3).max(254);
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const challengeId = z.string().min(20).max(200);

export const LoginRequest = z.strictObject({ username, password });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MfaSetupRequest = z.strictObject({ challengeId });
export type MfaSetupRequest = z.infer<typeof MfaSetupRequest>;

export const MfaVerifyRequest = z.strictObject({
  challengeId,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;

/** Signed-in user changing their own password. */
export const ChangePasswordRequest = z.strictObject({
  currentPassword: password,
  newPassword: password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** Forced change at sign-in (temporary password from an administrator). */
export const ForcedPasswordChangeRequest = z.strictObject({
  challengeId,
  newPassword: password,
});
export type ForcedPasswordChangeRequest = z.infer<typeof ForcedPasswordChangeRequest>;

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** Result of every sign-in step: either a token or the next step with a single-use challenge. */
export const LoginResponse = z.union([
  TokenResponse,
  z.object({ mfaRequired: z.literal(true), challengeId: z.string() }),
  z.object({ mfaSetupRequired: z.literal(true), challengeId: z.string() }),
  z.object({ passwordChangeRequired: z.literal(true), challengeId: z.string() }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

/** TOTP enrolment: the secret is shown once as text (no QR library). */
export const MfaSetupResponse = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type MfaSetupResponse = z.infer<typeof MfaSetupResponse>;

/** Temporary password, shown to the administrator exactly once. */
export const PasswordResetResponse = z.object({
  temporaryPassword: z.string(),
  mustChangePassword: z.literal(true),
});
export type PasswordResetResponse = z.infer<typeof PasswordResetResponse>;

/**
 * Administrator MFA reset: removes the person's authenticator (TOTP) so they enrol again at their
 * next sign-in, and ends their refresh sessions. Never one's own. The reason is audited.
 */
export const MfaResetRequest = z.strictObject({ reason: z.string().trim().min(5).max(500) });
export type MfaResetRequest = z.infer<typeof MfaResetRequest>;

export const MfaResetResponse = z.object({ mfaReset: z.literal(true) });
export type MfaResetResponse = z.infer<typeof MfaResetResponse>;

/**
 * Refresh token cookie (HttpOnly, SameSite=Strict, path /api/v1/auth; never readable by scripts).
 * Each token is single use; 30 minutes idle, 12 hours from the password sign-in at most.
 */
export const LOCAL_REFRESH_IDLE_SECONDS = 30 * 60;
export const LOCAL_REFRESH_ABSOLUTE_SECONDS = 12 * 60 * 60;
