import { describe, expect, it } from 'vitest';
import {
  hasCompetence,
  matrixCellState,
  matrixCellText,
  matrixRowHasGap,
  missingCompetences,
  summariseMatrixColumn,
  trainingExpiry,
} from '../src/index.js';

describe('training matrix cells (HR-03)', () => {
  it('only verified items count as met; no record is missing', () => {
    expect(matrixCellState({ required: true, status: 'GREEN' })).toBe('MET');
    expect(matrixCellState({ required: true, status: 'AMBER' })).toBe('DUE_SOON');
    expect(matrixCellState({ required: true, status: 'RED' })).toBe('OVERDUE');
    expect(matrixCellState({ required: true, status: 'GREY' })).toBe('MISSING');
    expect(matrixCellState({ required: true, status: null })).toBe('MISSING');
  });

  it('uploaded but unverified evidence is awaiting verification [C1]', () => {
    expect(matrixCellState({ required: true, status: 'GREY', reasonCode: 'UNVERIFIED' })).toBe(
      'AWAITING',
    );
    expect(matrixRowHasGap(['MET', 'AWAITING'])).toBe(true);
  });

  it('items not required for the person, or not applicable, are not counted', () => {
    expect(matrixCellState({ required: false, status: 'RED' })).toBe('NOT_REQUIRED');
    expect(matrixCellState({ required: true, status: 'NOT_APPLICABLE' })).toBe('NOT_REQUIRED');
  });

  it('cells use the workflow wording [C1]', () => {
    expect(matrixCellText('MET', '2027-03-12')).toBe('Verified, valid until 12 Mar 2027');
    expect(matrixCellText('DUE_SOON', null)).toBe('Due soon');
    expect(matrixCellText('OVERDUE', null)).toBe('Overdue or expired');
    expect(matrixCellText('AWAITING', null)).toBe('Awaiting verification');
    expect(matrixCellText('NOT_REQUIRED', null)).toBe('Not required');
  });

  it('says "Not done" for a missing item, and words the dates only when known', () => {
    expect(matrixCellText('MISSING', null)).toBe('Not done');
    expect(matrixCellText('MET', null)).toBe('Verified');
    expect(matrixCellText('DUE_SOON', '2026-12-01')).toBe('Due soon, expires 1 Dec 2026');
  });

  it('totals a column and rounds the percentage down', () => {
    expect(summariseMatrixColumn(['MET', 'MET', 'OVERDUE', 'NOT_REQUIRED'])).toEqual({
      required: 3,
      met: 2,
      dueSoon: 0,
      overdue: 1,
      awaiting: 0,
      missing: 0,
      percentMet: 66,
    });
    expect(summariseMatrixColumn(['NOT_REQUIRED']).percentMet).toBeNull();
  });

  it('a row has a gap when something required is overdue or missing', () => {
    expect(matrixRowHasGap(['MET', 'DUE_SOON', 'NOT_REQUIRED'])).toBe(false);
    expect(matrixRowHasGap(['MET', 'MISSING'])).toBe(true);
  });

  it('calculates expiry from the course interval when left blank [C1]', () => {
    expect(trainingExpiry('2026-03-12', 12, null)).toBe('2027-03-12');
    expect(trainingExpiry('2026-03-12', 12, '2026-12-31')).toBe('2026-12-31');
    expect(trainingExpiry('2026-03-12', null, null)).toBeNull();
  });
});

describe('competencies [C4]', () => {
  const recs = [
    { code: 'STAIR_CHAIR', outcome: 'NOT_YET_COMPETENT', assessedOn: '2026-01-01' },
    {
      code: 'STAIR_CHAIR',
      outcome: 'COMPETENT',
      assessedOn: '2026-02-01',
      expiresOn: '2027-02-01',
    },
    { code: 'BARIATRIC', outcome: 'COMPETENT', assessedOn: '2025-01-01', expiresOn: '2026-01-01' },
  ];

  it('uses the latest assessment and its expiry', () => {
    expect(hasCompetence(recs, 'STAIR_CHAIR', '2026-11-06')).toBe(true);
    expect(hasCompetence(recs, 'STAIR_CHAIR', '2026-01-15')).toBe(false);
    expect(hasCompetence(recs, 'BARIATRIC', '2026-11-06')).toBe(false);
    expect(hasCompetence(recs, 'OXYGEN', '2026-11-06')).toBe(false);
  });

  it('lists skills nobody on the crew holds', () => {
    expect(missingCompetences([recs, []], ['STAIR_CHAIR', 'BARIATRIC'], '2026-11-06')).toEqual([
      'BARIATRIC',
    ]);
  });
});
