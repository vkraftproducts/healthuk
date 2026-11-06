import { describe, expect, it } from 'vitest';
import {
  driverEligibility,
  drivingCategoryFor,
  needsSchedule3,
  schedule3Blockers,
  schedule3Checks,
  schedule3ItemsFor,
  unexplainedGaps,
  type Schedule3Record,
} from '../src/index.js';

const asOf = '2026-11-06';
const full: Schedule3Record[] = [
  { kind: 'RIGHT_TO_WORK', data: { checkedOn: '2026-01-10', checkType: 'MANUAL_DOCUMENT' } },
  {
    kind: 'DBS',
    data: {
      eligibility: 'ENHANCED_BARRED',
      barredListChecked: true,
      issueDate: '2026-01-05',
      riskDecision: 'ACCEPTED',
    },
  },
  { kind: 'REFERENCE', data: { outcome: 'SATISFACTORY' } },
  { kind: 'REFERENCE', data: { outcome: 'SATISFACTORY' } },
  {
    kind: 'EMPLOYMENT_HISTORY',
    data: {
      employer: 'Care Co',
      from: '2020-01-01',
      to: '2025-12-31',
      careRole: true,
      reasonForLeaving: 'Moved area',
    },
  },
  { kind: 'EMPLOYMENT_HISTORY', data: { employer: 'Meadowbank', from: '2026-01-01' } },
  { kind: 'REGISTRATION', data: { body: 'HCPC', expiresOn: '2027-06-30' } },
  { kind: 'OH_CLEARANCE', data: { fitStatus: 'FIT' } },
];
const allVerified = {
  IDENTITY: { title: 'Right to work', verified: true },
  RIGHT_TO_WORK: { title: 'Right to work', verified: true },
  DBS: { title: 'DBS', verified: true },
  CONDUCT_REFERENCES: { title: 'References', verified: true },
  REASON_FOR_LEAVING: { title: 'References', verified: true },
  EMPLOYMENT_HISTORY: { title: 'References', verified: true },
  QUALIFICATIONS: { title: 'Registration', verified: true },
  HEALTH: { title: 'OH clearance', verified: true },
};
type Check = ReturnType<typeof schedule3Checks>[number];
const byItem = (records: Schedule3Record[], evidence = allVerified) =>
  Object.fromEntries(
    schedule3Checks({ records, asOf, evidence }).map((c) => [c.item, c]),
  ) as Record<Check['item'], Check>;

