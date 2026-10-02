export type DesktopWindowMode = 'auth' | 'account' | 'workspace'

export interface DesktopWindowModeTarget {
  isDestroyed(): boolean
  isVisible(): boolean
  setSize(width: number, height: number): void
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

/**
 * The sign-in window: application-side WebID sign-in (A group) and the account
 * short sign-in/recovery pages (B group) share 280 x 400 native logical bounds.
 * The content fills the available viewport after native window chrome.
 * Registration, full consent and Pod management use the workspace frame.
 */
const SIGN_IN_WINDOW_SIZE = {
  width: 280,
  height: 400,
  minWidth: 280,
  minHeight: 400,
} as const

export const AUTH_WINDOW_MODE_SIZE = SIGN_IN_WINDOW_SIZE

export const ACCOUNT_WINDOW_MODE_SIZE = SIGN_IN_WINDOW_SIZE

export const WORKSPACE_WINDOW_MODE_SIZE = {
  width: 1280,
  height: 800,
  minWidth: 640,
  minHeight: 560,
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
  if (pathname === '/.account' || pathname.startsWith('/.account/')) return 'workspace'
  return undefined
}

function normalizeWindowModePathname(pathname: string): string {
  pathname = pathname.replace(/^\/\.account\/interaction\/[A-Za-z0-9_-]+(?=\/)/u, '/.account')
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname
}

function isCompactAccountPathname(pathname: string): boolean {
  // Only short authentication steps share the compact frame. Long Account
  // documents need the workspace viewport for readable forms and actions.
  return pathname === '/.account'
    || pathname === '/.account/login'
    || pathname === '/.account/login/password'
    || pathname === '/.account/login/password/forgot'
    || pathname === '/.account/login/password/reset'
}

export function bindDesktopWindowModeNavigation(
  source: DesktopWindowModeNavigationSource,
  controller: DesktopWindowModeController,
  workspaceOrigin?: string,
): void {
  let previousRoute: string | undefined
  const applyRouteMode = (url: string, inPage: boolean, isMainFrame = true): void => {
    if (!isMainFrame) return
    let route: string
    try {
      const parsed = new URL(url)
      route = `${parsed.origin}${parsed.pathname}`
    } catch { return }
    const sameRoute = inPage && previousRoute === route
    previousRoute = route
    if (controller.applyModeForUrl(url)) return
    // A query/hash cleanup is not a new product surface. Preserve the mode
    // the renderer already selected (for example its manual-login card).
    if (sameRoute) return
    // Returning from a compact Account route to a different product route
    // restores the workspace frame until that renderer supplies its own mode.
    if (workspaceOrigin && urlHasOrigin(url, workspaceOrigin)) controller.applyMode('workspace')
  }

  source.on('did-navigate', (_event, url, isMainFrame) => applyRouteMode(url, false, isMainFrame))
  source.on('did-navigate-in-page', (_event, url, isMainFrame) => applyRouteMode(url, true, isMainFrame))
}

function urlHasOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin
  } catch {
    return false
  }
}

export function isDesktopWindowMode(value: unknown): value is DesktopWindowMode {
  return value === 'auth' || value === 'account' || value === 'workspace'
}

/**
 * Keeps the native shell visually aligned with the renderer's current surface.
 *
 * The first BrowserWindow is created hidden. Shared WebID authentication owns
 * 280 × 400 native logical bounds and renders edge-to-edge inside them. Product
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

    if (mode === 'auth') {
      // WebID sign-in uses the same initial viewport as the Account authentication flow.
      this.target.setResizable(false)
      this.target.setMaximizable(false)
      this.target.setMinimumSize(AUTH_WINDOW_MODE_SIZE.minWidth, AUTH_WINDOW_MODE_SIZE.minHeight)
      this.target.setSize(AUTH_WINDOW_MODE_SIZE.width, AUTH_WINDOW_MODE_SIZE.height)
      this.target.setTitle('Xpod')
    } else if (mode === 'account') {
      // Short Account authentication starts compact and remains user-resizable.
      this.target.setResizable(true)
      this.target.setMaximizable(true)
      this.target.setMinimumSize(ACCOUNT_WINDOW_MODE_SIZE.minWidth, ACCOUNT_WINDOW_MODE_SIZE.minHeight)
      this.target.setSize(ACCOUNT_WINDOW_MODE_SIZE.width, ACCOUNT_WINDOW_MODE_SIZE.height)
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
