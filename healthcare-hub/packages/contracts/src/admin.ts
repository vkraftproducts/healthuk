import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

const name = z.string().trim().min(1).max(200);
const code = z.string().regex(/^[A-Z0-9_-]{2,40}$/, 'Use 2-40 capital letters, digits, - or _');
const version = z.number().int().min(1);

const AddressSchema = z
  .object({
    line1: z.string().max(200).optional(),
    line2: z.string().max(200).optional(),
    town: z.string().max(100).optional(),
    postcode: z.string().max(12).optional(),
  })
  .strict();
/** CQC provider and location IDs, e.g. 1-101234567. */
const cqcId = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z-]{3,20}$/, 'Use the ID as shown by CQC, e.g. 1-101234567');
export const MainContact = z
  .object({
    name: z.string().trim().max(200).optional(),
    role: z.string().trim().max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: z.string().trim().max(30).optional(),
  })
  .strict();

export const OrganisationDto = z.object({
  id: uuid,
  name: z.string(),
  legalName: z.string().nullable(),
  tradingName: z.string().nullable(),
  cqcProviderId: z.string().nullable(),
  address: AddressSchema.partial(),
  mainContact: MainContact.partial(),
  sectorPacks: z.array(z.string()),
  regulator: z.string(),
  timezone: z.string(),
  version,
});
export type OrganisationDto = z.infer<typeof OrganisationDto>;
/** Sector packs an organisation can switch on. Dental and care home content needs validating. */
export const SECTOR_PACKS: Record<string, string> = {
  ambulance: 'Independent ambulance',
  dental: 'Dental practice',
  care_home: 'Care home',
};
export const OrganisationPatch = z
  .object({
    name: name.optional(),
    legalName: name.nullable().optional(),
    tradingName: name.nullable().optional(),
    cqcProviderId: cqcId.nullable().optional(),
    address: AddressSchema.optional(),
    mainContact: MainContact.optional(),
    sectorPacks: z
      .array(z.string().max(40))
      .max(10)
      .refine((p) => p.every((k) => k in SECTOR_PACKS), 'Unknown sector pack')
      .optional(),
  })
  .strict();

/** What kind of place a location is (workflow A2). */
export const LOCATION_KINDS = ['AMBULANCE_BASE', 'OFFICE_ONLY', 'PRACTICE', 'HOME'] as const;
export const LOCATION_KIND_LABELS: Record<(typeof LOCATION_KINDS)[number], string> = {
  AMBULANCE_BASE: 'Ambulance base',
  OFFICE_ONLY: 'Office only',
  PRACTICE: 'Practice',
  HOME: 'Care home',
};
export const LocationDto = z.object({
  id: uuid,
  name: z.string(),
  address: AddressSchema.partial(),
  type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']),
  kind: z.enum(LOCATION_KINDS).nullable(),
  cqcLocationId: z.string().nullable(),
  registered: z.boolean(),
  archived: z.boolean(),
  archiveReason: z.string().nullable(),
  version,
});
export type LocationDto = z.infer<typeof LocationDto>;
export const LocationCreate = z
  .object({
    name,
    address: AddressSchema.default({}),
    type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']).default('PATIENT_FACING'),
    kind: z.enum(LOCATION_KINDS).nullable().default(null),
    cqcLocationId: cqcId.nullable().default(null),
    registered: z.boolean().default(false),
  })
  .strict();
export const LocationPatch = z
  .object({
    name: name.optional(),
    address: AddressSchema.optional(),
    type: z.enum(['PATIENT_FACING', 'ADMIN_ONLY']).optional(),
    kind: z.enum(LOCATION_KINDS).nullable().optional(),
    cqcLocationId: cqcId.nullable().optional(),
    registered: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Required when archiving. */
    archiveReason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((p) => p.archived !== true || p.archiveReason !== undefined, {
    message: 'Say why the location is being archived',
    path: ['archiveReason'],
  });

export const ServiceDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  archived: z.boolean(),
  /** Locations that run this service. */
  locationIds: z.array(uuid),
  version,
});
export type ServiceDto = z.infer<typeof ServiceDto>;
export const ServiceCreate = z
  .object({ code, name, locationIds: z.array(uuid).max(100).default([]) })
  .strict();
