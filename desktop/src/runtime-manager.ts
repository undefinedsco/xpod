import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, renameSync, unlinkSync, writeSync,
  constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'failed'
export type RuntimeOwnership = 'none' | 'external' | 'desktop'

export interface RuntimeSnapshot {
  state: RuntimeState
  ownership: RuntimeOwnership
  pid?: number
  error?: string
}

export interface RuntimeLaunchCommand {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** Read-only view of a child stream; only `data` is ever subscribed. */
export interface RuntimeDiagnosticStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown
}

export interface RuntimeChild {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  /** Present only when the acceptance diagnostic pipe is enabled. */
  stdout?: RuntimeDiagnosticStream | null
  stderr?: RuntimeDiagnosticStream | null
}

/**
 * Closed failure classes for the managed child. The child's own text is never
 * retained: only this enum may leave the process.
 */
export type RuntimeChildErrorClass =
  | 'enoent' | 'eacces' | 'eaddrinuse' | 'module-not-found' | 'config-invalid'
  | 'sqlite' | 'unknown'

/** Bounded, closed-shape startup observation. No path, argv, URL, env or message. */
export interface RuntimeStartupDiagnostic {
  schemaVersion: 1
  /** Monotonic per-process emission sequence (1-based). */
  sequence: number
  /** Wall-clock ms AT EMISSION. A later reader must treat this as the emission
   * instant, never as a re-observation of the manager at read time. */
  emittedAtMs: number
  event: 'spawned' | 'spawn-error' | 'exited' | 'ready' | 'failed'
  managerState: RuntimeState
  ownership: RuntimeOwnership
  childSeen: boolean
  pidPresent: boolean
  exitCode?: number
  signal?: string
  errorClass?: RuntimeChildErrorClass
  outputClass?: RuntimeChildErrorClass
}

export const STARTUP_DIAGNOSTIC_FILE = 'startup-diagnostics.json'
const STARTUP_DIAGNOSTIC_KEYS = ['schemaVersion', 'sequence', 'emittedAtMs', 'event', 'managerState',
  'ownership', 'childSeen', 'pidPresent', 'exitCode', 'signal', 'errorClass', 'outputClass'] as const
const STARTUP_EVENTS = new Set(['spawned', 'spawn-error', 'exited', 'ready', 'failed'])
const RUNTIME_STATES = new Set(['stopped', 'starting', 'running', 'failed'])
const RUNTIME_OWNERSHIPS = new Set(['none', 'external', 'desktop'])
const CHILD_ERROR_CLASSES = new Set(['enoent', 'eacces', 'eaddrinuse', 'module-not-found',
  'config-invalid', 'sqlite', 'unknown'])
/** Fixed signal vocabulary. An unknown signal is dropped, never forwarded. */
const SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGABRT',
  'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2', 'SIGCHLD'])

/** Project an arbitrary value down to the closed diagnostic shape. */
export function sanitizeStartupDiagnostic(value: unknown): RuntimeStartupDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !(STARTUP_DIAGNOSTIC_KEYS as readonly string[]).includes(key))) return undefined
  if (row.schemaVersion !== 1
    || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1
    || !Number.isSafeInteger(row.emittedAtMs) || (row.emittedAtMs as number) < 0
    || typeof row.event !== 'string' || !STARTUP_EVENTS.has(row.event)
    || typeof row.managerState !== 'string' || !RUNTIME_STATES.has(row.managerState)
    || typeof row.ownership !== 'string' || !RUNTIME_OWNERSHIPS.has(row.ownership)
    || typeof row.childSeen !== 'boolean' || typeof row.pidPresent !== 'boolean') return undefined
  const out: RuntimeStartupDiagnostic = {
    schemaVersion: 1,
    sequence: row.sequence as number,
    emittedAtMs: row.emittedAtMs as number,
    event: row.event as RuntimeStartupDiagnostic['event'],
    managerState: row.managerState as RuntimeState,
    ownership: row.ownership as RuntimeOwnership,
    childSeen: row.childSeen,
    pidPresent: row.pidPresent,
  }
  if (row.exitCode !== undefined) {
    if (!Number.isInteger(row.exitCode) || (row.exitCode as number) < 0 || (row.exitCode as number) > 255) return undefined
    out.exitCode = row.exitCode as number
  }
  if (row.signal !== undefined) {
    if (typeof row.signal !== 'string' || !SIGNALS.has(row.signal)) return undefined
    out.signal = row.signal
  }
  for (const key of ['errorClass', 'outputClass'] as const) {
    const candidate = row[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string' || !CHILD_ERROR_CLASSES.has(candidate)) return undefined
    out[key] = candidate as RuntimeChildErrorClass
  }
  return Object.freeze(out)
}

