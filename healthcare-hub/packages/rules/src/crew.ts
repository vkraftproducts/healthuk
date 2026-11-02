/**
 * Crew app rules (APP-01, APP-02, MOBILE_APP.md). Shared by the API, worker and the mobile app so
 * offline behaviour on the device matches what the server will accept.
 */

export type PushKind = 'JOB_OFFERED' | 'JOB_CHANGED' | 'POLICY_ACK' | 'SHIFT_CHANGED';

const PUSH_TEXT: Record<PushKind, { title: string; body: string }> = {
  JOB_OFFERED: { title: 'New job assigned', body: 'Open the app to view and acknowledge it.' },
  JOB_CHANGED: { title: 'Job updated', body: 'Open the app to see the change.' },
  POLICY_ACK: { title: 'Policy needs acknowledgement', body: 'Open the app to read it.' },
  SHIFT_CHANGED: { title: 'Shift updated', body: 'Open the app to see your shift.' },
};

/**
 * Push payload: fixed generic text, type and an opaque id only. No patient, address or job
 * detail ever leaves through a push service (non-negotiable 7); the app fetches after sign-in.
 */
export function pushPayload(kind: PushKind, refId: string) {
  return { ...PUSH_TEXT[kind], data: { type: kind, id: refId } };
}

/** Outbox retry delay: 15 s doubling per attempt, capped at 15 minutes. */
export function syncBackoffMs(attempts: number): number {
  const n = Math.max(0, Math.floor(attempts));
  return Math.min(15_000 * 2 ** Math.min(n, 10), 15 * 60_000);
}

/** After this many failed sends an outbox item stops retrying and asks the person to review it. */
export const OUTBOX_MAX_ATTEMPTS = 12;

/**
 * Offline, a shift may only be started when eligibility was confirmed by the server within the
 * last `maxMinutes` (default 30); otherwise "Follow downtime procedure – call control".
 */
export function offlineStartAllowed(i: {
  lastVerifiedAt: Date | null;
  now: Date;
  maxMinutes?: number;
}): boolean {
  if (!i.lastVerifiedAt) return false;
  const age = i.now.getTime() - i.lastVerifiedAt.getTime();
  return age >= 0 && age <= (i.maxMinutes ?? 30) * 60_000;
}

/** Cached shift data is kept until the end of the shift plus 12 hours (or 12 hours with no shift). */
export function crewCacheExpiry(shiftEndsAt: Date | null, now: Date): Date {
  const base = shiftEndsAt && shiftEndsAt > now ? shiftEndsAt : now;
  return new Date(base.getTime() + 12 * 3_600_000);
}

export type GateCardState = 'APPROVED' | 'COMPLETE' | 'REQUIRED' | 'BLOCKED';
export interface GateCard {
  code: 'DRIVING_CLEARANCE' | 'VDI' | 'CLEANING';
  label: string;
  state: GateCardState;
  reasonText: string;
}

/** The three wireframe cards on "My shift", from the server's shift-gate checks. */
export function crewGateCards(
  checks: readonly { code: string; result: 'PASS' | 'FAIL' | 'PENDING'; reasonText: string }[],
): GateCard[] {
  const by = (code: string) => checks.find((c) => c.code === code);
  const staff = by('STAFF_READY');
  const vdi = by('VDI');
  const clean = by('CLEANING');
  const card = (
    code: GateCard['code'],
    label: string,
    c: (typeof checks)[number] | undefined,
    ok: GateCardState,
  ): GateCard => ({
    code,
    label,
    state: !c
      ? 'REQUIRED'
      : c.result === 'PASS'
        ? ok
        : c.result === 'FAIL'
          ? 'BLOCKED'
          : 'REQUIRED',
    reasonText: c?.reasonText ?? 'Not checked yet',
  });
  return [
    card('DRIVING_CLEARANCE', 'Driving clearance', staff, 'APPROVED'),
    card('VDI', 'Vehicle daily inspection', vdi, 'COMPLETE'),
    card('CLEANING', 'Pre-shift cleaning', clean, 'COMPLETE'),
  ];
}

/** Sync outcome classification for one outbox item from the server's HTTP status. */
export type SyncOutcome = 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED' | 'RETRY';
export function classifySync(status: number, duplicate = false): SyncOutcome {
  if (status >= 200 && status < 300) return duplicate ? 'DUPLICATE' : 'ACCEPTED';
  if (status === 409 || status === 422) return 'CONFLICT';
  if (status === 408 || status === 429 || status >= 500) return 'RETRY';
  return 'REJECTED';
}
