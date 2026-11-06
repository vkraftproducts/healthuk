import { describe, expect, it } from 'vitest';
import * as R from '../src/index.js';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-30T09:00:00Z');
const win = { start: at('2026-10-30T10:00:00Z'), end: at('2026-10-30T12:00:00Z') };
const input = (o: Partial<R.RequirementInput> = {}): R.RequirementInput => ({
  applicability: 'APPLICABLE',
  criticalFailure: false,
  deadline: null,
  verifiedEvidence: null,
  pendingEvidence: false,
  blocking: 'NONE',
  ...o,
});
const ev = (validFrom: string | null = '2026-01-01', validTo: string | null = null) => ({
  validFrom,
  validTo,
});

describe('dates', () => {
  it('validates and formats', () => {
    expect(() => R.assertISODate('2026-02-30')).toThrow(RangeError);
    expect(() => R.assertISODate('30/10/2026')).toThrow(RangeError);
    expect(R.formatDate('2026-11-12')).toBe('12 Nov 2026');
    expect(R.startOfLondonDay('2026-07-01').toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(R.compareDates('2026-01-02', '2026-01-01')).toBe(1);
  });
  it('converts London wall-clock times either side of the clock change', () => {
    expect(R.londonDateTime('2026-07-01', '09:30').toISOString()).toBe('2026-07-01T08:30:00.000Z');
    expect(R.londonDateTime('2026-12-01', '09:30').toISOString()).toBe('2026-12-01T09:30:00.000Z');
    expect(() => R.londonDateTime('2026-12-01', '25:00')).toThrow(RangeError);
    expect(R.londonTime(at('2026-07-01T08:30:00Z'))).toBe('09:30');
    expect(R.londonTime(at('2026-12-01T08:30:00Z'))).toBe('08:30');
  });
  it('counts calendar days across DST, not 24h blocks', () => {
    expect(R.daysUntil('2026-10-26', at('2026-10-24T23:30:00Z'))).toBe(1); // 00:30 BST 25 Oct → 26 Oct
    expect(R.daysUntil('2026-10-26', at('2026-10-24T22:30:00Z'))).toBe(2); // 23:30 BST 24 Oct, across the clock change
    expect(R.daysUntil('2026-10-29', at('2026-10-30T10:00:00Z'))).toBe(-1);
    expect(R.addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(R.addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(R.addMonths('2026-03-15', -3)).toBe('2025-12-15');
  });
  it('validAcrossWindow handles not-yet-valid and open bounds', () => {
    expect(R.validAcrossWindow({ validFrom: '2026-11-01' }, win)).toEqual({
      ok: false,
      reason: 'NOT_YET_VALID',
    });
    expect(R.validAcrossWindow({ validFrom: '2026-10-30', expiryDate: null }, win)).toEqual({
      ok: true,
    });
    expect(R.validAcrossWindow({}, win)).toEqual({ ok: true });
  });
});

describe('recurrence', () => {
  const m3 = { unit: 'MONTHS', every: 3 } as const;
  it('supports day intervals and rejects bad intervals', () => {
    expect(R.occurrence('2026-01-01', { unit: 'DAYS', every: 10 }, 2)).toBe('2026-01-21');
    expect(() => R.occurrence('2026-01-01', { unit: 'DAYS', every: 0 }, 1)).toThrow(RangeError);
  });
  it('skips occurrences already passed when late by more than one period', () => {
    expect(R.nextFixedCalendar('2026-01-01', m3, '2026-04-01')).toBe('2026-07-01');
  });
  it('nextDue covers every type and validates arguments', () => {
    expect(R.nextDue({ type: 'MILEAGE' })).toEqual({ kind: 'NONE', reason: 'MILEAGE_ONLY' });
    expect(R.nextDue({ type: 'EVENT_TRIGGERED' })).toEqual({
      kind: 'NONE',
      reason: 'EVENT_TRIGGERED',
    });
    expect(R.nextDue({ type: 'PER_SHIFT' })).toEqual({ kind: 'NONE', reason: 'PER_SHIFT' });
    expect(() => R.nextDue({ type: 'FIXED_CALENDAR' })).toThrow(TypeError);
    expect(() => R.nextDue({ type: 'FIXED_CALENDAR', interval: m3, anchor: '2026-01-01' })).toThrow(
      TypeError,
    );
    expect(() => R.nextDue({ type: 'COMPLETION_BASED' })).toThrow(TypeError);
    expect(() => R.nextDue({ type: 'COMPLETION_BASED', interval: m3 })).toThrow(TypeError);
  });
});

describe('evaluateRequirement', () => {
  it('N/A wins over everything; critical failure wins over evidence', () => {
    expect(
      R.evaluateRequirement(
        input({ applicability: 'APPROVED_NOT_APPLICABLE', criticalFailure: true }),
        NOW,
      ).status,
    ).toBe('NOT_APPLICABLE');
    const r = R.evaluateRequirement(
      input({ criticalFailure: true, blocking: 'STATUTORY', verifiedEvidence: ev() }),
      NOW,
    );
    expect([r.status, r.reasonCode, r.effect]).toEqual(['RED', 'CRITICAL_FAILURE', 'BLOCK']);
  });
  it('GREEN when verified, in date and nothing pending; upload alone is never green', () => {
    const g = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), deadline: { kind: 'DUE', date: '2027-06-01' } }),
      NOW,
    );
    expect([g.status, g.currentlyVerified]).toEqual(['GREEN', true]);
    expect(R.evaluateRequirement(input({ verifiedEvidence: ev() }), NOW).status).toBe('GREEN'); // no deadline at all
    const up = R.evaluateRequirement(input({ pendingEvidence: true }), NOW);
    expect([up.status, up.reasonCode]).toEqual(['GREY', 'UNVERIFIED']);
    expect(up.reasonText).toBe('Evidence uploaded but not verified yet');
  });
  it('AMBER DUE_SOON uses the configurable window and pluralises', () => {
    const one = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), deadline: { kind: 'EXPIRY', date: '2026-10-31' } }),
      NOW,
    );
    expect([one.reasonCode, one.reasonText]).toEqual([
      'DUE_SOON',
      'Expires in 1 day (31 Oct 2026)',
    ]);
    const many = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), deadline: { kind: 'DUE', date: '2026-11-10' } }),
      NOW,
    );
    expect(many.reasonText).toBe('Due in 11 days (10 Nov 2026)');
    expect(
      R.evaluateRequirement(
        input({
          verifiedEvidence: ev(),
          deadline: { kind: 'DUE', date: '2026-11-10' },
          dueSoonDays: 7,
        }),
        NOW,
      ).status,
    ).toBe('GREEN');
  });
  it('uses the evidence end date as the expiry deadline when none is given', () => {
    const r = R.evaluateRequirement(
      input({ verifiedEvidence: ev('2026-01-01', '2026-11-05') }),
      NOW,
    );
    expect([r.reasonCode, r.daysUntil]).toEqual(['DUE_SOON', 6]);
    const expired = R.evaluateRequirement(
      input({ verifiedEvidence: ev('2025-01-01', '2026-10-01') }),
      NOW,
    );
    expect([expired.status, expired.reasonCode]).toEqual(['RED', 'EXPIRED']);
  });
  it('overdue / expired / review variants and effects', () => {
    const over = R.evaluateRequirement(
      input({ blocking: 'STATUTORY', deadline: { kind: 'DUE', date: '2026-10-01' } }),
      NOW,
    );
    expect([over.status, over.reasonCode, over.effect, over.reasonText]).toEqual([
      'RED',
      'OVERDUE',
      'BLOCK',
      'Overdue since 1 Oct 2026',
    ]);
    const exp = R.evaluateRequirement(
      input({ deadline: { kind: 'EXPIRY', date: '2026-10-01' } }),
      NOW,
    );
    expect(exp.reasonText).toBe('Expired since 1 Oct 2026');
  });
  it('a verified item whose deadline has passed is RED, not GREEN', () => {
    expect(
      R.evaluateRequirement(
        input({ verifiedEvidence: ev(), deadline: { kind: 'DUE', date: '2026-10-29' } }),
        NOW,
      ).status,
    ).toBe('RED');
  });
  it('a pending renewal after a lapse is GREY with the lapse explained (T10 text)', () => {
    const r = R.evaluateRequirement(
      input({ pendingEvidence: true, deadline: { kind: 'EXPIRY', date: '2026-10-01' } }),
      NOW,
    );
    expect(r.reasonText).toMatch(/lapsed/);
    const lapsedEv = R.evaluateRequirement(
      input({ pendingEvidence: true, verifiedEvidence: ev('2025-01-01', '2026-10-01') }),
      NOW,
    );
    expect(lapsedEv.reasonText).toMatch(/lapsed/);
    const laterDeadline = R.evaluateRequirement(
      input({
        pendingEvidence: true,
        verifiedEvidence: ev('2025-01-01', '2026-10-01'),
        deadline: { kind: 'DUE', date: '2027-01-01' },
      }),
      NOW,
    );
    expect(laterDeadline.reasonText).toMatch(/lapsed/);
  });
  it('evidence that has itself expired is RED even if the instance deadline is later', () => {
    const r = R.evaluateRequirement(
      input({
        verifiedEvidence: ev('2025-01-01', '2026-10-01'),
        deadline: { kind: 'DUE', date: '2027-01-01' },
      }),
      NOW,
    );
    expect([r.status, r.reasonCode, r.reasonText]).toEqual([
      'RED',
      'EXPIRED',
      'Expired on 1 Oct 2026',
    ]);
  });
  it('evidence that is not valid yet is GREY, not GREEN', () => {
    const r = R.evaluateRequirement(input({ verifiedEvidence: ev('2026-12-01') }), NOW);
    expect([r.status, r.reasonCode, r.currentlyVerified]).toEqual(['GREY', 'MISSING', false]);
  });
  it('missing evidence is GREY MISSING and blocks when critical', () => {
    const r = R.evaluateRequirement(input({ blocking: 'DEPLOYMENT_CRITICAL' }), NOW);
    expect([r.status, r.reasonCode, r.effect]).toEqual(['GREY', 'MISSING', 'BLOCK']);
    expect(
      R.evaluateRequirement(input({ deadline: { kind: 'DUE', date: '2026-12-01' } }), NOW)
        .reasonCode,
    ).toBe('MISSING');
  });
  it('worstStatus orders RED > AMBER > GREY > GREEN', () => {
    expect(R.worstStatus(['GREEN', 'GREY'])).toBe('GREY');
    expect(R.worstStatus(['GREEN', 'AMBER', 'GREY'])).toBe('AMBER');
    expect(R.worstStatus(['GREEN', 'RED'])).toBe('RED');
    expect(R.worstStatus(['GREEN'])).toBe('GREEN');
    expect(R.worstStatus(['NOT_APPLICABLE'])).toBe('NOT_APPLICABLE');
    expect(R.worstStatus([])).toBe('NOT_APPLICABLE');
  });
});

