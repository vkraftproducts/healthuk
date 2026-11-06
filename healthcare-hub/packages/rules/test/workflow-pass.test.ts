import { describe, expect, it } from 'vitest';
import {
  auditOverallResult,
  auditProgress,
  canRunReport,
  candourOutstanding,
  complaintEscalationText,
  eventTypesFor,
  homePathFor,
  incidentCloseBlockers,
  needsSpecialist,
  templateState,
  unansweredControls,
} from '../src/index.js';

describe('G1 and G2 audit helpers', () => {
  it('dental and care home templates need a named specialist; ambulance does not', () => {
    expect(needsSpecialist('dental')).toBe(true);
    expect(needsSpecialist('care_home')).toBe(true);
    expect(needsSpecialist('ambulance')).toBe(false);
    expect(needsSpecialist(null)).toBe(false);
  });

  it('a retired template stays retired whatever its versions say', () => {
    const versions = [{ status: 'PUBLISHED' }];
    expect(templateState({ active: true, retired: true, versions })).toBe('RETIRED');
    expect(templateState({ active: true, retired: false, versions })).toBe('ACTIVE');
    expect(templateState({ active: false, retired: false, versions })).toBe('PUBLISHED');
    expect(templateState({ active: false, retired: false, versions: [] })).toBe('DRAFT');
  });

  it('progress counts answered controls and lists the rest', () => {
    const controls = [{ code: 'A' }, { code: 'B' }, { code: 'C' }];
    expect(unansweredControls(controls, ['A', 'A'])).toEqual(['B', 'C']);
    expect(auditProgress(controls, ['A'])).toEqual({ answered: 1, total: 3, percent: 33 });
    expect(auditProgress([], [])).toEqual({ answered: 0, total: 0, percent: 0 });
  });

  it('a failed critical control makes the whole audit non-compliant', () => {
    const r = auditOverallResult([
      { result: 'COMPLIANT', critical: false },
      { result: 'NON_COMPLIANT', critical: true },
    ]);
    expect(r).toEqual({
      result: 'NON_COMPLIANT',
      text: 'Non-compliant: a critical control failed',
    });
    expect(auditOverallResult([{ result: 'PARTIAL', critical: true }]).text).toBe(
      'Partly compliant',
    );
    expect(auditOverallResult([{ result: 'NOT_ASSESSED', critical: false }]).text).toBe(
      'Not fully assessed',
    );
  });
});

describe('H1, H2 and M incident helpers', () => {
  it('offers IR(ME)R only to dental and DoLS only to care homes', () => {
    expect(eventTypesFor(['ambulance'])).not.toContain('IRMER');
    expect(eventTypesFor(['ambulance'])).not.toContain('DOLS');
    expect(eventTypesFor(['dental'])).toContain('IRMER');
    expect(eventTypesFor(['care_home'])).toContain('DOLS');
    expect(eventTypesFor(['care_home'])).toContain('HARASSMENT');
  });

  it('no candour steps are outstanding until someone decides candour applies', () => {
    expect(candourOutstanding(null, [])).toEqual([]);
    expect(candourOutstanding(false, [])).toEqual([]);
    expect(candourOutstanding(true, ['TOLD_IN_PERSON', 'APOLOGY'])).toEqual([
      'WRITTEN_NOTICE',
      'SUPPORT_OFFERED',
      'FINDINGS_SHARED',
    ]);
  });

  it('explains every reason an incident cannot close yet, in words', () => {
    const blockers = incidentCloseBlockers({
      triaged: false,
      pendingObligations: 1,
      candourFlagged: true,
      candourDecision: null,
      candourStepsOutstanding: 0,
      openActions: 2,
      nhsFunded: true,
      learningRecorded: false,
    });
    expect(blockers).toEqual([
      'Triage has not been recorded',
      '1 reporting obligation(s) still need a decision',
      'The registered manager has not decided on duty of candour',
      '2 action(s) not yet verified',
      'NHS-funded work needs a PSIRF learning response recorded',
    ]);
  });

  it('names the right ombudsman for NHS and private complaints', () => {
    expect(complaintEscalationText(true)).toContain('PHSO');
    expect(complaintEscalationText(false)).toContain('ISCAS');
    expect(complaintEscalationText(false)).toContain('CQC does not resolve complaints');
  });
});

describe('Navigation home and report access', () => {
  it('sends inspectors to the inspection view and dispatchers to the planner', () => {
    expect(homePathFor(['inspection.view', 'dashboard.view'])).toBe('/inspection');
    expect(homePathFor(['inspection.view', 'compliance.audit.run', 'dashboard.view'])).toBe('/');
    expect(homePathFor(['jobs.allocate', 'dashboard.view'], ['ambulance'])).toBe('/planner');
    expect(homePathFor(['jobs.allocate', 'dashboard.view'], ['dental'])).toBe('/');
    expect(homePathFor(['crew.today.view'])).toBe('/me');
  });

  it('the NHS KPI report needs registration or audit access', () => {
    expect(canRunReport('NHS_KPI', ['reports.view', 'compliance.audit.view'], ['dental'])).toBe(
      true,
    );
    expect(canRunReport('NHS_KPI', ['reports.view', 'fleet.vehicle.view'], null)).toBe(false);
    expect(canRunReport('NHS_KPI', ['compliance.audit.view'], null)).toBe(false);
  });
});
