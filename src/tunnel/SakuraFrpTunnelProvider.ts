/**
 * SakuraFRP Tunnel Provider
 *
 * 使用 SakuraFRP 提供隧道服务
 * 用于没有公网 IP 的 Local 节点
 *
 * 需要用户在 SakuraFRP 控制台创建隧道并获取 Token
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';

/**
 * SakuraFRP Tunnel Provider 配置
 */
export interface SakuraFrpTunnelProviderOptions {
  /** SakuraFRP Token (从环境变量 SAKURA_TOKEN 获取) */
  token: string;

  /** frpc 可执行文件路径 (默认 'frpc') */
  frpcPath?: string;

  /** SakuraFRP 服务端地址 (如果需要自定义) */
  serverAddr?: string;
}

/**
 * SakuraFRP Tunnel Provider
 *
 * 通过 frpc 客户端连接 SakuraFRP 服务
 */
export class SakuraFrpTunnelProvider implements TunnelProvider {
  public readonly name = 'sakura-frp';
  private readonly logger = getLoggerFor(this);

  private readonly token: string;
  private readonly frpcPath: string;
  private readonly serverAddr?: string;

  private process: ChildProcess | null = null;
  private status: TunnelStatus = {
    running: false,
    connected: false,
  };
  private currentConfig: TunnelConfig | null = null;
  private managedByUs = false;

  constructor(options: SakuraFrpTunnelProviderOptions) {
    this.token = options.token;
    this.frpcPath = options.frpcPath ?? 'frpc';
    this.serverAddr = options.serverAddr;
  }

  /**
   * Setup: 解析 Token 获取配置
   */
  async setup(_options: TunnelSetupOptions): Promise<TunnelConfig> {
    // SakuraFRP Token 格式通常包含隧道信息
    // 这里返回基本配置，实际配置由 frpc 从 Token 获取
    const config: TunnelConfig = {
      subdomain: 'sakura',
      provider: 'sakura-frp',
      endpoint: '',
      tunnelToken: this.token,
    };

    this.currentConfig = config;
    return config;
  }

  /**
   * 启动 frpc 客户端
   */
  async start(config?: TunnelConfig): Promise<void> {
    const actualConfig = config ?? {
      subdomain: 'sakura',
      provider: 'sakura-frp' as const,
      endpoint: '',
      tunnelToken: this.token,
    };

    // 检测是否已经在运行
    if (this.isFrpcRunning()) {
      this.logger.info('frpc already running externally');
      this.status = { running: true, connected: true };
      this.currentConfig = actualConfig;
      this.managedByUs = false;
      return;
    }

    if (this.process) {
      this.logger.info('Already running (managed by us)');
      return;
    }

    const token = actualConfig.tunnelToken ?? this.token;
    if (!token) {
      throw new Error('SakuraFRP token is required');
    }

    this.logger.info('Starting SakuraFRP tunnel...');
    this.status = { running: true, connected: false };
    this.managedByUs = true;

    // SakuraFRP 使用 frpc 客户端
    // 命令格式: frpc -f <token>
    const args = ['-f', token];
    if (this.serverAddr) {
      args.push('-s', this.serverAddr);
    }

    this.process = spawn(this.frpcPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        this.logger.info(`[frpc] ${output}`);
        this.checkConnectionStatus(output);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        this.logger.warn(`[frpc] ${output}`);
        this.checkConnectionStatus(output);
      }
    });

    this.process.on('exit', (code) => {
      this.logger.info(`frpc exited with code ${code}`);
      this.status = { running: false, connected: false };
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      this.logger.error(`Failed to start frpc: ${error.message}`);
      this.status = { running: false, connected: false, error: error.message };
      this.process = null;
      this.managedByUs = false;
    });

    this.currentConfig = actualConfig;

    // 等待连接
    await this.waitForConnection();
  }

  private checkConnectionStatus(output: string): void {
    // 检测连接成功的关键字
    if (
      output.includes('start proxy success') ||
      output.includes('login to server success') ||
      output.includes('tunnel running')
    ) {
      this.status.connected = true;
      this.status.lastHeartbeat = new Date();
      this.logger.info('SakuraFRP tunnel connected');
    }

    // 检测错误
    if (output.includes('error') || output.includes('failed')) {
      this.status.error = output;
    }
  }

  /**
   * 停止隧道
   */
  async stop(): Promise<void> {
    if (!this.managedByUs) {
      this.logger.info('Not managed by us, skipping stop');
      this.status = { running: false, connected: false };
      return;
    }

    if (this.process) {
      this.logger.info('Stopping SakuraFRP tunnel...');
      this.process.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.logger.info('Force killing frpc...');
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.logger.info('SakuraFRP tunnel stopped');
    }

    this.status = { running: false, connected: false };
    this.managedByUs = false;
  }

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  getEndpoint(): string | undefined {
    return this.currentConfig?.endpoint;
  }

  async cleanup(_config: TunnelConfig): Promise<void> {
    await this.stop();
    this.currentConfig = null;
  }

  /**
   * 检测 frpc 是否已经在运行
   */
  private isFrpcRunning(): boolean {
    try {
      if (process.platform === 'win32') {
        execSync('tasklist /FI "IMAGENAME eq frpc.exe" | find "frpc"', {
          stdio: 'ignore',
        });
      } else {
        execSync('pgrep -x frpc', { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  private async waitForConnection(timeout = 30000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (this.status.connected) {
        return;
      }

      if (!this.status.running && this.status.error) {
        throw new Error(`SakuraFRP failed to start: ${this.status.error}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    this.logger.warn('Connection timeout, tunnel may still be connecting...');
  }

  isManagedByUs(): boolean {
    return this.managedByUs;
  }
}