/** Upper bound of child text inspected for a class. Only the tail is kept. */
export const CHILD_DIAGNOSTIC_TAIL_CHARS = 8_192
const OUTPUT_CLASSES: readonly [RuntimeChildErrorClass, RegExp][] = [
  ['eaddrinuse', /EADDRINUSE|address already in use/iu],
  ['eacces', /EACCES|EPERM|permission denied/iu],
  ['enoent', /ENOENT|no such file or directory/iu],
  ['module-not-found', /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Cannot find package/iu],
  ['config-invalid', /Invalid configuration|Unknown configuration|Unexpected token.*JSON|config\w*\s+(?:is\s+)?invalid/iu],
  ['sqlite', /SQLITE_[A-Z]+|unable to open database|database is (?:busy|locked)/iu],
]

/** Classify one bounded text sample. Returns a fixed class, never the text. */
export function classifyRuntimeChildOutput(text: string): RuntimeChildErrorClass | undefined {
  for (const [name, pattern] of OUTPUT_CLASSES) {
    if (pattern.test(text)) return name
  }
  return undefined
}

/**
 * Accumulates only the last {@link CHILD_DIAGNOSTIC_TAIL_CHARS} characters so a
 * hostile/oversize stream can never grow memory or reach a public record.
 * `push` never throws and keeps draining after the first match.
 */
export function createChildOutputClassifier(): {
  push(chunk: unknown): void;
  result(): RuntimeChildErrorClass | undefined;
} {
  let tail = ''
  let found: RuntimeChildErrorClass | undefined
  return {
    push(chunk: unknown): void {
      if (found) return
      let text = ''
      if (typeof chunk === 'string') text = chunk
      else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString('utf8')
      if (!text) return
      tail = (tail + text).slice(-CHILD_DIAGNOSTIC_TAIL_CHARS)
      found = classifyRuntimeChildOutput(tail)
    },
    result: () => found,
  }
}

export type RuntimeStartupDiagnosticSink = (diagnostic: RuntimeStartupDiagnostic) => void

export interface RuntimeManagerOptions {
  targetOrigin: string
  packaged?: boolean
  fetchImpl?: typeof fetch
  resolveLaunch?: () => RuntimeLaunchCommand | undefined
  spawnImpl?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv;
    stdio: 'ignore' | ['ignore', 'pipe', 'pipe'] }) => RuntimeChild
  /**
   * Optional internal observation sink. Enabled ONLY by the packaged acceptance
   * entry point. It never changes lifecycle or readiness and its failures are
   * swallowed.
   */
  startupDiagnostics?: RuntimeStartupDiagnosticSink
  pollIntervalMs?: number
  startupTimeoutMs?: number
  autoRestart?: boolean
  restartDelayMs?: number
  resolveEnvironment?: () => NodeJS.ProcessEnv
  /** Authoritative packaged resources root; defaults to process.resourcesPath. */
  resourcesPath?: string
  /** AUTHORITATIVE OWNED mutable data root (the desktop userData directory). */
  ownedDataRoot?: string
}

/**
 * The packaged module context handed to the CLI child.
 *
 * A packaged runtime without an owned root or a bundle seed must fail BEFORE any
 * child is spawned: returning an empty environment instead would make the CLI fall
 * back to `$HOME/.xpod/modules` or to a registry download.
 */
export function packagedModuleEnvironment(input: {
  packaged: boolean; ownedDataRoot?: string; resourcesPath?: string;
}): Record<string, string> {
  if (!input.packaged) return {};
  const owned = input.ownedDataRoot;
  if (!owned || !path.isAbsolute(owned)) throw new Error('Packaged runtime requires an absolute userData directory');
  if (!input.resourcesPath || !path.isAbsolute(input.resourcesPath)) {
    throw new Error('Packaged runtime requires the bundle resources directory');
  }
  return {
    XPOD_MODULES_ROOT: path.join(owned, 'modules'),
    XPOD_MODULES_SEED: path.join(input.resourcesPath, 'runtime', 'modules'),
    XPOD_MODULES_OFFLINE: '1',
  };
}

