import type { TunnelProvider, TunnelConfig } from '../tunnel/TunnelProvider';
import type { DnsProvider } from '../dns/DnsProvider';
import type { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

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

  /** 绑定的节点 ID */
  nodeId?: string;
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

  /** Edge Node Repository (持久化) */
  edgeNodeRepo: EdgeNodeRepository;

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
 *
 * 注册信息持久化到 EdgeNodeRepository（identity_edge_node.subdomain 字段）
 */
export class SubdomainService {
  private readonly baseDomain: string;
  private readonly dnsProvider: DnsProvider;
  private readonly tunnelProvider: TunnelProvider;
  private readonly edgeNodeRepo: EdgeNodeRepository;
  private readonly reservedSubdomains: Set<string>;

  constructor(options: SubdomainServiceOptions) {
    this.baseDomain = options.baseDomain;
    this.dnsProvider = options.dnsProvider;
    this.tunnelProvider = options.tunnelProvider;
    this.edgeNodeRepo = options.edgeNodeRepo;
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
    if (!this.isValidSubdomain(subdomain)) {
      return {
        available: false,
        reason: 'Invalid subdomain format. Use 3-63 lowercase letters, numbers, or hyphens.',
      };
    }

    if (this.reservedSubdomains.has(subdomain.toLowerCase())) {
      return {
        available: false,
        reason: 'This subdomain is reserved.',
      };
    }

    const existing = await this.edgeNodeRepo.findNodeBySubdomain(subdomain.toLowerCase());
    if (existing) {
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
    nodeId: string;
    localPort: number;
    publicIp?: string;
    ownerId?: string;
  }): Promise<SubdomainRegistration> {
    const { subdomain, nodeId, localPort, publicIp, ownerId } = options;
    const normalizedSubdomain = subdomain.toLowerCase();

    const availability = await this.checkAvailability(normalizedSubdomain);
    if (!availability.available) {
      throw new Error(availability.reason);
    }

    const fullDomain = `${normalizedSubdomain}.${this.baseDomain}`;

    // 连通性检测
    let mode: 'direct' | 'tunnel' = 'tunnel';
    let verifiedIp: string | undefined;

    if (publicIp) {
      const connectivity = await this.checkConnectivity(publicIp, localPort);
      if (connectivity.reachable) {
        mode = 'direct';
        verifiedIp = publicIp;
      }
    }

    // DNS / 隧道
    let tunnelConfig: TunnelConfig | undefined;

    if (mode === 'direct') {
      const type = this.isIpv6(verifiedIp!) ? 'AAAA' : 'A';
      await this.dnsProvider.upsertRecord({
        subdomain: normalizedSubdomain,
        domain: this.baseDomain,
        type,
        value: verifiedIp!,
        ttl: 60,
      });
    } else {
      tunnelConfig = await this.tunnelProvider.setup({
        subdomain: normalizedSubdomain,
        localPort,
      });
    }

    // 持久化到 EdgeNodeRepository
    await this.edgeNodeRepo.updateNodeMode(nodeId, {
      accessMode: mode === 'direct' ? 'direct' : 'proxy',
      publicIp: verifiedIp,
      publicPort: localPort,
      subdomain: normalizedSubdomain,
      connectivityStatus: mode === 'direct' ? 'reachable' : 'unknown',
    });

    return {
      subdomain: normalizedSubdomain,
      fullDomain,
      mode,
      publicIp: verifiedIp,
      tunnelConfig,
      registeredAt: new Date(),
      ownerId,
      nodeId,
    };
  }

  /**
   * 释放子域名
   */
  async release(subdomain: string): Promise<void> {
    const normalizedSubdomain = subdomain.toLowerCase();
    const node = await this.edgeNodeRepo.findNodeBySubdomain(normalizedSubdomain);

    if (!node) {
      throw new Error('Subdomain not found');
    }

    // 获取完整连通性信息以判断模式
    const info = await this.edgeNodeRepo.getNodeConnectivityInfo(node.nodeId);
    const accessMode = info?.accessMode;

    // 删除 DNS 记录
    try {
      await this.dnsProvider.deleteRecord({
        subdomain: normalizedSubdomain,
        domain: this.baseDomain,
        type: accessMode === 'direct' ? 'A' : 'CNAME',
      });
    } catch {
      // DNS 删除失败不阻塞释放
    }

    // 清除 DB 中的 subdomain
    await this.edgeNodeRepo.updateNodeMode(node.nodeId, {
      accessMode: 'proxy',
      subdomain: undefined,
      connectivityStatus: 'unknown',
    });
  }

  /**
   * 获取注册信息
   */
  async getRegistration(subdomain: string): Promise<SubdomainRegistration | undefined> {
    const node = await this.edgeNodeRepo.findNodeBySubdomain(subdomain.toLowerCase());
    if (!node) {
      return undefined;
    }
    return this.nodeToRegistration(node);
  }

  /**
   * 获取所有注册
   */
  async getAllRegistrations(): Promise<SubdomainRegistration[]> {
    const nodes = await this.edgeNodeRepo.listNodes();
    const results: SubdomainRegistration[] = [];
    for (const n of nodes) {
      if (!n.metadata || !(n.metadata as Record<string, unknown>).subdomain) {
        // 需要查 connectivity info 获取 subdomain
        const info = await this.edgeNodeRepo.getNodeConnectivityInfo(n.nodeId);
        if (info?.subdomain) {
          results.push({
            subdomain: info.subdomain,
            fullDomain: `${info.subdomain}.${this.baseDomain}`,
            mode: info.accessMode === 'direct' ? 'direct' : 'tunnel',
            publicIp: info.publicIp,
            registeredAt: new Date(),
            nodeId: n.nodeId,
          });
        }
      }
    }
    return results;
  }

  /**
   * 启动隧道
   */
  async startTunnel(subdomain: string): Promise<void> {
    const reg = await this.getRegistration(subdomain);
    if (!reg) {
      throw new Error('Subdomain not found');
    }
    if (reg.mode !== 'tunnel' || !reg.tunnelConfig) {
      throw new Error('Subdomain is not in tunnel mode');
    }
    await this.tunnelProvider.start(reg.tunnelConfig);
  }

  /**
   * 停止隧道
   */
  async stopTunnel(): Promise<void> {
    await this.tunnelProvider.stop();
  }

  // ============ 私有方法 ============

  private nodeToRegistration(node: {
    nodeId: string;
    accessMode?: string;
    metadata?: Record<string, unknown> | null;
    subdomain?: string;
  }): SubdomainRegistration {
    const sub = node.subdomain!;
    return {
      subdomain: sub,
      fullDomain: `${sub}.${this.baseDomain}`,
      mode: node.accessMode === 'direct' ? 'direct' : 'tunnel',
      registeredAt: new Date(),
      nodeId: node.nodeId,
      ownerId: (node.metadata as Record<string, unknown> | null)?.ownerId as string | undefined,
    };
  }

  private isValidSubdomain(subdomain: string): boolean {
    const regex = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
    return regex.test(subdomain) && subdomain.length >= 3 && subdomain.length <= 63;
  }

  private async checkConnectivity(
    ip: string,
    port: number,
  ): Promise<ConnectivityResult> {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const host = this.isIpv6(ip) ? `[${ip}]` : ip;
      const response = await fetch(`http://${host}:${port}/.well-known/solid`, {
        method: 'HEAD',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      return {
        reachable: response.ok || response.status === 401,
        publicIp: ip,
        latency: Date.now() - start,
      };
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private isIpv6(ip: string): boolean {
    return ip.includes(':');
  }
}
