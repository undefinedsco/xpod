import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { getLoggerFor } from 'global-logger-factory';
import type { AuthMiddleware, AuthenticatedRequest } from './middleware/AuthMiddleware';
import { nodeRuntimeHost } from '../runtime/host/node/NodeRuntimeHost';
import { sendPodAccessFailure } from './handlers/PodAccessFailureResponse';
import type { RuntimeHost, RuntimeListenEndpoint } from '../runtime/host/types';
import {
  hashTaskModelDiagnosticSession,
  selectTaskModelDiagnosticReceipt,
  type TaskGatewayHttpDiagnosticReceipt,
} from '../util/task-model-diagnostics';

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
  /** If true, authenticate when credentials are present, otherwise continue unauthenticated */
  optionalAuth?: boolean;
  /** If true, match all methods instead of one method. */
  allMethods?: boolean;
}

export interface ApiServerOptions {
  port?: number;
  host?: string;
  socketPath?: string;
  listenEndpoint?: RuntimeListenEndpoint;
  runtimeHost?: RuntimeHost;
  authMiddleware: AuthMiddleware;
  corsOrigins?: string[];
}

export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Standalone API Server
 */
export class ApiServer {
  private readonly logger = getLoggerFor(this);
  private readonly runtimeHost: RuntimeHost;
  private readonly listenEndpoint: RuntimeListenEndpoint;
  private readonly authMiddleware: AuthMiddleware;
  private readonly corsOrigins: string[];
  private readonly routes: Route[] = [];
  private readonly upgradeHandlers: UpgradeHandler[] = [];
  private readonly shutdownHandlers: Array<() => void | Promise<void>> = [];
  private responseHeaders: Record<string, string> = {};
  private readonly activeHandlers = new Map<IncomingMessage, string>();
  private readonly openResponses = new Map<ServerResponse, string>();
  private readonly upgradedSockets = new Set<Duplex>();
  private readonly drainWaiters = new Set<() => void>();
  private stopping = false;
  private stopPromise?: Promise<void>;
  private server?: Server;

