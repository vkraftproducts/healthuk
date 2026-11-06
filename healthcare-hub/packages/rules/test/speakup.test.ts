import { describe, expect, it } from 'vitest';
import {
  detrimentCheckDue,
  harassmentDutySteps,
  speakUpAcknowledgeDue,
  speakUpCloseBlocker,
  type HarassmentDutyInput,
} from '../src/index.js';

const asOf = '2026-11-06';
const good: HarassmentDutyInput = {
  asOf,
  assessment: { approvedOn: '2026-09-01', reviewDue: '2027-09-01' },
  hasDraftAssessment: false,
  policy: { title: 'Harassment and bullying policy', reviewDate: '2027-06-01' },
  training: { title: 'Preventing sexual harassment', required: 10, met: 10 },
  overdueAcknowledgements: 0,
  overdueDetrimentChecks: 0,
};
const status = (i: HarassmentDutyInput) =>
  Object.fromEntries(harassmentDutySteps(i).map((s) => [s.step, s.status]));

describe('speaking up', () => {
  it('acknowledgement is due in 7 days and the detriment check 90 days after closing', () => {
    expect(speakUpAcknowledgeDue('2026-11-06')).toBe('2026-11-13');
    expect(detrimentCheckDue('2026-11-06')).toBe('2027-02-04');
  });

  it('a named concern needs feedback recorded before it closes; anonymous ones do not', () => {
    expect(
      speakUpCloseBlocker({ status: 'RECEIVED', anonymous: false, feedbackGivenOn: null }),
    ).toMatch(/Acknowledge/);
    expect(
      speakUpCloseBlocker({ status: 'INVESTIGATING', anonymous: false, feedbackGivenOn: null }),
    ).toMatch(/feedback/);
    expect(
      speakUpCloseBlocker({ status: 'INVESTIGATING', anonymous: true, feedbackGivenOn: null }),
    ).toBeNull();
    expect(
      speakUpCloseBlocker({ status: 'ACKNOWLEDGED', anonymous: false, feedbackGivenOn: asOf }),
    ).toBeNull();
    expect(
      speakUpCloseBlocker({ status: 'CLOSED', anonymous: false, feedbackGivenOn: asOf }),
    ).toMatch(/already closed/);
  });
});

describe('harassment prevention steps', () => {
  it('all green when every step the hub can see is in place, always with words', () => {
    const steps = harassmentDutySteps(good);
    expect(steps.map((s) => s.status)).toEqual(['GREEN', 'GREEN', 'GREEN', 'GREEN', 'GREEN']);
    for (const s of steps) expect(s.reasonText.length).toBeGreaterThan(5);
  });

  it('no assessment is red; a draft is amber; an overdue review is red', () => {
    expect(status({ ...good, assessment: null }).RISK_ASSESSMENT).toBe('RED');
    expect(status({ ...good, assessment: null, hasDraftAssessment: true }).RISK_ASSESSMENT).toBe(
      'AMBER',
    );
    expect(
      status({ ...good, assessment: { approvedOn: '2025-01-01', reviewDue: '2026-01-01' } })
        .RISK_ASSESSMENT,
    ).toBe('RED');
  });

  it('policy, training and concern handling each show their own gap', () => {
    const s = status({
      ...good,
      policy: { title: 'Harassment policy', reviewDate: '2026-01-01' },
      training: { title: 'Harassment training', required: 10, met: 7 },
      overdueAcknowledgements: 2,
      overdueDetrimentChecks: 1,
    });
    expect(s).toEqual({
      RISK_ASSESSMENT: 'GREEN',
      POLICY: 'AMBER',
      TRAINING: 'AMBER',
      CONCERNS_ACKNOWLEDGED: 'RED',
      DETRIMENT_CHECKS: 'AMBER',
    });
    expect(status({ ...good, policy: null, training: null })).toMatchObject({
      POLICY: 'RED',
      TRAINING: 'RED',
    });
  });

  it('training mapped to no one yet is grey, not green', () => {
    const steps = harassmentDutySteps({
      ...good,
      training: { title: 'Preventing sexual harassment', required: 0, met: 0 },
    });
    expect(steps.find((s) => s.step === 'TRAINING')).toMatchObject({
      status: 'GREY',
      reasonText: '"Preventing sexual harassment" applies to nobody yet',
    });
  });

  it('concern steps are grey for someone who cannot see concerns', () => {
    const s = status({ ...good, overdueAcknowledgements: null, overdueDetrimentChecks: null });
    expect(s.CONCERNS_ACKNOWLEDGED).toBe('GREY');
    expect(s.DETRIMENT_CHECKS).toBe('GREY');
  });
});
