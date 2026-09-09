import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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

export interface RuntimeChild {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface RuntimeManagerOptions {
  targetOrigin: string
  fetchImpl?: typeof fetch
  resolveLaunch?: () => RuntimeLaunchCommand | undefined
  spawnImpl?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: 'ignore' }) => RuntimeChild
  pollIntervalMs?: number
  startupTimeoutMs?: number
}

export class RuntimeManager {
  private readonly fetchImpl: typeof fetch
  private readonly resolveLaunch: () => RuntimeLaunchCommand | undefined
  private readonly spawnImpl: NonNullable<RuntimeManagerOptions['spawnImpl']>
  private readonly pollIntervalMs: number
  private readonly startupTimeoutMs: number
  private current: RuntimeSnapshot = { state: 'stopped', ownership: 'none' }
  private child?: RuntimeChild
  private starting?: Promise<RuntimeSnapshot>

  public constructor(private readonly options: RuntimeManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.resolveLaunch = options.resolveLaunch ?? (() => resolveRuntimeLaunchCommand({
      env: process.env,
      resourcesPath: process.resourcesPath,
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

  public async ensureRunning(): Promise<RuntimeSnapshot> {
    if (this.current.state === 'running') return this.snapshot()
    if (this.starting) return this.starting
    if (await this.probe()) {
      this.current = { state: 'running', ownership: 'external' }
      return this.snapshot()
    }

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

  public async stopOwned(): Promise<void> {
    const child = this.child
    if (!child || this.current.ownership !== 'desktop') return
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
      const targetUrl = new URL(this.options.targetOrigin)
      const runtimePort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')
      const runtimeBaseUrl = `${targetUrl.origin}/`
      const child = this.spawnImpl(launch.command, launch.args, {
        env: {
          ...process.env,
          ...launch.env,
          CSS_BASE_URL: runtimeBaseUrl,
          XPOD_PORT: runtimePort,
        },
        stdio: 'ignore',
      })
      this.child = child
      this.current = { state: 'starting', ownership: 'desktop', pid: child.pid }
      const childFailure = new Promise<never>((_resolve, reject) => {
        child.once('error', (error) => {
          this.markChildFailure(error.message)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          if (this.child === child && this.current.state !== 'stopped') {
            const error = new Error(`Xpod runtime exited (${signal ?? code ?? 'unknown'})`)
            this.markChildFailure(error.message)
            reject(error)
          }
        })
      })
      await Promise.race([this.waitUntilReady(), childFailure])
      this.current = { state: 'running', ownership: 'desktop', pid: child.pid }
      return this.snapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.current = { state: 'failed', ownership: this.child ? 'desktop' : 'none', pid: this.child?.pid, error: message }
      throw error
    }
  }

  private markChildFailure(message: string): void {
    this.current = { state: 'failed', ownership: 'desktop', pid: this.child?.pid, error: message }
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
    const deadline = Date.now() + this.startupTimeoutMs
    while (Date.now() <= deadline) {
      if (await this.probe()) return
      await delay(this.pollIntervalMs)
    }
    throw new Error(`Xpod runtime did not become ready within ${this.startupTimeoutMs}ms`)
  }
}

export function resolveRuntimeLaunchCommand({
  env,
  resourcesPath,
  execPath = process.execPath,
  moduleDir,
  pathExists = existsSync,
  resolveBunCommand = resolveSystemBunCommand,
}: {
  env: NodeJS.ProcessEnv
  resourcesPath: string
  execPath?: string
  moduleDir?: string
  pathExists?: (value: string) => boolean
  resolveBunCommand?: () => string | undefined
}): RuntimeLaunchCommand | undefined {
  if (env.XPOD_RUNTIME_COMMAND) {
    return { command: env.XPOD_RUNTIME_COMMAND, args: ['start', '--foreground'] }
  }
  const packagedBinary = path.join(resourcesPath, 'runtime', 'xpod')
  if (pathExists(packagedBinary)) {
    const qleverRuntime = path.join(resourcesPath, 'runtime', 'qlever', 'bin', 'xpod_qlever_local_runtime')
    if (!pathExists(qleverRuntime)) return undefined
    return {
      command: packagedBinary,
      args: ['start', '--foreground'],
      env: { XPOD_QLEVER_LOCAL_RUNTIME_COMMAND: qleverRuntime },
    }
  }
  const packagedCli = path.join(resourcesPath, 'runtime', 'bin', 'xpod.js')
  if (pathExists(packagedCli)) {
    const packagedBun = resolvePackagedBun(resourcesPath, pathExists)
    const bunCommand = packagedBun ?? resolveBunCommand()
    if (bunCommand) {
      return {
        command: bunCommand,
        args: [packagedCli, 'start', '--foreground'],
      }
    }
    return {
      command: execPath,
      args: [packagedCli, 'start', '--foreground'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  const localDesktopRuntime = moduleDir ? path.resolve(moduleDir, '..', 'runtime', 'xpod') : undefined
  if (localDesktopRuntime && pathExists(localDesktopRuntime)) {
    return { command: localDesktopRuntime, args: ['start', '--foreground'] }
  }
  return { command: 'xpod', args: ['start', '--foreground'] }
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
