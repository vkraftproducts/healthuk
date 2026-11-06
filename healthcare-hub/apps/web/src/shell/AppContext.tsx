import { createContext, useContext } from 'react';
import type { MeResponse } from '@hub/contracts';
import type { ApiClient } from '../api.js';
import type { LiveState } from './useLiveUpdates.js';

export interface AppState {
  api: ApiClient;
  me: MeResponse;
  /** Selected organisation (sent as X-Org-Id). */
  orgId: string | null;
  setOrgId: (id: string) => void;
  refresh: () => void;
  /** False once the service check has failed (not while it is still loading). */
  sourceOk: boolean;
  /** Live updates connection; null when the app runs without one. */
  live: LiveState | null;
  /** Ends the session (absent when the app is rendered without an auth client, e.g. tests). */
  signOut?: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext missing');
  return v;
}
