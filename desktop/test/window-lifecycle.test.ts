import { describe, expect, it } from 'bun:test'
import {
  WindowLifecycle,
  type WindowCloseEvent,
  type WindowLifecycleWindow,
} from '../src/window-lifecycle'

class FakeWindow implements WindowLifecycleWindow {
  destroyed = false
  visible = true
  focused = false
  showCalls = 0
  focusCalls = 0
  hideCalls = 0
  private closedListener?: () => void

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  isFocused(): boolean {
    return this.focused
  }

  show(): void {
    this.visible = true
    this.showCalls += 1
  }

  hide(): void {
    this.visible = false
    this.hideCalls += 1
  }

  focus(): void {
    this.focused = true
    this.focusCalls += 1
  }

  on(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListener = listener
  }

  emitClosed(): void {
    this.closedListener?.()
  }
}

function closeEvent(): WindowCloseEvent & { prevented: boolean } {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe('WindowLifecycle', () => {
  it('hides the current window on user close without entering application quit', () => {
    const window = new FakeWindow()
    const lifecycle = new WindowLifecycle(() => window)
    const event = closeEvent()

    lifecycle.ensureWindow()
    lifecycle.handleClose(window, event)

    expect(event.prevented).toBe(true)
    expect(window.hideCalls).toBe(1)
    expect(window.isDestroyed()).toBe(false)
    expect(lifecycle.isQuitting()).toBe(false)
    expect(lifecycle.currentWindow()).toBe(window)
  })

  it('shows the same renderer after close instead of creating a second login session', () => {
    const window = new FakeWindow()
    const create = () => window
    const lifecycle = new WindowLifecycle(create)

    lifecycle.ensureWindow()
    const event = closeEvent()
    lifecycle.handleClose(window, event)
    const reopened = lifecycle.ensureWindow()

    expect(reopened).toBe(window)
    expect(window.hideCalls).toBe(1)
    expect(window.showCalls).toBe(1)
    expect(window.focusCalls).toBe(1)
  })

  it('refocuses a hidden window even when Electron reports stale focused state', () => {
    const window = new FakeWindow()
    window.focused = true
    const lifecycle = new WindowLifecycle(() => window)

    lifecycle.ensureWindow()
    lifecycle.handleClose(window, closeEvent())
    lifecycle.handleTrayOpen()

    expect(window.showCalls).toBe(1)
    expect(window.focusCalls).toBe(1)
  })

  it('reuses and focuses the current window for activate, tray open, and second instance', () => {
    const window = new FakeWindow()
    window.focused = false
    const lifecycle = new WindowLifecycle(() => window)

    const first = lifecycle.ensureWindow()
    const activated = lifecycle.handleActivate()
    const trayOpened = lifecycle.handleTrayOpen()
    const secondInstance = lifecycle.handleSecondInstance()

    expect(activated).toBe(first)
    expect(trayOpened).toBe(first)
    expect(secondInstance).toBe(first)
    expect(window.showCalls).toBe(3)
    expect(window.focusCalls).toBe(3)
  })

  it('re-presents the retained renderer even when Electron reports it as visible', () => {
    const window = new FakeWindow()
    const lifecycle = new WindowLifecycle(() => window)

    lifecycle.ensureWindow()
    window.visible = true
    const reopened = lifecycle.handleTrayOpen()

    expect(reopened).toBe(window)
    expect(window.showCalls).toBe(1)
    expect(window.focusCalls).toBe(1)
  })

  it('allows the explicit quit path to close normally without intercepting it', () => {
    const window = new FakeWindow()
    const lifecycle = new WindowLifecycle(() => window)
    const event = closeEvent()

    lifecycle.markQuitting()
    lifecycle.ensureWindow()
    lifecycle.handleClose(window, event)

    expect(lifecycle.isQuitting()).toBe(true)
    expect(event.prevented).toBe(false)
    expect(window.hideCalls).toBe(0)
  })

  it('can hide the retained UI for a resident app quit without entering full quit', () => {
    const window = new FakeWindow()
    const lifecycle = new WindowLifecycle(() => window)

    lifecycle.ensureWindow()
    lifecycle.hideWindow()

    expect(window.hideCalls).toBe(1)
    expect(window.isDestroyed()).toBe(false)
    expect(lifecycle.isQuitting()).toBe(false)
    expect(lifecycle.currentWindow()).toBe(window)
  })
})
