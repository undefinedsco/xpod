import { describe, expect, it } from 'bun:test'
import { DesktopWindowRecovery, runFailedLoadRecovery } from '../src/window-recovery'

function contents(crashed: boolean) {
  return { isCrashed: () => crashed }
}

describe('DesktopWindowRecovery', () => {
  it('does not reload a healthy window on present', () => {
    const recovery = new DesktopWindowRecovery()
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(false)
  })

  it('reloads on present after a main-frame load failure', () => {
    const recovery = new DesktopWindowRecovery()
    recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: true })
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(true)
  })

  it('ignores subframe failures and aborted navigations', () => {
    const recovery = new DesktopWindowRecovery()
    recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: false })
    recovery.handleDidFailLoad({ errorCode: -3, isMainFrame: true })
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(false)
  })

  it('clears the failure once a page finishes loading', () => {
    const recovery = new DesktopWindowRecovery()
    recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: true })
    recovery.handleDidFinishLoad()
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(false)
  })

  it('reloads when the renderer crashed even without a load failure', () => {
    const recovery = new DesktopWindowRecovery()
    expect(recovery.shouldReloadOnPresent(contents(true))).toBe(true)
  })

  it('marks the window failed when the render process is gone', () => {
    const recovery = new DesktopWindowRecovery()
    recovery.handleRenderProcessGone()
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(true)
  })

  it('rate-limits automatic reloads after a crash', () => {
    const recovery = new DesktopWindowRecovery(1_000)
    expect(recovery.shouldAutoReload(10_000)).toBe(true)
    recovery.markReloaded(10_000)
    expect(recovery.shouldAutoReload(10_500)).toBe(false)
    expect(recovery.shouldAutoReload(11_000)).toBe(true)
  })

  it('markReloaded clears the failure flag', () => {
    const recovery = new DesktopWindowRecovery()
    recovery.handleRenderProcessGone()
    recovery.markReloaded()
    expect(recovery.shouldReloadOnPresent(contents(false))).toBe(false)
  })

  it('reports which load failures deserve recovery', () => {
    const recovery = new DesktopWindowRecovery()
    expect(recovery.handleDidFailLoad({ errorCode: -102, isMainFrame: true })).toBe(true)
    expect(recovery.handleDidFailLoad({ errorCode: -102, isMainFrame: false })).toBe(false)
    expect(recovery.handleDidFailLoad({ errorCode: -3, isMainFrame: true })).toBe(false)
  })

  it('keeps a single failed-load recovery in flight', () => {
    const recovery = new DesktopWindowRecovery()
    expect(recovery.isRecovering()).toBe(false)
    recovery.beginRecovery()
    expect(recovery.isRecovering()).toBe(true)
    recovery.endRecovery()
    expect(recovery.isRecovering()).toBe(false)
  })

  it('reports the remaining cooldown before another automatic reload', () => {
    const recovery = new DesktopWindowRecovery(1_000)
    expect(recovery.reloadCooldownRemainingMs(10_000)).toBe(0)
    recovery.markReloaded(10_000)
    expect(recovery.reloadCooldownRemainingMs(10_400)).toBe(600)
    expect(recovery.reloadCooldownRemainingMs(11_000)).toBe(0)
  })
})

