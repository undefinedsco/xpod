import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { getLoggerFor } from 'global-logger-factory';

interface FrpTunnelRuntimeConfig {
  serverHost: string;
  serverPort?: number;
  token?: string;
  protocol?: string;
  proxyName?: string;
  customDomains?: string[];
  remotePort?: number;
  entrypoint?: string;
  type?: string;
  [key: string]: unknown;
}

interface FrpcProcessManagerOptions {
  binaryPath: string;
  configPath: string;
  workingDirectory?: string;
  logPrefix?: string;
  autoRestart?: boolean;
  processFactory?: typeof spawn;
}

export interface FrpcRuntimeStatus {
  state: 'inactive' | 'starting' | 'running' | 'error';
  lastUpdated?: string;
  error?: string;
  entrypoint?: string;
  pid?: number;
  /** Restarts since the last healthy run, so a crash loop is visible instead of implied. */
  restartCount?: number;
  /** Delay before the next automatic restart, when one is scheduled. */
  nextRestartInMs?: number;
}

/**
 * frpc 崩溃后的重启退避（审计 N18）。
 *
 * 旧实现固定 1 秒重试：frpc 配置错误时会以每秒一次的节奏永远重启，日志与进程资源都被
 * 刷满，而且 `stop()` 不会取消已排定的那次重启——停掉的隧道会被自己排的重启复活。
 */
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 60_000;
/** 一次运行活过这个时长就算“健康”，重启计数清零。 */
const HEALTHY_UPTIME_MS = 60_000;
/** 隧道是兜底路径，退避到上限后继续重试，不放弃。 */
const CONFIG_FILE_MODE = 0o600;

export class FrpcProcessManager {
  private readonly logger = getLoggerFor(this);
  private readonly binaryPath: string;
  private readonly configPath: string;
  private readonly workingDirectory?: string;
  private readonly logPrefix: string;
  private readonly autoRestart: boolean;
  private readonly processFactory: typeof spawn;
  private process?: ChildProcessWithoutNullStreams;
  private currentSignature?: string;
  private restarting = false;
  private status: FrpcRuntimeStatus = { state: 'inactive' };
  private desiredRunning = false;
  private restartTimer?: NodeJS.Timeout;
  private consecutiveFailures = 0;
  private startedAt = 0;

  public constructor(options: FrpcProcessManagerOptions) {
    this.binaryPath = options.binaryPath;
    this.configPath = options.configPath;
    this.workingDirectory = options.workingDirectory;
    this.logPrefix = options.logPrefix ?? '[frpc]';
    this.autoRestart = options.autoRestart ?? true;
    this.processFactory = options.processFactory ?? spawn;
  }

  public async applyConfig(config?: FrpTunnelRuntimeConfig, status?: string, entrypoint?: string): Promise<void> {
    if (!config || !config.serverHost || status !== 'active') {
      this.desiredRunning = false;
      this.setStatus({ state: 'inactive', entrypoint, lastUpdated: new Date().toISOString() });
      await this.stop();
      this.currentSignature = undefined;
      return;
    }
    this.desiredRunning = true;
    const signature = JSON.stringify({ config });
    if (signature === this.currentSignature && this.process) {
      this.status.entrypoint = entrypoint ?? config.entrypoint;
      return;
    }
    await this.writeConfigFile(config);
    this.currentSignature = signature;
    this.setStatus({ state: 'starting', entrypoint: entrypoint ?? config.entrypoint, lastUpdated: new Date().toISOString() });
    await this.restart(entrypoint ?? config.entrypoint);
  }

  public async stop(): Promise<void> {
    // 取消已排定的自动重启：否则一次显式停止会被自己排的重启撤销（与 supervisor 同类缺陷）。
    this.cancelPendingRestart();
    // 显式停止才算“重新开始”，自动重启之间的失败计数必须保留，否则退避永远回到 1 秒。
    this.consecutiveFailures = 0;
    await this.stopProcess();
    if (this.status.state !== 'inactive') {
      this.setStatus({ state: 'inactive', lastUpdated: new Date().toISOString() });
    }
  }

