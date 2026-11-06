import { z } from 'zod';
import { uuid } from './common.js';

export const MembershipDto = z.object({
  organisationId: uuid,
  organisationName: z.string(),
  /** null = all locations in the organisation */
  locationId: uuid.nullable(),
  roleKey: z.string(),
  roleName: z.string(),
  /** The organisation's sector packs, so the web can hide modules the sector does not use. */
  sectorPacks: z.array(z.string()).optional(),
});
export type MembershipDto = z.infer<typeof MembershipDto>;

export const MeResponse = z.object({
  user: z.object({ id: uuid, email: z.string(), displayName: z.string() }),
  memberships: z.array(MembershipDto),
  /** Permissions for the organisation selected via X-Org-Id (empty when none selected). */
  permissions: z.array(z.string()),
  activeOrganisationId: uuid.nullable(),
  mfa: z.object({ required: z.boolean(), satisfied: z.boolean() }),
  /** A4: present while the caller is using a support access grant. */
  support: z.object({ endsAt: z.string() }).nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponse>;