describe('Schedule 3 checks (reg 19)', () => {
  it('is complete only when every item is recorded and its evidence verified', () => {
    const checks = schedule3Checks({ records: full, asOf, evidence: allVerified });
    expect(checks).toHaveLength(8);
    expect(checks.every((c) => c.state === 'COMPLETE' && c.status === 'GREEN')).toBe(true);
  });

  it('a record without verified evidence is amber, never green', () => {
    const c = byItem(full, { ...allVerified, DBS: { title: 'DBS', verified: false } });
    expect(c.DBS.state).toBe('RECORDED_UNVERIFIED');
    expect(c.DBS.status).toBe('AMBER');
    expect(c.DBS.reasonText).toMatch(/not yet verified/);
  });

  it('missing records are red with words', () => {
    const c = byItem([]);
    for (const item of Object.values(c)) {
      expect(item.state).toBe('MISSING');
      expect(item.status).toBe('RED');
      expect(item.reasonText.length).toBeGreaterThan(5);
    }
  });

  it('needs an enhanced DBS and the barred list check', () => {
    const basic = full.map((r) =>
      r.kind === 'DBS' ? { ...r, data: { ...r.data, eligibility: 'STANDARD' } } : r,
    );
    expect(byItem(basic).DBS.state).toBe('ATTENTION');
    const noBarred = full.map((r) =>
      r.kind === 'DBS' ? { ...r, data: { ...r.data, barredListChecked: false } } : r,
    );
    expect(byItem(noBarred).DBS.reasonText).toMatch(/barred list/);
  });

  it('needs two satisfactory references, or one with an approved alternative', () => {
    const one = full.filter((r, i) => !(r.kind === 'REFERENCE' && i === 3));
    expect(byItem(one).CONDUCT_REFERENCES.state).toBe('ATTENTION');
    const withRationale = one.map((r) =>
      r.kind === 'REFERENCE'
        ? { ...r, data: { ...r.data, alternativeRationale: 'Only one employer' } }
        : r,
    );
    expect(byItem(withRationale).CONDUCT_REFERENCES.state).toBe('ATTENTION');
    const approved = withRationale.map((r) =>
      r.kind === 'REFERENCE' ? { ...r, data: { ...r.data, alternativeApprovedByUserId: 'u1' } } : r,
    );
    expect(byItem(approved).CONDUCT_REFERENCES.state).toBe('COMPLETE');
  });

  it('an unsatisfactory reference blocks until a further reference makes two [B1]', () => {
    const bad = [
      ...full.filter((r, i) => !(r.kind === 'REFERENCE' && i === 3)),
      { kind: 'REFERENCE', data: { outcome: 'UNSATISFACTORY' } },
    ];
    expect(byItem(bad).CONDUCT_REFERENCES.reasonText).toMatch(/further reference/);
    expect(byItem(bad).CONDUCT_REFERENCES.state).toBe('ATTENTION');
    const further = [...bad, { kind: 'REFERENCE', data: { outcome: 'SATISFACTORY' } }];
    expect(byItem(further).CONDUCT_REFERENCES.state).toBe('COMPLETE');
  });

  it('a DBS disclosure blocks until a named manager records a risk decision [B1]', () => {
    const disclosed = full.map((r) =>
      r.kind === 'DBS'
        ? {
            ...r,
            data: { ...r.data, disclosure: 'INFORMATION_DISCLOSED', riskDecision: 'PENDING' },
          }
        : r,
    );
    expect(byItem(disclosed).DBS.state).toBe('ATTENTION');
    const decided = disclosed.map((r) =>
      r.kind === 'DBS'
        ? {
            ...r,
            data: {
              ...r.data,
              riskDecision: 'ACCEPTED_WITH_RISK_ASSESSMENT',
              riskDecisionByUserId: 'u2',
            },
          }
        : r,
    );
    expect(byItem(decided).DBS.state).toBe('COMPLETE');
  });

  it('a time-limited right to work blocks after the end date [B1]', () => {
    const limited = (ends: string) =>
      full.map((r) =>
        r.kind === 'RIGHT_TO_WORK' ? { ...r, data: { ...r.data, permissionEndsOn: ends } } : r,
      );
    expect(byItem(limited('2027-03-31')).RIGHT_TO_WORK.reasonText).toMatch(/time-limited/);
    expect(byItem(limited('2027-03-31')).RIGHT_TO_WORK.state).toBe('COMPLETE');
    expect(byItem(limited('2026-11-05')).RIGHT_TO_WORK.state).toBe('ATTENTION');
  });

  it('uses the identity record when held [B1]', () => {
    const id = { kind: 'IDENTITY', data: { checkedOn: '2026-01-10', photoMatches: false } };
    expect(byItem([...full, id]).IDENTITY.state).toBe('ATTENTION');
    const ok = { kind: 'IDENTITY', data: { checkedOn: '2026-01-10', photoMatches: true } };
    expect(byItem([...full, ok]).IDENTITY.reasonText).toMatch(/Photo identity checked/);
  });

  it('flags a care role that ended without a recorded reason', () => {
    const noReason = full.map((r) =>
      r.data.employer === 'Care Co'
        ? { ...r, data: { ...r.data, reasonForLeaving: undefined } }
        : r,
    );
    const c = byItem(noReason).REASON_FOR_LEAVING;
    expect(c.state).toBe('ATTENTION');
    expect(c.reasonText).toMatch(/Care Co/);
  });

  it('flags lapsed registration, overdue health review and right to work follow-up', () => {
    const stale = full.map((r) =>
      r.kind === 'REGISTRATION'
        ? { ...r, data: { ...r.data, expiresOn: '2026-10-01' } }
        : r.kind === 'OH_CLEARANCE'
          ? { ...r, data: { ...r.data, reviewOn: '2026-11-01' } }
          : r.kind === 'RIGHT_TO_WORK'
            ? { ...r, data: { ...r.data, followUpOn: '2026-11-05' } }
            : r,
    );
    const c = byItem(stale);
    expect(c.QUALIFICATIONS.state).toBe('ATTENTION');
    expect(c.HEALTH.state).toBe('ATTENTION');
    expect(c.RIGHT_TO_WORK.state).toBe('ATTENTION');
  });

  it('ignores a gap of under three months [B1]', () => {
    expect(
      unexplainedGaps([
        { employer: 'A', from: '2020-01-01', to: '2021-01-31' },
        { employer: 'B', from: '2021-04-15' },
      ]),
    ).toEqual([]);
  });

  it('a role held during a longer one does not shorten the period covered', () => {
    expect(
      unexplainedGaps([
        { employer: 'A', from: '2018-01-01', to: '2022-12-31' },
        { employer: 'B', from: '2019-01-01', to: '2020-01-01' },
        { employer: 'C', from: '2023-01-01' },
      ]),
    ).toEqual([]);
  });

  it('finds gaps over three months that have no explanation', () => {
    const gaps = unexplainedGaps([
      { employer: 'A', from: '2020-01-01', to: '2021-01-31' },
      { employer: 'B', from: '2021-06-01', to: '2022-01-01' },
      { employer: 'C', from: '2022-01-20', to: '2023-01-01' },
      { employer: 'D', from: '2023-06-01', gapExplanation: 'Travelling' },
    ]);
    expect(gaps).toEqual([{ from: '2021-02-01', to: '2021-05-31' }]);
  });

  it('maps requirement templates to items', () => {
    expect(schedule3ItemsFor('STF-02', 'Enhanced DBS')).toEqual(['DBS']);
    expect(schedule3ItemsFor('STF-03', 'Right to work')).toEqual(['RIGHT_TO_WORK', 'IDENTITY']);
    expect(schedule3ItemsFor('STF-04', 'References')).toEqual([
      'CONDUCT_REFERENCES',
      'REASON_FOR_LEAVING',
      'EMPLOYMENT_HISTORY',
    ]);
    expect(schedule3ItemsFor('STF-99', 'Fire safety training')).toEqual([]);
    expect(schedule3ItemsFor('STF-09', 'Professional registration')).toEqual(['QUALIFICATIONS']);
    expect(schedule3ItemsFor('STF-10', 'Care Certificate qualification')).toEqual([
      'QUALIFICATIONS',
    ]);
    expect(schedule3ItemsFor('STF-11', 'Occupational health clearance')).toEqual(['HEALTH']);
    expect(schedule3ItemsFor('OH', 'Pre-employment check')).toEqual(['HEALTH']);
  });
});

