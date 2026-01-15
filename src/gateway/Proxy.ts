import httpProxy from 'http-proxy';
import http from 'http';
import type { Supervisor } from './Supervisor';

// CORS configuration matching CSS CorsHandler defaults
const CORS_CONFIG = {
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
  allowedHeaders: [
    'Authorization', 'Content-Type', 'Accept', 'DPoP', 'Origin',
    'X-Requested-With', 'If-Match', 'If-None-Match', 'Slug', 'Link'
  ],
  exposedHeaders: [
    'Accept-Patch', 'Accept-Post', 'Accept-Put', 'Allow', 'Content-Range',
    'ETag', 'Last-Modified', 'Link', 'Location', 'Updates-Via',
    'WAC-Allow', 'Www-Authenticate', 'X-Request-Id'
  ]
};

export class GatewayProxy {
  private proxy: httpProxy;
  private server: http.Server;
  private targets: { css?: string; api?: string } = {};

  constructor(private port: number, private supervisor: Supervisor) {
    this.proxy = httpProxy.createProxyServer({
      xfwd: true,
    });

    this.proxy.on('error', (err, _req, res) => {
      console.error('[Gateway] Proxy error:', err);
      if (res && 'writeHead' in res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable', details: err.message }));
      }
    });

    this.server = http.createServer(this.handleRequest.bind(this));

    this.server.on('upgrade', (req, socket, head) => {
      if (this.targets.css) {
        this.proxy.ws(req, socket, head, { target: this.targets.css });
      } else {
        socket.destroy();
      }
    });
  }

  public setTargets(targets: { css?: string; api?: string }) {
    this.targets = targets;
  }

  public start(): void {
    this.server.listen(this.port, () => {
      console.log(`[Gateway] Listening on http://localhost:${this.port}`);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const origin = req.headers.origin;

    // Add x-forwarded-host for proper DPoP verification
    if (!req.headers['x-forwarded-host']) {
      req.headers['x-forwarded-host'] = req.headers.host;
    }

    // 1. Gateway Internal API (Status & Control) - Gateway handles CORS
    if (url.startsWith('/_gateway/')) {
      if (req.method === 'OPTIONS') {
        this.handleCorsPreflightRequest(res, origin);
        return;
      }
      if (origin) {
        this.addCorsHeaders(res, origin);
      }
      this.handleInternalApi(req, res);
      return;
    }

    // 2. API Server Routing (/v1 or /api) - API Server handles its own CORS
    if ((url.startsWith('/v1/') || url.startsWith('/api/')) && this.targets.api) {
      this.proxy.web(req, res, { target: this.targets.api });
      return;
    }

    // 3. CSS Routing (Default) - CSS handles its own CORS
    if (this.targets.css) {
      this.proxy.web(req, res, { target: this.targets.css });
    } else {
      res.writeHead(503);
      res.end('CSS Service Not Available');
    }
  }

  private handleCorsPreflightRequest(
    res: http.ServerResponse,
    origin: string | undefined
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

  private handleInternalApi(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/_gateway/status') {
      const status = this.supervisor.getAllStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }
}
