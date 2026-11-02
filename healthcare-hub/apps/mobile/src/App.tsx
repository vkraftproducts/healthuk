import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppRoot } from './app/AppRoot';
import { createServices } from './app/createServices';
import { loadConfig } from './config';
import { watchConnectivity } from './native/network';
import { onPushTap } from './native/push';
import { protectAppSwitcher } from './native/secureScreen';
import { colors } from './ui/theme';

export default function App() {
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  const services = useMemo(() => createServices(loadConfig(), () => onlineRef.current), []);
  useEffect(() => {
    void protectAppSwitcher();
    return watchConnectivity((o) => {
      onlineRef.current = o;
      setOnline(o);
    });
  }, []);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.card }}>
        <StatusBar style="dark" />
        <AppRoot services={services} online={online} subscribePushTaps={onPushTap} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
