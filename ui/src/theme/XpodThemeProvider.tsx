import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyXpodTheme,
  optionalLocalStorage,
  readXpodThemePreference,
  resolveXpodTheme,
  systemThemeMedia,
  XPOD_THEME_STORAGE_KEY,
  type XpodTheme,
  type XpodThemePreference,
} from './xpod-theme-state';
import { XpodThemeContext, type XpodThemeContextValue } from './xpod-theme-context';

export function XpodThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<XpodThemePreference>(() => readXpodThemePreference());
  const [systemTheme, setSystemTheme] = useState<XpodTheme>(() => resolveXpodTheme('system'));
  const resolvedTheme = preference === 'system' ? systemTheme : preference;

  useEffect(() => {
    const media = systemThemeMedia();
    if (!media) return;
    const update = (event: Pick<MediaQueryListEvent, 'matches'>) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener?.(update);
    return () => media.removeListener?.(update);
  }, []);

  useEffect(() => {
    applyXpodTheme(resolvedTheme);
  }, [resolvedTheme]);

  const value = useMemo<XpodThemeContextValue>(() => ({
    preference,
    resolvedTheme,
    setPreference(nextPreference) {
      setPreferenceState(nextPreference);
      try {
        if (nextPreference === 'system') {
          optionalLocalStorage()?.removeItem(XPOD_THEME_STORAGE_KEY);
        } else {
          optionalLocalStorage()?.setItem(XPOD_THEME_STORAGE_KEY, nextPreference);
        }
      } catch {
        // Theme selection remains usable when browser storage is unavailable.
      }
    },
  }), [preference, resolvedTheme]);

  return <XpodThemeContext.Provider value={value}>{children}</XpodThemeContext.Provider>;
}
