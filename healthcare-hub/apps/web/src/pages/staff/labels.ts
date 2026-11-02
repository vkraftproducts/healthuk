/** Plain-English labels for staff enums (UI_SPEC: no raw codes in the interface). */
export const ROLE_LABEL: Record<string, string> = {
  DRIVER: 'Driver',
  CARE_ASSISTANT: 'Care assistant',
  EMERGENCY_CARE_ASSISTANT: 'Emergency care assistant',
  TECHNICIAN: 'Technician',
  PARAMEDIC: 'Paramedic',
  NURSE: 'Nurse',
  CONTROL_ROOM: 'Control room',
  MANAGER: 'Manager',
  OTHER: 'Other',
};
export const LIFECYCLE_LABEL: Record<string, string> = {
  CANDIDATE: 'Candidate',
  CHECKS_IN_PROGRESS: 'Checks in progress',
  READY_FOR_REVIEW: 'Ready for review',
  APPROVED_FOR_ROLE: 'Approved for role',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  LEAVER: 'Leaver',
};
export const RESTRICTION_LABEL: Record<string, string> = {
  NO_DRIVING: 'No driving',
  NO_BLUE_LIGHT: 'No blue-light driving',
  NO_LONE_WORKING: 'No lone working',
  NO_PATIENT_CONTACT: 'No patient contact',
  NO_CHILDREN: 'No work with children',
  NO_NIGHT_SHIFTS: 'No night shifts',
  OTHER: 'Other restriction',
};
/** "Policy review date" is not an expiry (HR-02); label the date by what it is. */
export const DATE_LABEL: Record<string, string> = {
  DUE: 'Due',
  EXPIRY: 'Expiry',
  REVIEW: 'Policy review date',
};
export const list = (xs: readonly string[], map: Record<string, string>) =>
  xs.length ? xs.map((x) => map[x] ?? x).join(', ') : 'None';
