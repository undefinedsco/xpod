export type XpodTheme = 'light' | 'dark';
export type XpodThemePreference = XpodTheme | 'system';

export const XPOD_THEME_STORAGE_KEY = 'xpod.theme';
export const XPOD_THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function readXpodThemePreference(
  storage: Pick<Storage, 'getItem'> | undefined = optionalLocalStorage(),
): XpodThemePreference {
  try {
    const stored = storage?.getItem(XPOD_THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveXpodTheme(
  preference: XpodThemePreference,
  media: Pick<MediaQueryList, 'matches'> | undefined = systemThemeMedia(),
): XpodTheme {
  if (preference !== 'system') return preference;
  return media?.matches ? 'dark' : 'light';
}

export function applyXpodTheme(
  theme: XpodTheme,
  root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement,
): void {
  if (!root) return;
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function initializeXpodTheme(): {
  preference: XpodThemePreference;
  resolvedTheme: XpodTheme;
} {
  const preference = readXpodThemePreference();
  const resolvedTheme = resolveXpodTheme(preference);
  applyXpodTheme(resolvedTheme);
  return { preference, resolvedTheme };
}

export function systemThemeMedia(): MediaQueryList | undefined {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia(XPOD_THEME_MEDIA_QUERY);
}

export function optionalLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
