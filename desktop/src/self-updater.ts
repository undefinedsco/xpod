/**
 * Self-hosted desktop updater for macOS.
 *
 * Electron's built-in `autoUpdater` hands installation to Squirrel.Mac, which
 * validates the downloaded bundle against the *running* app's designated code
 * requirement. Xpod is ad-hoc signed, and for an ad-hoc signature that
 * requirement is a bare `cdhash H"…"`: no other build — not even the next
 * release — can ever satisfy it, so the download finishes and the install step
 * fails. Nothing in the updater can be configured to skip that check.
 *
 * This module owns the whole path instead of the Squirrel lifecycle:
 *
 *   manifest (electron-builder `latest-mac.yml` or the Electron update JSON)
 *     -> download with progress, speed and byte-range resume
 *     -> verify (sha512 when the manifest carries one, plus a strict code
 *        signature check on the staged bundle)
 *     -> stage with `ditto -x -k`
 *     -> swap the bundle from a detached helper that runs after this app exits
 *
 * It deliberately exposes the same event vocabulary as Electron's autoUpdater so
 * `DesktopUpdateManager` keeps owning the user-facing state machine.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  accessSync,
  createWriteStream,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import process from 'node:process'
import type { DesktopUpdateProgress } from './update-manager.js'

export interface SelfUpdateManifest {
  version: string
  /** Absolute URL of the update archive. */
  url: string
  sha512?: string
  size?: number
}

/** The tray owns presentation; this is the same shape the manager publishes. */
export type SelfUpdateProgress = DesktopUpdateProgress

export interface StagedUpdate {
  version: string
  archivePath: string
  appPath: string
}

export interface DesktopSelfUpdaterOptions {
  /** Version of the running app; a manifest must be strictly newer. */
  version: string
  /** Running `.app` bundle that an install replaces. */
  appPath: string
  /** Directory that holds partial downloads and the staged bundle. */
  updatesDir: string
  /** Explicit manifest URL. Updates stay disabled without one. */
  manifestUrl?: string
  fetchImpl?: typeof fetch
  runCommand?: (command: string, args: readonly string[]) => Promise<string>
  spawnInstaller?: (scriptPath: string, environment: NodeJS.ProcessEnv) => void
  /** Quit the app so the detached helper can replace the bundle. */
  requestQuit?: () => void
  onLifecycleEvent?: (event: string, detail?: string) => void
  /**
   * How the helper reopens Xpod. `direct` runs the new executable with this
   * process' environment, which unattended acceptance needs; production uses
   * LaunchServices through `open`.
   */
  relaunch?: 'open' | 'direct'
  /** Abort a transfer that has not delivered a byte for this long. */
  stallTimeoutMs?: number
  now?: () => number
}

export const UPDATE_RELAUNCH_ENV = 'XPOD_DESKTOP_UPDATE_RELAUNCH'
export const DEFAULT_STALL_TIMEOUT_MS = 120_000

const MANIFEST_TIMEOUT_MS = 30_000

/**
 * Read a manifest from either update channel:
 *
 * - electron-builder's `latest-mac.yml`, which is what Xpod releases publish;
 * - the Electron update JSON (`{ url, name }`) that
 *   `update.electronjs.org` and the local acceptance fixture serve.
 */
export function parseSelfUpdateManifest(body: string, manifestUrl: string): SelfUpdateManifest | undefined {
  const trimmed = body.trim()
  if (!trimmed) return undefined

  const json = parseJsonManifest(trimmed, manifestUrl)
  if (json) return json

  const fields = parseYamlFields(trimmed)
  const version = fields.version
  if (!version || !isVersionLike(version)) return undefined
  const archive = fields['files.0.url'] ?? fields.path ?? fields.url
  if (!archive) return undefined
  const sha512 = fields['files.0.sha512'] ?? fields.sha512
  const size = Number(fields['files.0.size'] ?? fields.size ?? '')
  return {
    version: normalizeVersion(version),
    url: resolveArchiveUrl(archive, manifestUrl),
    ...(sha512 && isBase64Sha512(sha512) ? { sha512 } : {}),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
  }
}

/**
 * SemVer ordering without a dependency.
 *
 * The pre-release suffix matters: a local `0.4.19-local.1` build must not block
 * the real 0.4.19 release from being offered, while it must still rank above the
 * released 0.4.18 it was built from.
 */
