import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

const name = z.string().trim().min(1).max(200);
const code = z.string().regex(/^[A-Z0-9_-]{2,40}$/, 'Use 2-40 capital letters, digits, - or _');
const version = z.number().int().min(1);

export const OrganisationDto = z.object({
  id: uuid,
  name: z.string(),
  sectorPacks: z.array(z.string()),
  regulator: z.string(),
  timezone: z.string(),
  version,
});
export type OrganisationDto = z.infer<typeof OrganisationDto>;
export const OrganisationPatch = z
  .object({ name: name.optional(), sectorPacks: z.array(z.string().max(40)).max(10).optional() })
  .strict();

const AddressSchema = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    town: z.string().max(100).optional(),
    postcode: z.string().max(12).optional(),
  })
  .strict();

export const LocationDto = z.object({
  id: uuid,
  name: z.string(),
  address: AddressSchema.partial(),
  type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']),
  registered: z.boolean(),
  archived: z.boolean(),
  version,
});
export type LocationDto = z.infer<typeof LocationDto>;
export const LocationCreate = z
  .object({
    name,
    address: AddressSchema.default({}),
    type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']).default('PATIENT_FACING'),
    registered: z.boolean().default(false),
  })
  .strict();
export const LocationPatch = z
  .object({
    name: name.optional(),
    address: AddressSchema.optional(),
    type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']).optional(),
    registered: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const ServiceDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  archived: z.boolean(),
  version,
});
export type ServiceDto = z.infer<typeof ServiceDto>;
export const ServiceCreate = z.object({ code, name }).strict();
export const ServicePatch = z
  .object({ name: name.optional(), archived: z.boolean().optional() })
  .strict();

export const ActivityDto = z.object({
  id: uuid,
  locationId: uuid,
  code: z.string(),
  name: z.string(),
  archived: z.boolean(),
  version,
});
export type ActivityDto = z.infer<typeof ActivityDto>;
export const ActivityCreate = z
  .object({ locationId: uuid, code, name: z.string().trim().min(1).max(300) })
  .strict();
export const ActivityPatch = z
  .object({ name: z.string().trim().min(1).max(300).optional(), archived: z.boolean().optional() })
  .strict();

// ---- users and roles -------------------------------------------------------
export const UserMembershipDto = z.object({
  membershipId: uuid,
  roleId: uuid,
  roleKey: z.string(),
  roleName: z.string(),
  locationId: uuid.nullable(),
  validFrom: isoDateTime,
  validTo: isoDateTime.nullable(),
});
export const AdminUserDto = z.object({
  id: uuid,
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'LEAVER']),
  lastLoginAt: isoDateTime.nullable(),
  memberships: z.array(UserMembershipDto),
});
export type AdminUserDto = z.infer<typeof AdminUserDto>;
export const InviteUser = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: name,
    roleId: uuid,
    locationId: uuid.nullable().default(null),
  })
  .strict();
export const AddMembership = z
  .object({ roleId: uuid, locationId: uuid.nullable().default(null) })
  .strict();
export const RevokeUser = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const RoleDto = z.object({
  id: uuid,
  key: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  derivedFrom: z.string().nullable(),
  permissions: z.array(z.string()),
  version,
});
export type RoleDto = z.infer<typeof RoleDto>;
export const RoleCreate = z
  .object({
    key: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'Use capital letters, digits and _'),
    name,
    derivedFrom: z
      .enum([
        'DISPATCHER',
        'CREW',
        'HR_LEAD',
        'FLEET_LEAD',
        'PREMISES_LEAD',
        'GOVERNANCE_LEAD',
        'AUDITOR',
      ])
      .nullable()
      .default(null),
    permissions: z.array(z.string()).max(200),
  })
  .strict();
export const RolePatch = z
  .object({ name: name.optional(), permissions: z.array(z.string()).max(200).optional() })
  .strict();
export const PermissionDto = z.object({ key: z.string(), description: z.string() });

// ---- settings --------------------------------------------------------------
export const OrgSettings = z
  .object({
    /** Product defaults (not CQC rules). */
    warningDays: z.array(z.number().int().min(1).max(365)).min(1).max(8),
    dueSoonDays: z.number().int().min(1).max(365),
    emailReminders: z.boolean(),
    deputyEscalation: z.boolean(),
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettings>;
export const SettingsResponse = z.object({ settings: OrgSettings, version });
export const SettingsPatch = OrgSettings.partial();

// ---- break-glass -----------------------------------------------------------
export const SupportGrantDto = z.object({
  id: uuid,
  supportUserId: uuid,
  approvedBy: uuid,
  reason: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  active: z.boolean(),
});
export type SupportGrantDto = z.infer<typeof SupportGrantDto>;
export const SupportGrantCreate = z
  .object({
    supportUserEmail: z.string().trim().toLowerCase().email(),
    reason: z.string().trim().min(10).max(500),
    hours: z.number().min(0.25).max(8),
  })
  .strict();
export type SettingsResponse = z.infer<typeof SettingsResponse>;
