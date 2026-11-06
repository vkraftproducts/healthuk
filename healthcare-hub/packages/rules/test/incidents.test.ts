import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  complaintTargetsWorking,
  eventTypesFor,
  incidentCloseBlockers,
  isWorkingDay,
  mergeObligation,
  suggestObligations,
  triageDueAt,
  type ObligationSuggestion,
  type SuggestInput,
} from '../src/index.js';

const at = (iso: string) => new Date(iso);

describe('working days in England and Wales', () => {
  it('weekends and bank holidays are not working days', () => {
    expect(isWorkingDay('2026-11-06')).toBe(true); // Friday
    expect(isWorkingDay('2026-11-07')).toBe(false); // Saturday
    expect(isWorkingDay('2026-11-08')).toBe(false); // Sunday
    expect(isWorkingDay('2026-12-25')).toBe(false); // Christmas Day, a Friday
    expect(isWorkingDay('2026-12-28')).toBe(false); // substitute Boxing Day, a Monday
  });

  it('counts forward over weekends and the Christmas bank holidays, not counting the start day', () => {
    expect(addWorkingDays('2026-11-06', 0)).toBe('2026-11-06');
    expect(addWorkingDays('2026-11-06', 1)).toBe('2026-11-09');
    expect(addWorkingDays('2026-12-24', 1)).toBe('2026-12-29');
  });

  it('triage is due by the end of the next working day on the London clock', () => {
    // Reported on a Friday afternoon: due at the end of Monday (GMT).
    expect(triageDueAt(at('2026-11-06T16:00:00Z')).toISOString()).toBe('2026-11-09T23:59:59.999Z');
    // 23:30 UTC on Thursday is 00:30 BST on Friday, so the next working day is Monday (BST).
    expect(triageDueAt(at('2026-07-02T23:30:00Z')).toISOString()).toBe('2026-07-06T22:59:59.999Z');
  });
});

describe('complaint targets in working days (H2)', () => {
  it('defaults to acknowledging in 3 working days and responding in 20', () => {
    expect(complaintTargetsWorking('2026-11-06')).toEqual({
      acknowledgeBy: '2026-11-11',
      respondBy: '2026-12-04',
    });
  });

  it('uses the organisation policy where set, and the default for anything it leaves out', () => {
    expect(
      complaintTargetsWorking('2026-11-06', { acknowledgeWorkingDays: 1, respondWorkingDays: 10 }),
    ).toEqual({ acknowledgeBy: '2026-11-09', respondBy: '2026-11-20' });
    expect(complaintTargetsWorking('2026-11-06', { acknowledgeWorkingDays: 2 })).toEqual({
      acknowledgeBy: '2026-11-10',
      respondBy: '2026-12-04',
    });
  });
});

describe('event types by sector (M)', () => {
  it('offers every type when the sector packs are unknown', () => {
    expect(eventTypesFor(null)).toEqual(expect.arrayContaining(['IRMER', 'DOLS']));
    expect(eventTypesFor(undefined)).toEqual(expect.arrayContaining(['IRMER', 'DOLS']));
  });
});

