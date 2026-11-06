import { describe, expect, it } from 'vitest';
import {
  ambulanceOn,
  canRunReport,
  staffRolesFor,
  visibleDashboardModules,
  visibleDashboardTiles,
} from '../src/index.js';

const HR = [
  'dashboard.view',
  'reports.view',
  'staff.profile.view_basic',
  'compliance.requirement.view',
  'events.event.view',
];
const DISPATCHER = [
  'dashboard.view',
  'reports.view',
  'fleet.vehicle.view',
  'jobs.job.view',
  'compliance.requirement.view',
];

describe('dashboard visibility [findings 23, 88, 95]', () => {
  it('shows only the modules the permissions cover', () => {
    expect(visibleDashboardModules(HR, ['ambulance'])).toEqual(['STAFF', 'COMPLIANCE', 'EVENTS']);
    expect(visibleDashboardModules(DISPATCHER, ['ambulance'])).toEqual([
      'FLEET',
      'COMPLIANCE',
      'JOBS',
    ]);
    const orgAdmin = ['dashboard.view', 'admin.users.manage'];
    expect(visibleDashboardModules(orgAdmin, ['ambulance'])).toEqual([]);
  });

  it('drops ambulance modules in a dental or care home organisation', () => {
    expect(visibleDashboardModules(DISPATCHER, ['dental'])).toEqual(['COMPLIANCE']);
    expect(visibleDashboardModules(DISPATCHER, null)).toContain('FLEET');
    expect(ambulanceOn(['care_home'])).toBe(false);
    expect(ambulanceOn(undefined)).toBe(true);
  });

  it('derives the tiles from the modules', () => {
    expect(visibleDashboardTiles(['STAFF'])).toEqual(['overdue', 'dueSoon']);
    expect(visibleDashboardTiles(['FLEET', 'JOBS'])).toEqual([
      'overdue',
      'dueSoon',
      'blockedVehicles',
      'jobsToday',
    ]);
    expect(visibleDashboardTiles(['JOBS'])).toEqual(['jobsToday']);
    expect(visibleDashboardTiles([])).toEqual([]);
  });
});

describe('report access [finding 84]', () => {
  it('needs reports.view and a permission for what the report covers', () => {
    expect(canRunReport('WORKFORCE_READINESS', HR, ['ambulance'])).toBe(true);
    expect(canRunReport('FLEET', HR, ['ambulance'])).toBe(false);
    expect(canRunReport('FLEET', DISPATCHER, ['ambulance'])).toBe(true);
    expect(canRunReport('WORKFORCE_READINESS', DISPATCHER, ['ambulance'])).toBe(false);
    expect(canRunReport('FLEET', ['fleet.vehicle.view'], ['ambulance'])).toBe(false);
  });

  it('never offers ambulance reports outside the ambulance pack', () => {
    expect(canRunReport('FLEET', DISPATCHER, ['dental'])).toBe(false);
    expect(canRunReport('JOURNEYS', DISPATCHER, ['care_home'])).toBe(false);
  });
});

describe('sector staff roles [finding 96]', () => {
  it('offers dental roles to a dental practice, not ambulance ones', () => {
    const dental = staffRolesFor(['dental']);
    expect(dental).toEqual(['DENTIST', 'DENTAL_NURSE', 'RECEPTIONIST', 'MANAGER', 'OTHER']);
    expect(dental).not.toContain('DRIVER');
  });

  it('offers every role when the packs are not known', () => {
    expect(staffRolesFor(null)).toEqual(expect.arrayContaining(['DRIVER', 'DENTIST', 'OTHER']));
    expect(staffRolesFor([])).toContain('SENIOR_CARER');
  });

  it('a pack it does not recognise adds only the roles every organisation gets', () => {
    expect(staffRolesFor(['veterinary'])).toEqual(['MANAGER', 'OTHER']);
  });
});

describe('dashboard tiles outside the ambulance pack (WORKFLOWS M)', () => {
  it('dental and care homes get staff unverified and audits overdue instead of fleet and jobs', () => {
    expect(visibleDashboardTiles(['STAFF', 'COMPLIANCE'], ['dental'])).toEqual([
      'overdue',
      'dueSoon',
      'unverified',
      'auditsOverdue',
    ]);
    expect(visibleDashboardTiles(['STAFF'], ['care_home'])).toEqual([
      'overdue',
      'dueSoon',
      'unverified',
    ]);
    expect(visibleDashboardTiles(['EVENTS'], ['care_home'])).toEqual(['overdue', 'dueSoon']);
  });
});