const green = R.evaluateRequirement(
  input({
    verifiedEvidence: ev('2026-01-01', '2027-06-01'),
    deadline: { kind: 'EXPIRY', date: '2027-06-01' },
  }),
  NOW,
);
const amberSoon = R.evaluateRequirement(
  input({
    blocking: 'STATUTORY',
    verifiedEvidence: ev('2026-01-01', '2026-10-30'),
    deadline: { kind: 'EXPIRY', date: '2026-10-30' },
  }),
  NOW,
);
const redStatutory = R.evaluateRequirement(
  input({ blocking: 'STATUTORY', deadline: { kind: 'EXPIRY', date: '2026-10-01' } }),
  NOW,
);
const redPolicy = R.evaluateRequirement(
  input({ blocking: 'POLICY', deadline: { kind: 'DUE', date: '2026-10-01' } }),
  NOW,
);
const redNone = R.evaluateRequirement(
  input({ deadline: { kind: 'DUE', date: '2026-10-01' } }),
  NOW,
);
const greyCrit = R.evaluateRequirement(input({ blocking: 'SAFETY_CRITICAL' }), NOW);
const na = R.evaluateRequirement(input({ applicability: 'APPROVED_NOT_APPLICABLE' }), NOW);

describe('readiness', () => {
  const entry = (
    result: R.RequirementResult,
    extra: Partial<R.RequirementEntry> = {},
  ): R.RequirementEntry => ({ code: 'X', group: 'CLEARANCE', result, ...extra });
  it('requirementCheck maps every status', () => {
    expect(R.requirementCheck(entry(na), win).result).toBe('PASS');
    expect(R.requirementCheck(entry(redStatutory, { instanceId: 'i1' }), win)).toMatchObject({
      result: 'FAIL',
      overridable: false,
      requirementInstanceId: 'i1',
    });
    expect(R.requirementCheck(entry(redPolicy), win)).toMatchObject({
      result: 'FAIL',
      overridable: true,
    });
    expect(R.requirementCheck(entry(redNone), win).result).toBe('PENDING');
    expect(R.requirementCheck(entry(greyCrit), win)).toMatchObject({
      result: 'FAIL',
      overridable: false,
    });
    expect(
      R.requirementCheck(entry(green, { validFrom: '2026-01-01', expiryDate: '2027-06-01' }), win)
        .result,
    ).toBe('PASS');
  });
  it('fails a valid item whose expiry falls inside the job window, or that starts later', () => {
    const expiring = R.requirementCheck(entry(amberSoon, { expiryDate: '2026-10-30' }), {
      start: at('2026-10-30T20:00:00Z'),
      end: at('2026-10-31T01:00:00Z'),
    });
    expect(expiring).toMatchObject({ result: 'FAIL', overridable: false });
    expect(expiring.reasonText).toMatch(/before the job ends/);
    const early = R.requirementCheck(entry(green, { validFrom: '2026-12-01' }), win);
    expect([early.result, early.reasonText]).toEqual(['FAIL', 'Not yet valid at the job start']);
    const policyExpiring = R.requirementCheck(
      entry({ ...green, effect: 'POLICY_BLOCK' }, { expiryDate: '2026-10-29' }),
      win,
    );
    expect(policyExpiring.overridable).toBe(true);
  });
  it('summariseReadiness: READY, BLOCKED, RESTRICTED', () => {
    const p = R.requirementCheck(entry(green), win);
    const hard = R.requirementCheck(entry(redStatutory), win);
    const soft = R.requirementCheck(entry(redPolicy), win);
    expect(R.summariseReadiness([p]).state).toBe('READY');
    expect(R.summariseReadiness([p, R.requirementCheck(entry(redNone), win)]).state).toBe('READY');
    expect(R.summariseReadiness([p, hard, soft]).state).toBe('BLOCKED');
    expect(R.summariseReadiness([p, soft]).state).toBe('RESTRICTED');
    expect(R.summariseReadiness([p], { restrictions: ['no night shifts'] }).state).toBe(
      'RESTRICTED',
    );
    expect(R.summariseReadiness([p], { restrictions: [] }).state).toBe('READY');
  });
  it('staffReadiness checks lifecycle, role, licence category and competencies', () => {
    const base: R.StaffInput = {
      lifecycle: 'ACTIVE',
      roleApproved: true,
      licenceCategoryCovers: null,
      requirements: [],
      missingCompetencies: [],
    };
    expect(R.staffReadiness(base, win).state).toBe('READY');
    expect(R.staffReadiness({ ...base, lifecycle: 'SUSPENDED' }, win).state).toBe('BLOCKED');
    expect(R.staffReadiness({ ...base, roleApproved: false }, win).state).toBe('BLOCKED');
    expect(R.staffReadiness({ ...base, licenceCategoryCovers: true }, win).state).toBe('READY');
    expect(R.staffReadiness({ ...base, licenceCategoryCovers: false }, win).state).toBe('BLOCKED');
    const comp = R.staffReadiness(
      { ...base, missingCompetencies: ['BARIATRIC'], restrictions: ['x'] },
      win,
    );
    expect(comp.state).toBe('RESTRICTED');
    expect(comp.checks.at(-1)?.group).toBe('COMPETENCE');
  });
  it('vehicle and equipment readiness', () => {
    const v: R.VehicleInput = {
      quarantined: false,
      openCriticalDefect: false,
      maintenanceOverdue: false,
      requirements: [{ code: 'MOT', group: 'ROADWORTHY', result: green, expiryDate: '2027-06-01' }],
    };
    expect(R.vehicleReadiness(v, win).state).toBe('READY');
    expect(R.vehicleReadiness({ ...v, openCriticalDefect: true }, win).state).toBe('BLOCKED');
    expect(R.vehicleReadiness({ ...v, quarantined: true }, win).state).toBe('BLOCKED');
    expect(R.vehicleReadiness({ ...v, maintenanceOverdue: true }, win).state).toBe('BLOCKED');
    const overdueBy = (by: R.VehicleInput['maintenanceOverdueBy']) =>
      R.vehicleReadiness({ ...v, maintenanceOverdue: true, maintenanceOverdueBy: by }, win)
        .checks[2]!.reasonText;
    expect(overdueBy('MILEAGE')).toBe('Maintenance overdue by mileage');
    expect(overdueBy('DATE')).toBe('Maintenance overdue by date');
    expect(overdueBy(null)).toBe('Maintenance overdue by date or mileage');
    const e: R.EquipmentInput = {
      quarantined: false,
      requirements: [{ code: 'LOLER', group: 'EQUIPMENT', result: green }],
    };
    expect(R.equipmentReadiness(e, win).state).toBe('READY');
    expect(R.equipmentReadiness({ ...e, quarantined: true }, win).state).toBe('BLOCKED');
  });
});

