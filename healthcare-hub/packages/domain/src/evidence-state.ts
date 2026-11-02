import type { ISODate } from '@hub/rules';

export interface EvidenceVersionState {
  id: string;
  createdAt: Date;
  scanStatus: 'PENDING' | 'CLEAN' | 'MALICIOUS' | 'FAILED';
  /** The blob has been uploaded and `complete` was called. */
  uploaded: boolean;
  decision: 'ACCEPTED' | 'REJECTED' | null;
  decidedAt: Date | null;
  validFrom: ISODate | null;
  /** The reviewer-confirmed end date if given, otherwise the uploader's. */
  validTo: ISODate | null;
}

export interface EvidenceInputs {
  verified: { id: string; validFrom: ISODate | null; validTo: ISODate | null } | null;
  pending: boolean;
}

/**
 * Current verified evidence = the most recently ACCEPTED version. Pending = a clean, uploaded
 * version with no decision that is newer than it. Rejected, quarantined and unscanned files never
 * count either way: upload alone never produces GREEN (RULES_ENGINE §2).
 */
export function deriveEvidenceInputs(versions: readonly EvidenceVersionState[]): EvidenceInputs {
  const accepted = versions
    .filter((v) => v.decision === 'ACCEPTED' && v.scanStatus === 'CLEAN' && v.decidedAt)
    .sort((a, b) => (b.decidedAt as Date).getTime() - (a.decidedAt as Date).getTime());
  const current = accepted[0] ?? null;
  const pending = versions.some(
    (v) =>
      v.decision === null &&
      v.uploaded &&
      v.scanStatus === 'CLEAN' &&
      (current === null ||
        v.createdAt.getTime() >
          (versions.find((x) => x.id === current.id) as EvidenceVersionState).createdAt.getTime()),
  );
  return {
    verified: current
      ? { id: current.id, validFrom: current.validFrom, validTo: current.validTo }
      : null,
    pending,
  };
}
