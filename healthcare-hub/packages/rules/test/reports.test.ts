import { describe, expect, it } from 'vitest';
import {
  AGE_BANDS,
  ageBand,
  monthPeriod,
  monthsIn,
  percent,
  punctual,
  REPORTS,
  reportDefinition,
} from '../src/reports.js';

describe('report catalogue [PRD 4.10]', () => {
  it('every measure documents its denominator, period and inclusion rule', () => {
    expect(REPORTS.map((r) => r.id)).toEqual([
      'WORKFORCE_READINESS',
      'SUPERVISION',
      'FLEET',
      'AUDITS_ACTIONS',
      'EVENTS',
      'POLICY_ACK',
      'PREMISES',
      'JOURNEYS',
      'NHS_KPI',
    ]);
    for (const r of REPORTS)
      for (const m of r.measures) {
        expect(m.denominator.length).toBeGreaterThan(5);
        expect(m.period.length).toBeGreaterThan(5);
        expect(m.inclusion.length).toBeGreaterThan(5);
      }
    expect(reportDefinition('FLEET').title).toMatch(/Fleet/);
  });

  it('percent rounds to one decimal and has no value without a denominator', () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 2)).toBe(100);
    expect(percent(0, 0)).toBeNull();
  });

  it('age bands', () => {
    expect([0, 30, 31, 60, 61, 90, 91].map(ageBand)).toEqual([
      '0–30',
      '0–30',
      '31–60',
      '31–60',
      '61–90',
      '61–90',
      '90+',
    ]);
    expect(AGE_BANDS).toHaveLength(4);
  });

  it('months and month periods (London dates)', () => {
    expect(monthsIn('2026-11-15', '2027-02-01')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(monthsIn('2026-10-01', '2026-10-31')).toEqual(['2026-10']);
    expect(monthPeriod('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthPeriod('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(() => monthPeriod('2026-13')).toThrow();
  });

  it('punctual means arrived at or before the end of the pickup window', () => {
    const end = new Date('2026-10-30T09:30:00Z');
    expect(punctual(end, end)).toBe(true);
    expect(punctual(new Date('2026-10-30T09:30:01Z'), end)).toBe(false);
  });
});
