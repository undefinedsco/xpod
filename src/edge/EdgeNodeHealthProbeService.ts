import { getLoggerFor } from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface EdgeNodeHealthProbeServiceOptions {
  repository?: EdgeNodeRepository;
  identityDbUrl?: string;
  enabled?: boolean | string;
  timeoutMs?: number | string;
}

interface ProbeResult {
  candidate: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
}

export class EdgeNodeHealthProbeService {
  private readonly logger = getLoggerFor(this);
  private readonly repository?: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly timeoutMs: number;

  public constructor(options: EdgeNodeHealthProbeServiceOptions) {
    this.repository = options.repository ?? this.createRepository(options.identityDbUrl);
    this.enabled = this.normalizeBoolean(options.enabled) && Boolean(this.repository);
    this.timeoutMs = this.normalizeTimeout(options.timeoutMs) ?? 3_000;
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
      const result = await this.ping(candidate);
      results.push(result);
    }

    const successful = results.find((item) => item.success);
    const now = new Date();
    const reachability = {
      status: successful ? 'direct' : 'unreachable',
      lastProbeAt: now.toISOString(),
      lastSuccessAt: successful ? now.toISOString() : undefined,
      candidates: results,
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

  private async ping(candidate: string): Promise<ProbeResult> {
    const url = this.toUrl(candidate);
    if (!url) {
      return { candidate, success: false, error: 'invalid-url' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(url.toString(), {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      return {
        candidate,
        success: response.ok,
        latencyMs,
        error: response.ok ? undefined : `status:${response.status}`,
      };
    } catch (error: unknown) {
      clearTimeout(timer);
      return {
        candidate,
        success: false,
        error: (error as Error).message,
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
}