  /**
   * 结束当前进程，但不碰重启计数与待重启定时器。
   *
   * 先把 `this.process` 置空：退出回调据此判断“这个进程已被替换”，不会为它再排一次重启，
   * 也不会把它的退出写成当前状态。
   */
  private async stopProcess(): Promise<void> {
    const proc = this.process;
    if (!proc) {
      return;
    }
    this.process = undefined;
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      proc.once('error', () => resolve());
      proc.kill();
      setTimeout(() => resolve(), 5_000);
    });
  }

  private async restart(entrypoint?: string): Promise<void> {
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    try {
      await this.stopProcess();
      await this.ensureDirectory(dirname(this.configPath));
      this.logger.info(`${this.logPrefix} 启动 frpc 进程`);
      const args = [ '-c', this.configPath ];
      const proc = this.processFactory(this.binaryPath, args, {
        cwd: this.workingDirectory,
        stdio: 'pipe',
      });
      this.process = proc;
      this.startedAt = Date.now();
      this.setStatus({
        state: 'running',
        entrypoint,
        lastUpdated: new Date().toISOString(),
        pid: proc.pid ?? undefined,
        restartCount: this.consecutiveFailures,
      });
      proc.stdout.on('data', (data) => {
        this.logger.debug(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.stderr.on('data', (data) => {
        this.logger.warn(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.once('exit', (code, signal) => {
        this.logger.info(`${this.logPrefix} 退出，code=${code ?? ''} signal=${signal ?? ''}`);
        if (this.process !== proc) {
          // 已被显式停止或替换：这次退出既不代表当前状态，也不该排重启。
          return;
        }
        this.process = undefined;
        // 一次活够久的运行说明配置没问题，重启计数清零；否则累加并指数退避。
        const uptimeMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
        this.consecutiveFailures = uptimeMs >= HEALTHY_UPTIME_MS ? 0 : this.consecutiveFailures + 1;
        const shouldRestart = this.autoRestart && Boolean(this.currentSignature) && this.desiredRunning;
        const delayMs = shouldRestart ? this.nextRestartDelayMs() : undefined;

        if (this.desiredRunning) {
          this.setStatus({
            state: 'error',
            error: `exit:${code ?? 'unknown'}`,
            lastUpdated: new Date().toISOString(),
            entrypoint,
            restartCount: this.consecutiveFailures,
            ...(delayMs === undefined ? {} : { nextRestartInMs: delayMs }),
          });
        } else {
          this.setStatus({
            state: 'inactive',
            lastUpdated: new Date().toISOString(),
          });
        }

        if (shouldRestart && delayMs !== undefined) {
          this.logger.warn(
            `${this.logPrefix} ${delayMs}ms 后重启（连续失败 ${this.consecutiveFailures} 次，上限 ${RESTART_MAX_DELAY_MS}ms）`,
          );
          this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            void this.restart(entrypoint).catch((error) => {
              this.logger.error(`${this.logPrefix} 重启失败: ${error instanceof Error ? error.message : String(error)}`);
            });
          }, delayMs);
        }
      });
      proc.once('error', (error) => {
        this.logger.error(`${this.logPrefix} 启动失败: ${(error as Error).message}`);
        this.process = undefined;
        this.setStatus({
          state: 'error',
          error: (error as Error).message,
          lastUpdated: new Date().toISOString(),
          entrypoint,
        });
      });
    } finally {
      this.restarting = false;
    }
  }

  private nextRestartDelayMs(): number {
    const exponent = Math.max(0, this.consecutiveFailures - 1);
    return Math.min(RESTART_BASE_DELAY_MS * 2 ** exponent, RESTART_MAX_DELAY_MS);
  }

  private cancelPendingRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!path || path === '.') {
      return;
    }
    await fs.mkdir(path, { recursive: true });
  }

  private async writeConfigFile(config: FrpTunnelRuntimeConfig): Promise<void> {
    const lines: string[] = [];
    lines.push('[common]');
    lines.push(`server_addr = ${config.serverHost}`);
    if (config.serverPort) {
      lines.push(`server_port = ${config.serverPort}`);
    }
    if (config.token) {
      lines.push(`token = ${config.token}`);
    }
    if (config.protocol && config.protocol !== 'tcp') {
      lines.push(`protocol = ${config.protocol}`);
    }
    lines.push('');

    const proxyName = config.proxyName ?? 'xpod-edge';
    lines.push(`[${proxyName}]`);
    const type = config.type ?? (config.customDomains && config.customDomains.length > 0 ? 'http' : (config.protocol ?? 'tcp'));
    lines.push(`type = ${type}`);
    if (config.customDomains && config.customDomains.length > 0) {
      lines.push(`custom_domains = ${config.customDomains.join(',')}`);
    }
    if (config.remotePort) {
      lines.push(`remote_port = ${config.remotePort}`);
    }
    if (config.entrypoint) {
      lines.push(`# public_url = ${config.entrypoint}`);
    }

    await this.ensureDirectory(dirname(this.configPath));
    // frpc 配置里有隧道 token：写 0600，并对已存在的旧文件再 chmod 一次（审计 N18）。
    await fs.writeFile(this.configPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: CONFIG_FILE_MODE });
    try {
      await fs.chmod(this.configPath, CONFIG_FILE_MODE);
    } catch (error: unknown) {
      this.logger.warn(`${this.logPrefix} 无法收紧配置文件权限: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public getStatus(): FrpcRuntimeStatus {
    return { ...this.status };
  }

  private setStatus(update: FrpcRuntimeStatus): void {
    this.status = {
      state: update.state,
      lastUpdated: update.lastUpdated,
      error: update.error,
      entrypoint: update.entrypoint,
      pid: update.pid,
      ...(update.restartCount === undefined ? {} : { restartCount: update.restartCount }),
      ...(update.nextRestartInMs === undefined ? {} : { nextRestartInMs: update.nextRestartInMs }),
    };
  }
}
