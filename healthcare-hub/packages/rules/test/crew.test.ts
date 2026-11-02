import { describe, expect, it } from 'vitest';
import {
  classifySync,
  crewCacheExpiry,
  crewGateCards,
  offlineStartAllowed,
  pushPayload,
  syncBackoffMs,
} from '../src/index.js';

const at = (s: string) => new Date(s);

describe('crew push payloads carry no detail [APP-02, non-negotiable 7]', () => {
  it('uses fixed generic text, the type and an opaque id', () => {
    const p = pushPayload('JOB_OFFERED', 'abc');
    expect(p).toEqual({
      title: 'New job assigned',
      body: 'Open the app to view and acknowledge it.',
      data: { type: 'JOB_OFFERED', id: 'abc' },
    });
    for (const k of ['JOB_CHANGED', 'POLICY_ACK', 'SHIFT_CHANGED'] as const)
      expect(Object.keys(pushPayload(k, 'x').data)).toEqual(['type', 'id']);
  });
});

describe('outbox backoff and offline rules [APP-01]', () => {
  it('backs off exponentially with a cap', () => {
    expect(syncBackoffMs(0)).toBe(15_000);
    expect(syncBackoffMs(1)).toBe(30_000);
    expect(syncBackoffMs(-3)).toBe(15_000);
    expect(syncBackoffMs(50)).toBe(15 * 60_000);
  });
  it('allows an offline shift start only after a recent server check', () => {
    const now = at('2026-10-30T08:00:00Z');
    expect(offlineStartAllowed({ lastVerifiedAt: null, now })).toBe(false);
    expect(offlineStartAllowed({ lastVerifiedAt: at('2026-10-30T07:31:00Z'), now })).toBe(true);
    expect(offlineStartAllowed({ lastVerifiedAt: at('2026-10-30T07:29:00Z'), now })).toBe(false);
    expect(
      offlineStartAllowed({ lastVerifiedAt: at('2026-10-30T07:00:00Z'), now, maxMinutes: 90 }),
    ).toBe(true);
    // A device clock ahead of the server check is not trusted.
    expect(offlineStartAllowed({ lastVerifiedAt: at('2026-10-30T08:05:00Z'), now })).toBe(false);
  });
  it('keeps the cache to the end of shift plus 12 hours', () => {
    const now = at('2026-10-30T08:00:00Z');
    expect(crewCacheExpiry(at('2026-10-30T19:00:00Z'), now).toISOString()).toBe(
      '2026-10-31T07:00:00.000Z',
    );
    expect(crewCacheExpiry(null, now).toISOString()).toBe('2026-10-30T20:00:00.000Z');
    expect(crewCacheExpiry(at('2026-10-30T07:00:00Z'), now).toISOString()).toBe(
      '2026-10-30T20:00:00.000Z',
    );
  });
  it('classifies sync results; conflicts are never retried silently', () => {
    expect(classifySync(201)).toBe('ACCEPTED');
    expect(classifySync(200, true)).toBe('DUPLICATE');
    expect(classifySync(409)).toBe('CONFLICT');
    expect(classifySync(422)).toBe('CONFLICT');
    expect(classifySync(503)).toBe('RETRY');
    expect(classifySync(429)).toBe('RETRY');
    expect(classifySync(400)).toBe('REJECTED');
  });
});

describe('My shift gate cards (wireframe 05)', () => {
  it('maps the server checks to the three cards with words', () => {
    const cards = crewGateCards([
      { code: 'STAFF_READY', result: 'PASS', reasonText: 'ok' },
      { code: 'VDI', result: 'FAIL', reasonText: 'VDI has a failed critical item' },
      { code: 'CLEANING', result: 'PENDING', reasonText: 'Not confirmed' },
    ]);
    expect(cards.map((c) => [c.label, c.state])).toEqual([
      ['Driving clearance', 'APPROVED'],
      ['Vehicle daily inspection', 'BLOCKED'],
      ['Pre-shift cleaning', 'REQUIRED'],
    ]);
    expect(crewGateCards([])[0]).toMatchObject({
      state: 'REQUIRED',
      reasonText: 'Not checked yet',
    });
    expect(crewGateCards([{ code: 'VDI', result: 'PASS', reasonText: 'x' }])[1]!.state).toBe(
      'COMPLETE',
    );
  });
});
