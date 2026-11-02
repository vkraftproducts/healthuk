import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';

/** Reports (PRD 4.10). Definitions travel with every report so a number is never shown without its rule. */
export const ReportId = z.enum([
  'WORKFORCE_READINESS',
  'SUPERVISION',
  'FLEET',
  'AUDITS_ACTIONS',
  'EVENTS',
  'POLICY_ACK',
  'PREMISES',
  'JOURNEYS',
]);
export type ReportIdT = z.infer<typeof ReportId>;

const Measure = z.object({
  key: z.string(),
  label: z.string(),
  numerator: z.string().nullable(),
  denominator: z.string(),
  period: z.string(),
  inclusion: z.string(),
});
export const ReportDefinitionDto = z.object({
  id: ReportId,
  title: z.string(),
  summary: z.string(),
  measures: z.array(Measure),
});
export type ReportDefinitionDto = z.infer<typeof ReportDefinitionDto>;

export const ReportQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    locationId: uuid.optional(),
  })
  .refine((q) => !q.from || !q.to || q.to >= q.from, 'to must not be before from');

export const ReportDataDto = z.object({
  id: ReportId,
  title: z.string(),
  summary: z.string(),
  period: z.object({ from: isoDate, to: isoDate }),
  locationId: uuid.nullable(),
  generatedAt: isoDateTime,
  measures: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.number().nullable(),
      unit: z.enum(['PERCENT', 'COUNT']),
      numerator: z.number().nullable(),
      denominator: z.number().nullable(),
      definition: Measure,
    }),
  ),
  tables: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
    }),
  ),
  /** Internal measures only (non-negotiable 9). */
  notice: z.literal('Internal measure — not a CQC rating'),
});
export type ReportDataDto = z.infer<typeof ReportDataDto>;

export const ManagementPackInput = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM'),
  locationId: uuid.optional(),
});
