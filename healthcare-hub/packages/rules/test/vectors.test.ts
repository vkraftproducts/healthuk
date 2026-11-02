import { describe, expect, it } from 'vitest';
import {
  checkOdometer,
  defectEffects,
  evaluateRequirement,
  evidenceCoverage,
  maintenanceState,
  nextDue,
  notificationsPaused,
  nextFixedCalendar,
  occurrence,
  validAcrossWindow,
  type RequirementInput,
  type Blocking,
} from '../src/index.js';
import { endOfLondonDay, isDueToday, isOverdue } from '../src/dates.js';
import { staffReadiness, requirementCheck } from '../src/readiness.js';

const at = (iso: string) => new Date(iso);
const req = (o: Partial<RequirementInput>): RequirementInput => ({
  applicability: 'APPLICABLE',
  criticalFailure: false,
  deadline: null,
  verifiedEvidence: null,
  pendingEvidence: false,
  blocking: 'NONE',
  ...o,
});
const verified = { validFrom: '2026-01-01', validTo: null };

describe('RULES_ENGINE §8 test vectors [UAT-01]', () => {
  it('T1 due 2026-10-29, now 23:30 London → AMBER DUE_TODAY', () => {
    const r = evaluateRequirement(
      req({ deadline: { kind: 'DUE', date: '2026-10-29' }, verifiedEvidence: verified }),
      at('2026-10-29T23:30:00Z'),
    );
    expect([r.status, r.reasonCode]).toEqual(['AMBER', 'DUE_TODAY']);
  });
  it('T2 due 2026-10-29, now 2026-10-30 00:00:01 London → RED OVERDUE', () => {
    const r = evaluateRequirement(
      req({ deadline: { kind: 'DUE', date: '2026-10-29' }, verifiedEvidence: verified }),
      at('2026-10-30T00:00:01Z'),
    );
    expect([r.status, r.reasonCode]).toEqual(['RED', 'OVERDUE']);
  });
  it('T3 DST end (BST→GMT) 2026-10-25 23:59 is still due today', () => {
    const now = at('2026-10-25T23:59:00Z'); // GMT
    expect(isDueToday('2026-10-25', now)).toBe(true);
    expect(isOverdue('2026-10-25', now)).toBe(false);
    expect(isOverdue('2026-10-25', at('2026-10-26T00:00:01Z'))).toBe(true);
  });
  it('T4 DST start 2027-03-28 23:59 is still due today', () => {
    const now = at('2027-03-28T22:59:00Z'); // 23:59 BST
    expect(isDueToday('2027-03-28', now)).toBe(true);
    expect(isOverdue('2027-03-28', now)).toBe(false);
    expect(endOfLondonDay('2027-03-28').toISOString()).toBe('2027-03-28T22:59:59.999Z');
  });
  it('T5 annual from 2028-02-29 → 2029-02-28 (and back to 29 Feb in 2032)', () => {
    expect(occurrence('2028-02-29', { unit: 'YEARS', every: 1 }, 1)).toBe('2029-02-28');
    expect(occurrence('2028-02-29', { unit: 'YEARS', every: 4 }, 1)).toBe('2032-02-29');
  });
  it('T6 monthly anchor 31 Jan → 28/29 Feb, 31 Mar, 30 Apr (from the anchor, not the clamped date)', () => {
    const m = { unit: 'MONTHS', every: 1 } as const;
    expect([1, 2, 3].map((k) => occurrence('2027-01-31', m, k))).toEqual([
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
    expect(occurrence('2028-01-31', m, 1)).toBe('2028-02-29');
  });
  it('T7 fixed calendar due 1 Oct completed 10 Oct 3-monthly → 1 Jan, not 10 Jan', () => {
    const q = { unit: 'MONTHS', every: 3 } as const;
    expect(nextFixedCalendar('2026-10-01', q, '2026-10-01')).toBe('2027-01-01');
    expect(
      nextDue({
        type: 'FIXED_CALENDAR',
        interval: q,
        anchor: '2026-10-01',
        previousScheduled: '2026-10-01',
        completedOn: '2026-10-10',
      }),
    ).toEqual({ kind: 'DATE', date: '2027-01-01' });
    expect(nextDue({ type: 'COMPLETION_BASED', interval: q, completedOn: '2026-10-10' })).toEqual({
      kind: 'DATE',
      date: '2027-01-10',
    });
  });
  it('T8 licence expires 12 Nov; job 12 Nov 22:00–23:30 → PASS', () => {
    expect(
      validAcrossWindow(
        { expiryDate: '2026-11-12' },
        { start: at('2026-11-12T22:00:00Z'), end: at('2026-11-12T23:30:00Z') },
      ),
    ).toEqual({ ok: true });
  });
  it('T9 licence expires 12 Nov; job 12 Nov 23:30–13 Nov 00:30 → FAIL', () => {
    expect(
      validAcrossWindow(
        { expiryDate: '2026-11-12' },
        { start: at('2026-11-12T23:30:00Z'), end: at('2026-11-13T00:30:00Z') },
      ),
    ).toEqual({ ok: false, reason: 'EXPIRES_DURING_WINDOW' });
  });
  it('T10 renewal uploaded, old expired, not verified → GREY and driving BLOCKED', () => {
    const now = at('2026-11-20T10:00:00Z');
    const r = evaluateRequirement(
      req({
        blocking: 'DEPLOYMENT_CRITICAL',
        deadline: { kind: 'EXPIRY', date: '2026-11-12' },
        pendingEvidence: true,
      }),
      now,
    );
    expect([r.status, r.reasonCode, r.effect]).toEqual(['GREY', 'UNVERIFIED', 'BLOCK']);
    const w = { start: now, end: at('2026-11-20T12:00:00Z') };
    const s = staffReadiness(
      {
        lifecycle: 'ACTIVE',
        roleApproved: true,
        licenceCategoryCovers: true,
        missingCompetencies: [],
        requirements: [{ code: 'DRIVING_LICENCE', group: 'LICENCE', result: r }],
      },
      w,
    );
    expect(s.state).toBe('BLOCKED');
  });
  it('T11 renewal uploaded, old still valid → AMBER AWAITING_REVIEW and still allocatable', () => {
    const now = at('2026-09-01T10:00:00Z');
    const r = evaluateRequirement(
      req({
        blocking: 'DEPLOYMENT_CRITICAL',
        deadline: { kind: 'EXPIRY', date: '2026-12-31' },
        verifiedEvidence: { validFrom: '2025-01-01', validTo: '2026-12-31' },
        pendingEvidence: true,
      }),
      now,
    );
    expect([r.status, r.reasonCode]).toEqual(['AMBER', 'AWAITING_REVIEW']);
    const c = requirementCheck(
      {
        code: 'DRIVING_LICENCE',
        group: 'LICENCE',
        result: r,
        validFrom: '2025-01-01',
        expiryDate: '2026-12-31',
      },
      { start: now, end: at('2026-09-01T12:00:00Z') },
    );
    expect(c.result).toBe('PASS');
  });
  it('T12 service due 10,000 mi or 1 Dec; odometer 10,050 on 1 Nov → overdue by mileage', () => {
    const m = maintenanceState(
      { dueDate: '2026-12-01', dueOdometer: 10000, currentOdometer: 10050 },
      at('2026-11-01T09:00:00Z'),
    );
    expect([m.state, m.by]).toEqual(['OVERDUE', 'MILEAGE']);
  });
  it('T13 odometer reading lower than previous → ODOMETER_DECREASED', () => {
    expect(
      checkOdometer({ reading: 52000, on: '2026-10-01' }, { reading: 51000, on: '2026-10-02' })
        .flags,
    ).toContain('ODOMETER_DECREASED');
  });
  it('T14 critical defect on AMB-03 with 2 future jobs → vehicle BLOCKED, 2 jobs NEEDS_REASSIGNMENT', () => {
    const e = defectEffects({ severity: 'CRITICAL', stopUse: false }, ['job-1', 'job-2']);
    expect(e).toMatchObject({
      blockVehicle: true,
      reassign: ['job-1', 'job-2'],
      alertControl: true,
    });
  });
  it('T16 snoozing pauses notifications only; status is unchanged', () => {
    const now = at('2026-10-30T09:00:00Z');
    const before = evaluateRequirement(
      req({ deadline: { kind: 'DUE', date: '2026-10-30' }, verifiedEvidence: verified }),
      now,
    );
    expect(notificationsPaused(at('2026-11-06T09:00:00Z'), now)).toBe(true);
    expect(
      evaluateRequirement(
        req({ deadline: { kind: 'DUE', date: '2026-10-30' }, verifiedEvidence: verified }),
        now,
      ),
    ).toEqual(before);
    expect(notificationsPaused(at('2026-11-06T09:00:00Z'), at('2026-11-07T09:00:00Z'))).toBe(false);
    expect(notificationsPaused(null, now)).toBe(false);
  });
  it('T17 DBS review date passed → RED "policy review date passed", not "expired"', () => {
    const r = evaluateRequirement(
      req({
        blocking: 'POLICY',
        deadline: { kind: 'REVIEW', date: '2026-09-01' },
        verifiedEvidence: verified,
      }),
      at('2026-10-30T09:00:00Z'),
    );
    expect([r.status, r.reasonCode]).toEqual(['RED', 'POLICY_REVIEW_OVERDUE']);
    expect(r.reasonText.toLowerCase()).toContain('policy review date passed');
    expect(r.reasonText.toLowerCase()).not.toContain('expired');
  });
  it('T18 approved N/A is excluded from the coverage denominator and listed in exclusions', () => {
    const now = at('2026-10-30T09:00:00Z');
    const results = [
      evaluateRequirement(req({ verifiedEvidence: verified }), now),
      evaluateRequirement(req({}), now),
      evaluateRequirement(req({ applicability: 'APPROVED_NOT_APPLICABLE' }), now),
    ];
    expect(evidenceCoverage(results)).toMatchObject({
      numerator: 1,
      denominator: 2,
      exclusions: 1,
      percent: 50,
      label: 'Internal measure — not a CQC rating',
    });
  });
  // T15 (concurrent allocation) is a database-level guarantee; see apps/api tests (M6).
});

describe('blocking effects', () => {
  it.each<[Blocking, string]>([
    ['NONE', 'NONE'],
    ['POLICY', 'POLICY_BLOCK'],
    ['DEPLOYMENT_CRITICAL', 'BLOCK'],
    ['STATUTORY', 'BLOCK'],
    ['SAFETY_CRITICAL', 'BLOCK'],
  ])('%s → %s', (blocking, effect) => {
    expect(evaluateRequirement(req({ blocking }), at('2026-10-30T09:00:00Z')).effect).toBe(effect);
  });
});