describe('maintenance and defects', () => {
  it('maintenanceState: mileage, date, due soon, ok', () => {
    expect(
      R.maintenanceState({ dueDate: null, dueOdometer: 10000, currentOdometer: 10050 }, NOW).by,
    ).toBe('MILEAGE');
    expect(
      R.maintenanceState({ dueDate: '2026-10-01', dueOdometer: 10000, currentOdometer: 5000 }, NOW),
    ).toMatchObject({ state: 'OVERDUE', by: 'DATE' });
    expect(
      R.maintenanceState({ dueDate: null, dueOdometer: 10000, currentOdometer: 9700 }, NOW),
    ).toMatchObject({ state: 'DUE_SOON', by: 'MILEAGE' });
    expect(
      R.maintenanceState({ dueDate: '2026-11-10', dueOdometer: 10000, currentOdometer: 5000 }, NOW),
    ).toMatchObject({ state: 'DUE_SOON', by: 'DATE' });
    expect(
      R.maintenanceState({ dueDate: '2027-11-10', dueOdometer: 10000, currentOdometer: 5000 }, NOW)
        .state,
    ).toBe('OK');
    expect(
      R.maintenanceState({ dueDate: null, dueOdometer: null, currentOdometer: null }, NOW).state,
    ).toBe('OK');
    expect(
      R.maintenanceState({ dueDate: null, dueOdometer: 10000, currentOdometer: null }, NOW).state,
    ).toBe('OK');
  });
  it('checkOdometer flags', () => {
    expect(R.checkOdometer(null, { reading: 1, on: '2026-10-01' }).flags).toEqual([]);
    expect(
      R.checkOdometer({ reading: 100, on: '2026-10-02' }, { reading: 150, on: '2026-10-01' }).flags,
    ).toEqual(['READING_BEFORE_PREVIOUS']);
    expect(
      R.checkOdometer({ reading: 100, on: '2026-10-01' }, { reading: 90000, on: '2026-10-02' })
        .flags,
    ).toEqual(['ODOMETER_IMPLAUSIBLE_JUMP']);
    expect(
      R.checkOdometer({ reading: 100, on: '2026-10-01' }, { reading: 300, on: '2026-10-02' }).flags,
    ).toEqual([]);
    expect(
      R.checkOdometer({ reading: 100, on: '2026-10-01' }, { reading: 300, on: '2026-10-01' }).flags,
    ).toEqual([]);
  });
  it('defectEffects: critical/stop-use block; minor needs classification; major does not', () => {
    expect(R.defectEffects({ severity: 'MINOR', stopUse: true }, ['a']).blockVehicle).toBe(true);
    expect(R.defectEffects({ severity: 'MAJOR', stopUse: false }, ['a'])).toMatchObject({
      blockVehicle: false,
      reassign: [],
      needsClassification: false,
    });
    expect(R.defectEffects({ severity: 'MINOR', stopUse: false }, [])).toMatchObject({
      needsClassification: true,
    });
    expect(
      R.defectEffects({ severity: 'MINOR', stopUse: false, classifiedBy: 'u1' }, [])
        .needsClassification,
    ).toBe(true);
    expect(
      R.defectEffects(
        { severity: 'MINOR', stopUse: false, classifiedBy: 'u1', repairDeadline: '2026-11-10' },
        [],
      ).needsClassification,
    ).toBe(false);
  });
  it('canReleaseVehicle needs permission, finished repair and no other stop-use defects', () => {
    expect(
      R.canReleaseVehicle({
        repairCompleted: true,
        hasReturnToServicePermission: false,
        openStopUseDefects: 0,
      }).ok,
    ).toBe(false);
    expect(
      R.canReleaseVehicle({
        repairCompleted: false,
        hasReturnToServicePermission: true,
        openStopUseDefects: 0,
      }).reason,
    ).toBe('Repair is not complete');
    expect(
      R.canReleaseVehicle({
        repairCompleted: true,
        hasReturnToServicePermission: true,
        openStopUseDefects: 1,
      }).ok,
    ).toBe(false);
    expect(
      R.canReleaseVehicle({
        repairCompleted: true,
        hasReturnToServicePermission: true,
        openStopUseDefects: 0,
      }),
    ).toEqual({ ok: true, reason: null });
  });
  it('repairDueState uses London dates and stops counting once the repair is signed off', () => {
    const now = new Date('2026-11-10T23:30:00Z'); // 23:30 GMT on 10 Nov
    const open = (repairDeadline: string | null) =>
      R.repairDueState({ status: 'OPEN', repairDeadline }, now);
    expect(open(null)).toEqual({ state: 'NONE', daysLeft: null });
    expect(open('2026-11-10')).toEqual({ state: 'DUE_TODAY', daysLeft: 0 });
    expect(open('2026-11-09')).toEqual({ state: 'OVERDUE', daysLeft: -1 });
    expect(open('2026-11-15').state).toBe('DUE_SOON');
    expect(open('2026-12-15').state).toBe('DUE');
    expect(R.repairDueState({ status: 'REPAIRED', repairDeadline: '2026-11-01' }, now).state).toBe(
      'DONE',
    );
  });
});

