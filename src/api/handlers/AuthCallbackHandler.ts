import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';

const ENTRY_FILE = 'auth-callback.html';
const ASSET_PREFIX = '/auth/callback/assets/';
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface AuthCallbackHandlerOptions {
  staticDir: string;
}

/**
 * Serve the browser-only callback entry and its immutable assets.
 *
 * This route deliberately contains no OIDC, Account, or token handling. The
 * callback JavaScript loaded from the entry performs protocol completion in
 * the browser with Inrupt's existing session adapter.
 */
export function registerAuthCallbackRoutes(
  server: ApiServer,
  options: AuthCallbackHandlerOptions,
): void {
  const staticDir = path.resolve(options.staticDir);
  const serveEntry: RouteHandler = async (req, res) => {
    await serveFile(req, res, staticDir, ENTRY_FILE, 'text/html', 'no-cache');
  };
  const serveAsset: RouteHandler = async (req, res, params) => {
    const relativePath = params.path ?? '';
    if (!relativePath || relativePath.includes('..') || relativePath.includes('\\')) {
      writeNotFound(res);
      return;
    }
    await serveFile(req, res, staticDir, path.join('assets', relativePath));
  };

  // Exact path only: unlike a SPA product, a callback URL must never be
  // redirected or rewritten because its query carries the OIDC response.
  server.get('/auth/callback', serveEntry, { public: true });
  server.route('HEAD', '/auth/callback', serveEntry, { public: true });
  server.get(`${ASSET_PREFIX}*path`, serveAsset, { public: true });
  server.route('HEAD', `${ASSET_PREFIX}*path`, serveAsset, { public: true });
}

async function serveFile(
  req: AuthenticatedRequest,
  res: ServerResponse,
  staticDir: string,
  relativePath: string,
  contentTypeOverride?: string,
  cacheControlOverride?: string,
): Promise<void> {
  const fullPath = path.resolve(staticDir, relativePath);
  if (!isWithinDirectory(fullPath, staticDir)) {
    writeNotFound(res);
    return;
  }

  let content: Buffer;
  try {
    const stats = await fs.promises.stat(fullPath);
    if (!stats.isFile()) {
      writeNotFound(res);
      return;
    }
    content = await fs.promises.readFile(fullPath);
  } catch {
    writeNotFound(res);
    return;
  }

  const extension = path.extname(fullPath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeOverride ?? MIME_TYPES[extension] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', cacheControlOverride ?? 'public, max-age=31536000, immutable');
  res.setHeader('Content-Length', content.byteLength);
  if ((req.method ?? 'GET').toUpperCase() !== 'HEAD') {
    res.end(content);
  } else {
    res.end();
  }
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function writeNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not Found' }));
}
