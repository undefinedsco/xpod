import httpProxy from 'http-proxy';
import http from 'http';
import type { Supervisor } from './Supervisor';
import { logger } from '../util/logger';

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
      logger.error('Proxy error:', err);
      this.supervisor.addLog('xpod', 'error', `Proxy error: ${err.message}`);
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
      const msg = `Listening on http://localhost:${this.port}`;
      logger.log(msg);
      this.supervisor.addLog('xpod', 'info', msg);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    const origin = req.headers.origin;

    // Add x-forwarded-host for proper DPoP verification
    if (!req.headers['x-forwarded-host']) {
      req.headers['x-forwarded-host'] = req.headers.host;
    }

    // 1. Internal API (Status & Control) - handled here with CORS
    if (url.startsWith('/service/')) {
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

    // 2. API Server Routing (/v1, /api, /chatkit, /dashboard) - API Server handles its own CORS
    if ((url.startsWith('/v1/') || url.startsWith('/api/') || url.startsWith('/chatkit') || url.startsWith('/dashboard')) && this.targets.api) {
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
    if (req.url === '/service/status') {
      const status = this.supervisor.getAllStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // SSE endpoint for streaming logs
    if (req.url === '/service/logs/stream') {
      this.handleLogStream(req, res);
      return;
    }

    if (req.url?.startsWith('/service/logs')) {
      // Parse query parameters
      const url = new URL(req.url, `http://localhost:${this.port}`);
      const level = url.searchParams.get('level') || 'all';
      const source = url.searchParams.get('source') || 'all';
      const limit = parseInt(url.searchParams.get('limit') || '500', 10);
      
      let logs = this.supervisor.getLogs();
      
      // Filter by level
      if (level !== 'all') {
        logs = logs.filter(log => log.level === level);
      }
      
      // Filter by source
      if (source !== 'all') {
        logs = logs.filter(log => log.source === source);
      }
      
      // Apply limit (get last N logs)
      if (logs.length > limit) {
        logs = logs.slice(-limit);
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(logs));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  /**
   * Handle SSE log streaming
   */
  private handleLogStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial logs
    const logs = this.supervisor.getLogs();
    res.write(`data: ${JSON.stringify({ type: 'init', logs: logs.slice(-100) })}

`);

    // Set up interval to send new logs
    let lastIndex = logs.length;
    const interval = setInterval(() => {
      const currentLogs = this.supervisor.getLogs();
      if (currentLogs.length > lastIndex) {
        const newLogs = currentLogs.slice(lastIndex);
        res.write(`data: ${JSON.stringify({ type: 'update', logs: newLogs })}

`);
        lastIndex = currentLogs.length;
      }
    }, 1000);

    // Clean up on connection close
    req.on('close', () => {
      clearInterval(interval);
    });

    req.on('error', () => {
      clearInterval(interval);
    });
  }
}
