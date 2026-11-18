const KEY = 'hh_theme_v36';

export type ThemeMode = 'light' | 'dark';

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* storage unavailable */
  }
  return 'light';
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', mode === 'dark');
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

export function toggleTheme(): ThemeMode {
  const next: ThemeMode = readTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  (window as unknown as { __hubSetTheme?: (m: ThemeMode) => void }).__hubSetTheme?.(next);
  return next;
}
