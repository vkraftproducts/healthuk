import { describe, expect, it } from 'vitest';
import {
  CQC_NOTIFICATION_NEXT,
  FPP_ITEMS,
  fppNextReviewDue,
  fppOutstanding,
  fppState,
  contractNoticeBy,
  contractState,
  isNhsContractItem,
  summariseContractItems,
  notificationState,
  notificationTargetDate,
  ratingDisplayDue,
  ratingDisplayState,
  suggestNotificationKind,
  type FppCheckInput,
} from '../src/index.js';

describe('rating display (reg 20A)', () => {
  const base = {
    publishedOn: '2026-10-01',
    displayedPremisesOn: null,
    displayedWebsiteOn: null,
    noWebsite: false,
  };

  it('is due 21 days after publication', () => {
    expect(ratingDisplayDue('2026-10-01')).toBe('2026-10-22');
  });

  it('is amber until the due date, then red, naming where it is missing', () => {
    const amber = ratingDisplayState(base, '2026-10-22');
    expect(amber.status).toBe('AMBER');
    expect(amber.reasonText).toContain('at the premises and on the website');
    const red = ratingDisplayState(base, '2026-10-23');
    expect(red.status).toBe('RED');
    expect(red.reasonText).toContain('was due 22 Oct 2026');
  });

  it('is green once displayed where required; no website means premises only', () => {
    expect(
      ratingDisplayState(
        { ...base, displayedPremisesOn: '2026-10-05', displayedWebsiteOn: '2026-10-06' },
        '2026-12-01',
      ).status,
    ).toBe('GREEN');
    expect(
      ratingDisplayState(
        { ...base, displayedPremisesOn: '2026-10-05', noWebsite: true },
        '2026-12-01',
      ).status,
    ).toBe('GREEN');
    const web = ratingDisplayState({ ...base, displayedPremisesOn: '2026-10-05' }, '2026-12-01');
    expect(web.status).toBe('RED');
    expect(web.reasonText).toContain('on the website');
    expect(web.reasonText).not.toContain('premises');
  });

  it('never mentions a rating value', () => {
    const s = ratingDisplayState(base, '2026-10-02');
    expect(s.reasonText).not.toMatch(/good|outstanding|inadequate|requires improvement/i);
  });
});

describe("directors' fit and proper checks", () => {
  const all = FPP_ITEMS.map((item) => ({ item, done: true }));
  const check: FppCheckInput = {
    checkedOn: '2026-01-10',
    items: all,
    declarationOn: '2026-01-10',
    outcome: 'FIT',
    nextReviewDue: fppNextReviewDue('2026-01-10'),
  };

  it('reviews every 12 months', () => {
    expect(fppNextReviewDue('2026-01-10')).toBe('2027-01-10');
    expect(fppNextReviewDue('2024-02-29')).toBe('2025-02-28');
  });

  it('is red with no check, and red when found not fit', () => {
    expect(fppState(null, '2026-11-06').status).toBe('RED');
    expect(fppState({ ...check, outcome: 'NOT_FIT' }, '2026-11-06').status).toBe('RED');
    expect(fppState({ ...check, outcome: 'FURTHER_REVIEW' }, '2026-11-06').status).toBe('AMBER');
  });

  it('lists outstanding items and a missing declaration', () => {
    const items = all.map((i) => (i.item === 'DBS' ? { ...i, done: false } : i));
    expect(fppOutstanding(items)).toEqual(['DBS']);
    expect(fppOutstanding([])).toHaveLength(FPP_ITEMS.length);
    const s = fppState({ ...check, items }, '2026-11-06');
    expect(s.status).toBe('AMBER');
    expect(s.reasonText).toContain('DBS check');
    expect(fppState({ ...check, declarationOn: null }, '2026-11-06').reasonText).toContain(
      'Self-declaration',
    );
  });

  it('is green when current, amber within 30 days of review, red when overdue', () => {
    expect(fppState(check, '2026-11-06').status).toBe('GREEN');
    expect(fppState(check, '2026-12-11').status).toBe('AMBER');
    const overdue = fppState(check, '2027-01-11');
    expect(overdue.status).toBe('RED');
    expect(overdue.reasonText).toContain('overdue');
  });
});

