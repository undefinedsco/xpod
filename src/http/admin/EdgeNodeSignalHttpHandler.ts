import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  InternalServerError,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  UnauthorizedHttpError,
  
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import type { EdgeNodeDnsCoordinator } from '../../edge/EdgeNodeDnsCoordinator';
import type { EdgeNodeCertificateProvisioner } from '../../edge/EdgeNodeCertificateProvisioner';
import type { EdgeNodeTunnelManager } from '../../edge/interfaces/EdgeNodeTunnelManager';
import type { EdgeNodeHealthProbeService } from '../../edge/EdgeNodeHealthProbeService';
import { EdgeNodeModeDetector, type NodeRegistrationInfo, type NodeCapabilities } from '../../edge/EdgeNodeModeDetector';
import { EdgeNodeCapabilityDetector } from '../../edge/EdgeNodeCapabilityDetector';

interface EdgeNodeSignalHttpHandlerOptions {
  identityDbUrl: string;
  basePath?: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  dnsCoordinator?: EdgeNodeDnsCoordinator;
  certificateProvisioner?: EdgeNodeCertificateProvisioner;
  tunnelManager?: EdgeNodeTunnelManager;
  healthProbeService?: EdgeNodeHealthProbeService;
  modeDetector?: EdgeNodeModeDetector;
  capabilityDetector?: EdgeNodeCapabilityDetector;
  clusterBaseDomain?: string;
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
  private readonly modeDetector?: EdgeNodeModeDetector;
  private readonly capabilityDetector?: EdgeNodeCapabilityDetector;

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
    this.modeDetector = options.modeDetector ?? (options.clusterBaseDomain ? 
      new EdgeNodeModeDetector({ baseDomain: options.clusterBaseDomain }) : 
      undefined);
    this.capabilityDetector = options.capabilityDetector;
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
    try {
      await this.handleRequest(request, response);
    } catch (error: unknown) {
      this.writeError(response, error);
    }
  }

  private async handleRequest(request: HttpHandlerInput['request'], response: HttpResponse): Promise<void> {
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

    let merged = await this.mergeMetadata((secret.metadata ?? {}) as EdgeNodeMetadata, payload, now);
    if (this.tunnelManager) {
      const enriched = await this.tunnelManager.ensureConnectivity(secret.nodeId, merged);
      if (enriched) {
        merged = enriched;
      }
    }

    // Perform mode detection and update if necessary
    const fallbackPublicIp = this.optionalString(payload.ipv4) ??
      this.optionalString(merged.ipv4) ??
      this.optionalString(merged.publicIp);

    const connectivityInfo = await this.repo.getNodeConnectivityInfo(payload.nodeId);

    // 提取 IPv6 地址
    const ipv6Address = this.optionalString(payload.ipv6) ?? this.optionalString(merged.ipv6);
    
    if (this.modeDetector && (fallbackPublicIp || ipv6Address)) {
      const nodeRegistrationInfo: NodeRegistrationInfo = {
        nodeId: payload.nodeId,
        publicIp: fallbackPublicIp,
        publicIpv6: ipv6Address,
        publicPort: this.extractPortNumber(payload.publicAddress || merged.publicAddress),
        capabilities: this.buildNodeCapabilities(payload, merged),
      };

      const currentConnectivity = connectivityInfo;
      
      // Perform initial mode detection or recheck if in proxy mode
      let modeResult;
      const normalizedCurrentMode = this.normalizeAccessMode(currentConnectivity?.accessMode);
      if (!normalizedCurrentMode) {
        // Initial registration - perform full mode detection
        modeResult = await this.modeDetector.detectMode(nodeRegistrationInfo);
        this.logger.info(`Initial mode detection for node ${payload.nodeId}: ${modeResult.accessMode} (${modeResult.reason})`);
      } else if (normalizedCurrentMode === 'proxy') {
        // Periodic recheck for proxy nodes to see if they can switch to redirect mode
        modeResult = await this.modeDetector.recheckMode(normalizedCurrentMode, nodeRegistrationInfo);
        if (modeResult) {
          this.logger.info(`Mode transition for node ${payload.nodeId}: ${normalizedCurrentMode} -> ${modeResult.accessMode} (${modeResult.reason})`);
        }
      }

      // Update database with mode information if detection was performed
      if (modeResult) {
        await this.repo.updateNodeMode(payload.nodeId, {
          accessMode: modeResult.accessMode,
          publicIp: nodeRegistrationInfo.publicIp,
          publicPort: nodeRegistrationInfo.publicPort,
          subdomain: modeResult.subdomain,
          connectivityStatus: modeResult.connectivityTest?.success === true ? 'reachable' : 
                             modeResult.connectivityTest?.success === false ? 'unreachable' : 'unknown',
          capabilities: nodeRegistrationInfo.capabilities as Record<string, unknown>,
        });

        // Store mode information in merged metadata for coordinator services
        merged.accessMode = modeResult.accessMode;
        merged.subdomain = modeResult.subdomain;
        merged.connectivityTest = modeResult.connectivityTest;
        if (nodeRegistrationInfo.publicIp) {
          merged.publicIp = nodeRegistrationInfo.publicIp;
        }
        if (nodeRegistrationInfo.publicPort) {
          merged.publicPort = nodeRegistrationInfo.publicPort;
        }
      }
    }

    await this.applyRoutingDecision(payload.nodeId, merged, connectivityInfo);

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

  private writeError(response: HttpResponse, error: unknown): void {
    if (response.headersSent) {
      return;
    }

    let statusCode = 500;
    let message = 'Internal Server Error';

    if (error instanceof UnauthorizedHttpError) {
      statusCode = 401;
      message = error.message;
    } else if (error instanceof BadRequestHttpError) {
      statusCode = 400;
      message = error.message;
    } else if (error instanceof MethodNotAllowedHttpError) {
      statusCode = 405;
      message = error.message;
    } else if (error instanceof NotImplementedHttpError) {
      statusCode = 501;
      message = error.message;
    } else if (error instanceof InternalServerError) {
      statusCode = 500;
      message = error.message;
    } else if (error instanceof Error) {
      message = error.message;
    }

    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: message }));
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

  private async mergeMetadata(previous: EdgeNodeMetadata, payload: EdgeNodeSignalPayload, now: Date): Promise<EdgeNodeMetadata> {
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

    // Enhanced capability reporting using EdgeNodeCapabilityDetector
    if (this.capabilityDetector) {
      try {
        // Get structured capabilities from the detector
        const detectedCapabilities = await this.capabilityDetector.detectCapabilities();
        
        // Merge detected capabilities with existing metadata
        next.detectedCapabilities = detectedCapabilities;
        
        // Convert to string array format for backward compatibility
        const capabilityStrings = EdgeNodeCapabilityDetector.capabilitiesToStringArray(detectedCapabilities);
        
        // Merge with user-provided capabilities if any
        const existingCapabilities = (payload.capabilities ?? []);
        const mergedCapabilities = [...new Set([...existingCapabilities, ...capabilityStrings])];
        
        next.capabilities = mergedCapabilities;
        
        this.logger.debug(`Enhanced node capabilities for ${payload.nodeId}: ${JSON.stringify({ 
          original: existingCapabilities,
          detected: detectedCapabilities,
          merged: mergedCapabilities 
        })}`);
      } catch (error: unknown) {
        this.logger.warn(`Failed to detect capabilities for node ${payload.nodeId}: ${(error as Error).message}`);
        // Continue with user-provided capabilities if detection fails
      }
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
      if (typeof request.setEncoding === 'function') {
        request.setEncoding('utf8');
      }
      request.on('data', (chunk: Buffer | string) => {
        data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
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

  private extractPortNumber(address: unknown): number | undefined {
    if (typeof address !== 'string') {
      return undefined;
    }
    try {
      const url = new URL(address);
      const port = url.port;
      if (port) {
        const parsed = parseInt(port, 10);
        return isNaN(parsed) ? undefined : parsed;
      }
      // Return default port based on protocol
      return url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : undefined;
    } catch {
      return undefined;
    }
  }

  private buildNodeCapabilities(payload: EdgeNodeSignalPayload, merged: EdgeNodeMetadata): NodeCapabilities {
    // Start with basic capability information from payload and metadata
    const capabilityStrings = Array.isArray(payload.capabilities) ?
      payload.capabilities :
      Array.isArray(merged.capabilities) ? merged.capabilities as string[] : undefined;
    let capabilities: NodeCapabilities = {
      solidProtocolVersion: payload.version || merged.version as string || '1.0.0',
      storageBackends: this.parseStorageBackends(capabilityStrings),
      authMethods: this.parseAuthMethods(capabilityStrings),
      maxBandwidth: merged.maxBandwidth as number,
      location: merged.location as NodeCapabilities['location'],
      supportedModes: this.parseSupportedModes(capabilityStrings) ?? [ 'direct', 'proxy' ],
    };

    // If we have structured capabilities from the detector, use them to enhance the information
    if (merged.detectedCapabilities) {
      try {
        const detected = merged.detectedCapabilities as NodeCapabilities;
        capabilities = {
          solidProtocolVersion: detected.solidProtocolVersion || capabilities.solidProtocolVersion,
          storageBackends: detected.storageBackends || capabilities.storageBackends,
          authMethods: detected.authMethods || capabilities.authMethods,
          maxBandwidth: detected.maxBandwidth || capabilities.maxBandwidth,
          location: detected.location || capabilities.location,
        };
      } catch (error: unknown) {
        this.logger.warn(`Failed to use detected capabilities: ${(error as Error).message}`);
      }
    }

    return capabilities;
  }

  private parseStorageBackends(capabilityStrings?: string[]): string[] | undefined {
    if (!capabilityStrings || capabilityStrings.length === 0) {
      return ['filesystem']; // default
    }

    const storageBackends = capabilityStrings
      .filter(cap => cap.startsWith('storage:'))
      .map(cap => cap.substring(8)); // remove 'storage:' prefix

    return storageBackends.length > 0 ? storageBackends : ['filesystem'];
  }

  private parseAuthMethods(capabilityStrings?: string[]): string[] | undefined {
    if (!capabilityStrings || capabilityStrings.length === 0) {
      return ['webid', 'client-credentials']; // defaults
    }

    const authMethods = capabilityStrings
      .filter(cap => cap.startsWith('auth:'))
      .map(cap => cap.substring(5)); // remove 'auth:' prefix

    return authMethods.length > 0 ? authMethods : ['webid', 'client-credentials'];
  }

  private parseSupportedModes(capabilityStrings?: string[]): ('direct' | 'proxy')[] | undefined {
    if (!capabilityStrings || capabilityStrings.length === 0) {
      return undefined;
    }
    const modes = new Set<'direct' | 'proxy'>();
    for (const entry of capabilityStrings) {
      if (typeof entry !== 'string' || !entry.startsWith('mode:')) {
        continue;
      }
      const mode = entry.slice(5).trim().toLowerCase();
      if (mode === 'redirect' || mode === 'direct') {
        modes.add('direct');
      }
      if (mode === 'proxy') {
        modes.add('proxy');
      }
    }
    return modes.size > 0 ? [ ...modes ] : undefined;
  }

  private getSupportedModeFlags(metadata: EdgeNodeMetadata): { supportsDirect: boolean; supportsProxy: boolean } {
    const capabilityStrings = Array.isArray(metadata.capabilities) ?
      (metadata.capabilities as string[]).filter((entry) => typeof entry === 'string') as string[] :
      undefined;
    const parsed = this.parseSupportedModes(capabilityStrings) ?? [ 'direct', 'proxy' ];
    const set = new Set(parsed);
    return {
      supportsDirect: set.has('direct'),
      supportsProxy: set.has('proxy'),
    };
  }

  private async applyRoutingDecision(nodeId: string, metadata: EdgeNodeMetadata, currentConnectivity?: ReturnType<EdgeNodeRepository['getNodeConnectivityInfo']> extends Promise<infer T> ? T : never): Promise<void> {
    const desiredMode = this.determineAccessMode(metadata);
    if (!desiredMode) {
      return;
    }

    const currentMode = this.normalizeAccessMode(currentConnectivity?.accessMode);
    if (currentMode === desiredMode.accessMode &&
      currentConnectivity?.publicIp === desiredMode.publicIp &&
      currentConnectivity?.subdomain === desiredMode.subdomain) {
      metadata.accessMode = desiredMode.accessMode;
      return;
    }
    await this.repo.updateNodeMode(nodeId, {
      accessMode: desiredMode.accessMode,
      publicIp: desiredMode.publicIp,
      publicPort: desiredMode.publicPort,
      subdomain: desiredMode.subdomain,
      connectivityStatus: desiredMode.connectivityStatus,
      capabilities: metadata.capabilities as Record<string, unknown>,
    });
    metadata.accessMode = desiredMode.accessMode;
    metadata.subdomain = desiredMode.subdomain ?? metadata.subdomain;
  }

  private determineAccessMode(metadata: EdgeNodeMetadata): { accessMode: 'direct' | 'proxy'; publicIp?: string; publicPort?: number; subdomain?: string; connectivityStatus: 'reachable' | 'unreachable' | 'unknown'; } | undefined {
    const { supportsDirect, supportsProxy } = this.getSupportedModeFlags(metadata);
    const reachability = this.asRecord(metadata.reachability);
    const status = typeof reachability.status === 'string' ? reachability.status.trim().toLowerCase() : undefined;
    const tunnel = this.asRecord(metadata.tunnel);

    // Prefer direct if it is healthy and supported
    const directHealthy = status === 'direct' || status === 'reachable' || status === 'redirect';
    if (directHealthy && supportsDirect) {
      return {
        accessMode: 'direct',
        publicIp: typeof metadata.publicIp === 'string' ? metadata.publicIp : undefined,
        publicPort: typeof metadata.publicPort === 'number' ? metadata.publicPort : undefined,
        subdomain: typeof metadata.subdomain === 'string' ? metadata.subdomain : undefined,
        connectivityStatus: 'reachable',
      };
    }

    // Fallback to proxy if supported and tunnel is active
    if (supportsProxy && tunnel?.status === 'active') {
      return {
        accessMode: 'proxy',
        publicIp: typeof metadata.publicIp === 'string' ? metadata.publicIp : undefined,
        publicPort: typeof metadata.publicPort === 'number' ? metadata.publicPort : undefined,
        subdomain: typeof metadata.subdomain === 'string' ? metadata.subdomain : undefined,
        connectivityStatus: 'reachable',
      };
    }

    // Proxy supported but inactive
    if (supportsProxy && !supportsDirect) {
      return {
        accessMode: 'proxy',
        connectivityStatus: 'unreachable',
        subdomain: typeof metadata.subdomain === 'string' ? metadata.subdomain : undefined,
      };
    }

    // Direct supported but currently unreachable
    if (supportsDirect && status === 'unreachable') {
      return {
        accessMode: 'direct',
        publicIp: typeof metadata.publicIp === 'string' ? metadata.publicIp : undefined,
        publicPort: typeof metadata.publicPort === 'number' ? metadata.publicPort : undefined,
        subdomain: typeof metadata.subdomain === 'string' ? metadata.subdomain : undefined,
        connectivityStatus: 'unreachable',
      };
    }

      return undefined;
  }

  private normalizeAccessMode(mode: string | undefined): 'direct' | 'proxy' | undefined {
    if (!mode) {
      return undefined;
    }
    const normalized = mode.trim().toLowerCase();
    if (normalized === 'redirect' || normalized === 'direct') {
      return 'direct';
    }
    if (normalized === 'proxy') {
      return 'proxy';
    }
    return undefined;
  }
}
