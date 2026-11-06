/** Words for event codes (EVT-01..04); never show the raw codes. */
export const EVENT_TYPE: Record<string, string> = {
  INCIDENT: 'Incident',
  ACCIDENT: 'Accident',
  NEAR_MISS: 'Near miss',
  SAFEGUARDING: 'Safeguarding concern',
  COMPLAINT: 'Complaint',
  COMPLIMENT: 'Compliment',
  DEFECT: 'Defect',
  HARASSMENT: 'Harassment',
  IRMER: 'Radiation (IR(ME)R) incident',
  DOLS: 'Deprivation of liberty (DoLS)',
};
export const PRIORITY: Record<string, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};
export const CATEGORY: Record<string, string> = {
  PATIENT_CARE: 'Patient care',
  MEDICATION: 'Medication',
  MOVING_AND_HANDLING: 'Moving and handling',
  VEHICLE_COLLISION: 'Vehicle collision',
  EQUIPMENT: 'Equipment',
  STAFF_INJURY: 'Staff injury',
  VIOLENCE_AGGRESSION: 'Violence or aggression',
  DATA_BREACH: 'Data breach',
  INFECTION: 'Infection',
  SAFEGUARDING: 'Safeguarding',
  HARASSMENT: 'Harassment',
  RADIATION: 'Radiation',
  DOLS: 'Deprivation of liberty',
  OTHER: 'Other',
};
export const CANDOUR_STEP: Record<string, string> = {
  TOLD_IN_PERSON: 'Told the person in person',
  APOLOGY: 'Apology given',
  WRITTEN_NOTICE: 'Written notice sent',
  SUPPORT_OFFERED: 'Support offered',
  FINDINGS_SHARED: 'Findings shared',
};
export const LEARNING_RESPONSE: Record<string, string> = {
  AFTER_ACTION_REVIEW: 'After action review',
  SWARM_HUDDLE: 'Swarm huddle',
  MDT_REVIEW: 'Multidisciplinary team review',
  THEMATIC_REVIEW: 'Thematic review',
  PSII: 'Patient safety incident investigation (PSII)',
  NO_FURTHER_RESPONSE: 'No further learning response',
};
export const EVENT_STAGE: Record<string, string> = {
  TRIAGE: 'Triage',
  PROTECT: 'Make safe',
  ASSESS: 'Assess reporting duties',
  INVESTIGATE: 'Investigate',
  RESPOND: 'Respond',
  ACTIONS: 'Actions',
  LEARNING_VERIFIED: 'Learning confirmed',
  CLOSED: 'Closed',
};
export const STAGES = Object.keys(EVENT_STAGE);
export const HARM: Record<string, string> = {
  NO_HARM: 'No harm',
  LOW: 'Low harm',
  MODERATE: 'Moderate harm',
  SEVERE: 'Severe harm',
  DEATH: 'Death',
};
export const DUTY_BODY: Record<string, string> = {
  CQC: 'CQC notification',
  SAFEGUARDING: 'Local authority safeguarding referral',
  RIDDOR: 'RIDDOR report to HSE',
  INSURER: 'Insurer',
  COMMISSIONER: 'Commissioner',
  ICO: 'ICO personal data breach report',
  LFPSE: 'LFPSE patient safety record',
  OTHER: 'Other',
};
export const CHANNEL: Record<string, string> = {
  PHONE: 'Phone',
  EMAIL: 'Email',
  LETTER: 'Letter',
  IN_PERSON: 'In person',
  WEB: 'Website',
  OTHER: 'Other',
};
export const OUTCOME: Record<string, string> = {
  UPHELD: 'Upheld',
  PARTLY_UPHELD: 'Partly upheld',
  NOT_UPHELD: 'Not upheld',
  WITHDRAWN: 'Withdrawn',
};
