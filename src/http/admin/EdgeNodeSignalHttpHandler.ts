import type { IncomingMessage } from 'node:http';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  InternalServerError,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  UnauthorizedHttpError,
  getLoggerFor,
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import type { EdgeNodeCertificateProvisioner } from '../../edge/EdgeNodeCertificateProvisioner';
import type { EdgeNodeTunnelManager } from '../../edge/EdgeNodeTunnelManager';
import type { EdgeNodeHealthProbeService } from '../../edge/EdgeNodeHealthProbeService';

interface EdgeNodeSignalHttpHandlerOptions {
  identityDbUrl: string;
  basePath?: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  dnsCoordinator?: EdgeNodeDnsCoordinator;
  certificateProvisioner?: EdgeNodeCertificateProvisioner;
  tunnelManager?: EdgeNodeTunnelManager;
  healthProbeService?: EdgeNodeHealthProbeService;
}

interface EdgeNodeSignalPayload {
  nodeId: string;
  token: string;
  baseUrl?: string;
  publicAddress?: string;
  hostname?: string;
  ipv4?: string;
  ipv6?: string;
  version?: string;
  status?: string;
  capabilities?: string[];
  pods?: string[];
  reachability?: Record<string, unknown>;
  directCandidates?: string[];
  tunnel?: Record<string, unknown>;
  certificate?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

type EdgeNodeMetadata = Record<string, unknown>;

export class EdgeNodeSignalHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repo: EdgeNodeRepository;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly enabled: boolean;
  private readonly dnsCoordinator?: EdgeNodeDnsCoordinator;
  private readonly certificateProvisioner?: EdgeNodeCertificateProvisioner;
  private readonly tunnelManager?: EdgeNodeTunnelManager;
  private readonly healthProbeService?: EdgeNodeHealthProbeService;

