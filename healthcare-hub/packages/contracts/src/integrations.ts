import { z } from 'zod';
import { isoDate, isoDateTime, uuid } from './common.js';

/**
 * Integrations (INT-01). Every adapter currently runs against a deterministic synthetic feed
 * ("MOCK"): API access and licences are unconfirmed, so nothing here talks to a real system.
 */
export const IntegrationAdapter = z.enum([
  'TELEMATICS',
  'FLEETX',
  'TRAINING',
  'PAYROLL',
  'CALENDAR',
]);
export type IntegrationAdapter = z.infer<typeof IntegrationAdapter>;
export const IntegrationScenario = z.enum(['normal', 'faults']);

export const IntegrationConnect = z.strictObject({
  /** Only MOCK is accepted until real credentials exist. */
  mode: z.enum(['MOCK', 'LIVE']).default('MOCK'),
});
export const IntegrationSync = z.strictObject({
  /** `faults` makes the mock feed include bad records, to show how they are flagged or skipped. */
  scenario: IntegrationScenario.default('normal'),
});
export const PayrollQuery = z.object({ from: isoDate, to: isoDate });

export const IntegrationRunDto = z.object({
  id: uuid,
  adapter: IntegrationAdapter,
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  status: z.enum(['SUCCEEDED', 'PARTIAL', 'FAILED']),
  scenario: z.string(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime,
  recordsSeen: z.number().int(),
  recordsApplied: z.number().int(),
  recordsFlagged: z.number().int(),
  recordsSkipped: z.number().int(),
  notes: z.array(z.string()),
  error: z.string().nullable(),
});
export type IntegrationRunDto = z.infer<typeof IntegrationRunDto>;

export const IntegrationDto = z.object({
  adapter: IntegrationAdapter,
  name: z.string(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  summary: z.string(),
  /** What the platform does with the data once it arrives or leaves. */
  treatment: z.string(),
  connected: z.boolean(),
  mode: z.literal('MOCK').nullable(),
  lastRunAt: isoDateTime.nullable(),
  lastStatus: z.enum(['SUCCEEDED', 'PARTIAL', 'FAILED']).nullable(),
});
export type IntegrationDto = z.infer<typeof IntegrationDto>;
export const IntegrationList = z.object({
  data: z.array(IntegrationDto),
  recentRuns: z.array(IntegrationRunDto),
  notice: z.string(),
});
export type IntegrationList = z.infer<typeof IntegrationList>;