const ready: R.Readiness = { state: 'READY', checks: [] };
describe('shift gate', () => {
  const base: R.ShiftGateInput = {
    shiftVehicleId: 'v1',
    shiftId: 's1',
    vdi: { vehicleId: 'v1', shiftId: 's1', failedCritical: false },
    cleaningConfirmed: { vehicleId: 'v1', shiftId: 's1' },
    staffReadiness: ready,
  };
  it('passes only when VDI, cleaning and staff readiness all pass', () => {
    expect(R.evaluateShiftGate(base).canStart).toBe(true);
  });
  it('blocks on missing / failed VDI, missing cleaning, not-ready staff', () => {
    expect(R.evaluateShiftGate({ ...base, vdi: null }).checks[0]!.result).toBe('PENDING');
    expect(
      R.evaluateShiftGate({
        ...base,
        vdi: { vehicleId: 'v1', shiftId: 's1', failedCritical: true },
      }).checks[0]!.result,
    ).toBe('FAIL');
    expect(R.evaluateShiftGate({ ...base, cleaningConfirmed: null }).canStart).toBe(false);
    expect(
      R.evaluateShiftGate({ ...base, staffReadiness: { state: 'BLOCKED', checks: [] } }).canStart,
    ).toBe(false);
  });
  it('a vehicle swap invalidates the earlier VDI and cleaning', () => {
    const swapped = R.evaluateShiftGate({ ...base, shiftVehicleId: 'v2' });
    expect(swapped.canStart).toBe(false);
    expect(swapped.checks.slice(0, 2).map((c) => c.result)).toEqual(['PENDING', 'PENDING']);
  });
});

