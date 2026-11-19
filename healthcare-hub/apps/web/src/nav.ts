export interface NavItem {
  to: string;
  label: string;
  /** Shown when the user holds any of these permissions; empty means every member. */
  anyOf: readonly string[];
  /** Only for organisations with this sector pack (vehicles and the planner are ambulance). */
  pack?: 'ambulance';
  /**
   * Nested under a module in the v36 IA — still routable for deep links, but not a
   * top-level side-nav item. `parent` is the module path used for active highlighting.
   */
  nested?: boolean;
  parent?: string;
  /** Optional query (e.g. tab) for in-module deep links matching v36 MODS. */
  search?: Record<string, string>;
  /**
   * In-page tabs / deep links under this module (v36). The side nav is flat —
   * only the eight modules appear in the sider; these are not nested menu items.
   */
  children?: readonly NavItem[];
}

/**
 * Flat top-level side navigation matching the v36 eight modules.
 * Sub-screens (Overview / My work, Staff directory, …) are in-page tabs.
 * Hiding is cosmetic: every page and endpoint is still checked by the server.
 */
export const NAV_MODULES: readonly NavItem[] = [
  {
    to: '/',
    label: 'Dashboard',
    anyOf: [],
    children: [
      { to: '/', label: 'Overview', anyOf: [], search: { tab: 'overview' } },
      { to: '/', label: 'My work', anyOf: [], search: { tab: 'work' } },
    ],
  },
  {
    to: '/staff',
    label: 'Staff',
    anyOf: ['staff.profile.view_basic', 'staff.profile.view_clearance', 'staff.self.view'],
    children: [
      {
        to: '/staff',
        label: 'Directory',
        anyOf: ['staff.profile.view_basic', 'staff.profile.view_clearance'],
        search: { tab: 'register' },
      },
      { to: '/me', label: 'My record', anyOf: ['staff.self.view'] },
      // v36 (17 Nov 2026): rota, open shifts, swaps, hours and patterns
      { to: '/staff', label: 'Shifts', anyOf: ['jobs.job.view', 'crew.today.view'], search: { tab: 'shifts' } },
      {
        to: '/staff',
        label: 'Evidence review',
        anyOf: ['compliance.evidence.verify'],
        search: { tab: 'review' },
      },
      {
        to: '/staff',
        label: 'Training',
        anyOf: ['staff.profile.view_basic', 'staff.profile.view_clearance'],
        search: { tab: 'matrix' },
      },
      {
        to: '/staff',
        label: 'Supervision',
        anyOf: ['staff.profile.view_basic', 'staff.profile.view_clearance'],
        search: { tab: 'supervision' },
      },
    ],
  },
  {
    to: '/vehicles',
    label: 'Vehicles and assets',
    anyOf: ['fleet.vehicle.view', 'fleet.expense.approve'],
    pack: 'ambulance',
    children: [
      {
        to: '/vehicles',
        label: 'Fleet',
        anyOf: ['fleet.vehicle.view'],
        search: { tab: 'vehicles' },
      },
      {
        to: '/vehicles',
        label: 'Daily checks',
        anyOf: ['fleet.vehicle.view'],
        search: { tab: 'checks' },
      },
      {
        to: '/vehicles',
        label: 'Defects',
        anyOf: ['fleet.vehicle.view', 'fleet.defect.manage'],
        search: { tab: 'defects' },
      },
      {
        to: '/vehicles',
        label: 'Equipment',
        anyOf: ['fleet.vehicle.view'],
        search: { tab: 'equipment' },
      },
    ],
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
      'events.event.report',
      'governance.meeting.manage',
      'governance.fit_proper.manage',
      'speakup.raise',
      'speakup.manage',
      'harassment.manage',
      'privacy.manage',
    ],
    children: [
      {
        to: '/compliance',
        label: 'Audits & actions',
        anyOf: ['compliance.audit.view', 'compliance.action.manage'],
        search: { tab: 'audits' },
      },
      {
        to: '/compliance',
        label: 'Risks',
        anyOf: ['compliance.risk.manage'],
        search: { tab: 'risks' },
      },
      {
        to: '/compliance',
        label: 'Incidents',
        anyOf: ['events.event.view', 'events.event.manage', 'events.event.report'],
        search: { tab: 'events' },
      },
      {
        to: '/speak-up',
        label: 'Speak up',
        anyOf: ['speakup.raise', 'speakup.manage', 'harassment.manage'],
      },
      {
        to: '/compliance',
        label: 'Policies',
        anyOf: ['compliance.policy.manage', 'compliance.policy.acknowledge'],
        search: { tab: 'policies' },
      },
      {
        to: '/compliance',
        label: 'Governance',
        anyOf: ['governance.meeting.manage', 'governance.fit_proper.manage'],
        search: { tab: 'meetings' },
      },
    ],
  },
  {
    to: '/premises',
    label: 'Premises safety',
    anyOf: ['premises.item.view'],
    children: [
      { to: '/premises', label: 'Premises checks', anyOf: ['premises.item.view'] },
      {
        to: '/premises',
        label: 'Contractors & visitors',
        anyOf: ['premises.item.view'],
        search: { tab: 'contractors' },
      },
    ],
  },
  {
    to: '/planner',
    label: 'Work planner',
    anyOf: ['jobs.job.view'],
    pack: 'ambulance',
    children: [{ to: '/planner', label: 'Planner', anyOf: ['jobs.job.view'] }],
  },
  {
    to: '/reports',
    label: 'Reports',
    anyOf: ['reports.view', 'inspection.view', 'admin.audit.view'],
    children: [
      {
        to: '/reports',
        label: 'Standard reports',
        anyOf: ['reports.view'],
        search: { tab: 'standard' },
      },
      {
        to: '/inspection',
        label: 'Inspection view',
        anyOf: ['inspection.view'],
      },
      {
        to: '/reports',
        label: 'Audit trail',
        anyOf: ['admin.audit.view'],
        search: { tab: 'audit' },
      },
    ],
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
    children: [
      {
        to: '/settings',
        label: 'Users & access',
        anyOf: ['admin.users.manage', 'admin.roles.manage'],
        search: { tab: 'users' },
      },
      {
        to: '/settings',
        label: 'Escalation & deputies',
        anyOf: ['admin.settings.manage'],
        search: { tab: 'escalation' },
      },
      {
        to: '/settings',
        label: 'Organisation',
        anyOf: ['admin.org.manage'],
        search: { tab: 'organisation' },
      },
    ],
  },
];

