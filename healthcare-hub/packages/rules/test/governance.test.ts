import { describe, expect, it } from 'vitest';
import {
  ackState,
  auditOutcome,
  candourFlag,
  checkEventTransition,
  complaintTargets,
  needsAction,
  repeatedSelections,
  riskBandText,
  riskRating,
  summariseControl,
} from '../src/index.js';

describe('audit controls', () => {
  it('AC-07 with 4 pass and 1 fail is non-compliant (US-COMP-1)', () => {
    const s = summariseControl([
      'COMPLIANT',
      'COMPLIANT',
      'COMPLIANT',
      'COMPLIANT',
      'NON_COMPLIANT',
    ]);
    expect(s).toMatchObject({
      pass: 4,
      fail: 1,
      result: 'NON_COMPLIANT',
      severity: 'HIGH',
      text: '4 pass / 1 fail',
    });
    expect(summariseControl(['NON_COMPLIANT'], true).severity).toBe('CRITICAL');
  });
  it('worst result wins, with every count shown', () => {
    expect(summariseControl(['COMPLIANT', 'PARTIAL', 'NOT_APPLICABLE'])).toMatchObject({
      result: 'PARTIAL',
      severity: 'MEDIUM',
      text: '1 pass / 1 partial / 0 fail / 1 not applicable',
    });
    expect(summariseControl(['COMPLIANT', 'NOT_ASSESSED'])).toMatchObject({
      result: 'NOT_ASSESSED',
      severity: 'LOW',
      text: '1 pass / 0 fail / 1 not assessed',
    });
    expect(summariseControl(['COMPLIANT']).result).toBe('COMPLIANT');
    expect(summariseControl(['NOT_APPLICABLE']).result).toBe('NOT_APPLICABLE');
    expect(needsAction('PARTIAL')).toBe(true);
    expect(needsAction('COMPLIANT')).toBe(false);
  });
  it('outcome stays RED until actions are verified; evidence alone does not close (UAT-04)', () => {
    const fail = [{ result: 'NON_COMPLIANT' as const, severity: 'HIGH' as const }];
    expect(auditOutcome(fail, [])).toMatchObject({
      status: 'RED',
      reason: 'Action required',
      closed: false,
    });
    expect(auditOutcome(fail, [{ status: 'EVIDENCE_SUBMITTED', severity: 'HIGH' }])).toMatchObject({
      status: 'RED',
      reason: 'Action outstanding',
    });
    expect(auditOutcome(fail, [{ status: 'OPEN', severity: 'LOW' }])).toMatchObject({
      status: 'AMBER',
    });
    expect(
      auditOutcome(fail, [
        { status: 'VERIFIED', severity: 'HIGH' },
        { status: 'OPEN', severity: 'MEDIUM', kind: 'REAUDIT' },
      ]),
    ).toMatchObject({ status: 'GREEN', reason: 'Actions verified', closed: true });
    expect(auditOutcome([{ result: 'NOT_ASSESSED', severity: 'LOW' }], [])).toMatchObject({
      status: 'GREY',
    });
    expect(auditOutcome([{ result: 'COMPLIANT', severity: 'LOW' }], [])).toMatchObject({
      status: 'GREEN',
      reason: 'Compliant',
    });
  });
  it('warns about repeatedly sampled subjects (AUD-02)', () => {
    expect(repeatedSelections(['a', 'b', 'c'], [['b'], ['x', 'c']])).toEqual(['b', 'c']);
  });
});