export class RuntimeManager {
  private readonly fetchImpl: typeof fetch
  private readonly resolveLaunch: () => RuntimeLaunchCommand | undefined
  /** The packaged resources root, so module staging uses the bundle's own tree. */
  private readonly resourcesPath: string
  /**
   * The OWNED mutable root (the desktop userData directory).
   *
   * `main.ts` passes the real `app.getPath('userData')`. The environment variable is
   * only the SAME value the acceptance entry point already sets through
   * `app.setPath`, so it is a fallback for that one path, never a second authority
   * and never a user-facing setting.
   */
  private ownedDataRoot(): string | undefined {
    const value = this.options.ownedDataRoot ?? process.env.XPOD_DESKTOP_USER_DATA_DIR;
    return value && path.isAbsolute(value) ? value : undefined;
  }

  /** The packaged module context, or {} for an unpackaged developer launch. */
  private packagedModuleEnvironment(): Record<string, string> {
    if (!this.options.packaged) return {};
    const ownedDataRoot = this.ownedDataRoot();
    return packagedModuleEnvironment({
      packaged: true,
      ...(ownedDataRoot === undefined ? {} : { ownedDataRoot }),
      resourcesPath: this.resourcesPath,
    });
  }
  private readonly spawnImpl: NonNullable<RuntimeManagerOptions['spawnImpl']>
  private readonly pollIntervalMs: number
  private readonly startupTimeoutMs: number
  private current: RuntimeSnapshot = { state: 'stopped', ownership: 'none' }
  private child?: RuntimeChild
  private starting?: Promise<RuntimeSnapshot>
  private autoRestart: boolean
  private desiredRunning = false
  private restartTimer?: ReturnType<typeof setTimeout>
  private diagnosticSequence = 0

