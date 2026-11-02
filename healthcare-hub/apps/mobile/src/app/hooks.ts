import type { CrewJobDto, CrewPolicyDto, CrewProfileDto } from '@hub/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, NetworkError } from '../core/api';
import type { CachedToday } from '../core/cache';
import { useOnline, useServices } from './services';

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  /** Shown from the device cache because the server could not be reached. */
  offline: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const errorText = (e: unknown): string =>
  e instanceof ApiError
    ? (e.detail ?? 'The server refused this request.')
    : e instanceof NetworkError
      ? 'No connection.'
      : 'Something went wrong.';

/**
 * Loads from the server when online and keeps the encrypted cache current; falls back to the cache
 * when offline. Expired cache entries are never shown.
 */
function useCached<T>(
  fetchLive: (() => Promise<T>) | null,
  loadCache: () => Promise<T | null>,
  saveCache: (v: T) => Promise<void>,
  deps: unknown[],
): Loaded<T> {
  const online = useOnline();
  const [state, setState] = useState<{ data: T | null; offline: boolean; error: string | null }>({
    data: null,
    offline: false,
    error: null,
  });
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (online && fetchLive) {
        try {
          const v = await fetchLive();
          await saveCache(v);
          if (alive.current) setState({ data: v, offline: false, error: null });
          return;
        } catch (e) {
          if (!(e instanceof NetworkError)) {
            if (alive.current) setState((p) => ({ ...p, error: errorText(e) }));
            return;
          }
        }
      }
      const c = await loadCache();
      if (alive.current)
        setState({ data: c, offline: true, error: c ? null : 'Not available offline.' });
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [online, ...deps]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { ...state, loading, refresh };
}

export function useToday(): Loaded<CachedToday> {
  const { api, cache, clock } = useServices();
  return useCached<CachedToday>(
    async () => ({ today: await api.get('/api/v1/crew/today'), savedAt: clock() }),
    () => cache.loadToday(),
    (v) => cache.saveToday(v.today),
    [],
  );
}

export function useJob(id: string, shiftEndsAt: string | null): Loaded<CrewJobDto> {
  const { api, cache } = useServices();
  return useCached<CrewJobDto>(
    () => api.get(`/api/v1/crew/jobs/${id}`),
    () => cache.loadJob(id),
    // Patient details are kept only until the shift ends.
    (j) => (shiftEndsAt ? cache.saveJob(j, shiftEndsAt) : Promise.resolve()),
    [id, shiftEndsAt],
  );
}

export function usePolicies(until: string | null): Loaded<CrewPolicyDto[]> {
  const { api, cache } = useServices();
  return useCached<CrewPolicyDto[]>(
    () => api.get('/api/v1/crew/policies/pending'),
    () => cache.load<CrewPolicyDto[]>('crew:policies'),
    (v) => (until ? cache.save('crew:policies', v, until) : Promise.resolve()),
    [until],
  );
}

export function useProfile(until: string | null): Loaded<CrewProfileDto> {
  const { api, cache } = useServices();
  return useCached<CrewProfileDto>(
    () => api.get('/api/v1/crew/profile'),
    () => cache.load<CrewProfileDto>('crew:profile'),
    (v) => (until ? cache.save('crew:profile', v, until) : Promise.resolve()),
    [until],
  );
}
