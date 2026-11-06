import { describe, expect, it } from 'vitest';
import {
  auditCalendarState,
  auditOverallResult,
  autoActionDeadline,
  nextRecurrence,
  pickSample,
  reauditDueDate,
  type Severity,
} from '../src/index.js';

describe('audit overall result (G2)', () => {
  it('a failed non-critical control still makes the audit non-compliant', () => {
    expect(
      auditOverallResult([
        { result: 'COMPLIANT', critical: true },
        { result: 'NON_COMPLIANT', critical: false },
      ]),
    ).toEqual({ result: 'NON_COMPLIANT', text: 'Non-compliant: one or more controls failed' });
  });

  it('compliant when every applicable control passed', () => {
    expect(
      auditOverallResult([
        { result: 'COMPLIANT', critical: true },
        { result: 'NOT_APPLICABLE', critical: false },
      ]),
    ).toEqual({ result: 'COMPLIANT', text: 'Compliant' });
  });

  it('nothing applicable when no control applied, or there were none', () => {
    const na = { result: 'NOT_APPLICABLE', text: 'Nothing applicable' };
    expect(auditOverallResult([{ result: 'NOT_APPLICABLE', critical: true }])).toEqual(na);
    expect(auditOverallResult([])).toEqual(na);
  });
});

describe('actions and re-audits from failed controls (G2)', () => {
  it('sets the action deadline by severity', () => {
    expect(autoActionDeadline('CRITICAL', '2026-11-06')).toBe('2026-11-13');
    expect(autoActionDeadline('HIGH', '2026-11-06')).toBe('2026-11-20');
    expect(autoActionDeadline('MEDIUM', '2026-11-06')).toBe('2026-12-06');
    expect(autoActionDeadline('LOW', '2026-11-06')).toBe('2027-01-05');
  });

  it('falls back to 30 days for a severity it does not recognise (for example an older stored value)', () => {
    expect(autoActionDeadline('URGENT' as Severity, '2026-11-06')).toBe('2026-12-06');
  });

  it('the re-audit is due the day after the last action deadline, whatever order they come in', () => {
    const deadlines = ['2026-12-01', '2027-01-15', '2026-11-20'];
    expect(reauditDueDate(deadlines)).toBe('2027-01-16');
    expect(deadlines).toEqual(['2026-12-01', '2027-01-15', '2026-11-20']);
  });

  it('no re-audit date until there is an action', () => {
    expect(reauditDueDate([])).toBeNull();
  });

  it('a recurring audit moves on by calendar months, clamped to the month end', () => {
    expect(nextRecurrence('2026-11-06', 3)).toBe('2027-02-06');
    expect(nextRecurrence('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('sampling records for an audit (G2)', () => {
  const population = Array.from({ length: 10 }, (_, i) => `REC-${i}`);

  it('returns nothing when the sample size is zero or negative, or the population is empty', () => {
    expect(pickSample(population, 'RANDOM', 0)).toEqual([]);
    expect(pickSample(population, 'EVERY_NTH', -3)).toEqual([]);
    expect(pickSample([], 'RANDOM', 5)).toEqual([]);
  });

  it('every nth record steps evenly through the population', () => {
    expect(pickSample(population, 'EVERY_NTH', 3)).toEqual(['REC-0', 'REC-3', 'REC-6']);
  });

  it('never asks for more records than there are', () => {
    expect(pickSample(['A', 'B'], 'EVERY_NTH', 5)).toEqual(['A', 'B']);
    expect(pickSample(['A', 'B'], 'RANDOM', 5, () => 0.5)).toHaveLength(2);
  });

  it('a random sample is a shuffle driven by the supplied random source, so tests can seed it', () => {
    expect(pickSample(['A', 'B', 'C', 'D'], 'RANDOM', 2, () => 0)).toEqual(['B', 'C']);
    expect(pickSample(['A', 'B', 'C', 'D'], 'RANDOM', 4, () => 0.999)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('without a random source it still picks distinct records from the population', () => {
    const sample = pickSample(population, 'RANDOM', 4);
    expect(sample).toHaveLength(4);
    expect(new Set(sample).size).toBe(4);
    for (const r of sample) expect(population).toContain(r);
  });
});

describe('audit calendar (G1)', () => {
  it('a scheduled or in-progress audit is overdue after its due date, due until then', () => {
    expect(auditCalendarState({ dueDate: '2026-11-05', status: 'SCHEDULED' }, '2026-11-06')).toBe(
      'OVERDUE',
    );
    expect(auditCalendarState({ dueDate: '2026-11-06', status: 'IN_PROGRESS' }, '2026-11-06')).toBe(
      'DUE',
    );
    expect(auditCalendarState({ dueDate: '2026-11-05', status: 'IN_PROGRESS' }, '2026-11-06')).toBe(
      'OVERDUE',
    );
  });

  it('a finished audit is done even if its due date has passed', () => {
    expect(auditCalendarState({ dueDate: '2026-10-01', status: 'COMPLETED' }, '2026-11-06')).toBe(
      'DONE',
    );
  });
});
