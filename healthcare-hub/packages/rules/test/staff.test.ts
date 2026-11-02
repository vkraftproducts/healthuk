import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  checkStaffTransition,
  licenceCovers,
  readinessLifecycle,
  type StaffLifecycle,
} from '../src/index.js';

const t = (from: StaffLifecycle, to: StaffLifecycle, approvedRoles = 1, actorIsSubject = false) =>
  checkStaffTransition({ from, to, approvedRoles, actorIsSubject });

describe('staff lifecycle (HR-01)', () => {
  it('follows the onboarding path in order', () => {
    expect(t('CANDIDATE', 'CHECKS_IN_PROGRESS')).toBeNull();
    expect(t('CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW')).toBeNull();
    expect(t('READY_FOR_REVIEW', 'APPROVED_FOR_ROLE')).toBeNull();
    expect(t('APPROVED_FOR_ROLE', 'ACTIVE')).toBeNull();
  });
  it('cannot skip steps or leave LEAVER', () => {
    expect(t('CANDIDATE', 'ACTIVE')).toBe('NOT_ALLOWED');
    expect(t('LEAVER', 'ACTIVE')).toBe('NOT_ALLOWED');
    expect(allowedTransitions('LEAVER')).toEqual([]);
  });
  it('suspension is reversible; anyone can become a leaver', () => {
    expect(t('ACTIVE', 'SUSPENDED')).toBeNull();
    expect(t('SUSPENDED', 'ACTIVE')).toBeNull();
    expect(t('CANDIDATE', 'LEAVER', 0)).toBeNull();
  });
  it('approval and activation need at least one approved role', () => {
    expect(t('READY_FOR_REVIEW', 'APPROVED_FOR_ROLE', 0)).toBe('NO_ROLE_APPROVED');
    expect(t('SUSPENDED', 'ACTIVE', 0)).toBe('NO_ROLE_APPROVED');
  });
  it('nobody moves their own record', () => {
    expect(t('ACTIVE', 'SUSPENDED', 1, true)).toBe('SELF_APPROVAL');
  });
  it('maps onto readiness', () => {
    expect(readinessLifecycle('ACTIVE')).toBe('ACTIVE');
    expect(readinessLifecycle('SUSPENDED')).toBe('SUSPENDED');
    expect(readinessLifecycle('LEAVER')).toBe('LEAVER');
    expect(readinessLifecycle('APPROVED_FOR_ROLE')).toBe('ONBOARDING');
  });
});

describe('licence entitlement', () => {
  it.each([
    [['B'], 'B', true],
    [['B'], 'C1', false],
    [['C'], 'C1', true],
    [['C1'], 'C', false],
    [['D1E'], 'BE', true],
    [['XX'], 'XX', true],
    [[], 'B', false],
  ] as const)('%j covers %s: %s', (held, req, ok) => {
    expect(licenceCovers(held, req)).toBe(ok);
  });
});