describe('risk, policy, events', () => {
  it.each([
    [1, 4, 'LOW'],
    [1, 5, 'MEDIUM'],
    [2, 5, 'HIGH'],
    [4, 5, 'EXTREME'],
  ] as const)('likelihood %i x impact %i is %s', (l, i, r) =>
    expect(riskRating(l, i).rating).toBe(r),
  );

  it('policy acknowledgement carries forward only across non-material changes', () => {
    const v = (id: string, material: boolean) => ({ id, material });
    expect(ackState([], new Set())).toBe('NO_PUBLISHED_VERSION');
    expect(ackState([v('3', true)], new Set(['3']))).toBe('CURRENT');
    expect(ackState([v('3', false), v('2', true)], new Set(['2']))).toBe('CARRIED_FORWARD');
    expect(ackState([v('3', false), v('2', false), v('1', true)], new Set(['1']))).toBe(
      'CARRIED_FORWARD',
    );
    expect(ackState([v('3', true), v('2', true)], new Set(['2']))).toBe('REQUIRED');
    expect(ackState([v('3', false), v('2', true)], new Set())).toBe('REQUIRED');
    expect(ackState([v('3', false)], new Set())).toBe('REQUIRED');
  });

  it('events move one step at a time with gates', () => {
    const base = {
      pendingObligations: 0,
      candourFlagged: false,
      candourDecided: false,
      openActions: 0,
    };
    expect(checkEventTransition({ ...base, from: 'TRIAGE', to: 'PROTECT' })).toBeNull();
    expect(checkEventTransition({ ...base, from: 'TRIAGE', to: 'ASSESS' })).toBe('NOT_ALLOWED');
    expect(checkEventTransition({ ...base, from: 'CLOSED', to: 'LEARNING_VERIFIED' })).toBe(
      'NOT_ALLOWED',
    );
    expect(
      checkEventTransition({ ...base, from: 'INVESTIGATE', to: 'ASSESS', pendingObligations: 3 }),
    ).toBeNull();
    expect(
      checkEventTransition({ ...base, from: 'ASSESS', to: 'INVESTIGATE', pendingObligations: 1 }),
    ).toBe('OBLIGATIONS_UNDECIDED');
    expect(
      checkEventTransition({ ...base, from: 'ASSESS', to: 'INVESTIGATE', candourFlagged: true }),
    ).toBe('CANDOUR_UNDECIDED');
    expect(
      checkEventTransition({
        ...base,
        from: 'ASSESS',
        to: 'INVESTIGATE',
        candourFlagged: true,
        candourDecided: true,
      }),
    ).toBeNull();
    expect(
      checkEventTransition({ ...base, from: 'ACTIONS', to: 'LEARNING_VERIFIED', openActions: 2 }),
    ).toBe('ACTIONS_OPEN');
  });

  it('flags (never decides) duty of candour; complaint targets come from policy', () => {
    expect(candourFlag('MODERATE', ['INCIDENT'])).toBe(true);
    expect(candourFlag('LOW', ['INCIDENT'])).toBe(false);
    expect(candourFlag('SEVERE', ['COMPLAINT'])).toBe(false);
    expect(complaintTargets('2026-10-30', { acknowledgeDays: 3, respondDays: 28 })).toEqual({
      acknowledgeBy: '2026-11-02',
      respondBy: '2026-11-27',
    });
  });

  it('shows the risk band in words with its score (H4)', () => {
    expect(riskBandText(1, 3)).toBe('Low 3');
    expect(riskBandText(1, 5)).toBe('Medium 5');
    expect(riskBandText(4, 4)).toBe('High 16');
    expect(riskBandText(4, 5)).toBe('Extreme 20');
  });

  describe('optional event gates (H1)', () => {
    const base = {
      pendingObligations: 0,
      candourFlagged: false,
      candourDecided: false,
      openActions: 0,
    };

    it('cannot leave triage when triage is recorded as not done; unknown triage does not block', () => {
      expect(checkEventTransition({ ...base, from: 'TRIAGE', to: 'PROTECT', triaged: false })).toBe(
        'NOT_TRIAGED',
      );
      expect(checkEventTransition({ ...base, from: 'TRIAGE', to: 'PROTECT', triaged: true })).toBe(
        null,
      );
    });

    it('cannot leave investigation without a PSIRF learning response when one is needed', () => {
      const step = { ...base, from: 'INVESTIGATE', to: 'RESPOND' } as const;
      expect(checkEventTransition({ ...step, learningResponseMissing: true })).toBe(
        'LEARNING_RESPONSE_MISSING',
      );
      expect(checkEventTransition({ ...step, learningResponseMissing: false })).toBeNull();
      expect(checkEventTransition(step)).toBeNull();
    });

    it('cannot close with candour steps or reporting decisions outstanding', () => {
      const close = { ...base, from: 'LEARNING_VERIFIED', to: 'CLOSED' } as const;
      expect(checkEventTransition({ ...close, candourStepsOutstanding: 2 })).toBe(
        'CANDOUR_INCOMPLETE',
      );
      expect(checkEventTransition({ ...close, pendingObligations: 1 })).toBe(
        'OBLIGATIONS_UNDECIDED',
      );
      expect(checkEventTransition({ ...close, candourStepsOutstanding: 0 })).toBeNull();
      expect(checkEventTransition(close)).toBeNull();
    });
  });
});