export function compareDesktopVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const delta = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  // A released version always outranks its own pre-releases.
  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) {
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1
      continue
    }
    // Numeric identifiers rank below alphanumeric ones.
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export function isVersionLike(value: string): boolean {
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.trim())
}

/** `Xpod 0.4.19` and `0.4.19` both name version 0.4.19. */
export function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/u, '').replace(/^Xpod\s+/iu, '')
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatUpdateProgress(progress: SelfUpdateProgress): string {
  const percent = progress.percent !== undefined ? `${Math.round(progress.percent)}%` : formatBytes(progress.transferred)
  const speed = progress.bytesPerSecond && progress.bytesPerSecond > 0
    ? ` · ${formatBytes(progress.bytesPerSecond)}/s`
    : ''
  const total = progress.total ? ` of ${formatBytes(progress.total)}` : ''
  return `${percent}${total}${speed}`
}

/** Parse the version out of a staged bundle's Info.plist. */
export function parseBundleVersion(plistXml: string): string | undefined {
  const match = plistXml.match(/<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u)
  return match?.[1]?.trim() || undefined
}

export interface InstallScriptOptions {
  pid: number
  targetApp: string
  stagedApp: string
  logPath: string
  relaunch: 'open' | 'direct'
}

/**
 * The helper runs after the app exits, so it must be plain `/bin/sh` with every
 * path already resolved. A failed copy restores the backup rather than leaving
 * the user without an app.
 */
export function buildInstallScript(options: InstallScriptOptions): string {
  const quote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`
  const target = quote(options.targetApp)
  const staged = quote(options.stagedApp)
  const backup = quote(`${options.targetApp}.xpod-previous`)
  const log = quote(options.logPath)
  const executable = quote(path.join(options.targetApp, 'Contents', 'MacOS', path.basename(options.targetApp, '.app')))
  // Every redirection must name the same variable the script defines: `>>"$log"`
  // silently becomes an empty file name and breaks the relaunch.
  const relaunch = options.relaunch === 'direct'
    ? `${executable} >>"$LOG" 2>&1 &`
    : `open ${target} >>"$LOG" 2>&1 || true`
  return `#!/bin/sh
# Generated by Xpod ${options.pid}. Replaces the app bundle after it exits.
LOG=${log}
exec >>"$LOG" 2>&1
echo "installer started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
attempt=0
while kill -0 ${options.pid} 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -gt 900 ] && break
  sleep 0.2
done
# Let the owned runtime release its files inside the bundle.
sleep 1
rm -rf ${backup}
if ! ditto ${target} ${backup}; then
  echo "backup failed"
  exit 1
fi
rm -rf ${target}
if ! ditto ${staged} ${target}; then
  echo "copy failed; restoring previous bundle"
  rm -rf ${target}
  ditto ${backup} ${target}
  open ${target} >>"$LOG" 2>&1 || true
  exit 1
