import httpProxy from 'http-proxy';
import http from 'http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import type { Supervisor } from '../supervisor/Supervisor';
import { nodeRuntimeHost } from './host/node/NodeRuntimeHost';
import type { RuntimeHost, RuntimeListenEndpoint } from './host/types';
import {
  createGatewayAdminProxyHeaders,
  GATEWAY_ADMIN_PROXY_HEADERS,
  GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER,
  isLoopbackRemoteAddress,
  stripGatewayAdminProxyHeaders,
  verifyGatewayAdminProxyHeaders,
} from './GatewayAdminProxyAuth';
import { BunNativeUpgradeRelay } from './upgrade/BunNativeUpgradeRelay';

type InterceptedRequest = http.IncomingMessage & { __xpodInspectRootMutation?: boolean };

interface RootMutationForbiddenBody {
  name: 'ForbiddenHttpError';
  message: string;
  statusCode: 403;
  errorCode: 'H403';
  details: { cause: 'root-container-write' };
}

// CORS configuration matching CSS CorsHandler defaults
const CORS_CONFIG = {
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
  allowedHeaders: [
    'Authorization', 'Content-Type', 'Accept', 'DPoP', 'Origin',
    'X-Requested-With', 'If-Match', 'If-None-Match', 'Slug', 'Link',
    'X-Xpod-Canonical-Url', 'X-Xpod-Canonical-Origin', 'X-Xpod-Canonical-Host',
    'X-Xpod-Local-Route-Url',
  ],
  exposedHeaders: [
    'Accept-Patch', 'Accept-Post', 'Accept-Put', 'Allow', 'Content-Range',
    'ETag', 'Last-Modified', 'Link', 'Location', 'Updates-Via',
    'WAC-Allow', 'Www-Authenticate', 'X-Request-Id',
  ],
};

/**
 * Grace period (ms) for the listener to report a clean close; see `closeServer`.
 */
const SERVER_CLOSE_GRACE_MS = 2_000;

const SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER = 'x-xpod-canonical-url';
const SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER = 'x-xpod-canonical-origin';
const SOLID_LOCAL_ROUTE_CANONICAL_HOST_HEADER = 'x-xpod-canonical-host';
const SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER = 'x-xpod-local-route-url';
const SOLID_LOCAL_ROUTE_HEADERS = [
  SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER,
  SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER,
  SOLID_LOCAL_ROUTE_CANONICAL_HOST_HEADER,
  SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER,
] as const;

export class GatewayProxy {
  private readonly logger = getLoggerFor(this);
  private proxy: httpProxy;
  private server: http.Server;
  private targets: { css?: GatewayProxyTarget; api?: GatewayProxyTarget } = {};
  private readonly runtimeHost: RuntimeHost;
  private readonly listenEndpoint: RuntimeListenEndpoint;
  private readonly exitOnStop: boolean;
  private readonly shutdownHandler?: () => Promise<void>;
  private readonly baseUrl?: string;
  private readonly internalAdminAuthSecret?: string;
  private readonly clientRemoteAddressResolver?: (req: http.IncomingMessage) => string | undefined;
  /**
   * Upgrade relay for runtimes whose HTTP server cannot expose the raw upgraded
   * socket (Bun). `undefined` keeps the byte-level `http-proxy` relay.
   */
  private readonly nativeUpgradeRelay?: BunNativeUpgradeRelay;
  /** Sockets created by `upgrade` events, dropped on shutdown. */
  private readonly upgradeSockets = new Set<Duplex>();
  /**
   * Loopback-only listener used as the origin of everything that forwards remote
   * traffic to this Gateway (managed tunnels, P2P data plane). Requests accepted
   * there are never treated as local, so a forwarded request cannot inherit the
   * trust that a real local client has.
   */
  private readonly ingressPort?: number;
  private ingressServer?: http.Server;

