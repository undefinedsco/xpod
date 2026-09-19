#!/usr/bin/env node
/**
 * Real Electron lifecycle acceptance against isolated HTTP fixtures.
 * Build desktop first, then: node desktop/scripts/login-recovery-acceptance.mjs
 * Does not use the live Gateway, Cloud IdP, or the user's desktop profile.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.resolve(root, '.test-data/desktop-login-recovery')
await mkdir(output, { recursive: true })
const profile = await mkdtemp(path.join(output, 'profile-'))
const servers = []
let application
let processExited = false
const evidence = { scope: 'isolated HTTP fixture with real Electron main/preload', stages: [] }

async function listen(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
function json(response, data) {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(data))
}
async function until(read, matches, description, timeout = 15_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (matches(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
async function capture(page, name) {
  const screenshot = path.join(output, `${name}.png`)
  await page.screenshot({ path: screenshot })
  const state = { name, url: page.url(), body: await page.locator('body').innerText(), screenshot }
  evidence.stages.push(state)
  return state
}

try {
  let hangingRequests = 0
  const issuer = await listen((request, response) => {
    if (request.url.startsWith('/stall')) { hangingRequests += 1; return }
    response.setHeader('content-type', 'text/html')
    response.end('<h1>Fixture consent</h1><p>Pending interaction</p><button id=guard onclick="window.onbeforeunload=()=>true">Refuse navigation</button>')
  })
  const origin = await listen((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/service/status') return json(response, [{ name: 'css', status: 'running' }, { name: 'api', status: 'running' }])
    if (url.pathname === '/provision/status') return json(response, { managed: true, oidcIssuer: issuer })
    if (url.pathname === '/.well-known/openid-configuration') return json(response, { issuer })
    response.setHeader('content-type', 'text/html')
    response.end(`<h1>${url.searchParams.get('xpod-login') === 'cancelled' ? 'Login cancelled' : 'Fixture product'}</h1>`)
  })
  const target = `${origin}/ai-connections`
  application = await electron.launch({
    args: [path.join(root, 'desktop/dist/main.js')], cwd: path.join(root, 'desktop'),
    env: { ...process.env, XPOD_DESKTOP_URL: target, XPOD_DESKTOP_ACCEPTANCE: '1',
      XPOD_DESKTOP_ALLOW_PARALLEL_ACCEPTANCE: '1', XPOD_DESKTOP_USER_DATA_DIR: profile },
    timeout: 30_000,
  })
  const child = application.process()
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    processExited = true
    resolve({ code, signal })
  }))
  const page = await application.firstWindow()
  // Electron's native will-prevent-unload handler owns this decision. Disable
  // Playwright's competing automatic dialog dismissal during cancellation.
  page.on('dialog', () => {})
  await page.waitForURL(target)
  await capture(page, 'initial-product')

  await application.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url)
  }, `${issuer}/.account/interaction/fixture/oidc/consent/`)
  await capture(page, 'pending-consent')
  // Main-process navigation remains pending forever until native cancellation.
  // Do not await loadURL: the regression is specifically independent of DOM.
  await application.evaluate(({ BrowserWindow }, url) => {
    void BrowserWindow.getAllWindows()[0].loadURL(url).catch(() => undefined)
  }, `${issuer}/stall`)
  await until(() => hangingRequests, value => value === 1, 'stalled HTTP navigation')
  const menuState = await application.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('xpod-cancel-login')
    if (!item) throw new Error('Missing native xpod-cancel-login menu item')
    const window = BrowserWindow.getAllWindows()[0]
    const before = { enabled: item.enabled, loading: window.webContents.isLoading() }
    item.click(undefined, window, {})
    return before
  })
  assert.equal(menuState.enabled, true)
  assert.equal(menuState.loading, true)
  await until(() => page.url(), value => {
    const url = new URL(value)
    return url.origin === origin && url.searchParams.get('xpod-login') === 'cancelled'
  }, 'native cancellation return URL')
  await page.getByRole('heading', { name: 'Login cancelled' }).waitFor()
  await capture(page, 'native-cancelled')
  evidence.nativeCancellation = menuState

  await application.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url)
  }, `${issuer}/.account/interaction/guarded-fixture/oidc/consent/`)
  await page.locator('#guard').click()
  await application.evaluate(({ Menu, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.once('will-prevent-unload', () => {
      window.webContents.__acceptancePreventUnloadObserved = true
    })
    Menu.getApplicationMenu().getMenuItemById('xpod-cancel-login').click(undefined, window, {})
  })
  await until(() => page.url(), value => {
    const url = new URL(value)
    return url.origin === origin && url.searchParams.get('xpod-login') === 'cancelled'
  }, 'native cancellation return URL')
  await page.getByRole('heading', { name: 'Login cancelled' }).waitFor()
  evidence.beforeUnloadObserved = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.__acceptancePreventUnloadObserved === true)
  assert.equal(evidence.beforeUnloadObserved, true)
  await capture(page, 'native-cancel-before-unload')

  // Closing a pending authorization must not retain that interaction behind
  // the tray. Reopening exercises Electron's real activate path.
  await application.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url)
    BrowserWindow.getAllWindows()[0].close()
  }, `${issuer}/.account/interaction/second-fixture/oidc/consent/`)
  await application.evaluate(({ app }) => { app.emit('activate') })
  const reopened = await until(async () => {
    for (const candidate of application.windows()) {
      if (!candidate.isClosed() && new URL(candidate.url()).origin === origin) return candidate
    }
    return undefined
  }, Boolean, 'reopened product instead of old interaction')
  assert.equal(new URL(reopened.url()).pathname, '/ai-connections')
  await capture(reopened, 'reopened-product')

  await reopened.evaluate(() => window.xpodDesktop.setWindowMode('auth'))
  const readContentSize = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  const beforeReplaceState = await until(readContentSize, size => size[0] === 280 && size[1] === 400, 'auth compact native size')
  await reopened.evaluate(() => history.replaceState(null, '', location.pathname))
  await new Promise(resolve => setTimeout(resolve, 500))
  evidence.sameDocumentMode = { beforeReplaceState, afterReplaceState: await readContentSize() }
  assert.deepEqual(evidence.sameDocumentMode.afterReplaceState, [280, 400])
  await capture(reopened, 'compact-after-query-removal')

  // Use the ordinary native API, not acceptance-only quit IPC or app.exit.
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  const quit = await Promise.race([exited, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Normal app.quit() did not exit within 10 seconds')), 10_000)
    timer.unref()
  })])
  assert.equal(quit.code, 0)
  evidence.normalQuit = quit
  evidence.passed = true
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (application && !processExited) {
    // Cleanup only this isolated test process after recording a failure.
    await application.evaluate(({ app }) => app.exit(1)).catch(() => undefined)
  }
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  await rm(profile, { recursive: true, force: true })
  await writeFile(path.join(output, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence, null, 2))
}
