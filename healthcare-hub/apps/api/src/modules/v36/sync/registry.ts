import type { V36Adapter } from './types.js';
import { STAFF_ADAPTERS } from './staff.js';
import { FLEET_ADAPTERS } from './fleet.js';
import { GOVERNANCE_ADAPTERS } from './governance.js';

/** Every connected v36 collection. Each area keeps its adapters in its own file. */
export const V36_ADAPTERS: readonly V36Adapter[] = [
  ...STAFF_ADAPTERS,
  ...FLEET_ADAPTERS,
  ...GOVERNANCE_ADAPTERS,
];

const byKey = new Map<string, V36Adapter>();
for (const a of V36_ADAPTERS) {
  if (byKey.has(a.key)) throw new Error(`v36 adapter registered twice: ${a.key}`);
  byKey.set(a.key, a);
}
export const adapterFor = (key: string) => byKey.get(key);
