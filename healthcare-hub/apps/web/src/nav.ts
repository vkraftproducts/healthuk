export interface NavItem {
  to: string;
  label: string;
  /** Shown when the user holds any of these permissions; empty means every member. */
  anyOf: readonly string[];
  /** Only for organisations with this sector pack (vehicles and the planner are ambulance). */
  pack?: 'ambulance';
}

/**
 * Left navigation from the wireframes (PRD §3), filtered by role. Hiding is cosmetic: every page
 * and endpoint is still checked by the server. To add a page, add one entry here and its
 * component to PAGES in App.tsx; detail pages under it inherit its permission check.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', anyOf: [] },
  { to: '/inspection', label: 'Inspection', anyOf: ['inspection.view'] },
  { to: '/me', label: 'My record', anyOf: ['staff.self.view'] },
  { to: '/report', label: 'Report an incident', anyOf: ['events.event.report'] },
  {
    to: '/alerts',
    label: 'Alerts',
    anyOf: [
      'compliance.requirement.view',
      'compliance.action.manage',
      'compliance.audit.run',
      'events.event.manage',
      'privacy.manage',
      'jobs.allocate',
      'fleet.defect.manage',
    ],
  },
  {
    to: '/staff',
    label: 'Staff',
    anyOf: ['staff.profile.view_basic', 'staff.profile.view_clearance'],
  },
  {
    to: '/vehicles',
    label: 'Vehicles and assets',
    // Crew submit expenses and vehicle checks in the crew app; the web page needs the register.
    anyOf: ['fleet.vehicle.view'],
    pack: 'ambulance',
  },
  {
    to: '/compliance',
    label: 'Compliance',
    anyOf: [
      'compliance.evidence.verify',
      'compliance.audit.view',
      'compliance.action.manage',
      'compliance.policy.manage',
      'compliance.policy.acknowledge',
      'compliance.risk.manage',
      'compliance.registration.manage',
      'events.event.view',
      'events.event.manage',
      'governance.meeting.manage',
    ],
  },
  { to: '/premises', label: 'Premises safety', anyOf: ['premises.item.view'] },
  { to: '/planner', label: 'Work planner', anyOf: ['jobs.job.view'], pack: 'ambulance' },
  { to: '/reports', label: 'Reports', anyOf: ['reports.view'] },
  {
    to: '/speak-up',
    label: 'Speak up',
    anyOf: ['speakup.raise', 'speakup.manage', 'harassment.manage', 'reports.view'],
  },
  {
    to: '/settings',
    label: 'Settings',
    anyOf: [
      'admin.org.manage',
      'admin.users.manage',
      'admin.roles.manage',
      'admin.settings.manage',
      'admin.requirements.publish',
      'admin.audit.view',
      'admin.support.approve',
      'admin.import.manage',
      'privacy.manage',
    ],
  },
];

/**
 * Whether the item is for this person here. `packs` are the organisation's sector packs; when they
 * are not known (older server, support access) nothing is hidden for the sector.
 */
export const canSee = (
  item: NavItem,
  permissions: readonly string[],
  packs?: readonly string[] | null,
) =>
  (item.anyOf.length === 0 || item.anyOf.some((p) => permissions.includes(p))) &&
  (!item.pack || packs == null || packs.includes(item.pack));

/** The navigation item a path belongs to ("/staff/123" belongs to "/staff"). */
export const navItemFor = (path: string) =>
  NAV_ITEMS.filter((n) => n.to !== '/' && (path === n.to || path.startsWith(`${n.to}/`)))[0];
