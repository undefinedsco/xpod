import { describe, expect, it } from 'bun:test'
import { DesktopWindowRecovery } from '../src/window-recovery'

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