export const ServicePatch = z
  .object({
    name: name.optional(),
    archived: z.boolean().optional(),
    locationIds: z.array(uuid).max(100).optional(),
  })
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

/** People directory entry for owner and assignee pickers (names and roles only). */
export const PersonDto = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  roleKeys: z.array(z.string()),
  roleNames: z.array(z.string()),
  locationIds: z.array(z.string().uuid()),
});
export type PersonDto = z.infer<typeof PersonDto>;
export const InviteUser = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    displayName: name,
    roleId: uuid,
    locationId: uuid.nullable().default(null),
    /** A3: link the new sign-in to an existing staff record. */
    staffId: uuid.optional(),
  })
  .strict();
export const AddMembership = z
  .object({ roleId: uuid, locationId: uuid.nullable().default(null) })
  .strict();
export const RevokeUser = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
/** Changes a membership's role or location: the old one ends now and a new one starts. */
export const MembershipChange = z
  .strictObject({
    roleId: uuid.optional(),
    locationId: uuid.nullable().optional(),
    reason: z.string().trim().min(5).max(500),
  })
  .refine(
    (c) => c.roleId !== undefined || c.locationId !== undefined,
    'Change the role or location',
  );
/** Role keys that are never offered or granted through the user screens. */
export const NON_INVITABLE_ROLE_KEYS = ['PLATFORM_SUPPORT'];

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
export const NOTIFICATION_EVENTS = [
  'EXPIRY_WARNING',
  'ACTION_OVERDUE',
  'INCIDENT_REPORTED',
  'BREACH_RECORDED',
  'POLICY_PUBLISHED',
  'AUDIT_OVERDUE',
] as const;
/** Kinds of item notification rules apply to (workflow A6). */
export const ITEM_KINDS = [
  'STAFF_REQUIREMENT',
  'VEHICLE_DOCUMENT',
  'EQUIPMENT_REGIME',
  'PREMISES_ITEM',
  'ACTION',
  'AUDIT',
  'INCIDENT_OBLIGATION',
  'DP_DEADLINE',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  STAFF_REQUIREMENT: 'Staff requirement',
  VEHICLE_DOCUMENT: 'Vehicle document',
  EQUIPMENT_REGIME: 'Equipment regime',
  PREMISES_ITEM: 'Premises item',
  ACTION: 'Action',
  AUDIT: 'Audit',
  INCIDENT_OBLIGATION: 'Incident obligation',
  DP_DEADLINE: 'Data protection deadline',
};
export const RECIPIENTS = ['OWNER', 'LEAD', 'REGISTERED_MANAGER'] as const;
export const RECIPIENT_LABELS: Record<(typeof RECIPIENTS)[number], string> = {
  OWNER: 'The owner',
  LEAD: 'Their lead',
  REGISTERED_MANAGER: 'The registered manager',
};
/** Product defaults, not CQC rules (A6). */
export const DEFAULT_WARNING_DAYS = [90, 60, 30, 14, 7];
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date');
export const ItemRule = z.strictObject({
  kind: z.enum(ITEM_KINDS),
  recipients: z.array(z.enum(RECIPIENTS)).min(1).max(3),
});
export const Deputy = z
  .strictObject({
    leadUserId: uuid,
    deputyUserId: uuid,
    from: isoDay,
    to: isoDay,
  })
  .refine((d) => d.to >= d.from, { message: 'Cover must end on or after it starts', path: ['to'] })
  .refine((d) => d.leadUserId !== d.deputyUserId, {
    message: 'A lead cannot deputise for themselves',
    path: ['deputyUserId'],
  });
export type Deputy = z.infer<typeof Deputy>;
export const DEFAULT_ITEM_RULES: z.infer<typeof ItemRule>[] = ITEM_KINDS.map((kind) => ({
  kind,
  recipients: ['OWNER', 'LEAD'],
}));

