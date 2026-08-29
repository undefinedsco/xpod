import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import {
  buildTrayMenuModel,
  normalizeTrayIdentity,
  type TrayMenuAction,
  type TrayMenuItemModel,
  type TrayServiceSnapshot,
} from './tray-menu.js'
import { trayIconAssetName, XPOD_TRAY_GUID } from './tray-icon.js'
import { RuntimeManager } from './runtime-manager.js'
import { resolveDesktopTargetUrl } from './target-url.js'
import { installDockIcon, resolveDockIconPath } from './dock-icon.js'
import {
  applyDesktopThemeToWindow,
  desktopWindowBackgroundColor,
  installDesktopNativeTheme,
} from './native-theme.js'
import { WindowLifecycle } from './window-lifecycle.js'
import { DesktopWindowModeController } from './window-mode.js'
import {
  DesktopUpdateManager,
  resolveDesktopUpdateConfig,
  withDefaultDesktopUpdateFeed,
  type DesktopUpdateState,
} from './update-manager.js'
import { loadDesktopUrlWithoutStaleCache } from './navigation-cache.js'
import { ensureDesktopEnvFile, loadDesktopEnvFile } from './user-env.js'
import { isTrustedOidcNavigation } from './navigation-policy.js'

const desktopOidcIssuer = process.env.SOLID_OIDC_ISSUER ?? 'https://id.undefineds.co/'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

app.setName('Xpod')
app.setPath('userData', process.env.XPOD_DESKTOP_USER_DATA_DIR
  ? path.resolve(process.env.XPOD_DESKTOP_USER_DATA_DIR)
  : path.join(app.getPath('appData'), 'Xpod'))
if (process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_VERSION_FILE) {
  // Packaged two-version acceptance needs evidence from the relaunched app,
  // not merely from the feed or download events.
  writeFileSync(
    path.resolve(process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_VERSION_FILE),
    app.getVersion(),
    { encoding: 'utf8', mode: 0o600 },
  )
}
const desktopDataRoot = app.getPath('userData')
if (app.isPackaged) {
  const envPath = ensureDesktopEnvFile(desktopDataRoot)
  loadDesktopEnvFile(envPath)
  process.env.XPOD_ENV_FILE ??= envPath
}
process.env.XPOD_BUN_SINGLE_CACHE_DIR ??= path.join(desktopDataRoot, 'runtime-cache')
process.env.XPOD_EDITION ??= 'local'
process.env.XPOD_AI_CLIENT_CONFIGURATION_ENABLED ??= 'true'
process.env.CSS_IDENTITY_DB_URL ??= `sqlite:${path.join(desktopDataRoot, 'identity.sqlite')}`
process.env.CSS_SPARQL_ENDPOINT ??= `sqlite:${path.join(desktopDataRoot, 'quadstore.sqlite')}`
process.env.CSS_RDF_INDEX_PATH ??= path.join(desktopDataRoot, 'rdf-index.sqlite')
process.env.CSS_ROOT_FILE_PATH ??= path.join(desktopDataRoot, 'data')

const targetUrl = resolveDesktopTargetUrl()
const targetOrigin = new URL(targetUrl).origin
const smokeMode = process.env.XPOD_DESKTOP_SMOKE === '1'
const acceptanceMode = process.env.XPOD_DESKTOP_ACCEPTANCE === '1'

let tray: Tray | null = null
let trayServices: TrayServiceSnapshot[] = []
let trayPoll: ReturnType<typeof setInterval> | undefined
let trayIdentity: { label: string; webId?: string; podUrl?: string } | undefined
let trayTooltip = ''
let trayImageEmpty = true
let trayImageScaleFactors: number[] = []
const updateConfig = withDefaultDesktopUpdateFeed(resolveDesktopUpdateConfig(), {
  isPackaged: app.isPackaged,
  version: app.getVersion(),
})
const updateAcceptanceLog = process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_LOG
  ? path.resolve(process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_LOG)
  : undefined
const updateAcceptanceInstallMarker = process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_INSTALL_MARKER
  ? path.resolve(process.env.XPOD_DESKTOP_UPDATE_ACCEPTANCE_INSTALL_MARKER)
  : undefined
