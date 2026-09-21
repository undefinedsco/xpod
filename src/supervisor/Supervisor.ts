import { spawn, type ChildProcess } from 'node:child_process';
import kill from 'tree-kill';
import type { ServiceConfig, ServiceState, ServiceStatus, StatusChangeHandler } from './types';

const MAX_RESTARTS = 5;
const MAX_LOGS = 500;
/** Restart backoff: 2s, 4s, 8s, 16s, 32s, capped at 60s. */
const RESTART_BASE_DELAY_MS = 2_000;
const RESTART_MAX_DELAY_MS = 60_000;
/** A run that stays up this long counts as healthy and clears the failure streak. */
const HEALTHY_UPTIME_MS = 60_000;
/** Bounded tail of child output kept per service for crash diagnosis. */
const MAX_CHILD_OUTPUT_LINES = 20;

/**
 * Failures that cannot be fixed by retrying: the child's own runtime cannot resolve a module,
 * so every restart fails identically. Retrying only hides the breakage behind a healthy-looking
 * gateway, which is exactly how the audited instance stayed half-dead for hours (N20).
 */
const NON_RETRYABLE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /Cannot find package ['"][^'"]+['"]/u, reason: 'missing dependency (Cannot find package)' },
  { pattern: /Cannot find module ['"][^'"]+['"]/u, reason: 'missing module (Cannot find module)' },
  { pattern: /\bMODULE_NOT_FOUND\b/u, reason: 'missing module (MODULE_NOT_FOUND)' },
];

