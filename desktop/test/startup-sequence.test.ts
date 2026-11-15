import { describe, expect, it } from 'bun:test'
import { runStartupSequence } from '../src/startup-sequence'
import { WindowLifecycle, type WindowLifecycleWindow } from '../src/window-lifecycle'

/** A promise plus its settle controls, so ordering is asserted, not raced. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Minimal real-lifecycle target: only what WindowLifecycle actually calls. */
class LifecycleWindow implements WindowLifecycleWindow {
  destroyed = false
  visible = false
  focused = false
  showCalls = 0
  focusCalls = 0
  hideCalls = 0
  closedHandlers: Array<() => void> = []
  on(event: string, handler: () => void) { if (event === 'closed') this.closedHandlers.push(handler) }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  isMinimized() { return false }
  restore() { return undefined }
  show() { this.showCalls += 1; this.visible = true }
  focus() { this.focusCalls += 1; this.focused = true }
  hide() { this.hideCalls += 1; this.visible = false }
}

describe('desktop startup ordering', () => {
  it('creates the window before the runtime start settles', async () => {
    const runtime = deferred()
    const events: string[] = []
    const { settled } = runStartupSequence({
      createWindow: () => { events.push('window') },
      startRuntime: () => { events.push('start'); return runtime.promise },
      refreshTray: () => { events.push('tray') },
    })

    // The runtime promise is still pending, yet the window must already exist.
    await Promise.resolve()
    expect(events).toEqual(['window', 'start'])

    runtime.resolve()
    await settled
    expect(events).toEqual(['window', 'start', 'tray'])
  })

  it('refreshes the tray after the runtime start rejects', async () => {
    const runtime = deferred()
    const events: string[] = []
    let settledCalled = false
    const { settled } = runStartupSequence({
      createWindow: () => { events.push('window') },
      startRuntime: () => runtime.promise,
      refreshTray: () => { events.push('tray') },
      onSettled: () => { settledCalled = true },
    })

    runtime.reject(new Error('gateway never became ready'))
    await settled

    expect(events[0]).toBe('window')
    expect(settledCalled).toBe(true)
  })

  it('does not swallow a tray failure into an unhandled rejection', async () => {
    const runtime = deferred()
    const { settled } = runStartupSequence({
      createWindow: () => undefined,
      startRuntime: () => runtime.promise,
      refreshTray: () => { throw new Error('tray exploded') },
    })
    runtime.resolve()
    await expect(settled).resolves.toBeUndefined()
  })

  it('stays resolved even when the settle hook throws', async () => {
    const runtime = deferred()
    const { settled } = runStartupSequence({
      createWindow: () => undefined,
      startRuntime: () => runtime.promise,
      refreshTray: () => undefined,
      onSettled: () => { throw new Error('settle hook exploded') },
    })
    runtime.resolve()
    await expect(settled).resolves.toBeUndefined()
  })

  it('creates the lifecycle window while the runtime promise is still pending', async () => {
    const runtime = deferred()
    const lifecycle = new WindowLifecycle(() => new LifecycleWindow())
    const created: WindowLifecycleWindow[] = []
    const { settled } = runStartupSequence({
      createWindow: () => { created.push(lifecycle.ensureWindow()) },
      startRuntime: () => runtime.promise,
      refreshTray: () => undefined,
    })

    await Promise.resolve()
    // A real window OBJECT exists and is owned by the lifecycle even though the
    // runtime is unresolved. Visibility is NOT asserted here: a freshly created
    // window is shown by the ready-to-show / mode path, not by ensureWindow.
    expect(created).toHaveLength(1)
    expect(lifecycle.currentWindow()).toBe(created[0]!)
    expect((created[0] as LifecycleWindow).showCalls).toBe(0)

    runtime.resolve()
    await settled
    // Same window is retained; no second window was manufactured.
    expect(lifecycle.currentWindow()).toBe(created[0]!)
    expect(created).toHaveLength(1)
  })

  it('keeps the same window owned when the runtime start rejects', async () => {
    const runtime = deferred()
    const lifecycle = new WindowLifecycle(() => new LifecycleWindow())
    let createdCount = 0
    const { settled } = runStartupSequence({
      createWindow: () => { createdCount += 1; lifecycle.ensureWindow() },
      startRuntime: () => runtime.promise,
      refreshTray: () => undefined,
    })
    const first = lifecycle.currentWindow()

    runtime.reject(new Error('gateway never became ready'))
    await settled

    expect(createdCount).toBe(1)
    expect(lifecycle.currentWindow()).toBe(first)
    expect((first as LifecycleWindow).isDestroyed()).toBe(false)
  })

  it('creates the window while startup remains pending', async () => {
    const events: string[] = []
    runStartupSequence({
      createWindow: () => { events.push('window') },
      // Keep startup pending to test the independent window creation.
      startRuntime: () => new Promise<void>(() => undefined),
      refreshTray: () => { events.push('tray') },
    })
    await Promise.resolve()
    expect(events).toEqual(['window'])
  })
})