export const OrgSettings = z
  .object({
    /** Product defaults (not CQC rules). */
    warningDays: z.array(z.number().int().min(1).max(365)).min(1).max(8),
    dueSoonDays: z.number().int().min(1).max(365),
    emailReminders: z.boolean(),
    deputyEscalation: z.boolean(),
    /** Who is told about what, in addition to the record owner. */
    notificationRules: z
      .array(
        z.strictObject({
          event: z.enum(NOTIFICATION_EVENTS),
          roleKeys: z.array(z.string().max(40)).max(20),
          email: z.boolean(),
        }),
      )
      .max(20)
      .default([]),
    /** A6: who is told for each kind of item. */
    itemRules: z.array(ItemRule).max(ITEM_KINDS.length).default(DEFAULT_ITEM_RULES),
    /** A6: overdue this many days goes to the lead, then to the registered manager. */
    escalation: z
      .strictObject({
        leadAfterDays: z.number().int().min(0).max(90),
        managerAfterDays: z.number().int().min(1).max(180),
      })
      .refine((e) => e.managerAfterDays > e.leadAfterDays, {
        message: 'The registered manager step must come after the lead step',
        path: ['managerAfterDays'],
      })
      .default({ leadAfterDays: 1, managerAfterDays: 7 }),
    /** A6: deputies for each lead and the dates they cover. */
    deputies: z.array(Deputy).max(50).default([]),
    /** A6: in-app is always on; email optional; mobile push for crew. */
    channels: z
      .strictObject({ email: z.boolean(), push: z.boolean() })
      .default({ email: true, push: true }),
    /** H6: the named Freedom to Speak Up guardian. */
    speakUpGuardianUserId: uuid.nullable().default(null),
  })
  .strict();
export type OrgSettings = z.infer<typeof OrgSettings>;
export const SettingsResponse = z.object({ settings: OrgSettings, version });
/** Only the keys sent are changed; nothing missing is reset to a default. */
export const SettingsPatch = z
  .object({
    warningDays: OrgSettings.shape.warningDays,
    dueSoonDays: OrgSettings.shape.dueSoonDays,
    emailReminders: OrgSettings.shape.emailReminders,
    deputyEscalation: OrgSettings.shape.deputyEscalation,
    notificationRules: OrgSettings.shape.notificationRules.unwrap(),
    itemRules: OrgSettings.shape.itemRules.unwrap(),
    escalation: OrgSettings.shape.escalation.unwrap(),
    deputies: OrgSettings.shape.deputies.unwrap(),
    channels: OrgSettings.shape.channels.unwrap(),
    speakUpGuardianUserId: uuid.nullable(),
  })
  .partial()
  .strict();

// ---- break-glass -----------------------------------------------------------
export const SupportGrantDto = z.object({
  id: uuid,
  supportUserId: uuid,
  supportUserName: z.string().optional(),
  approvedBy: uuid,
  approvedByName: z.string().optional(),
  reason: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  /** Set when access was ended early (A4). */
  endedEarlyAt: isoDateTime.nullable().optional(),
  endedEarlyReason: z.string().nullable().optional(),
  active: z.boolean(),
});
export type SupportGrantDto = z.infer<typeof SupportGrantDto>;
/** A4: support access for 1 to 8 whole hours. */
export const SupportGrantCreate = z
  .object({
    supportUserEmail: z.string().trim().toLowerCase().email(),
    reason: z.string().trim().min(10).max(500),
    hours: z.number().int('Choose a whole number of hours').min(1).max(8),
  })
  .strict();
export const SupportGrantEnd = z.strictObject({ reason: z.string().trim().min(3).max(500) });
/** The banner every page shows while support access is active (A4). */
export const supportBannerText = (endsAt: string) =>
  `Support access is active until ${endsAt}. Every action is recorded in the audit log.`;
export type SettingsResponse = z.infer<typeof SettingsResponse>;
