import { describe, expect, it } from 'vitest';
import {
  breachClock,
  DEFAULT_RETENTION,
  retentionCutoff,
  subjectRequestDue,
  subjectRequestLatestExtension,
} from '../src/privacy.js';

describe('UK GDPR timings', () => {
  it('a subject request is due one calendar month after receipt, extendable to three', () => {
    expect(subjectRequestDue('2026-01-31')).toBe('2026-02-28');
    expect(subjectRequestDue('2026-11-02')).toBe('2026-12-02');
    expect(subjectRequestLatestExtension('2026-11-02')).toBe('2027-02-02');
  });

  it('the 72-hour ICO clock', () => {
    const discoveredAt = new Date('2026-11-02T09:00:00Z');
    const at = (h: number) => new Date(discoveredAt.getTime() + h * 3_600_000);
    const c = (
      now: Date,
      icoReportable: boolean | null = null,
      icoReportedAt: Date | null = null,
    ) => breachClock({ discoveredAt, icoReportable, icoReportedAt, now });
    expect(c(at(1))).toMatchObject({ state: 'OPEN', hoursLeft: 71, deadline: at(72) });
    expect(c(at(49)).state).toBe('DUE_SOON');
    expect(c(at(73)).state).toBe('OVERDUE');
    expect(c(at(73), true).state).toBe('OVERDUE');
    expect(c(at(73), false).state).toBe('NOT_REPORTABLE');
    expect(c(at(73), true, at(70)).state).toBe('REPORTED');
  });

  it('retention cutoffs and placeholder defaults', () => {
    expect(retentionCutoff(new Date('2026-11-02T12:00:00Z'), 6)).toBe('2026-05-02');
    expect(DEFAULT_RETENTION).toHaveLength(9);
    expect(DEFAULT_RETENTION.every((d) => d.basis.startsWith('Placeholder'))).toBe(true);
  });
});
