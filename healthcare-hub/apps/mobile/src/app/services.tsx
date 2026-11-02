import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Api } from '../core/api';
import type { CrewCache } from '../core/cache';
import type { Outbox, OutboxItem } from '../core/outbox';
import type { Clock, FileStore } from '../core/ports';
import type { Session } from '../core/session';
import type { SyncEngine } from '../core/sync';

/** Everything screens use, injected so tests can run the real screens against fakes. */
export interface Services {
  api: Api;
  outbox: Outbox;
  sync: SyncEngine;
  cache: CrewCache;
  session: Session;
  files: FileStore;
  clock: Clock;
  controlPhone: string;
  takePhoto: () => Promise<{ uri: string; mime: 'image/jpeg' } | null>;
  /** One-tap call to control (tel: link). */
  callControl: () => void;
  /** Hands an address to the device maps app (no in-app driving UI). */
  openMaps: (address: string) => void;
  /** Applied on screens that show patient details. */
  useSecureScreen: () => void;
  /** Connects the device for push; called once after sign-in. */
  registerDevice: () => Promise<void>;
  deviceId: () => Promise<string>;
}

const Ctx = createContext<Services | null>(null);
const OnlineCtx = createContext<{ online: boolean }>({ online: true });

export function ServicesProvider({
  services,
  online,
  children,
}: {
  services: Services;
  online: boolean;
  children: ReactNode;
}) {
  return (
    <Ctx.Provider value={services}>
      <OnlineCtx.Provider value={{ online }}>{children}</OnlineCtx.Provider>
    </Ctx.Provider>
  );
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}

export const useOnline = () => useContext(OnlineCtx).online;

/** The outbox, re-read whenever it changes (pending badges, conflicts). */
export function useOutboxItems(): OutboxItem[] {
  const { outbox } = useServices();
  const [items, setItems] = useState<OutboxItem[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void outbox.list().then((x) => {
        if (live) setItems(x);
      });
    load();
    const off = outbox.subscribe(load);
    return () => {
      live = false;
      off();
    };
  }, [outbox]);
  return items;
}
