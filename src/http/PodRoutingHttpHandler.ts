import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import { Readable } from 'node:stream';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  InternalServerError,
  
} from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { PodLookupRepository } from '../identity/drizzle/PodLookupRepository';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface PodRoutingHttpHandlerOptions {
  identityDbUrl: string;
  nodeId: string;                    // Current node ID
  enabled?: boolean | string;
  podLookupRepository?: PodLookupRepository;
  edgeNodeRepository?: EdgeNodeRepository;
}

/**
 * Pod Routing HTTP Handler - Routes requests to the correct node based on Pod location.
 * 
 * For multi-node Center deployment:
 * 1. Extract Pod ID from request URL
 * 2. Look up Pod's nodeId from database
 * 3. If Pod is on current node, pass through to next handler
 * 4. If Pod is on another node, proxy the request
 */
export class PodRoutingHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly podLookupRepository: PodLookupRepository;
  private readonly edgeNodeRepository: EdgeNodeRepository;
  private readonly currentNodeId: string;
  private readonly enabled: boolean;

  public constructor(options: PodRoutingHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.podLookupRepository = options.podLookupRepository ?? new PodLookupRepository(db);
    this.edgeNodeRepository = options.edgeNodeRepository ?? new EdgeNodeRepository(db);
    this.currentNodeId = options.nodeId;
    this.enabled = this.normalizeBoolean(options.enabled);

    this.logger.info(`PodRoutingHttpHandler initialized: nodeId=${this.currentNodeId}, enabled=${this.enabled}`);
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Pod routing disabled.');
    }

    if (!this.currentNodeId) {
      throw new NotImplementedHttpError('No nodeId configured, pod routing disabled.');
    }

    const url = this.parseUrl(request);
    
    // Skip internal/system paths
    if (this.isSystemPath(url.pathname)) {
      throw new NotImplementedHttpError('System path, skip pod routing.');
    }

    // Look up Pod for this request
    const pod = await this.podLookupRepository.findByResourceIdentifier(url.href);
    if (!pod) {
      throw new NotImplementedHttpError('No Pod found for this request.');
    }

    // If Pod has no nodeId, it's on current node (legacy/default)
    if (!pod.nodeId) {
      throw new NotImplementedHttpError('Pod has no nodeId, handle locally.');
    }

    // If Pod is on current node, pass through
    if (pod.nodeId === this.currentNodeId) {
      throw new NotImplementedHttpError('Pod is on current node, handle locally.');
    }

    // Pod is on another node, we need to proxy
    this.logger.debug(`Pod ${pod.podId} is on node ${pod.nodeId}, need to proxy.`);
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const url = this.parseUrl(request);
    const pod = await this.podLookupRepository.findByResourceIdentifier(url.href);

    if (!pod || !pod.nodeId) {
      throw new InternalServerError('Pod lookup failed in handle phase.');
    }

    // Try to resolve upstream with internal endpoint support (for center-to-center)
    const upstream = await this.resolveUpstreamWithInternal(pod.nodeId);
    if (!upstream) {
      throw new InternalServerError(`Target node ${pod.nodeId} has no reachable endpoint.`);
    }

    await this.proxyRequest(request, response, upstream, url);
  }

  /**
   * Proxy request to target node.
   */
  private async proxyRequest(
    request: IncomingMessage,
    response: HttpResponse,
    upstream: string,
    originalUrl: URL,
  ): Promise<void> {
    const upstreamBase = new URL(upstream);
    const target = new URL(originalUrl.pathname + originalUrl.search, upstreamBase);
    target.hash = originalUrl.hash;

    const body = await this.readRequestBody(request);
    const headers = this.buildProxyHeaders(request, originalUrl, upstreamBase);

    this.logger.debug(`Proxying to ${target.toString()}`);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(target.toString(), {
        method: (request.method ?? 'GET').toUpperCase(),
        headers,
        body: body?.length ? body : undefined,
      });
    } catch (error: unknown) {
      this.logger.error(`Proxy request to ${target.toString()} failed: ${String(error)}`);
      throw new InternalServerError('Failed to proxy request to target node.', { cause: error });
    }

    // Forward response
    response.statusCode = upstreamResponse.status;
    response.setHeader('X-Xpod-Proxied-From', this.currentNodeId);

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

    const readable = Readable.from(upstreamResponse.body as unknown as AsyncIterable<Uint8Array>);
    readable.on('error', (error) => {
      this.logger.error(`Proxy stream error: ${String(error)}`);
      response.destroy(error);
    });
    readable.pipe(response);
  }

  /**
   * Resolve upstream endpoint from node info.
   * For center nodes, prefer internal endpoint for intra-cluster communication.
   */
  private resolveUpstream(nodeInfo: {
    publicIp?: string | null;
    publicPort?: number | null;
    nodeId: string;
  }): string | undefined {
    // Try public IP first (for edge nodes or external access)
    if (nodeInfo.publicIp) {
      const port = nodeInfo.publicPort && nodeInfo.publicPort !== 443 ? `:${nodeInfo.publicPort}` : '';
      return `https://${nodeInfo.publicIp}${port}`;
    }

    // NOTE: Internal endpoint lookup is done via CenterNodeRegistrationService.getNodeInternalUrl()
    // This method is kept simple - the handler should be injected with the registration service
    // for full internal routing support.

    return undefined;
  }

  /**
   * Resolve upstream for center node using internal endpoint.
   */
  public async resolveUpstreamWithInternal(nodeId: string): Promise<string | undefined> {
    // First try to get center node internal endpoint
    const centerNodes = await this.edgeNodeRepository.listCenterNodes();
    const centerNode = centerNodes.find(n => n.nodeId === nodeId);
    
    if (centerNode && centerNode.internalIp && centerNode.internalPort) {
      return `http://${centerNode.internalIp}:${centerNode.internalPort}`;
    }

    // Fall back to public endpoint
    const nodeInfo = await this.edgeNodeRepository.getNodeConnectivityInfo(nodeId);
    if (!nodeInfo) {
      return undefined;
    }
    return this.resolveUpstream(nodeInfo);
  }

  /**
   * Build headers for proxy request.
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

    // Add forwarded headers
    headers.set('x-forwarded-host', original.host);
    headers.set('x-forwarded-proto', original.protocol.replace(/:$/u, ''));

    const port = original.port || (original.protocol === 'https:' ? '443' : '80');
    headers.set('x-forwarded-port', port);

    // Add source node info
    headers.set('x-xpod-source-node', this.currentNodeId);

    // Add client IP if available
    const remoteAddress = (request.socket as { remoteAddress?: string })?.remoteAddress;
    if (remoteAddress) {
      const existing = headers.get('x-forwarded-for');
      headers.set('x-forwarded-for', existing ? `${existing}, ${remoteAddress}` : remoteAddress);
    }

    return headers;
  }

  /**
   * Read request body for proxy forwarding.
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
   * Check if path is a system/internal path that should skip routing.
   */
  private isSystemPath(pathname: string): boolean {
    const systemPaths = [
      '/idp/',
      '/.well-known/',
      '/-/',
      '/api/',
    ];
    return systemPaths.some(prefix => pathname.startsWith(prefix));
  }

  /**
   * Parse request URL.
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
   * Normalize boolean values from string/boolean.
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
}
