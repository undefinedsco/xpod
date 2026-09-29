#!/usr/bin/env node

/**
 * Start a packaged old Xpod build against a local newer-version feed.
 *
 * Xpod cannot use Electron's built-in macOS updater: Squirrel validates the new
 * bundle against the ad-hoc `cdhash` requirement of the running build, which no
 * later release can satisfy. The desktop updates itself instead, so this script
 * observes the real Electron process end to end: check -> download -> verify ->
 * stage -> swap the bundle -> relaunch as the newer version.
 *
 * Build two versions first (from desktop/):
 *   electron-builder --mac zip --config.extraMetadata.version=0.1.0
 *   electron-builder --mac zip --config.extraMetadata.version=0.1.1
 *
 * Then launch the old app:
 *   node scripts/packaged-update-acceptance.mjs \
 *     --old release/mac-arm64/Xpod.app \
 *     --new-zip release/Xpod-0.1.1-mac.zip
 *
 * `--new-app <Xpod.app>` signs and zips a freshly built bundle instead, which is
 * the shape a release ships.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('Packaged update acceptance requires macOS.')
  process.exit(2)
}

const options = parseArgs(process.argv.slice(2))
const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(scriptsDir, '..')
const oldApp = path.resolve(desktopDir, String(options.old ?? 'release/mac-arm64/Xpod.app'))
const newZip = resolveNewZip()
const oldBinary = path.join(oldApp, 'Contents', 'MacOS', 'Xpod')
const newVersion = String(options.version ?? inferVersion(newZip) ?? '0.1.1')
const userData = userDataPath(options)
const expectedVersionFile = path.join(userData, 'accepted-version.txt')
const lifecycleLog = path.join(userData, 'update-events.log')
const installMarker = path.join(userData, 'install-requested.txt')

fs.mkdirSync(userData, { recursive: true, mode: 0o700 })

if (!fs.existsSync(oldBinary)) {
  throw new Error(`Old packaged app binary not found: ${oldBinary}`)
}
if (!newZip) {
  throw new Error('--new-zip or --new-app is required for packaged update acceptance')
}
if (!fs.statSync(newZip).isFile()) {
  throw new Error(`New packaged zip not found: ${newZip}`)
}

const fixturePath = path.join(scriptsDir, 'update-feed-fixture.mjs')
const fixtureArgs = ['--version', newVersion]
if (newZip) fixtureArgs.push('--artifact', newZip)
const fixture = spawn(process.execPath, [fixturePath, ...fixtureArgs], {
  cwd: desktopDir,
  stdio: ['ignore', 'pipe', 'inherit'],
})

let appProcess
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  if (appProcess && !appProcess.killed) appProcess.kill()
  if (!fixture.killed) fixture.kill()
  if (!options['user-data']) fs.rmSync(userData, { recursive: true, force: true })
}

process.once('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.once('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

fixture.stdout.setEncoding('utf8')
let output = ''
fixture.stdout.on('data', (chunk) => {
  output += chunk
  const match = output.match(/XPOD_UPDATE_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+\/update\/darwin)/)
  if (!match || appProcess) return
  const feedUrl = match[1]
  console.log(`Update feed: ${feedUrl}`)
  console.log(`Isolated userData: ${userData}`)
  console.log('Expected path: old app checks -> newer manifest -> download -> verify -> swap bundle -> new app version.')
  if (!newZip) console.warn('No archive supplied; the feed response is valid but the download will fail.')

  appProcess = spawn(oldBinary, [], {
    cwd: desktopDir,
    env: {
      ...process.env,
      XPOD_DESKTOP_UPDATE_FEED_URL: feedUrl,
      XPOD_DESKTOP_AUTO_INSTALL_UPDATES: String(options['auto-install'] ?? '1'),
      // The helper reopens the replaced bundle directly so this process'
      // acceptance environment (version file, lifecycle log) survives.
      XPOD_DESKTOP_UPDATE_RELAUNCH: String(options.relaunch ?? 'direct'),
      XPOD_DESKTOP_USER_DATA_DIR: userData,
      XPOD_DESKTOP_UPDATE_ACCEPTANCE_VERSION_FILE: expectedVersionFile,
      XPOD_DESKTOP_UPDATE_ACCEPTANCE_LOG: lifecycleLog,
      XPOD_DESKTOP_UPDATE_ACCEPTANCE_INSTALL_MARKER: installMarker,
    },
    stdio: 'inherit',
  })
  appProcess.once('exit', async (code, signal) => {
    console.log(`Packaged Xpod exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`)
    try {
      await waitForAcceptanceEvidence({
        versionFile: expectedVersionFile,
        expectedVersion: newVersion,
        installMarker,
        lifecycleLog,
        timeoutMs: Number(options.timeout ?? 120_000),
      })
      console.log(`XPOD_UPDATE_ACCEPTANCE_OK ${newVersion}`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      cleanup()
      process.exit(1)
    }
    cleanup()
    process.exit(code ?? 0)
  })
})

fixture.once('exit', (code) => {
  if (!appProcess && code !== 0) {
    cleanup()
    process.exit(code ?? 1)
  }
})

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const value = args[index + 1]
    if (value && !value.startsWith('--')) {
      parsed[key] = value
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

/**
 * Turn a built bundle into the archive a release would ship: ad-hoc signed with
 * the bundle's resources sealed, then zipped the way electron-builder does.
 */
function resolveNewZip() {
  if (options['new-zip']) return path.resolve(desktopDir, options['new-zip'])
  if (!options['new-app']) return undefined

  const appPath = path.resolve(desktopDir, options['new-app'])
  if (!fs.existsSync(path.join(appPath, 'Contents', 'Info.plist'))) {
    throw new Error(`--new-app is not an application bundle: ${appPath}`)
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-zip-'))
  const name = path.basename(appPath).replace(/\.app$/, '')
  const zipPath = path.join(outputDir, `${name}-update.zip`)
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], { stdio: 'inherit' })
  console.log(`Signed update archive: ${zipPath}`)
  return zipPath
}

function inferVersion(zipPath) {
  const match = zipPath?.match(/(?:^|[-_])v?(\d+\.\d+(?:\.\d+){0,2})(?:[-_.]|$)/)
  return match?.[1]
}

function userDataPath(parsedOptions) {
  return parsedOptions['user-data']
    ? path.resolve(parsedOptions['user-data'])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'xpod-update-'))
}

async function waitForAcceptanceEvidence({
  versionFile,
  expectedVersion,
  installMarker,
  lifecycleLog,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const actual = fs.readFileSync(versionFile, { encoding: 'utf8', flag: 'a+' }).trim()
    const installed = fs.readFileSync(installMarker, { encoding: 'utf8', flag: 'a+' }).trim()
    const events = fs.readFileSync(lifecycleLog, { encoding: 'utf8', flag: 'a+' })
    if (
      actual === expectedVersion
      && installed === expectedVersion
      && events.includes('checking-for-update')
      && events.includes('update-available')
      && events.includes('download-verified')
      && events.includes('update-downloaded')
      && events.includes('auto-install-ready')
    ) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Update did not install and relaunch as Xpod ${expectedVersion} within ${timeoutMs}ms.`)
}