describe('Schedule 3 item details (reg 19)', () => {
  /** `full` with every record of `kind` replaced by `records`. */
  const replace = (kind: string, ...data: Record<string, unknown>[]): Schedule3Record[] => [
    ...full.filter((r) => r.kind !== kind),
    ...data.map((d) => ({ kind, data: d })),
  ];

  it('a right to work follow-up still to come is shown with the check', () => {
    const c = byItem(
      replace('RIGHT_TO_WORK', { checkedOn: '2026-01-10', followUpOn: '2027-01-10' }),
    ).RIGHT_TO_WORK;
    expect(c.state).toBe('COMPLETE');
    expect(c.reasonText).toBe('Checked 2026-01-10; follow-up due 2027-01-10');
  });

  it('an expired identity document needs attention; one still in date is met', () => {
    const expired = { checkedOn: '2026-01-10', photoMatches: true, documentExpiry: '2026-10-01' };
    expect(byItem([...full, { kind: 'IDENTITY', data: expired }]).IDENTITY).toMatchObject({
      state: 'ATTENTION',
      status: 'RED',
      reasonText: 'The identity document expired 2026-10-01',
    });
    const current = { ...expired, documentExpiry: '2030-01-01' };
    expect(byItem([...full, { kind: 'IDENTITY', data: current }]).IDENTITY.state).toBe('COMPLETE');
  });

  it('a DBS result that was not accepted needs attention', () => {
    const c = byItem(replace('DBS', { eligibility: 'ENHANCED', riskDecision: 'NOT_ACCEPTED' })).DBS;
    expect(c).toMatchObject({ state: 'ATTENTION', reasonText: 'DBS result not accepted' });
  });

  it('a disclosure accepted without a risk assessment, or without a named manager, still blocks', () => {
    const disclosed = {
      eligibility: 'ENHANCED',
      issueDate: '2026-01-05',
      disclosure: 'INFORMATION_DISCLOSED',
    };
    const message = 'The certificate discloses information: a manager must record a risk decision';
    expect(byItem(replace('DBS', { ...disclosed, riskDecision: 'ACCEPTED' })).DBS.reasonText).toBe(
      message,
    );
    expect(
      byItem(replace('DBS', { ...disclosed, riskDecision: 'ACCEPTED_WITH_RISK_ASSESSMENT' })).DBS
        .reasonText,
    ).toBe(message);
    expect(
      byItem(
        replace('DBS', {
          ...disclosed,
          riskDecision: 'ACCEPTED_WITH_RISK_ASSESSMENT',
          riskDecisionByUserId: 'user-7',
        }),
      ).DBS.reasonText,
    ).toBe('Enhanced DBS issued 2026-01-05, accepted with a risk assessment');
  });

  it('counts references still awaited', () => {
    const c = byItem(
      replace('REFERENCE', { outcome: 'SATISFACTORY' }, { outcome: 'PENDING' }),
    ).CONDUCT_REFERENCES;
    expect(c).toMatchObject({
      state: 'ATTENTION',
      reasonText: '1 of 2 satisfactory references; 1 awaited',
    });
  });

  it('an unexplained gap in the employment history needs attention, naming the dates', () => {
    const c = byItem(
      replace(
        'EMPLOYMENT_HISTORY',
        { employer: 'Care Co', from: '2018-01-01', to: '2019-01-31' },
        { employer: 'Meadowbank', from: '2020-01-01' },
      ),
    ).EMPLOYMENT_HISTORY;
    expect(c).toMatchObject({
      state: 'ATTENTION',
      reasonText: 'Unexplained gap(s): 2019-02-01 to 2019-12-31',
    });
  });

  it('with no earlier care roles there is no reason for leaving to record', () => {
    const c = byItem(
      replace('EMPLOYMENT_HISTORY', {
        employer: 'Retail Co',
        from: '2020-01-01',
        to: '2025-12-31',
      }),
    ).REASON_FOR_LEAVING;
    expect(c).toMatchObject({
      state: 'COMPLETE',
      reasonText: 'No earlier work with children or vulnerable adults recorded',
    });
  });

  it('counts registrations and training records as qualifications', () => {
    const trainingOnly = [
      ...full.filter((r) => r.kind !== 'REGISTRATION'),
      { kind: 'TRAINING', data: { title: 'Care Certificate' } },
    ];
    expect(byItem(trainingOnly).QUALIFICATIONS.reasonText).toBe(
      '1 qualification or training record(s)',
    );
    expect(
      byItem([...full, { kind: 'TRAINING', data: { title: 'Care Certificate' } }]).QUALIFICATIONS
        .reasonText,
    ).toBe('1 registration(s), 1 qualification or training record(s)');
  });

  it('health clearance: pending and unfit need attention; fit with adjustments is met', () => {
    const health = (fitStatus: string) => byItem(replace('OH_CLEARANCE', { fitStatus })).HEALTH;
    expect(health('PENDING')).toMatchObject({
      state: 'ATTENTION',
      reasonText: 'Health clearance pending',
    });
    expect(health('UNFIT')).toMatchObject({
      state: 'ATTENTION',
      reasonText: 'Assessed as not fit for duty',
    });
    expect(health('FIT_WITH_ADJUSTMENTS')).toMatchObject({
      state: 'COMPLETE',
      reasonText: 'Fit with adjustments',
    });
  });
});