fi
xattr -dr com.apple.quarantine ${target} >/dev/null 2>&1 || true
echo "installed ${target}"
rm -rf ${backup} ${quote(path.dirname(options.stagedApp))}
${relaunch}
echo "relaunched"
`
}

export class DesktopSelfUpdater {
  private manifestUrl: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly runCommand: (command: string, args: readonly string[]) => Promise<string>
  private readonly spawnInstaller: (scriptPath: string, environment: NodeJS.ProcessEnv) => void
  private readonly now: () => number
  private readonly stallTimeoutMs: number
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private abort: AbortController | undefined
  private staged: StagedUpdate | undefined
  private running: Promise<void> | undefined
  private disposed = false

  public constructor(private readonly options: DesktopSelfUpdaterOptions) {
    this.manifestUrl = options.manifestUrl?.trim() || undefined
    this.fetchImpl = options.fetchImpl ?? fetch
    this.runCommand = options.runCommand ?? runCommand
    this.spawnInstaller = options.spawnInstaller ?? ((scriptPath, environment) => {
      spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore', env: environment }).unref()
    })
    this.now = options.now ?? (() => Date.now())
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  public setFeedURL(options: { url: string }): void {
    this.manifestUrl = options.url.trim() || undefined
  }

  public snapshot(): StagedUpdate | undefined {
    return this.staged ? { ...this.staged } : undefined
  }

  public on(event: 'error', listener: (error: unknown) => void): this
  public on(event: 'checking-for-update', listener: () => void): this
  public on(event: 'update-available', listener: (...args: unknown[]) => void): this
  public on(event: 'update-not-available', listener: () => void): this
  public on(event: 'update-downloaded', listener: (...args: unknown[]) => void): this
  public on(event: 'download-progress', listener: (progress: DesktopUpdateProgress) => void): this
  public on(event: string, listener: (...args: never[]) => void): this
  public on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener as (...args: unknown[]) => void)
    this.listeners.set(event, listeners)
    return this
  }

  public checkForUpdates(): void {
    if (this.running) return
    this.running = this.run().catch((error: unknown) => {
      this.options.onLifecycleEvent?.('error', describeError(error))
      this.emit('error', error)
    }).finally(() => {
      this.running = undefined
    })
  }

  public quitAndInstall(): void {
    const staged = this.staged
    if (!staged || this.disposed) return
    const blocked = describeInstallBlocker(this.options.appPath)
    if (blocked) {
      this.emit('error', new Error(blocked))
      return
    }

    const logPath = path.join(this.options.updatesDir, 'install.log')
    const scriptPath = path.join(this.options.updatesDir, 'install-update.sh')
    mkdirSync(this.options.updatesDir, { recursive: true })
    writeFileSync(scriptPath, buildInstallScript({
      pid: process.pid,
      targetApp: this.options.appPath,
      stagedApp: staged.appPath,
      logPath,
      relaunch: this.options.relaunch ?? 'open',
    }), { mode: 0o700 })
    this.spawnInstaller(scriptPath, { ...process.env, [UPDATE_RELAUNCH_ENV]: this.options.relaunch ?? 'open' })
    this.options.requestQuit?.()
  }

  public dispose(): void {
    this.disposed = true
    this.abort?.abort()
  }

  private async run(): Promise<void> {
    if (!this.manifestUrl) {
      throw new Error('No update feed is configured for this build.')
    }
    this.emit('checking-for-update')
    const manifest = await this.fetchManifest(this.manifestUrl)
    if (!manifest) {
      this.emit('update-not-available')
      return
    }
    if (compareDesktopVersions(manifest.version, this.options.version) <= 0) {
      this.emit('update-not-available')
      return
    }

    mkdirSync(this.options.updatesDir, { recursive: true })
    this.emit('update-available', { version: manifest.version })
    const archivePath = await this.download(manifest)
    this.staged = await this.stage(manifest, archivePath)
    this.emit('update-downloaded', { version: manifest.version })
  }

  private async fetchManifest(url: string): Promise<SelfUpdateManifest | undefined> {
    const controller = this.beginRequest()
    const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json, text/yaml, text/plain;q=0.9, */*;q=0.8',
          'user-agent': `Xpod/${this.options.version} (macOS)`,
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      // An update service answers 204 (or 404) when the caller is current.
      if (response.status === 204 || response.status === 404) return undefined
      if (!response.ok) {
        throw new Error(`The update service answered HTTP ${response.status}.`)
      }
      const body = await response.text()
      const manifest = parseSelfUpdateManifest(body, response.url || url)
      if (!manifest) throw new Error('The update service returned an unreadable manifest.')
      return manifest
    } finally {
      clearTimeout(timeout)
      this.endRequest(controller)
    }
  }

  private async download(manifest: SelfUpdateManifest): Promise<string> {
    const archivePath = path.join(this.options.updatesDir, archiveName(manifest))
    const partPath = `${archivePath}.part`
    let received = existsSync(partPath) ? statSync(partPath).size : 0
    const resumed = received > 0

    const controller = this.beginRequest()
    let initialized = false
    let lastProgressAt = this.now()
    const watchdog = setInterval(() => {
      if (this.now() - lastProgressAt <= this.stallTimeoutMs) return
      controller.abort(new Error('The update download stalled with no progress.'))
    }, Math.max(5_000, Math.min(this.stallTimeoutMs, 15_000)))
    ;(watchdog as unknown as { unref?: () => void }).unref?.()

    try {
      const response = await this.fetchImpl(manifest.url, {
        headers: {
          ...(received > 0 ? { range: `bytes=${received}-` } : {}),
          'user-agent': `Xpod/${this.options.version} (macOS)`,
        },
        redirect: 'follow',
        signal: controller.signal,
      })
      // A server that ignores Range answers 200 with the whole archive.
      if (response.status === 200 && received > 0) received = 0
      if (response.status === 416 && received > 0) {
        rmSync(partPath, { force: true })
        throw new Error('The partial update download could not be resumed.')
      }
      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`The update download failed with HTTP ${response.status}.`)
      }
      const contentLength = Number(response.headers.get('content-length') ?? '')
      const total = Number.isFinite(contentLength) && contentLength > 0
        ? contentLength + received
        : manifest.size
      const body = response.body
      if (!body) throw new Error('The update download returned an empty response.')

      const stream = createWriteStream(partPath, { flags: received > 0 && response.status === 206 ? 'a' : 'w' })
      let windowBytes = 0
      let windowStartedAt = this.now()
      const reader = body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value
        if (!value?.byteLength) continue
        if (!stream.write(Buffer.from(value))) await once(stream, 'drain')
        received += value.byteLength
        windowBytes += value.byteLength
        lastProgressAt = this.now()
        if (!initialized) {
          initialized = true
          this.options.onLifecycleEvent?.('download-started', `${received}/${total ?? 'unknown'}`)
        }
        const elapsed = Math.max(1, this.now() - windowStartedAt)
        if (elapsed >= 1_000) {
          this.emit('download-progress', progressSnapshot({
            transferred: received,
            total,
            bytesPerSecond: (windowBytes * 1_000) / elapsed,
            resumed,
          }))
          windowBytes = 0
          windowStartedAt = this.now()
        }
      }
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve())
        stream.once('error', reject)
      })
      this.emit('download-progress', progressSnapshot({ transferred: received, total, resumed }))
    } finally {
      clearInterval(watchdog)
      this.endRequest(controller)
    }

    if (manifest.size && statSync(partPath).size !== manifest.size) {
      throw new Error(`The update archive is ${statSync(partPath).size} bytes, expected ${manifest.size}.`)
    }
    if (manifest.sha512) {
      const actual = await sha512Base64(partPath)
      if (actual !== manifest.sha512) {
        rmSync(partPath, { force: true })
        throw new Error('The downloaded update did not match its published checksum.')
      }
    }
    renameSync(partPath, archivePath)
    this.options.onLifecycleEvent?.('download-verified', path.basename(archivePath))
    return archivePath
  }
  private async stage(manifest: SelfUpdateManifest, archivePath: string): Promise<StagedUpdate> {
    const stageDir = path.join(this.options.updatesDir, `staged-${manifest.version}`)
    rmSync(stageDir, { recursive: true, force: true })
    mkdirSync(stageDir, { recursive: true })
    await this.runCommand('/usr/bin/ditto', ['-x', '-k', archivePath, stageDir])

    const bundleName = readdirSync(stageDir).find((entry) => entry.endsWith('.app'))
    if (!bundleName) throw new Error('The update archive does not contain an application bundle.')
    const appPath = path.join(stageDir, bundleName)

    const infoPlist = path.join(appPath, 'Contents', 'Info.plist')
    if (!existsSync(infoPlist)) throw new Error('The update archive is missing Contents/Info.plist.')
    const bundleVersion = normalizeVersion(await this.runCommand('/usr/bin/plutil', [
      '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist,
    ]))
    if (compareDesktopVersions(bundleVersion, manifest.version) !== 0) {
      throw new Error(`The update archive contains version ${bundleVersion || 'unknown'}, expected ${manifest.version}.`)
    }
    await this.verifySignature(appPath, Boolean(manifest.sha512))
    this.options.onLifecycleEvent?.('update-staged', manifest.version)
    return { version: manifest.version, archivePath, appPath }
  }

  /**
   * An ad-hoc signature proves nothing about authorship, so a verified archive
   * checksum is the real gate whenever the manifest carries one. Without a
   * checksum the bundle signature is the only structural evidence available and
   * therefore has to be enforced.
   */
  private async verifySignature(appPath: string, checksumVerified: boolean): Promise<void> {
    try {
      await this.runCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
      this.options.onLifecycleEvent?.('signature-verified', path.basename(appPath))
    } catch (error) {
      if (!checksumVerified) throw error
      this.options.onLifecycleEvent?.('signature-ignored', describeError(error))
    }
  }

  private beginRequest(): AbortController {
    this.abort?.abort()
    const controller = new AbortController()
    this.abort = controller
    return controller
  }

  private endRequest(controller: AbortController): void {
    if (this.abort === controller) this.abort = undefined
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

function progressSnapshot({
  transferred,
  total,
  bytesPerSecond,
  resumed,
}: {
  transferred: number
  total?: number
  bytesPerSecond?: number
  resumed: boolean
}): SelfUpdateProgress {
  return {
    transferred,
    ...(total ? { total, percent: Math.min(100, (transferred / total) * 100) } : {}),
    ...(bytesPerSecond ? { bytesPerSecond } : {}),
    resumed,
  }
}

/** A running app cannot replace itself: ad-hoc installs are one directory move. */
export function describeInstallBlocker(appPath: string): string | undefined {
  if (appPath.includes('/AppTranslocation/')) {
    return 'Xpod is running from a read-only translocated copy. Move Xpod into Applications and update again.'
  }
  try {
    accessSync(path.dirname(appPath), fsConstants.W_OK)
  } catch {
    return `Xpod cannot replace ${appPath} with the current user's permissions. Install the downloaded update manually.`
  }
  return undefined
}

