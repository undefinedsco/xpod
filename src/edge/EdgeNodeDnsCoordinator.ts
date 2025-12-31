import { getLoggerFor } from 'global-logger-factory';
import type { DnsProvider, DnsRecordTypeValue } from '../dns/DnsProvider';

export interface EdgeNodeDnsCoordinatorOptions {
  provider: DnsProvider;
  /** 顶级域名，例如 `xpod.example`。 */
  rootDomain?: string | null;
  /**
   * 默认记录类型，当目标地址无法识别时回退使用。
   * 一般为 `A`（IPv4）或 `AAAA`（IPv6）。
   */
  defaultRecordType?: DnsRecordTypeValue;
  /** TTL 秒数，缺省按供应商默认。 */
  ttl?: number | string | null;
  /**
   * Cluster 的公网 IP 地址，用于 proxy 模式的 DNS 指向。
   * 如果未设置，proxy 模式节点将跳过 DNS 同步。
   */
  clusterIp?: string | null;
}

export class EdgeNodeDnsCoordinator {
  private readonly logger = getLoggerFor(this);
  private readonly provider: DnsProvider;
  private readonly rootDomain?: string;
  private readonly defaultRecordType: DnsRecordTypeValue;
  private readonly ttl?: number;
  private readonly clusterIp?: string;
  private readonly enabled: boolean;

  public constructor(options: EdgeNodeDnsCoordinatorOptions) {
    this.provider = options.provider;
    this.rootDomain = this.normalizeRootDomain(options.rootDomain);
    this.defaultRecordType = options.defaultRecordType ?? 'A';
    this.ttl = this.normalizeTtl(options.ttl);
    this.clusterIp = this.extractString(options.clusterIp);
    this.enabled = Boolean(this.rootDomain);
  }

  public async synchronize(nodeId: string, metadata: Record<string, unknown>): Promise<void> {
    if (!this.enabled) {
      return;
    }
    
    const hints = this.extractDnsHints(metadata);

    // Extract subdomain and access mode
    const subdomain = this.extractString(metadata.subdomain) ?? hints?.subdomain;
    if (!subdomain) {
      this.logger.debug(`Node ${nodeId} 未提供 subdomain，跳过 DNS 同步。`);
      return;
    }
    
    const accessMode = this.extractString(metadata.accessMode);
    const normalizedAccessMode = accessMode?.trim().toLowerCase();
    
    // Determine DNS target based on access mode
    let target: string | undefined;
    if (normalizedAccessMode === 'direct') {
      // Direct mode: DNS 指向节点公网 IP
      target = this.extractString(metadata.publicIp) 
        ?? this.extractString(metadata.ipv4)
        ?? this.extractString(metadata.publicAddress);
      
      if (!target && hints?.target) {
        target = hints.target;
      }

      if (!target) {
        this.logger.warn(`Node ${nodeId} (direct mode) 未提供公网 IP，跳过 DNS 同步。`);
        return;
      }
    } else if (normalizedAccessMode === 'proxy') {
      // Proxy mode: DNS 指向 Cluster IP
      if (!this.clusterIp) {
        this.logger.debug(`Cluster IP 未配置，跳过 proxy 模式节点 ${nodeId} 的 DNS 同步。`);
        return;
      }
      target = this.clusterIp;
    } else if (hints?.target) {
      // Fallback: 使用旧的逻辑从 metadata 提取
      target = hints.target;
    } else {
      this.logger.debug(`Node ${nodeId} 未提供 accessMode/dns hints，跳过同步。`);
      return;
    }
    
    const type = this.detectRecordType(target) ?? this.defaultRecordType;
    const value = this.normalizeRecordValue(target, type);

    if (!value) {
      this.logger.warn(`Edge node ${nodeId} DNS 目标解析失败，跳过同步。`);
      return;
    }

    try {
      await this.provider.upsertRecord({
        domain: this.rootDomain!,
        subdomain,
        type,
        value,
        ttl: this.ttl,
      });
      const loggedMode = normalizedAccessMode ?? 'unknown';
      this.logger.info(`已同步节点 ${nodeId} (${loggedMode}) 的 DNS: ${subdomain}.${this.rootDomain} -> ${value}`);
    } catch (error: unknown) {
      this.logger.error(`同步节点 ${nodeId} DNS 记录失败: ${(error as Error).message}`);
      throw error;
    }
  }

  private extractDnsHints(metadata: Record<string, unknown>): { subdomain: string; target: string } | undefined {
    const dns = metadata?.dns;
    if (!dns || typeof dns !== 'object') {
      return undefined;
    }
    const subdomain = this.extractString((dns as Record<string, unknown>).subdomain);
    if (!subdomain) {
      return undefined;
    }

    const target = this.extractString((dns as Record<string, unknown>).target)
      ?? this.extractString(metadata.publicAddress)
      ?? this.extractString(metadata.baseUrl);

    if (!target) {
      return undefined;
    }
    return { subdomain, target };
  }

  private extractString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private detectRecordType(target: string): DnsRecordTypeValue | undefined {
    const host = this.extractHost(target) ?? target;
    if (this.isIpv4(host)) {
      return 'A';
    }
    if (this.isIpv6(host)) {
      return 'AAAA';
    }
    if (host.includes('.')) {
      return 'CNAME';
    }
    return undefined;
  }

  private normalizeRecordValue(target: string, type: DnsRecordTypeValue): string | undefined {
    const host = this.extractHost(target) ?? target;
    if (type === 'A' && this.isIpv4(host)) {
      return host;
    }
    if (type === 'AAAA' && this.isIpv6(host)) {
      return host;
    }
    if (type === 'CNAME') {
      return host.endsWith('.') ? host : `${host}.`;
    }
    if (type === 'TXT') {
      return host;
    }
    return undefined;
  }

  private extractHost(input: string): string | undefined {
    try {
      const url = new URL(input);
      return url.hostname;
    } catch {
      return input;
    }
  }

  private isIpv4(value: string): boolean {
    const parts = value.split('.');
    if (parts.length !== 4) {
      return false;
    }
    return parts.every((part) => {
      if (!/^[0-9]{1,3}$/.test(part)) {
        return false;
      }
      const num = Number(part);
      return num >= 0 && num <= 255;
    });
  }

  private isIpv6(value: string): boolean {
    return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
  }

  private normalizeRootDomain(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    let trimmed = value.trim();
    if (trimmed.includes('://')) {
      try {
        trimmed = new URL(trimmed).hostname;
      } catch {
        // ignore
      }
    }
    trimmed = trimmed.replace(/\.$/, '');
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeTtl(value?: number | string | null): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
      }
    }
    return undefined;
  }
}
