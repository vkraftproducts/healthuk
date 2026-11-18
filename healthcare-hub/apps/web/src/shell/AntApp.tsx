import { App as AntAppShell, ConfigProvider } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { hubTheme } from './antdTheme.js';
import { applyTheme, readTheme, type ThemeMode } from './theme.js';

/** Ant Design root: themed ConfigProvider + App context (message/modal). */
export function AntApp({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => readTheme());

  useEffect(() => {
    applyTheme(mode);
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'hh_theme_v36' && (e.newValue === 'light' || e.newValue === 'dark'))
        setMode(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [mode]);

  // Expose setter for Shell theme toggle without prop drilling.
  useEffect(() => {
    (window as unknown as { __hubSetTheme?: (m: ThemeMode) => void }).__hubSetTheme = (m) => {
      applyTheme(m);
      setMode(m);
    };
    return () => {
      delete (window as unknown as { __hubSetTheme?: unknown }).__hubSetTheme;
    };
  }, []);

  return (
    <ConfigProvider theme={hubTheme(mode)}>
      <AntAppShell>{children}</AntAppShell>
    </ConfigProvider>
  );
}

export function setAppTheme(mode: ThemeMode): void {
  applyTheme(mode);
  (window as unknown as { __hubSetTheme?: (m: ThemeMode) => void }).__hubSetTheme?.(mode);
}
