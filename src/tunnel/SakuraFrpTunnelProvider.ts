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
import { createTunnelStatus, describeSpawnError } from './TunnelLifecycle';
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
  /** SakuraFRP Token (从环境变量 SAKURA_TUNNEL_TOKEN 获取) */
  token: string;

  /** Active profile public endpoint, shown in status and DDNS diagnostics. */
  publicUrl?: string;

  /** frpc 可执行文件路径 (默认 'frpc') */
  frpcPath?: string;

  /** 等待代理发布的毫秒数；超时后状态为 failed */
  connectTimeoutMs?: number;

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
  private readonly publicUrl?: string;
  private readonly frpcPath: string;
  private readonly connectTimeoutMs: number;
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
    this.publicUrl = normalizePublicEndpoint(options.publicUrl);
    this.frpcPath = options.frpcPath ?? 'frpc';
    this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
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
      provider: 'sakura_frp',
      endpoint: this.publicUrl ?? '',
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
      provider: 'sakura_frp',
      endpoint: this.publicUrl ?? '',
      tunnelToken: this.token,
    };

    // A foreign frpc is not ours to adopt: another instance's tunnel would be reported as
    // this provider's readiness and its stop would kill a process we do not own.
    if (this.isFrpcRunning()) {
      this.logger.warn('Another frpc process is already running; refusing to take it over');
      this.status = createTunnelStatus('failed', {
        endpoint: this.publicUrl,
        error: 'frpc-already-running',
      });
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
    this.status = createTunnelStatus('process-started', { endpoint: this.publicUrl });
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
      this.status = createTunnelStatus('failed', {
        endpoint: this.publicUrl,
        error: this.status.error ?? (code === 0 ? 'frpc-exited' : `frpc exited with code ${code}`),
      });
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      const described = describeSpawnError('sakura-frp', this.frpcPath, error);
      this.logger.error(`Failed to start frpc: ${described}`);
      this.status = createTunnelStatus('failed', { endpoint: this.publicUrl, error: described });
      this.process = null;
      this.managedByUs = false;
    });

    this.currentConfig = actualConfig;

    // 等待连接
    await this.waitForConnection(this.connectTimeoutMs);
  }

  private checkConnectionStatus(output: string): void {
    const lower = output.toLowerCase();

    // 代理已发布才算就绪
    if (lower.includes('start proxy success') || lower.includes('tunnel running')) {
      this.status = createTunnelStatus('proxy-ready', {
        endpoint: this.publicUrl ?? this.status.endpoint,
        lastHeartbeat: new Date(),
        error: this.status.error,
      });
      this.logger.info('SakuraFRP tunnel connected');
    } else if (lower.includes('login to server success') && this.status.stage !== 'proxy-ready') {
      // 控制连接成功说明凭据可用，但代理还没起来
      this.status = createTunnelStatus('control-connected', {
        endpoint: this.publicUrl ?? this.status.endpoint,
        error: this.status.error,
      });
    }

    // 检测错误：代理启动失败必须撤销"已连接"
    if (lower.includes('start proxy error') || lower.includes('start error')) {
      this.status = createTunnelStatus('failed', {
        endpoint: this.publicUrl ?? this.status.endpoint,
        error: output,
      });
      return;
    }
    if (lower.includes('error') || lower.includes('failed')) {
      this.status = { ...this.status, error: output };
    }
  }

  /**
   * 停止隧道
   */
  async stop(): Promise<void> {
    if (!this.managedByUs) {
      this.logger.info('Not managed by us, skipping stop');
      this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
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

    this.status = createTunnelStatus('stopped', { endpoint: this.status.endpoint, error: this.status.error });
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

    // Timeout is a visible failure: frpc is running but no proxy was published.
    this.status = createTunnelStatus('failed', {
      endpoint: this.publicUrl ?? this.status.endpoint,
      error: this.status.error ?? 'frpc-connect-timeout',
    });
    this.logger.warn('frpc did not publish a proxy before the timeout');
    throw new Error('SakuraFRP connection timeout');
  }

  isManagedByUs(): boolean {
    return this.managedByUs;
  }
}

function normalizePublicEndpoint(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString().replace(/\/+$/u, '') + '/';
  } catch {
    return value.trim();
  }
}