  public constructor(options: ApiServerOptions) {
    this.runtimeHost = options.runtimeHost ?? nodeRuntimeHost;
    this.listenEndpoint = options.listenEndpoint ?? this.runtimeHost.createListenEndpoint({
      port: options.port,
      host: options.host,
      socketPath: options.socketPath,
    });
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
      /** If true, authenticate when credentials are present, otherwise continue unauthenticated */
      optionalAuth?: boolean;
      /** If true, match all methods instead of one method */
      allMethods?: boolean;
    },
  ): void {
    const { pattern, paramNames } = this.pathToRegex(path);
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      paramNames,
      handler,
      public: options?.public,
      optionalAuth: options?.optionalAuth,
      allMethods: options?.allMethods,
    });
    this.logger.debug(`Registered route: ${method.toUpperCase()} ${path}${options?.public ? ' (public)' : ''}${options?.optionalAuth ? ' (optional auth)' : ''}`);
  }

  /**
   * Convenience methods for common HTTP methods
   */
  public get(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('GET', path, handler, options);
  }

  public post(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('POST', path, handler, options);
  }

  public put(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('PUT', path, handler, options);
  }

  public delete(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('DELETE', path, handler, options);
  }

  public patch(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('PATCH', path, handler, options);
  }

  public all(path: string, handler: RouteHandler, options?: { public?: boolean; optionalAuth?: boolean }): void {
    this.route('ALL', path, handler, { ...options, allMethods: true });
  }

  public addUpgradeHandler(handler: UpgradeHandler): void {
    this.upgradeHandlers.push(handler);

  }

  public addShutdownHandler(handler: () => void | Promise<void>): void {
    this.shutdownHandlers.push(handler);
  }

  public addResponseHeaders(headers: Record<string, string>): void {
    this.responseHeaders = { ...this.responseHeaders, ...headers };
  }

  /**
   * Start the server
   */
  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        const requestPath = `${req.method ?? 'GET'} ${(req.url ?? '/').split('?', 1)[0]}`;
        this.openResponses.set(res, requestPath);
        const responseDone = (): void => {
          this.openResponses.delete(res);
          req.off('aborted', responseDone);
          req.socket.off('close', responseDone);
          this.notifyDrained();
        };
        res.once('finish', responseDone);
        res.once('close', responseDone);
        req.once('aborted', responseDone);
        req.socket.once('close', responseDone);
        if (this.stopping) {
          res.statusCode = 503;
          res.setHeader('Connection', 'close');
          res.end('Service is shutting down');
          return;
        }
        this.activeHandlers.set(req, requestPath);
        this.handleRequest(req, res).catch((error) => {
          this.logger.error(`Unhandled error: ${error}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        }).finally(() => {
          // Bun can omit response finish/close after the peer disconnected.
          // The transport is gone, but its logical write still had to finish.
          if (req.aborted || req.socket.destroyed || res.destroyed) { responseDone(); }
          this.activeHandlers.delete(req);
          this.notifyDrained();
        });
      });
      this.server.on('upgrade', (request, socket, head) => {
        this.upgradedSockets.add(socket);
        socket.once('close', () => { this.upgradedSockets.delete(socket); this.notifyDrained(); });
        if (this.stopping) { socket.destroy(); return; }
        for (const handler of this.upgradeHandlers) { handler(request, socket, head); }
      });

      this.runtimeHost.listen(this.server, this.listenEndpoint).then(() => {
        this.logger.info(`API Server listening on ${this.runtimeHost.formatListenEndpoint(this.listenEndpoint)}`);
        resolve();
      }, reject);
    });
  }

  /**
   * Stop the server
   */
  public async stop(): Promise<void> {
    if (this.stopPromise) { return this.stopPromise; }
    this.stopping = true;
    this.stopPromise = this.drainAndClose();
    return this.stopPromise;
  }

  private async drainAndClose(): Promise<void> {
    if (!this.server) { return; }
    const endpoint = JSON.stringify(this.listenEndpoint);
    this.logger.info(`Stopping API shutdown handlers at ${endpoint}`);
    await Promise.all(this.shutdownHandlers.map(async (handler) => handler()));
    // Upgraded channels no longer accept work. Wait for actual socket close,
    // not just destroy() returning: Bun's native WebSocket cleanup is asynchronous.
    // Shutdown handlers own the WebSocket close handshake; wait for its socket close.
    this.logger.info(`Draining API HTTP server at ${endpoint}`);
    this.logger.info(`API pending handlers at ${endpoint}: ${JSON.stringify([...this.activeHandlers.values()])}; responses: ${JSON.stringify([...this.openResponses.values()])}`);
    await new Promise<void>((resolve) => { this.drainWaiters.add(resolve); this.notifyDrained(); });
    this.server.once('close', () => this.logger.info(`API HTTP close event at ${endpoint}`));
    await this.runtimeHost.close(this.server, this.listenEndpoint, { connectionsDrained: true });
    this.logger.info(`API Server stopped at ${endpoint}`);
  }

  private notifyDrained(): void {
    if (this.activeHandlers.size || this.openResponses.size || this.upgradedSockets.size) { return; }
    for (const resolve of this.drainWaiters) { resolve(); }
    this.drainWaiters.clear();
  }

  /**
   * Get the underlying HTTP server (for WebSocket upgrade)
   */
  public getHttpServer(): Server | undefined {
    return this.server;
  }

  public address(): AddressInfo | string | null {
    return this.server?.address() ?? null;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    this.observeTaskGatewayResponse(request, response, method, path);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      this.handleCors(request, response);
      response.statusCode = 204;
      response.end();
      return;
    }

    // Add CORS headers
    this.handleCors(request, response);
    for (const [name, value] of Object.entries(this.responseHeaders)) {
      response.setHeader(name, value);
    }

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

    // Run auth middleware unless route is public. Optional-auth routes accept
    // anonymous callers but still hydrate request.auth when credentials exist.
    if (route.optionalAuth && request.headers.authorization) {
      const authOk = await this.authMiddleware.process(authRequest, response);
      if (!authOk) {
        return;
      }
    } else if (!route.public && !route.optionalAuth) {
      const authOk = await this.authMiddleware.process(authRequest, response);
      if (!authOk) {
        return;
      }
    }

    // Execute handler
    try {
      await route.handler(authRequest, response, params);
    } catch (error) {
      if (!response.headersSent && sendPodAccessFailure(response, error)) return;
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const causes: string[] = [];
      let cause: unknown = error instanceof Error ? error.cause : undefined;
      while (cause instanceof Error && causes.length < 5) {
        const code = 'code' in cause && cause.code ? `[${String(cause.code)}] ` : '';
        causes.push(`${code}${cause.message}`);
        cause = cause.cause;
      }
      this.logger.error(
        `Route handler error: ${method} ${path} - ${detail}` +
        (causes.length > 0 ? ` | causes: ${causes.join(' <- ')}` : ''),
      );
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  }

  private observeTaskGatewayResponse(
    request: IncomingMessage, response: ServerResponse, method: string, path: string,
  ): void {
    if (method !== 'POST') return;
    const route: TaskGatewayHttpDiagnosticReceipt['route'] | undefined =
      path === '/v1/chat/completions' ? 'chat_completions' :
      path === '/v1/responses' ? 'responses' :
      path === '/v1/messages' ? 'anthropic_messages' : undefined;
    if (!route) return;
    const correlationHash = hashTaskModelDiagnosticSession(request.headers['x-opencode-session']);
    if (!correlationHash) return;
    const startedAt = Date.now();
    const observe = (statusSource: TaskGatewayHttpDiagnosticReceipt['statusSource']): void => {
      response.off('finish', onFinish);
      response.off('close', onClose);
      // An unsent close has no actual caller HTTP status, regardless of statusCode.
      if (statusSource === 'response_closed' && !response.headersSent) return;
      try {
        const receipt = selectTaskModelDiagnosticReceipt({
          event: 'xpod.task-gateway-http-diagnostic', schemaVersion: 1, scope: 'session',
          correlationHash, route, callerHTTPstatus: response.statusCode, statusSource,
          durationMs: Math.max(0, Math.min(2147483647, Date.now() - startedAt)),
        } satisfies TaskGatewayHttpDiagnosticReceipt);
        if (receipt) this.logger.error(JSON.stringify(receipt));
      } catch {
        // Diagnostics are observational; a failing sink must not affect HTTP or cleanup.
      }
    };
    const onFinish = (): void => observe('response_finished');
    const onClose = (): void => observe('response_closed');
    response.once('finish', onFinish);
    response.once('close', onClose);
  }

  private findRoute(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (!route.allMethods && route.method !== method) {
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
      response.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      if (origin) {
        response.setHeader('Vary', 'Origin');
      }
    } else if (origin && this.corsOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }

    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    response.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Authorization',
        'Content-Type',
        'Accept',
        'DPoP',
        'X-Xpod-Pod-Url',
        'Origin',
        'X-Requested-With',
        'If-Match',
        'If-None-Match',
        'Slug',
        'Link',
      ].join(', '),
    );
    response.setHeader('Access-Control-Max-Age', '86400');
  }
}
