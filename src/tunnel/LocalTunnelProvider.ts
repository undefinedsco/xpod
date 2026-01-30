import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';

/** cloudflared metrics 端口 */
const CLOUDFLARED_METRICS_PORT = 33863;

/**
 * Local Tunnel Provider 配置
 * 仅用于启动 cloudflared，不涉及 Cloudflare API 操作
 */
export interface LocalTunnelProviderOptions {
  /** Cloudflare Tunnel Token (从环境变量 CLOUDFLARE_TUNNEL_TOKEN 获取) */
  tunnelToken: string;

  /** cloudflared 可执行文件路径 (默认 'cloudflared') */
  cloudflaredPath?: string;
}

/**
 * Local Tunnel Provider
 * 
 * 专为 Local 模式设计的简化版 Tunnel Provider
 * 只负责启动 cloudflared，不涉及 Cloudflare API 操作（创建 Tunnel、DNS 记录等）
 * 
 * 使用场景：
 * - 用户已在 Cloudflare Dashboard 创建好 Tunnel
 * - 用户通过环境变量 CLOUDFLARE_TUNNEL_TOKEN 传入 Token
 * - 服务启动时自动启动 cloudflared
 */
export class LocalTunnelProvider implements TunnelProvider {
  public readonly name = 'cloudflare-local';
  private readonly logger = getLoggerFor(this);

  private readonly tunnelToken: string;
  private readonly cloudflaredPath: string;

  private process: ChildProcess | null = null;
  private status: TunnelStatus = {
    running: false,
    connected: false,
  };
  private currentConfig: TunnelConfig | null = null;
  /** 标记隧道进程是否由我们启动和管理 */
  private managedByUs = false;

  constructor(options: LocalTunnelProviderOptions) {
    this.tunnelToken = options.tunnelToken;
    this.cloudflaredPath = options.cloudflaredPath ?? 'cloudflared';
  }

  /**
   * Local 模式不需要 setup，直接返回基于 Token 的配置
   */
  async setup(_options: TunnelSetupOptions): Promise<TunnelConfig> {
    // Local 模式下，Tunnel 已在 Cloudflare Dashboard 创建
    // 只需要返回一个包含 Token 的配置
    const config: TunnelConfig = {
      subdomain: 'local', // 占位符，实际域名由 Cloudflare Tunnel 配置决定
      provider: 'cloudflare',
      endpoint: '', // 实际 endpoint 由 Cloudflare Tunnel 配置决定
      tunnelToken: this.tunnelToken,
    };

    this.currentConfig = config;
    return config;
  }

  /**
   * 启动隧道客户端
   * 如果 cloudflared 已经在运行，则跳过启动
   */
  async start(config?: TunnelConfig): Promise<void> {
    // 如果没有传入 config，使用默认配置
    const actualConfig = config ?? {
      subdomain: 'local',
      provider: 'cloudflare' as const,
      endpoint: '',
      tunnelToken: this.tunnelToken,
    };

    // 检测是否已经在运行
    const alreadyRunning = await this.isCloudflaredRunning();
    if (alreadyRunning) {
      this.logger.info('Already running externally, skipping start');
      this.status = { running: true, connected: true, endpoint: actualConfig.endpoint };
      this.currentConfig = actualConfig;
      this.managedByUs = false;
      return;
    }

    if (this.process) {
      this.logger.info('Already running (managed by us)');
      return;
    }

    const token = actualConfig.tunnelToken ?? this.tunnelToken;
    if (!token) {
      throw new Error('Tunnel token is required');
    }

    this.logger.info('Starting cloudflared tunnel...');
    this.status = { running: true, connected: false };
    this.managedByUs = true;

    this.process = spawn(this.cloudflaredPath, [
      'tunnel',
      '--protocol', 'http2',
      '--no-autoupdate',
      'run',
      '--token',
      token,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        this.logOutput(output);
      }

      // 检测连接成功
      if (output.includes('Connection registered') || output.includes('Registered tunnel connection')) {
        this.status.connected = true;
        this.status.lastHeartbeat = new Date();
        this.logger.info('Tunnel connected successfully');
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      if (output) {
        // cloudflared 的正常日志也输出到 stderr
        this.logOutput(output);

        // 检测连接成功
        if (output.includes('Registered tunnel connection') || output.includes('Connection registered')) {
          this.status.connected = true;
          this.status.lastHeartbeat = new Date();
          // logOutput 已经打印了信息，这里不需要重复打印
        }

        // 检测错误
        if (output.includes('ERR') || output.includes('failed')) {
          this.status.error = output;
        }
      }
    });

    this.process.on('exit', (code) => {
      this.logger.info(`Process exited with code ${code}`);
      this.status = { running: false, connected: false };
      this.process = null;
      this.managedByUs = false;
    });

    this.process.on('error', (error) => {
      this.logger.error(`Failed to start: ${error.message}`);
      this.status = { running: false, connected: false, error: error.message };
      this.process = null;
      this.managedByUs = false;
    });

    this.currentConfig = actualConfig;
    this.status.endpoint = actualConfig.endpoint;

    // 等待连接建立
    await this.waitForConnection();
  }

