import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  NotImplementedHttpError,
  InternalServerError,
  getLoggerFor,
} from '@solid/community-server';
import type { ComponentsManagerBuilder } from 'componentsjs';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface ClusterIngressRouterOptions {
  identityDbUrl: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  clusterIngressDomain: string; // cluster.example.com
  skipAuthRedirect?: boolean; // For testing
  fetchImpl?: any;
}

/**
 * Cluster Ingress Router - 集群统一入口路由器
 * 
 * 实现我们设计的混合路由策略：
 * 1. 所有节点子域名DNS都指向集群入口
 * 2. 认证请求路由到集群IDP  
 * 3. 数据请求根据节点模式智能路由（307重定向 vs 代理）
 */
export class ClusterIngressRouter extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repository: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly clusterIngressDomain: string;
  private readonly skipAuthRedirect: boolean;
  private readonly fetchImpl: any;

  // Authentication paths that should always route to cluster IDP
  private readonly authPaths = [
    '/idp/',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-authorization-server', 
    '/login',
    '/logout'
  ];

  public constructor(options: ClusterIngressRouterOptions) {
    super();
    this.repository = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.clusterIngressDomain = this.normalizeDomain(options.clusterIngressDomain);
    this.skipAuthRedirect = options.skipAuthRedirect ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    this.logger.info('ClusterIngressRouter.canHandle called');
    if (!this.enabled) {
      this.logger.info('ClusterIngressRouter disabled');
      throw new NotImplementedHttpError('Cluster ingress router disabled.');
    }

    const hostname = this.extractHostname(request);
    if (!hostname) {
      throw new NotImplementedHttpError('Missing Host header.');
    }

    // Only handle requests to node subdomains, not the cluster domain itself
    if (hostname === this.clusterIngressDomain) {
      throw new NotImplementedHttpError('Request to cluster domain, not a node subdomain.');
    }

    // Check if this is a valid node subdomain
    const nodeId = this.extractNodeIdFromHostname(hostname);
    if (!nodeId) {
      throw new NotImplementedHttpError('Not a node subdomain pattern.');
    }

    // Verify the node exists
    const nodeSecret = await this.repository.getNodeSecret(nodeId);
    if (!nodeSecret) {
      throw new NotImplementedHttpError(`Node ${nodeId} not registered.`);
    }

    const url = this.parseUrl(request);
    if (this.isAuthenticationRequest(url.pathname)) {
      this.rewriteRequestForClusterIdp(request, hostname);
      throw new NotImplementedHttpError('Authentication routed to cluster IDP.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const hostname = this.extractHostname(request)!;
    const url = this.parseUrl(request);
    const nodeId = this.extractNodeIdFromHostname(hostname)!;
    
    // Check if this is an authentication request
    if (this.isAuthenticationRequest(url.pathname)) {
      await this.handleAuthenticationRequest(request, response, url);
      return;
    }

    // Data request - route based on node access mode
    await this.handleDataRequest(request, response, nodeId, url);
  }

  /**
   * Handle authentication requests - always route to cluster IDP
   */
  private async handleAuthenticationRequest(
    request: IncomingMessage, 
    response: HttpResponse, 
    url: URL
  ): Promise<void> {
    if (this.skipAuthRedirect) {
      throw new NotImplementedHttpError('Auth routing skipped for testing.');
    }

    // Redirect authentication requests to cluster IDP
    const clusterAuthUrl = new URL(url.pathname + url.search + url.hash, `https://${this.clusterIngressDomain}`);
    
    this.logger.debug(`Routing auth request to cluster IDP: ${clusterAuthUrl.toString()}`);
    
    response.statusCode = 307;
    response.setHeader('Location', clusterAuthUrl.toString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Xpod-Auth-Redirect', 'cluster-idp');
    response.end();
  }

  /**
   * Handle data requests - route based on node access mode
   */
  private async handleDataRequest(
    request: IncomingMessage,
    response: HttpResponse, 
    nodeId: string,
    url: URL
  ): Promise<void> {
    try {
      const [nodeInfo, nodeMetadata] = await Promise.all([
        this.repository.getNodeConnectivityInfo(nodeId),
        this.repository.getNodeMetadata(nodeId),
      ]);
      
      if (!nodeInfo) {
        throw new InternalServerError(`Node ${nodeId} connectivity info not found.`);
      }

      const mode = this.normalizeMode(nodeInfo.accessMode);
      if (mode === 'direct' && nodeInfo.publicIp) {
        await this.handleDirectModeRedirect(response, nodeInfo, url);
      } else if (mode === 'proxy') {
        await this.handleProxyModeRequest(request, response, nodeId, nodeInfo, nodeMetadata?.metadata || null, url);
      } else {
        throw new InternalServerError(`Node ${nodeId} has unsupported accessMode ${nodeInfo.accessMode ?? 'unknown'}.`);
      }
    } catch (error: unknown) {
      if (error instanceof NotImplementedHttpError) {
        throw error;
      }
      throw new InternalServerError('Failed to route data request.', { cause: error });
    }
  }

  /**
   * Handle direct mode - redirect to node's public IP
   */
  private async handleDirectModeRedirect(
    response: HttpResponse,
    nodeInfo: NonNullable<Awaited<ReturnType<EdgeNodeRepository['getNodeConnectivityInfo']>>>,
    url: URL
  ): Promise<void> {
    const port = nodeInfo.publicPort && nodeInfo.publicPort !== 443 ? `:${nodeInfo.publicPort}` : '';
    const nodeDirectUrl = `https://${nodeInfo.publicIp}${port}${url.pathname}${url.search}${url.hash}`;
    
    this.logger.debug(`Redirecting to edge node (direct mode): ${nodeDirectUrl}`);
    
    response.statusCode = 307;
    response.setHeader('Location', nodeDirectUrl);
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Xpod-Direct-Node', nodeInfo.nodeId);
    response.setHeader('X-Xpod-Target-IP', nodeInfo.publicIp!);
    response.end();
  }

  /**
   * Handle proxy mode - proxy the request through tunnel
   */
  private async handleProxyModeRequest(
    request: IncomingMessage,
    response: HttpResponse,
    nodeId: string,
    nodeInfo: NonNullable<Awaited<ReturnType<EdgeNodeRepository['getNodeConnectivityInfo']>>>,
    metadata: Record<string, unknown> | null,
    url: URL
  ): Promise<void> {
    // Get tunnel entrypoint from node metadata
    const upstream = this.resolveUpstream(metadata);
    if (!upstream) {
      throw new InternalServerError(`Node ${nodeId} tunnel endpoint not ready.`);
    }

    const upstreamBase = new URL(upstream);
    const target = new URL(url.pathname + url.search, upstreamBase);
    target.hash = url.hash;

    const body = await this.readRequestBody(request);
    const headers = this.buildProxyHeaders(request, url, upstreamBase);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.fetchImpl(target.toString(), {
        method: (request.method ?? 'GET').toUpperCase(),
        headers,
        body: body?.length ? body : undefined,
      });
    } catch (error: unknown) {
      this.logger.error(`Proxy request to ${target.toString()} failed: ${String(error)}`);
      throw new InternalServerError('Failed to proxy request to edge node.', { cause: error });
    }

    // Forward response
    response.statusCode = upstreamResponse.status;
    response.setHeader('X-Xpod-Proxy-Node', nodeId);
    
    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding' && value === 'chunked') {
        return; // Let Node.js handle chunking
      }
      response.setHeader(key, value);
    });

    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    const readable = Readable.from(upstreamResponse.body as any);
    readable.on('error', (error) => {
      this.logger.error(`Proxy stream error: ${String(error)}`);
      response.destroy(error);
    });
    readable.pipe(response);
  }

  /**
   * Resolve upstream endpoint from node metadata
   */
  private resolveUpstream(metadata?: Record<string, unknown> | null): string | undefined {
    const tunnel = metadata?.tunnel;
    if (tunnel && typeof tunnel === 'object') {
      const entrypoint = (tunnel as Record<string, unknown>).entrypoint;
      if (typeof entrypoint === 'string' && entrypoint.trim().length > 0) {
        return entrypoint;
      }
    }
    
    // Fallback to publicAddress if available
    if (typeof metadata?.publicAddress === 'string') {
      return metadata.publicAddress;
    }
    
    return undefined;
  }

  /**
   * Build headers for proxy request
   */
  private buildProxyHeaders(request: IncomingMessage, original: URL, upstream: URL): Headers {
    const headers = new Headers();
    
    // Forward original headers except host
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || name.toLowerCase() === 'host') {
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(name, value.join(','));
      } else {
        headers.set(name, value);
      }
    }
    
    // Set proper target host
    headers.set('host', upstream.host);
    
    // Add forwarded headers for transparency
    headers.set('x-forwarded-host', original.host);
    headers.set('x-forwarded-proto', original.protocol.replace(/:$/u, ''));
    
    const port = original.port || (original.protocol === 'https:' ? '443' : '80');
    headers.set('x-forwarded-port', port);
    
    // Add client IP if available
    const remoteAddress = (request.socket as any)?.remoteAddress;
    if (remoteAddress) {
      const existing = headers.get('x-forwarded-for');
      headers.set('x-forwarded-for', existing ? `${existing}, ${remoteAddress}` : remoteAddress);
    }
    
    return headers;
  }

  /**
   * Read request body for proxy forwarding
   */
  private readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (['GET', 'HEAD'].includes(method)) {
      return Promise.resolve(undefined);
    }
    
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  /**
   * Check if request path is for authentication
   */
  private isAuthenticationRequest(pathname: string): boolean {
    return this.authPaths.some(authPath => pathname.startsWith(authPath));
  }

  /**
   * Rewrite the incoming request so downstream handlers treat it as cluster IDP traffic.
   */
  private rewriteRequestForClusterIdp(request: IncomingMessage, originalHost: string): void {
    if (!request.headers['x-original-host']) {
      request.headers['x-original-host'] = originalHost;
    }

    request.headers.host = this.clusterIngressDomain;
    request.headers.Host = this.clusterIngressDomain;

    if (!request.headers['x-forwarded-host']) {
      request.headers['x-forwarded-host'] = originalHost;
    }
  }

  /**
   * Extract node ID from hostname
   * e.g., "node1.cluster.example.com" -> "node1"
   */
  private extractNodeIdFromHostname(hostname: string): string | undefined {
    const clusterSuffix = `.${this.clusterIngressDomain}`;
    if (!hostname.endsWith(clusterSuffix)) {
      return undefined;
    }
    
    const nodeId = hostname.slice(0, -clusterSuffix.length);
    // Validate node ID format (simple validation)
    if (!nodeId || nodeId.includes('.') || nodeId.length === 0) {
      return undefined;
    }
    
    return nodeId;
  }

  /**
   * Extract hostname from request headers
   * Check for original host header first (set by ClusterHttpServerFactory)
   */
  private extractHostname(request: IncomingMessage): string | undefined {
    // Check for original host header first (set by ClusterHttpServerFactory)
    const originalHost = request.headers['x-original-host'];
    if (originalHost && typeof originalHost === 'string') {
      return originalHost.toLowerCase();
    }
    
    const hostHeader = request.headers.host || request.headers.Host;
    if (Array.isArray(hostHeader)) {
      return hostHeader[0]?.toLowerCase();
    }
    return typeof hostHeader === 'string' ? hostHeader.toLowerCase() : undefined;
  }

  /**
   * Parse request URL
   */
  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'https' : 'https';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  /**
   * Normalize domain input; accept bare host or full URL.
   */
  private normalizeDomain(domain: string): string {
    if (domain.includes('://')) {
      try {
        return new URL(domain).hostname.toLowerCase();
      } catch {
        return domain.toLowerCase();
      }
    }
    return domain.toLowerCase();
  }

  /**
   * Normalize boolean values from string/boolean
   */
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

  private normalizeMode(mode: string | undefined): 'direct' | 'proxy' | undefined {
    if (!mode) {
      return undefined;
    }
    const normalized = mode.trim().toLowerCase();
    // Backward compatibility for 'redirect' -> 'direct'
    if (normalized === 'redirect' || normalized === 'direct') {
      return 'direct';
    }
    if (normalized === 'proxy') {
      return 'proxy';
    }
    return undefined;
  }
}
