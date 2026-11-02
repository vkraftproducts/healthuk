/** Staff lifecycle (PRD §4.3, HR-01). Only HR/management transition; every move needs a reason. */
export type StaffLifecycle =
  | 'CANDIDATE'
  | 'CHECKS_IN_PROGRESS'
  | 'READY_FOR_REVIEW'
  | 'APPROVED_FOR_ROLE'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'LEAVER';

const NEXT: Record<StaffLifecycle, readonly StaffLifecycle[]> = {
  CANDIDATE: ['CHECKS_IN_PROGRESS', 'LEAVER'],
  CHECKS_IN_PROGRESS: ['READY_FOR_REVIEW', 'LEAVER'],
  READY_FOR_REVIEW: ['APPROVED_FOR_ROLE', 'CHECKS_IN_PROGRESS', 'LEAVER'],
  APPROVED_FOR_ROLE: ['ACTIVE', 'CHECKS_IN_PROGRESS', 'LEAVER'],
  ACTIVE: ['SUSPENDED', 'LEAVER'],
  SUSPENDED: ['ACTIVE', 'LEAVER'],
  LEAVER: [],
};

export type TransitionRefusal = 'NOT_ALLOWED' | 'NO_ROLE_APPROVED' | 'SELF_APPROVAL';

export interface TransitionInput {
  from: StaffLifecycle;
  to: StaffLifecycle;
  /** Active (unrevoked) role approvals held by the staff member. */
  approvedRoles: number;
  /** The person making the change is the staff member themselves. */
  actorIsSubject: boolean;
}

/** Returns null when the transition is permitted, otherwise why it is refused. */
export function checkStaffTransition(i: TransitionInput): TransitionRefusal | null {
  if (!NEXT[i.from].includes(i.to)) return 'NOT_ALLOWED';
  if (i.actorIsSubject) return 'SELF_APPROVAL';
  if ((i.to === 'APPROVED_FOR_ROLE' || i.to === 'ACTIVE') && i.approvedRoles === 0)
    return 'NO_ROLE_APPROVED';
  return null;
}

export const allowedTransitions = (from: StaffLifecycle): readonly StaffLifecycle[] => NEXT[from];

/** Maps the stored lifecycle onto the readiness input (anything before ACTIVE is onboarding). */
export function readinessLifecycle(
  s: StaffLifecycle,
): 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED' | 'LEAVER' {
  if (s === 'ACTIVE' || s === 'SUSPENDED' || s === 'LEAVER') return s;
  return 'ONBOARDING';
}

/**
 * UK driving licence entitlement: a held category covers the categories listed for it.
 * Simplified table for the vehicles an ambulance service runs (B cars/vans, C1 up to 7.5t,
 * D1 minibuses); restriction codes are reviewed separately by a person.
 */
const COVERS: Record<string, readonly string[]> = {
  B: ['B'],
  BE: ['B', 'BE'],
  C1: ['C1'],
  C1E: ['C1', 'C1E', 'BE'],
  C: ['C', 'C1'],
  CE: ['C', 'C1', 'CE', 'C1E', 'BE'],
  D1: ['D1'],
  D1E: ['D1', 'D1E', 'BE'],
  D: ['D', 'D1'],
  DE: ['D', 'D1', 'DE', 'D1E', 'BE'],
};

export function licenceCovers(held: readonly string[], required: string): boolean {
  return held.some((h) => (COVERS[h] ?? [h]).includes(required));
}
