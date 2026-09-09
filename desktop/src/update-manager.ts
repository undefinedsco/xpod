/**
 * Small adapter around Electron's built-in autoUpdater.
 *
 * The renderer and tray should only have to understand a small, consumer-facing
 * state machine.  Electron's updater emits events from a different lifecycle
 * (and downloads automatically after `update-available`), so this class keeps
 * that implementation detail at the desktop boundary.
 */

export type DesktopUpdateStateName =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'

export interface DesktopUpdateState {
  status: DesktopUpdateStateName
  version?: string
  /** A short, user-facing message. Never expose an updater stack trace here. */
  message?: string
}

export interface DesktopAutoUpdater {
  setFeedURL(options: { url: string }): void
  checkForUpdates(): void
  quitAndInstall(): void
  on(event: 'error', listener: (error: unknown) => void): this
  on(event: 'checking-for-update', listener: () => void): this
  on(event: 'update-available', listener: (...args: unknown[]) => void): this
  on(event: 'update-not-available', listener: () => void): this
  on(event: 'update-downloaded', listener: (...args: unknown[]) => void): this
}

export interface DesktopUpdateManagerOptions {
  updater: DesktopAutoUpdater
  /** Explicit feed URL. Omit it to keep updates disabled. */
  feedUrl?: string
  /** Automatically restart and install after the download completes. */
  autoInstall?: boolean
  /** Briefly allow Squirrel to finish staging before an unattended restart. */
  installDelayMs?: number
  /** Check as soon as the manager starts. Defaults to true. */
  autoCheck?: boolean
  /** Optional periodic check interval. A non-positive value disables polling. */
  checkIntervalMs?: number
  onStateChange?: (state: DesktopUpdateState) => void
  /** Notify the desktop host after a verified update has finished downloading. */
  onUpdateDownloaded?: (state: DesktopUpdateState, install: () => DesktopUpdateState) => void
  onAutoInstallReady?: (install: () => DesktopUpdateState) => void
  onLifecycleEvent?: (event: string, detail?: string) => void
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}

export const UPDATE_FEED_ENV = 'XPOD_DESKTOP_UPDATE_FEED_URL'
export const UPDATE_AUTO_CHECK_ENV = 'XPOD_DESKTOP_AUTO_CHECK_UPDATES'
export const UPDATE_AUTO_INSTALL_ENV = 'XPOD_DESKTOP_AUTO_INSTALL_UPDATES'
export const UPDATE_CHECK_INTERVAL_ENV = 'XPOD_DESKTOP_UPDATE_CHECK_INTERVAL_MS'
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

export interface DesktopUpdateEnvironment {
  [UPDATE_FEED_ENV]?: string
  [UPDATE_AUTO_CHECK_ENV]?: string
  [UPDATE_AUTO_INSTALL_ENV]?: string
  [UPDATE_CHECK_INTERVAL_ENV]?: string
}

export interface DefaultDesktopUpdateFeedOptions {
  isPackaged: boolean
  version: string
  platform?: NodeJS.Platform
  arch?: string
  owner?: string
  repository?: string
}

export interface ResolvedDesktopUpdateConfig {
  feedUrl?: string
  autoCheck: boolean
  autoInstall: boolean
  checkIntervalMs: number
}

/**
 * Resolve process configuration without making a network request. This is
 * deliberately explicit: production can provide an HTTPS feed while local
 * acceptance can point at a loopback JSON feed.
 */
export function resolveDesktopUpdateConfig(
  environment: DesktopUpdateEnvironment = process.env,
): ResolvedDesktopUpdateConfig {
  return {
    feedUrl: environment[UPDATE_FEED_ENV]?.trim() || undefined,
    autoCheck: parseBoolean(environment[UPDATE_AUTO_CHECK_ENV], true),
    // Consumer-default: detect and download automatically, then let the user
    // choose a safe restart from the tray. Automated acceptance can opt into
    // immediate installation with XPOD_DESKTOP_AUTO_INSTALL_UPDATES=1.
    autoInstall: parseBoolean(environment[UPDATE_AUTO_INSTALL_ENV], false),
    checkIntervalMs: parsePositiveInteger(
      environment[UPDATE_CHECK_INTERVAL_ENV],
      DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    ),
  }
}

/** Official Electron update service URL used by production packages. */
export function defaultDesktopUpdateFeedUrl({
  isPackaged,
  version,
  platform = process.platform,
  arch = process.arch,
  owner = 'undefinedsco',
  repository = 'xpod',
}: DefaultDesktopUpdateFeedOptions): string | undefined {
  if (!isPackaged || platform !== 'darwin' || !version.trim()) return undefined
  return `https://update.electronjs.org/${owner}/${repository}/${platform}-${arch}/${encodeURIComponent(version.trim())}`
}

export function withDefaultDesktopUpdateFeed(
  config: ResolvedDesktopUpdateConfig,
  options: DefaultDesktopUpdateFeedOptions,
): ResolvedDesktopUpdateConfig {
  return config.feedUrl
    ? config
    : { ...config, feedUrl: defaultDesktopUpdateFeedUrl(options) }
}

export class DesktopUpdateManager {
  private state: DesktopUpdateState
  private started = false
  private checkTimer: ReturnType<typeof setTimeout> | undefined
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void

  public constructor(private readonly options: DesktopUpdateManagerOptions) {
    this.state = options.feedUrl ? { status: 'idle' } : { status: 'disabled' }
    this.setTimeoutFn = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimeoutFn = options.clearTimeout ?? ((handle) => clearTimeout(handle))
  }

  public snapshot(): DesktopUpdateState {
    return { ...this.state }
  }

