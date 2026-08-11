import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell, type MenuItemConstructorOptions } from 'electron'
import {
  buildTrayMenuModel,
  type TrayMenuAction,
  type TrayMenuItemModel,
  type TrayServiceSnapshot,
} from './tray-menu.js'
import { trayIconAssetName } from './tray-icon.js'
import { RuntimeManager } from './runtime-manager.js'
import { resolveDesktopTargetUrl } from './target-url.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

app.setName('Xpod')
app.setPath('userData', path.join(app.getPath('appData'), 'Xpod'))
const desktopDataRoot = app.getPath('userData')
process.env.XPOD_BUN_SINGLE_CACHE_DIR ??= path.join(desktopDataRoot, 'runtime-cache')
process.env.XPOD_EDITION ??= 'local'
process.env.CSS_IDENTITY_DB_URL ??= `sqlite:${path.join(desktopDataRoot, 'identity.sqlite')}`
process.env.CSS_SPARQL_ENDPOINT ??= `sqlite:${path.join(desktopDataRoot, 'quadstore.sqlite')}`
process.env.CSS_RDF_INDEX_PATH ??= path.join(desktopDataRoot, 'rdf-index.sqlite')
process.env.CSS_ROOT_FILE_PATH ??= path.join(desktopDataRoot, 'data')

const targetUrl = resolveDesktopTargetUrl()
const targetOrigin = new URL(targetUrl).origin
const smokeMode = process.env.XPOD_DESKTOP_SMOKE === '1'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let trayServices: TrayServiceSnapshot[] = []
let trayPoll: ReturnType<typeof setInterval> | undefined
let trayIdentity: { label: string; webId?: string; podUrl?: string } | undefined
let quitCleanupStarted = false
const runtimeManager = new RuntimeManager({ targetOrigin })

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preload scripts are loaded as CommonJS by Electron even
      // though the desktop package itself is ESM.
      preload: path.join(moduleDir, 'preload.cjs'),
    },
  })

  window.setMenuBarVisibility(process.platform !== 'darwin')
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isExternalUrl(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  window.once('ready-to-show', () => window.show())
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
    if (!quitting && process.platform === 'darwin') {
      event.preventDefault()
      window.hide()
    }
  })

  void window.loadURL(targetUrl)
  return window
}

function ensureWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

function trayIcon(state: ReturnType<typeof buildTrayMenuModel>['aggregate']['state'] = 'stopped'): Electron.NativeImage {
  const asset = trayIconAssetName(state, process.platform === 'darwin')
  const image = nativeImage.createFromPath(path.join(moduleDir, '..', 'assets', asset))
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function createTray(): Tray {
  const created = new Tray(trayIcon())
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
  })
  target.setImage(trayIcon(model.aggregate.state))
  target.setToolTip(model.tooltip)
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
        await runtimeManager.stopOwned()
      }
      quitting = true
      app.quit()
  }
}

async function openRoute(route: string): Promise<void> {
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
  if (isTrayIdentity(identity)) {
    trayIdentity = identity
  } else {
    trayIdentity = undefined
  }
  if (tray) updateTray(tray)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    ensureWindow()
  })

  app.whenReady().then(async () => {
    tray = createTray()
    await runtimeManager.ensureRunning().catch(() => undefined)
    await refreshTrayStatus(tray)
    ensureWindow()

    app.on('activate', () => {
      ensureWindow()
    })
  })
}

app.on('before-quit', (event) => {
  quitting = true
  if (trayPoll) clearInterval(trayPoll)
  if (runtimeManager.snapshot().ownership === 'desktop' && !quitCleanupStarted) {
    event.preventDefault()
    quitCleanupStarted = true
    void runtimeManager.stopOwned().finally(() => app.quit())
  }
})

function isTrayIdentity(value: unknown): value is { label: string; webId?: string; podUrl?: string } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { label?: unknown; webId?: unknown; podUrl?: unknown }
  return typeof candidate.label === 'string'
    && (candidate.webId === undefined || typeof candidate.webId === 'string')
    && (candidate.podUrl === undefined || typeof candidate.podUrl === 'string')
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
