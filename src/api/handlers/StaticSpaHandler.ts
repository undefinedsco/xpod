import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

export interface StaticSpaRouteOptions {
  prefix: `/${string}`;
  staticDir: string;
  entryFiles: readonly string[];
  label: string;
}

function resolveEntry(staticDir: string, entryFiles: readonly string[]): string | undefined {
  return entryFiles
    .map((entry) => path.join(staticDir, entry))
    .find((entry) => fs.existsSync(entry));
}

export function registerStaticSpaRoutes(server: ApiServer, options: StaticSpaRouteOptions): void {
  const { prefix, staticDir, entryFiles, label } = options;
  if (!fs.existsSync(staticDir)) {
    console.warn(`[${label}] Static directory not found: ${staticDir}`);
    console.warn(`[${label}] Run "bun run build:ui" to build the UI products`);
    return;
  }

  console.log(`[${label}] Serving from: ${staticDir}`);

  const redirectHandler: RouteHandler = async (_req, res) => {
    res.statusCode = 302;
    res.setHeader('Location', `${prefix}/`);
    res.end();
  };

  const staticHandler: RouteHandler = async (
    req: AuthenticatedRequest,
    res: ServerResponse,
    params: Record<string, string>,
  ) => {
    const filePath = params.path || '';
    if (filePath.includes('..')) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let fullPath = path.join(staticDir, filePath);
    if (!filePath || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      fullPath = resolveEntry(staticDir, entryFiles) ?? fullPath;
    }

    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    try {
      const content = fs.readFileSync(fullPath);
      const ext = path.extname(fullPath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000');
      res.end((req.method ?? 'GET').toUpperCase() === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error(`[${label}] Error reading file: ${fullPath}`, error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  };

  server.get(prefix, redirectHandler, { public: true });
  server.get(`${prefix}/`, staticHandler, { public: true });
  server.get(`${prefix}/*path`, staticHandler, { public: true });
  server.route('HEAD', prefix, redirectHandler, { public: true });
  server.route('HEAD', `${prefix}/`, staticHandler, { public: true });
  server.route('HEAD', `${prefix}/*path`, staticHandler, { public: true });
}
