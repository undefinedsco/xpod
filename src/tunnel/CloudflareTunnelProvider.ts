import { spawn, execSync, type ChildProcess } from 'node:child_process';
import type {
  TunnelProvider,
  TunnelConfig,
  TunnelSetupOptions,
  TunnelStatus,
} from './TunnelProvider';

/** cloudflared metrics 端口 */
const CLOUDFLARED_METRICS_PORT = 33863;

/**
 * Cloudflare Tunnel Provider 配置
 */
export interface CloudflareTunnelProviderOptions {
  /** Cloudflare API Token (需要 Tunnel 和 DNS 权限) */
  apiToken: string;

  /** Cloudflare Account ID */
  accountId: string;

  /** 基础域名 (如 pods.undefieds.co) */
  baseDomain: string;

  /** cloudflared 可执行文件路径 (默认 'cloudflared') */
  cloudflaredPath?: string;
}

/**
 * Cloudflare Tunnel Provider
 * 
 * 使用 Cloudflare Tunnel 实现隧道穿透
 */
export class CloudflareTunnelProvider implements TunnelProvider {
  public readonly name = 'cloudflare';

  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly baseDomain: string;
  private readonly cloudflaredPath: string;

  private process: ChildProcess | null = null;
  private status: TunnelStatus = {
    running: false,
    connected: false,
  };
  private currentConfig: TunnelConfig | null = null;
  /** 标记隧道进程是否由我们启动和管理 */
  private managedByUs = false;

  constructor(options: CloudflareTunnelProviderOptions) {
    this.apiToken = options.apiToken;
    this.accountId = options.accountId;
    this.baseDomain = options.baseDomain;
    this.cloudflaredPath = options.cloudflaredPath ?? 'cloudflared';
  }

  /**
   * 初始化隧道
   */
  async setup(options: TunnelSetupOptions): Promise<TunnelConfig> {
    const { subdomain, localPort } = options;
    const fullDomain = `${subdomain}.${this.baseDomain}`;

    // 1. 创建 Tunnel
    const tunnel = await this.createTunnel(subdomain);

    // 2. 配置 Tunnel ingress (指向本地端口)
    await this.configureTunnelIngress(tunnel.id, fullDomain, localPort);

    // 3. 创建 DNS CNAME 记录
    await this.createDnsRecord(subdomain, tunnel.id);

    // 4. 获取 Tunnel Token
    const tunnelToken = await this.getTunnelToken(tunnel.id);

    const config: TunnelConfig = {
      subdomain,
      provider: 'cloudflare',
      endpoint: `https://${fullDomain}`,
      tunnelId: tunnel.id,
      tunnelToken,
    };

    this.currentConfig = config;
    return config;
  }

  /**
   * 启动隧道客户端
   * 如果 cloudflared 已经在运行，则跳过启动
   */
  async start(config: TunnelConfig): Promise<void> {
    // 检测是否已经在运行
    const alreadyRunning = await this.isCloudflaredRunning();
    if (alreadyRunning) {
      console.log('[cloudflared] Already running externally, skipping start');
      this.status = { running: true, connected: true, endpoint: config.endpoint };
      this.currentConfig = config;
      this.managedByUs = false;
      return;
    }

    if (this.process) {
      throw new Error('Tunnel already running');
    }

    if (!config.tunnelToken) {
      throw new Error('Tunnel token is required');
    }

    this.status = { running: true, connected: false };
    this.managedByUs = true;

    this.process = spawn(this.cloudflaredPath, [
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token',
      config.tunnelToken,
    ]);

    this.process.stdout?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.log(`[cloudflared] ${output}`);

      // 检测连接成功
      if (output.includes('Connection registered') || output.includes('Registered tunnel connection')) {
        this.status.connected = true;
        this.status.lastHeartbeat = new Date();
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const output = data.toString();
      console.error(`[cloudflared] ${output}`);

      // 检测错误
      if (output.includes('error') || output.includes('failed')) {
        this.status.error = output;
      }
    });

    this.process.on('exit', (code) => {
      console.log(`[cloudflared] Process exited with code ${code}`);
      this.status = { running: false, connected: false };
      this.process = null;
    });

    this.currentConfig = config;
    this.status.endpoint = config.endpoint;