describe('runFailedLoadRecovery sequencing', () => {
  /** A controllable recovery whose awaits can be parked mid-flight. */
  function controlled({ cooldownMs = 0 } = {}) {
    const recovery = new DesktopWindowRecovery(cooldownMs)
    recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: true })
    const gates = {
      reachable: undefined as undefined | ((value: boolean) => void),
      delay: undefined as undefined | (() => void),
      issuer: undefined as undefined | ((value: unknown) => void),
      cacheClear: undefined as undefined | (() => void),
    }
    let destroyed = false
    let loads = 0
    const events: string[] = []

    const input = {
      recovery,
      isDestroyed: () => destroyed,
      waitUntilReachable: () => new Promise<boolean>((resolve) => { gates.reachable = resolve }),
      // Parked so a page commit can land DURING the cooldown wait.
      delay: () => new Promise<void>((resolve) => { gates.delay = resolve }).then(() => { events.push('delay') }),
      discoverIssuer: () => new Promise<unknown>((resolve) => { gates.issuer = resolve }),
      load: async (stillNeeded: () => boolean) => {
        // Mirrors the real helper: cache clear first, THEN the final check.
        await new Promise<void>((resolve) => { gates.cacheClear = resolve })
        events.push('cache-cleared')
        if (!stillNeeded()) { events.push('skipped'); return }
        loads += 1
        events.push('loaded')
      },
    }
    return { recovery, input, gates, events,
      destroy: () => { destroyed = true },
      loadCount: () => loads };
  }

  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

  async function reachFinalGate(f: ReturnType<typeof controlled>) {
    await flush()
    f.gates.reachable!(true)
    await flush()
    f.gates.issuer!(undefined)
    await flush()
  }

  it('does not even start for an already healthy window', async () => {
    const recovery = new DesktopWindowRecovery(0)
    const calls: string[] = []
    const started = await runFailedLoadRecovery({
      recovery,
      isDestroyed: () => false,
      waitUntilReachable: async () => { calls.push('wait'); return true },
      delay: async () => { calls.push('delay') },
      discoverIssuer: async () => { calls.push('issuer') },
      load: async () => { calls.push('load') },
    })
    expect(started).toBe(false)
    expect(calls).toEqual([])
    expect(recovery.isRecovering()).toBe(false)
  })

  it('does not steal or end a recovery that is already running', async () => {
    const f = controlled()
    f.recovery.beginRecovery()
    const calls: string[] = []
    const started = await runFailedLoadRecovery({
      recovery: f.recovery,
      isDestroyed: () => false,
      waitUntilReachable: async () => { calls.push('wait'); return true },
      delay: async () => undefined,
      discoverIssuer: async () => undefined,
      load: async () => { calls.push('load') },
    })
    expect(started).toBe(false)
    expect(calls).toEqual([])
    // The other recovery still owns the flag; we must not have cleared it.
    expect(f.recovery.isRecovering()).toBe(true)
  })

  it('reloads once when the page is still failing', async () => {
    const f = controlled()
    const running = runFailedLoadRecovery(f.input)
    await reachFinalGate(f)
    f.gates.cacheClear!()
    expect(await running).toBe(true)
    expect(f.loadCount()).toBe(1)
    expect(f.recovery.needsRecovery()).toBe(false)
    expect(f.recovery.isRecovering()).toBe(false)
  })

  it('stops when a new page commits while waiting for the runtime (the RC418 race)', async () => {
    const f = controlled()
    const running = runFailedLoadRecovery(f.input)
    await flush()
    f.recovery.handleDidFinishLoad()
    f.gates.reachable!(true)
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
  })

  it('stops when a new page commits during cooldown', async () => {
    const f = controlled({ cooldownMs: 5_000 })
    // A recent reload makes the cooldown non-zero, so the delay path is taken.
    f.recovery.markReloaded()
    f.recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: true })
    const running = runFailedLoadRecovery(f.input)
    await flush()
    f.gates.reachable!(true)
    await flush()
    expect(f.gates.delay).toBeDefined()
    f.recovery.handleDidFinishLoad()
    f.gates.delay!()
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
  })

  it('stops when a new page commits during issuer discovery', async () => {
    const f = controlled()
    const running = runFailedLoadRecovery(f.input)
    await flush()
    f.gates.reachable!(true)
    await flush()
    f.recovery.handleDidFinishLoad()
    f.gates.issuer!(undefined)
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
  })

  it('stops at the final check after the cache clear, before loadURL', async () => {
    const f = controlled()
    const running = runFailedLoadRecovery(f.input)
    await reachFinalGate(f)
    f.gates.cacheClear!()
    f.recovery.handleDidFinishLoad()
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
    expect(f.events).toContain('skipped')
  })

  it('does not record a reload when the recovery is cancelled before navigating', async () => {
    // Zero cooldown: the delay is skipped and the cache await is the last place
    // a cancellation can arrive.
    const f = controlled({ cooldownMs: 0 })
    const running = runFailedLoadRecovery(f.input)
    await flush()
    f.gates.reachable!(true)
    await flush()
    f.gates.issuer!(undefined)
    await flush()
    // Cancelled at the final gate instead of navigating.
    f.recovery.handleDidFinishLoad()
    f.gates.cacheClear!()
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
    // Nothing re-armed the cooldown: a navigation would have set it again.
    expect(f.recovery.reloadCooldownRemainingMs()).toBe(0)
  })

  it('stops when the window is destroyed', async () => {
    const f = controlled()
    const running = runFailedLoadRecovery(f.input)
    await flush()
    f.destroy()
    f.gates.reachable!(true)
    expect(await running).toBe(false)
    expect(f.loadCount()).toBe(0)
  })

  it('propagates an unknown error and still clears recovering', async () => {
    const recovery = new DesktopWindowRecovery(0)
    recovery.handleDidFailLoad({ errorCode: -105, isMainFrame: true })
    await expect(runFailedLoadRecovery({
      recovery,
      isDestroyed: () => false,
      waitUntilReachable: async () => { throw new Error('runtime probe exploded') },
      delay: async () => undefined,
      discoverIssuer: async () => undefined,
      load: async () => undefined,
    })).rejects.toThrow('runtime probe exploded')
    expect(recovery.isRecovering()).toBe(false)
  })
})