describe('allocation validation', () => {
  const capacity = { seats: 4, wheelchairs: 1, stretchers: 1, maxLoadKg: 400 };
  const mk = (o: Partial<R.AllocationInput> = {}): R.AllocationInput => ({
    now: NOW,
    job: {
      start: at('2026-10-31T09:00:00Z'),
      seatsNeeded: 1,
      wheelchairsNeeded: 1,
      stretchersNeeded: 0,
      loadKg: 200,
      requiredEquipment: ['RAMP'],
    },
    staff: [{ id: 'st1', readiness: ready }],
    vehicle: {
      id: 'v1',
      readiness: ready,
      capacity,
      equipmentPresent: ['RAMP'],
      quarantinedEquipment: [],
      expiredEquipment: [],
    },
    conflicts: [],
    shiftGate: {
      vdi: 'PENDING',
      cleaning: 'NOT_CONFIRMED',
      shiftStart: at('2026-10-31T07:00:00Z'),
    },
    ...o,
  });
  const failing = (group: R.CheckGroup, overridable = false): R.Readiness => ({
    state: 'BLOCKED',
    checks: [{ code: 'C', group, result: 'FAIL', reasonText: 'bad', overridable }],
  });

  it('returns the eight checks in wireframe order; pending shift gate before shift start is allowed', () => {
    const r = R.validateAllocation(mk());
    expect(r.checks.map((c) => c.code)).toEqual([
      'STAFF_CLEARANCE',
      'LICENCE',
      'COMPETENCE',
      'VEHICLE_ROADWORTHY',
      'VEHICLE_SUITABILITY',
      'EQUIPMENT',
      'TIME_CONFLICT',
      'SHIFT_GATE',
    ]);
    expect(r.allowed).toBe(true);
    expect(r.checks.at(-1)?.result).toBe('PENDING');
  });
  it('statutory failures are blockers with no exception path (JOB-03)', () => {
    const r = R.validateAllocation(
      mk({
        staff: [{ id: 'st1', readiness: failing('LICENCE') }],
        exceptions: [
          {
            code: 'LICENCE',
            approvedBy: 'u1',
            reason: 'urgent',
            expiresAt: at('2026-11-30T00:00:00Z'),
          },
        ],
      }),
    );
    expect(r.allowed).toBe(false);
    expect(r.blockers).toEqual(['LICENCE']);
    expect(R.exceptionAvailable(r.checks[1]!)).toBe(false);
  });
  it('competence can be excepted by policy only with an approved, unexpired exception', () => {
    const staff = [{ id: 'st1', readiness: failing('COMPETENCE', true) }];
    const none = R.validateAllocation(mk({ staff }));
    expect([none.allowed, none.exceptable]).toEqual([false, ['COMPETENCE']]);
    expect(R.exceptionAvailable(none.checks[2]!)).toBe(true);
    const ex = {
      code: 'COMPETENCE' as const,
      approvedBy: 'u1',
      reason: 'cover',
      expiresAt: at('2026-11-30T00:00:00Z'),
    };
    expect(R.validateAllocation(mk({ staff, exceptions: [ex] })).allowed).toBe(true);
    expect(
      R.validateAllocation(
        mk({ staff, exceptions: [{ ...ex, expiresAt: at('2026-10-01T00:00:00Z') }] }),
      ).allowed,
    ).toBe(false);
    expect(
      R.validateAllocation(mk({ staff, exceptions: [{ ...ex, approvedBy: '' }] })).allowed,
    ).toBe(false);
    expect(R.validateAllocation(mk({ staff, exceptions: [{ ...ex, reason: '' }] })).allowed).toBe(
      false,
    );
    // Mixed policy + statutory failures in one group stay non-overridable.
    const mixed: R.Readiness = {
      state: 'BLOCKED',
      checks: [...failing('COMPETENCE', true).checks, ...failing('COMPETENCE', false).checks],
    };
    expect(
      R.validateAllocation(mk({ staff: [{ id: 'st1', readiness: mixed }], exceptions: [ex] }))
        .allowed,
    ).toBe(false);
  });
  it('roadworthiness, suitability, equipment and conflicts block', () => {
    expect(
      R.validateAllocation(mk({ vehicle: { ...mk().vehicle, readiness: failing('ROADWORTHY') } }))
        .blockers,
    ).toContain('VEHICLE_ROADWORTHY');
    const big = R.validateAllocation(
      mk({
        job: {
          ...mk().job,
          seatsNeeded: 9,
          wheelchairsNeeded: 3,
          stretchersNeeded: 2,
          loadKg: 999,
        },
      }),
    );
    expect(big.checks[4]!.details).toHaveLength(4);
    expect(big.blockers).toContain('VEHICLE_SUITABILITY');
    const veh = mk().vehicle;
    expect(
      R.validateAllocation(mk({ vehicle: { ...veh, equipmentPresent: [] } })).checks[5]!.details,
    ).toEqual(['RAMP missing']);
    expect(
      R.validateAllocation(mk({ vehicle: { ...veh, quarantinedEquipment: ['RAMP'] } })).checks[5]!
        .details,
    ).toEqual(['RAMP quarantined']);
    expect(
      R.validateAllocation(mk({ vehicle: { ...veh, expiredEquipment: ['RAMP'] } })).checks[5]!
        .details,
    ).toEqual(['RAMP out of date']);
    const eqFail = R.validateAllocation(
      mk({ vehicle: { ...veh, readiness: failing('EQUIPMENT') } }),
    );
    expect(eqFail.checks[5]).toMatchObject({ result: 'FAIL', overridable: false });
    const c = R.validateAllocation(
      mk({ conflicts: [{ resourceType: 'VEHICLE', resourceId: 'v1', otherJobId: 'j9' }] }),
    );
    expect(c.checks[6]).toMatchObject({
      result: 'FAIL',
      details: ['VEHICLE v1 already on job j9'],
    });
  });
  it('shift gate: no context, failed VDI, passed, and started-without-pass', () => {
    const gate = (g: R.AllocationInput['shiftGate']) =>
      R.validateAllocation(mk({ shiftGate: g })).checks.at(-1)!.result;
    expect(gate(null)).toBe('PENDING');
    expect(
      gate({ vdi: 'FAIL', cleaning: 'CONFIRMED', shiftStart: at('2026-12-01T00:00:00Z') }),
    ).toBe('FAIL');
    expect(
      gate({ vdi: 'PASS', cleaning: 'CONFIRMED', shiftStart: at('2026-10-01T00:00:00Z') }),
    ).toBe('PASS');
    expect(
      gate({ vdi: 'PASS', cleaning: 'NOT_CONFIRMED', shiftStart: at('2026-10-01T00:00:00Z') }),
    ).toBe('FAIL');
    expect(
      gate({ vdi: 'PASS', cleaning: 'NOT_CONFIRMED', shiftStart: at('2026-12-01T00:00:00Z') }),
    ).toBe('PENDING');
    // Finding 71 (6 Nov 2026): past its start time a shift nobody has started fails the gate.
    const late = {
      vdi: 'PENDING',
      cleaning: 'NOT_CONFIRMED',
      shiftStart: at('2026-10-01T00:00:00Z'),
    } as const;
    expect(gate({ ...late, started: false })).toBe('FAIL');
    expect(
      R.validateAllocation(mk({ shiftGate: { ...late, started: false } })).checks.at(-1)!
        .reasonText,
    ).toBe('Shift has not been started');
    expect(gate({ ...late, started: true })).toBe('FAIL');
    expect(gate({ ...late, started: false, vdi: 'FAIL' })).toBe('FAIL');
  });
  it('E3: plain conflict text, stretcher wording and a fix for each failure', () => {
    const c = R.validateAllocation(
      mk({
        conflicts: [
          {
            resourceType: 'STAFF',
            resourceId: 's1',
            otherJobId: 'j9',
            text: 'Sam Taylor is already on AMB-02 from 07:00 to 19:00',
          },
        ],
      }),
    );
    expect(c.checks[6]).toMatchObject({
      reasonText: 'Sam Taylor is already on AMB-02 from 07:00 to 19:00',
      fix: { action: 'SHIFT_ACTIONS' },
    });
    const veh = mk().vehicle;
    const s = R.validateAllocation(
      mk({
        job: { ...mk().job, stretchersNeeded: 1 },
        vehicle: { ...veh, capacity: { ...veh.capacity, stretchers: 0 } },
      }),
    );
    expect(s.checks[4]!.reasonText).toBe('No in-date stretcher on this vehicle');
    const bariatric = (limit: number | null) =>
      R.validateAllocation(
        mk({
          job: { ...mk().job, bariatric: true },
          vehicle: { ...veh, capacity: { ...veh.capacity, bariatricLimitKg: limit } },
        }),
      ).checks[4]!;
    expect(bariatric(null)).toMatchObject({
      result: 'FAIL',
      reasonText: 'Vehicle has no bariatric limit recorded',
    });
    expect(bariatric(250).result).toBe('PASS');
    const crew: R.Readiness = {
      state: 'BLOCKED',
      checks: [
        {
          code: 'CREW_SIZE',
          group: 'CLEARANCE',
          result: 'FAIL',
          reasonText: 'Job needs 2 crew',
          overridable: false,
        },
      ],
    };
    const small = R.validateAllocation(mk({ staff: [{ id: 'shift', readiness: crew }] }));
    expect(small.checks[0]!.fix).toEqual({
      text: 'Add a second crew member to this shift',
      action: 'SHIFT_ACTIONS',
    });
    expect(R.validateAllocation(mk()).checks[0]!.fix).toBeNull();
  });
  it('any other staff clearance failure is fixed on the staff record or by swapping the person', () => {
    const r = R.validateAllocation(mk({ staff: [{ id: 'st1', readiness: failing('CLEARANCE') }] }));
    expect(r.checks[0]).toMatchObject({
      result: 'FAIL',
      fix: {
        text: 'Clear the person on their staff record, or swap them off this shift',
        action: 'STAFF',
      },
    });
  });
  it('a shift with no approved driver is fixed by adding one to the shift', () => {
    const noDriver: R.Readiness = {
      state: 'BLOCKED',
      checks: [
        {
          code: 'NO_DRIVER',
          group: 'CLEARANCE',
          result: 'FAIL',
          reasonText: 'No approved driver on the shift',
          overridable: false,
        },
      ],
    };
    const r = R.validateAllocation(mk({ staff: [{ id: 'shift', readiness: noDriver }] }));
    expect(r.checks[0]!.fix).toEqual({
      text: 'Add an approved driver to this shift',
      action: 'SHIFT_ACTIONS',
    });
  });
  it('a blue-light job needs a vehicle authorised for blue lights; unknown authorisation does not block', () => {
    const veh = mk().vehicle;
    const blue = (blueLightAuthorised: boolean | undefined) =>
      R.validateAllocation(
        mk({
          job: { ...mk().job, blueLights: true },
          vehicle: { ...veh, capacity: { ...veh.capacity, blueLightAuthorised } },
        }),
      ).checks[4]!;
    expect(blue(false)).toMatchObject({
      result: 'FAIL',
      overridable: false,
      reasonText: 'Vehicle is not authorised for blue-light driving',
      details: ['not authorised for blue-light driving'],
    });
    expect(blue(true).result).toBe('PASS');
    expect(blue(undefined).result).toBe('PASS');
  });
  it('D2: says which maintenance limit comes first from recent mileage', () => {
    const now = at('2026-11-06T12:00:00Z');
    const fast = R.firstLimit(
      {
        dueDate: '2027-11-01',
        dueOdometer: 22000,
        readings: [
          { reading: 10000, on: '2026-10-07' },
          { reading: 13000, on: '2026-11-06' },
        ],
      },
      now,
    );
    expect(fast.first).toBe('MILEAGE');
    expect(fast.mileageDueOn).toBe('2027-02-04');
    const slow = R.firstLimit(
      {
        dueDate: '2026-12-01',
        dueOdometer: 22000,
        readings: [
          { reading: 10000, on: '2026-10-07' },
          { reading: 10300, on: '2026-11-06' },
        ],
      },
      now,
    );
    expect(slow.first).toBe('DATE');
    expect(R.firstLimit({ dueDate: '2026-12-01', dueOdometer: 1, readings: [] }, now).first).toBe(
      null,
    );
  });
  it('D2: a plan with only one kind of limit says so', () => {
    const now = at('2026-11-06T12:00:00Z');
    expect(
      R.firstLimit({ dueDate: '2027-01-01', dueOdometer: null, readings: [] }, now),
    ).toMatchObject({ first: 'DATE', mileageDueOn: null, text: 'Date limit only' });
    expect(R.firstLimit({ dueDate: null, dueOdometer: null, readings: [] }, now)).toMatchObject({
      first: null,
      text: 'No limit set',
    });
    expect(R.firstLimit({ dueDate: null, dueOdometer: 50000, readings: [] }, now)).toMatchObject({
      first: 'MILEAGE',
      mileageDueOn: null,
      text: 'Mileage limit only',
    });
  });
  it('D1: MOT from three years old, licence needed, document wording', () => {
    expect(R.motRequired({ firstRegisteredOn: '2024-01-10' }, '2026-11-06')).toBe(false);
    expect(R.motRequired({ firstRegisteredOn: '2023-11-01' }, '2026-11-06')).toBe(true);
    expect(R.motRequired({ year: 2025 }, '2026-11-06')).toBe(false);
    expect(R.motRequired({}, '2026-11-06')).toBe(true);
    expect(R.licenceNeededText('B', 4200)).toBe('Needs C1');
    const check = (reasonText: string): R.Check => ({
      code: 'X',
      group: 'ROADWORTHY',
      result: 'FAIL',
      reasonText,
      overridable: false,
    });
    expect(
      R.vehicleDocumentText('Insurance', check('No verified evidence on record'), {
        status: 'GREY',
        expiryDate: null,
      }),
    ).toBe('Insurance not verified');
    expect(
      R.vehicleDocumentText('MOT', check('Expired on 2 Nov 2026'), {
        status: 'RED',
        expiryDate: '2026-11-02',
      }),
    ).toBe('MOT expired on 2 Nov 2026');
    expect(
      R.vehicleHeadline({
        offRoad: true,
        quarantined: false,
        statusReason: 'Awaiting parts',
        expectedReturnOn: '2026-11-20',
        failing: [],
      }),
    ).toEqual({ status: 'OFF_ROAD', reason: 'Awaiting parts; expected back 20 Nov 2026' });
    expect(
      R.expenseDuplicate(
        { vehicleId: 'v', incurredOn: '2026-11-01', amountPence: 100, receiptEvidenceId: 'e1' },
        [{ vehicleId: 'w', incurredOn: '2026-10-01', amountPence: 5, receiptEvidenceId: 'e1' }],
      ),
    ).toBe(true);
  });
  it('staff details name the person in plain words, never ids or check codes', () => {
    const r = R.validateAllocation(
      mk({ staff: [{ id: 'st1', name: 'Sam Driver', readiness: failing('LICENCE') }] }),
    );
    expect(r.checks[1]!.details).toHaveLength(1);
    expect(r.checks[1]!.details[0]).toMatch(/^Sam Driver: /);
    expect(r.checks[1]!.details[0]).not.toContain('st1');
    const anon = R.validateAllocation(
      mk({ staff: [{ id: 'shift', readiness: failing('LICENCE') }] }),
    );
    expect(anon.checks[1]!.details).toEqual(['bad']);
  });
});

