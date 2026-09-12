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