  public constructor(options: EdgeNodeSignalHttpHandlerOptions) {
    super();
    this.repo = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.basePath = this.normalizeBasePath(options.basePath ?? '/api/signal');
    this.basePathWithSlash = `${this.basePath}/`;
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.dnsCoordinator = options.dnsCoordinator;
    this.certificateProvisioner = options.certificateProvisioner;
    this.tunnelManager = options.tunnelManager;
    this.healthProbeService = options.healthProbeService;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Edge node signaling is disabled.');
    }
    const pathname = this.parseUrl(request).pathname;
    if (!this.matchesBase(pathname)) {
      throw new NotImplementedHttpError('Not an edge node signaling request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }
    if (method !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST', 'OPTIONS' ]);
    }

    const url = this.parseUrl(request);
    const relative = this.toRelative(url.pathname);
    if (relative !== '') {
      throw new NotImplementedHttpError('Unknown signal endpoint.');
    }

    const payload = await this.readPayload(request);
    const now = new Date();
    const secret = await this.repo.getNodeSecret(payload.nodeId);
    if (!secret || !secret.tokenHash || !this.repo.matchesToken(secret.tokenHash, payload.token)) {
      throw new UnauthorizedHttpError('Edge node authentication failed.');
    }

    let merged = this.mergeMetadata((secret.metadata ?? {}) as EdgeNodeMetadata, payload, now);
    if (this.tunnelManager) {
      const enriched = await this.tunnelManager.ensureConnectivity(secret.nodeId, merged);
      if (enriched) {
        merged = enriched;
      }
    }

    try {
      await this.repo.updateNodeHeartbeat(secret.nodeId, merged, now);
      if (payload.pods !== undefined) {
        await this.repo.replaceNodePods(secret.nodeId, payload.pods);
      }
      if (this.dnsCoordinator) {
        await this.dnsCoordinator.synchronize(secret.nodeId, merged);
      }
      if (this.certificateProvisioner) {
        await this.certificateProvisioner.handleCertificateRequest(secret.nodeId, merged);
      }
      if (this.healthProbeService) {
        await this.healthProbeService.probeNode(secret.nodeId);
      }
    } catch (error: unknown) {
      this.logger.error(`Failed to update node heartbeat: ${(error as Error).message}`);
      throw new InternalServerError('Failed to record edge node status.', { cause: error });
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({
      status: 'ok',
      nodeId: secret.nodeId,
      lastSeen: now.toISOString(),
      metadata: merged,
    }));
  }

  private async readPayload(request: IncomingMessage): Promise<EdgeNodeSignalPayload> {
    const body = await this.readBody(request);
    if (!body) {
      throw new BadRequestHttpError('信令上报必须包含 JSON 请求体。');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error: unknown) {
      throw new BadRequestHttpError('信令上报体必须是有效 JSON。', { cause: error });
    }
    if (payload == null || typeof payload !== 'object') {
      throw new BadRequestHttpError('信令上报体必须是 JSON 对象。');
    }

    const data = payload as Record<string, unknown>;
    const nodeId = this.requireString(data.nodeId, 'nodeId');
    const token = this.requireString(data.token, 'token');

    return {
      nodeId,
      token,
      baseUrl: this.optionalUrl(data.baseUrl),
      publicAddress: this.optionalUrl(data.publicAddress),
      hostname: this.optionalString(data.hostname),
      ipv4: this.optionalIP(data.ipv4),
      ipv6: this.optionalIP(data.ipv6),
      version: this.optionalString(data.version),
      status: this.optionalStatus(data.status),
      capabilities: this.optionalCapabilities(data.capabilities),
      pods: this.optionalPods(data.pods),
      reachability: this.optionalRecord(data.reachability, 'reachability'),
      directCandidates: this.optionalUrlList(data.directCandidates, 'directCandidates'),
      tunnel: this.optionalRecord(data.tunnel, 'tunnel'),
      certificate: this.optionalRecord(data.certificate, 'certificate'),
      metrics: this.optionalRecord(data.metrics, 'metrics'),
      metadata: this.optionalRecord(data.metadata, 'metadata'),
    };
  }

  private optionalCapabilities(input: unknown): string[] | undefined {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const items = input.map((value) => typeof value === 'string' ? value.trim() : '').filter((value) => value.length > 0);
    const unique = Array.from(new Set(items));
    return unique.length > 0 ? unique : undefined;
  }

  private optionalStatus(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : undefined;
  }

  private mergeMetadata(previous: EdgeNodeMetadata, payload: EdgeNodeSignalPayload, now: Date): EdgeNodeMetadata {
    const next: EdgeNodeMetadata = { ...previous };
    next.lastHeartbeatAt = now.toISOString();
    if (payload.baseUrl) {
      next.baseUrl = payload.baseUrl;
    }
    if (payload.publicAddress) {
      next.publicAddress = payload.publicAddress;
    }
    if (payload.hostname) {
      next.hostname = payload.hostname;
    }
    if (payload.ipv4) {
      next.ipv4 = payload.ipv4;
    }
    if (payload.ipv6) {
      next.ipv6 = payload.ipv6;
    }
    if (payload.version) {
      next.version = payload.version;
    }
    if (payload.status) {
      next.status = payload.status;
    }
    if (payload.capabilities) {
      next.capabilities = payload.capabilities;
    }
    if (payload.pods) {
      next.pods = payload.pods;
    }
    if (payload.reachability) {
      next.reachability = this.mergeRecord(next.reachability, payload.reachability);
      next.reachabilityUpdatedAt = now.toISOString();
    }
    if (payload.directCandidates) {
      next.directCandidates = this.uniqueList(payload.directCandidates);
    }
    if (payload.tunnel) {
      next.tunnel = this.mergeRecord(next.tunnel, payload.tunnel);
    }
    if (payload.certificate) {
      next.certificate = this.mergeRecord(next.certificate, payload.certificate);
    }
    if (payload.metrics) {
      next.metrics = payload.metrics;
      next.metricsUpdatedAt = now.toISOString();
    }
    if (payload.metadata) {
      const previousExtra = this.asRecord(next.extra);
      next.extra = { ...previousExtra, ...payload.metadata };
    }
    return next;
  }

  private writeOptions(response: HttpResponse): void {
    response.statusCode = 204;
    response.setHeader('Allow', 'POST,OPTIONS');
    response.end();
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let data = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        data += chunk;
      });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private optionalUrl(value: unknown): string | undefined {
    const candidate = this.optionalString(value);
    if (!candidate) {
      return undefined;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }

  private optionalIP(value: unknown): string | undefined {
    const candidate = this.optionalString(value);
    if (!candidate) {
      return undefined;
    }
    const ipRegex = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/u;
    return ipRegex.test(candidate) ? candidate : undefined;
  }

  private optionalPods(value: unknown): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new BadRequestHttpError('pods 必须是字符串数组。');
    }
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }
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
        this.logger.warn(`忽略无效 pod 基址: ${trimmed}`);
      }
    }
    return result;
  }

  private optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestHttpError(`${field} 必须是 JSON 对象。`);
    }
    return value as Record<string, unknown>;
  }

  private optionalUrlList(value: unknown, field: string): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new BadRequestHttpError(`${field} 必须是字符串数组。`);
    }
    const result: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        continue;
      }
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
        this.logger.warn(`忽略无效 ${field} 候选: ${trimmed}`);
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private mergeRecord(current: unknown, update: Record<string, unknown>): Record<string, unknown> {
    const base = this.asRecord(current);
    return { ...base, ...update };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private uniqueList(list: string[]): string[] {
    return Array.from(new Set(list));
  }


  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestHttpError(`${field} 必须是字符串。`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestHttpError(`${field} 不能为空。`);
    }
    return trimmed;
  }

  private matchesBase(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private toRelative(pathname: string): string | null {
    if (pathname === this.basePath) {
      return '';
    }
    if (!pathname.startsWith(this.basePathWithSlash)) {
      return null;
    }
    return pathname.slice(this.basePathWithSlash.length);
  }

  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  private normalizeBasePath(input: string): string {
    if (!input.startsWith('/')) {
      throw new BadRequestHttpError('Signal base path must start with /.');
    }
    return input.endsWith('/') ? input.slice(0, -1) : input;
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
}
