import type { TenantTx } from '@hub/db';

/** Why control should look at someone's future shifts. Never carries the HR reason. */
export type ControlFlag = 'LEFT' | 'ACCESS_ENDED' | 'RESTRICTED' | 'SUSPENDED';

const TEXT: Record<ControlFlag, string> = {
  LEFT: 'Has left the organisation: future shifts need re-planning',
  ACCESS_ENDED: 'App access has ended: future shifts need re-planning',
  RESTRICTED: 'A restriction now applies: check their future shifts and jobs',
  SUSPENDED: 'Suspended from deployment: future shifts need re-planning',
};

/**
 * Raises one alert for control when the person has future shifts (B4, B6, A3). The planner itself
 * is not changed here; the allocation gates already refuse people who are no longer eligible.
 * Returns the number of future bookings found.
 */
export async function flagFutureShifts(
  tx: TenantTx,
  orgId: string,
  staffId: string,
  flag: ControlFlag,
): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM resource_booking
    WHERE resource_type = 'STAFF' AND resource_id = ${staffId}::uuid
      AND active AND ends_at > now()`;
  const n = Number(row?.n ?? 0);
  if (n === 0) return 0;
  const open = await tx.alert.findFirst({
    where: { sourceType: 'STAFF', sourceId: staffId, state: { not: 'RESOLVED' } },
  });
  const reasonText = `${TEXT[flag]} (${n} booking${n === 1 ? '' : 's'})`;
  if (open) {
    await tx.alert.update({
      where: { id: open.id },
      data: { reasonCode: `STAFF_${flag}`, reasonText, state: 'OPEN' },
    });
  } else {
    await tx.alert.create({
      data: {
        organisationId: orgId,
        sourceType: 'STAFF',
        sourceId: staffId,
        severity: flag === 'RESTRICTED' ? 'HIGH' : 'CRITICAL',
        reasonCode: `STAFF_${flag}`,
        reasonText,
      },
    });
  }
  return n;
}
