import { describe, expect, it } from 'vitest';
import { checkJobTransition, expandRecurrence, jobDashboardRow, jobNext } from '../src/index.js';

describe('job lifecycle (JOB-04)', () => {
  it('control allocates and offers; crew acknowledge and progress', () => {
    expect(checkJobTransition({ from: 'ALLOCATED', to: 'OFFERED', actor: 'CONTROL' })).toBeNull();
    expect(checkJobTransition({ from: 'OFFERED', to: 'ACKNOWLEDGED', actor: 'CREW' })).toBeNull();
    expect(checkJobTransition({ from: 'OFFERED', to: 'ACKNOWLEDGED', actor: 'CONTROL' })).toBe(
      'NOT_YOURS',
    );
    expect(
      checkJobTransition({ from: 'BOOKED', to: 'CANCELLED', actor: 'CREW', reason: 'x x x' }),
    ).toBe('NOT_YOURS');
    expect(checkJobTransition({ from: 'ACKNOWLEDGED', to: 'COMPLETED', actor: 'CREW' })).toBe(
      'NOT_ALLOWED',
    );
    expect(jobNext('COMPLETED')).toEqual([]);
  });
  it('exceptional outcomes need a reason', () => {
    expect(checkJobTransition({ from: 'ARRIVED', to: 'NO_ACCESS', actor: 'CREW' })).toBe(
      'REASON_REQUIRED',
    );
    expect(
      checkJobTransition({ from: 'ARRIVED', to: 'NO_ACCESS', actor: 'CREW', reason: '  ' }),
    ).toBe('REASON_REQUIRED');
    expect(
      checkJobTransition({
        from: 'ARRIVED',
        to: 'NO_ACCESS',
        actor: 'CREW',
        reason: 'No answer at the door',
      }),
    ).toBeNull();
  });
});

describe('recurring journeys', () => {
  it('daily and every-other-day', () => {
    expect(
      expandRecurrence('2026-11-02', { freq: 'DAILY', interval: 1, until: '2026-11-04' }),
    ).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(
      expandRecurrence('2026-11-02', { freq: 'DAILY', interval: 2, until: '2026-11-06' }),
    ).toEqual(['2026-11-02', '2026-11-04', '2026-11-06']);
  });
  it('weekly on chosen weekdays (Mon/Wed/Fri dialysis) and default weekday', () => {
    expect(
      expandRecurrence('2026-11-04', {
        freq: 'WEEKLY',
        interval: 1,
        byWeekday: [1, 3, 5],
        until: '2026-11-11',
      }),
    ).toEqual(['2026-11-04', '2026-11-06', '2026-11-09', '2026-11-11']);
    expect(
      expandRecurrence('2026-11-02', { freq: 'WEEKLY', interval: 2, until: '2026-11-30' }),
    ).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
  });
  it('caps instances and ignores impossible rules', () => {
    expect(
      expandRecurrence('2026-01-01', { freq: 'DAILY', interval: 1, until: '2027-12-31' }),
    ).toHaveLength(100);
    expect(
      expandRecurrence(
        '2026-01-01',
        { freq: 'WEEKLY', interval: 1, byWeekday: [1, 2, 3, 4, 5, 6, 7], until: '2027-12-31' },
        10,
      ),
    ).toHaveLength(10);
    expect(
      expandRecurrence('2026-11-10', { freq: 'DAILY', interval: 1, until: '2026-11-01' }),
    ).toEqual([]);
    expect(
      expandRecurrence('2026-11-10', { freq: 'DAILY', interval: 0, until: '2026-11-11' }),
    ).toEqual([]);
  });
});

describe('jobDashboardRow [DASH-01, UAT-08]', () => {
  const now = new Date('2026-06-01T10:00:00Z');
  const before = new Date('2026-06-01T09:00:00Z');
  const after = new Date('2026-06-01T12:00:00Z');
  it('cancelled jobs are not counted', () => {
    expect(jobDashboardRow('CANCELLED', after, now)).toBeNull();
  });
  it('unallocated jobs await allocation; late or refused ones are red', () => {
    expect(jobDashboardRow('BOOKED', after, now)).toEqual({
      status: 'AMBER',
      reasonText: 'Awaiting allocation',
      tiles: ['jobsToday', 'awaitingAllocation'],
    });
    expect(jobDashboardRow('REFUSED', after, now)).toMatchObject({
      status: 'RED',
      reasonText: 'Needs a new crew and vehicle',
    });
    expect(jobDashboardRow('ASSESSED', before, now)).toMatchObject({
      status: 'RED',
      reasonText: 'Past planned start and still unallocated',
    });
  });
  it('offers await acknowledgement and turn red when late', () => {
    expect(jobDashboardRow('ALLOCATED', after, now)).toMatchObject({
      status: 'AMBER',
      tiles: ['jobsToday'],
    });
    expect(jobDashboardRow('OFFERED', after, now)!.tiles).toEqual([
      'jobsToday',
      'acknowledgementsDue',
    ]);
    expect(jobDashboardRow('OFFERED', before, now)).toMatchObject({
      status: 'RED',
      tiles: ['jobsToday', 'acknowledgementsDue'],
    });
    expect(jobDashboardRow('ACKNOWLEDGED', before, now)).toMatchObject({
      status: 'RED',
      tiles: ['jobsToday'],
    });
    expect(jobDashboardRow('ACKNOWLEDGED', after, now)!.status).toBe('GREEN');
  });
  it('ended and moving jobs', () => {
    expect(jobDashboardRow('NO_ACCESS', before, now)!.reasonText).toBe('Ended – no access');
    expect(jobDashboardRow('ABORTED', before, now)!.reasonText).toBe('Ended – aborted');
    expect(jobDashboardRow('EN_ROUTE', before, now)!.reasonText).toBe('Under way');
    expect(jobDashboardRow('COMPLETED', before, now)).toMatchObject({
      status: 'GREEN',
      reasonText: 'Completed',
    });
  });
});
