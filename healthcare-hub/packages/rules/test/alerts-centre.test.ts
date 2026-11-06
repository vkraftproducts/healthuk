import { describe, expect, it } from 'vitest';
import {
  alertEvent,
  alertLink,
  compareCentreItems,
  emailRolesForEvent,
  readNotificationRules,
  rolesForEvent,
  toldByRule,
  type NotificationRule,
} from '../src/index.js';

const rules: NotificationRule[] = [
  { event: 'EXPIRY_WARNING', roleKeys: ['GOVERNANCE_LEAD', 'HR_LEAD'], email: false },
  { event: 'EXPIRY_WARNING', roleKeys: ['HR_LEAD', 'DIRECTOR'], email: true },
  { event: 'BREACH_RECORDED', roleKeys: ['DIRECTOR'], email: true },
];

describe('notification rules (task 24)', () => {
  it('reads stored rules defensively', () => {
    expect(readNotificationRules(null)).toEqual([]);
    expect(readNotificationRules({ warningDays: [30] })).toEqual([]);
    expect(
      readNotificationRules({
        notificationRules: [rules[0], { event: 'X' }, null, 'junk'],
      }),
    ).toEqual([rules[0]]);
  });

  it('collects the roles told about an event, once each', () => {
    expect(rolesForEvent(rules, 'EXPIRY_WARNING')).toEqual([
      'GOVERNANCE_LEAD',
      'HR_LEAD',
      'DIRECTOR',
    ]);
    expect(rolesForEvent(rules, 'ACTION_OVERDUE')).toEqual([]);
  });

  it('only sends email to roles on a rule with email switched on', () => {
    expect(emailRolesForEvent(rules, 'EXPIRY_WARNING')).toEqual(['HR_LEAD', 'DIRECTOR']);
  });

  it('says whether a person is told by their role', () => {
    expect(toldByRule(rules, 'BREACH_RECORDED', ['DIRECTOR'])).toBe(true);
    expect(toldByRule(rules, 'BREACH_RECORDED', ['CREW'])).toBe(false);
  });

  it('maps stored alerts to routable events', () => {
    expect(alertEvent('REQUIREMENT')).toBe('EXPIRY_WARNING');
    expect(alertEvent('BREACH')).toBe('BREACH_RECORDED');
    expect(alertEvent('JOB')).toBeNull();
  });

  it('links to pages without personal data', () => {
    const id = '01900000-0000-7000-8000-000000000001';
    expect(alertLink('EVENT', id)).toBe(`/compliance/events/${id}`);
    expect(alertLink('ACTION', id)).toBe('/compliance?tab=actions');
    expect(alertLink('UNKNOWN', id)).toBe('/alerts');
  });

  it('puts the most serious first, then the oldest', () => {
    const items = [
      { severity: 'LOW' as const, raisedAt: '2026-11-01T00:00:00.000Z' },
      { severity: 'CRITICAL' as const, raisedAt: '2026-11-05T00:00:00.000Z' },
      { severity: 'CRITICAL' as const, raisedAt: '2026-11-02T00:00:00.000Z' },
    ];
    expect(items.sort(compareCentreItems).map((i) => i.raisedAt)).toEqual([
      '2026-11-02T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
  });
});
