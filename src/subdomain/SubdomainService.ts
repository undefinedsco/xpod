import type { TunnelProvider, TunnelConfig } from '../tunnel/TunnelProvider';
import type { DnsProvider } from '../dns/DnsProvider';

/**
 * 子域名注册信息
 */
export interface SubdomainRegistration {
  /** 子域名 (如 mynode) */
  subdomain: string;

  /** 完整域名 (如 mynode.pods.undefieds.co) */
  fullDomain: string;

  /** 访问模式 */
  mode: 'direct' | 'tunnel';

  /** 公网 IP (直连模式) */
  publicIp?: string;

  /** 隧道配置 (隧道模式) */
  tunnelConfig?: TunnelConfig;

  /** 注册时间 */
  registeredAt: Date;

  /** 所有者 ID */
  ownerId?: string;
}

/**
 * 连通性检测结果
 */
export interface ConnectivityResult {
  /** 是否可达 */
  reachable: boolean;

  /** 公网 IP */
  publicIp?: string;

  /** 延迟 (ms) */
  latency?: number;

  /** 错误信息 */
  error?: string;
}

/**
 * SubdomainService 配置
 */
export interface SubdomainServiceOptions {
  /** 基础域名 (如 pods.undefieds.co) */
  baseDomain: string;

  /** DNS Provider */
  dnsProvider: DnsProvider;

  /** Tunnel Provider */
  tunnelProvider: TunnelProvider;

  /** 连通性检测端点 (可选，用于回调检测) */
  connectivityCheckEndpoint?: string;

  /** 保留的子域名列表 */
  reservedSubdomains?: string[];
}

/**
 * 子域名管理服务
 * 
 * 负责：
 * 1. 子域名可用性检查
 * 2. 连通性检测
 * 3. 直连/隧道模式选择
 * 4. DNS 记录管理
 * 5. 隧道创建
 */
export class SubdomainService {
  private readonly baseDomain: string;
  private readonly dnsProvider: DnsProvider;
  private readonly tunnelProvider: TunnelProvider;
  private readonly connectivityCheckEndpoint?: string;
  private readonly reservedSubdomains: Set<string>;

  /** 已注册的子域名 (内存缓存，后续可改为数据库) */
  private registrations: Map<string, SubdomainRegistration> = new Map();

  constructor(options: SubdomainServiceOptions) {
    this.baseDomain = options.baseDomain;
    this.dnsProvider = options.dnsProvider;
    this.tunnelProvider = options.tunnelProvider;
    this.connectivityCheckEndpoint = options.connectivityCheckEndpoint;
    this.reservedSubdomains = new Set(options.reservedSubdomains ?? [
      'www', 'api', 'app', 'admin', 'mail', 'ftp', 'ssh',
      'pods', 'center', 'edge', 'node', 'test', 'dev', 'staging',
    ]);
  }

  /**
   * 检查子域名是否可用
   */
  async checkAvailability(subdomain: string): Promise<{
    available: boolean;
    reason?: string;
  }> {
    // 1. 格式校验
    if (!this.isValidSubdomain(subdomain)) {
      return {
        available: false,
        reason: 'Invalid subdomain format. Use 3-63 lowercase letters, numbers, or hyphens.',
      };
    }

    // 2. 保留名检查
    if (this.reservedSubdomains.has(subdomain.toLowerCase())) {
      return {
        available: false,
        reason: 'This subdomain is reserved.',
      };
    }

    // 3. 已注册检查
    if (this.registrations.has(subdomain.toLowerCase())) {
      return {
        available: false,
        reason: 'This subdomain is already registered.',
      };
    }

    return { available: true };
  }

