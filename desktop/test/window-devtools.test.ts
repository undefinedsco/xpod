import { describe, expect, it } from 'bun:test'
import {
  installCompactWindowDevToolsGuard,
  isDesktopDevToolsShortcut,
  setDesktopDevToolsMenuEnabled,
  type DesktopDevToolsInput,
} from '../src/window-devtools'
import type { DesktopWindowMode } from '../src/window-mode'

class FakeDevToolsWebContents {
  devToolsOpened = false
  closeCalls = 0
  listeners = new Map<string, (...args: unknown[]) => void>()

  isDevToolsOpened(): boolean {
    return this.devToolsOpened
  }

  closeDevTools(): void {
    this.closeCalls += 1
    this.devToolsOpened = false
  }

  on(event: 'before-input-event' | 'devtools-opened', listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, listener)
  }

  emitDevToolsOpened(): void {
    this.devToolsOpened = true
    this.listeners.get('devtools-opened')?.()
  }

  emitBeforeInput(input: DesktopDevToolsInput): boolean {
    let prevented = false
    this.listeners.get('before-input-event')?.({
      preventDefault: () => {
        prevented = true
      },
    }, input)
    return prevented
  }
}

describe('installCompactWindowDevToolsGuard', () => {
  it('closes already-open DevTools when entering compact auth or account mode', () => {
    let mode: DesktopWindowMode | null = 'workspace'
    const webContents = new FakeDevToolsWebContents()
    const guard = installCompactWindowDevToolsGuard(webContents, () => mode)

    webContents.devToolsOpened = true
    guard.sync()
    expect(webContents.closeCalls).toBe(0)

    mode = 'account'
    guard.sync()
    expect(webContents.closeCalls).toBe(1)

    webContents.devToolsOpened = true
    mode = 'auth'
    guard.sync()
    expect(webContents.closeCalls).toBe(2)
  })

  it('prevents common DevTools shortcuts only while in compact modes', () => {
    let mode: DesktopWindowMode | null = 'account'
    const webContents = new FakeDevToolsWebContents()
    installCompactWindowDevToolsGuard(webContents, () => mode)

    expect(webContents.emitBeforeInput({ key: 'I', control: true, shift: true })).toBe(true)
    expect(webContents.emitBeforeInput({ key: 'F12' })).toBe(true)

    mode = 'workspace'
    expect(webContents.emitBeforeInput({ key: 'I', control: true, shift: true })).toBe(false)
    expect(webContents.emitBeforeInput({ key: 'F12' })).toBe(false)
  })

  it('closes DevTools if any menu or programmatic entry opens it in compact mode', () => {
    const webContents = new FakeDevToolsWebContents()
    installCompactWindowDevToolsGuard(webContents, () => 'auth')

    webContents.emitDevToolsOpened()

    expect(webContents.devToolsOpened).toBe(false)
    expect(webContents.closeCalls).toBe(1)
  })
})

describe('isDesktopDevToolsShortcut', () => {
  it('matches Electron DevTools accelerators without blocking unrelated input', () => {
    expect(isDesktopDevToolsShortcut({ key: 'I', control: true, shift: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'J', control: true, shift: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'C', control: true, shift: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'I', meta: true, alt: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'J', meta: true, alt: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'C', meta: true, shift: true })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'F12' })).toBe(true)
    expect(isDesktopDevToolsShortcut({ key: 'I', control: true })).toBe(false)
    expect(isDesktopDevToolsShortcut({ key: 'R', control: true, shift: true })).toBe(false)
  })
})

describe('setDesktopDevToolsMenuEnabled', () => {
  it('toggles DevTools menu items recursively while preserving other entries', () => {
    const toggleDevTools = { role: 'toggleDevTools', enabled: true }
    const inspectElement = { id: 'inspect-element', label: 'Inspect Element', enabled: true }
    const regularReload = { role: 'reload', enabled: true }
    const menu = {
      items: [
        { label: 'File', submenu: { items: [{ label: 'Close', enabled: true }] } },
        { label: 'View', submenu: { items: [regularReload, toggleDevTools, inspectElement] } },
      ],
    }

    expect(setDesktopDevToolsMenuEnabled(menu, false)).toBe(true)
    expect(toggleDevTools.enabled).toBe(false)
    expect(inspectElement.enabled).toBe(false)
    expect(regularReload.enabled).toBe(true)

    expect(setDesktopDevToolsMenuEnabled(menu, true)).toBe(true)
    expect(toggleDevTools.enabled).toBe(true)
    expect(inspectElement.enabled).toBe(true)
    expect(regularReload.enabled).toBe(true)
  })
})
