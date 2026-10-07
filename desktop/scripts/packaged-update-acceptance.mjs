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
 *     --new-zip release/Xpod-0.1.1-mac.zip \
 *     --source-sha <40-hex commit> \
 *     --old-zip release/Xpod-0.1.0-mac.zip \
 *     --old-release-tag v0.1.0 \
 *     --evidence-out /tmp/desktop-self-update-evidence.json
 *
 * Relative paths follow the desktop package (documented local usage) and also
 * resolve from the repository root (candidate workflow), so both callers work.
 *
 * `--new-app <Xpod.app>` signs and zips a freshly built bundle instead, which is
 * the shape a release ships.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(scriptsDir, '..')
const REQUIRED_LIFECYCLE_EVENTS = [
  'checking-for-update',
  'update-available',
  'download-verified',
  'update-downloaded',
  'auto-install-ready',
]

let options
let appProcess
let fixture
let oldApp
let oldBinary
let userData
let releasedFacts

/**
 * Resolve a caller-supplied path that may be written relative to the desktop
 * package (documented local usage) or relative to the repository root (the
 * candidate workflow runs from the repository root). An existing path wins;
 * otherwise the documented desktop-relative interpretation is returned.
 */
export function resolveCallerPath(value, { baseDir = desktopDir, cwd = process.cwd() } = {}) {
  const text = String(value)
  const candidates = [ path.resolve(baseDir, text), path.resolve(cwd, text) ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

/** Wait for one owned phase, removing its listener and timer on every outcome. */
export function waitForPhaseEvent(emitter, event, accepts, timeoutMs, phase, ownedChild) {
  return new Promise((resolve, reject) => {
    const settle = (error, args) => {
      clearTimeout(timer)
      emitter.removeListener(event, onEvent)
      ownedChild?.removeListener('exit', onChildExit)
      emitter.removeListener('error', onError)
      if (ownedChild !== emitter) ownedChild?.removeListener('error', onError)
      if (error) reject(error)
      else resolve(args)
    }
    const onError = () => settle(new Error(`Packaged update acceptance failed waiting for ${phase}.`))
    const onChildExit = () => settle(new Error(`Packaged update acceptance child exited before ${phase}.`))
    const onEvent = (...args) => {
      try {
        if (accepts(...args)) settle(undefined, args)
      } catch (error) {
        settle(error)
      }
    }
    const timer = setTimeout(() => {
      settle(new Error(`Packaged update acceptance timed out waiting for ${phase}.`))
    }, timeoutMs)
    emitter.on(event, onEvent)
    emitter.on('error', onError)
    if (ownedChild !== emitter) ownedChild?.on('error', onError)
    ownedChild?.on('exit', onChildExit)
  })
}

async function run() {
  if (process.platform !== 'darwin') {
    console.error('Packaged update acceptance requires macOS.')
    process.exit(2)
  }

  options = parseArgs(process.argv.slice(2))
  oldApp = resolveCallerPath(String(options.old ?? 'release/mac-arm64/Xpod.app'))
  const newZip = resolveNewZip()
  oldBinary = path.join(oldApp, 'Contents', 'MacOS', 'Xpod')
  const newVersion = String(options.version ?? inferVersion(newZip) ?? '0.1.1')
  const sourceSha = String(options['source-sha'] ?? process.env.XPOD_ACCEPTED_SHA ?? '').trim()
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error('--source-sha (or XPOD_ACCEPTED_SHA) must be a 40-character lowercase commit SHA')
  }
  const oldReleaseTag = options['old-release-tag'] ? String(options['old-release-tag']) : undefined
  const oldVersion = readBundleVersion(oldApp)
  const oldZip = options['old-zip'] ? resolveCallerPath(options['old-zip']) : undefined
  if (oldZip && !fs.statSync(oldZip, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Old packaged zip not found: ${oldZip}`)
  }
  userData = userDataPath(options)
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

  // Provenance captured before the bundle is ever replaced: the old binary hash
  // and the exact archive bytes the released app will download.
  const oldBinarySha256 = sha256File(oldBinary)
  const newArchive = describeArchive(newZip)

  const fixturePath = path.join(scriptsDir, 'update-feed-fixture.mjs')
  const fixtureArgs = [
    '--version', newVersion,
    '--artifact', newZip,
    '--sha512', newArchive.sha512,
    '--size', String(newArchive.size),
  ]
  fixture = spawn(process.execPath, [fixturePath, ...fixtureArgs], {
    cwd: desktopDir,
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  process.once('SIGINT', () => {
    void releaseOwned().finally(() => process.exit(130))
  })
  process.once('SIGTERM', () => {
    void releaseOwned().finally(() => process.exit(143))
  })

  const phaseTimeoutMs = Number(options.timeout ?? 120_000)
  let cleanupFacts
  let exitCode
  let events
  try {
    fixture.stdout.setEncoding('utf8')
    let output = ''
    let feedUrl
    await waitForPhaseEvent(fixture.stdout, 'data', (chunk) => {
      output += chunk
      const match = output.match(/XPOD_UPDATE_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+\/update\/darwin)/)
      if (!match) return false
      feedUrl = match[1]
      return true
    }, phaseTimeoutMs, 'fixture READY', fixture)
    console.log(`Update feed: ${feedUrl}`)
    console.log(`Isolated userData: ${userData}`)
    console.log('Expected path: old app checks -> newer manifest -> checksum verify -> swap bundle -> new app version.')
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
    const [code, signal] = await waitForPhaseEvent(appProcess, 'exit', () => true, phaseTimeoutMs, 'old App exit')
    exitCode = code
    console.log(`Packaged Xpod exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`)
    await waitForAcceptanceEvidence({
      versionFile: expectedVersionFile,
      expectedVersion: newVersion,
      installMarker,
      lifecycleLog,
      timeoutMs: Number(options.timeout ?? 120_000),
    })
    events = readLifecycleEvents(lifecycleLog)
  } finally {
    cleanupFacts = await releaseOwned()
  }
  const cleanup = cleanupFacts
  if (!cleanupSatisfied(cleanup)) {
    throw new Error(`owned resources were not fully released: ${JSON.stringify(cleanup)}`)
  }
  writeAcceptanceEvidence({
    sourceSha,
    oldReleaseTag,
    oldVersion,
    newVersion,
    oldApp,
    oldBinarySha256,
    oldZip,
    newArchive,
    events,
    cleanup,
  })
  console.log(`XPOD_UPDATE_ACCEPTANCE_OK ${newVersion}`)
  process.exit(exitCode ?? 0)
}

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
  if (options['new-zip']) return resolveCallerPath(options['new-zip'])
  if (!options['new-app']) return undefined

  const appPath = resolveCallerPath(options['new-app'])
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

function readBundleVersion(appPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist')
  if (!fs.existsSync(infoPlist)) {
    throw new Error(`Packaged app is missing Contents/Info.plist: ${appPath}`)
  }
  return execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist,
  ], { encoding: 'utf8' }).trim()
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sha512Base64(filePath) {
  return createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

function describeArchive(filePath) {
  return {
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    sha512: sha512Base64(filePath),
  }
}

function readLifecycleEvents(logPath) {
  let text = ''
  try {
    text = fs.readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  return REQUIRED_LIFECYCLE_EVENTS.filter((name) => text.includes(name))
}

export function cleanupSatisfied(facts) {
  return Boolean(
    facts
    && facts.oldAppStopped === true
    && facts.relaunchedAppStopped === true
    && facts.fixtureStopped === true
    && facts.removedUserData === true
    && facts.remainingOwnedPids === 0
    && facts.removalError === undefined
    && facts.inventoryError === undefined,
  )
}

/**
 * Exact path markers for the processes this run owns: the private bundle's
 * `Contents` subtree and, only when this run created it, the private
 * `xpod-update-*` userData directory.
 *
 * `Contents` (rather than the `.app` root) is deliberate: the acceptance
 * process is launched with `--old <Xpod.app>`, so matching the bundle root
 * would select this very process and then kill it. `Contents` covers the
 * Electron main process, the `Contents/Resources/runtime/xpod` runtime that
 * extracts `runtime-cache`, and `Contents/Frameworks` helpers. A caller
 * supplied `--user-data` (the original profile) is never a marker.
 */
export function ownedProcessMarkers({ appPath, userData: dataDir, privateUserData }) {
  const markers = []
  if (appPath) markers.push(path.join(appPath, 'Contents'))
  if (privateUserData && dataDir) markers.push(dataDir)
  return markers
}

/**
 * True when `command` contains `marker` as a whole path token. A raw substring
 * test would accept ambiguous prefixes, so a sibling such as
 * `/tmp/xpod-update-abcdef` could be mistaken for `/tmp/xpod-update-abc`. The
 * marker must begin at a token boundary and end at end-of-string, a path
 * separator, whitespace or a quote, which keeps descendants owned without
 * capturing prefix siblings.
 */
export function commandNamesPath(command, marker) {
  if (!marker) return false
  let from = 0
  for (;;) {
    const index = command.indexOf(marker, from)
    if (index === -1) return false
    const before = index === 0 ? '' : command[index - 1]
    const after = index + marker.length >= command.length ? '' : command[index + marker.length]
    const beforeOk = index === 0 || /[\s'"]/u.test(before)
    const afterOk = after === '' || after === '/' || /[\s'"]/u.test(after)
    if (beforeOk && afterOk) return true
    from = index + 1
  }
}

/**
 * PIDs whose command line names one of the owned markers, read from the real
 * process table so a bundle-launched runtime or a userData-argument helper is
 * caught even though neither appears as `oldBinary`. The acceptance process
 * itself is never owned.
 */
export function listOwnedPids(markers, { readProcessTable = defaultReadProcessTable, selfPid = process.pid } = {}) {
  const wanted = markers.filter(Boolean)
  if (wanted.length === 0) return []
  const pids = new Set()
  for (const { pid, command } of readProcessTable()) {
    if (pid === selfPid) continue
    if (wanted.some((marker) => commandNamesPath(command, marker))) pids.add(pid)
  }
  return [ ...pids ]
}

function defaultReadProcessTable() {
  let output
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  } catch (error) {
    // An unreadable process table is not "no owned processes". Fail closed so
    // cleanup never deletes a directory while a writer may still exist.
    throw new Error(`process inventory unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const rows = []
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/u)
    if (match) rows.push({ pid: Number(match[1]), command: match[2] })
  }
  return rows
}

/** Wait up to `windowMs` for any owned process to appear, then return its PIDs. */
export async function observeOwnedProcesses(markers, windowMs, {
  listPids = (value) => listOwnedPids(value),
  wait = sleep,
} = {}) {
  const deadline = Date.now() + windowMs
  for (;;) {
    const pids = listPids(markers)
    if (pids.length > 0 || Date.now() >= deadline) return pids
    await wait(200)
  }
}

/**
 * Terminate every owned PID (SIGTERM, then SIGKILL after the deadline) and only
 * report ownership released once the process table no longer names any of them.
 */
export async function stopOwnedProcesses(markers, timeoutMs, {
  listPids = (value) => listOwnedPids(value),
  killPid = (pid, signal) => process.kill(pid, signal),
  wait = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = listPids(markers)
    if (pids.length === 0) return { stopped: true, remaining: 0 }
    for (const pid of pids) {
      try { killPid(pid, 'SIGTERM') } catch { /* already gone */ }
    }
    await wait(200)
    if (Date.now() >= deadline) {
      for (const pid of listPids(markers)) {
        try { killPid(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      await wait(200)
      const remaining = listPids(markers)
      return { stopped: remaining.length === 0, remaining: remaining.length }
    }
  }
}

/**
 * Remove the private userData directory only while no owned process remains.
 * A transient `ENOTEMPTY` is retried a bounded number of times, each retry
 * gated on a fresh ownership check; any other error, or a retry budget that is
 * exhausted while writers may still exist, is returned to the caller rather
 * than hidden behind a blind `rm` retry.
 */
export async function removeOwnedUserData(userDataDir, markers, {
  listPids = (value) => listOwnedPids(value),
  remove = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  pathExists = (value) => fs.existsSync(value),
  attempts = 5,
  retryDelayMs = 200,
  wait = sleep,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let owned
    try {
      owned = listPids(markers)
    } catch (error) {
      // Unknown process inventory: never delete on a guess.
      return { removed: false, remainingOwnedPids: 0, error }
    }
    if (owned.length > 0) {
      return {
        removed: false,
        remainingOwnedPids: owned.length,
        error: new Error('owned processes still running before userData removal'),
      }
    }
    try {
      remove(userDataDir)
      if (!pathExists(userDataDir)) return { removed: true, remainingOwnedPids: 0 }
      return { removed: false, remainingOwnedPids: 0, error: new Error('userData directory still exists after removal') }
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' || attempt === attempts - 1) {
        return { removed: false, remainingOwnedPids: 0, error }
      }
      await wait(retryDelayMs)
    }
  }
  return { removed: false, remainingOwnedPids: 0, error: new Error('userData removal exhausted its retry budget') }
}

/**
 * Kill every process this run owns and confirm none remain before the private
 * userData directory is removed. Ownership is proven by the exact private
 * bundle subtree and the exact private userData directory; nothing is selected
 * by a broad name, and the user's original profile is never touched.
 */
async function releaseOwned() {
  if (releasedFacts) return releasedFacts
  const ownsUserData = !options['user-data']
  const markers = ownedProcessMarkers({ appPath: oldApp, userData, privateUserData: ownsUserData })
  const facts = {
    oldAppStopped: true,
    relaunchedAppStopped: true,
    relaunchProcessObserved: false,
    relaunchDistinctPid: false,
    fixtureStopped: true,
    // Only an actual verified removal of the private directory may set this
    // true. An explicit --user-data is the user's original profile: it is
    // preserved, so `removedUserData` stays false and cleanup is not satisfied.
    removedUserData: false,
    remainingOwnedPids: 0,
  }

  if (fixture) {
    if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGTERM')
    if (!(await waitForChildExit(fixture, 5_000))) {
      try { fixture.kill('SIGKILL') } catch { /* already gone */ }
    }
    facts.fixtureStopped = await waitForChildExit(fixture, 2_000)
  }

  if (appProcess) {
    if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill('SIGTERM')
    if (!(await waitForChildExit(appProcess, 5_000))) {
      try { appProcess.kill('SIGKILL') } catch { /* already gone */ }
    }
    facts.oldAppStopped = await waitForChildExit(appProcess, 2_000)
  }

  try {
    // The relaunch fact is proven only by the exact old binary path. The bundle
    // `Contents` subtree also matches a stale runtime or helper, which can have
    // a different PID without the NEW app main process ever running.
    if (oldBinary) {
      const observed = await observeOwnedProcesses([ oldBinary ], 3_000)
      if (observed.length > 0) {
        facts.relaunchProcessObserved = true
        facts.relaunchDistinctPid = observed.some((pid) => pid !== appProcess?.pid)
      }
    }

    if (markers.length > 0) {
      const stopped = await stopOwnedProcesses(markers, 10_000)
      facts.relaunchedAppStopped = stopped.stopped
      facts.remainingOwnedPids = stopped.remaining
    }
  } catch (error) {
    // Process inventory failed: fail closed, do not delete, surface the error.
    facts.inventoryError = error instanceof Error ? error.message : String(error)
    facts.relaunchedAppStopped = false
  }

  if (ownsUserData && facts.inventoryError === undefined) {
    const removal = await removeOwnedUserData(userData, markers)
    facts.removedUserData = removal.removed
    if (removal.remainingOwnedPids > facts.remainingOwnedPids) facts.remainingOwnedPids = removal.remainingOwnedPids
    if (removal.error) facts.removalError = removal.error.message
  }

  releasedFacts = facts
  return facts
}

function waitForChildExit(child, timeoutMs) {
  if (!child) return Promise.resolve(true)
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bind the run to the exact source commit, the exact released old bytes and the
 * exact new archive so a green `desktop` check cannot be claimed from bundle
 * presence alone. Only booleans, counters, versions and hashes are recorded.
 */
function writeAcceptanceEvidence({
  sourceSha,
  oldReleaseTag,
  oldVersion,
  newVersion,
  oldApp,
  oldBinarySha256,
  oldZip,
  newArchive,
  events,
  cleanup,
}) {
  if (!options['evidence-out']) return
  const evidence = {
    schemaVersion: 1,
    kind: 'desktop-self-update-acceptance',
    ok: events.length === REQUIRED_LIFECYCLE_EVENTS.length && cleanupSatisfied(cleanup),
    sourceSha,
    oldVersion,
    newVersion,
    oldApp: path.basename(oldApp),
    oldBinarySha256,
    newZip: {
      name: newArchive.name,
      size: newArchive.size,
      sha256: newArchive.sha256,
      sha512: newArchive.sha512,
    },
    events,
    requiredEvents: REQUIRED_LIFECYCLE_EVENTS,
    cleanup,
    completedAt: new Date().toISOString(),
  }
  if (oldReleaseTag) evidence.oldReleaseTag = oldReleaseTag
  if (oldZip) {
    evidence.oldZip = { ...describeArchive(oldZip), version: inferVersion(oldZip) }
  }
  const out = path.resolve(desktopDir, String(options['evidence-out']))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(`Update acceptance evidence: ${out}`)
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
