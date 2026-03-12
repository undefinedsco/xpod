import httpProxy from 'http-proxy';
import http from 'http';
import { getLoggerFor } from 'global-logger-factory';
import type { Supervisor } from '../supervisor/Supervisor';
import { nodeRuntimeHost } from './host/node/NodeRuntimeHost';
import type { RuntimeHost, RuntimeListenEndpoint } from './host/types';

type InterceptedRequest = http.IncomingMessage & { __xpodInspectRootMutation?: boolean };

// CORS configuration matching CSS CorsHandler defaults
const CORS_CONFIG = {
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
  allowedHeaders: [
    'Authorization', 'Content-Type', 'Accept', 'DPoP', 'Origin',
    'X-Requested-With', 'If-Match', 'If-None-Match', 'Slug', 'Link',
  ],
  exposedHeaders: [
    'Accept-Patch', 'Accept-Post', 'Accept-Put', 'Allow', 'Content-Range',
    'ETag', 'Last-Modified', 'Link', 'Location', 'Updates-Via',
    'WAC-Allow', 'Www-Authenticate', 'X-Request-Id',
  ],
};

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

      // Route /ws/* WebSocket connections to API server
      if (url.startsWith('/ws/') && this.targets.api) {
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
    const origin = req.headers.origin;

    // Store original host for x-forwarded-host before any rewrites
    const originalHost = req.headers.host;

    // Set x-forwarded-proto based on CSS_BASE_URL
    const baseUrl = this.baseUrl ?? process.env.CSS_BASE_URL ?? '';
    if (baseUrl.startsWith('https')) {
      req.headers['x-forwarded-proto'] = 'https';
    }

    // Rewrite Host header to match CSS_BASE_URL for proper routing
    if (baseUrl) {
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
    if (url.startsWith('/service/')) {
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

    // 2. API Server Routing (/v1 or /api)

    // 2a. Dashboard UI is served by API server under /dashboard/*
    if ((url === '/dashboard' || url.startsWith('/dashboard/')) && this.targets.api) {
      this.proxy.web(req, res, { target: this.toProxyTarget(this.targets.api) as any });
      return;
    }

    if ((url.startsWith('/v1/') || url.startsWith('/api/') || url.startsWith('/provision/')) && this.targets.api) {
      this.proxy.web(req, res, { target: this.toProxyTarget(this.targets.api) as any });
      return;
    }

    // 3. CSS Routing (Default)
    if (this.targets.css) {
      const interceptedRequest = req as InterceptedRequest;
      interceptedRequest.__xpodInspectRootMutation = this.shouldInspectRootMutation(req);
      this.proxy.web(req, res, {
        target: this.toProxyTarget(this.targets.css) as any,
        ...(interceptedRequest.__xpodInspectRootMutation ? { selfHandleResponse: true } : {}),
      } as any);
    } else {
      res.writeHead(503);
      res.end('CSS Service Not Available');
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
      const normalizedBody = Buffer.from(JSON.stringify({
        name: 'ForbiddenHttpError',
        message: 'Write to server root is not allowed.',
        statusCode: 403,
        errorCode: 'H403',
        details: { cause: 'root-container-write' },
      }));
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
}
