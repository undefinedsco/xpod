import httpProxy from 'http-proxy';
import http from 'http';
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

    this.server = http.createServer(this.handleRequest.bind(this));

    this.server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '/';

      // Route /ws/* and device notification WebSocket connections to API server
      if ((url.startsWith('/ws/') || url.startsWith('/v1/notifications/ws')) && this.targets.api) {
        this.proxy.ws(req, socket, head, { target: this.toProxyTarget(this.targets.api) as any });
      } else if (this.targets.css) {
        this.proxy.ws(req, socket, head, { target: this.toProxyTarget(this.targets.css) as any });
      } else {
        socket.destroy();
      }
    });
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
  }

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxy.close();
      this.runtimeHost.close(this.server, this.listenEndpoint).then(() => {
        resolve();
      }, reject);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    // Route matching must ignore the query string: OIDC callbacks and other
    // product URLs arrive as `/ai-connections?code=...`, and exact-path
    // comparisons against req.url would otherwise fall through to CSS and 401.
    const pathname = url.split('?')[0];
    const origin = req.headers.origin;
    const originalRemoteAddress = this.clientRemoteAddressResolver?.(req) ?? req.socket.remoteAddress;
    const originalClientLoopback = isLoopbackRemoteAddress(originalRemoteAddress);
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
}