  /** Configure the feed, attach listeners and optionally begin checking. */
  public start(): DesktopUpdateState {
    if (!this.options.feedUrl) {
      this.setState({ status: 'disabled' })
      return this.snapshot()
    }

    const feedUrl = normalizeUpdateFeedUrl(this.options.feedUrl)
    if (!feedUrl) {
      this.setState({ status: 'error', message: 'Update feed must be HTTPS or a local test URL.' })
      return this.snapshot()
    }

    const firstStart = !this.started
    if (firstStart) {
      this.started = true
      try {
        this.options.updater.setFeedURL({ url: feedUrl })
      } catch (error) {
        this.setState({ status: 'error', message: friendlyUpdateError(error) })
        return this.snapshot()
      }
      this.attachUpdaterListeners()
      this.schedulePeriodicChecks()
    }

    if (firstStart) {
      if (this.options.autoCheck !== false) this.checkNow()
      else this.setState({ status: 'idle' })
    }
    return this.snapshot()
  }

  /** Stop the optional polling timer. Safe to call during app shutdown. */
  public dispose(): void {
    if (this.checkTimer !== undefined) {
      this.clearTimeoutFn(this.checkTimer)
      this.checkTimer = undefined
    }
  }

  /** Trigger one check. Electron downloads an available update automatically. */
  public checkNow(): DesktopUpdateState {
    if (!this.options.feedUrl) {
      this.setState({ status: 'disabled' })
      return this.snapshot()
    }
    if (!this.started) return this.start()
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return this.snapshot()
    }

    this.setState({ status: 'checking' })
    try {
      this.options.updater.checkForUpdates()
    } catch (error) {
      this.setState({ status: 'error', message: friendlyUpdateError(error) })
    }
    return this.snapshot()
  }

  /** Install a previously downloaded update, if one is ready. */
  public installNow(): DesktopUpdateState {
    if (this.state.status !== 'downloaded') return this.snapshot()
    try {
      this.options.updater.quitAndInstall()
    } catch (error) {
      this.setState({ status: 'error', message: friendlyUpdateError(error) })
    }
    return this.snapshot()
  }

  private attachUpdaterListeners(): void {
    this.options.updater.on('checking-for-update', () => {
      this.options.onLifecycleEvent?.('checking-for-update')
      this.setState({ status: 'checking' })
    })
    this.options.updater.on('update-available', (...args) => {
      this.options.onLifecycleEvent?.('update-available')
      const version = extractUpdateVersion(args)
      // Electron's built-in updater starts downloading immediately after this
      // event. Emit both states so consumers can render the transition without
      // pretending that a manual download API exists.
      this.setState({ status: 'available', ...(version ? { version } : {}) })
      this.setState({ status: 'downloading', ...(version ? { version } : {}) })
    })
    this.options.updater.on('update-not-available', () => {
      this.options.onLifecycleEvent?.('update-not-available')
      this.setState({ status: 'not-available' })
    })
    this.options.updater.on('update-downloaded', (...args) => {
      this.options.onLifecycleEvent?.('update-downloaded')
      const version = extractUpdateVersion(args)
      const downloaded: DesktopUpdateState = {
        status: 'downloaded',
        ...(version ? { version } : {}),
      }
      this.setState(downloaded)
      const install = () => this.installNow()
      if (this.options.autoInstall === true) {
        if (this.options.onAutoInstallReady) this.options.onAutoInstallReady(install)
        else this.setTimeoutFn(install, this.options.installDelayMs ?? 1_000)
      } else {
        this.options.onUpdateDownloaded?.(downloaded, install)
      }
    })
    this.options.updater.on('error', (error) => {
      this.options.onLifecycleEvent?.('error', rawUpdateError(error))
      this.setState({ status: 'error', message: friendlyUpdateError(error) })
    })
  }

  private schedulePeriodicChecks(): void {
    const interval = this.options.checkIntervalMs
    if (!interval || interval <= 0) return
    const schedule = (): void => {
      this.checkTimer = this.setTimeoutFn(() => {
        this.checkTimer = undefined
        if (this.state.status !== 'downloaded') this.checkNow()
        schedule()
      }, interval)
    }
    schedule()
  }

  private setState(state: DesktopUpdateState): void {
    this.state = state
    this.options.onStateChange?.(this.snapshot())
  }
}

export function normalizeUpdateFeedUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (!url.hostname || url.username || url.password || url.hash) return undefined
    if (url.protocol === 'https:') return url.toString()
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.toString()
    return undefined
  } catch {
    return undefined
  }
}

function extractUpdateVersion(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    const version = versionFromValue(arg)
    if (version) return version
  }
  return undefined
}

function versionFromValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    // Electron's macOS event has releaseNotes before releaseName. Prefer a
    // version-shaped string and ignore arbitrary release-note prose.
    return /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed)
      ? trimmed
      : undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { version?: unknown; releaseName?: unknown }
  return versionFromValue(candidate.version) ?? versionFromValue(candidate.releaseName)
}

function friendlyUpdateError(error: unknown): string {
  const compact = rawUpdateError(error)
  if (!compact) return 'Update service is unavailable. Try again later.'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|internet|offline|HTTP 5\d\d/i.test(compact)) {
    return 'Could not reach the update service. Check your connection and try again.'
  }
  if (/signature|code sign|not signed|certificate|validation/i.test(compact)) {
    return 'The downloaded update could not be verified. Xpod kept the current version.'
  }
  if (/HTTP 4\d\d|404|not found/i.test(compact)) {
    return 'No compatible update is available for this Xpod build.'
  }
  return 'Xpod could not check for updates. Try again later.'
}

function rawUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (/^(0|false|off|no)$/i.test(value.trim())) return false
  if (/^(1|true|on|yes)$/i.test(value.trim())) return true
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}