  /**
   * 解析并打印 cloudflared 日志
   */
  private logOutput(raw: string): void {
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      
      // 尝试去除时间戳 (例如: 2023-01-01T00:00:00Z INF ...)
      // 正则匹配 ISO 时间戳开头
      const match = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+(INF|WRN|ERR)\s+(.*)$/);
      
      if (match) {
        const level = match[1];
        const content = match[2];
        
        switch (level) {
          case 'INF':
            this.logger.info(content);
            break;
          case 'WRN':
            this.logger.warn(content);
            break;
          case 'ERR':
            this.logger.error(content);
            break;
          default:
            this.logger.info(content);
        }
      } else {
        // 无法解析格式，原样输出
        this.logger.info(line);
      }
    }
  }

  /**
   * 停止隧道
   * 只有当隧道是由我们启动时才会停止
   */
  async stop(): Promise<void> {
    if (!this.managedByUs) {
      this.logger.info('Not managed by us, skipping stop');
      this.status = { running: false, connected: false };
      return;
    }

    if (this.process) {
      this.logger.info('Stopping tunnel...');
      this.process.kill('SIGTERM');

      // 等待进程退出
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.logger.info('Force killing process...');
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
      this.logger.info('Tunnel stopped');
    }

    this.status = { running: false, connected: false };
    this.managedByUs = false;
  }

  /**
   * 获取隧道状态
   */
  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  /**
   * 获取公网端点
   */
  getEndpoint(): string | undefined {
    return this.currentConfig?.endpoint;
  }

  /**
   * Local 模式不需要 cleanup（不涉及 Cloudflare API 操作）
   */
  async cleanup(_config: TunnelConfig): Promise<void> {
    await this.stop();
    this.currentConfig = null;
  }

  // ============ 隧道检测方法 ============

  /**
   * 检测 cloudflared 是否已经在运行
   * 通过进程检测 + metrics 端口检测
   */
  async isCloudflaredRunning(): Promise<boolean> {
    // 方法1：检测进程
    if (this.isCloudflaredProcessRunning()) {
      return true;
    }

    // 方法2：检测 metrics 端口
    return await this.isMetricsPortOpen();
  }

  /**
   * 检测 cloudflared 进程是否存在
   */
  private isCloudflaredProcessRunning(): boolean {
    try {
      if (process.platform === 'win32') {
        execSync('tasklist /FI "IMAGENAME eq cloudflared.exe" | find "cloudflared"', { 
          stdio: 'ignore' 
        });
      } else {
        execSync('pgrep -x cloudflared', { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检测 cloudflared metrics 端口是否开放
   */
  private async isMetricsPortOpen(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      
      const res = await fetch(`http://localhost:${CLOUDFLARED_METRICS_PORT}/ready`, {
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 等待连接建立
   */
  private async waitForConnection(timeout = 30000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (this.status.connected) {
        return;
      }

      if (!this.status.running && this.status.error) {
        throw new Error(`Tunnel failed to start: ${this.status.error}`);
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    // 超时不抛错，cloudflared 可能还在连接中
    this.logger.warn('Connection timeout, tunnel may still be connecting...');
  }

  /**
   * 获取是否由我们管理
   */
  isManagedByUs(): boolean {
    return this.managedByUs;
  }
}
