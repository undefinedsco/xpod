import { getLoggerFor } from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface EdgeNodeHealthProbeServiceOptions {
  repository?: EdgeNodeRepository;
  identityDbUrl?: string;
  enabled?: boolean | string;
  timeoutMs?: number | string;
  locations?: string | string[];
}

interface ProbeResult {
  location: string;
  candidate: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: string;
}

interface ProbeLocation {
  name: string;
  endpoint?: string;
}

export class EdgeNodeHealthProbeService {
  private readonly logger = getLoggerFor(this);
  private readonly repository?: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly locations: ProbeLocation[];

  public constructor(options: EdgeNodeHealthProbeServiceOptions) {
    this.repository = options.repository ?? this.createRepository(options.identityDbUrl);
    this.enabled = this.normalizeBoolean(options.enabled) && Boolean(this.repository);
    this.timeoutMs = this.normalizeTimeout(options.timeoutMs) ?? 3_000;
    this.locations = this.normalizeLocations(options.locations);
  }

  public async probeNode(nodeId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const node = await this.repository!.getNodeMetadata(nodeId);
    if (!node?.metadata) {
      this.logger.debug(`节点 ${nodeId} 无 metadata，跳过探测。`);
      return;
    }
    const metadata = node.metadata as Record<string, unknown>;
    const candidates = this.collectCandidates(metadata);
    if (candidates.length === 0) {
      this.logger.debug(`节点 ${nodeId} 没有可探测的候选地址。`);
      return;
    }

    const results: ProbeResult[] = [];
    for (const candidate of candidates) {
      for (const location of this.locations) {
        const result = await this.ping(candidate, location);
        results.push(result);
      }
    }

    const successful = results.find((item) => item.success);
    const clusterSuccess = results.some((item) => item.location === 'cluster' && item.success);
    const status = clusterSuccess ? 'direct' : successful ? 'degraded' : 'unreachable';
    const now = new Date();
    const reachability = {
      status,
      lastProbeAt: now.toISOString(),
      lastSuccessAt: successful ? successful.checkedAt : undefined,
      samples: results,
    };

    await this.repository!.mergeNodeMetadata(nodeId, { reachability });
  }

  private collectCandidates(metadata: Record<string, unknown>): string[] {
    const candidates = new Set<string>();
    const direct = (metadata.directCandidates as string[] | undefined) ?? [];
    for (const candidate of direct) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        candidates.add(candidate.trim());
      }
    }
    if (typeof metadata.publicAddress === 'string') {
      candidates.add(metadata.publicAddress.trim());
    }
    if (typeof metadata.baseUrl === 'string') {
      candidates.add(metadata.baseUrl.trim());
    }
    return Array.from(candidates);
  }

  private async ping(candidate: string, location: ProbeLocation): Promise<ProbeResult> {
    const url = this.toUrl(candidate);
    if (!url) {
      return { candidate, success: false, error: 'invalid-url', location: location.name, checkedAt: new Date().toISOString() };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      if (location.endpoint) {
        const probeUrl = new URL(location.endpoint);
        probeUrl.searchParams.set('target', url.toString());
        const response = await fetch(probeUrl.toString(), {
          method: 'GET',
          signal: controller.signal,
          headers: { 'accept': 'application/json' },
        });
        clearTimeout(timer);
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          return {
            candidate,
            location: location.name,
            success: false,
            latencyMs,
            error: `status:${response.status}`,
            checkedAt: new Date().toISOString(),
          };
        }
        try {
          const data = await response.json() as Partial<ProbeResult>;
          return {
            candidate,
            location: location.name,
            success: Boolean(data.success),
            latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : latencyMs,
            error: data.error,
            checkedAt: data.checkedAt ?? new Date().toISOString(),
          };
        } catch (error: unknown) {
          return {
            candidate,
            location: location.name,
            success: false,
            latencyMs,
            error: `invalid-json:${(error as Error).message}`,
            checkedAt: new Date().toISOString(),
          };
        }
      }
      const response = await fetch(url.toString(), {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      return {
        candidate,
        location: location.name,
        success: response.ok,
        latencyMs,
        error: response.ok ? undefined : `status:${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      clearTimeout(timer);
      return {
        candidate,
        location: location.name,
        success: false,
        error: (error as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private toUrl(value: string): URL | undefined {
    try {
      return new URL(value);
    } catch {
      try {
        return new URL(`https://${value}`);
      } catch {
        return undefined;
      }
    }
  }

  private createRepository(identityDbUrl?: string): EdgeNodeRepository | undefined {
    if (!identityDbUrl) {
      return undefined;
    }
    const db = getIdentityDatabase(identityDbUrl);
    return new EdgeNodeRepository(db);
  }

  private normalizeBoolean(value?: boolean | string): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  }

  private normalizeTimeout(value?: number | string): number | undefined {
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

  private normalizeLocations(value?: string | string[]): ProbeLocation[] {
    const defaultLocation: ProbeLocation = { name: 'cluster' };
    if (value === undefined) {
      return [ defaultLocation ];
    }
    const input = Array.isArray(value) ? value : value.split(/[,;\n]+/u);
    const result: ProbeLocation[] = [];
    for (const entry of input) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const [ namePart, endpointPart ] = trimmed.split('@', 2);
      const name = namePart.trim() || 'cluster';
      const endpoint = endpointPart?.trim();
      result.push({
        name,
        endpoint: endpoint?.length ? endpoint : undefined,
      });
    }
    return result.length > 0 ? result : [ defaultLocation ];
  }
}