describe('driver eligibility', () => {
  const licence = {
    categories: ['B', 'C1'],
    photocardExpiry: '2030-01-01',
    lastCheckedOn: '2026-09-01',
    penaltyPoints: 0,
  };
  const base = {
    licence,
    licenceVerified: true,
    roleApproved: true,
    noDrivingRestriction: false,
    category: 'C1',
    asOf,
  };
  const failed = (r: ReturnType<typeof driverEligibility>) =>
    r.checks.filter((c) => c.result === 'FAIL').map((c) => c.code);

  it('is eligible when every check passes', () => {
    const r = driverEligibility(base);
    expect(r.eligible).toBe(true);
    expect(failed(r)).toEqual([]);
  });

  it('fails without the category, with an expired photocard or a stale DVLA check', () => {
    expect(failed(driverEligibility({ ...base, category: 'D1' }))).toEqual(['LICENCE_CATEGORY']);
    const old = { ...licence, photocardExpiry: '2026-01-01', lastCheckedOn: '2026-01-01' };
    expect(failed(driverEligibility({ ...base, licence: old }))).toEqual([
      'PHOTOCARD_IN_DATE',
      'DVLA_CHECK_RECENT',
    ]);
    expect(
      driverEligibility({ ...base, licence: old, policy: { recheckMonths: 12 } }).checks.find(
        (c) => c.code === 'DVLA_CHECK_RECENT',
      )?.result,
    ).toBe('PASS');
  });

  it('fails without the role, with a driving restriction, or unverified licence', () => {
    const r = driverEligibility({
      ...base,
      roleApproved: false,
      noDrivingRestriction: true,
      licenceVerified: false,
    });
    expect(r.eligible).toBe(false);
    expect(failed(r)).toEqual(['ROLE_APPROVED', 'NO_DRIVING_RESTRICTION', 'LICENCE_VERIFIED']);
  });

  it('fails with no licence on record', () => {
    expect(failed(driverEligibility({ ...base, licence: null }))).toContain('LICENCE_RECORD');
  });

  it('penalty points only warn', () => {
    const r = driverEligibility({ ...base, licence: { ...licence, penaltyPoints: 9 } });
    expect(r.eligible).toBe(true);
    expect(r.checks.find((c) => c.code === 'PENALTY_POINTS')?.result).toBe('WARN');
  });
});

