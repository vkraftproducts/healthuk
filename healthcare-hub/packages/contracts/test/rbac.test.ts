import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_KEYS,
  RESTRICTED_FOR_DISPATCH_AND_CREW,
  SYSTEM_ROLES,
} from '../src/index.js';

describe('rbac matrix', () => {
  it('uses well-formed permission keys', () => {
    for (const k of ALL_PERMISSION_KEYS) expect(k).toMatch(/^[a-z_]+(\.[a-z_]+){1,3}$/);
  });
  it('only references known permissions', () => {
    for (const r of SYSTEM_ROLES)
      for (const p of r.permissions) expect(ALL_PERMISSION_KEYS).toContain(p);
  });
  it('never grants restricted permissions to dispatcher or crew', () => {
    for (const key of ['DISPATCHER', 'CREW']) {
      const role = SYSTEM_ROLES.find((r) => r.key === key)!;
      for (const p of RESTRICTED_FOR_DISPATCH_AND_CREW) expect(role.permissions).not.toContain(p);
    }
  });
  it('dispatcher cannot see DBS/OH/staff sensitive data (matrix: ✗)', () => {
    const d = SYSTEM_ROLES.find((r) => r.key === 'DISPATCHER')!;
    expect(d.permissions).not.toContain('staff.sensitive.view');
    expect(d.permissions).toContain('staff.profile.view_clearance');
  });
  it('crew have no org-wide patient or HR access', () => {
    const c = SYSTEM_ROLES.find((r) => r.key === 'CREW')!;
    expect(c.permissions).not.toContain('jobs.patient.view');
    expect(c.permissions).not.toContain('staff.profile.view_basic');
  });
  it('only managers hold return-to-service and exception approval alongside fleet lead', () => {
    const holders = (p: string) =>
      SYSTEM_ROLES.filter((r) => (r.permissions as readonly string[]).includes(p))
        .map((r) => r.key)
        .sort();
    expect(holders('allocation.exception.approve')).toEqual(['DIRECTOR', 'REGISTERED_MANAGER']);
    expect(holders('fleet.return_to_service')).toEqual([
      'DIRECTOR',
      'FLEET_LEAD',
      'REGISTERED_MANAGER',
    ]);
  });
  it('has unique role keys', () => {
    expect(new Set(SYSTEM_ROLES.map((r) => r.key)).size).toBe(SYSTEM_ROLES.length);
  });
});
