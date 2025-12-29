import { getLoggerFor } from 'global-logger-factory';

export interface EdgeNodeHeartbeatServiceOptions {
  edgeNodesEnabled?: string | boolean;
  signalEndpoint?: string;
  nodeId?: string;
  nodeToken?: string;
  baseUrl?: string;
  publicAddress?: string;
  pods?: string | string[];
  capabilities?: string | string[];
  reachability?: string;
  directCandidates?: string | string[];
  tunnel?: string;
  certificate?: string;
  metrics?: string;
  metadata?: string;
  intervalMs?: number | string;
  onHeartbeatResponse?: (data: unknown) => void;
  metadataSupplier?: () => Record<string, unknown> | undefined;
  metricsSupplier?: () => Record<string, unknown> | undefined;
  tunnelSupplier?: () => Record<string, unknown> | undefined;
}

type HeartbeatPayload = {
  nodeId: string;
  token: string;
  baseUrl?: string;
  publicAddress?: string;
  pods?: string[];
  capabilities?: string[];
  reachability?: Record<string, unknown>;
  directCandidates?: string[];
  tunnel?: Record<string, unknown>;
  certificate?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export class EdgeNodeHeartbeatService {
  private readonly logger = getLoggerFor(this);
  private readonly interval?: NodeJS.Timeout;
  private readonly endpoint?: string;
  private readonly baseNodeId?: string;
  private readonly baseToken?: string;
  private readonly baseUrl?: string;
  private readonly publicAddress?: string;
  private readonly basePods?: string[];
  private readonly baseCapabilities?: string[];
  private readonly baseReachability?: Record<string, unknown>;
  private readonly baseDirectCandidates?: string[];
  private readonly baseTunnel?: Record<string, unknown>;
  private readonly baseCertificate?: Record<string, unknown>;
  private readonly baseMetrics?: Record<string, unknown>;
  private readonly baseMetadata?: Record<string, unknown>;
  private readonly tunnelSupplier?: () => Record<string, unknown> | undefined;
  private readonly metricsSupplier?: () => Record<string, unknown> | undefined;
  private readonly metadataSupplier?: () => Record<string, unknown> | undefined;
  private readonly intervalMs: number = 30_000;
  private readonly onHeartbeatResponse?: (data: unknown) => void;

  public constructor(options: EdgeNodeHeartbeatServiceOptions) {
    const enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    const endpoint = this.normalizeString(options.signalEndpoint);
    const nodeId = this.normalizeString(options.nodeId);
    const nodeToken = this.normalizeString(options.nodeToken);

    if (!enabled) {
      this.logger.debug('Edge node heartbeat service disabled.');
      return;
    }

    if (!endpoint || !nodeId || !nodeToken) {
      this.logger.warn('Edge node heartbeat service missing configuration (signal endpoint, nodeId, nodeToken).');
      return;
    }

    this.intervalMs = this.normalizeInterval(options.intervalMs) ?? this.intervalMs;
    this.endpoint = endpoint;
    this.onHeartbeatResponse = options.onHeartbeatResponse;
    this.metadataSupplier = options.metadataSupplier;
    this.metricsSupplier = options.metricsSupplier;
    this.tunnelSupplier = options.tunnelSupplier;

    this.baseNodeId = nodeId;
    this.baseToken = nodeToken;
    this.baseUrl = this.normalizeString(options.baseUrl);
    this.publicAddress = this.normalizeString(options.publicAddress);
    this.basePods = this.normalizePods(options.pods);
    this.baseCapabilities = this.normalizeStringArray(options.capabilities);
    this.baseReachability = this.normalizeJsonRecord(options.reachability, 'reachability');
    this.baseDirectCandidates = this.normalizeCandidates(options.directCandidates);
    this.baseTunnel = this.normalizeJsonRecord(options.tunnel, 'tunnel');
    this.baseCertificate = this.normalizeJsonRecord(options.certificate, 'certificate');
    this.baseMetrics = this.normalizeJsonRecord(options.metrics, 'metrics');
    this.baseMetadata = this.normalizeJsonRecord(options.metadata, 'metadata');

    void this.sendHeartbeat();
    if (this.intervalMs > 0) {
      this.interval = setInterval(() => {
        void this.sendHeartbeat();
      }, this.intervalMs);
    }
  }

  public dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.endpoint || !this.baseNodeId || !this.baseToken) {
      return;
    }

    const payload: Record<string, unknown> = this.buildPayload();

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.logger.warn(`Edge node heartbeat failed: ${response.status} ${response.statusText}`);
      } else {
        this.logger.debug('Edge node heartbeat sent successfully.');
        await this.handleHeartbeatResponse(response);
      }
    } catch (error: unknown) {
      this.logger.error(`Edge node heartbeat error: ${(error as Error).message}`);
    }
  }

  private buildPayload(): HeartbeatPayload {
    const payload: HeartbeatPayload = {
      nodeId: this.baseNodeId!,
      token: this.baseToken!,
    };

    if (this.baseUrl) {
      payload.baseUrl = this.baseUrl;
    }
    if (this.publicAddress) {
      payload.publicAddress = this.publicAddress;
    }
    if (this.basePods && this.basePods.length > 0) {
      payload.pods = [ ...this.basePods ];
    }
    if (this.baseCapabilities && this.baseCapabilities.length > 0) {
      payload.capabilities = [ ...this.baseCapabilities ];
    }
    const reachability = this.mergeRecords(this.baseReachability, undefined);
    if (reachability && Object.keys(reachability).length > 0) {
      payload.reachability = reachability;
    }
    const directCandidates = this.baseDirectCandidates;
    if (directCandidates && directCandidates.length > 0) {
      payload.directCandidates = [ ...directCandidates ];
    }
    const tunnel = this.mergeRecords(this.baseTunnel, this.tunnelSupplier?.());
    if (tunnel && Object.keys(tunnel).length > 0) {
      payload.tunnel = tunnel;
    }
    const certificate = this.mergeRecords(this.baseCertificate, undefined);
    if (certificate && Object.keys(certificate).length > 0) {
      payload.certificate = certificate;
    }
    const metrics = this.mergeRecords(this.baseMetrics, this.metricsSupplier?.());
    if (metrics && Object.keys(metrics).length > 0) {
      payload.metrics = metrics;
    }
    const metadata = this.mergeRecords(this.baseMetadata, this.metadataSupplier?.());
    if (metadata && Object.keys(metadata).length > 0) {
      payload.metadata = metadata;
    }
    return payload;
  }

  private async handleHeartbeatResponse(response: Response): Promise<void> {
    if (!this.onHeartbeatResponse) {
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return;
    }
    try {
      const data = await response.json();
      this.onHeartbeatResponse(data);
    } catch (error: unknown) {
      this.logger.warn(`解析心跳响应 JSON 失败: ${(error as Error).message}`);
    }
  }

  private mergeRecords(base?: Record<string, unknown>, extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!base && !extra) {
      return undefined;
    }
    return { ...(base ?? {}), ...(extra ?? {}) };
  }

  private normalizeBoolean(value?: string | boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  }

  private normalizeString(value?: string): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeInterval(value?: number | string): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return undefined;
  }

  private normalizePods(value?: string | string[]): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    const source = Array.isArray(value) ? value : value.split(/[\n,]+/u);
    const pods = source
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        try {
          return new URL(entry).toString();
        } catch {
          this.logger.warn(`忽略无效的 Pod 基址: ${entry}`);
          return undefined;
        }
      })
      .filter((entry): entry is string => typeof entry === 'string');
    return pods.length > 0 ? pods : undefined;
  }

  private normalizeStringArray(value?: string | string[]): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    const source = Array.isArray(value) ? value : value.split(/[\n,]+/u);
    const items = source
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return items.length > 0 ? Array.from(new Set(items)) : undefined;
  }

  private normalizeJsonRecord(value: string | undefined, field: string): Record<string, unknown> | undefined {
    if (!value) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.logger.warn(`忽略 ${field}：需要 JSON 对象。`);
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch (error: unknown) {
      this.logger.warn(`无法解析 ${field} JSON：${(error as Error).message}`);
      return undefined;
    }
  }

  private normalizeCandidates(value?: string | string[]): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    const source = Array.isArray(value) ? value : value.split(/[\n,]+/u);
    const result: string[] = [];
    for (const entry of source) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const normalized = new URL(trimmed).toString();
        if (!result.includes(normalized)) {
          result.push(normalized);
        }
      } catch {
        this.logger.warn(`忽略无效的候选地址: ${trimmed}`);
      }
    }
    return result.length > 0 ? result : undefined;
  }
}
