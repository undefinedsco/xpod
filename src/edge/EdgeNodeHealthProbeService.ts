import { getLoggerFor } from 'global-logger-factory';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';
import {
  assertPublicProbeTarget,
  createPinnedHeadProbeRequest,
  type HeadProbeRequest,
  type ResolveAddresses,
} from './ProbeTargetGuard';

interface EdgeNodeHealthProbeServiceOptions {
  repository?: EdgeNodeRepository;
  identityDbUrl?: string;
  enabled?: boolean | string;
  timeoutMs?: number | string;
  locations?: string | string[];
  /** DNS resolution used to validate probe targets; injected in tests. */
  resolveAddresses?: ResolveAddresses;
  /** Transport for the direct HEAD probe; injected in tests. */
  headRequest?: HeadProbeRequest;
  /** Redirect hops followed while re-validating every target. */
  maxRedirects?: number;
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
  private readonly resolveAddresses?: ResolveAddresses;
  private readonly headRequest: HeadProbeRequest;
  private readonly maxRedirects: number;

  public constructor(options: EdgeNodeHealthProbeServiceOptions) {
    this.repository = options.repository ?? this.createRepository(options.identityDbUrl);
    this.enabled = this.normalizeBoolean(options.enabled) && Boolean(this.repository);
    this.timeoutMs = this.normalizeTimeout(options.timeoutMs) ?? 3_000;
    this.locations = this.normalizeLocations(options.locations);
    this.resolveAddresses = options.resolveAddresses;
    this.headRequest = options.headRequest ?? createPinnedHeadProbeRequest();
    this.maxRedirects = Math.max(0, Math.trunc(options.maxRedirects ?? 3));
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
    const tunnelEntrypoint = this.extractTunnelEntrypoint(metadata.tunnel) ?? this.extractManagedTunnelEndpoint(metadata.managedTunnel);
    if (tunnelEntrypoint) {
      candidates.add(tunnelEntrypoint);
    }
    if (typeof metadata.baseUrl === 'string') {
      candidates.add(metadata.baseUrl.trim());
    }
    return Array.from(candidates);
  }

  private extractTunnelEntrypoint(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return this.extractNonEmptyString((value as Record<string, unknown>).entrypoint);
  }

  private extractManagedTunnelEndpoint(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    return this.extractNonEmptyString((value as Record<string, unknown>).endpoint);
  }

  private extractNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private async ping(candidate: string, location: ProbeLocation): Promise<ProbeResult> {
    const url = this.toUrl(candidate);
    if (!url) {
      return { candidate, success: false, error: 'invalid-url', location: location.name, checkedAt: new Date().toISOString() };
    }

    // The candidate comes from node metadata, so Cloud only contacts public targets:
    // private, loopback, link-local and metadata addresses stay with clients that can
    // actually reach them.
    const decision = await assertPublicProbeTarget(url, this.resolveAddresses);
    if (!decision.allowed) {
      this.logger.debug(`跳过非公网探测目标 ${candidate}: ${decision.reason}`);
      return {
        candidate,
        success: false,
        error: `blocked-target:${decision.reason}`,
        location: location.name,
        checkedAt: new Date().toISOString(),
      };
    }

    const started = Date.now();
    try {
      if (location.endpoint) {
        const probeUrl = new URL(location.endpoint);
        probeUrl.searchParams.set('target', url.toString());
        const response = await fetch(probeUrl.toString(), {
          method: 'GET',
          headers: { 'accept': 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
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

      const probe = await this.probePublicCandidate(url, decision.address);
      const latencyMs = Date.now() - started;
      return {
        candidate,
        location: location.name,
        success: probe.status >= 200 && probe.status < 400,
        latencyMs,
        error: probe.error ?? (probe.status >= 200 && probe.status < 400 ? undefined : `status:${probe.status}`),
        checkedAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      return {
        candidate,
        location: location.name,
        success: false,
        error: (error as Error).message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Follows redirects by hand so every hop is validated again: a public entry point must
   * not be able to bounce the probe into a private address.
   */
  private async probePublicCandidate(
    startUrl: URL,
    startAddress: string,
  ): Promise<{ status: number; error?: string }> {
    let url = startUrl;
    let address = startAddress;
    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const response = await this.headRequest(url, { address, timeoutMs: this.timeoutMs });
      if (response.status < 300 || response.status >= 400 || !response.location) {
        return { status: response.status };
      }
      const next = new URL(response.location, url);
      const decision = await assertPublicProbeTarget(next, this.resolveAddresses);
      if (!decision.allowed) {
        return { status: 0, error: `blocked-redirect:${decision.reason}` };
      }
      url = next;
      address = decision.address;
    }
    return { status: 0, error: 'blocked-redirect:too-many-redirects' };
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
