type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Total checks that apply, and how many are verified and in date. */
export function checkCount(r: Row): { done: number; total: number } {
  const c = r.counts as { red: number; amber: number; grey: number; green: number } | undefined;
  if (!c || r.checksSetUp === false) return { done: 0, total: 0 };
  return { done: c.green, total: c.green + c.amber + c.red + c.grey };
}

/**
 * Readiness for shifts in v36 words. Conservative: an active person is "Not ready" while any
 * check is overdue, expired, missing or unverified, or nothing is set up yet. The allocation and
 * shift-start gates on the server remain the authority.
 */
export function readiness(r: Row): { tone: 'green' | 'red' | 'grey'; word: string; why?: string } {
  if (r.lifecycleState === 'SUSPENDED') return { tone: 'red', word: 'Suspended' };
  if (r.lifecycleState === 'LEAVER') return { tone: 'grey', word: 'Left' };
  if (r.lifecycleState !== 'ACTIVE') return { tone: 'grey', word: 'Onboarding' };
  const c = r.counts as { red: number; amber: number; grey: number; green: number } | undefined;
  // The clearance-only (dispatcher) list carries no check counts: readiness is not shown there.
  if (!c) return { tone: 'grey', word: 'Not shown' };
  if (r.checksSetUp === false)
    return { tone: 'red', word: 'Not ready', why: 'No checks set up for the approved role yet' };
  const why = [
    c.red && `${c.red} overdue or expired`,
    c.grey && `${c.grey} missing or unverified`,
  ].filter(Boolean);
  if (why.length) return { tone: 'red', word: 'Not ready', why: why.join(', ') };
  return { tone: 'green', word: 'Ready', ...(c.amber ? { why: `${c.amber} due soon` } : {}) };
}