  public constructor(private readonly options: RuntimeManagerOptions) {
    this.autoRestart = options.autoRestart ?? false
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath ?? ''
    this.fetchImpl = options.fetchImpl ?? fetch
    this.resolveLaunch = options.resolveLaunch ?? (() => resolveRuntimeLaunchCommand({
      env: process.env,
      packaged: options.packaged,
      resourcesPath: this.resourcesPath,
      execPath: process.execPath,
      moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    }))
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as ChildProcess)
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    // First extraction plus Components.js discovery can exceed 30 seconds on
    // a cold desktop install, especially while optional catalog probes time out.
    this.startupTimeoutMs = options.startupTimeoutMs ?? 60_000
  }

  public snapshot(): RuntimeSnapshot {
    return { ...this.current }
  }

  public setAutoRestart(enabled: boolean): void {
    this.autoRestart = enabled
    if (!enabled && this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
  }

  public async ensureRunning(): Promise<RuntimeSnapshot> {
    this.desiredRunning = true
    if (this.current.state === 'running') return this.snapshot()
    if (this.starting) return this.starting
    if (await this.probe()) {
      this.current = { state: 'running', ownership: 'external' }
      return this.snapshot()
    }

    if (!this.desiredRunning) return this.snapshot()
    const launch = this.resolveLaunch()
    if (!launch) {
      const message = 'Xpod runtime is not installed. Install the xpod CLI or set XPOD_RUNTIME_COMMAND.'
      this.current = { state: 'failed', ownership: 'none', error: message }
      throw new Error(message)
    }

    this.current = { state: 'starting', ownership: 'desktop' }
    this.starting = this.launchAndWait(launch).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  public async restart(): Promise<RuntimeSnapshot> {
    if (this.current.ownership === 'desktop') {
      await this.stopOwned()
      return this.ensureRunning()
    }
    const response = await this.fetchImpl(new URL('/api/admin/restart', this.options.targetOrigin), { method: 'POST' })
    if (!response.ok) throw new Error(`Runtime restart failed with HTTP ${response.status}`)
    this.current = { state: 'starting', ownership: 'external' }
    await this.waitUntilReady()
    this.current = { state: 'running', ownership: 'external' }
    return this.snapshot()
  }

  /**
   * Reports whether the gateway currently answers its readiness probes.
   * Never spawns or restarts anything.
   */
  public isReachable(): Promise<boolean> {
    return this.probe()
  }

  /**
   * Waits for the gateway to answer its readiness probes without spawning.
   *
   * A cold start can outlive the launch timeout while the retained window is
   * already loading, so window recovery must be able to wait for the runtime
   * that is still coming up instead of launching a second one that would then
   * fight it for the port.
   */
  public async waitUntilReachable(timeoutMs = this.startupTimeoutMs): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if (await this.probe()) return true
      await delay(this.pollIntervalMs)
    }
    return false
  }

  public async stopOwned(): Promise<void> {
    this.desiredRunning = false
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
    const child = this.child
    if (this.current.ownership !== 'desktop') return
    if (!child) { this.current = { state: 'stopped', ownership: 'none' }; return }
    this.current = { state: 'stopped', ownership: 'desktop', pid: child.pid }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill('SIGTERM')
    })
    this.child = undefined
    this.current = { state: 'stopped', ownership: 'none' }
  }

  private async launchAndWait(launch: RuntimeLaunchCommand): Promise<RuntimeSnapshot> {
    try {
      // Resolved before anything is spawned so a packaged context problem is fatal
      // rather than a silently degraded (HOME or online) child.
      const packagedEnvironment = this.packagedModuleEnvironment()
      const targetUrl = new URL(this.options.targetOrigin)
      const runtimePort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')
      const runtimeBaseUrl = `${targetUrl.origin}/`
      const runtimeEnvironment = {
          ...process.env,
          ...launch.env,
          ...this.options.resolveEnvironment?.(),
          CSS_BASE_URL: runtimeBaseUrl,
          XPOD_PORT: runtimePort,
          // A packaged desktop seeds capabilities from the READ-ONLY bundle into
          // an OWNED mutable store under its userData directory. The installed
          // bundle stays immutable (its modules are only ever read), lifecycle
          // locks live in the owned store, and nothing touches the real HOME.
          // Throws (before spawn) when the packaged context is incomplete.
          ...packagedEnvironment,
      }
      const diagnosticStreams = this.options.startupDiagnostics !== undefined
      const child = this.spawnImpl(launch.command, desktopRuntimeArguments(launch.args, this.options.targetOrigin, runtimeEnvironment), {
        env: runtimeEnvironment,
        // Acceptance-only: pipe and fully drain so a bounded classifier can name
        // the failure CLASS. Normal launches keep the historical ignored stdio.
        stdio: diagnosticStreams ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      })
      this.child = child
      this.current = { state: 'starting', ownership: 'desktop', pid: child.pid }
      const output = createChildOutputClassifier()
      if (diagnosticStreams) {
        for (const stream of [child.stdout, child.stderr]) {
          if (!stream || typeof stream.on !== 'function') continue
          try { stream.on('data', (chunk: unknown) => { try { output.push(chunk) } catch { /* keep draining */ } }) }
          catch { /* an unreadable stream must not fail startup */ }
        }
      }
      this.emitStartupDiagnostic('spawned')
      const childFailure = new Promise<never>((_resolve, reject) => {
        child.once('error', (error) => {
          this.markChildFailure(error.message)
          this.emitStartupDiagnostic('spawn-error', {
            ...(readErrorCode(error) === 'ENOENT' ? { errorClass: 'enoent' as const } : {}),
            ...(readErrorCode(error) === 'EACCES' ? { errorClass: 'eacces' as const } : {}),
            ...(output.result() ? { outputClass: output.result()! } : {}),
          })
          reject(error)
        })
        child.once('exit', (code, signal) => {
          if (this.child === child) {
            if (!this.desiredRunning || this.current.state === 'stopped') { reject(new Error('Runtime stopped')); return }
            const shouldRestart = this.current.state === 'running' && this.desiredRunning && this.autoRestart
            const error = new Error(`Xpod runtime exited (${signal ?? code ?? 'unknown'})`)
            this.markChildFailure(error.message)
            this.child = undefined
            try {
              this.emitStartupDiagnostic('exited', {
                ...(typeof code === 'number' ? { exitCode: code } : {}),
                ...(signal ? { signal } : {}),
                ...(output.result() ? { outputClass: output.result()! } : {}),
              })
            } catch { /* observation must never change lifecycle */ }
            if (shouldRestart) this.scheduleRestart()
            reject(error)
          }
        })
      })
      await Promise.race([this.waitUntilReady(), childFailure])
      if (this.child !== child || !this.desiredRunning) return this.snapshot()
      this.current = { state: 'running', ownership: 'desktop', pid: child.pid }
      this.emitStartupDiagnostic('ready')
      return this.snapshot()
    } catch (error) {
      if (!this.desiredRunning) return this.snapshot()
      const message = error instanceof Error ? error.message : String(error)
      this.current = { state: 'failed', ownership: this.child ? 'desktop' : 'none', pid: this.child?.pid, error: message }
      this.emitStartupDiagnostic('failed')
      throw error
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.autoRestart && this.desiredRunning) void this.ensureRunning().catch(() => undefined)
    }, this.options.restartDelayMs ?? 1_000)
    this.restartTimer.unref?.()
  }

  private markChildFailure(message: string): void {
    this.current = { state: 'failed', ownership: 'desktop', pid: this.child?.pid, error: message }
  }

  /**
   * Emit ONE bounded observation to the acceptance-only sink.
   *
   * Never changes state, readiness or the thrown error: a throwing sink and an
   * unsanitizable frame are both swallowed. No path/argv/env/message is passed.
   */
  private emitStartupDiagnostic(event: RuntimeStartupDiagnostic['event'],
    extra: Partial<Pick<RuntimeStartupDiagnostic, 'exitCode' | 'signal' | 'errorClass' | 'outputClass'>> = {}): void {
    const sink = this.options.startupDiagnostics
    if (!sink) return
    try {
      this.diagnosticSequence += 1
      const frame = sanitizeStartupDiagnostic({
        schemaVersion: 1,
        sequence: this.diagnosticSequence,
        emittedAtMs: Date.now(),
        event,
        managerState: this.current.state,
        ownership: this.current.ownership,
        childSeen: this.child !== undefined,
        pidPresent: Number.isSafeInteger(this.current.pid) && (this.current.pid ?? 0) > 0,
        ...extra,
      })
      if (frame) sink(frame)
    } catch { /* observation must never change lifecycle */ }
  }

  private async probe(): Promise<boolean> {
    try {
      const statusResponse = await this.fetchImpl(new URL('/service/status', this.options.targetOrigin), {
        signal: AbortSignal.timeout(1_500),
      })
      if (!statusResponse.ok) return false
      const services = await statusResponse.json() as unknown
      if (!hasRunningService(services, 'css') || !hasRunningService(services, 'api')) return false
      const shellResponse = await this.fetchImpl(new URL('/status/overview', this.options.targetOrigin), {
        signal: AbortSignal.timeout(1_500),
      })
      const accountResponse = await this.fetchImpl(new URL('/.account/', this.options.targetOrigin), {
        signal: AbortSignal.timeout(1_500),
      })
      return shellResponse.ok && accountResponse.ok
    } catch {
      return false
    }
  }

  private async waitUntilReady(): Promise<void> {
    if (!await this.waitUntilReachable()) {
      throw new Error(`Xpod runtime did not become ready within ${this.startupTimeoutMs}ms`)
    }
  }
}

