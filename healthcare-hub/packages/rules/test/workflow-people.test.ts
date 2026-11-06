import { describe, expect, it } from 'vitest';
import {
  activeDeputy,
  alertItemKind,
  coveringFor,
  escalationStage,
  identityPauseDays,
  quarterRange,
  recipientReason,
  snoozeUntil,
  speakUpThemes,
  subjectRequestEffectiveDue,
  suggestBreachRisk,
  suppressedCount,
} from '../src/index.js';

const esc = { leadAfterDays: 1, managerAfterDays: 7 };

describe('A6 escalation and deputies', () => {
  it('escalates by whole UK days since the alert was raised', () => {
    const raised = new Date('2026-11-01T10:00:00Z');
    expect(escalationStage(raised, new Date('2026-11-01T22:00:00Z'), esc)).toBe('OWNER');
    expect(escalationStage(raised, new Date('2026-11-02T08:00:00Z'), esc)).toBe('LEAD');
    expect(escalationStage(raised, new Date('2026-11-08T08:00:00Z'), esc)).toBe('MANAGER');
    expect(escalationStage(raised, new Date('2026-11-08T08:00:00Z'), esc, true)).toBe('OWNER');
  });

  it('finds cover only inside its dates, both ends included', () => {
    const deputies = [
      { leadUserId: 'lead', deputyUserId: 'dep', from: '2026-11-02', to: '2026-11-06' },
    ];
    expect(coveringFor(deputies, 'dep', '2026-11-02')).toEqual(['lead']);
    expect(coveringFor(deputies, 'dep', '2026-11-06')).toEqual(['lead']);
    expect(coveringFor(deputies, 'dep', '2026-11-07')).toEqual([]);
    expect(activeDeputy(deputies, 'lead', '2026-11-04')).toBe('dep');
    expect(activeDeputy(deputies, 'lead', '2026-11-01')).toBeNull();
  });

  it('routes items to the lead role for their kind', () => {
    expect(alertItemKind('REQUIREMENT', 'VEHICLE')).toBe('VEHICLE_DOCUMENT');
    expect(alertItemKind('REQUIREMENT', 'STAFF')).toBe('STAFF_REQUIREMENT');
    expect(alertItemKind('BREACH')).toBe('DP_DEADLINE');
    const base = { kind: 'STAFF_REQUIREMENT', roleKeys: ['HR_LEAD'] };
    expect(recipientReason({ ...base, recipients: ['OWNER', 'LEAD'], stage: 'OWNER' })).toBe(
      'RULE',
    );
    expect(recipientReason({ ...base, recipients: ['OWNER'], stage: 'OWNER' })).toBeNull();
    expect(recipientReason({ ...base, recipients: ['OWNER'], stage: 'LEAD' })).toBe('ESCALATED');
    expect(
      recipientReason({
        kind: 'STAFF_REQUIREMENT',
        roleKeys: ['REGISTERED_MANAGER'],
        recipients: ['OWNER'],
        stage: 'LEAD',
      }),
    ).toBeNull();
  });

  it('snoozes to the end of the UK day when given a date', () => {
    // 23:59:59.999 London time in winter is the same in UTC.
    expect(snoozeUntil('2026-11-10').toISOString()).toBe('2026-11-10T23:59:59.999Z');
    expect(snoozeUntil('2026-11-10T09:00:00.000Z').toISOString()).toBe('2026-11-10T09:00:00.000Z');
  });
});

describe('L2 data protection', () => {
  it('pauses the subject request clock while identity is awaited', () => {
    expect(identityPauseDays(null, '2026-11-10')).toBe(0);
    expect(identityPauseDays('2026-11-01', '2026-11-05')).toBe(4);
    expect(subjectRequestEffectiveDue('2026-12-01', null, 4)).toBe('2026-12-05');
    expect(subjectRequestEffectiveDue('2026-12-01', '2027-02-01', 4)).toBe('2027-02-05');
  });

  it('suggests a breach risk from the guided answers', () => {
    const a = {
      specialCategory: false,
      identifiable: true,
      volume: 'FEW' as const,
      likelyHarm: 'NONE' as const,
      recovered: true,
    };
    expect(suggestBreachRisk(a)).toBe('UNLIKELY');
    expect(suggestBreachRisk({ ...a, recovered: false })).toBe('RISK');
    expect(suggestBreachRisk({ ...a, specialCategory: true, likelyHarm: 'SOME' })).toBe(
      'HIGH_RISK',
    );
    expect(suggestBreachRisk({ ...a, identifiable: false, likelyHarm: 'SERIOUS' })).toBe(
      'UNLIKELY',
    );
  });
});

describe('H6 speak-up themes', () => {
  it('gives the UK dates of a quarter', () => {
    expect(quarterRange('2026-Q1')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(quarterRange('2026-Q4')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(() => quarterRange('2026-Q5')).toThrow();
  });

  it('hides counts under 3 and does not order them by size', () => {
    expect(suppressedCount(0)).toBe('0');
    expect(suppressedCount(2)).toBe('fewer than 3');
    expect(suppressedCount(3)).toBe('3');
    const t = speakUpThemes(['B', 'A', 'C', 'C', 'C', 'A']);
    expect(t).toEqual([
      { category: 'C', count: '3' },
      { category: 'A', count: 'fewer than 3' },
      { category: 'B', count: 'fewer than 3' },
    ]);
  });
});
