/**
 * DDNS Manager for Local Managed Mode
 *
 * 负责在托管式 Local 模式下：
 * 1. 启动时自动向 Cloud 注册并分配 DDNS 子域名
 * 2. 定期检测本机 IP 变化并更新 DDNS 记录
 */

import { getLoggerFor } from 'global-logger-factory';
import type { SubdomainClient } from '../subdomain/SubdomainClient';
import type { EdgeNodeCapabilityDetector, NetworkAddressInfo } from './EdgeNodeCapabilityDetector';

export interface DdnsManagerOptions {
  /** SubdomainClient 实例 */
  client: SubdomainClient;

  /** 网络检测器 */
  detector: EdgeNodeCapabilityDetector;

  /** 要分配的子域名 (通常从 Node Token 解析) */
  subdomain: string;

  /** IP 检测和更新间隔 (ms) */
  intervalMs?: number;

  /** 是否在启动时自动分配子域名 */
  autoAllocate?: boolean;
}

export class DdnsManager {
  private readonly logger = getLoggerFor(this);
  private readonly client: SubdomainClient;
  private readonly detector: EdgeNodeCapabilityDetector;
  private readonly subdomain: string;
  private readonly intervalMs: number;
  private readonly autoAllocate: boolean;

  private interval?: NodeJS.Timeout;
  private lastIpv4?: string;
  private lastIpv6?: string;
  private allocated = false;

  public constructor(options: DdnsManagerOptions) {
    this.client = options.client;
    this.detector = options.detector;
    this.subdomain = options.subdomain;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.autoAllocate = options.autoAllocate ?? true;
  }

  /**
   * 启动 DDNS 管理
   */
  public async start(): Promise<void> {
    if (this.interval) {
      return;
    }

    this.logger.info(`Starting DDNS manager for subdomain: ${this.subdomain}`);

    // 初始检测并注册
    await this.runCycle();

    // 定期检测 IP 变化
    this.interval = setInterval(() => this.runCycle(), this.intervalMs);
  }

  /**
   * 停止 DDNS 管理
   */
  public stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.logger.info('DDNS manager stopped');
  }

  /**
   * 获取当前 FQDN
   */
  public getFqdn(): string | undefined {
    if (!this.allocated) {
      return undefined;
    }
    // 需要从 Cloud 获取实际的 domain
    return undefined;
  }

  /**
   * 是否已分配子域名
   */
  public isAllocated(): boolean {
    return this.allocated;
  }

  private async runCycle(): Promise<void> {
    try {
      // 1. 检测本机 IP
      const netInfo = await this.detector.detectNetworkAddresses();
      const ipv4 = netInfo.ipv4Public ?? netInfo.ipv4;
      const ipv6 = netInfo.ipv6Public ?? netInfo.ipv6;

      // 2. 如果尚未分配，先尝试分配
      if (!this.allocated && this.autoAllocate) {
        await this.allocateSubdomain(ipv4, ipv6);
      }

      // 3. 如果已分配，检查 IP 是否变化
      if (this.allocated) {
        const ipChanged = ipv4 !== this.lastIpv4 || ipv6 !== this.lastIpv6;
        if (ipChanged) {
          await this.updateDdns(ipv4, ipv6);
        }
      }
    } catch (error: unknown) {
      this.logger.error(`DDNS cycle failed: ${(error as Error).message}`);
    }
  }

  private async allocateSubdomain(ipv4?: string, ipv6?: string): Promise<void> {
    try {
      // 先检查是否已存在
      const existing = await this.client.getDdns(this.subdomain);
      if (existing) {
        this.logger.info(`DDNS subdomain already allocated: ${existing.fqdn}`);
        this.allocated = true;
        this.lastIpv4 = existing.ipAddress;
        this.lastIpv6 = existing.ipv6Address;

        // 如果 IP 不同，更新
        if (existing.ipAddress !== ipv4 || existing.ipv6Address !== ipv6) {
          await this.updateDdns(ipv4, ipv6);
        }
        return;
      }

      // 分配新子域名
      this.logger.info(`Allocating DDNS subdomain: ${this.subdomain}`);
      const result = await this.client.allocateDdns({
        subdomain: this.subdomain,
        ipAddress: ipv4,
        ipv6Address: ipv6,
      });

      if (result.success) {
        this.logger.info(`DDNS allocated: ${result.fqdn}`);
        this.allocated = true;
        this.lastIpv4 = ipv4;
        this.lastIpv6 = ipv6;
      }
    } catch (error: unknown) {
      const message = (error as Error).message;
      if (message.includes('409') || message.includes('already')) {
        // 子域名已被占用，可能是之前注册的
        this.logger.warn(`Subdomain ${this.subdomain} already taken, trying to claim...`);
        // 尝试获取现有记录
        const existing = await this.client.getDdns(this.subdomain);
        if (existing) {
          this.allocated = true;
          this.lastIpv4 = existing.ipAddress;
          this.lastIpv6 = existing.ipv6Address;
        }
      } else {
        this.logger.error(`Failed to allocate DDNS: ${message}`);
      }
    }
  }

  private async updateDdns(ipv4?: string, ipv6?: string): Promise<void> {
    if (!ipv4 && !ipv6) {
      this.logger.debug('No IP address to update');
      return;
    }

    try {
      this.logger.info(`Updating DDNS: ${this.subdomain} -> IPv4=${ipv4 ?? 'none'}, IPv6=${ipv6 ?? 'none'}`);

      const result = await this.client.updateDdns(this.subdomain, {
        ipAddress: ipv4,
        ipv6Address: ipv6,
      });

      if (result.success) {
        this.lastIpv4 = ipv4;
        this.lastIpv6 = ipv6;
        this.logger.info(`DDNS updated: ${result.fqdn}`);
      }
    } catch (error: unknown) {
      this.logger.error(`Failed to update DDNS: ${(error as Error).message}`);
    }
  }
}