export function resolveRuntimeLaunchCommand({
  env,
  packaged = false,
  resourcesPath,
  execPath = process.execPath,
  moduleDir,
  pathExists = existsSync,
  resolveBunCommand = resolveSystemBunCommand,
}: {
  env: NodeJS.ProcessEnv
  packaged?: boolean
  resourcesPath: string
  execPath?: string
  moduleDir?: string
  pathExists?: (value: string) => boolean
  resolveBunCommand?: () => string | undefined
}): RuntimeLaunchCommand | undefined {
  if (env.XPOD_RUNTIME_COMMAND) {
    return { command: env.XPOD_RUNTIME_COMMAND, args: ['start'] }
  }
  const packagedBinary = path.join(resourcesPath, 'runtime', 'xpod')
  if (!packaged && pathExists(packagedBinary)) {
    const qleverRuntime = path.join(resourcesPath, 'runtime', 'qlever', 'bin', 'xpod_qlever_local_runtime')
    if (!pathExists(qleverRuntime)) return undefined
    return {
      command: packagedBinary,
      args: ['start'],
      env: { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntime },
    }
  }
  const runtimeRoot = path.join(resourcesPath, 'runtime')
  const packagedCli = path.join(runtimeRoot, 'node_modules', '@undefineds.co', 'xpod-cli', 'dist', 'xpod.mjs')
  if (pathExists(packagedCli)) {
    const packagedBun = resolvePackagedBun(resourcesPath, pathExists)
    const bunCommand = packagedBun ?? (packaged ? undefined : resolveBunCommand())
    if (bunCommand) {
      return {
        command: bunCommand,
        args: [packagedCli, 'start'],
      }
    }
    const normalLauncher = path.join(runtimeRoot, 'node_modules', '@undefineds.co', 'xpod-cli', 'dist', 'bin', 'xpod')
    if (!packaged && pathExists(normalLauncher)) return { command: normalLauncher, args: ['start'] }
    return undefined
  }
  if (packaged) return undefined
  const localDesktopRuntime = moduleDir ? path.resolve(moduleDir, '..', 'runtime', 'xpod') : undefined
  if (localDesktopRuntime && pathExists(localDesktopRuntime)) {
    return { command: localDesktopRuntime, args: ['start'] }
  }
  return { command: 'xpod', args: ['start'] }
}

