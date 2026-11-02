import { z } from 'zod';

/** Stable machine-readable business codes (API_SPEC "Errors"). */
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'ORG_REQUIRED',
  'MFA_REQUIRED',
  'USER_INACTIVE',
  'DEVICE_REVOKED',
  'ALLOCATION_BLOCKED',
  'SHIFT_GATE_BLOCKED',
  'EVIDENCE_NOT_VERIFIED',
  'STALE_VERSION',
  'OVERRIDE_NOT_PERMITTED',
  'FOUR_EYES_REQUIRED',
  'CONFLICT',
  'TEMPLATE_NOT_PUBLISHED',
  'UPLOAD_REJECTED',
  'TRANSITION_NOT_ALLOWED',
  'SELF_APPROVAL',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem+json. `detail` and `errors` must never echo request payloads (no PII). */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /** Failed checks for ALLOCATION_BLOCKED / SHIFT_GATE_BLOCKED (codes and reasons, never personal data). */
  checks: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type Problem = z.infer<typeof Problem>;

export const problemType = (code: ErrorCode): string =>
  `https://healthcare-hub.example/problems/${code.toLowerCase().replace(/_/g, '-')}`;