let trayUpdate: DesktopUpdateState = { status: updateConfig.feedUrl ? 'idle' : 'disabled' }
let quitCleanupStarted = false
type DesktopQuitReason = 'resident' | 'explicit' | 'update-install'
let quitReason: DesktopQuitReason = 'resident'
const runtimeManager = new RuntimeManager({ targetOrigin })
const updateManager = new DesktopUpdateManager({
  updater: autoUpdater,
  ...updateConfig,
  onUpdateDownloaded: (state, install) => {
    const version = state.version ? ` ${state.version}` : ''
    void dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Xpod update ready',
      message: `Xpod${version} is ready`,
      detail: 'Restart Xpod to finish installing the update. Your signed-in session will be preserved.',
    }).then((result) => {
      if (result.response !== 0 || updateManager.snapshot().status !== 'downloaded') return
      quitReason = 'update-install'
      install()
    }).catch(() => undefined)
  },
  onAutoInstallReady: (install) => {
    if (updateAcceptanceLog) writeFileSync(updateAcceptanceLog, 'auto-install-ready\n', { flag: 'a' })
    if (updateAcceptanceInstallMarker) {
      const availableVersion = updateManager.snapshot().version
      if (availableVersion) {
        writeFileSync(updateAcceptanceInstallMarker, availableVersion, { encoding: 'utf8', mode: 0o600 })
      }
    }
    quitReason = 'update-install'
    install()
  },
  onLifecycleEvent: (event, detail) => {
    if (updateAcceptanceLog) writeFileSync(updateAcceptanceLog, `${event}${detail ? `: ${detail}` : ''}\n`, { flag: 'a' })
  },
  onStateChange: (state) => {
    trayUpdate = state
    if (tray) updateTray(tray)
  },
})
const windowLifecycle = new WindowLifecycle<BrowserWindow>(() => createWindow())
const windowModeControllers = new WeakMap<BrowserWindow, DesktopWindowModeController>()
installDesktopNativeTheme(nativeTheme, () => BrowserWindow.getAllWindows())

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.origin !== targetOrigin
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'Xpod',
    backgroundColor: desktopWindowBackgroundColor(nativeTheme),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preload scripts are loaded as CommonJS by Electron even
      // though the desktop package itself is ESM.
      preload: path.join(moduleDir, 'preload.cjs'),
    },
  })
  const windowMode = new DesktopWindowModeController(window)
  windowModeControllers.set(window, windowMode)
  applyDesktopThemeToWindow(window, nativeTheme)

  window.setMenuBarVisibility(process.platform !== 'darwin')
  window.webContents.setWindowOpenHandler(({ url }) => {
    console.info(`[desktop] window-open ${safeNavigationTarget(url)}`)
    if (isTrustedOidcNavigation(url, desktopOidcIssuer)) {
      // Inrupt may start authorization with window.open. Reuse the current
      // WebContents so sessionStorage/PKCE survives the loopback callback.
      void window.loadURL(url)
      return { action: 'deny' }
    }
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    console.info(`[desktop] will-navigate ${safeNavigationTarget(url)}`)
    if (isExternalUrl(url)) {
      // OIDC must remain in this WebContents. Opening it in the system browser
      // loses the tab-scoped PKCE/state transaction before the loopback
      // callback returns to /auth/callback.
      if (isTrustedOidcNavigation(url, desktopOidcIssuer)) return
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  window.once('ready-to-show', () => windowMode.markReadyToShow())
  window.webContents.on('page-title-updated', (event, title) => {
    if (windowMode.handlePageTitleUpdate(title)) event.preventDefault()
  })
  window.webContents.once('did-finish-load', () => {
    if (smokeMode) {
      console.log(`[xpod-desktop] smoke ok: ${window.webContents.getURL()}`)
      app.exit(0)
    }
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (smokeMode) {
      console.error(`[xpod-desktop] smoke failed: ${errorCode} ${errorDescription} ${validatedURL}`)
      app.exit(1)
    }
  })
  window.on('close', (event) => {
    windowLifecycle.handleClose(window, event)
  })
  window.on('closed', () => {
    windowMode.dispose()
  })

  void loadDesktopUrlWithoutStaleCache(window, targetUrl)
  return window
}

function safeNavigationTarget(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return 'invalid-url'
  }
}

function ensureWindow({ focus = true }: { focus?: boolean } = {}): BrowserWindow {
  if (focus && process.platform === 'darwin') {
    // BrowserWindow.show() alone cannot unhide an application hidden at the
    // macOS process level. Restore the app before presenting its retained
    // renderer so reopening from the tray is reliable.
    app.show()
  }
  const window = windowLifecycle.ensureWindow({ focus })
  if (focus && process.platform === 'darwin') {
    // A status-menu action does not automatically activate its owning app.
    // Explicitly bring Xpod forward after restoring the retained window.
    app.focus({ steal: true })
  }
  return window
}

function trayIcon(state: ReturnType<typeof buildTrayMenuModel>['aggregate']['state'] = 'stopped'): Electron.NativeImage {
  const asset = trayIconAssetName(state)
  const image = nativeImage.createFromPath(path.join(moduleDir, '..', 'assets', asset))
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function createTray(): Tray {
  const initialImage = trayIcon()
  trayImageEmpty = initialImage.isEmpty()
  const created = new Tray(initialImage, XPOD_TRAY_GUID)
  updateTray(created)
  if (process.platform !== 'darwin') created.on('click', () => ensureWindow())
  void refreshTrayStatus(created)
  trayPoll = setInterval(() => void refreshTrayStatus(created), 10_000)
  return created
}

function updateTray(target: Tray): void {
  const model = buildTrayMenuModel({
    services: trayServices,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    identity: trayIdentity,
    update: trayUpdate,
  })
  const image = trayIcon(model.aggregate.state)
  trayImageEmpty = image.isEmpty()
  trayImageScaleFactors = image.getScaleFactors()
  trayTooltip = model.tooltip
  target.setImage(image)
  target.setToolTip(trayTooltip)
  target.setContextMenu(Menu.buildFromTemplate(model.items.map(toElectronMenuItem)))
}

function toElectronMenuItem(item: TrayMenuItemModel): MenuItemConstructorOptions {
  if (item.type === 'separator') return { type: 'separator' }
  return {
    label: item.label,
    enabled: item.enabled,
    type: item.checked === undefined ? 'normal' : 'checkbox',
    checked: item.checked,
    click: item.action ? () => void runTrayAction(item.action!) : undefined,
  }
}

async function runTrayAction(action: TrayMenuAction): Promise<void> {
  switch (action.type) {
    case 'open-xpod':
      ensureWindow()
      return
    case 'open-pod':
      if (trayIdentity?.podUrl) {
        await shell.openExternal(trayIdentity.podUrl)
      } else {
        await openRoute('/settings/pod')
      }
      return
    case 'open-route':
      await openRoute(action.route)
      return
    case 'refresh':
      if (tray) await refreshTrayStatus(tray)
      return
    case 'restart':
      await runtimeManager.restart().catch(() => undefined)
      if (tray) setTimeout(() => void refreshTrayStatus(tray!), 1_000)
      return
    case 'start':
      await runtimeManager.ensureRunning().catch(() => undefined)
      if (tray) await refreshTrayStatus(tray)
      return
    case 'toggle-launch-at-login':
      app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin })
      if (tray) updateTray(tray)
      return
    case 'check-update':
      updateManager.checkNow()
      return
    case 'install-update':
      // autoUpdater.quitAndInstall() emits before-quit-for-update after it
      // closes windows. Mark the reason before calling it so the normal full
      // user-quit path does not revoke the two active sessions during an
      // in-place update/restart.
      if (updateManager.snapshot().status === 'downloaded') quitReason = 'update-install'
      updateManager.installNow()
      return
    case 'about':
      app.showAboutPanel()
      return
    case 'quit':
      if (runtimeManager.snapshot().ownership === 'desktop') {
        const result = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Quit and stop Xpod', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: 'Quit Xpod?',
          detail: 'This Xpod runtime was started by the desktop app and will be stopped.',
        })
        if (result.response !== 0) return
      }
      quitReason = 'explicit'
      windowLifecycle.markQuitting()
      app.quit()
  }
}

