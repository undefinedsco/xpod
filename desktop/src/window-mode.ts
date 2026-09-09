export type DesktopWindowMode = 'auth' | 'account' | 'workspace'

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

export type DesktopWindowModeListener = (mode: DesktopWindowMode) => void

export interface DesktopWindowModeNavigationSource {
  on(
    event: 'did-navigate' | 'did-navigate-in-page',
    listener: (_event: unknown, url: string, isMainFrame?: boolean) => void,
  ): unknown
}

export const AUTH_WINDOW_MODE_SIZE = {
  width: 280,
  height: 400,
  minWidth: 280,
  minHeight: 400,
} as const

export const ACCOUNT_WINDOW_MODE_SIZE = {
  width: 480,
  height: 640,
  minWidth: 420,
  minHeight: 520,
} as const

export const WORKSPACE_WINDOW_MODE_SIZE = {
  width: 1080,
  height: 760,
  minWidth: 420,
  minHeight: 520,
} as const

const DEFAULT_FIRST_MODE_FALLBACK_MS = 700

export function desktopWindowModeForUrl(value: string): DesktopWindowMode | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }

  const pathname = normalizeWindowModePathname(url.pathname)
  if (pathname === '/auth/callback') return 'auth'
  if (isCompactAccountPathname(pathname)) return 'account'
  return undefined
}

function normalizeWindowModePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

function isCompactAccountPathname(pathname: string): boolean {
  return pathname === '/.account'
    || pathname === '/.account/login'
    || pathname.startsWith('/.account/login/')
    || pathname === '/.account/create-pod'
    || pathname === '/.account/oidc/consent'
}

export function bindDesktopWindowModeNavigation(
  source: DesktopWindowModeNavigationSource,
  controller: DesktopWindowModeController,
): void {
  const applyRouteMode = (_event: unknown, url: string, isMainFrame = true): void => {
    if (!isMainFrame) return
    controller.applyModeForUrl(url)
  }

  source.on('did-navigate', applyRouteMode)
  source.on('did-navigate-in-page', applyRouteMode)
}

export function isDesktopWindowMode(value: unknown): value is DesktopWindowMode {
  return value === 'auth' || value === 'account' || value === 'workspace'
}

/**
 * Keeps the native shell visually aligned with the renderer's current surface.
 *
 * The first BrowserWindow is created hidden. Xpod Account authentication owns
 * the compact native window and renders edge-to-edge inside it. Product
 * workspaces use the resizable workspace frame; CSS identity-provider
 * documents can request compact Account mode when hosted by Electron.
 */
export class DesktopWindowModeController {
  private ready = false
  private shown = false
  private mode: DesktopWindowMode | null = null
  private fallbackTimer: unknown
  private pageTitle = 'Xpod'
  private readonly modeListeners: DesktopWindowModeListener[] = []

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

  public applyModeForUrl(value: string): boolean {
    const routeMode = desktopWindowModeForUrl(value)
    if (!routeMode) return false
    this.applyMode(routeMode)
    return true
  }

  public onModeChange(listener: DesktopWindowModeListener): () => void {
    this.modeListeners.push(listener)
    return () => {
      const index = this.modeListeners.indexOf(listener)
      if (index >= 0) this.modeListeners.splice(index, 1)
    }
  }

  public applyMode(mode: DesktopWindowMode): void {
    if (this.target.isDestroyed()) return
    if (this.mode === mode) {
      this.showWhenReady()
      return
    }

    this.mode = mode
    this.emitModeChange(mode)
    if (this.fallbackTimer) {
      this.timers.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = undefined
    }

    if (mode === 'auth' || mode === 'account') {
      const size = mode === 'account' ? ACCOUNT_WINDOW_MODE_SIZE : AUTH_WINDOW_MODE_SIZE
      this.target.setResizable(false)
      this.target.setMaximizable(false)
      this.target.setMinimumSize(size.minWidth, size.minHeight)
      this.target.setContentSize(size.width, size.height)
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

  private emitModeChange(mode: DesktopWindowMode): void {
    for (const listener of this.modeListeners) listener(mode)
  }
}

function sanitizeWindowTitle(title: string): string | undefined {
  const compact = title.replace(/\s+/g, ' ').trim()
  return compact || undefined
}
