/**
 * In-memory sliding-window limiter (per API instance), e.g. 20 local sign-in attempts per IP per
 * 15 minutes. Keys should be hashes (never raw IPs or usernames).
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly capacity = 10_000,
  ) {}

  /** Records an attempt; false when the key has already used its allowance in the window. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.capacity) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.set(key, recent);
    return true;
  }
}

/** Account lockout rule shared by real accounts (stored) and unknown usernames (in memory). */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60_000;

/**
 * Applies one failed password attempt. An expired lock starts a fresh count; the failure that
 * reaches the threshold locks for LOCKOUT_MS. Attempts during a lock are not counted (so a lock
 * cannot be extended indefinitely by someone else).
 */
export function applyFailure(
  state: { failedAttempts: number; lockedUntil: number | null },
  now: number,
): { failedAttempts: number; lockedUntil: number | null; lockedNow: boolean } {
  const expired = state.lockedUntil !== null && state.lockedUntil <= now;
  const failedAttempts = (expired ? 0 : state.failedAttempts) + 1;
  const lockedNow = failedAttempts >= LOCKOUT_THRESHOLD;
  return {
    failedAttempts,
    lockedUntil: lockedNow ? now + LOCKOUT_MS : expired ? null : state.lockedUntil,
    lockedNow,
  };
}
