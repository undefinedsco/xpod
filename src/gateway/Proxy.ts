import httpProxy from 'http-proxy';
import http from 'http';
import { getLoggerFor } from 'global-logger-factory';
import type { Supervisor } from './Supervisor';

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
  private targets: { css?: string; api?: string } = {};

  constructor(private port: number, private supervisor: Supervisor, private bindHost = '0.0.0.0') {
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

    this.server = http.createServer(this.handleRequest.bind(this));

    this.server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '/';

      // Route /ws/* WebSocket connections to API server
      if (url.startsWith('/ws/') && this.targets.api) {
        this.proxy.ws(req, socket, head, { target: this.targets.api });
      } else if (this.targets.css) {
        this.proxy.ws(req, socket, head, { target: this.targets.css });
      } else {
        socket.destroy();
      }
    });
  }

  public setTargets(targets: { css?: string; api?: string }): void {
    this.targets = targets;
  }

  public start(): void {
    this.server.listen(this.port, this.bindHost, () => {
      this.logger.info(`Listening on http://${this.bindHost}:${this.port}`);
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const origin = req.headers.origin;

    // Store original host for x-forwarded-host before any rewrites
    const originalHost = req.headers.host;

    // Set x-forwarded-proto based on CSS_BASE_URL
    const baseUrl = process.env.CSS_BASE_URL || '';
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

    // 1. Gateway internal service endpoints
    if (url.startsWith('/service/') || url.startsWith('/_gateway/')) {
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
      this.proxy.web(req, res, { target: this.targets.api });
      return;
    }

    if ((url.startsWith('/v1/') || url.startsWith('/api/')) && this.targets.api) {
      this.proxy.web(req, res, { target: this.targets.api });
      return;
    }

    // 3. CSS Routing (Default)
    if (this.targets.css) {
      this.proxy.web(req, res, { target: this.targets.css });
    } else {
      res.writeHead(503);
      res.end('CSS Service Not Available');
    }
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

    try {
      // NOTE: CSS is configured with public `baseUrl` pointing at the gateway,
      // so probing the internal CSS port can fail identifier-space checks.
      // We probe through the gateway itself to mirror real client traffic.
      const gatewayBase = `http://127.0.0.1:${this.port}/`;
      const candidates = [
        // CSS OIDC lives under /.oidc/*
        new URL('.oidc/.well-known/openid-configuration', gatewayBase).toString(),
        // Some deployments expose the well-known at root
        new URL('.well-known/openid-configuration', gatewayBase).toString(),
      ];

      for (const probeUrl of candidates) {
        try {
          const response = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
          if (response.ok) {
            return true;
          }
        } catch {
          // Try next candidate.
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}