describe('Schedule 3 approval gate [task 18]', () => {
  it('applies to regulated roles only', () => {
    expect(needsSchedule3('CARE_ASSISTANT')).toBe(true);
    expect(needsSchedule3('DENTIST')).toBe(true);
    expect(needsSchedule3('MANAGER')).toBe(false);
    expect(needsSchedule3('RECEPTIONIST')).toBe(false);
  });

  it('blocks on missing items and on unverified evidence, not on items nobody holds', () => {
    const none = schedule3Checks({ records: [], asOf, evidence: {} });
    expect(schedule3Blockers(none)).toHaveLength(8);
    const complete = schedule3Checks({ records: full, asOf, evidence: allVerified });
    expect(schedule3Blockers(complete)).toEqual([]);
    const unheld = schedule3Checks({ records: full, asOf, evidence: {} });
    expect(unheld.every((c) => c.state === 'RECORDED_UNVERIFIED')).toBe(true);
    expect(schedule3Blockers(unheld)).toEqual([]);
    const waiting = schedule3Checks({
      records: full,
      asOf,
      evidence: { ...allVerified, DBS: { title: 'DBS', verified: false } },
    });
    expect(schedule3Blockers(waiting).map((c) => c.item)).toEqual(['DBS']);
  });
});

describe('licence category from vehicle weight [finding 89]', () => {
  it('needs C1 above 3,500 kg and C above 7,500 kg', () => {
    expect(drivingCategoryFor('B', 3500)).toBe('B');
    expect(drivingCategoryFor('B', 3501)).toBe('C1');
    expect(drivingCategoryFor('B', 4250)).toBe('C1');
    expect(drivingCategoryFor('C1', 4250)).toBe('C1');
    expect(drivingCategoryFor('B', 7600)).toBe('C');
    expect(drivingCategoryFor('B', null)).toBe('B');
    expect(drivingCategoryFor('D1', 5000)).toBe('D1');
  });

  it('a B-only driver is not eligible for a heavy ambulance', () => {
    const r = driverEligibility({
      licence: {
        categories: ['B'],
        photocardExpiry: '2030-01-01',
        lastCheckedOn: '2026-09-01',
        penaltyPoints: 0,
      },
      licenceVerified: true,
      roleApproved: true,
      noDrivingRestriction: false,
      category: drivingCategoryFor('B', 4250),
      asOf,
    });
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.code === 'LICENCE_CATEGORY')?.result).toBe('FAIL');
  });
});