/** Mask credentials before child output is stored in supervisor state or served over HTTP. */
function redactSecrets(line: string): string {
  return line
    .replace(
      /([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/giu,
      (_match, key: string, separator: string) => `${key}${separator}***`,
    )
    .replace(/\b([Bb]earer)\s+[A-Za-z0-9\-._~+/=]{8,}/gu, '$1 ***');
}

export interface SupervisorLog {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export interface SupervisorOptions {
  handleProcessSignals?: boolean;
  /** Consecutive failed runs tolerated before giving up. */
  maxRestarts?: number;
  /** First restart delay; doubles per consecutive failure up to 60s. */
  restartBaseDelayMs?: number;
  /** Uptime that counts as a healthy run and resets the failure streak. */
  healthyUptimeMs?: number;
}

export class Supervisor {
  private processes: Map<string, ChildProcess> = new Map();
  private managedStops: Map<string, () => Promise<void>> = new Map();
  private states: Map<string, ServiceState> = new Map();
  private configs: Map<string, ServiceConfig> = new Map();
  private logs: SupervisorLog[] = [];
  private onStatusChange?: StatusChangeHandler;
  private isShuttingDown = false;
  private childOutput: Map<string, string[]> = new Map();
  private pendingRestarts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private intentionalStops: Set<string> = new Set();
  private readonly maxRestarts: number;
  private readonly restartBaseDelayMs: number;
  private readonly healthyUptimeMs: number;

  constructor(options: SupervisorOptions = {}) {
    this.maxRestarts = options.maxRestarts ?? MAX_RESTARTS;
    this.restartBaseDelayMs = options.restartBaseDelayMs ?? RESTART_BASE_DELAY_MS;
    this.healthyUptimeMs = options.healthyUptimeMs ?? HEALTHY_UPTIME_MS;

    if (options.handleProcessSignals === false) {
      return;
    }

    // 确保父进程退出时清理所有子进程
    process.on('exit', () => this.killAll());
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  private async shutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    console.log(`[Supervisor] Received ${signal}, stopping all services...`);
    await this.stopAll();
    process.exit(0);
  }

  private killAll(): void {
    // 同步杀掉所有子进程（用于 process.on('exit')）
    for (const [, child] of this.processes) {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // 进程可能已经退出
        }
      }
    }
  }

  public setStatusChangeHandler(handler: StatusChangeHandler): void {
    this.onStatusChange = handler;
  }

  public register(config: ServiceConfig): void {
    this.configs.set(config.name, config);
    this.states.set(config.name, {
      name: config.name,
      status: 'stopped',
      restartCount: 0,
    });
  }

  public registerManaged(name: string, stop?: () => Promise<void> | void): void {
    if (!this.states.has(name)) {
      this.states.set(name, {
        name,
        status: 'stopped',
        restartCount: 0,
      });
    }

    if (stop) {
      this.managedStops.set(name, async() => {
        await stop();
      });
    }
  }

  public setStatus(name: string, status: ServiceStatus, extra?: Partial<ServiceState>): void {
    if (!this.states.has(name)) {
      this.registerManaged(name);
    }

    this.updateState(name, {
      status,
      ...extra,
    });
  }

  public addLog(source: string, level: SupervisorLog['level'], message: string): void {
    this.logs.push({
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
    });

    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
  }

  public getLogs(filters?: {
    level?: string;
    source?: string;
    limit?: number;
  }): SupervisorLog[] {
    let rows = this.logs;

    if (filters?.level) {
      rows = rows.filter((item) => item.level === filters.level);
    }
    if (filters?.source) {
      rows = rows.filter((item) => item.source === filters.source);
    }

    const limit = filters?.limit;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return rows.slice(-limit);
    }

    return rows;
  }

  public async startAll(): Promise<void> {
    for (const name of this.configs.keys()) {
      this.start(name);
    }
  }

  public async stopAll(): Promise<void> {
    this.isShuttingDown = true;
    for (const [ name, timer ] of this.pendingRestarts) {
      clearTimeout(timer);
      this.pendingRestarts.delete(name);
    }
    const promises: Promise<void>[] = [];
    for (const name of this.processes.keys()) {
      promises.push(this.stop(name));
    }
    for (const [ name, stop ] of this.managedStops) {
      promises.push(stop().catch((error) => {
        this.addLog(name, 'error', `Failed to stop managed service: ${String(error)}`);
      }));
    }
    await Promise.all(promises);
  }

  public start(name: string): void {
    const config = this.configs.get(name);
    const state = this.states.get(name);
    if (!config || !state) return;

    if (state.status === 'running' || state.status === 'starting') return;

    const pendingRestart = this.pendingRestarts.get(name);
    if (pendingRestart) {
      clearTimeout(pendingRestart);
      this.pendingRestarts.delete(name);
    }
    this.intentionalStops.delete(name);
    this.childOutput.set(name, []);

    console.log(`[Supervisor] Starting ${name}...`);
    this.addLog(name, 'info', 'Service starting');
    this.updateState(name, { status: 'starting', startTime: Date.now(), givenUpReason: undefined });

    const env = config.env ?? process.env;

    const child = spawn(config.command, config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: config.cwd || process.cwd(),
      detached: false,
    });

    this.processes.set(name, child);
    this.updateState(name, { status: 'running', pid: child.pid });

    const recordOutput = (line: string): void => {
      const tail = this.childOutput.get(name);
      if (!tail) {
        return;
      }
      tail.push(line);
      if (tail.length > MAX_CHILD_OUTPUT_LINES) {
        tail.splice(0, tail.length - MAX_CHILD_OUTPUT_LINES);
      }
    };

    const prefixLog = (source: string, data: Buffer, isError = false): void => {
      const output = data.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        // Redact once, at the single point where child output enters supervisor state:
        // the console, the log ring buffer (served by /service/logs) and the retained
        // crash tail must not disagree about what the child printed.
        const text = redactSecrets(trimmed);
        recordOutput(text);

        if (isError) {
          console.error(`[${source}] ${text}`);
          this.addLog(source, 'error', text);
        } else {
          console.log(`[${source}] ${text}`);
          this.addLog(source, 'info', text);
        }
      }
    };

    child.stdout?.on('data', (data) => {
      prefixLog(name, data, false);
    });

    child.stderr?.on('data', (data) => {
      prefixLog(name, data, true);
    });

    child.on('error', (err) => {
      console.error(`[Supervisor] Error spawning ${name}:`, err);
      this.addLog(name, 'error', `Spawn error: ${String(err)}`);
      this.updateState(name, { status: 'crashed', givenUpReason: `Spawn error: ${String(err)}` });
    });

    child.on('exit', (code, signal) => {
      const exitedAt = Date.now();
      const stateBeforeExit = this.states.get(name);
      const uptimeMs = stateBeforeExit?.startTime ? exitedAt - stateBeforeExit.startTime : 0;
      const wasManualStop = stateBeforeExit?.status === 'stopped' || this.intentionalStops.has(name);
      const wasHealthy = uptimeMs >= this.healthyUptimeMs;
      const consecutiveFailures = wasHealthy ? 0 : (stateBeforeExit?.consecutiveFailures ?? 0) + 1;
      const outputTail = this.childOutput.get(name) ?? [];
      const nonRetryable = NON_RETRYABLE_PATTERNS.find(({ pattern }) =>
        outputTail.some((line) => pattern.test(line)));

      console.log(`[Supervisor] ${name} exited with code ${code} signal ${signal}`);
      this.addLog(name, code === 0 ? 'info' : 'error', `Exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`);

      this.processes.delete(name);
      this.childOutput.delete(name);
      this.intentionalStops.delete(name);

      this.updateState(name, {
        status: 'stopped',
        lastExitCode: code ?? undefined,
        lastExitAt: exitedAt,
        lastOutput: outputTail,
        consecutiveFailures,
        pid: undefined,
      });

      // Auto-restart on crash (not on clean exit, manual stop or shutdown)
      if (code === 0 || wasManualStop || this.isShuttingDown) {
        return;
      }

      if (nonRetryable) {
        this.giveUp(name, `Unrecoverable child failure: ${nonRetryable.reason}; restart suppressed`, consecutiveFailures);
        return;
      }

      if (consecutiveFailures > this.maxRestarts) {
        this.giveUp(
          name,
          `Exceeded max restarts (budget ${this.maxRestarts}, ${consecutiveFailures} consecutive failures)`,
          consecutiveFailures,
        );
        return;
      }

      const delay = Math.min(
        this.restartBaseDelayMs * 2 ** (consecutiveFailures - 1),
        RESTART_MAX_DELAY_MS,
      );
      this.updateState(name, { restartCount: (stateBeforeExit?.restartCount ?? 0) + 1 });
      const attempt = `(${consecutiveFailures}/${this.maxRestarts} consecutive failures)`;
      console.log(`[Supervisor] Restarting ${name} in ${delay}ms... ${attempt}`);
      this.addLog(name, 'warn', `Restarting in ${Math.round(delay / 1000)}s ${attempt}`);

      const timer = setTimeout(() => {
        this.pendingRestarts.delete(name);
        this.start(name);
      }, delay);
      this.pendingRestarts.set(name, timer);
    });
  }

  /**
   * Stop restarting a service and say why. The gateway must not keep advertising itself as
   * healthy afterwards: readiness derives from supervised state, not from HTTP reachability.
   */
  private giveUp(name: string, reason: string, consecutiveFailures: number): void {
    console.error(`[Supervisor] ${name}: ${reason}`);
    this.addLog(name, 'error', `Giving up on ${name}: ${reason}`);
    this.updateState(name, { status: 'given-up', givenUpReason: reason, consecutiveFailures });
  }

  /**
   * Readiness of the supervised set: every configured child must be running. Managed services
   * (for example the gateway itself) are lifecycle-owned elsewhere and are not required here.
   */
  public isReady(): boolean {
    for (const name of this.configs.keys()) {
      if (this.states.get(name)?.status !== 'running') {
        return false;
      }
    }
    return true;
  }

  public stop(name: string): Promise<void> {
    return new Promise((resolve) => {
      const pendingRestart = this.pendingRestarts.get(name);
      if (pendingRestart) {
        // A service waiting out its backoff is not running, but it is not stopped either:
        // cancel the timer so a stop request cannot be undone by a scheduled restart.
        clearTimeout(pendingRestart);
        this.pendingRestarts.delete(name);
      }

      const child = this.processes.get(name);
      if (!child || !child.pid) {
        if (this.states.has(name)) {
          this.updateState(name, { status: 'stopped', pid: undefined, givenUpReason: undefined });
        }
        resolve();
        return;
      }

      // Mark as stopped first to prevent auto-restart
      this.intentionalStops.add(name);
      this.updateState(name, { status: 'stopped' });
      this.addLog(name, 'info', 'Stopping service');

      kill(child.pid, 'SIGTERM', (err) => {
        if (err) {
          console.error(`[Supervisor] Failed to kill ${name}:`, err);
          this.addLog(name, 'error', `Failed to stop: ${String(err)}`);
        }
        resolve();
      });
    });
  }

  public async restart(name: string): Promise<boolean> {
    if (!this.configs.has(name)) {
      return false;
    }

    await this.stop(name);
    const deadline = Date.now() + 5_000;
    while (this.processes.has(name) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.processes.has(name)) {
      this.addLog(name, 'error', 'Timed out waiting for service to stop before restart');
      return false;
    }

    // An explicit restart follows a deliberate operator action: grant a fresh retry budget.
    this.updateState(name, { consecutiveFailures: 0, givenUpReason: undefined });
    this.addLog(name, 'info', 'Service restart requested');
    this.start(name);
    return true;
  }

  public getStatus(name: string): ServiceState | undefined {
    const state = this.states.get(name);
    if (state && state.status === 'running' && state.startTime) {
      return { ...state, uptime: Date.now() - state.startTime };
    }
    return state;
  }

  public getAllStatus(): ServiceState[] {
    return Array.from(this.states.values()).map((s) => {
      if (s.status === 'running' && s.startTime) {
        return { ...s, uptime: Date.now() - s.startTime };
      }
      return s;
    });
  }

  private updateState(name: string, update: Partial<ServiceState>): void {
    const state = this.states.get(name);
    if (state) {
      Object.assign(state, update);
      this.onStatusChange?.(name, { ...state });
    }
  }
}
