// v36 collections for this area, connected to the real tables. See ./types.ts.
// Order matters: one v36 button can change several collections, and both the browser and the
// import go through them in this order (vehicles before their checks; a daily check before the
// defects it raised).
import type { V36Adapter } from './types.js';
import { checksAdapter, clAdapter } from './fleet-checks.js';
import { defAdapter } from './fleet-defects.js';
import { vehAdapter } from './fleet-vehicles.js';
import { clean2Adapter, cleanAdapter, dcNeedAdapter } from './fleet-care.js';
import { FLEET_REGISTER_ADAPTERS } from './fleet-registers.js';
import { FLEET_PLAN_ADAPTERS } from './fleet-plan.js';

export const FLEET_ADAPTERS: V36Adapter[] = [
  vehAdapter,
  clAdapter,
  checksAdapter,
  defAdapter,
  cleanAdapter,
  dcNeedAdapter,
  clean2Adapter,
  ...FLEET_REGISTER_ADAPTERS,
  ...FLEET_PLAN_ADAPTERS,
];
if (process.env.V36_DEBUG)
  for (const a of FLEET_ADAPTERS)
    for (const m of ['load', 'apply', 'import', 'isEmpty'] as const) {
      const f = a[m] as ((...x: unknown[]) => Promise<unknown>) | undefined;
      if (f)
        (a as unknown as Record<string, unknown>)[m] = async (...x: unknown[]) => {
          try {
            return await f.apply(a, x);
          } catch (e) {
            if (!(e instanceof Error && e.constructor.name === "HubError")) console.error(`[v36 ${a.key}.${m}]`, e);
            throw e;
          }
        };
    }
