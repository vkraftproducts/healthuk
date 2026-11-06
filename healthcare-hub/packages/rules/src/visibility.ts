import type { ReportId } from './reports.js';

/**
 * Which modules, dashboard figures and reports a person may see, from their permissions and the
 * organisation's sector packs. The API applies these to the data it returns (server-side); the
 * web uses the same functions so it never asks for data the role cannot read.
 */
export type SectorPackKey = 'ambulance' | 'dental' | 'care_home';

/**
 * Vehicles, the work planner, jobs and telematics are ambulance modules. Unknown packs (null, for
 * example platform support without a membership) keep everything visible; the server still checks.
 */
export const ambulanceOn = (packs: readonly string[] | null | undefined): boolean =>
  packs == null || packs.includes('ambulance');

export type DashboardModule = 'STAFF' | 'FLEET' | 'COMPLIANCE' | 'PREMISES' | 'EVENTS' | 'JOBS';

const MODULE_PERMISSIONS: Record<DashboardModule, readonly string[]> = {
  STAFF: ['staff.profile.view_basic'],
  FLEET: ['fleet.vehicle.view'],
  COMPLIANCE: ['compliance.requirement.view', 'compliance.audit.view', 'compliance.action.manage'],
  PREMISES: ['premises.item.view'],
  EVENTS: ['events.event.view'],
  JOBS: ['jobs.job.view'],
};
const AMBULANCE_MODULES: readonly DashboardModule[] = ['FLEET', 'JOBS'];

/** Dashboard modules (rows, tiles and module status) this person may see. */
export function visibleDashboardModules(
  permissions: Iterable<string>,
  packs: readonly string[] | null | undefined,
): DashboardModule[] {
  const held = new Set(permissions);
  return (Object.keys(MODULE_PERMISSIONS) as DashboardModule[]).filter(
    (m) =>
      MODULE_PERMISSIONS[m].some((p) => held.has(p)) &&
      (ambulanceOn(packs) || !AMBULANCE_MODULES.includes(m)),
  );
}

export type DashboardTileKey =
  'overdue' | 'dueSoon' | 'blockedVehicles' | 'jobsToday' | 'unverified' | 'auditsOverdue';

/**
 * Tiles shown for the visible modules: blocked vehicles needs fleet, jobs today needs jobs.
 * Dental and care-home organisations (no ambulance pack) get Overdue tasks, Due in 30 days,
 * Staff unverified and Audits overdue instead (WORKFLOWS M).
 */
export function visibleDashboardTiles(
  modules: readonly DashboardModule[],
  packs?: readonly string[] | null,
): DashboardTileKey[] {
  const out: DashboardTileKey[] = [];
  if (modules.some((m) => m !== 'JOBS')) out.push('overdue', 'dueSoon');
  if (!ambulanceOn(packs)) {
    if (modules.includes('STAFF')) out.push('unverified');
    if (modules.includes('COMPLIANCE')) out.push('auditsOverdue');
    return out;
  }
  if (modules.includes('FLEET')) out.push('blockedVehicles');
  if (modules.includes('JOBS')) out.push('jobsToday');
  return out;
}

/** Plain-words label for each dashboard tile; the count always equals the rows it opens. */
export const DASHBOARD_TILE_LABEL: Record<DashboardTileKey, string> = {
  overdue: 'Overdue tasks',
  dueSoon: 'Due in 30 days',
  blockedVehicles: 'Blocked vehicles',
  jobsToday: 'Jobs today',
  unverified: 'Staff unverified',
  auditsOverdue: 'Audits overdue',
};

/**
 * Where a person lands after signing in (WORKFLOWS A1): the inspection view for auditors, the
 * dashboard for managers and leads, the work planner for dispatchers, My work for everyone else.
 */
export function homePathFor(
  permissions: Iterable<string>,
  packs?: readonly string[] | null,
): '/inspection' | '/' | '/planner' | '/me' {
  const held = new Set(permissions);
  if (held.has('inspection.view') && !held.has('compliance.audit.run')) return '/inspection';
  const dispatcher = held.has('jobs.allocate') && !held.has('compliance.requirement.manage');
  if (dispatcher && ambulanceOn(packs)) return '/planner';
  if (held.has('dashboard.view')) return '/';
  return '/me';
}

/** What each report shows, and so which permission it needs (any of). */
export const REPORT_ACCESS: Record<ReportId, readonly string[]> = {
  WORKFORCE_READINESS: ['staff.profile.view_basic'],
  SUPERVISION: ['staff.profile.view_basic'],
  FLEET: ['fleet.vehicle.view'],
  AUDITS_ACTIONS: ['compliance.audit.view', 'compliance.action.manage'],
  EVENTS: ['events.event.view'],
  POLICY_ACK: ['compliance.policy.manage', 'compliance.audit.view', 'staff.profile.view_basic'],
  PREMISES: ['premises.item.view'],
  JOURNEYS: ['jobs.job.view'],
  NHS_KPI: ['compliance.registration.manage', 'compliance.audit.view'],
};
const AMBULANCE_REPORTS: readonly ReportId[] = ['FLEET', 'JOURNEYS'];

/** A report may be run only by a role that can see what it is about, in a sector that has it. */
export function canRunReport(
  id: ReportId,
  permissions: Iterable<string>,
  packs: readonly string[] | null | undefined,
): boolean {
  const held = new Set(permissions);
  if (!held.has('reports.view')) return false;
  if (!ambulanceOn(packs) && AMBULANCE_REPORTS.includes(id)) return false;
  return REPORT_ACCESS[id].some((p) => held.has(p));
}

/** Staff roles offered for each sector pack; OTHER and MANAGER are always offered. */
export const SECTOR_STAFF_ROLES: Record<SectorPackKey, readonly string[]> = {
  ambulance: [
    'DRIVER',
    'CARE_ASSISTANT',
    'EMERGENCY_CARE_ASSISTANT',
    'TECHNICIAN',
    'PARAMEDIC',
    'NURSE',
    'CONTROL_ROOM',
  ],
  dental: ['DENTIST', 'DENTAL_NURSE', 'RECEPTIONIST'],
  care_home: ['CARE_ASSISTANT', 'SENIOR_CARER', 'NURSE', 'ACTIVITIES_COORDINATOR'],
};
const ALWAYS: readonly string[] = ['MANAGER', 'OTHER'];

/** Roles that make sense for the organisation. With no pack known, every role is offered. */
export function staffRolesFor(packs: readonly string[] | null | undefined): string[] {
  if (packs == null || packs.length === 0)
    return [...new Set([...Object.values(SECTOR_STAFF_ROLES).flat(), ...ALWAYS])];
  const roles = packs.flatMap((p) => SECTOR_STAFF_ROLES[p as SectorPackKey] ?? []);
  return [...new Set([...roles, ...ALWAYS])];
}
