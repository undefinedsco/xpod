import { getLoggerFor } from '@solid/community-server';
import type { EdgeNodeTunnelManager } from './EdgeNodeTunnelManager';

interface FrpTunnelManagerOptions {
  serverHost?: string | null;
  serverPort?: number | string | null;
  protocol?: string | null;
  token?: string | null;
  customDomainSuffix?: string | null;
  publicScheme?: string | null;
  remotePortBase?: number | string | null;
  remotePortStep?: number | string | null;
}

interface TunnelMetadata {
  status?: string;
  entrypoint?: string;
  type?: string;
  proxyName?: string;
  remotePort?: number;
  customDomain?: string;
  serverHost?: string;
  serverPort?: number;
  protocol?: string;
  token?: string;
  updatedAt?: string;
  config?: Record<string, unknown>;
}

export class FrpTunnelManager implements EdgeNodeTunnelManager {
  private readonly logger = getLoggerFor(this);
  private readonly enabled: boolean;
  private readonly serverHost?: string;
  private readonly serverPort?: number;
  private readonly protocol: string;
  private readonly token?: string;
  private readonly customDomainSuffix?: string;
  private readonly publicScheme: string;
  private readonly remotePortBase?: number;
  private readonly remotePortStep: number;

  public constructor(options: FrpTunnelManagerOptions) {
    this.serverHost = this.normalizeString(options.serverHost);
    this.serverPort = this.normalizeNumber(options.serverPort);
    this.protocol = this.normalizeString(options.protocol)?.toLowerCase() ?? 'tcp';
    this.token = this.normalizeString(options.token);
    this.customDomainSuffix = this.normalizeString(options.customDomainSuffix);
    this.publicScheme = this.normalizeString(options.publicScheme)?.toLowerCase() ?? 'https';
    this.remotePortBase = this.normalizeNumber(options.remotePortBase);
    this.remotePortStep = this.normalizeNumber(options.remotePortStep) ?? 1;
    this.enabled = Boolean(this.serverHost && this.token && (this.customDomainSuffix || this.remotePortBase));
    if (!this.enabled) {
      this.logger.info('FrpTunnelManager disabled：缺少 serverHost/token 或 domain/port 配置。');
    }
  }

  public async ensureConnectivity(nodeId: string, metadata: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (!this.enabled) {
      return undefined;
    }
    const reachability = this.extractRecord(metadata.reachability);
    const existing = this.extractTunnel(metadata.tunnel);
    const directHealthy = this.isDirectHealthy(reachability);

    const prepared = this.prepareTunnel(nodeId, metadata, existing);

    if (directHealthy) {
      if (prepared.status !== 'standby') {
        this.logger.debug(`节点 ${nodeId} 直连可用，保持隧道 standby。`);
      }
      prepared.status = 'standby';
    } else {
      if (prepared.status !== 'active') {
        this.logger.info(`节点 ${nodeId} 直连不可用，激活 frp 隧道 ${prepared.entrypoint ?? prepared.customDomain ?? ''}`);
      }
      prepared.status = 'active';
    }

    prepared.updatedAt = new Date().toISOString();
    return { ...metadata, tunnel: prepared };
  }

  private prepareTunnel(nodeId: string, metadata: Record<string, unknown>, existing?: TunnelMetadata): TunnelMetadata {
    const next: TunnelMetadata = existing ? { ...existing } : { type: 'frp' };
    next.serverHost = this.serverHost;
    next.serverPort = this.serverPort;
    next.protocol = this.protocol;
    next.token = this.token;
    next.proxyName = existing?.proxyName ?? nodeId;
    next.customDomain = this.resolveCustomDomain(nodeId, metadata, existing);
    next.remotePort = this.resolveRemotePort(nodeId, metadata, existing);
    next.entrypoint = this.resolveEntrypoint(next);
    next.config = this.buildConfig(next);
    return next;
  }

  private resolveCustomDomain(nodeId: string, metadata: Record<string, unknown>, existing?: TunnelMetadata): string | undefined {
    if (!this.customDomainSuffix) {
      return existing?.customDomain;
    }
    const dnsSubdomain = this.extractRecord(metadata.dns)?.subdomain;
    const subdomain = this.normalizeSubdomain(dnsSubdomain) ?? this.normalizeSubdomain(existing?.customDomain?.split('.')?.[0]) ?? this.normalizeSubdomain(nodeId);
    if (!subdomain) {
      return existing?.customDomain;
    }
    return `${subdomain}.${this.customDomainSuffix}`;
  }

  private resolveRemotePort(nodeId: string, metadata: Record<string, unknown>, existing?: TunnelMetadata): number | undefined {
    if (this.customDomainSuffix) {
      // 使用自定义域名时无需 remotePort
      return existing?.remotePort;
    }
    if (existing?.remotePort) {
      return existing.remotePort;
    }
    if (this.remotePortBase == null) {
      return undefined;
    }
    const hash = this.hashString(nodeId);
    return this.remotePortBase + (hash * this.remotePortStep);
  }

  private resolveEntrypoint(tunnel: TunnelMetadata): string | undefined {
    if (tunnel.customDomain) {
      return `${this.publicScheme}://${tunnel.customDomain}`;
    }
    if (tunnel.serverHost && tunnel.remotePort) {
      return `${this.publicScheme}://${tunnel.serverHost}:${tunnel.remotePort}`;
    }
    return undefined;
  }

  private buildConfig(tunnel: TunnelMetadata): Record<string, unknown> {
    const config: Record<string, unknown> = {
      serverHost: this.serverHost,
      serverPort: this.serverPort,
      protocol: this.protocol,
      token: this.token,
      proxyName: tunnel.proxyName,
    };
    if (tunnel.customDomain) {
      config.customDomains = [ tunnel.customDomain ];
      config.type = 'http';
    }
    if (tunnel.remotePort) {
      config.remotePort = tunnel.remotePort;
      config.type = this.protocol;
    }
    config.publicUrl = tunnel.entrypoint;
    return config;
  }

  private extractRecord(value: unknown): Record<string, any> | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return value as Record<string, any>;
  }

  private extractTunnel(value: unknown): TunnelMetadata | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as any;
    return { ...record } as TunnelMetadata;
  }

  private isDirectHealthy(reachability?: Record<string, unknown>): boolean {
    if (!reachability) {
      return false;
    }
    const status = typeof reachability.status === 'string' ? reachability.status.trim().toLowerCase() : undefined;
    if (status === 'direct' || status === 'healthy') {
      return true;
    }
    if (status === 'degraded' && typeof reachability.lastSuccessAt === 'string') {
      const last = new Date(reachability.lastSuccessAt);
      const diff = Date.now() - last.getTime();
      return Number.isFinite(diff) && diff < 60_000;
    }
    return false;
  }

  private normalizeString(value?: string | null): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeNumber(value?: number | string | null): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private normalizeSubdomain(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/^-+|-+$/gu, '');
    return sanitized.length > 0 ? sanitized : undefined;
  }

  private hashString(input: string): number {
    let hash = 0;
    for (const char of input) {
      hash = (hash << 5) - hash + char.charCodeAt(0);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