describe('NHS contracts [task 22]', () => {
  const c = { startOn: '2026-04-01', endOn: '2027-03-31', noticeMonths: 6 };

  it('works out the notice date from the end date', () => {
    expect(contractNoticeBy('2027-03-31', 6)).toBe('2026-09-30');
    expect(contractNoticeBy('2027-03-31', 0)).toBeNull();
  });

  it('is grey before it starts, green while running, amber from the notice date', () => {
    expect(contractState(c, '2026-03-01').status).toBe('GREY');
    expect(contractState(c, '2026-06-01')).toEqual({
      status: 'GREEN',
      reasonText: 'Running until 31 Mar 2027',
    });
    const amber = contractState(c, '2026-09-30');
    expect(amber.status).toBe('AMBER');
    expect(amber.reasonText).toContain('agree renewal or exit');
    expect(contractState(c, '2027-04-01').status).toBe('NOT_APPLICABLE');
    expect(contractState({ ...c, noticeMonths: 0 }, '2027-03-30').status).toBe('GREEN');
  });

  it('recognises NHS contract items by pack or code', () => {
    expect(isNhsContractItem({ pack: 'NHS_CONTRACT_V1', code: 'NHS-ORG-01' })).toBe(true);
    expect(isNhsContractItem({ pack: 'CUSTOM', code: 'nhs-kpi-1' })).toBe(true);
    expect(isNhsContractItem({ pack: 'AMBULANCE_V1', code: 'AMB-STF-01' })).toBe(false);
  });

  it('counts an item as met only when green', () => {
    expect(summariseContractItems(['GREEN', 'AMBER', 'GREY', 'NOT_APPLICABLE', 'RED'])).toEqual({
      total: 5,
      met: 1,
      notMet: 3,
      notApplicable: 1,
    });
  });
});

describe('CQC notification drafts', () => {
  it('targets the next day, or 28 days before a planned manager absence', () => {
    expect(notificationTargetDate('SERIOUS_INJURY', '2026-11-06')).toBe('2026-11-07');
    expect(notificationTargetDate('MANAGER_ABSENCE', '2026-12-31', true)).toBe('2026-12-03');
    expect(notificationTargetDate('MANAGER_ABSENCE', '2026-11-06', false)).toBe('2026-11-07');
  });

  it('suggests a kind from the event', () => {
    expect(suggestNotificationKind({ types: ['INCIDENT'], severity: 'DEATH' })).toBe('DEATH');
    expect(suggestNotificationKind({ types: ['SAFEGUARDING'], severity: 'LOW' })).toBe(
      'ABUSE_ALLEGATION',
    );
    expect(suggestNotificationKind({ types: ['ACCIDENT'], severity: 'SEVERE' })).toBe(
      'SERIOUS_INJURY',
    );
    expect(suggestNotificationKind({ types: ['NEAR_MISS'], severity: 'NO_HARM' })).toBeNull();
  });

  it('only moves forward through review to submission', () => {
    expect(CQC_NOTIFICATION_NEXT.DRAFT).toEqual(['READY', 'NOT_REQUIRED']);
    expect(CQC_NOTIFICATION_NEXT.READY).toContain('SUBMITTED');
    expect(CQC_NOTIFICATION_NEXT.SUBMITTED).toEqual([]);
    expect(CQC_NOTIFICATION_NEXT.NOT_REQUIRED).toEqual([]);
  });

  it('shows the state in words', () => {
    const draft = { status: 'DRAFT' as const, dueOn: '2026-11-07', submittedOn: null };
    expect(notificationState(draft, '2026-11-07').status).toBe('AMBER');
    expect(notificationState(draft, '2026-11-08').status).toBe('RED');
    expect(
      notificationState(
        { status: 'SUBMITTED', dueOn: '2026-11-07', submittedOn: '2026-11-07' },
        '2026-12-01',
      ).status,
    ).toBe('GREEN');
    const late = notificationState(
      { status: 'SUBMITTED', dueOn: '2026-11-07', submittedOn: '2026-11-09' },
      '2026-12-01',
    );
    expect(late.status).toBe('AMBER');
    expect(late.reasonText).toContain('after the target');
    expect(
      notificationState(
        { status: 'NOT_REQUIRED', dueOn: '2026-11-07', submittedOn: null },
        '2026-12-01',
      ).status,
    ).toBe('NOT_APPLICABLE');
  });

  it('a reviewed notification says it is not yet submitted, amber until the target passes', () => {
    const ready = { status: 'READY' as const, dueOn: '2026-11-07', submittedOn: null };
    expect(notificationState(ready, '2026-11-07')).toEqual({
      status: 'AMBER',
      reasonText: 'Reviewed, not yet submitted – submit by 7 Nov 2026',
    });
    expect(notificationState(ready, '2026-11-08')).toEqual({
      status: 'RED',
      reasonText: 'Reviewed, not yet submitted – target was 7 Nov 2026',
    });
  });
});