describe('alerts', () => {
  it('derives alerts from state and never for GREEN / N/A', () => {
    expect(R.deriveAlert(green, false)).toBeNull();
    expect(R.deriveAlert(na, false)).toBeNull();
    expect(R.deriveAlert(redStatutory, true)?.severity).toBe('CRITICAL');
    expect(R.deriveAlert(redNone, false)?.severity).toBe('HIGH');
    const crit = R.evaluateRequirement(input({ criticalFailure: true }), NOW);
    expect(R.deriveAlert(crit, false)?.severity).toBe('CRITICAL');
    expect(R.deriveAlert(greyCrit, true)?.severity).toBe('HIGH');
    expect(R.deriveAlert(R.evaluateRequirement(input(), NOW), false)?.severity).toBe('MEDIUM');
    expect(R.deriveAlert(amberSoon, true)?.severity).toBe('HIGH'); // DUE_TODAY
    const soon = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), deadline: { kind: 'DUE', date: '2026-11-10' } }),
      NOW,
    );
    expect(R.deriveAlert(soon, false)?.severity).toBe('MEDIUM');
    const review = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), pendingEvidence: true }),
      NOW,
    );
    expect(R.deriveAlert(review, false)?.severity).toBe('LOW');
  });
  it('warning windows, dedupe key, escalation and backoff', () => {
    expect(R.currentWarningWindow(25, [90, 60, 30, 14, 7])).toBe(30);
    expect(R.currentWarningWindow(100, [90, 60, 30])).toBeNull();
    expect(R.currentWarningWindow(-1, [30])).toBeNull();
    expect(R.dedupeKey('a1', 'EMAIL', '2026-10-30')).toBe('a1|EMAIL|2026-10-30');
    expect(R.windowDay(at('2026-10-30T23:30:00Z'))).toBe('2026-10-30');
    expect(R.escalationTarget({ ownerAbsent: false, deputyAbsent: false, hasDeputy: true })).toBe(
      'OWNER',
    );
    expect(R.escalationTarget({ ownerAbsent: true, deputyAbsent: false, hasDeputy: true })).toBe(
      'DEPUTY',
    );
    expect(R.escalationTarget({ ownerAbsent: true, deputyAbsent: true, hasDeputy: true })).toBe(
      'MANAGER',
    );
    expect(R.escalationTarget({ ownerAbsent: true, deputyAbsent: false, hasDeputy: false })).toBe(
      'MANAGER',
    );
    expect([1, 2, 3, 4, 8, 20].map(R.retryDelayMinutes)).toEqual([1, 2, 4, 8, 60, 60]);
    expect(R.retryDelayMinutes(0)).toBe(1);
  });
});