async function openRoute(route: string): Promise<void> {
  // The initial window load already invalidates stale packaged UI assets.
  // Tray navigation must preserve normal browser caching and auth storage so
  // switching sections does not manufacture an avoidable login/restoring flash.
  await ensureWindow().loadURL(new URL(route, targetOrigin).toString())
}

async function refreshTrayStatus(target: Tray): Promise<void> {
  try {
    const response = await fetch(new URL('/service/status', targetOrigin))
    const payload = await response.json() as unknown
    const reported = Array.isArray(payload) ? payload.filter(isTrayServiceSnapshot) : []
    trayServices = [
      ...(reported.some((service) => service.name === 'gateway')
        ? []
        : [{ name: 'gateway', status: 'running' as const }]),
      ...reported,
    ]
  } catch {
    const runtime = runtimeManager.snapshot()
    if (runtime.state === 'starting') {
      trayServices = XPOD_RUNTIME_SERVICES.map((name) => ({ name, status: 'starting' as const }))
    } else if (runtime.state === 'failed') {
      trayServices = [
        { name: 'gateway', status: 'crashed' },
        { name: 'css', status: 'stopped' },
        { name: 'api', status: 'stopped' },
      ]
    } else if (trayServices.length === 0 || runtime.state === 'stopped') {
      trayServices = [
        { name: 'gateway', status: 'stopped' },
        { name: 'css', status: 'stopped' },
        { name: 'api', status: 'stopped' },
      ]
    }
  }
  updateTray(target)
}

