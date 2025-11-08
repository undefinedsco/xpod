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
}

export class FrpcProcessManager {
  private readonly logger = getLoggerFor(this);
  private readonly binaryPath: string;
  private readonly configPath: string;
  private readonly workingDirectory?: string;
  private readonly logPrefix: string;
  private readonly autoRestart: boolean;
  private process?: ChildProcessWithoutNullStreams;
  private currentSignature?: string;
  private restarting = false;

  public constructor(options: FrpcProcessManagerOptions) {
    this.binaryPath = options.binaryPath;
    this.configPath = options.configPath;
    this.workingDirectory = options.workingDirectory;
    this.logPrefix = options.logPrefix ?? '[frpc]';
    this.autoRestart = options.autoRestart ?? true;
  }

  public async applyConfig(config?: FrpTunnelRuntimeConfig, status?: string): Promise<void> {
    if (!config || !config.serverHost) {
      await this.stop();
      this.currentSignature = undefined;
      return;
    }
    // Keep tunnel active also in standby; only decide logging based on status
    const signature = JSON.stringify({ config, status });
    if (signature === this.currentSignature && this.process) {
      return;
    }
    await this.writeConfigFile(config);
    this.currentSignature = signature;
    await this.restart();
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

  private async restart(): Promise<void> {
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    try {
      await this.stop();
      await this.ensureDirectory(dirname(this.configPath));
      this.logger.info(`${this.logPrefix} 启动 frpc 进程`);
      const args = [ '-c', this.configPath ];
      const proc = spawn(this.binaryPath, args, {
        cwd: this.workingDirectory,
        stdio: 'pipe',
      });
      this.process = proc;
      proc.stdout.on('data', (data) => {
        this.logger.debug(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.stderr.on('data', (data) => {
        this.logger.warn(`${this.logPrefix} ${data.toString().trim()}`);
      });
      proc.once('exit', (code, signal) => {
        this.logger.info(`${this.logPrefix} 退出，code=${code ?? ''} signal=${signal ?? ''}`);
        this.process = undefined;
        if (this.autoRestart && this.currentSignature) {
          setTimeout(() => {
            void this.restart().catch((error) => {
              this.logger.error(`${this.logPrefix} 重启失败: ${error instanceof Error ? error.message : String(error)}`);
            });
          }, 1_000);
        }
      });
      proc.once('error', (error) => {
        this.logger.error(`${this.logPrefix} 启动失败: ${(error as Error).message}`);
        this.process = undefined;
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
}
