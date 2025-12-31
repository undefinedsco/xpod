import { getLoggerFor } from 'global-logger-factory';
import type { EdgeNodeTunnelManager } from './interfaces/EdgeNodeTunnelManager';

interface FrpTunnelManagerOptions {
  serverHost?: string | null;
  serverPort?: number | string | null;
  protocol?: string | null;
  token?: string | null;
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
  reason?: string;
}

export class FrpTunnelManager implements EdgeNodeTunnelManager {
  private readonly logger = getLoggerFor(this);
  private readonly enabled: boolean;
  private readonly serverHost?: string;
  private readonly serverPort?: number;
  private readonly protocol: string;
  private readonly token?: string;
  private readonly remotePortBase = 20000;
  private readonly remotePortStep = 17;

  public constructor(options: FrpTunnelManagerOptions) {
    this.serverHost = this.normalizeString(options.serverHost);
    this.serverPort = this.normalizeNumber(options.serverPort);
    this.protocol = this.normalizeString(options.protocol)?.toLowerCase() ?? 'tcp';
    this.token = this.normalizeString(options.token);
    this.enabled = Boolean(this.serverHost && this.token);
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
    const directHealthy = this.isRedirectHealthy(reachability);

    const prepared = this.prepareTunnel(nodeId, metadata, existing);

    if (prepared.status === 'unreachable') {
      this.logger.warn(`节点 ${nodeId} 隧道不可用：${prepared.reason ?? '未知原因'}`);
      return { ...metadata, tunnel: prepared };
    }

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
    if (!this.serverHost || !this.serverPort || !this.token) {
      next.status = 'unreachable';
      next.reason = 'FRP server config missing';
      return next;
    }
    next.remotePort = this.resolveRemotePort(nodeId, metadata, existing);
    next.entrypoint = this.resolveEntrypoint(next);
    next.config = this.buildConfig(next);
    return next;
  }

  private resolveRemotePort(nodeId: string, metadata: Record<string, unknown>, existing?: TunnelMetadata): number | undefined {
    if (existing?.remotePort) {
      return existing.remotePort;
    }
    const hash = this.hashString(nodeId);
    return this.remotePortBase + ((hash % 1000) * this.remotePortStep);
  }

  private resolveEntrypoint(tunnel: TunnelMetadata): string | undefined {
    if (tunnel.serverHost && tunnel.remotePort) {
      return `https://${tunnel.serverHost}:${tunnel.remotePort}`;
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
    if (!tunnel.entrypoint) {
      config.error = 'FRP entrypoint not resolved';
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

  private isRedirectHealthy(reachability?: Record<string, unknown>): boolean {
    if (!reachability) {
      return false;
    }
    const status = typeof reachability.status === 'string' ? reachability.status.trim().toLowerCase() : undefined;
    if (status === 'redirect' || status === 'healthy') {
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

  private hashString(input: string): number {
    let hash = 0;
    for (const char of input) {
      hash = (hash << 5) - hash + char.charCodeAt(0);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}