  constructor(
    port: number | undefined,
    private supervisor: Supervisor,
    bindHost = '0.0.0.0',
    options: GatewayProxyOptions = {},
  ) {
    this.runtimeHost = options.runtimeHost ?? nodeRuntimeHost;
    this.listenEndpoint = options.listenEndpoint ?? this.runtimeHost.createListenEndpoint({
      port,
      host: bindHost,
      socketPath: options.socketPath,
    });
    this.exitOnStop = options.exitOnStop ?? false;
    this.shutdownHandler = options.shutdownHandler;
    this.baseUrl = options.baseUrl;
    this.internalAdminAuthSecret = options.internalAdminAuthSecret;
    this.clientRemoteAddressResolver = options.clientRemoteAddressResolver;
    this.ingressPort = options.ingressPort;
    this.proxy = httpProxy.createProxyServer({
      xfwd: true,
    });

    this.proxy.on('error', (err, _req, res) => {
      this.logger.error('Proxy error:', err);
      if (res && 'writeHead' in res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable', details: err.message }));
      }
    });

    this.proxy.on('proxyRes', (proxyRes, req, res) => {
      this.normalizeProxiedCorsHeaders(req, proxyRes);
      this.sanitizeProxyResponseHeaders(req, proxyRes);
      const interceptedRequest = req as InterceptedRequest;
      const outgoing = res as http.ServerResponse;
      if (!interceptedRequest.__xpodInspectRootMutation || !outgoing || outgoing.headersSent) {
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      proxyRes.on('end', () => {
        const originalBody = Buffer.concat(chunks);
        const rewritten = this.normalizeRootMutationProxyResponse(proxyRes, originalBody);
        outgoing.writeHead(rewritten.statusCode, rewritten.headers);
        outgoing.end(rewritten.body);
      });
    });

    this.server = this.createListener(false);
    if (this.ingressPort !== undefined) {
      this.ingressServer = this.createListener(true);
    }

    if (options.nativeUpgradeRelay ?? isBunRuntime()) {
      this.nativeUpgradeRelay = new BunNativeUpgradeRelay({
        logger: this.logger,
        fallback: (req, socket, head, target) => this.relayUpgradeWithHttpProxy(req, socket, head, target),
      });
    }
  }

  /**
   * Builds one HTTP listener plus its WebSocket routing.
   *
   * `untrustedIngress` marks the listener that tunnels and the P2P data plane
   * connect to; see `ingressPort`.
   */
  private createListener(untrustedIngress: boolean): http.Server {
    const server = http.createServer((req, res) => this.handleRequest(req, res, untrustedIngress));

    server.on('upgrade', (req, socket, head) => {
      this.trackUpgradeSocket(socket);
      const target = this.resolveUpgradeTarget(req.url ?? '/');
      if (!target) {
        socket.destroy();
        return;
      }
      if (this.nativeUpgradeRelay) {
        this.nativeUpgradeRelay.handle(req, socket, head, target);
        return;
      }
      this.relayUpgradeWithHttpProxy(req, socket, head, target);
    });

    return server;
  }

  /**
   * Upgraded sockets outlive the HTTP request that created them; they are
   * tracked so shutdown can drop them instead of waiting for a long lived
   * notification channel to end on its own.
   */
  private trackUpgradeSocket(socket: Duplex): void {
    this.upgradeSockets.add(socket);
    socket.once('close', () => {
      this.upgradeSockets.delete(socket);
    });
  }

  /**
   * Picks the internal service that owns an upgrade path.
   *
   * `/ws/*` and the device notification multiplex live on the API server; every
   * other upgrade (Solid notification channels, edge node tunnels) goes to CSS.
   */
  private resolveUpgradeTarget(url: string): GatewayProxyTarget | undefined {
    if ((url.startsWith('/ws/') || url.startsWith('/v1/notifications/ws')) && this.targets.api) {
      return this.targets.api;
    }
    return this.targets.css;
  }

  private relayUpgradeWithHttpProxy(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: GatewayProxyTarget,
  ): void {
    this.proxy.ws(req, socket, head, { target: this.toProxyTarget(target) as any });
  }

  public setTargets(targets: { css?: string | GatewayProxyTarget; api?: string | GatewayProxyTarget }): void {
    this.targets = {
      css: this.normalizeTarget(targets.css),
      api: this.normalizeTarget(targets.api),
    };
  }

  public async start(): Promise<void> {
    await this.runtimeHost.listen(this.server, this.listenEndpoint);
    this.logger.info(`Listening on ${this.runtimeHost.formatListenEndpoint(this.listenEndpoint)}`);
    if (this.ingressServer) {
      await this.runtimeHost.listen(this.ingressServer, this.ingressListenEndpoint());
      this.logger.info(`Ingress listener on 127.0.0.1:${this.ingressPort} (never local)`);
    }
  }

  public async stop(): Promise<void> {
    this.nativeUpgradeRelay?.close();
    // Upgraded connections never end on their own, so `server.close()` would
    // otherwise wait for an idle notification channel to time out.
    for (const socket of [ ...this.upgradeSockets ]) {
      socket.destroy();
    }
    this.upgradeSockets.clear();
    this.proxy.close();
    await this.closeServer(this.server, this.listenEndpoint);
    if (this.ingressServer) {
      await this.closeServer(this.ingressServer, this.ingressListenEndpoint());
    }
  }

  /**
   * Closes the listener with a bounded wait.
   *
   * The listening socket stops accepting as soon as `close()` is called, but
   * the callback waits for every connection to end. Node keeps upgraded sockets
   * counted until they are destroyed (done above); Bun additionally never calls
   * back once a WebSocket was closed from the server side
   * (oven-sh/bun#28396), so waiting forever would block gateway restarts.
   */
  private async closeServer(server: http.Server, endpoint: RuntimeListenEndpoint): Promise<void> {
    const closing = this.runtimeHost.close(server, endpoint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      closing.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), SERVER_CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut) {
      this.logger.warn(`Gateway server did not report a clean close within ${SERVER_CLOSE_GRACE_MS}ms; continuing shutdown`);
      void closing.catch(() => undefined);
    }
  }

