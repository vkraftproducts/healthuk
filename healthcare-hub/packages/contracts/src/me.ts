import { z } from 'zod';
import { uuid } from './common.js';

export const MembershipDto = z.object({
  organisationId: uuid,
  organisationName: z.string(),
  /** null = all locations in the organisation */
  locationId: uuid.nullable(),
  roleKey: z.string(),
  roleName: z.string(),
});
export type MembershipDto = z.infer<typeof MembershipDto>;

/**
 * Something waiting for this person: work sent back to them with a reason, or a decision only
 * they can make. Links point at the record to act on.
 */
export const InboxItemDto = z.object({
  id: z.string(),
  kind: z.enum(['SENT_BACK', 'EXCEPTION_REQUEST', 'EXCEPTION_DECLINED']),
  title: z.string(),
  reasonText: z.string(),
  raisedAt: z.string(),
  link: z.object({
    type: z.enum(['REQUIREMENT', 'JOB']),
    id: z.string(),
    subjectType: z.string().optional(),
    subjectId: z.string().optional(),
    date: z.string().optional(),
  }),
});
export type InboxItemDto = z.infer<typeof InboxItemDto>;

export const MeResponse = z.object({
  user: z.object({ id: uuid, email: z.string(), displayName: z.string() }),
  memberships: z.array(MembershipDto),
  /** Permissions for the organisation selected via X-Org-Id (empty when none selected). */
  permissions: z.array(z.string()),
  activeOrganisationId: uuid.nullable(),
  mfa: z.object({ required: z.boolean(), satisfied: z.boolean() }),
});
export type MeResponse = z.infer<typeof MeResponse>;