describe('reporting obligation suggestions (H1)', () => {
  const base: SuggestInput = {
    code: 'EVT-0042',
    types: ['INCIDENT'],
    harm: 'NO_HARM',
    category: null,
    nhsFunded: false,
    occurredAt: at('2026-11-05T14:00:00Z'),
    discoveredAt: at('2026-11-06T09:00:00Z'),
  };
  const suggest = (o: Partial<SuggestInput>) => suggestObligations({ ...base, ...o });
  const bodies = (o: Partial<SuggestInput>) => suggest(o).map((s) => s.body);
  const one = (o: Partial<SuggestInput>, body: string) => suggest(o).find((s) => s.body === body)!;
  const NEXT_DAY = '2026-11-07T23:59:59.999Z';

  it('suggests nothing for a no-harm incident on private work', () => {
    expect(suggest({})).toEqual([]);
  });

  it('a death is a CQC regulation 16 notification, prompted by the next day, with reference-only draft wording', () => {
    const cqc = one({ harm: 'DEATH' }, 'CQC');
    expect(cqc).toMatchObject({
      trigger: 'A person using the service died',
      basis: 'CQC (Registration) Regulations 2009, regulation 16',
      deadlineText: 'Without delay (the hub prompts by the next day)',
    });
    expect(cqc.deadlineAt!.toISOString()).toBe(NEXT_DAY);
    expect(cqc.draftText).toContain('Notification under regulation 16.');
    expect(cqc.draftText).toContain(
      'Event EVT-0042, death of a person using the service, on 5 Nov 2026.',
    );
    expect(cqc.draftText).toContain('job or booking references only, no names');
    expect(bodies({ harm: 'DEATH' })).toEqual(['CQC', 'INSURER']);
  });

  it('a serious injury is a CQC regulation 18 notification and may concern the insurer', () => {
    const cqc = one({ harm: 'SEVERE' }, 'CQC');
    expect(cqc.basis).toBe('CQC (Registration) Regulations 2009, regulation 18(2)(a)');
    expect(cqc.draftText).toContain('serious injury');
    expect(one({ harm: 'SEVERE' }, 'INSURER').trigger).toBe(
      'Serious harm that may lead to a claim',
    );
  });

  it('safeguarding, by type or by category, goes to CQC and the local safeguarding team within 24 hours', () => {
    for (const o of [{ types: ['SAFEGUARDING'] }, { types: [], category: 'SAFEGUARDING' }]) {
      expect(bodies(o)).toEqual(['CQC', 'SAFEGUARDING']);
      expect(one(o, 'CQC').basis).toContain('regulation 18(2)(e)');
      const sg = one(o, 'SAFEGUARDING');
      expect(sg.deadlineAt!.toISOString()).toBe('2026-11-07T09:00:00.000Z');
      expect(sg.draftText).toBeNull();
    }
  });

  it('a death with a safeguarding concern is one CQC suggestion naming both triggers', () => {
    const cqc = suggest({ harm: 'DEATH', types: ['SAFEGUARDING'] }).filter((s) => s.body === 'CQC');
    expect(cqc).toHaveLength(1);
    expect(cqc[0]!.trigger).toBe(
      'A person using the service died; Abuse or an allegation of abuse',
    );
    expect(cqc[0]!.basis).toContain('regulation 16; CQC (Registration)');
    expect(cqc[0]!.draftText).toContain('death of a person using the service');
    expect(cqc[0]!.deadlineAt!.toISOString()).toBe(NEXT_DAY);
  });

  it('unintended radiation exposure (IR(ME)R) is notified to CQC, by type or category', () => {
    for (const o of [{ types: ['IRMER'] }, { types: [], category: 'RADIATION' }]) {
      const cqc = one(o, 'CQC');
      expect(cqc.basis).toContain('Ionising Radiation (Medical Exposure) Regulations 2017');
      expect(cqc.draftText).toContain('Notification under IR(ME)R 2017 regulation 8.');
    }
  });

  it('a DoLS outcome is notified to CQC, by type or category', () => {
    for (const o of [{ types: ['DOLS'] }, { types: [], category: 'DOLS' }]) {
      const cqc = one(o, 'CQC');
      expect(cqc.basis).toContain('regulation 18(4A) and (4B)');
      expect(cqc.deadlineText).toBe('Without delay once the outcome is known');
    }
  });

  it('a work accident causing death or a specified injury is RIDDOR-reportable within 10 days', () => {
    for (const o of [
      { types: ['ACCIDENT'], harm: 'SEVERE' as const },
      { types: ['INCIDENT'], category: 'STAFF_INJURY', harm: 'DEATH' as const },
    ]) {
      const riddor = one(o, 'RIDDOR');
      expect(riddor.basis).toBe('RIDDOR 2013, regulations 4 and 6');
      expect(riddor.deadlineAt!.toISOString()).toBe('2026-11-15T23:59:59.999Z');
    }
  });

  it('a worker off for more than 7 days is RIDDOR-reportable within 15 days of the accident', () => {
    const riddor = one({ types: ['ACCIDENT'], harm: 'LOW', overSevenDayInjury: true }, 'RIDDOR');
    expect(riddor.basis).toBe('RIDDOR 2013, regulation 4(2)');
    expect(riddor.deadlineAt!.toISOString()).toBe('2026-11-20T23:59:59.999Z');
  });

  it('suggests no RIDDOR report without a work accident or a qualifying injury', () => {
    expect(bodies({ types: ['ACCIDENT'], harm: 'LOW' })).not.toContain('RIDDOR');
    expect(bodies({ harm: 'SEVERE' })).not.toContain('RIDDOR');
    expect(bodies({ category: 'EQUIPMENT', overSevenDayInjury: true })).not.toContain('RIDDOR');
  });

  it('a personal data breach goes to the ICO within 72 hours of discovery', () => {
    const ico = one({ category: 'DATA_BREACH' }, 'ICO');
    expect(ico.basis).toContain('UK GDPR Article 33');
    expect(ico.deadlineAt!.toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('a vehicle collision is for the insurer, with no fixed deadline', () => {
    const insurer = one({ category: 'VEHICLE_COLLISION', harm: 'LOW' }, 'INSURER');
    expect(insurer).toMatchObject({
      trigger: 'Vehicle collision',
      deadlineAt: null,
      deadlineText: 'As your policy requires',
    });
  });

  it('NHS-funded work: moderate or worse harm goes to the commissioner within 2 working days', () => {
    for (const harm of ['MODERATE', 'SEVERE', 'DEATH'] as const) {
      const c = one({ nhsFunded: true, types: ['COMPLAINT'], harm }, 'COMMISSIONER');
      expect(c.deadlineAt!.toISOString()).toBe('2026-11-10T23:59:59.999Z');
    }
    expect(bodies({ nhsFunded: true, types: ['COMPLAINT'], harm: 'LOW' })).toEqual([]);
    expect(bodies({ nhsFunded: false, harm: 'MODERATE' })).toEqual([]);
  });

  it('NHS-funded work: incidents, near misses and accidents are recorded on LFPSE', () => {
    for (const t of ['INCIDENT', 'NEAR_MISS', 'ACCIDENT'])
      expect(bodies({ nhsFunded: true, types: [t] })).toEqual(['LFPSE']);
    expect(bodies({ nhsFunded: true, types: ['COMPLAINT'] })).toEqual([]);
  });
});

describe('merging two suggestions for the same body', () => {
  const s = (o: Partial<ObligationSuggestion>): ObligationSuggestion => ({
    body: 'CQC',
    trigger: 'first',
    basis: 'basis one',
    deadlineAt: null,
    deadlineText: 'Without delay',
    draftText: null,
    ...o,
  });

  it('joins the triggers and bases and keeps the earliest deadline', () => {
    const merged = mergeObligation(
      s({ deadlineAt: at('2026-11-08T00:00:00Z') }),
      s({ trigger: 'second', basis: 'basis two', deadlineAt: at('2026-11-07T00:00:00Z') }),
    );
    expect(merged.trigger).toBe('first; second');
    expect(merged.basis).toBe('basis one; basis two');
    expect(merged.deadlineAt!.toISOString()).toBe('2026-11-07T00:00:00.000Z');
  });

  it('keeps whichever deadline exists when only one has one', () => {
    const d = at('2026-11-07T00:00:00Z');
    expect(mergeObligation(s({ deadlineAt: d }), s({})).deadlineAt).toBe(d);
    expect(mergeObligation(s({}), s({ deadlineAt: d })).deadlineAt).toBe(d);
    expect(mergeObligation(s({}), s({})).deadlineAt).toBeNull();
  });

  it('keeps the first draft wording, or the second when the first has none', () => {
    expect(mergeObligation(s({ draftText: 'A' }), s({ draftText: 'B' })).draftText).toBe('A');
    expect(mergeObligation(s({}), s({ draftText: 'B' })).draftText).toBe('B');
  });

  it('caps the joined trigger and basis at 500 characters', () => {
    const long = 'x'.repeat(400);
    const merged = mergeObligation(
      s({ trigger: long, basis: long }),
      s({ trigger: long, basis: long }),
    );
    expect(merged.trigger).toHaveLength(500);
    expect(merged.basis).toHaveLength(500);
  });
});

describe('incident close blockers', () => {
  const clear = {
    triaged: true,
    pendingObligations: 0,
    candourFlagged: true,
    candourDecision: true,
    candourStepsOutstanding: 0,
    openActions: 0,
    nhsFunded: true,
    learningRecorded: true,
  };

  it('nothing blocks once every duty is done', () => {
    expect(incidentCloseBlockers(clear)).toEqual([]);
    expect(incidentCloseBlockers({ ...clear, nhsFunded: false, learningRecorded: false })).toEqual(
      [],
    );
  });

  it('outstanding duty of candour steps block closing', () => {
    expect(incidentCloseBlockers({ ...clear, candourStepsOutstanding: 2 })).toEqual([
      '2 duty of candour step(s) not recorded',
    ]);
  });
});
