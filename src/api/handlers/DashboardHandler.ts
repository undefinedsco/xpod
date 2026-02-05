/**
 * Dashboard 静态资源处理器
 *
 * Serve /dashboard/ 路径下的运维 UI 静态资源
 */

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

export interface DashboardHandlerOptions {
  /** 静态资源目录路径 */
  staticDir: string;
}

/**
 * 注册 Dashboard 路由
 */
export function registerDashboardRoutes(
  server: ApiServer,
  options: DashboardHandlerOptions,
): void {
  const { staticDir } = options;

  // 检查目录是否存在
  if (!fs.existsSync(staticDir)) {
    console.warn(`[Dashboard] Static directory not found: ${staticDir}`);
    console.warn('[Dashboard] Run "cd dashboard && yarn build" to build the dashboard UI');
    return;
  }

  console.log(`[Dashboard] Serving from: ${staticDir}`);

  // 处理 /dashboard 和 /dashboard/ 重定向
  const redirectHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
  ) => {
    res.statusCode = 302;
    res.setHeader('Location', '/dashboard/');
    res.end();
  };

  // 静态资源处理器
  const staticHandler: RouteHandler = async (
    _req: AuthenticatedRequest,
    res: ServerResponse,
    params: Record<string, string>,
  ) => {
    let filePath = params.path || 'index.html';

    // 安全检查：防止路径遍历
    if (filePath.includes('..')) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    let fullPath = path.join(staticDir, filePath);

    // 如果是目录，尝试 dashboard.html
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      fullPath = path.join(fullPath, 'index.html');
    }

    // 如果文件不存在，返回 dashboard.html (SPA fallback)
    if (!fs.existsSync(fullPath)) {
      fullPath = path.join(staticDir, 'index.html');
    }

    // 再次检查文件是否存在
    if (!fs.existsSync(fullPath)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    // 获取 MIME 类型
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    // 读取并返回文件
    try {
      const content = fs.readFileSync(fullPath);
      res.statusCode = 200;
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000');
      res.end(content);
    } catch (error) {
      console.error(`[Dashboard] Error reading file: ${fullPath}`, error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  };

  // 注册路由 - 都是 public 的，不需要认证
  // 使用通配符 *path 匹配所有子路径（包括 assets/xxx.js）
  server.get('/dashboard', redirectHandler, { public: true });
  server.get('/dashboard/', staticHandler, { public: true });
  server.get('/dashboard/*path', staticHandler, { public: true });
}
