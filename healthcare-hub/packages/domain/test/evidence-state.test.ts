import { describe, expect, it } from 'vitest';
import { deriveEvidenceInputs, type EvidenceVersionState } from '../src/evidence-state.js';

const t = (min: number) => new Date(Date.UTC(2026, 9, 1, 9, min));
const v = (o: Partial<EvidenceVersionState> & { id: string }): EvidenceVersionState => ({
  createdAt: t(0),
  scanStatus: 'CLEAN',
  uploaded: true,
  decision: null,
  decidedAt: null,
  validFrom: null,
  validTo: '2027-01-01',
  ...o,
});

describe('deriveEvidenceInputs (upload never makes anything green)', () => {
  it('no versions: nothing verified, nothing pending', () => {
    expect(deriveEvidenceInputs([])).toEqual({ verified: null, pending: false });
  });
  it('an uploaded, clean, undecided version is pending only', () => {
    expect(deriveEvidenceInputs([v({ id: 'a' })])).toEqual({ verified: null, pending: true });
  });
  it.each([
    ['not uploaded', { uploaded: false }],
    ['unscanned', { scanStatus: 'PENDING' as const }],
    ['malicious', { scanStatus: 'MALICIOUS' as const }],
    ['scan failed', { scanStatus: 'FAILED' as const }],
    ['rejected', { decision: 'REJECTED' as const, decidedAt: t(5) }],
  ])('a %s version is neither verified nor pending', (_n, o) => {
    expect(deriveEvidenceInputs([v({ id: 'a', ...o })])).toEqual({
      verified: null,
      pending: false,
    });
  });
  it('an accepted version that was somehow not clean never counts', () => {
    const r = deriveEvidenceInputs([
      v({ id: 'a', scanStatus: 'MALICIOUS', decision: 'ACCEPTED', decidedAt: t(5) }),
    ]);
    expect(r.verified).toBeNull();
  });
  it('the most recently accepted version is current', () => {
    const r = deriveEvidenceInputs([
      v({
        id: 'old',
        createdAt: t(0),
        decision: 'ACCEPTED',
        decidedAt: t(1),
        validTo: '2026-12-01',
      }),
      v({
        id: 'new',
        createdAt: t(2),
        decision: 'ACCEPTED',
        decidedAt: t(3),
        validTo: '2027-12-01',
      }),
    ]);
    expect(r).toEqual({
      verified: { id: 'new', validFrom: null, validTo: '2027-12-01' },
      pending: false,
    });
  });
  it('a newer undecided upload is pending alongside the current verified one (renewal)', () => {
    const r = deriveEvidenceInputs([
      v({ id: 'cur', createdAt: t(0), decision: 'ACCEPTED', decidedAt: t(1) }),
      v({ id: 'renewal', createdAt: t(2) }),
    ]);
    expect(r.verified?.id).toBe('cur');
    expect(r.pending).toBe(true);
  });
  it('an older undecided upload does not count as pending once something newer is verified', () => {
    const r = deriveEvidenceInputs([
      v({ id: 'stale', createdAt: t(0) }),
      v({ id: 'cur', createdAt: t(2), decision: 'ACCEPTED', decidedAt: t(3) }),
    ]);
    expect(r.pending).toBe(false);
  });
});
