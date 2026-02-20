import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthMiddleware, AuthenticatedRequest } from './middleware/AuthMiddleware';

/**
 * Route handler function
 */
export type RouteHandler = (
  request: AuthenticatedRequest,
  response: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

/**
 * Route definition
 */
export interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
  /** If true, skip authentication */
  public?: boolean;
}

export interface ApiServerOptions {
  port: number;
  host?: string;
  authMiddleware: AuthMiddleware;
  corsOrigins?: string[];
}

/**
 * Standalone API Server
 */
export class ApiServer {
  private readonly logger = getLoggerFor(this);
  private readonly port: number;
  private readonly host: string;
  private readonly authMiddleware: AuthMiddleware;
  private readonly corsOrigins: string[];
  private readonly routes: Route[] = [];
  private server?: Server;

  public constructor(options: ApiServerOptions) {
    this.port = options.port;
    this.host = options.host ?? '0.0.0.0';
    this.authMiddleware = options.authMiddleware;
    this.corsOrigins = options.corsOrigins ?? ['*'];
  }

  /**
   * Register a route
   */
  public route(
    method: string,
    path: string,
    handler: RouteHandler,
    options?: {
      /** If true, skip authentication for this route */
      public?: boolean;
    },
  ): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
      public: options?.public,
    });
    this.logger.debug(`Registered route: ${method.toUpperCase()} ${path}${options?.public ? ' (public)' : ''}`);
  }

  /**
   * Convenience methods for common HTTP methods
   */
  public get(path: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.route('GET', path, handler, options);
  }

  public post(path: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.route('POST', path, handler, options);
  }

  public put(path: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.route('PUT', path, handler, options);
  }

  public delete(path: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.route('DELETE', path, handler, options);
  }

  public patch(path: string, handler: RouteHandler, options?: { public?: boolean }): void {
    this.route('PATCH', path, handler, options);
  }

  /**
   * Start the server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          this.logger.error(`Unhandled error: ${error}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.port, this.host, () => {
        this.logger.info(`API Server listening on ${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the server
   */
  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.logger.info('API Server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Get the underlying HTTP server (for WebSocket upgrade)
   */
  public getHttpServer(): Server | undefined {
    return this.server;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      this.handleCors(request, response);
      response.statusCode = 204;
      response.end();
      return;
    }

    // Add CORS headers
    this.handleCors(request, response);

    // Find matching route
    const match = this.findRoute(method, path);
    if (!match) {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    const { route, params } = match;
    const authRequest = request as AuthenticatedRequest;

    // Run auth middleware unless route is public
    if (!route.public) {
      const authOk = await this.authMiddleware.process(authRequest, response);
      if (!authOk) {
        return;
      }
    }

    // Execute handler
    try {
      await route.handler(authRequest, response, params);
    } catch (error) {
      this.logger.error(`Route handler error: ${error}`);
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }

  private findRoute(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }

      const match = route.pattern.exec(path);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1];
        });
        return { route, params };
      }
    }
    return undefined;
  }

  private pathToRegex(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    let regexStr = path
      // 先处理通配符 *path 或 * (匹配剩余所有路径)
      .replace(/\*([a-zA-Z0-9_]*)/g, (_, name) => {
        paramNames.push(name || 'wildcard');
        return '(.*)';
      })
      // 再处理普通参数 :param (只匹配单段)
      .replace(/:([a-zA-Z0-9_]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      })
      .replace(/\//g, '\\/');
    return {
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
    };
  }

  private handleCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;

    if (this.corsOrigins.includes('*')) {
      response.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && this.corsOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Access-Control-Max-Age', '86400');
  }
}