  private ingressListenEndpoint(): RuntimeListenEndpoint {
    return this.runtimeHost.createListenEndpoint({ port: this.ingressPort, host: '127.0.0.1' });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, untrustedIngress = false): void {
    const url = req.url ?? '/';
    // Route matching must ignore the query string: OIDC callbacks and other
    // product URLs arrive as `/ai-connections?code=...`, and exact-path
    // comparisons against req.url would otherwise fall through to CSS and 401.
    const pathname = url.split('?')[0];
    const origin = req.headers.origin;
    const originalRemoteAddress = this.clientRemoteAddressResolver?.(req) ?? req.socket.remoteAddress;
    // A loopback peer address only proves the connection came from this machine: tunnels and
    // the P2P data plane terminate here too. Forwarded-for is what separates them - a local
    // dev proxy forwards this machine's address, while a provider edge appends the address it
    // saw, so a request whose right-most forwarder is not loopback came from outside and is
    // never local, whatever its peer address or headers say.
    const originalClientLoopback = !untrustedIngress
      && !forwardedFromOutside(req)
      && isLoopbackRemoteAddress(originalRemoteAddress);
    const internalPodProxyHeaders = this.verifiedInternalPodProxyHeaders(req, originalClientLoopback);
    stripGatewayAdminProxyHeaders(req.headers);
    if (internalPodProxyHeaders) {
      Object.assign(req.headers, internalPodProxyHeaders);
    }

    // Store public host for routing before any CSS canonical-host rewrites.
    // External gateways pass the original domain through X-Forwarded-Host;
    // direct/local requests use Host.
    const originalHost = this.firstHeaderValue(req.headers['x-forwarded-host']) ?? req.headers.host;
    const originalProto = this.firstHeaderValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim();
    const localCanonicalHost = originalClientLoopback
      ? this.firstHeaderValue(req.headers['x-xpod-canonical-host'])
      : undefined;
    const localCanonicalProto = originalClientLoopback
      ? this.firstHeaderValue(req.headers['x-xpod-canonical-origin'])?.split(':', 1)[0] ?? originalProto
      : undefined;
    const apiHost = this.isApiHost(originalHost);
    const apiPath = this.shouldRouteToApi(pathname);
    const clientCanonicalUrl = originalClientLoopback
      ? this.firstHeaderValue(req.headers[SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER])
      : undefined;
    const clientCanonicalOrigin = originalClientLoopback
      ? this.firstHeaderValue(req.headers[SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER])
      : undefined;
    const clientLocalRouteUrl = originalClientLoopback && localCanonicalHost
      ? this.localRouteUrlFromRequest(originalHost, url)
      : undefined;
    this.stripSolidLocalRouteHeaders(req.headers);
    if (originalClientLoopback && localCanonicalHost) {
      req.headers[SOLID_LOCAL_ROUTE_CANONICAL_HOST_HEADER] = localCanonicalHost;
      if (clientCanonicalUrl) {
        req.headers[SOLID_LOCAL_ROUTE_CANONICAL_URL_HEADER] = clientCanonicalUrl;
      }
      if (clientCanonicalOrigin) {
        req.headers[SOLID_LOCAL_ROUTE_CANONICAL_ORIGIN_HEADER] = clientCanonicalOrigin;
      }
      if (clientLocalRouteUrl) {
        req.headers[SOLID_LOCAL_ROUTE_LOCAL_URL_HEADER] = clientLocalRouteUrl;
      }
    }

    // Set x-forwarded-proto based on CSS_BASE_URL
    const baseUrl = this.baseUrl ?? process.env.CSS_BASE_URL ?? '';
    if (baseUrl.startsWith('https')) {
      req.headers['x-forwarded-proto'] = 'https';
    }

    // API requests keep their signed ingress origin, including single-origin
    // /api and /v1 clients. CSS canonicalization must not change the DPoP htu.
    if (apiHost || apiPath) {
      if (originalHost) {
        req.headers.host = originalHost;
        req.headers['x-forwarded-host'] = originalHost;
      }
      req.headers['x-forwarded-proto'] = originalProto || (apiHost && baseUrl.startsWith('https') ? 'https' : 'http');
    } else if (localCanonicalHost) {
      req.headers.host = localCanonicalHost;
      req.headers['x-forwarded-host'] = localCanonicalHost;
      req.headers['x-forwarded-proto'] = localCanonicalProto || 'https';
    } else if (baseUrl) {
      try {
        const parsedBaseUrl = new URL(baseUrl);
        req.headers.host = parsedBaseUrl.host;
        req.headers['x-forwarded-host'] = parsedBaseUrl.host;
      } catch {
        if (!req.headers['x-forwarded-host']) {
          req.headers['x-forwarded-host'] = originalHost;
        }
      }
    } else if (!req.headers['x-forwarded-host']) {
      req.headers['x-forwarded-host'] = originalHost;
    }

    this.logger.debug(
      `${req.method} ${url} x-forwarded-proto=${req.headers['x-forwarded-proto']} x-forwarded-host=${req.headers['x-forwarded-host']} host=${req.headers.host}`,
    );

    // 1. Internal service endpoints
    if (pathname.startsWith('/service/')) {
      if (req.method === 'OPTIONS') {
        this.handleCorsPreflightRequest(res, origin);
        return;
      }
      if (origin) {
        this.addCorsHeaders(res, origin);
      }
      void this.handleInternalApi(req, res);
      return;
    }

    // 2. API Server Routing.
    // Public API is selected by host (`api.<domain>`), not by adding an `/api`
    // path prefix to the IdP/Pod host. Path-based routing remains for local/dev
    // single-origin clients and existing legacy endpoints.

    // 2a. Xpod web products are served by the API server.
    if (this.isApiWebProductPath(pathname) && this.targets.api) {
      this.applyInternalAdminProxyHeaders(req, originalClientLoopback);
      this.proxy.web(req, res, { target: this.toProxyTarget(this.targets.api) as any });
      return;
    }

    if ((apiHost || apiPath) && this.targets.api) {
      this.applyInternalAdminProxyHeaders(req, originalClientLoopback);
      this.proxy.web(req, res, { target: this.toProxyTarget(this.targets.api) as any });
      return;
    }

    // 3. CSS Routing (Default)
    if (this.targets.css) {
      if (this.shouldRejectRootResourceMutation(req)) {
        this.writeRootMutationForbidden(res);
        return;
      }

      const interceptedRequest = req as InterceptedRequest;
      interceptedRequest.__xpodInspectRootMutation = this.shouldInspectRootMutation(req);
      if (clientLocalRouteUrl && clientCanonicalUrl) {
        // Unix-socket CSS peers have no IP address. Attest the original local
        // transport using the existing internal signature; CSS still verifies
        // the user's DPoP proof against the actual ingress URL.
        this.applyInternalAdminProxyHeaders(req, originalClientLoopback);
      }
      this.proxy.web(req, res, {
        target: this.toProxyTarget(this.targets.css) as any,
        ...(interceptedRequest.__xpodInspectRootMutation ? { selfHandleResponse: true } : {}),
      } as any);
    } else {
      res.writeHead(503);
      res.end('CSS Service Not Available');
    }
  }