/**
 * Nested routes kept for bookmarks and role home redirects. They appear as tabs inside
 * their parent module, not only in the side nav.
 */
export const NESTED_ROUTES: readonly NavItem[] = [
  {
    to: '/me',
    label: 'My record',
    anyOf: ['staff.self.view'],
    nested: true,
    parent: '/staff',
  },
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
      'dashboard.view',
    ],
    nested: true,
    parent: '/',
  },
  {
    to: '/speak-up',
    label: 'Speak up',
    anyOf: ['speakup.raise', 'speakup.manage', 'harassment.manage', 'reports.view'],
    nested: true,
    parent: '/compliance',
  },
  {
    to: '/report',
    label: 'Report an incident',
    anyOf: ['events.event.report'],
    nested: true,
    parent: '/compliance',
  },
  {
    to: '/inspection',
    label: 'Inspection',
    anyOf: ['inspection.view'],
    nested: true,
    parent: '/reports',
  },
];

/** All routable nav items (modules + nested). */
export const NAV_ITEMS: readonly NavItem[] = [...NAV_MODULES, ...NESTED_ROUTES];

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
export const navItemFor = (path: string) => {
  const nested = NESTED_ROUTES.find((n) => path === n.to || path.startsWith(`${n.to}/`));
  if (nested) return nested;
  return (
    NAV_MODULES.filter((n) => n.to !== '/' && (path === n.to || path.startsWith(`${n.to}/`)))[0] ??
    NAV_MODULES.find((n) => n.to === '/')
  );
};

/** Module path used to highlight the side nav for the current URL. */
export const modulePathFor = (path: string) => {
  const item = navItemFor(path);
  if (!item) return '/';
  if (item.nested && item.parent) return item.parent;
  if (path === '/' || path.startsWith('/?')) return '/';
  return item.to;
};
