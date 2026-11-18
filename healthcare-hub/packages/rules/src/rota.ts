/**
 * Working-time prompts for the rota (Working Time Regulations 1998: 11 hours' daily rest,
 * 48-hour average week unless the worker has opted out). These are prompts for the rota
 * planner, not gates: the shift-start and allocation gates live in shift-gate.ts.
 */
export const MIN_DAILY_REST_HOURS = 11;
export const WEEKLY_HOURS_PROMPT = 48;

export interface RotaShift {
  id: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
}
export interface RotaWarning {
  shiftId: string;
  kind: 'SHORT_REST' | 'LONG_WEEK';
  text: string;
}

const H = 3_600_000;
const hours = (ms: number) => Math.round((ms / H) * 10) / 10;

/** Per-shift prompts: rest before the shift under 11 hours; over 48 hours in the 7 days to its end. */
export function rotaWarnings(shifts: readonly RotaShift[]): RotaWarning[] {
  const out: RotaWarning[] = [];
  const byStaff = new Map<string, RotaShift[]>();
  for (const s of shifts) byStaff.set(s.staffId, [...(byStaff.get(s.staffId) ?? []), s]);
  for (const list of byStaff.values()) {
    const sorted = [...list].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    sorted.forEach((s, i) => {
      const prev = sorted[i - 1];
      if (prev) {
        const rest = (s.startsAt.getTime() - prev.endsAt.getTime()) / H;
        if (rest < MIN_DAILY_REST_HOURS)
          out.push({
            shiftId: s.id,
            kind: 'SHORT_REST',
            text: `Only ${hours(Math.max(0, rest) * H)}h rest since last shift (${MIN_DAILY_REST_HOURS}h minimum)`,
          });
      }
      const windowStart = s.endsAt.getTime() - 7 * 24 * H;
      const worked = sorted
        .filter((x) => x.startsAt.getTime() <= s.startsAt.getTime())
        .reduce(
          (sum, x) =>
            sum + Math.max(0, x.endsAt.getTime() - Math.max(x.startsAt.getTime(), windowStart)),
          0,
        );
      if (worked / H > WEEKLY_HOURS_PROMPT)
        out.push({
          shiftId: s.id,
          kind: 'LONG_WEEK',
          text: `${hours(worked)}h in 7 days – over ${WEEKLY_HOURS_PROMPT}; check the opt-out`,
        });
    });
  }
  return out;
}
