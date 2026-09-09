import { createContext, useContext } from 'react';
import type { XpodTheme, XpodThemePreference } from './xpod-theme-state';

export type XpodThemeContextValue = {
  preference: XpodThemePreference;
  resolvedTheme: XpodTheme;
  setPreference: (preference: XpodThemePreference) => void;
};

export const XpodThemeContext = createContext<XpodThemeContextValue | null>(null);

export function useXpodTheme(): XpodThemeContextValue {
  const value = useContext(XpodThemeContext);
  if (!value) throw new Error('useXpodTheme must be used within XpodThemeProvider');
  return value;
}
