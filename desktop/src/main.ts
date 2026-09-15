import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, MenuItem, Tray, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
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
import { DesktopWindowRecovery } from './window-recovery.js'
import { DesktopWindowModeController, bindDesktopWindowModeNavigation } from './window-mode.js'
import {
  DesktopUpdateManager,
  resolveDesktopUpdateConfig,
  withDefaultDesktopUpdateFeed,
  type DesktopUpdateState,
} from './update-manager.js'
import { loadDesktopUrlWithoutStaleCache } from './navigation-cache.js'
import { canCancelDesktopLogin, cancelDesktopLogin, shouldCancelDesktopLoginOnClose } from './login-recovery.js'
import { navigateDesktopProduct } from './product-navigation.js'
import { ensureDesktopEnvFile, loadDesktopEnvFile } from './user-env.js'
import { isTrustedOidcNavigation, resolveDesktopOidcIssuer, isOidcAuthorizationRequest, isSameOriginProductUrl } from './navigation-policy.js'
import {
  installCompactWindowDevToolsGuard,
  isCompactDesktopWindowMode,
  setDesktopDevToolsMenuEnabled,
} from './window-devtools.js'
import { desktopConsole } from './desktop-console.js'

let desktopOidcIssuer: string | undefined
let issuerDiscovery: Promise<string | undefined> | undefined
const loginNavigationEpoch = new WeakMap<BrowserWindow, number>()
const cancellingLogin = new WeakSet<BrowserWindow>()
const navigationReadyContents = new WeakSet<Electron.WebContents>()
const xpodLatestReleaseUrl = 'https://github.com/undefinedsco/xpod/releases/latest'

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
type DesktopQuitReason = 'explicit' | 'update-install'
let quitReason: DesktopQuitReason = 'explicit'
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
const windowRecoveries = new WeakMap<BrowserWindow, DesktopWindowRecovery>()
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

/**
 * Renderer isolation shared by the shell window and every product window it
 * opens. Stated once so a popup cannot end up with weaker preferences than the
 * window that opened it, whatever Electron's opener inheritance does.
 */
const productWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  // Sandboxed preload scripts are loaded as CommonJS by Electron even
  // though the desktop package itself is ESM.
  preload: path.join(moduleDir, 'preload.cjs'),
} as const

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: 'Xpod',
    backgroundColor: desktopWindowBackgroundColor(nativeTheme),
    webPreferences: { ...productWebPreferences },
  })
  const windowMode = new DesktopWindowModeController(window)
  const devToolsGuard = installCompactWindowDevToolsGuard(window.webContents, () => windowMode.currentMode())
  windowMode.onModeChange(() => {
    devToolsGuard.sync()
    refreshDevToolsMenuForFocusedWindow()
  })
  windowModeControllers.set(window, windowMode)
  const recovery = new DesktopWindowRecovery()
  windowRecoveries.set(window, recovery)
  applyDesktopThemeToWindow(window, nativeTheme)

  window.setMenuBarVisibility(process.platform !== 'darwin')
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) navigationReadyContents.delete(window.webContents)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    desktopConsole.info(`[desktop] window-open ${safeNavigationTarget(url)}`)
    if (isTrustedOidcNavigation(url, desktopOidcIssuer)) {
      // Inrupt may start authorization with window.open. Reuse the current
      // WebContents so sessionStorage/PKCE survives the loopback callback.
      void window.loadURL(url)
      return { action: 'deny' }
    }
    if (isOidcAuthorizationRequest(url, targetOrigin)) {
      void resumeOidcNavigation(window, url)
      return { action: 'deny' }
    }
    if (isExternalUrl(url)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    // Product pages on the shell's own origin keep the desktop session. Let
    // Electron open them as their own window; denying here silently swallowed
    // every in-app window.open with no window and no error. The isolation is
    // restated rather than inherited so a popup cannot be weaker than its
    // opener.
    return isSameOriginProductUrl(url, targetOrigin)
      ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...productWebPreferences } } }
      : { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    desktopConsole.info(`[desktop] will-navigate ${safeNavigationTarget(url)}`)
    if (isExternalUrl(url)) {
      // OIDC must remain in this WebContents. Opening it in the system browser
      // loses the tab-scoped PKCE/state transaction before the loopback
      // callback returns to /auth/callback.
      if (isTrustedOidcNavigation(url, desktopOidcIssuer)) return
      event.preventDefault()
      if (isOidcAuthorizationRequest(url, targetOrigin)) {
        void resumeOidcNavigation(window, url)
      } else {
        void shell.openExternal(url)
      }
    }
  })
  bindDesktopWindowModeNavigation(window.webContents, windowMode, targetOrigin)
  window.once('ready-to-show', () => windowMode.markReadyToShow())
  window.webContents.on('page-title-updated', (event, title) => {
    if (windowMode.handlePageTitleUpdate(title)) event.preventDefault()
  })
  window.webContents.once('did-finish-load', () => {
    if (smokeMode) {
      desktopConsole.log(`[xpod-desktop] smoke ok: ${window.webContents.getURL()}`)
      app.exit(0)
    }
  })
  window.webContents.on('did-finish-load', () => {
    recovery.handleDidFinishLoad()
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (recovery.handleDidFailLoad({ errorCode, isMainFrame })) {
      void recoverWindowAfterFailedLoad(window).catch((error: unknown) => {
        // A repeated failure is reported by did-fail-load; never let recovery
        // itself turn into an unhandled rejection.
        desktopConsole.warn(`[desktop] window recovery failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    if (smokeMode) {
      desktopConsole.error(`[xpod-desktop] smoke failed: ${errorCode} ${errorDescription} ${validatedURL}`)
      app.exit(1)
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    desktopConsole.error(`[desktop] render-process-gone: ${details.reason}`)
    recovery.handleRenderProcessGone()
    // A crashed renderer leaves a white window that no hide/show cycle can
    // fix. Reload immediately, rate-limited so a crashing page cannot loop.
    if (recovery.shouldAutoReload()) {
      recovery.markReloaded()
      void loadDesktopUrlWithoutStaleCache(window, targetUrl)
    }
  })
  window.webContents.on('will-prevent-unload', (event) => {
    // Only an explicit native cancellation/quit may override a page's guard.
    if (cancellingLogin.has(window) || windowLifecycle.isQuitting()) event.preventDefault()
  })
  window.on('close', (event) => {
    const shouldCancel = !windowLifecycle.isQuitting() && shouldCancelDesktopLoginOnClose(
      windowMode.currentMode(), window.webContents.getURL(), targetOrigin, desktopOidcIssuer,
    )
    windowLifecycle.handleClose(window, event)
    if (shouldCancel) void returnFromDesktopLogin(window).catch(() => undefined)
  })
  window.on('focus', () => {
    refreshDevToolsMenuForFocusedWindow()
  })
  window.on('closed', () => {
    windowMode.dispose()
  })

  const initialNavigationEpoch = loginNavigationEpoch.get(window)
  void discoverDesktopIssuer().finally(() => {
    if (!window.isDestroyed() && loginNavigationEpoch.get(window) === initialNavigationEpoch) {
      void loadDesktopUrlWithoutStaleCache(window, targetUrl)
    }
  })
  return window
}

async function resumeOidcNavigation(window: BrowserWindow, url: string): Promise<void> {
  const epoch = loginNavigationEpoch.get(window)
  const issuer = await discoverDesktopIssuer()
  if (window.isDestroyed() || loginNavigationEpoch.get(window) !== epoch) return
  if (isTrustedOidcNavigation(url, issuer)) {
    await window.loadURL(url)
    return
  }
  // Never move a pending PKCE transaction to the system browser on a failed
  // discovery probe. It cannot complete the original renderer's callback.
  await dialog.showMessageBox(window, {
    type: 'error',
    message: '暂时无法确认登录服务',
    detail: '请确认 Xpod 服务可用后重新登录。',
    buttons: ['确定'],
  })
}

function returnFromDesktopLogin(window: BrowserWindow): Promise<void> {
  const epoch = (loginNavigationEpoch.get(window) ?? 0) + 1
  loginNavigationEpoch.set(window, epoch)
  cancellingLogin.add(window)
  return cancelDesktopLogin(window, targetUrl).catch((error: unknown) => {
    desktopConsole.warn(`[desktop] login recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }).finally(() => {
    if (loginNavigationEpoch.get(window) === epoch) cancellingLogin.delete(window)
  })
}

function installDesktopLoginRecoveryMenu(): void {
  // Extend Electron's standard menu so native edit/window/quit and DevTools
  // roles stay available even when the Account renderer cannot execute JS.
  const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ])
  menu.append(new MenuItem({
    label: '登录',
    submenu: [{
      id: 'xpod-cancel-login',
      label: '取消登录并返回 Xpod',
      accelerator: 'CmdOrCtrl+[',
      click: () => { void returnFromDesktopLogin(windowLifecycle.ensureWindow()).catch(() => undefined) },
    }],
  }))
  Menu.setApplicationMenu(menu)
}

function discoverDesktopIssuer(): Promise<string | undefined> {
  issuerDiscovery ??= resolveDesktopOidcIssuer(targetOrigin).then((issuer) => {
    desktopOidcIssuer = issuer
    return issuer
  }).finally(() => { issuerDiscovery = undefined })
  return issuerDiscovery
}

function refreshDevToolsMenuForFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const mode = focused ? windowModeControllers.get(focused)?.currentMode() ?? null : null
  const menu = Menu.getApplicationMenu()
  if (!setDesktopDevToolsMenuEnabled(menu, !isCompactDesktopWindowMode(mode))) return
  Menu.setApplicationMenu(menu)
}

