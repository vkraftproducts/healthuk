import { z } from 'zod';
import { SupportGrantDto } from './admin.js';
import { BreachDto, RetentionReviewDto, SubjectRequestSourcesDto } from './privacy.js';
import { AlertCountDto, TemplateDto } from './requirements.js';
import { SpeakUpDto, SpeakUpGuardianDto, SpeakUpProgressDto, SpeakUpThemesDto } from './speakup.js';
import {
  ReadinessWindowDto,
  RecordAckDto,
  SupervisionBookingDto,
  TrainingCourseDto,
} from './staff.js';

const list = <T extends z.ZodType>(t: T) => z.object({ data: z.array(t) });
const csv = z.string();

/**
 * Endpoints added by the workflow pass for A, B, C, K, H6, L2, L4 and F0. Spread into `routes`
 * (routes.ts) so OpenAPI lists them.
 */
export const peopleRoutes = {
  // ---- A4, A7: support access and the alert bell --------------------------------------------
  supportGrantEnd: {
    method: 'post',
    path: '/admin/support-access-grants/{id}/end',
    summary: 'End a support access grant early, with a reason (never by the support user)',
    response: SupportGrantDto,
  },
  alertCount: {
    method: 'get',
    path: '/alerts/count',
    summary: 'Open, unsnoozed alert centre items for the bell, and how many are critical',
    response: AlertCountDto,
  },
  // ---- L4: audit log export -------------------------------------------------------------------
  auditLogExport: {
    method: 'get',
    path: '/audit-log/export',
    summary: 'CSV of the filtered audit log (at most 5000 rows); the export is itself audited',
    response: csv,
  },
  // ---- B, C: staff, training and supervision ---------------------------------------------------
  staffReadinessWindow: {
    method: 'get',
    path: '/staff/{id}/readiness-window',
    summary: 'Readiness of a member of staff for a role across a time window, with reasons',
    response: ReadinessWindowDto,
  },
  trainingMatrixExport: {
    method: 'get',
    path: '/staff/training-matrix/export',
    summary: 'CSV of the training matrix with the words shown on screen',
    response: csv,
  },
  trainingCourseList: {
    method: 'get',
    path: '/training-courses',
    summary: 'Training course catalogue with interval, basis and whether it is deployment-critical',
    response: list(TrainingCourseDto),
  },
  trainingCourseAdd: {
    method: 'post',
    path: '/training-courses',
    summary: 'Add a course to the catalogue',
    response: TrainingCourseDto,
  },
  trainingCourseRetire: {
    method: 'post',
    path: '/training-courses/{id}/retire',
    summary: 'Retire a course with a reason (If-Match); existing records are kept',
    response: TrainingCourseDto,
  },
  trainingRecordsBulk: {
    method: 'post',
    path: '/training-records/bulk',
    summary: 'Record one training session for several staff; each record is unverified',
    response: z.object({ created: z.number().int(), recordIds: z.array(z.string()) }),
  },
  supervisionBookingList: {
    method: 'get',
    path: '/supervision-bookings',
    summary: 'Supervision bookings: HR sees all; others see their own and those they supervise',
    response: list(SupervisionBookingDto),
  },
  supervisionBook: {
    method: 'post',
    path: '/staff/{id}/supervision-bookings',
    summary: 'Book a supervision for a member of staff',
    response: SupervisionBookingDto,
  },
  supervisionBookingClose: {
    method: 'post',
    path: '/supervision-bookings/{id}/close',
    summary: 'Mark a booking held (with its record), cancelled or missed, optionally rebooking',
    response: SupervisionBookingDto,
  },
  staffRecordAcks: {
    method: 'get',
    path: '/staff-records/{id}/acknowledgements',
    summary: 'Acknowledgements and comments on a supervision or appraisal record',
    response: list(RecordAckDto),
  },
  staffRecordAcknowledge: {
    method: 'post',
    path: '/staff-records/{id}/acknowledgements',
    summary: 'The member of staff agrees with, or comments on, their own record',
    response: RecordAckDto,
  },
  // ---- K: requirement library ----------------------------------------------------------------
  requirementTemplateRetire: {
    method: 'post',
    path: '/requirements/templates/{id}/retire',
    summary: 'Retire a requirement template with a reason; history is kept',
    response: TemplateDto,
  },
  // ---- L2: data protection -------------------------------------------------------------------
  subjectRequestSources: {
    method: 'get',
    path: '/subject-requests/{id}/sources',
    summary: 'Where the requester appears: counts by record kind, to help gather the response',
    response: SubjectRequestSourcesDto,
  },
  breachContain: {
    method: 'post',
    path: '/breaches/{id}/containment',
    summary: 'Record when and how a breach was contained and how many people it affects',
    response: BreachDto,
  },
  retentionReviewList: {
    method: 'get',
    path: '/retention-reviews',
    summary: 'Retention reviews with frozen candidate counts and decisions',
    response: list(RetentionReviewDto),
  },
  retentionReviewOpen: {
    method: 'post',
    path: '/retention-reviews',
    summary: 'Open the monthly review for an approved retention rule',
    response: RetentionReviewDto,
  },
  retentionReviewDecide: {
    method: 'post',
    path: '/retention-reviews/{id}/decisions',
    summary: 'Keep (with reason and date) or act on the candidates; decisions cannot be changed',
    response: RetentionReviewDto,
  },
  retentionReviewClose: {
    method: 'post',
    path: '/retention-reviews/{id}/close',
    summary: 'Close a review once every candidate has a decision',
    response: RetentionReviewDto,
  },
  // ---- H6: speak up --------------------------------------------------------------------------
  speakUpProgress: {
    method: 'get',
    path: '/speak-up/progress',
    summary: 'Status and feedback for an anonymous concern, found by its progress code',
    response: SpeakUpProgressDto,
  },
  speakUpGuardian: {
    method: 'get',
    path: '/speak-up/guardian',
    summary: 'Name of the Freedom to Speak Up guardian, if one is set',
    response: SpeakUpGuardianDto,
  },
  speakUpThemes: {
    method: 'get',
    path: '/speak-up/themes',
    summary: 'Concern themes for a quarter; counts under 3 are hidden',
    response: SpeakUpThemesDto,
  },
  speakUpProgressFeedback: {
    method: 'post',
    path: '/speak-up/{id}/progress-feedback',
    summary: 'Write feedback an anonymous raiser can read with their progress code',
    response: SpeakUpDto,
  },
} as const;
