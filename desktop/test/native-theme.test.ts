import { describe, expect, it } from 'bun:test'
import {
  applyDesktopThemeToWindow,
  desktopWindowBackgroundColor,
  installDesktopNativeTheme,
  resolveDesktopTheme,
  type DesktopNativeTheme,
} from '../src/native-theme'

function theme(dark: boolean): DesktopNativeTheme & { emit(): void } {
  const listeners = new Set<() => void>()
  return {
    themeSource: 'light',
    shouldUseDarkColors: dark,
    on(_event, listener) {
      listeners.add(listener)
    },
    off(_event, listener) {
      listeners.delete(listener)
    },
    emit() {
      for (const listener of listeners) listener()
    },
  }
}

describe('desktop native theme', () => {
  it('resolves window background from the current system theme', () => {
    expect(resolveDesktopTheme({ shouldUseDarkColors: false })).toBe('light')
    expect(desktopWindowBackgroundColor({ shouldUseDarkColors: false })).toBe('#fafafa')
    expect(resolveDesktopTheme({ shouldUseDarkColors: true })).toBe('dark')
    expect(desktopWindowBackgroundColor({ shouldUseDarkColors: true })).toBe('#141414')
  })

  it('applies the resolved background to a BrowserWindow-like target', () => {
    const applied: string[] = []
    applyDesktopThemeToWindow({ setBackgroundColor: (color) => applied.push(color) }, { shouldUseDarkColors: true })
    expect(applied).toEqual(['#141414'])
  })

  it('uses system theme and updates all existing windows when Electron reports a theme change', () => {
    const native = theme(false)
    const first: string[] = []
    const second: string[] = []
    const windows = [
      { setBackgroundColor: (color: string) => first.push(color) },
      { setBackgroundColor: (color: string) => second.push(color) },
    ]

    installDesktopNativeTheme(native, () => windows)
    expect(native.themeSource).toBe('system')
    expect(first).toEqual(['#fafafa'])
    expect(second).toEqual(['#fafafa'])

    native.shouldUseDarkColors = true
    native.emit()
    expect(first).toEqual(['#fafafa', '#141414'])
    expect(second).toEqual(['#fafafa', '#141414'])
  })
})
