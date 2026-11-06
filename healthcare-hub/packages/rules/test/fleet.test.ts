import { describe, expect, it } from 'vitest';
import {
  expenseDuplicate,
  moveDateProblem,
  vehicleDocumentKind,
  vehicleDocumentText,
  vehicleHeadline,
  type Check,
} from '../src/index.js';

describe('statutory vehicle documents (D1)', () => {
  it('recognises MOT, insurance, tax and conversion certificates from a code or title', () => {
    expect(vehicleDocumentKind('MOT test certificate')).toBe('MOT');
    expect(vehicleDocumentKind('mot')).toBe('MOT');
    expect(vehicleDocumentKind('Motor insurance')).toBe('INSURANCE');
    expect(vehicleDocumentKind('Road tax')).toBe('TAX');
    expect(vehicleDocumentKind('Vehicle excise duty (VED)')).toBe('TAX');
    expect(vehicleDocumentKind('Ambulance conversion certificate')).toBe('CONVERSION');
  });

  it('does not mistake other words for a statutory document', () => {
    expect(vehicleDocumentKind('Annual service')).toBeNull();
    expect(vehicleDocumentKind('Motorway driving course')).toBeNull();
    expect(vehicleDocumentKind('Taxi licence')).toBeNull();
  });
});

describe('vehicle document wording (D1, E3)', () => {
  const check = (result: Check['result'], reasonText: string): Check => ({
    code: 'X',
    group: 'ROADWORTHY',
    result,
    reasonText,
    overridable: false,
  });

  it('a passing check keeps its own words', () => {
    expect(
      vehicleDocumentText('Insurance', check('PASS', 'Valid until 1 Mar 2027'), {
        status: 'GREEN',
        expiryDate: '2027-03-01',
      }),
    ).toBe('Insurance: Valid until 1 Mar 2027');
  });

  it('a document that expires before the job ends names the expiry date', () => {
    expect(
      vehicleDocumentText('MOT', check('FAIL', 'Expires during the job'), {
        status: 'AMBER',
        expiryDate: '2026-11-07',
      }),
    ).toBe('MOT expires 7 Nov 2026, before the job ends');
  });

  it('without a stored expiry date it falls back to the check’s own reason', () => {
    expect(
      vehicleDocumentText('MOT', check('FAIL', 'Expires during the job'), {
        status: 'AMBER',
        expiryDate: null,
      }),
    ).toBe('MOT expires during the job');
  });
});

describe('vehicle headline status (D1)', () => {
  const base = {
    offRoad: false,
    quarantined: false,
    statusReason: null,
    failing: [] as string[],
  };

  it('off road wins, with its reason and expected return date', () => {
    expect(
      vehicleHeadline({
        ...base,
        offRoad: true,
        quarantined: true,
        statusReason: 'Gearbox repair',
        expectedReturnOn: '2026-11-12',
      }),
    ).toEqual({ status: 'OFF_ROAD', reason: 'Gearbox repair; expected back 12 Nov 2026' });
    expect(vehicleHeadline({ ...base, offRoad: true })).toEqual({
      status: 'OFF_ROAD',
      reason: 'Off road',
    });
  });

  it('quarantined shows its reason, or says quarantined when none is given', () => {
    expect(vehicleHeadline({ ...base, quarantined: true, statusReason: 'Fuel leak' })).toEqual({
      status: 'QUARANTINED',
      reason: 'Fuel leak',
    });
    expect(vehicleHeadline({ ...base, quarantined: true })).toEqual({
      status: 'QUARANTINED',
      reason: 'Quarantined',
    });
  });

  it('blocked lists every failing check; otherwise available with no reason', () => {
    expect(
      vehicleHeadline({
        ...base,
        failing: ['MOT expired on 2 Nov 2026', 'Insurance not verified'],
      }),
    ).toEqual({
      status: 'BLOCKED',
      reason: 'MOT expired on 2 Nov 2026; Insurance not verified',
    });
    expect(vehicleHeadline(base)).toEqual({ status: 'AVAILABLE', reason: null });
  });
});

describe('possible duplicate expenses (D7)', () => {
  const existing = [
    { vehicleId: 'veh-1', incurredOn: '2026-11-02', amountPence: 4550, receiptEvidenceId: 'ev-9' },
    { vehicleId: 'veh-2', incurredOn: '2026-11-03', amountPence: 1200, receiptEvidenceId: null },
  ];

  it('the same receipt is a duplicate even on another vehicle', () => {
    expect(
      expenseDuplicate(
        { vehicleId: 'veh-3', incurredOn: '2026-11-05', amountPence: 1, receiptEvidenceId: 'ev-9' },
        existing,
      ),
    ).toBe(true);
  });

  it('the same amount on the same date and vehicle is a duplicate', () => {
    expect(
      expenseDuplicate(
        { vehicleId: 'veh-2', incurredOn: '2026-11-03', amountPence: 1200 },
        existing,
      ),
    ).toBe(true);
  });

  it('differs by vehicle, date or amount: not a duplicate', () => {
    const next = { vehicleId: 'veh-2', incurredOn: '2026-11-03', amountPence: 1200 };
    expect(expenseDuplicate({ ...next, vehicleId: 'veh-1' }, existing)).toBe(false);
    expect(expenseDuplicate({ ...next, incurredOn: '2026-11-04' }, existing)).toBe(false);
    expect(expenseDuplicate({ ...next, amountPence: 1201 }, existing)).toBe(false);
    expect(expenseDuplicate({ ...next, receiptEvidenceId: 'ev-new' }, [])).toBe(false);
  });
});

describe('moving a vehicle between locations (D5)', () => {
  const now = new Date('2026-11-06T10:00:00Z');

  it('allows a move today or on an earlier date', () => {
    expect(moveDateProblem('2026-11-06', now)).toBeNull();
    expect(moveDateProblem('2026-11-01', now)).toBeNull();
  });

  it('refuses a move dated in the future', () => {
    expect(moveDateProblem('2026-11-07', now)).toBe(
      'A move can take effect today or on an earlier date',
    );
  });

  it('judges “today” on the London clock, not UTC', () => {
    // 23:30 UTC on 1 July is already 2 July in London (BST).
    expect(moveDateProblem('2026-07-02', new Date('2026-07-01T23:30:00Z'))).toBeNull();
  });
});
