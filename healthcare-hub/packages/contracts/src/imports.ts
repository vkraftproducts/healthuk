import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

/** CSV import and compliance workbook staging (PRD 4.12, INT-01, MIG-01..03). */
export const MAX_IMPORT_ROWS = 5000;
const csv = z.string().min(1).max(900_000, 'Split files over about 900 KB');
const filename = z.string().trim().min(1).max(200);

export const ImportCreate = z.strictObject({
  kind: z.enum(['STAFF', 'VEHICLES']),
  filename,
  csv,
});

/** Which column holds what; header names as they appear in the sheet. */
export const WorkbookStageInput = z.strictObject({
  filename,
  sheet: z.string().trim().min(1).max(100),
  csv,
  columns: z.strictObject({
    code: z.string().trim().min(1).max(100),
    text: z.string().trim().min(1).max(100),
    status: z.string().trim().min(1).max(100).optional(),
    kloe: z.string().trim().min(1).max(100).optional(),
  }),
});

export const ImportBatchDto = z.object({
  id: uuid,
  code: z.string(),
  kind: z.enum(['STAFF', 'VEHICLES', 'WORKBOOK']),
  filename: z.string(),
  sheet: z.string().nullable(),
  status: z.enum(['PREVIEWED', 'COMMITTED', 'PARTIAL', 'ROLLED_BACK', 'DISCARDED']),
  rowCount: z.number(),
  validCount: z.number(),
  errorCount: z.number(),
  duplicateCount: z.number(),
  importedCount: z.number(),
  createdAt: isoDateTime,
  committedAt: isoDateTime.nullable(),
  rolledBackAt: isoDateTime.nullable(),
  version: z.number(),
});
export type ImportBatchDto = z.infer<typeof ImportBatchDto>;

export const ImportRowDto = z.object({
  rowNo: z.number(),
  status: z.enum(['VALID', 'ERROR', 'DUPLICATE', 'IMPORTED', 'FAILED', 'ROLLED_BACK', 'KEPT']),
  data: z.record(z.string(), z.unknown()),
  errors: z.array(z.string()),
  duplicateOf: z.string().nullable(),
  entityId: uuid.nullable(),
  resultDetail: z.string().nullable(),
});
export const ImportDetailDto = ImportBatchDto.extend({ rows: z.array(ImportRowDto) });
export type ImportDetailDto = z.infer<typeof ImportDetailDto>;

export const WorkbookClassification = z.enum([
  'SHARED',
  'AMBULANCE',
  'DENTAL',
  'CARE_HOME',
  'GP',
  'OUT_OF_SCOPE',
]);
export const WorkbookItemDto = z.object({
  id: uuid,
  batchId: uuid,
  sheet: z.string(),
  rowNo: z.number(),
  promptCode: z.string().nullable(),
  kind: z.enum(['HEADER', 'PROMPT']),
  text: z.string(),
  placeholders: z.array(z.string()),
  sourceStatus: z.string().nullable(),
  legacyKloe: z.array(z.string()),
  classification: WorkbookClassification.nullable(),
  mappingStatus: z.enum(['UNMAPPED', 'PROPOSED', 'APPROVED', 'REJECTED', 'PUBLISHED']),
  proposedCode: z.string().nullable(),
  proposedTitle: z.string().nullable(),
  proposedSubject: z.string().nullable(),
  proposedBy: uuid.nullable(),
  proposedByName: z.string().nullable().optional(),
  decidedBy: uuid.nullable(),
  decidedByName: z.string().nullable().optional(),
  decisionNote: z.string().nullable(),
  publishedTemplateId: uuid.nullable(),
  version: z.number(),
});
export type WorkbookItemDto = z.infer<typeof WorkbookItemDto>;

export const WorkbookItemsQuery = z.object({
  batchId: uuid.optional(),
  status: z.enum(['UNMAPPED', 'PROPOSED', 'APPROVED', 'REJECTED', 'PUBLISHED']).optional(),
});

/** Classify a row and (unless out of scope) propose the requirement it becomes. */
export const WorkbookProposeInput = z
  .strictObject({
    classification: WorkbookClassification,
    proposedCode: z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,59}$/, 'Use capital letters, digits, - or _')
      .optional(),
    proposedTitle: z.string().trim().min(1).max(200).optional(),
    proposedSubject: z
      .enum(['ORGANISATION', 'SERVICE', 'STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES'])
      .optional(),
  })
  .refine(
    (p) =>
      p.classification === 'OUT_OF_SCOPE' ||
      (!!p.proposedCode && !!p.proposedTitle && !!p.proposedSubject),
    'In-scope items need a proposed code, title and subject',
  );

export const WorkbookDecisionInput = z
  .strictObject({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (d) => d.decision === 'APPROVED' || (d.note?.length ?? 0) >= 3,
    'Say why the mapping is rejected',
  );