  /**
   * 注册子域名
   */
  async register(options: {
    subdomain: string;
    localPort: number;
    publicIp?: string;
    ownerId?: string;
  }): Promise<SubdomainRegistration> {
    const { subdomain, localPort, publicIp, ownerId } = options;
    const normalizedSubdomain = subdomain.toLowerCase();

    // 1. 检查可用性
    const availability = await this.checkAvailability(normalizedSubdomain);
    if (!availability.available) {
      throw new Error(availability.reason);
    }

    const fullDomain = `${normalizedSubdomain}.${this.baseDomain}`;

    // 2. 连通性检测 (如果提供了公网 IP)
    let mode: 'direct' | 'tunnel' = 'tunnel';
    let verifiedIp: string | undefined;

    if (publicIp) {
      const connectivity = await this.checkConnectivity(publicIp, localPort);
      if (connectivity.reachable) {
        mode = 'direct';
        verifiedIp = publicIp;
      }
    }

    // 3. 根据模式设置 DNS 和隧道
    let tunnelConfig: TunnelConfig | undefined;

    if (mode === 'direct') {
      // 直连模式：创建 A 记录
      await this.dnsProvider.upsertRecord({
        subdomain: normalizedSubdomain,
        domain: this.baseDomain,
        type: 'A',
        value: verifiedIp!,
        ttl: 60,
      });
    } else {
      // 隧道模式：创建隧道 + CNAME
      tunnelConfig = await this.tunnelProvider.setup({
        subdomain: normalizedSubdomain,
        localPort,
      });
    }

    // 4. 保存注册信息
    const registration: SubdomainRegistration = {
      subdomain: normalizedSubdomain,
      fullDomain,
      mode,
      publicIp: verifiedIp,
      tunnelConfig,
      registeredAt: new Date(),
      ownerId,
    };

    this.registrations.set(normalizedSubdomain, registration);

    return registration;
  }

  /**
   * 释放子域名
   */
  async release(subdomain: string): Promise<void> {
    const normalizedSubdomain = subdomain.toLowerCase();
    const registration = this.registrations.get(normalizedSubdomain);

    if (!registration) {
      throw new Error('Subdomain not found');
    }

    // 1. 清理隧道
    if (registration.tunnelConfig) {
      await this.tunnelProvider.cleanup(registration.tunnelConfig);
    }

    // 2. 删除 DNS 记录 (尝试删除 A 和 CNAME 类型)
    try {
      await this.dnsProvider.deleteRecord({
        subdomain: normalizedSubdomain,
        domain: this.baseDomain,
        type: registration.mode === 'direct' ? 'A' : 'CNAME',
      });
    } catch (error) {
      console.warn(`Failed to delete DNS record for ${normalizedSubdomain}:`, error);
    }

    // 3. 移除注册信息
    this.registrations.delete(normalizedSubdomain);
  }

  /**
   * 获取注册信息
   */
  getRegistration(subdomain: string): SubdomainRegistration | undefined {
    return this.registrations.get(subdomain.toLowerCase());
  }

  /**
   * 获取所有注册
   */
  getAllRegistrations(): SubdomainRegistration[] {
    return Array.from(this.registrations.values());
  }

  /**
   * 启动隧道
   */
  async startTunnel(subdomain: string): Promise<void> {
    const registration = this.registrations.get(subdomain.toLowerCase());

    if (!registration) {
      throw new Error('Subdomain not found');
    }

    if (registration.mode !== 'tunnel' || !registration.tunnelConfig) {
      throw new Error('Subdomain is not in tunnel mode');
    }

    await this.tunnelProvider.start(registration.tunnelConfig);
  }

  /**
   * 停止隧道
   */
  async stopTunnel(): Promise<void> {
    await this.tunnelProvider.stop();
  }

  // ============ 私有方法 ============

  /**
   * 校验子域名格式
   */
  private isValidSubdomain(subdomain: string): boolean {
    // 3-63 字符，小写字母、数字、连字符，不能以连字符开头或结尾
    const regex = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
    return regex.test(subdomain) && subdomain.length >= 3 && subdomain.length <= 63;
  }

  /**
   * 连通性检测
   */
  private async checkConnectivity(
    ip: string,
    port: number
  ): Promise<ConnectivityResult> {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`http://${ip}:${port}/.well-known/solid`, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latency = Date.now() - start;

      return {
        reachable: response.ok || response.status === 401,
        publicIp: ip,
        latency,
      };
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