  private isApiWebProductPath(url: string): boolean {
    const pathname = this.pathnameFromRequestUrl(url);
    return [
      '/dashboard',
      '/status',
      '/network',
      '/settings',
      '/ai-config',
      '/ai-connections',
    ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
      || pathname === '/auth/callback'
      || pathname === '/auth/callback/theme-init.js'
      || pathname === '/auth/callback/assets'
      || pathname.startsWith('/auth/callback/assets/');
  }

  private shouldRouteToApi(url: string): boolean {
    const pathname = this.pathnameFromRequestUrl(url);
    return pathname.startsWith('/v1/')
      || pathname.startsWith('/api/')
      || pathname.startsWith('/provision/')
      || pathname === '/.well-known/matrix/client'
      || pathname.startsWith('/_matrix/');
  }

  private pathnameFromRequestUrl(url: string): string {
    try {
      return new URL(url, 'http://xpod-gateway.invalid').pathname;
    } catch {
      return url.split('?', 1)[0] ?? '/';
    }
  }

  private applyInternalAdminProxyHeaders(req: http.IncomingMessage, originalClientLoopback: boolean): void {
    if (!this.internalAdminAuthSecret) {
      req.headers[GATEWAY_ADMIN_PROXY_LOOPBACK_HEADER] = originalClientLoopback ? '1' : '0';
      return;
    }
    Object.assign(req.headers, createGatewayAdminProxyHeaders({
      secret: this.internalAdminAuthSecret,
      method: req.method,
      url: req.url,
      originalClientLoopback,
    }));
  }

  private verifiedInternalPodProxyHeaders(
    req: http.IncomingMessage,
    originalClientLoopback: boolean,
  ): http.IncomingHttpHeaders | undefined {
    if (!originalClientLoopback || req.url !== '/.internal/pod-data') {
      return undefined;
    }

    const verification = verifyGatewayAdminProxyHeaders({
      headers: req.headers,
      secret: this.internalAdminAuthSecret,
      method: req.method,
      url: req.url,
    });
    if (!verification.valid || !verification.originalClientLoopback || !verification.intent || !verification.nonce) {
      return undefined;
    }

    return Object.fromEntries(GATEWAY_ADMIN_PROXY_HEADERS.flatMap((header) => {
      const value = req.headers[header];
      return value === undefined ? [] : [[header, value]];
    }));
  }

  private isApiHost(hostHeader: string | undefined): boolean {
    const host = this.normalizeHost(hostHeader);
    if (!host) {
      return false;
    }
    if (host.startsWith('api.') || host.startsWith('registry.')) {
      return true;
    }

    const configuredHosts = this.configuredApiHosts();
    return configuredHosts.includes(host);
  }

  private configuredApiHosts(): string[] {
    return [
      process.env.XPOD_PUBLIC_API_URL,
      process.env.XPOD_PUBLIC_REGISTRY_URL,
    ]
      .flatMap((value) => this.hostsFromUrlList(value))
      .filter((host): host is string => Boolean(host));
  }

  private hostsFromUrlList(value: string | undefined): Array<string | undefined> {
    if (!value) {
      return [];
    }
    return value.split(',').map((entry) => this.hostFromUrl(entry.trim()));
  }

  private hostFromUrl(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return new URL(value).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }

  private normalizeHost(hostHeader: string | undefined): string | undefined {
    const host = this.firstHeaderValue(hostHeader)?.split(',')[0]?.trim();
    if (!host) {
      return undefined;
    }
    return host.replace(/:\d+$/, '').toLowerCase();
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private stripSolidLocalRouteHeaders(headers: http.IncomingHttpHeaders): void {
    for (const header of SOLID_LOCAL_ROUTE_HEADERS) {
      delete headers[header];
    }
  }

  private localRouteUrlFromRequest(hostHeader: string | undefined, url: string): string | undefined {
    const host = this.firstHeaderValue(hostHeader);
    if (!host) {
      return undefined;
    }
    try {
      return new URL(url, `http://${host}`).toString();
    } catch {
      return undefined;
    }
  }

  private shouldInspectRootMutation(req: http.IncomingMessage): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    if (![ 'POST', 'PUT', 'PATCH', 'DELETE' ].includes(method)) {
      return false;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments.length === 1 && !segments[0].startsWith('.');
  }

  private shouldRejectRootResourceMutation(req: http.IncomingMessage): boolean {
    const method = (req.method ?? 'GET').toUpperCase();
    if (![ 'POST', 'PUT', 'PATCH', 'DELETE' ].includes(method)) {
      return false;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments.length === 1 && !segments[0].startsWith('.') && !pathname.endsWith('/');
  }

  private writeRootMutationForbidden(res: http.ServerResponse): void {
    const body = Buffer.from(JSON.stringify(this.createRootMutationForbiddenBody()));
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Content-Length': String(body.byteLength),
    });
    res.end(body);
  }

  private normalizeRootMutationProxyResponse(
    proxyRes: http.IncomingMessage,
    body: Buffer,
  ): { statusCode: number; headers: http.OutgoingHttpHeaders; body: Buffer } {
    const headers: http.OutgoingHttpHeaders = { ...proxyRes.headers };
    const statusCode = proxyRes.statusCode ?? 500;
    const contentType = typeof proxyRes.headers['content-type'] === 'string'
      ? proxyRes.headers['content-type']
      : Array.isArray(proxyRes.headers['content-type'])
        ? proxyRes.headers['content-type'][0] ?? ''
        : '';
    const bodyText = contentType.includes('application/json') ? body.toString('utf8') : '';

    if (
      statusCode === 500 &&
      bodyText.includes('Cannot obtain the parent of') &&
      bodyText.includes('because it is a root container')
    ) {
      const normalizedBody = Buffer.from(JSON.stringify(this.createRootMutationForbiddenBody()));
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(normalizedBody.byteLength);
      return { statusCode: 403, headers, body: normalizedBody };
    }

    delete headers['transfer-encoding'];
    headers['content-length'] = String(body.byteLength);
    return { statusCode, headers, body };
  }

  private createRootMutationForbiddenBody(): RootMutationForbiddenBody {
    return {
      name: 'ForbiddenHttpError',
      message: 'Write to server root is not allowed.',
      statusCode: 403,
      errorCode: 'H403',
      details: { cause: 'root-container-write' },
    };
  }

  private sanitizeProxyResponseHeaders(req: http.IncomingMessage, proxyRes: http.IncomingMessage): void {
    const method = (req.method ?? 'GET').toUpperCase();
    const statusCode = proxyRes.statusCode ?? 200;
    const headers = proxyRes.headers as Record<string, string | string[] | undefined>;
    const transferEncoding = headers['transfer-encoding'];
    const hasTransferEncoding = Array.isArray(transferEncoding)
      ? transferEncoding.some((value) => value.toLowerCase().includes('chunked'))
      : typeof transferEncoding === 'string'
        ? transferEncoding.toLowerCase().includes('chunked')
        : false;

    if (method === 'HEAD' || statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200)) {
      delete headers['transfer-encoding'];
      return;
    }

    if (hasTransferEncoding) {
      delete headers['transfer-encoding'];
      if (headers['content-length'] !== undefined) {
        delete headers['content-length'];
      }
    }
  }

