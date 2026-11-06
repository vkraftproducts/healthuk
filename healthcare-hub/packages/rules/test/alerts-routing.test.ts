import { describe, expect, it } from 'vitest';
import { alertItemKind, alertLink, recipientReason } from '../src/index.js';

describe('alert item kinds (A6)', () => {
  it('splits requirement alerts by what the requirement is about', () => {
    expect(alertItemKind('REQUIREMENT', 'VEHICLE')).toBe('VEHICLE_DOCUMENT');
    expect(alertItemKind('REQUIREMENT', 'EQUIPMENT')).toBe('EQUIPMENT_REGIME');
    expect(alertItemKind('REQUIREMENT', 'PREMISES')).toBe('PREMISES_ITEM');
    expect(alertItemKind('REQUIREMENT', 'STAFF')).toBe('STAFF_REQUIREMENT');
    expect(alertItemKind('REQUIREMENT')).toBe('STAFF_REQUIREMENT');
  });

  it('maps every other source to its item kind, with incident obligations as the fallback', () => {
    expect(alertItemKind('DEFECT')).toBe('EQUIPMENT_REGIME');
    expect(alertItemKind('BREACH')).toBe('DP_DEADLINE');
    expect(alertItemKind('RETENTION')).toBe('DP_DEADLINE');
    expect(alertItemKind('STAFF')).toBe('STAFF_REQUIREMENT');
    expect(alertItemKind('ACTION')).toBe('ACTION');
    expect(alertItemKind('AUDIT')).toBe('AUDIT');
    expect(alertItemKind('OBLIGATION')).toBe('INCIDENT_OBLIGATION');
  });
});

describe('why a person is told about an alert (A6)', () => {
  it('the registered manager is brought in only once an alert reaches the manager stage', () => {
    const manager = {
      kind: 'ACTION',
      recipients: ['OWNER'] as const,
      roleKeys: ['REGISTERED_MANAGER'],
    };
    expect(recipientReason({ ...manager, stage: 'LEAD' })).toBeNull();
    expect(recipientReason({ ...manager, stage: 'MANAGER' })).toBe('ESCALATED');
  });

  it('an item kind with no lead role brings in no lead, even at the manager stage', () => {
    expect(
      recipientReason({
        kind: 'UNKNOWN_KIND',
        recipients: ['LEAD'],
        stage: 'MANAGER',
        roleKeys: ['GOVERNANCE_LEAD', 'FLEET_LEAD'],
      }),
    ).toBeNull();
  });
});

describe('alert links (no personal data in URLs)', () => {
  it('links each source to its page, with only an ID in the path', () => {
    expect(alertLink('REQUIREMENT', 'r1')).toBe('/');
    expect(alertLink('STAFF', 's1')).toBe('/staff/s1');
    expect(alertLink('BREACH', 'b1')).toBe('/settings');
    expect(alertLink('RETENTION', 'x1')).toBe('/settings');
    expect(alertLink('DEFECT', 'd1')).toBe('/vehicles');
    expect(alertLink('JOB', 'j1')).toBe('/planner');
    expect(alertLink('ACTION', 'a1')).toBe('/compliance?tab=actions');
    expect(alertLink('AUDIT', 'au1')).toBe('/compliance/audits/au1');
    expect(alertLink('EVENT', 'e1')).toBe('/compliance/events/e1');
    expect(alertLink('POLICY', 'p1')).toBe('/compliance?tab=policies');
    expect(alertLink('SOMETHING_ELSE', 'z1')).toBe('/alerts');
  });
});
