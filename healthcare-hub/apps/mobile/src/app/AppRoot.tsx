import type { MeResponse } from '@hub/contracts';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { PushRoute } from '../core/push';
import type { SessionState, WipeReason } from '../core/session';
import { SignIn, Unlock } from '../screens/Auth';
import { Main } from './Main';
import { ServicesProvider, type Services } from './services';

export const SYNC_INTERVAL_MS = 60_000;
/** Back from the background (e.g. the maps app) after this long: unlock again. */
export const RELOCK_AFTER_MS = 5 * 60_000;

/**
 * Session gate and background work: sign-in, unlock, organisation selection, push registration and
 * the sync loop (on reconnect, on foreground and every 60 seconds while online).
 */
export function AppRoot({
  services,
  online,
  subscribePushTaps,
}: {
  services: Services;
  online: boolean;
  subscribePushTaps?: (open: (r: PushRoute) => void) => () => void;
}) {
  const { session, sync, api, clock } = services;
  const [state, setState] = useState<SessionState>(session.state);
  const [why, setWhy] = useState<WipeReason | undefined>();
  const [pushRoute, setPushRoute] = useState<PushRoute | null>(null);
  const bgAt = useRef<number | null>(null);

  useEffect(() => {
    const off = session.subscribe((s, w) => {
      setState(s);
      if (w) setWhy(w);
    });
    if (session.state === 'SIGNED_OUT') void session.restore();
    return off;
  }, [session]);

  // After unlock: pick the organisation, register for push, send anything waiting.
  useEffect(() => {
    if (state !== 'READY' || !online) return;
    let live = true;
    void (async () => {
      try {
        if (!session.getOrgId()) {
          const me = await api.get<MeResponse>('/api/v1/me');
          const m = me.memberships.find((x) => x.roleKey === 'CREW') ?? me.memberships[0];
          if (m && live) await session.setOrgId(m.organisationId);
        }
        await services.registerDevice();
      } catch {
        // Offline or refused: retried on the next reconnect; revocation is handled by the client.
      }
      if (live) void sync.run();
    })();
    return () => {
      live = false;
    };
  }, [state, online, api, session, services, sync]);

  useEffect(() => {
    if (state !== 'READY' || !online) return;
    const t = setInterval(() => void sync.run(), SYNC_INTERVAL_MS);
    return () => clearInterval(t);
  }, [state, online, sync]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') bgAt.current = clock().getTime();
      if (s === 'active') {
        if (bgAt.current !== null && clock().getTime() - bgAt.current > RELOCK_AFTER_MS)
          session.lock();
        bgAt.current = null;
        if (online && session.state === 'READY') void sync.run();
      }
    });
    return () => sub.remove();
  }, [clock, online, session, sync]);

  useEffect(() => subscribePushTaps?.((r) => setPushRoute(r)), [subscribePushTaps]);

  return (
    <ServicesProvider services={services} online={online}>
      {state === 'READY' ? (
        <Main pushRoute={pushRoute} />
      ) : state === 'LOCKED' ? (
        <Unlock />
      ) : (
        <SignIn {...(why ? { why } : {})} />
      )}
    </ServicesProvider>
  );
}
