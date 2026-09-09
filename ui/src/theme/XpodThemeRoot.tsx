import { useContext, type ReactNode } from 'react';
import { XpodThemeProvider } from './XpodThemeProvider';
import { XpodThemeContext } from './xpod-theme-context';

export function XpodThemeRoot({ children }: { children: ReactNode }) {
  const inherited = useContext(XpodThemeContext);
  return inherited ? <>{children}</> : <XpodThemeProvider>{children}</XpodThemeProvider>;
}
