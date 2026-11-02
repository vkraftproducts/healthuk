import { describe, expect, it } from 'vitest';
import { planStatus } from '../src/fleet.js';

const now = new Date('2026-10-30T12:00:00Z');
const plan = (o: Partial<Parameters<typeof planStatus>[0]> = {}) => ({
  intervalDays: 365,
  intervalMiles: 10_000,
  dueSoonMiles: 500,
  dueSoonDays: 30,
  lastDoneOn: new Date('2026-01-01T00:00:00Z'),
  lastDoneOdometer: 40_000,
  createdAt: new Date('2025-06-01T00:00:00Z'),
  ...o,
});

describe('planStatus (date and mileage, whichever first)', () => {
  it('computes both due points', () => {
    expect(planStatus(plan(), 45_000, now)).toMatchObject({
      state: 'OK',
      dueDate: '2027-01-01',
      dueOdometer: 50_000,
    });
  });
  it('mileage can make it overdue before the date', () => {
    expect(planStatus(plan(), 50_100, now)).toMatchObject({ state: 'OVERDUE', by: 'MILEAGE' });
  });
  it('the date can make it due soon before the mileage', () => {
    expect(
      planStatus(plan({ lastDoneOn: new Date('2025-11-15T00:00:00Z') }), 41_000, now),
    ).toMatchObject({ state: 'DUE_SOON', by: 'DATE' });
  });
  it('a never-done date plan counts from creation; a mileage-only plan without a baseline is date-free', () => {
    expect(planStatus(plan({ lastDoneOn: null, intervalMiles: null }), null, now)).toMatchObject({
      state: 'OVERDUE',
      by: 'DATE',
      dueDate: '2026-06-01',
    });
    expect(planStatus(plan({ intervalDays: null, lastDoneOdometer: null }), 1, now)).toMatchObject({
      state: 'OK',
      dueDate: null,
      dueOdometer: null,
    });
  });
});
