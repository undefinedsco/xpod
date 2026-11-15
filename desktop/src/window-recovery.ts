export interface WindowRecoveryWebContents {
  isCrashed(): boolean
}

// Electron reports ERR_ABORTED (-3) when a navigation is superseded by another
// one (redirect chains, SPA pushState follow-ups). That is normal traffic, not
// a broken page, so it must not mark the window as failed.
const ERR_ABORTED = -3

/**
 * Tracks whether the retained desktop window currently shows a broken page.
 *
 * Xpod keeps its BrowserWindow alive across hide/show cycles, so a window that
 * once failed to load (gateway down) or whose renderer crashed would otherwise
 * be re-presented forever in that broken state. The recovery flags here let
 * the host reload the target URL instead of merely showing the stale surface.
 */
export class DesktopWindowRecovery {
  private mainFrameFailed = false
  private lastAutoReloadAt = 0
  private recovering = false

  public constructor(private readonly autoReloadCooldownMs = 15_000) {}

  public handleDidFinishLoad(): void {
    this.mainFrameFailed = false
  }

  /** Reports whether this handler recorded a main-frame failure worth recovering. */
  public handleDidFailLoad({ errorCode, isMainFrame }: { errorCode: number; isMainFrame: boolean }): boolean {
    if (!isMainFrame || errorCode === ERR_ABORTED) return false
    this.mainFrameFailed = true
    return true
  }

  public handleRenderProcessGone(): void {
    this.mainFrameFailed = true
  }

  /** Re-presenting a broken window reloads the target instead of show-only. */
  public shouldReloadOnPresent(contents: WindowRecoveryWebContents): boolean {
    return this.mainFrameFailed || contents.isCrashed()
  }

  /** True while an automatic failed-load recovery is already waiting. */
  public isRecovering(): boolean {
    return this.recovering
  }

  /**
   * True while THIS window still shows the broken page a recovery was started for.
   *
   * A recovery waits on the runtime, the cooldown, issuer discovery and cache
   * invalidation. Any of those can outlive the failure: once a different document
   * finishes loading, `handleDidFinishLoad` clears the flag and the pending reload
   * must stand down instead of replacing the page the user is now on.
   */
  public needsRecovery(): boolean {
    return this.mainFrameFailed
  }

  public beginRecovery(): void {
    this.recovering = true
  }

  public endRecovery(): void {
    this.recovering = false
  }

  /**
   * Rate-limit automatic reloads so neither a crashing renderer nor a gateway
   * that is still starting can put the window into a tight reload loop.
   */
  public reloadCooldownRemainingMs(now = Date.now()): number {
    return Math.max(0, this.autoReloadCooldownMs - (now - this.lastAutoReloadAt))
  }

  public shouldAutoReload(now = Date.now()): boolean {
    return this.reloadCooldownRemainingMs(now) === 0
  }

  public markReloaded(now = Date.now()): void {
    this.mainFrameFailed = false
    this.lastAutoReloadAt = now
  }
}

/**
 * Everything a failed-load recovery waits on, injected so the real sequencing can
 * be exercised with controlled promises instead of a live Electron window.
 */
export interface FailedLoadRecoveryInput {
  recovery: DesktopWindowRecovery
  isDestroyed(): boolean
  waitUntilReachable(): Promise<boolean>
  delay(milliseconds: number): Promise<void>
  discoverIssuer(): Promise<unknown>
  /**
   * Clear caches and navigate. `stillNeeded` must be consulted immediately
   * before the real loadURL; the owner records the reload there, after the last
   * await, so a cancelled recovery never consumes the cooldown.
   */
  load(stillNeeded: () => boolean): Promise<void>
}

/**
 * Reloads a window that showed a failed page, but only while that same failure is
 * still the page's problem.
 *
 * The waits below (runtime reachability, the reload cooldown, issuer discovery and
 * the navigation-cache clear inside `load`) can each outlive the original failure:
 * the gateway becoming reachable is exactly what lets an in-flight page commit.
 * A committed page calls `handleDidFinishLoad`, which clears the SAME
 * `mainFrameFailed` flag this recovery is gated on, so every later step stands
 * down instead of replacing the live page.
 *
 * @returns true only when a navigation was actually issued.
 */
export async function runFailedLoadRecovery(input: FailedLoadRecoveryInput): Promise<boolean> {
  const { recovery } = input
  // Never steal or end another recovery, and never start one for a window whose
  // page is already fine or already gone.
  if (recovery.isRecovering() || input.isDestroyed() || !recovery.needsRecovery()) return false
  const stale = (): boolean => input.isDestroyed() || !recovery.needsRecovery()
  let navigated = false
  recovery.beginRecovery()
  try {
    if (!await input.waitUntilReachable()) return false
    if (stale()) return false
    const cooldown = recovery.reloadCooldownRemainingMs()
    if (cooldown > 0) await input.delay(cooldown)
    if (stale()) return false
    await input.discoverIssuer()
    if (stale()) return false
    // Last gate sits INSIDE load, after the cache await and immediately before
    // loadURL; markReloaded is recorded there so only a real navigation counts.
    await input.load(() => {
      if (stale()) return false
      recovery.markReloaded()
      navigated = true
      return true
    })
    return navigated
  } finally {
    recovery.endRecovery()
  }
}
