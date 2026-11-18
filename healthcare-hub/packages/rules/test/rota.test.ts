import { describe, expect, it } from 'vitest';
import { rotaWarnings, type RotaShift } from '../src/rota.js';

const at = (d: string, h: number) => new Date(`2026-11-${d}T${String(h).padStart(2, '0')}:00:00Z`);
const shift = (id: string, staffId: string, day: string, from: number, to: number): RotaShift => ({
  id,
  staffId,
  startsAt: at(day, from),
  endsAt: to > from ? at(day, to) : at(String(Number(day) + 1).padStart(2, '0'), to),
});

describe('rotaWarnings [working time prompts]', () => {
  it('flags less than 11 hours rest between shifts, per person', () => {
    const w = rotaWarnings([
      shift('a', 'p1', '16', 7, 19),
      shift('b', 'p1', '17', 4, 14), // 9h after 19:00
      shift('c', 'p2', '17', 4, 14), // someone else: no previous shift
    ]);
    expect(w).toEqual([
      { shiftId: 'b', kind: 'SHORT_REST', text: 'Only 9h rest since last shift (11h minimum)' },
    ]);
  });
  it('treats overlapping shifts as no rest', () => {
    const w = rotaWarnings([shift('a', 'p1', '16', 7, 19), shift('b', 'p1', '16', 18, 22)]);
    expect(w[0]).toMatchObject({
      shiftId: 'b',
      text: 'Only 0h rest since last shift (11h minimum)',
    });
  });
  it('prompts when the 7 days to the end of a shift exceed 48 hours, counting only time inside', () => {
    const five = ['16', '17', '18', '19', '20'].map((d, i) => shift(`s${i}`, 'p1', d, 7, 19));
    const w = rotaWarnings(five);
    // 12h a day: 48h after four shifts (not over), 60h after the fifth.
    expect(w).toEqual([
      { shiftId: 's4', kind: 'LONG_WEEK', text: '60h in 7 days – over 48; check the opt-out' },
    ]);
    // A shift 8 days earlier counts only for the part inside the window (none here).
    expect(rotaWarnings([shift('old', 'p1', '08', 7, 19), ...five.slice(0, 4)])).toEqual([]);
  });
});