    // 等待连接建立
    await this.waitForConnection();
  }

  /**
   * 停止隧道
   * 只有当隧道是由我们启动时才会停止
   */
  async stop(): Promise<void> {
    if (!this.managedByUs) {
      console.log('[cloudflared] Not managed by us, skipping stop');
      this.status = { running: false, connected: false };
      return;
    }

    if (this.process) {
      this.process.kill('SIGTERM');

      // 等待进程退出
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
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
   * 清理资源
   */
  async cleanup(config: TunnelConfig): Promise<void> {
    // 1. 停止隧道
    await this.stop();

    // 2. 删除 DNS 记录
    if (config.subdomain) {
      await this.deleteDnsRecord(config.subdomain);
    }

    // 3. 删除 Tunnel
    if (config.tunnelId) {
      await this.deleteTunnel(config.tunnelId);
    }

    this.currentConfig = null;
  }

  // ============ Cloudflare API 方法 ============

  /**
   * 创建 Tunnel
   */
  private async createTunnel(name: string): Promise<{ id: string; name: string }> {
    const response = await this.cloudflareApi(
      `accounts/${this.accountId}/cfd_tunnel`,
      'POST',
      {
        name: `xpod-${name}`,
        tunnel_secret: this.generateTunnelSecret(),
        config_src: 'cloudflare',
      }
    );

    return {
      id: response.result.id,
      name: response.result.name,
    };
  }

  /**
   * 配置 Tunnel Ingress
   */
  private async configureTunnelIngress(
    tunnelId: string,
    hostname: string,
    localPort: number
  ): Promise<void> {
    await this.cloudflareApi(
      `accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      'PUT',
      {
        config: {
          ingress: [
            {
              hostname,
              service: `http://localhost:${localPort}`,
            },
            {
              service: 'http_status:404',
            },
          ],
        },
      }
    );
  }

  /**
   * 获取 Tunnel Token
   */
  private async getTunnelToken(tunnelId: string): Promise<string> {
    const response = await this.cloudflareApi(
      `accounts/${this.accountId}/cfd_tunnel/${tunnelId}/token`,
      'GET'
    );

    return response.result;
  }

  /**
   * 删除 Tunnel
   */
  private async deleteTunnel(tunnelId: string): Promise<void> {
    try {
      await this.cloudflareApi(
        `accounts/${this.accountId}/cfd_tunnel/${tunnelId}`,
        'DELETE'
      );
    } catch (error) {
      console.warn(`Failed to delete tunnel ${tunnelId}:`, error);
    }
  }

  /**
   * 创建 DNS CNAME 记录
   */
  private async createDnsRecord(subdomain: string, tunnelId: string): Promise<void> {
    const zoneId = await this.getZoneId();
    const fullDomain = `${subdomain}.${this.baseDomain}`;

    await this.cloudflareApi(
      `zones/${zoneId}/dns_records`,
      'POST',
      {
        type: 'CNAME',
        name: fullDomain,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      }
    );
  }

  /**
   * 删除 DNS 记录
   */
  private async deleteDnsRecord(subdomain: string): Promise<void> {
    try {
      const zoneId = await this.getZoneId();
      const fullDomain = `${subdomain}.${this.baseDomain}`;

      // 查找记录
      const response = await this.cloudflareApi(
        `zones/${zoneId}/dns_records?name=${fullDomain}`,
        'GET'
      );

      for (const record of response.result) {
        await this.cloudflareApi(
          `zones/${zoneId}/dns_records/${record.id}`,
          'DELETE'
        );
      }
    } catch (error) {
      console.warn(`Failed to delete DNS record for ${subdomain}:`, error);
    }
  }

  /**
   * 获取 Zone ID
   */
  private async getZoneId(): Promise<string> {
    const response = await this.cloudflareApi(
      `zones?name=${this.baseDomain}`,
      'GET'
    );

    if (!response.result?.length) {
      throw new Error(`Zone not found for domain: ${this.baseDomain}`);
    }

    return response.result[0].id;
  }

  /**
   * Cloudflare API 请求
   */
  private async cloudflareApi(
    endpoint: string,
    method: string,
    body?: unknown
  ): Promise<any> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json() as {
      success: boolean;
      errors?: Array<{ message: string }>;
      result?: unknown;
    };

    if (!response.ok || !data.success) {
      const errors = data.errors?.map((e) => e.message).join(', ') || 'Unknown error';
      throw new Error(`Cloudflare API error: ${errors}`);
    }

    return data;
  }

  /**
   * 生成 Tunnel Secret
   */
  private generateTunnelSecret(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString('base64');
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

      if (!this.status.running) {
        throw new Error('Tunnel process exited unexpectedly');
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error('Tunnel connection timeout');
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
   * 检测隧道是否可从外部访问
   * @param domain 要检测的域名
   */
  async isReachable(domain: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const res = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      // 任何响应都说明隧道通了（包括 404）
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取是否由我们管理
   */
  isManagedByUs(): boolean {
    return this.managedByUs;
  }
}
