import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api.js';

export type LiveState = 'connecting' | 'live' | 'reconnecting';

const MAX_BACKOFF_MS = 30_000;
/** Gives a burst of signals time to settle into one refetch. */
const REFETCH_DELAY_MS = 150;

/**
 * Keeps the screens current: when the server signals that this organisation's data changed, what
 * is on screen is refetched through the normal endpoints. The stream ends every few minutes by
 * design; it reconnects at once, and backs off only when it cannot connect. Returns null when
 * the API client has no stream (component tests).
 */
export function useLiveUpdates(api: ApiClient, orgId: string | null): LiveState | null {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!api.watchChanges || !orgId) return;
    const watch = api.watchChanges;
    const stop = new AbortController();
    let refetch: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(refetch);
      refetch = setTimeout(() => {
        for (const scope of ['list', 'one', 'me'])
          void qc.invalidateQueries({ queryKey: [scope, orgId] });
      }, REFETCH_DELAY_MS);
    };
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        stop.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });

    void (async () => {
      let failures = 0;
      let connectedBefore = false;
      while (!stop.signal.aborted) {
        let connected = false;
        try {
          await watch(
            orgId,
            (event) => {
              if (event === 'ready') {
                connected = true;
                failures = 0;
                setState('live');
                // Changes made while disconnected were not signalled.
                if (connectedBefore) refresh();
                connectedBefore = true;
              } else refresh();
            },
            stop.signal,
          );
        } catch {
          /* handled below: not connected, so back off */
        }
        if (stop.signal.aborted) break;
        if (!connected) {
          setState('reconnecting');
          await pause(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures));
          failures += 1;
        }
      }
    })();

    return () => {
      stop.abort();
      clearTimeout(refetch);
      setState('connecting');
    };
  }, [api, orgId, qc]);

  return api.watchChanges && orgId ? state : null;
}
