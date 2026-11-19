// v36 collections for this area, connected to the real tables. See ./types.ts.
// People come first: the registers refer to people by their staff code, so a saved copy moves
// in people before anything that points at them.
import type { V36Adapter } from './types.js';
import { peopleAdapter } from './staff-people.js';
import { REGISTER_ADAPTERS } from './staff-registers.js';
import { ROTA_ADAPTERS } from './staff-rota.js';

export const STAFF_ADAPTERS: V36Adapter[] = [peopleAdapter, ...REGISTER_ADAPTERS, ...ROTA_ADAPTERS];
if (process.env.V36_DEBUG)
  for (const a of STAFF_ADAPTERS)
    for (const m of ['load', 'apply', 'import', 'isEmpty'] as const) {
      const f = a[m] as ((...x: unknown[]) => Promise<unknown>) | undefined;
      if (f)
        (a as unknown as Record<string, unknown>)[m] = (...x: unknown[]) =>
          f.apply(a, x).catch((e: unknown) => {
            if (!(e instanceof Error && e.constructor.name === 'HubError')) console.error(`[v36 ${a.key}.${m}]`, e);
            throw e;
          });
    }
