import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { getLoggerFor } from '@solid/community-server';

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
}

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
    if (!this.process) {
      return;
    }
    return new Promise((resolve) => {
      const proc = this.process;
      this.process = undefined;
      if (!proc) {
        resolve();
        return;
      }
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
      await this.stop();
      await this.ensureDirectory(dirname(this.configPath));
      this.logger.info(`${this.logPrefix} 启动 frpc 进程`);
      const args = [ '-c', this.configPath ];
      const proc = this.processFactory(this.binaryPath, args, {
        cwd: this.workingDirectory,
        stdio: 'pipe',
      });
      this.process = proc;
      this.setStatus({
        state: 'running',
        entrypoint,
        lastUpdated: new Date().toISOString(),
        pid: proc.pid ?? undefined,
      });
      proc.stdout.on('data', (data) => {
        this.logger.debug(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.stderr.on('data', (data) => {
        this.logger.warn(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.once('exit', (code, signal) => {
        this.logger.info(`${this.logPrefix} 退出，code=${code ?? ''} signal=${signal ?? ''}`);
        this.process = undefined;
        if (this.desiredRunning) {
          this.setStatus({
            state: 'error',
            error: `exit:${code ?? 'unknown'}`,
            lastUpdated: new Date().toISOString(),
            entrypoint,
          });
        } else {
          this.setStatus({
            state: 'inactive',
            lastUpdated: new Date().toISOString(),
          });
        }
        if (this.autoRestart && this.currentSignature && this.desiredRunning) {
          setTimeout(() => {
            void this.restart(entrypoint).catch((error) => {
              this.logger.error(`${this.logPrefix} 重启失败: ${error instanceof Error ? error.message : String(error)}`);
            });
          }, 1_000);
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
    await fs.writeFile(this.configPath, `${lines.join('\n')}\n`, 'utf8');
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
    };
  }
}
