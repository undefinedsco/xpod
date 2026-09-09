import { describe, expect, it } from 'bun:test'
import {
  ACCOUNT_WINDOW_MODE_SIZE,
  AUTH_WINDOW_MODE_SIZE,
  DesktopWindowModeController,
  bindDesktopWindowModeNavigation,
  desktopWindowModeForUrl,
  WORKSPACE_WINDOW_MODE_SIZE,
  isDesktopWindowMode,
  type DesktopWindowModeTarget,
  type DesktopWindowModeTimers,
} from '../src/window-mode'

class FakeWindow implements DesktopWindowModeTarget {
  destroyed = false
  visible = false
  contentSize: [number, number] | undefined
  minimumSize: [number, number] | undefined
  resizable: boolean | undefined
  maximizable: boolean | undefined
  title = ''
  centerCalls = 0
  showCalls = 0

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  setContentSize(width: number, height: number): void {
    this.contentSize = [width, height]
  }

  setMinimumSize(width: number, height: number): void {
    this.minimumSize = [width, height]
  }

  setResizable(resizable: boolean): void {
    this.resizable = resizable
  }

  setMaximizable(maximizable: boolean): void {
    this.maximizable = maximizable
  }

  center(): void {
    this.centerCalls += 1
  }

  show(): void {
    this.visible = true
    this.showCalls += 1
  }

  setTitle(title: string): void {
    this.title = title
  }
}

class FakeNavigationSource {
  listeners = new Map<string, (_event: unknown, url: string, isMainFrame?: boolean) => void>()

  on(event: 'did-navigate' | 'did-navigate-in-page', listener: (_event: unknown, url: string, isMainFrame?: boolean) => void): void {
    this.listeners.set(event, listener)
  }

  emit(event: 'did-navigate' | 'did-navigate-in-page', url: string, isMainFrame?: boolean): void {
    this.listeners.get(event)?.({}, url, isMainFrame)
  }
}

class FakeTimers implements DesktopWindowModeTimers {
  callbacks: Array<() => void> = []
  cleared: unknown[] = []

  setTimeout(callback: () => void): unknown {
    this.callbacks.push(callback)
    return callback
  }

  clearTimeout(timer: unknown): void {
    this.cleared.push(timer)
  }

  runLast(): void {
    this.callbacks.at(-1)?.()
  }
}

describe('DesktopWindowModeController', () => {
  it('maps SPA Account provisioning routes to compact account mode', () => {
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/create-pod/')).toBe('account')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/oidc/consent?prompt=consent')).toBe('account')
    expect(desktopWindowModeForUrl('http://127.0.0.1:3000/auth/callback?code=used')).toBe('auth')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/account/')).toBeUndefined()
  })

  it('shrinks an already shown workspace window after an Account SPA route event', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller)

    controller.markReadyToShow()
    controller.applyMode('workspace')
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])

    navigation.emit('did-navigate-in-page', 'https://id.undefineds.co/.account/create-pod/')

    expect(controller.currentMode()).toBe('account')
    expect(window.resizable).toBe(false)
    expect(window.contentSize).toEqual([ACCOUNT_WINDOW_MODE_SIZE.width, ACCOUNT_WINDOW_MODE_SIZE.height])
  })

  it('ignores Account route changes from child frames', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller)

    controller.markReadyToShow()
    controller.applyMode('workspace')

    navigation.emit('did-navigate-in-page', 'https://id.undefineds.co/.account/create-pod/', false)

    expect(controller.currentMode()).toBe('workspace')
    expect(window.resizable).toBe(true)
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])
  })

  it('accepts only strict auth/workspace mode values', () => {
    expect(isDesktopWindowMode('auth')).toBe(true)
    expect(isDesktopWindowMode('workspace')).toBe(true)
    expect(isDesktopWindowMode('account')).toBe(true)
    expect(isDesktopWindowMode('Auth')).toBe(false)
    expect(isDesktopWindowMode('dashboard')).toBe(false)
    expect(isDesktopWindowMode(null)).toBe(false)
  })

  it('keeps the window hidden until ready-to-show and a valid auth mode are both present', () => {
    const window = new FakeWindow()
    const timers = new FakeTimers()
    const controller = new DesktopWindowModeController(window, timers)

    expect(controller.applyUnknownMode('bad')).toBe(false)
    expect(window.showCalls).toBe(0)

    expect(controller.applyUnknownMode('auth')).toBe(true)
    expect(window.showCalls).toBe(0)
    expect(window.resizable).toBe(false)
    expect(window.maximizable).toBe(false)
    expect(window.minimumSize).toEqual([AUTH_WINDOW_MODE_SIZE.minWidth, AUTH_WINDOW_MODE_SIZE.minHeight])
    expect(window.contentSize).toEqual([AUTH_WINDOW_MODE_SIZE.width, AUTH_WINDOW_MODE_SIZE.height])
    expect(window.title).toBe('Xpod')

    controller.markReadyToShow()
    expect(window.showCalls).toBe(1)
  })

  it('keeps WebID auth and Account documents in separate compact viewport sizes', () => {
    expect(AUTH_WINDOW_MODE_SIZE).toEqual({
      width: 280,
      height: 400,
      minWidth: 280,
      minHeight: 400,
    })
    expect(ACCOUNT_WINDOW_MODE_SIZE).toEqual({
      width: 480,
      height: 640,
      minWidth: 420,
      minHeight: 520,
    })
  })

  it('uses the wider compact Account viewport without enabling resize controls', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())

    controller.applyMode('account')

    expect(window.resizable).toBe(false)
    expect(window.maximizable).toBe(false)
    expect(window.minimumSize).toEqual([ACCOUNT_WINDOW_MODE_SIZE.minWidth, ACCOUNT_WINDOW_MODE_SIZE.minHeight])
    expect(window.contentSize).toEqual([ACCOUNT_WINDOW_MODE_SIZE.width, ACCOUNT_WINDOW_MODE_SIZE.height])
    expect(window.title).toBe('Xpod')
  })

  it('restores workspace size and resizability without showing twice', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())

    controller.markReadyToShow()
    controller.applyMode('workspace')
    controller.applyMode('workspace')

    expect(window.showCalls).toBe(1)
    expect(window.resizable).toBe(true)
    expect(window.maximizable).toBe(true)
    expect(window.minimumSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.minWidth, WORKSPACE_WINDOW_MODE_SIZE.minHeight])
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])
    expect(window.centerCalls).toBe(1)
  })

  it('uses workspace mode as the safe fallback if the renderer never reports a mode', () => {
    const window = new FakeWindow()
    const timers = new FakeTimers()
    const controller = new DesktopWindowModeController(window, timers)

    controller.markReadyToShow()
    timers.runLast()

    expect(controller.currentMode()).toBe('workspace')
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])
    expect(window.showCalls).toBe(1)
  })

  it('suppresses page titles before workspace mode and restores them in workspace mode', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())

    expect(controller.handlePageTitleUpdate('Xpod Dashboard')).toBe(true)
    expect(window.title).toBe('Xpod')

    controller.applyMode('workspace')
    expect(window.title).toBe('Xpod Dashboard')

    expect(controller.handlePageTitleUpdate('AI Config · Xpod')).toBe(false)
    expect(window.title).toBe('AI Config · Xpod')

    controller.applyMode('auth')
    expect(window.title).toBe('Xpod')
  })
})