const XPOD_RUNTIME_SERVICES = ['gateway', 'css', 'api'] as const

function isTrayServiceSnapshot(value: unknown): value is TrayServiceSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { name?: unknown; status?: unknown }
  return typeof candidate.name === 'string'
    && (candidate.status === 'stopped'
      || candidate.status === 'starting'
      || candidate.status === 'running'
      || candidate.status === 'crashed')
}

ipcMain.on('xpod:identity', (_event, identity: unknown) => {
  trayIdentity = normalizeTrayIdentity(identity, targetOrigin)
  if (tray) updateTray(tray)
})

ipcMain.on('xpod:window-mode', (event, mode: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return
  windowModeControllers.get(window)?.applyUnknownMode(mode)
})

if (acceptanceMode) {
  (app as unknown as { on(event: string, listener: () => void): unknown }).on('xpod:acceptance:read-tray', () => {
    app.emit('xpod:acceptance:tray-evidence', tray
      ? {
        exists: true,
        bounds: tray.getBounds(),
        tooltip: trayTooltip,
        imageEmpty: trayImageEmpty,
        imageScaleFactors: trayImageScaleFactors,
      }
      : { exists: false })
  })
  ipcMain.on('xpod:acceptance:close-window', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window && !window.isDestroyed()) window.close()
  })
  ipcMain.on('xpod:acceptance:quit', () => {
    quitReason = 'explicit'
    windowLifecycle.markQuitting()
    app.quit()
  });
  // Playwright's ElectronApplication can still evaluate the main-process
  // app after the last renderer has been closed. This event is intentionally
  // acceptance-only and exercises the same tray/user quit path without
  // reaching back through a destroyed renderer.
  (app as unknown as { on(event: string, listener: () => void): unknown }).on('xpod:acceptance:quit-app', () => {
    quitReason = 'explicit'
    windowLifecycle.markQuitting()
    app.quit()
  })
}

autoUpdater.on('before-quit-for-update', () => {
  quitReason = 'update-install'
})

const allowParallelAcceptanceInstance = acceptanceMode
  && process.env.XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE === '1'
const hasSingleInstanceLock = allowParallelAcceptanceInstance || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  quitReason = 'explicit'
  app.quit()
} else {
  if (!allowParallelAcceptanceInstance) {
    app.on('second-instance', () => {
      ensureWindow()
    })
  }

  app.whenReady().then(async () => {
    installDockIcon({
      app,
      nativeImage,
      platform: process.platform,
      iconPath: resolveDockIconPath({
        appPath: app.getAppPath(),
        moduleDir,
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
      }),
    })
    tray = createTray()
    updateManager.start()
    await runtimeManager.ensureRunning().catch(() => undefined)
    await refreshTrayStatus(tray)
    if (acceptanceMode) app.emit('xpod:acceptance:tray-ready')
    ensureWindow()

    app.on('activate', () => {
      ensureWindow()
    })
  })
}

app.on('before-quit', (event) => {
  // Xpod is a resident menu-bar host. Closing the window or using the normal
  // macOS Quit command dismisses the UI but must leave the tray and runtime
  // alive so both Solid sessions remain reusable. Only the tray's explicit
  // "Quit Xpod" action (and updater hand-off) performs full cleanup.
  if (quitReason === 'resident') {
    event.preventDefault()
    windowLifecycle.hideWindow()
    if (process.platform === 'darwin') app.hide()
    return
  }
  windowLifecycle.markQuitting()
  if (trayPoll) clearInterval(trayPoll)
  // Squirrel owns the update installation lifecycle after quitAndInstall().
  // Do not defer this event: preventing it, even for runtime cleanup, causes
  // Electron's built-in updater to finish downloading but never relaunch.
  if (quitReason === 'update-install') {
    updateManager.dispose()
    void runtimeManager.stopOwned().catch(() => undefined)
    return
  }
  if (!quitCleanupStarted) {
    event.preventDefault()
    quitCleanupStarted = true
    updateManager.dispose()
    // Application quit is not an in-product sign-out. Let CSS/Inrupt retain
    // their own profile-persistent sessions and only stop the runtime owned by
    // this desktop process. The next launch restores if those sessions remain
    // valid and otherwise falls back to the remembered-account idle state.
    void (runtimeManager.snapshot().ownership === 'desktop'
      ? runtimeManager.stopOwned()
      : Promise.resolve())
      .finally(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  // Closing the last window tears down the UI surface. Keep Electron, the
  // tray and the runtime manager alive until the explicit Quit action.
})
