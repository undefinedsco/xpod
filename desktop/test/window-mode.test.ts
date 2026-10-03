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
  size: [number, number] | undefined
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

  setSize(width: number, height: number): void {
    this.size = [width, height]
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
  it('keeps short authentication compact and opens long Account documents in the workspace', () => {
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/login/')).toBe('account')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/oidc/consent?prompt=consent')).toBe('workspace')
    expect(desktopWindowModeForUrl('http://127.0.0.1:3000/auth/callback?code=used')).toBe('auth')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/login/password/register/')).toBe('workspace')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/login/password/forgot/')).toBe('account')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/login/password/reset/?rid=record')).toBe('account')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/create-pod/')).toBe('workspace')
    expect(desktopWindowModeForUrl('https://id.undefineds.co/.account/account/')).toBe('workspace')
  })

  it('preserves Account window modes within a scoped OIDC interaction', () => {
    const base = 'https://id.example/.account/interaction/transaction-A/'
    expect(desktopWindowModeForUrl(`${base}login/password/`)).toBe('account')
    expect(desktopWindowModeForUrl(`${base}oidc/consent/`)).toBe('workspace')
    expect(desktopWindowModeForUrl(`${base}login/password/register/`)).toBe('workspace')
  })

  it('resizes an already shown workspace window after an Account SPA route event', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller)

    controller.markReadyToShow()
    controller.applyMode('workspace')
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])

    navigation.emit('did-navigate-in-page', 'https://id.undefineds.co/.account/login/password')

    expect(controller.currentMode()).toBe('account')
    // §5.1：Account 文档窗口可缩放
    expect(window.resizable).toBe(true)
    expect(window.size).toEqual([ACCOUNT_WINDOW_MODE_SIZE.width, ACCOUNT_WINDOW_MODE_SIZE.height])
  })

  it('expands registration and consent before returning to compact login', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller)
    const base = 'https://id.example/.account/interaction/transaction-A/'

    navigation.emit('did-navigate', base)
    expect(controller.currentMode()).toBe('account')
    expect(window.size).toEqual([440, 620])
    for (const document of ['login/password/register/', 'oidc/consent/', 'create-pod/']) {
      navigation.emit('did-navigate-in-page', `${base}${document}`)
      expect(controller.currentMode()).toBe('workspace')
      expect(window.contentSize).toEqual([1280, 800])
      expect(window.resizable).toBe(true)
      navigation.emit('did-navigate-in-page', `${base}login/password/`)
      expect(controller.currentMode()).toBe('account')
      expect(window.size).toEqual([440, 620])
    }
  })

  it('preserves renderer auth mode when cancellation removes only the product query', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller, 'http://127.0.0.1:3000')
    navigation.emit('did-navigate', 'http://127.0.0.1:3000/ai-connections?xpod-login=cancelled')
    controller.applyMode('auth')
    navigation.emit('did-navigate-in-page', 'http://127.0.0.1:3000/ai-connections')
    expect(controller.currentMode()).toBe('auth')
    expect(window.size).toEqual([AUTH_WINDOW_MODE_SIZE.width, AUTH_WINDOW_MODE_SIZE.height])
  })

  it('restores workspace mode when a compact route navigates back to a same-origin product page', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller, 'http://127.0.0.1:3000')

    controller.markReadyToShow()
    controller.applyMode('workspace')
    navigation.emit('did-navigate-in-page', 'http://127.0.0.1:3000/.account/login/password')
    expect(controller.currentMode()).toBe('account')

    navigation.emit('did-navigate-in-page', 'http://127.0.0.1:3000/settings/pod')
    expect(controller.currentMode()).toBe('workspace')
    expect(window.resizable).toBe(true)
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])

    navigation.emit('did-navigate', 'http://127.0.0.1:3000/.account/account/')
    expect(controller.currentMode()).toBe('workspace')
  })

  it('restores a full document viewport for external Account pages', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller, 'http://127.0.0.1:3000')

    controller.markReadyToShow()
    navigation.emit('did-navigate-in-page', 'http://127.0.0.1:3000/.account/login/password')
    expect(controller.currentMode()).toBe('account')

    navigation.emit('did-navigate', 'https://id.undefineds.co/.account/account/')
    expect(controller.currentMode()).toBe('workspace')
    expect(window.resizable).toBe(true)
  })

  it('ignores Account route changes from child frames', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    const navigation = new FakeNavigationSource()
    bindDesktopWindowModeNavigation(navigation, controller)

    controller.markReadyToShow()
    controller.applyMode('workspace')

    navigation.emit('did-navigate-in-page', 'https://id.undefineds.co/.account/login/password', false)

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
    expect(window.size).toEqual([AUTH_WINDOW_MODE_SIZE.width, AUTH_WINDOW_MODE_SIZE.height])
    expect(window.title).toBe('Xpod')

    controller.markReadyToShow()
    expect(window.showCalls).toBe(1)
  })

  it('gives WebID sign-in and the account service pages the same 440 x 620 window', () => {
    expect(AUTH_WINDOW_MODE_SIZE).toEqual({
      width: 440,
      height: 620,
      minWidth: 320,
      minHeight: 480,
    })
    expect(ACCOUNT_WINDOW_MODE_SIZE).toEqual({
      width: 440,
      height: 620,
      minWidth: 320,
      minHeight: 480,
    })
  })

  it('keeps the viewport stable across WebID and Account authentication transitions', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())
    controller.applyMode('auth')
    expect(window.size).toEqual([440, 620])
    expect(window.contentSize).toBeUndefined()
    controller.applyModeForUrl('https://id.example/.account/login/password/')
    expect(window.size).toEqual([440, 620])
    expect(window.contentSize).toBeUndefined()
    expect(window.minimumSize).toEqual([320, 480])
    controller.applyModeForUrl('https://id.example/.account/account/')
    expect(window.contentSize).toEqual([WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height])
  })

  it('opens the Account document as a resizable window', () => {
    const window = new FakeWindow()
    const controller = new DesktopWindowModeController(window, new FakeTimers())

    controller.applyMode('account')

    // §5.1：文档窗口允许用户调整尺寸，且保留用户尺寸（不反复重置）
    expect(window.resizable).toBe(true)
    expect(window.maximizable).toBe(true)
    expect(window.minimumSize).toEqual([ACCOUNT_WINDOW_MODE_SIZE.minWidth, ACCOUNT_WINDOW_MODE_SIZE.minHeight])
    expect(window.size).toEqual([ACCOUNT_WINDOW_MODE_SIZE.width, ACCOUNT_WINDOW_MODE_SIZE.height])
    expect(window.title).toBe('Xpod')
  })

  it('uses the October desktop design canvas as the default workspace viewport', () => {
    expect(WORKSPACE_WINDOW_MODE_SIZE).toEqual({ width: 1280, height: 800, minWidth: 640, minHeight: 560 })
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
