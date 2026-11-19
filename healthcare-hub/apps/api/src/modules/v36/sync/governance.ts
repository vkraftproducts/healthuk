// v36 collections for this area, connected to the real tables. See ./types.ts.
// Order matters: sync applies changes in this order and import moves collections in this order,
// so the records an action points at (events, audits, risks) exist before the actions.
import { HubError } from '../../../common/problem.filter.js';
import type { V36Adapter } from './types.js';
import { incAdapter, riddorAdapter } from './governance-inc.js';
import { actAdapter, audAdapter, progAdapter, tplAdapter } from './governance-audits.js';
import { polAdapter, riskAdapter } from './governance-pol-risk.js';
import { GOV_REGISTER_ADAPTERS } from './governance-registers.js';
import { GOV_VALUE_ADAPTERS } from './governance-values.js';

/** A database rule that refused a change becomes v36's "Not saved · …" with the rule's words. */
function friendly(e: unknown): never {
  if (e instanceof HubError) throw e;
  const msg = String((e as { message?: string })?.message ?? e);
  const m =
    /(?:ERROR|Message): `?([^`\n]+?)`?(?:\n|$)/.exec(msg) ??
    /violates check constraint "([^"]+)"/.exec(msg) ??
    /(duplicate key value[^\n]*)/.exec(msg);
  if (m && /check|constraint|immutable|fixed|duplicate|violat|kept/i.test(msg))
    throw new HubError('VALIDATION_FAILED', 400, `The change breaks a rule (${m[1]!.slice(0, 160)})`);
  throw e;
}
const guarded = (a: V36Adapter): V36Adapter => ({
  ...a,
  ...(a.apply
    ? { apply: (ctx, c) => a.apply!(ctx, c).catch(friendly) }
    : {}),
  ...(a.import && process.env.V36_DEBUG
    ? {
        import: (ctx, r, all) =>
          a.import!(ctx, r, all).catch((e: unknown) => {
            console.error('IMPORT', a.key, e);
            throw e;
          }),
      }
    : {}),
});

export const GOVERNANCE_ADAPTERS: V36Adapter[] = [
  tplAdapter,
  progAdapter,
  audAdapter,
  incAdapter,
  riddorAdapter,
  riskAdapter,
  polAdapter,
  actAdapter,
  ...GOV_REGISTER_ADAPTERS,
  ...GOV_VALUE_ADAPTERS,
].map(guarded);
