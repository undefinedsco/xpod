import { getLoggerFor } from '@solid/community-server';

export interface EdgeNodeTunnelManager {
  /**
   * 根据当前 metadata 判断是否需要建立/更新隧道，当返回对象时表示需要写回 metadata。
   */
  ensureConnectivity(nodeId: string, metadata: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
}

interface SimpleEdgeNodeTunnelManagerOptions {
  /** 当直连失败时兜底的入口地址列表。 */
  entrypoints?: string | string[] | null;
  /** 是否默认启用隧道。 */
  enabled?: boolean;
}

export class SimpleEdgeNodeTunnelManager implements EdgeNodeTunnelManager {
  private readonly logger = getLoggerFor(this);
  private readonly entrypoints: string[];
  private readonly enabled: boolean;

  public constructor(options: SimpleEdgeNodeTunnelManagerOptions) {
    this.entrypoints = this.normalizeEntrypoints(options.entrypoints);
    this.enabled = options.enabled ?? this.entrypoints.length > 0;
  }

  public async ensureConnectivity(nodeId: string, metadata: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (!this.enabled || this.entrypoints.length === 0) {
      return undefined;
    }

    const reachability = this.extractRecord((metadata as any).reachability);
    const tunnel = this.extractRecord((metadata as any).tunnel);

    const directStatus = typeof reachability?.status === 'string' ? reachability.status : undefined;
    const directHealthy = this.isDirectHealthy(directStatus, reachability);

    if (directHealthy) {
      if (tunnel?.status === 'active') {
        const next = { ...metadata, tunnel: { ...tunnel, status: 'standby', updatedAt: new Date().toISOString() } };
        this.logger.debug(`节点 ${nodeId} 直连恢复，将隧道标记为 standby。`);
        return next;
      }
      return undefined;
    }

    const entrypoint = this.selectEntrypoint(nodeId, tunnel);
    if (!entrypoint) {
      return undefined;
    }

    if (tunnel?.status === 'active' && tunnel.entrypoint === entrypoint) {
      return undefined;
    }

    const nextTunnel = {
      status: 'active',
      entrypoint,
      updatedAt: new Date().toISOString(),
    };
    this.logger.info(`节点 ${nodeId} 直连不可达，启用隧道入口 ${entrypoint}`);
    return { ...metadata, tunnel: nextTunnel };
  }

  private selectEntrypoint(nodeId: string, tunnel?: Record<string, unknown>): string | undefined {
    if (tunnel?.entrypoint && typeof tunnel.entrypoint === 'string') {
      return tunnel.entrypoint;
    }
    if (this.entrypoints.length === 1) {
      return this.entrypoints[0];
    }
    const hash = this.hashString(nodeId);
    const index = hash % this.entrypoints.length;
    return this.entrypoints[index];
  }

  private hashString(value: string): number {
    let hash = 0;
    for (const char of value) {
      hash = (hash << 5) - hash + char.charCodeAt(0);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  private extractRecord(value: unknown): Record<string, any> | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return value as Record<string, any>;
  }

  private isDirectHealthy(status?: string, reachability?: Record<string, unknown>): boolean {
    if (!status) {
      return false;
    }
    const normalized = status.trim().toLowerCase();
    if (normalized === 'direct' || normalized === 'healthy') {
      return true;
    }
    if (normalized === 'degraded' && typeof reachability?.lastSuccessAt === 'string') {
      const last = new Date(reachability.lastSuccessAt);
      const diff = Date.now() - last.getTime();
      return Number.isFinite(diff) && diff < 60_000;
    }
    return false;
  }

  private normalizeEntrypoints(input?: string | string[] | null): string[] {
    if (!input) {
      return [];
    }
    const list = Array.isArray(input) ? input : input.split(/[,\s]+/u);
    return list
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
}

export class NoopEdgeNodeTunnelManager implements EdgeNodeTunnelManager {
  public async ensureConnectivity(): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }
}
