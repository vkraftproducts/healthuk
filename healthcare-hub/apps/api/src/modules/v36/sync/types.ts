// The link between the v36 front end and the real tables (step 2, 19 Nov 2026).
//
// v36 keeps its data in one object S of named collections (S.people, S.def, S.inc …). Each
// collection that is connected to the database has an adapter here:
//  - load()  builds that collection, in v36's exact shape, from the real tables;
//  - apply() takes one changed record (what v36's button did to it) and makes the same change
//            through our rules, or throws a HubError the screen shows as v36's own message.
// A collection without an adapter stays in the organisation's saved copy (v36_workspace_doc).
import type { TenantTx } from '@hub/db';
import type { HubRequestContext } from '../../../common/context.js';

/** A record of a collection: v36 records are plain JSON objects. */
export type V36Record = Record<string, unknown>;

export interface V36Change {
  /** The S key, e.g. 'def'. */
  key: string;
  /** The record id within the collection (dict key, or the record's id field for lists). */
  id: string;
  /** The record as the server last sent it (null = new). */
  before: V36Record | null;
  /** The record after v36's button ran (null = removed). */
  after: V36Record | null;
}

export interface V36Ctx {
  hub: HubRequestContext;
  orgId: string;
  userId: string;
  /** The v36 button that caused the change (data-act), for the audit trail. */
  act: string | null;
  /** v36's "today" (its time machine can move it in the demo). */
  today: string;
  /**
   * Calls one of our existing endpoints as the signed-in person (same permissions, validation,
   * rules and audit trail as any other screen). Throws the endpoint's HubError on refusal.
   * Prefer this for writes, so v36 changes go through the rules already built and tested.
   */
  api<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    version?: number,
  ): Promise<T>;
  /** Runs fn in a tenant transaction (RLS on), for direct reads or for writes with no endpoint. */
  tx<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export interface V36Adapter {
  key: string;
  /**
   * 'map': S[key] is an object keyed by id. 'list': S[key] is an array of records with `idField`.
   * 'value': S[key] is one value (number, string, list, object or null), sent as the single
   * record id '_'. In 'map' and 'value', a "record" may be any JSON value, not only an object:
   * adapters for such collections cast before/after accordingly.
   */
  shape: 'map' | 'list' | 'value';
  /** For lists: which field is the record id (default 'id'). */
  idField?: string;
  /** Who may see this collection at all; others get it empty. Default: every member. */
  canRead?(ctx: V36Ctx): boolean;
  load(ctx: V36Ctx): Promise<unknown>;
  /** Missing = the collection is read-only from v36 (changes are refused). */
  apply?(ctx: V36Ctx, change: V36Change): Promise<void>;
  /**
   * One-time move of the organisation's saved v36 copy (step 1 data) into the real tables, run
   * when isEmpty() says the organisation has no rows yet. Must keep v36's codes (DEF-080…).
   */
  isEmpty?(ctx: V36Ctx): Promise<boolean>;
  import?(
    ctx: V36Ctx,
    records: Record<string, V36Record> | V36Record[],
    all: Record<string, unknown>,
  ): Promise<void>;
}
