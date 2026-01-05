import httpProxy from 'http-proxy';
import http from 'http';
import type { Supervisor } from './Supervisor';

export class GatewayProxy {
  private proxy: httpProxy;
  private server: http.Server;
  private targets: { css?: string; api?: string } = {};

  constructor(private port: number, private supervisor: Supervisor) {
    this.proxy = httpProxy.createProxyServer({
      // Essential for CSS to trust headers
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
      // WebSocket traffic (Solid Notifications) goes to CSS
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

    // 1. Gateway Internal API (Status & Control)
    if (url.startsWith('/_gateway/')) {
      this.handleInternalApi(req, res);
      return;
    }

    // 2. API Server Routing (/v1 or /api)
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