function resolvePackagedBun(
  resourcesPath: string,
  pathExists: (value: string) => boolean,
): string | undefined {
  const candidates = [
    path.join(resourcesPath, 'runtime', 'bin', 'bun'),
    path.join(resourcesPath, 'runtime', 'bun'),
  ]
  return candidates.find((candidate) => pathExists(candidate))
}

function resolveSystemBunCommand(): string | undefined {
  const result = spawnSync('bun', ['--no-env-file', '-e', 'process.stdout.write(process.execPath)'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

/**
 * Build the acceptance-only file sink for startup observations.
 *
 * The parent is verified to be a real, non-symlink directory owned by this uid,
 * so the write can never escape the owned userData root. The tmp file is opened
 * with O_EXCL|O_NOFOLLOW (a pre-existing symlink is removed as a LINK, never
 * followed) and the finished frame is renamed into place atomically at 0600.
 * Every failure is swallowed: observation must never change lifecycle.
 */
export function createStartupDiagnosticSink(options: {
  userDataRoot: string;
  /** Defaults to <userDataRoot>/startup-diagnostics.json. Must stay in the root. */
  file?: string;
}): RuntimeStartupDiagnosticSink {
  const root = path.resolve(options.userDataRoot)
  const file = path.resolve(options.file ?? path.join(root, STARTUP_DIAGNOSTIC_FILE))
  if (path.dirname(file) !== root) throw new Error('Startup diagnostics must stay in the owned userData root')
  const ownedDirectory = (): boolean => {
    try {
      const stat = lstatSync(root)
      const owner = process.getuid?.()
      return stat.isDirectory() && !stat.isSymbolicLink() && (owner === undefined || stat.uid === owner)
    } catch { return false }
  }
  return (diagnostic: RuntimeStartupDiagnostic): void => {
    try {
      if (!ownedDirectory()) return
      const frame = sanitizeStartupDiagnostic(diagnostic)
      if (!frame) return
      const pending = `${file}.tmp`
      // Remove only the LINK at the tmp path (unlink never follows it).
      try { unlinkSync(pending) } catch { /* absent is normal */ }
      const fd = openSync(pending,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
      try { writeSync(fd, `${JSON.stringify(frame)}\n`) } finally { closeSync(fd) }
      renameSync(pending, file)
    } catch { /* observation must never change lifecycle */ }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Read only the OS error code; the message itself is never retained here. */
function readErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : undefined
}

function hasRunningService(value: unknown, name: 'css' | 'api'): boolean {
  return Array.isArray(value) && value.some((item) =>
    typeof item === 'object' &&
    item !== null &&
    'name' in item &&
    'status' in item &&
    item.name === name &&
    item.status === 'running')
}

/** Translate desktop state to the public CLI start contract, without aliases. */
export function desktopRuntimeArguments(prefix: string[], targetOrigin: string, env: NodeJS.ProcessEnv): string[] {
  const target = new URL(targetOrigin)
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  const args = [...prefix, '--port', port, '--baseUrl', `${target.origin}/`]
  if (env.XPOD_EDITION) args.push('--mode', env.XPOD_EDITION)
  if (env.CSS_ROOT_FILE_PATH) args.push('--data', env.CSS_ROOT_FILE_PATH)
  return args
}
