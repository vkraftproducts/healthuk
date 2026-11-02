import { createContext, useContext } from 'react';

export type Tab = 'shift' | 'jobs' | 'policies' | 'messages' | 'profile';
export type Route =
  | { name: 'vdi' }
  | { name: 'cleaning' }
  | { name: 'job'; id: string }
  | { name: 'defect'; jobId?: string }
  | { name: 'fuel' };

export interface Nav {
  tab: Tab;
  setTab: (t: Tab) => void;
  push: (r: Route) => void;
  back: () => void;
}

export const NavCtx = createContext<Nav>({
  tab: 'shift',
  setTab: () => undefined,
  push: () => undefined,
  back: () => undefined,
});
export const useNav = () => useContext(NavCtx);