describe('dashboard counts and module status', () => {
  it('keeps overdue, due soon, unverified and blocked separate', () => {
    const crit = R.evaluateRequirement(input({ criticalFailure: true }), NOW);
    const awaiting = R.evaluateRequirement(
      input({ verifiedEvidence: ev(), pendingEvidence: true }),
      NOW,
    );
    const c = R.dashboardCounts([
      green,
      amberSoon,
      redStatutory,
      redPolicy,
      greyCrit,
      awaiting,
      crit,
      na,
    ]);
    expect(c).toEqual({ overdue: 2, dueSoon: 1, unverified: 2, blocked: 2 });
  });
  it('a module with any critical RED is RED; otherwise the worst status', () => {
    expect(R.moduleStatus([green, redStatutory])).toBe('RED');
    expect(
      R.moduleStatus([green, R.evaluateRequirement(input({ criticalFailure: true }), NOW)]),
    ).toBe('RED');
    expect(R.moduleStatus([green, redNone])).toBe('RED'); // non-critical RED still shows the worst
    expect(R.moduleStatus([green, greyCrit])).toBe('GREY');
    expect(R.moduleStatus([green, na])).toBe('GREEN');
  });
  it('coverage handles the empty case and excludes RED even if once verified', () => {
    expect(R.evidenceCoverage([])).toMatchObject({ numerator: 0, denominator: 0, percent: null });
    const verifiedButRed = { ...green, status: 'RED' as const };
    expect(R.evidenceCoverage([verifiedButRed, green])).toMatchObject({
      numerator: 1,
      denominator: 2,
    });
  });
});
