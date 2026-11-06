import { describe, expect, it } from 'vitest';
import { premisesIntervalStatus } from '../src/index.js';

const today = '2026-11-06';

describe('premises items with an interval but no linked requirement (J1)', () => {
  it('has no own status without an interval', () => {
    expect(
      premisesIntervalStatus({ intervalMonths: null, assessedOn: '2026-01-01' }, today),
    ).toBeNull();
    expect(
      premisesIntervalStatus({ intervalMonths: 0, assessedOn: '2026-01-01' }, today),
    ).toBeNull();
  });

  it('asks for the last assessment date before it can say when the next is due', () => {
    expect(premisesIntervalStatus({ intervalMonths: 12, assessedOn: null }, today)).toEqual({
      status: 'GREY',
      reasonText: 'Record the last assessment date to work out when it is next due',
      nextDue: null,
    });
  });

  it('is red once the next assessment date has passed', () => {
    expect(premisesIntervalStatus({ intervalMonths: 12, assessedOn: '2025-10-01' }, today)).toEqual(
      {
        status: 'RED',
        reasonText: 'Overdue since 1 Oct 2026',
        nextDue: '2026-10-01',
      },
    );
  });

  it('is amber from today up to 30 days ahead, and not yet overdue on the due date itself', () => {
    expect(premisesIntervalStatus({ intervalMonths: 12, assessedOn: '2025-11-06' }, today)).toEqual(
      {
        status: 'AMBER',
        reasonText: 'Due 6 Nov 2026',
        nextDue: '2026-11-06',
      },
    );
    expect(
      premisesIntervalStatus({ intervalMonths: 1, assessedOn: '2026-11-06' }, today)?.status,
    ).toBe('AMBER'); // due 6 Dec, exactly 30 days ahead
  });

  it('is grey, never green, when further away: verified evidence needs a linked requirement', () => {
    expect(premisesIntervalStatus({ intervalMonths: 1, assessedOn: '2026-11-07' }, today)).toEqual({
      status: 'GREY',
      reasonText: 'Next due 7 Dec 2026; link a requirement to record verified evidence',
      nextDue: '2026-12-07',
    });
  });

  it('accepts a stored date-only value (midnight UTC) the same as its ISO date', () => {
    expect(
      premisesIntervalStatus(
        { intervalMonths: 12, assessedOn: new Date('2025-10-01T00:00:00Z') },
        today,
      ),
    ).toEqual(premisesIntervalStatus({ intervalMonths: 12, assessedOn: '2025-10-01' }, today));
  });
});
