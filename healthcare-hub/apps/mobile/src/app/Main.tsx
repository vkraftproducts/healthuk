import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PushRoute } from '../core/push';
import { Cleaning } from '../screens/Cleaning';
import { Defect } from '../screens/Defect';
import { Fuel } from '../screens/Fuel';
import { JobDetail } from '../screens/JobDetail';
import { Jobs } from '../screens/Jobs';
import { Messages } from '../screens/Messages';
import { MyShift } from '../screens/MyShift';
import { Policies } from '../screens/Policies';
import { Profile } from '../screens/Profile';
import { Vdi } from '../screens/Vdi';
import { colors, TOUCH } from '../ui/theme';
import { NavCtx, type Nav, type Route, type Tab } from './nav';
import { useOutboxItems } from './services';

const TABS: { key: Tab; label: string }[] = [
  { key: 'shift', label: 'My shift' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'policies', label: 'Policies' },
  { key: 'messages', label: 'Messages' },
  { key: 'profile', label: 'Profile' },
];

export function Main({ pushRoute }: { pushRoute?: PushRoute | null }) {
  const [tab, setTabState] = useState<Tab>('shift');
  const [stack, setStack] = useState<Route[]>([]);
  const items = useOutboxItems();
  const attention = items.filter((i) => i.state !== 'PENDING').length;

  const setTab = useCallback((t: Tab) => {
    setStack([]);
    setTabState(t);
  }, []);
  const nav: Nav = useMemo(
    () => ({
      tab,
      setTab,
      push: (r) => setStack((s) => [...s, r]),
      back: () => setStack((s) => s.slice(0, -1)),
    }),
    [tab, setTab],
  );

  useEffect(() => {
    if (!pushRoute) return;
    if (pushRoute.screen === 'job') setStack([{ name: 'job', id: pushRoute.id }]);
    else setTab(pushRoute.screen === 'policies' ? 'policies' : 'shift');
  }, [pushRoute, setTab]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length === 0) return false;
      nav.back();
      return true;
    });
    return () => sub.remove();
  }, [stack.length, nav]);

  const top = stack[stack.length - 1];
  return (
    <NavCtx.Provider value={nav}>
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          {top ? (
            top.name === 'vdi' ? (
              <Vdi />
            ) : top.name === 'cleaning' ? (
              <Cleaning />
            ) : top.name === 'job' ? (
              <JobDetail key={top.id} id={top.id} />
            ) : top.name === 'defect' ? (
              <Defect {...(top.jobId ? { jobId: top.jobId } : {})} />
            ) : (
              <Fuel />
            )
          ) : tab === 'shift' ? (
            <MyShift />
          ) : tab === 'jobs' ? (
            <Jobs />
          ) : tab === 'policies' ? (
            <Policies />
          ) : tab === 'messages' ? (
            <Messages />
          ) : (
            <Profile />
          )}
        </View>
        <View style={s.tabs} accessibilityRole="tablist">
          {TABS.map((t) => {
            const on = tab === t.key && !top;
            const label =
              t.key === 'messages' && attention > 0 ? `${t.label} (${attention})` : t.label;
            return (
              <Pressable
                key={t.key}
                onPress={() => setTab(t.key)}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: on }}
                style={[s.tab, on && s.tabOn]}
              >
                <Text style={[s.tabText, on && { color: colors.primary }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </NavCtx.Provider>
  );
}

const s = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  tab: {
    flex: 1,
    minHeight: TOUCH,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  tabOn: { borderTopWidth: 3, borderColor: colors.primary, backgroundColor: colors.accentBg },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.muted, textAlign: 'center' },
});