function safeNavigationTarget(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return 'invalid-url'
  }
}

// A cold runtime start can outlive the launch timeout while the window is
// already loading. Keep waiting long enough to cover it instead of leaving the
// failed page on screen permanently.
const WINDOW_RECOVERY_TIMEOUT_MS = 10 * 60_000

/**
 * Reloads the retained window once the gateway answers again.
 *
 * The window loads the product URL as soon as it is created, so a runtime that
 * is still starting makes that first load fail and Electron keeps the error
 * page on screen: nothing else re-presents the window until the user hides and
 * reopens it from the tray. Recovery waits for the runtime that is already
 * coming up rather than launching a competing one.
 */
async function recoverWindowAfterFailedLoad(window: BrowserWindow): Promise<void> {
  const recovery = windowRecoveries.get(window)
  if (!recovery || window.isDestroyed() || recovery.isRecovering()) return
  recovery.beginRecovery()
  try {
    if (!await runtimeManager.waitUntilReachable(WINDOW_RECOVERY_TIMEOUT_MS)) return
    if (window.isDestroyed()) return
    const cooldown = recovery.reloadCooldownRemainingMs()
    if (cooldown > 0) await delay(cooldown)
    if (window.isDestroyed()) return
    desktopConsole.info(`[desktop] reloading ${safeNavigationTarget(targetUrl)} after a failed load`)
    recovery.markReloaded()
    await discoverDesktopIssuer()
    await loadDesktopUrlWithoutStaleCache(window, targetUrl)
  } finally {
    recovery.endRecovery()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function ensureWindow({ focus = true }: { focus?: boolean } = {}): BrowserWindow {
  if (focus && process.platform === 'darwin') {
    // BrowserWindow.show() alone cannot unhide an application hidden at the
    // macOS process level. Restore the app before presenting its retained
    // renderer so reopening from the tray is reliable.
    app.show()
  }
  const window = windowLifecycle.ensureWindow({ focus })
  const recovery = windowRecoveries.get(window)
  if (!window.isDestroyed() && recovery?.shouldReloadOnPresent(window.webContents)) {
    // The retained window survived a failed load or renderer crash. Showing
    // it again would re-present the same broken page, so reload the target.
    recovery.markReloaded()
    void loadDesktopUrlWithoutStaleCache(window, targetUrl)
  }
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
    case 'open-release-download':
      await shell.openExternal(xpodLatestReleaseUrl)
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
  const window = ensureWindow()
  await navigateDesktopProduct(window, route, targetOrigin, navigationReadyContents.has(window.webContents))
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

ipcMain.handle('xpod:cancel-login', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed() || !canCancelDesktopLogin({
    isCurrentWindow: window === windowLifecycle.currentWindow(),
    isMainFrame: event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? '',
  }, targetOrigin, desktopOidcIssuer)) {
    throw new Error('Desktop login cancellation requires the trusted main document')
  }
  await returnFromDesktopLogin(window)
})

ipcMain.on('xpod:identity', (_event, identity: unknown) => {
  trayIdentity = normalizeTrayIdentity(identity, targetOrigin)
  if (tray) updateTray(tray)
})

ipcMain.on('xpod:navigation-ready', (event, ready: unknown) => {
  if (event.senderFrame !== event.sender.mainFrame) return
  if (ready === true && isSameOriginProductUrl(event.sender.getURL(), targetOrigin)) {
    navigationReadyContents.add(event.sender)
  } else {
    navigationReadyContents.delete(event.sender)
  }
})

ipcMain.on('xpod:window-mode', (event, mode: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return
  const controller = windowModeControllers.get(window)
  if (!controller) return
  if (controller.applyModeForUrl(event.sender.getURL())) return
  controller.applyUnknownMode(mode)
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
    installDesktopLoginRecoveryMenu()
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
      // The first quit is deliberately cancelled while the owned runtime is
      // stopped. Do not re-enter before-quit afterwards: Electron can keep the
      // process resident after a cancelled quit. Cleanup is complete, so exit
      // directly and leave the resident-window path unaffected.
      .finally(() => app.exit(0))
  }
})

app.on('window-all-closed', () => {
  // Closing the last window tears down the UI surface. Keep Electron, the
  // tray and the runtime manager alive until the explicit Quit action.
})