  private normalizeProxiedCorsHeaders(
    req: http.IncomingMessage,
    proxyRes: http.IncomingMessage,
  ): void {
    const origin = req.headers.origin;
    if (!origin) {
      return;
    }
    proxyRes.headers['access-control-allow-origin'] = origin;
    proxyRes.headers['access-control-allow-credentials'] = 'true';
    const vary = proxyRes.headers.vary;
    const varyValues = (Array.isArray(vary) ? vary : [vary])
      .flatMap((value) => value?.split(',') ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (!varyValues.some((value) => value.toLowerCase() === 'origin')) {
      varyValues.push('Origin');
    }
    proxyRes.headers.vary = varyValues.join(', ');
  }

  private handleCorsPreflightRequest(
    res: http.ServerResponse,
    origin: string | undefined,
  ): void {
    this.addCorsHeaders(res, origin);
    res.writeHead(204);
    res.end();
  }

  /**
   * Add CORS headers matching CSS CorsHandler configuration
   */
  private addCorsHeaders(res: http.ServerResponse, origin: string | undefined): void {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', String(CORS_CONFIG.credentials));
    res.setHeader('Access-Control-Allow-Methods', CORS_CONFIG.methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', CORS_CONFIG.allowedHeaders.join(', '));
    res.setHeader('Access-Control-Expose-Headers', CORS_CONFIG.exposedHeaders.join(', '));
  }

  private async handleInternalApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const reqUrl = req.url ?? '/';
      const parsed = new URL(reqUrl, 'http://localhost');
      const pathname = parsed.pathname;

      if (pathname === '/service/status') {
        const status = this.supervisor.getAllStatus();
        const cssReady = await this.isCssReady();
        const code = cssReady ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (pathname === '/service/logs') {
        const level = parsed.searchParams.get('level') ?? undefined;
        const source = parsed.searchParams.get('source') ?? undefined;
        const limitValue = parsed.searchParams.get('limit');
        const limit = limitValue ? parseInt(limitValue, 10) : undefined;

        const logs = this.supervisor.getLogs({
          level,
          source,
          limit: Number.isFinite(limit as number) ? limit : undefined,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(logs));
        return;
      }

      const restartMatch = /^\/service\/restart\/([^/]+)$/.exec(pathname);
      if (restartMatch && req.method === 'POST') {
        const service = decodeURIComponent(restartMatch[1]);
        if (service === 'gateway') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Gateway restart requires restarting the whole Xpod runtime.',
            scope: 'runtime',
          }));
          return;
        }
        if (service !== 'css' && service !== 'api') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unknown service.' }));
          return;
        }
        const accepted = await this.supervisor.restart(service);
        res.writeHead(accepted ? 202 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accepted
          ? { ok: true, service }
          : { error: `${service} is not managed by this runtime.`, service }));
        return;
      }

      if (pathname === '/service/stop' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setImmediate(() => {
          const shutdown = this.shutdownHandler ?? (() => this.supervisor.stopAll());
          void shutdown().then(() => {
            if (this.exitOnStop) {
              process.exit(0);
            }
          });
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (error) {
      this.logger.error('Internal service endpoint failed:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  }

  private async isCssReady(): Promise<boolean> {
    if (!this.targets.css) {
      return true;
    }

    return this.runtimeHost.isConnectionTargetReady(this.targets.css, 1_500);
  }

  private normalizeTarget(target?: string | GatewayProxyTarget): GatewayProxyTarget | undefined {
    if (!target) {
      return undefined;
    }
    if (typeof target === 'string') {
      return { url: target };
    }
    return target;
  }

  private toProxyTarget(target: GatewayProxyTarget): string | { socketPath: string; protocol: string } {
    if (target.socketPath) {
      return {
        socketPath: target.socketPath,
        protocol: 'http:',
      };
    }
    return target.url!;
  }
}

export interface GatewayProxyTarget {
  url?: string;
  socketPath?: string;
}

export interface GatewayProxyOptions {
  socketPath?: string;
  listenEndpoint?: RuntimeListenEndpoint;
  runtimeHost?: RuntimeHost;
  exitOnStop?: boolean;
  shutdownHandler?: () => Promise<void>;
  baseUrl?: string;
  internalAdminAuthSecret?: string;
  clientRemoteAddressResolver?: (req: http.IncomingMessage) => string | undefined;
  /**
   * Forces the native (message level) upgrade relay on or off.
   * Defaults to `true` on Bun, where the `http-proxy` relay cannot reach the
   * client socket at all.
   */
  nativeUpgradeRelay?: boolean;
  /**
   * Port for the loopback-only ingress listener that remote forwarding paths
   * (managed tunnels, P2P data plane) use as their origin. Omit it when the
   * Gateway has no remote ingress.
   */
  ingressPort?: number;
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/**
 * Whether the client-address headers say this request travelled through a forwarder outside
 * this machine.
 *
 * This is the fallback behind the structural gate (the Gateway's tunnel entry listener): a
 * tunnel pointed at the Gateway port by mistake still must not inherit local trust. Only
 * headers that carry a client *address* count - `x-forwarded-for`, `x-real-ip` and the
 * `for=` part of `Forwarded`. `x-forwarded-host`/`x-forwarded-proto` do not: a local dev proxy
 * sets them for local browsers too, so treating them as evidence would lock the operator out
 * of their own admin surface.
 *
 * The right-most value is the address the last forwarder saw - the one our own handlers append
 * (`ClusterIngressRouter`, `EdgeNodeProxyHttpHandler`, `PodRoutingHttpHandler`) - so a client
 * cannot look local by sending its own. An unreadable value is treated as remote.
 */
export function forwardedFromOutside(req: http.IncomingMessage): boolean {
  const evidence = [
    ...splitHeaderList(req.headers['x-forwarded-for']),
    ...splitHeaderList(req.headers['x-real-ip']),
    ...forwardedForParameters(req.headers.forwarded),
  ];
  const last = evidence.at(-1);
  if (last === undefined) {
    return false;
  }
  return isIP(last) === 0 || !isLoopbackRemoteAddress(last);
}

function splitHeaderList(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
}

/** The `for=` values of an RFC 7239 `Forwarded` header, in order. */
function forwardedForParameters(raw: string | string[] | undefined): string[] {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value) {
    return [];
  }
  return value.split(/[;,]/u)
    .map((part) => /^\s*for\s*=\s*(.+)$/iu.exec(part.trim())?.[1])
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replace(/^"|"$/gu, '').replace(/^\[|\]$/gu, ''));
}
