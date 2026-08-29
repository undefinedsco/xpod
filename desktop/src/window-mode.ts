export type DesktopWindowMode = 'auth' | 'workspace'

export interface DesktopWindowModeTarget {
  isDestroyed(): boolean
  isVisible(): boolean
  setContentSize(width: number, height: number): void
  setMinimumSize(width: number, height: number): void
  setResizable(resizable: boolean): void
  setMaximizable(maximizable: boolean): void
  center(): void
  show(): void
  setTitle(title: string): void
}

export interface DesktopWindowModeTimers {
  setTimeout(callback: () => void, delay: number): unknown
  clearTimeout(timer: unknown): void
}

export const AUTH_WINDOW_MODE_SIZE = {
  width: 280,
  height: 400,
  minWidth: 280,
  minHeight: 400,
} as const

export const WORKSPACE_WINDOW_MODE_SIZE = {
  width: 1080,
  height: 760,
  minWidth: 420,
  minHeight: 520,
} as const

const DEFAULT_FIRST_MODE_FALLBACK_MS = 700

export function isDesktopWindowMode(value: unknown): value is DesktopWindowMode {
  return value === 'auth' || value === 'workspace'
}

/**
 * Keeps the native shell visually aligned with the renderer's current surface.
 *
 * The first BrowserWindow is created hidden. Product authentication is an
 * in-shell overlay, so the default and fallback size is the workspace frame.
 * Compact `auth` mode remains available for CSS identity-provider documents.
 */
export class DesktopWindowModeController {
  private ready = false
  private shown = false
  private mode: DesktopWindowMode | null = null
  private fallbackTimer: unknown
  private pageTitle = 'Xpod'

  public constructor(
    private readonly target: DesktopWindowModeTarget,
    private readonly timers: DesktopWindowModeTimers = globalThis,
    private readonly fallbackDelayMs = DEFAULT_FIRST_MODE_FALLBACK_MS,
  ) {
    this.fallbackTimer = this.timers.setTimeout(() => {
      this.applyMode('workspace')
    }, this.fallbackDelayMs)
  }

  public currentMode(): DesktopWindowMode | null {
    return this.mode
  }

  public markReadyToShow(): void {
    this.ready = true
    this.showWhenReady()
  }

  public applyUnknownMode(value: unknown): boolean {
    if (!isDesktopWindowMode(value)) return false
    this.applyMode(value)
    return true
  }

  public applyMode(mode: DesktopWindowMode): void {
    if (this.target.isDestroyed()) return
    if (this.mode === mode) {
      this.showWhenReady()
      return
    }

    this.mode = mode
    if (this.fallbackTimer) {
      this.timers.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = undefined
    }

    if (mode === 'auth') {
      this.target.setResizable(false)
      this.target.setMaximizable(false)
      this.target.setMinimumSize(AUTH_WINDOW_MODE_SIZE.minWidth, AUTH_WINDOW_MODE_SIZE.minHeight)
      this.target.setContentSize(AUTH_WINDOW_MODE_SIZE.width, AUTH_WINDOW_MODE_SIZE.height)
      this.target.setTitle('Xpod')
    } else {
      this.target.setResizable(true)
      this.target.setMaximizable(true)
      this.target.setMinimumSize(WORKSPACE_WINDOW_MODE_SIZE.minWidth, WORKSPACE_WINDOW_MODE_SIZE.minHeight)
      this.target.setContentSize(WORKSPACE_WINDOW_MODE_SIZE.width, WORKSPACE_WINDOW_MODE_SIZE.height)
      this.target.setTitle(this.pageTitle)
    }

    this.target.center()
    this.showWhenReady()
  }

  public dispose(): void {
    if (this.fallbackTimer) {
      this.timers.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = undefined
    }
  }

  public handlePageTitleUpdate(title: string): boolean {
    this.pageTitle = sanitizeWindowTitle(title) ?? 'Xpod'
    if (this.mode !== 'workspace') {
      this.target.setTitle('Xpod')
      return true
    }
    this.target.setTitle(this.pageTitle)
    return false
  }

  private showWhenReady(): void {
    if (!this.ready || this.shown || !this.mode || this.target.isDestroyed()) return
    this.shown = true
    if (!this.target.isVisible()) this.target.show()
  }
}

function sanitizeWindowTitle(title: string): string | undefined {
  const compact = title.replace(/\s+/g, ' ').trim()
  return compact || undefined
}