function parseJsonManifest(body: string, manifestUrl: string): SelfUpdateManifest | undefined {
  if (!body.startsWith('{')) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object') return undefined
  const candidate = payload as { version?: unknown; name?: unknown; url?: unknown; sha512?: unknown; size?: unknown }
  const version = typeof candidate.version === 'string' && isVersionLike(candidate.version)
    ? normalizeVersion(candidate.version)
    : typeof candidate.name === 'string' && isVersionLike(candidate.name)
      ? normalizeVersion(candidate.name)
      : undefined
  if (!version) return undefined
  if (typeof candidate.url !== 'string' || !candidate.url.trim()) return undefined
  const sha512 = typeof candidate.sha512 === 'string' && isBase64Sha512(candidate.sha512) ? candidate.sha512 : undefined
  const size = typeof candidate.size === 'number' && Number.isFinite(candidate.size) && candidate.size > 0
    ? candidate.size
    : undefined
  return {
    version,
    url: resolveArchiveUrl(candidate.url, manifestUrl),
    ...(sha512 ? { sha512 } : {}),
    ...(size ? { size } : {}),
  }
}

/**
 * Read the flat `key: value` shape electron-builder writes, keeping the first
 * entry of the `files:` list as `files.0.<field>`. Deliberately not a general
 * YAML parser: the manifest is machine-generated with a fixed layout.
 */
function parseYamlFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let listKey: string | undefined
  let listIndex = -1
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const listItem = line.match(/^\s*-\s*([A-Za-z0-9_]+):\s*(.*)$/u)
    if (listItem) {
      listIndex += 1
      fields[`${listKey ?? 'files'}.${listIndex}.${listItem[1]}`] = unquoteYaml(listItem[2])
      continue
    }
    const entry = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/u)
    if (!entry) continue
    const [, key, value] = entry
    // Fields indented under a `- url:` item belong to that item.
    if (listKey && listIndex >= 0 && /^\s/u.test(line)) {
      fields[`${listKey}.${listIndex}.${key}`] = unquoteYaml(value)
      continue
    }
    if (!value.trim()) {
      listKey = key
      listIndex = -1
      continue
    }
    listKey = undefined
    listIndex = -1
    fields[key] = unquoteYaml(value)
  }
  return fields
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function archiveName(manifest: SelfUpdateManifest): string {
  const base = path.basename(new URL(manifest.url).pathname)
  return base && base !== '/' ? base : `Xpod-${manifest.version}-update.zip`
}

function resolveArchiveUrl(value: string, manifestUrl: string): string {
  try {
    return new URL(value, manifestUrl).toString()
  } catch {
    return value
  }
}

function versionParts(value: string): { numbers: number[]; prerelease: string[] } {
  const normalized = normalizeVersion(value)
  const [, core = '', prerelease = ''] = normalized.match(/^(\d+(?:\.\d+)*)(?:[-+](.*))?$/u) ?? []
  return {
    numbers: core.split('.').map((part) => Number(part) || 0),
    prerelease: prerelease.split('.').filter(Boolean),
  }
}

function isBase64Sha512(value: string): boolean {
  return /^[A-Za-z0-9+/]{86}==$/u.test(value.trim())
}

async function sha512Base64(filePath: string): Promise<string> {
  const hash = createHash('sha512')
  const stream = (await import('node:fs')).createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).replace(/\s+/gu, ' ').trim().slice(0, 300)
        reject(new Error(detail || `${path.basename(command)} failed`))
        return
      }
      resolve(String(stdout))
    })
  })
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/gu, ' ').trim().slice(0, 300)
}
