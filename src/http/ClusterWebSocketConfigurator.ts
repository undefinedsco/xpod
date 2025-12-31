import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import httpProxy from 'http-proxy';
import { getLoggerFor } from 'global-logger-factory';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface ClusterWebSocketConfiguratorOptions {
  identityDbUrl: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  clusterIngressDomain: string;
}

/**
 * ServerConfigurator that handles WebSocket upgrade requests for edge nodes.
 * 
 * For proxy mode: proxies WebSocket connections through FRP tunnel
 * For direct mode: sends 307 redirect to edge node's public IP
 */
export class ClusterWebSocketConfigurator {
  protected readonly logger = getLoggerFor(this);
  private readonly repository: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly clusterIngressDomain: string;
  private readonly wsProxy: httpProxy;

  public constructor(options: ClusterWebSocketConfiguratorOptions) {
    this.repository = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.clusterIngressDomain = this.normalizeDomain(options.clusterIngressDomain);
    
    // Create WebSocket proxy instance
    this.wsProxy = httpProxy.createProxyServer({
      ws: true,
      changeOrigin: true,
      xfwd: true,
    });
    
    this.wsProxy.on('error', (err, req, res) => {
      this.logger.error(`WebSocket proxy error: ${String(err)}`);
      if (res && 'end' in res && typeof res.end === 'function') {
        res.end();
      }
    });
  }

  /**
   * Attach to HTTP server's upgrade event
   */
  public async handle(server: Server): Promise<void> {
    if (!this.enabled) {
      this.logger.info('ClusterWebSocketConfigurator disabled');
      return;
    }

    // Prepend our handler to run before CSS's WebSocketServerConfigurator
    server.prependListener('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head).catch((error) => {
        this.logger.error(`WebSocket upgrade error: ${String(error)}`);
        // Don't destroy socket here - let other handlers try
      });
    });

    this.logger.info('ClusterWebSocketConfigurator attached to server');
  }

  /**
   * Handle WebSocket upgrade request
   */
  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<boolean> {
    const hostname = this.extractHostname(request);
    if (!hostname) {
      return false; // Let other handlers deal with it
    }

    // Only handle requests to node subdomains
    if (hostname === this.clusterIngressDomain) {
      return false; // Cluster domain - let CSS handle it
    }

    const nodeId = this.extractNodeIdFromHostname(hostname);
    if (!nodeId) {
      return false; // Not a node subdomain
    }

    // Verify node exists
    const nodeSecret = await this.repository.getNodeSecret(nodeId);
    if (!nodeSecret) {
      this.logger.warn(`WebSocket upgrade: Node ${nodeId} not registered`);
      this.sendUpgradeError(socket, 404, `Node ${nodeId} not found`);
      return true; // We handled it (with error)
    }

    // Get node info
    const [nodeInfo, nodeMetadata] = await Promise.all([
      this.repository.getNodeConnectivityInfo(nodeId),
      this.repository.getNodeMetadata(nodeId),
    ]);

    if (!nodeInfo) {
      this.logger.error(`WebSocket upgrade: Node ${nodeId} connectivity info not found`);
      this.sendUpgradeError(socket, 502, 'Node connectivity info not found');
      return true;
    }

    const mode = this.normalizeMode(nodeInfo.accessMode);

    if (mode === 'direct' && nodeInfo.publicIp) {
      // Direct mode: redirect client to connect directly
      const port = nodeInfo.publicPort && nodeInfo.publicPort !== 443 ? `:${nodeInfo.publicPort}` : '';
      const directUrl = `wss://${nodeInfo.publicIp}${port}${request.url ?? '/'}`;

      this.logger.info(`WebSocket direct mode: redirecting to ${directUrl}`);
      
      socket.write(
        `HTTP/1.1 307 Temporary Redirect\r\n` +
        `Location: ${directUrl}\r\n` +
        `X-Xpod-Direct-Node: ${nodeId}\r\n` +
        `Connection: close\r\n` +
        `\r\n`
      );
      socket.end();
      return true;
    }

    if (mode === 'proxy') {
      const upstream = this.resolveUpstream(nodeMetadata?.metadata || null);
      if (!upstream) {
        this.logger.error(`WebSocket upgrade: Node ${nodeId} tunnel endpoint not ready`);
        this.sendUpgradeError(socket, 502, 'Node tunnel not ready');
        return true;
      }

      const upstreamUrl = new URL(upstream);
      const wsProtocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const target = `${wsProtocol}//${upstreamUrl.host}`;

      this.logger.info(`WebSocket proxy: ${hostname} -> ${target}${request.url}`);

      // Add forwarded headers
      request.headers['x-forwarded-host'] = hostname;
      request.headers['x-forwarded-proto'] = 'wss';
      request.headers['x-xpod-proxy-node'] = nodeId;

      // Proxy the WebSocket connection
      this.wsProxy.ws(request, socket, head, {
        target,
        secure: true,
      });
      return true;
    }

    this.logger.warn(`WebSocket upgrade: Unsupported mode ${mode} for node ${nodeId}`);
    this.sendUpgradeError(socket, 400, `Unsupported access mode: ${mode}`);
    return true;
  }

  /**
   * Send HTTP error response for WebSocket upgrade failure
   */
  private sendUpgradeError(socket: Duplex, statusCode: number, message: string): void {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\n` +
      `Content-Type: text/plain\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      message
    );
    socket.end();
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
    if (typeof metadata?.publicAddress === 'string') {
      return metadata.publicAddress;
    }
    return undefined;
  }

  /**
   * Extract hostname from request headers
   */
  private extractHostname(request: IncomingMessage): string | undefined {
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
   * Extract node ID from hostname
   */
  private extractNodeIdFromHostname(hostname: string): string | undefined {
    const clusterSuffix = `.${this.clusterIngressDomain}`;
    if (!hostname.endsWith(clusterSuffix)) {
      return undefined;
    }
    const nodeId = hostname.slice(0, -clusterSuffix.length);
    if (!nodeId || nodeId.includes('.') || nodeId.length === 0) {
      return undefined;
    }
    return nodeId;
  }

  /**
   * Normalize domain input
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
   * Normalize boolean values
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

  /**
   * Normalize access mode
   */
  private normalizeMode(mode: string | undefined): 'direct' | 'proxy' | undefined {
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
