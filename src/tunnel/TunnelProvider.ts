/**
 * Tunnel Provider Interface
 * 
 * 抽象隧道服务，支持多种实现：
 * - CloudflareTunnelProvider: Cloudflare Tunnel（阶段 1）
 * - FrpTunnelProvider: FRP（阶段 2，自建或第三方）
 */

/**
 * 隧道配置
 */
export interface TunnelConfig {
  /** 子域名 (如 mynode，完整域名为 mynode.pods.undefieds.co) */
  subdomain: string;

  /** 隧道类型 */
  provider: 'cloudflare' | 'frp' | 'sakura-frp';

  /** 公网访问端点 (如 https://mynode.pods.undefieds.co) */
  endpoint: string;

  /** Cloudflare Tunnel Token (cloudflare 专用) */
  tunnelToken?: string;

  /** Cloudflare Tunnel ID (cloudflare 专用) */
  tunnelId?: string;

  /** FRP 服务器地址 (frp 专用) */
  frpServer?: string;

  /** FRP 服务器端口 (frp 专用) */
  frpServerPort?: number;

  /** FRP Token (frp 专用) */
  frpToken?: string;

  /** FRP 远程端口 (frp 专用) */
  frpRemotePort?: number;
}

/**
 * 隧道设置参数
 */
export interface TunnelSetupOptions {
  /** 子域名 */
  subdomain: string;

  /** 本地服务端口 */
  localPort: number;

  /** 本地服务协议 */
  localProtocol?: 'http' | 'https';
}

/**
 * 隧道状态
 */
export interface TunnelStatus {
  /** 是否正在运行 */
  running: boolean;

  /** 连接状态 */
  connected: boolean;

  /** 公网端点 */
  endpoint?: string;

  /** 错误信息 */
  error?: string;

  /** 最后心跳时间 */
  lastHeartbeat?: Date;
}

/**
 * 隧道 Provider 接口
 */
export interface TunnelProvider {
  /** Provider 名称 */
  readonly name: string;

  /**
   * 初始化隧道（注册、分配资源）
   * @param options 设置参数
   * @returns 隧道配置
   */
  setup(options: TunnelSetupOptions): Promise<TunnelConfig>;

  /**
   * 启动隧道客户端
   * @param config 隧道配置
   */
  start(config: TunnelConfig): Promise<void>;

  /**
   * 停止隧道
   */
  stop(): Promise<void>;

  /**
   * 获取隧道状态
   */
  getStatus(): TunnelStatus;

  /**
   * 获取公网访问端点
   */
  getEndpoint(): string | undefined;

  /**
   * 清理资源（删除隧道、DNS 记录等）
   * @param config 隧道配置
   */
  cleanup(config: TunnelConfig): Promise<void>;
}
