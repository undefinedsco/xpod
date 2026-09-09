export type DesktopThemeName = 'light' | 'dark'

export interface DesktopNativeTheme {
  themeSource: 'system' | 'light' | 'dark'
  shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): void
  off?(event: 'updated', listener: () => void): void
}

export interface DesktopThemeWindow {
  setBackgroundColor(color: string): void
}

const DESKTOP_WINDOW_BACKGROUND: Record<DesktopThemeName, string> = {
  light: '#fafafa',
  dark: '#141414',
}

export function resolveDesktopTheme(nativeTheme: Pick<DesktopNativeTheme, 'shouldUseDarkColors'>): DesktopThemeName {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export function desktopWindowBackgroundColor(nativeTheme: Pick<DesktopNativeTheme, 'shouldUseDarkColors'>): string {
  return DESKTOP_WINDOW_BACKGROUND[resolveDesktopTheme(nativeTheme)]
}

export function applyDesktopThemeToWindow(
  window: DesktopThemeWindow,
  nativeTheme: Pick<DesktopNativeTheme, 'shouldUseDarkColors'>,
): void {
  window.setBackgroundColor(desktopWindowBackgroundColor(nativeTheme))
}

export function installDesktopNativeTheme(
  nativeTheme: DesktopNativeTheme,
  getWindows: () => readonly DesktopThemeWindow[],
): () => void {
  nativeTheme.themeSource = 'system'
  const applyTheme = () => {
    for (const window of getWindows()) {
      applyDesktopThemeToWindow(window, nativeTheme)
    }
  }

  nativeTheme.on('updated', applyTheme)
  applyTheme()

  return () => nativeTheme.off?.('updated', applyTheme)
}
