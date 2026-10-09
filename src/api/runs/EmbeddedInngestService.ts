import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { getLoggerFor } from 'global-logger-factory';
import { getFreePort, PACKAGE_ROOT } from '../../runtime';
import { getEphemeralLoopbackPort } from '../../runtime/port-finder';
import { requestViaSocket } from '../../runtime/socket-transport';
import {
  createGatewayAdminProxyHeaders,
  GATEWAY_ADMIN_PROXY_HEADERS,
} from '../../runtime/GatewayAdminProxyAuth';
import { nodeRuntimeHost } from '../../runtime/host/node/NodeRuntimeHost';
import type { RuntimeHost, RuntimeListenEndpoint } from '../../runtime/host/types';
import { readBoundedRequestBody } from '../handlers/readBoundedRequestBody';
import { MatrixError } from '../matrix/MatrixError';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);
const CALLBACK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const CALLBACK_BODY_LIMIT_MESSAGE = 'Inngest callback body exceeded the bridge limit';

export interface EmbeddedInngestServiceOptions {
  edition: 'cloud' | 'local';
  apiBaseUrl: string;
  apiPath?: string;
  databaseUrl: string;
  redisUrl?: string;
  enabled?: boolean;
  mode?: 'managed' | 'spawn';
  host?: string;
  port?: number;
  baseUrl?: string;
  eventKey?: string;
  signingKey?: string;
  binaryPath?: string;
  sqliteDir?: string;
  /**
   * Unix socket the API is bound to. When set, the spawned executor's callback
   * cannot be addressed by the public base URL, so a private loopback bridge is
   * derived instead of pointing the executor at an unreachable `http://localhost`.
   */
  socketPath?: string;
  /**
   * Gateway's internal marker secret. The bridge signs each forwarded callback
   * with this secret and `originalClientLoopback: true`, which is the canonical
   * evidence the dev callback authorizer trusts for an unsigned local executor.
   */
  gatewayAdminProxyAuthSecret?: string;
  /** Runtime host used to bind/close the derived loopback listener. */
  runtimeHost?: RuntimeHost;
}

export interface EmbeddedInngestRuntimeConfig {
  enabled: boolean;
  durableDelivery: boolean;
  /**
   * The executor protocol Xpod actually resolved and started. This is the
   * authoritative answer to "is the callback signed?" and is independent of
   * whether delivery is durable. Consumers (serve handler / SDK client) must
   * read this instead of re-deriving `edition + configured mode`, so the
   * spawned dev executor and a managed executor can never drift apart.
   */
  mode?: 'managed' | 'spawn';
  baseUrl?: string;
  eventKey?: string;
  signingKey?: string;
  functionEndpoint?: string;
}

/**
 * Xpod-owned Inngest runtime process.
 *
 * The JS SDK is only the client/function adapter; the durable executor is the
 * Inngest CLI/server. In local mode Xpod may spawn that server as a managed
 * child process. In cloud/cluster mode the deployment supplies a stable
 * cluster-scoped Inngest URL, still owned by the Xpod deployment rather than
 * user-provided SaaS. Xpod Run/RunStep remain the business source of truth.
 */
export class EmbeddedInngestService {
  private readonly logger = getLoggerFor(this);
  private readonly options: EmbeddedInngestServiceOptions;
  private readonly runtimeHost: RuntimeHost;
  private child?: ChildProcess;
  private config?: EmbeddedInngestRuntimeConfig;
  private callbackServer?: http.Server;
  private callbackEndpoint?: RuntimeListenEndpoint;
  private callbackBaseUrl?: string;
  /**
   * Increases every time the bridge is (re)started or closed. Async child
   * events capture the value they were created under so a callback bridge that
   * belongs to a later `start()` is never torn down by an earlier child's exit.
   */
  private callbackGeneration = 0;

  public constructor(options: EmbeddedInngestServiceOptions) {
    this.options = options;
    this.runtimeHost = options.runtimeHost ?? nodeRuntimeHost;
  }

  public async start(): Promise<EmbeddedInngestRuntimeConfig> {
    if (this.config) {
      return this.config;
    }

    if (this.options.enabled === false || !this.isConfigured()) {
      this.config = {
        enabled: false,
        durableDelivery: false,
      };
      this.logger.info('Embedded Inngest disabled by config');
      return this.config;
    }

    const mode = this.options.mode ?? (this.options.edition === 'cloud' ? 'managed' : 'spawn');
    if ((this.options.edition === 'cloud' || mode === 'managed') && (!this.options.eventKey || !this.options.signingKey)) {
      throw new Error('Managed/cloud Inngest requires explicit eventKey and signingKey');
    }

    const eventKey = this.options.eventKey || 'xpod-local-event-key';
    const signingKey = this.options.signingKey || '78706f642d6c6f63616c2d7369676e696e672d6b6579';
    const host = this.options.host || '127.0.0.1';
    const port = this.options.port ?? (mode === 'spawn' ? await getFreePort(8288, host) : 8288);
    const baseUrl = this.options.baseUrl || (mode === 'spawn' ? `http://${host}:${port}` : 'http://xpod-inngest:8288');
    const apiPath = this.options.apiPath ?? '/api/inngest';

    const config: EmbeddedInngestRuntimeConfig = {
      enabled: true,
      durableDelivery: false,
      mode,
      baseUrl,
      eventKey,
      signingKey,
    };

    if (mode === 'managed') {
      config.functionEndpoint = new URL(apiPath, this.options.apiBaseUrl).toString();
      config.durableDelivery = config.enabled;
      this.config = config;
      this.logger.info(`Using managed embedded Inngest at ${baseUrl}, function endpoint ${config.functionEndpoint}`);
      return config;
    }

    const binary = this.resolveUsableBinaryPath();
    if (!binary) {
      config.functionEndpoint = new URL(apiPath, this.options.apiBaseUrl).toString();
      this.config = config;
      this.logger.warn('Embedded Inngest binary not found; Xpod will still expose the function endpoint, but durable delivery is unavailable.');
      return config;
    }

    // Resolve the callback endpoint before publishing `config`: a missing marker
    // secret or a rejected bridge listen throws here, and this start must leave
    // no cached enabled config behind (so the same instance can retry).
    let functionEndpoint: string;
    try {
      functionEndpoint = await this.resolveFunctionEndpoint(apiPath);
    } catch (error) {
      await this.stopCallbackBridge().catch(() => undefined);
      throw error;
    }
    config.functionEndpoint = functionEndpoint;

    const env = this.buildEnvironment({
      baseUrl,
      eventKey,
      signingKey,
      functionEndpoint,
    });
    const args = this.buildArguments(host, port, functionEndpoint);

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd: PACKAGE_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      await this.stopCallbackBridge().catch(() => undefined);
      throw error;
    }

    this.config = config;
    this.child = child;
    const childGeneration = this.callbackGeneration;

    child.stdout?.on('data', (chunk) => {
      this.logger.info(`[Inngest] ${String(chunk).trim()}`);
    });
    child.stderr?.on('data', (chunk) => {
      this.logger.warn(`[Inngest] ${String(chunk).trim()}`);
    });
    child.once('exit', (code, signal) => {
      const message = `Embedded Inngest exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      // Any exit of the current child means no executor remains: an executor
      // that terminates cleanly still must not keep advertising durable
      // delivery or an open callback bridge. Explicit stop() clears ownership
      // first, so this path only fires for a live child.
      if (code === 0 && signal === null) {
        this.logger.info(message);
      } else {
        this.logger.error(message);
      }
      this.invalidateDelivery('exited', child, childGeneration, message);
    });
    child.once('error', (error) => {
      const message = `Failed to start embedded Inngest: ${error}`;
      this.logger.error(message);
      this.invalidateDelivery('failed to start', child, childGeneration, message);
    });

    this.logger.info(`Embedded Inngest starting at ${baseUrl}, function endpoint ${functionEndpoint}`);
    config.durableDelivery = true;
    return config;
  }

  /**
   * A spawned executor that dies or fails to start leaves no durable delivery.
   *
   * The failure is reported by invalidating the resolved config (so the next
   * `start()` can retry rather than hand back the stale result) and closing the
   * callback bridge this child owned. Only the current child invalidates:
   * `stop()` clears `this.child` first, and `callbackGeneration` moves on every
   * bridge start/close, so a replaced child's late event cannot race a newer
   * one.
   */
  private invalidateDelivery(
    reason: string,
    child: ChildProcess,
    childGeneration: number,
    message: string,
  ): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.invalidateResolvedConfig();
    void this.stopCallbackBridge(childGeneration).catch((error: unknown) => {
      this.logger.warn(`Failed to close Inngest callback bridge after executor ${reason}: ${error}`);
    });
    this.logger.warn(`Embedded Inngest durable delivery disabled: executor ${reason} (${message})`);
  }

  /**
   * Marks the resolved config as no longer delivering and drops the cache.
   *
   * `this.config` is the same object handed to callers and registered by the
   * API container, so clearing the private reference alone would leave
   * consumers reading `durableDelivery: true`. Mutate the object first, then
   * drop the cache so the next `start()` re-resolves.
   */
  private invalidateResolvedConfig(): void {
    if (this.config) {
      this.config.durableDelivery = false;
      this.config = undefined;
    }
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (child) {
      this.child = undefined;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);
        timer.unref?.();

        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }

    // Stopping the service ends durable delivery for any consumer holding the
    // previously returned config, even though the explicit stop already
    // disowned the child so its exit event is ignored.
    this.invalidateResolvedConfig();
    await this.stopCallbackBridge();
  }

  /**
   * Address the spawned executor must POST its callbacks to.
   *
   * With a Unix-socket API there is no TCP listener to name, so a private
   * loopback bridge is derived. Managed and port transports keep the public
   * base URL untouched.
   */
  private async resolveFunctionEndpoint(apiPath: string): Promise<string> {
    // `resolveApiBaseUrl` collapses to `http://localhost/` under socket
    // transport, which names no listener. A spawned executor cannot reach it,
    // so a socket+spawn runtime without a derived bridge fails here instead of
    // advertising an unreachable callback as durable.
    if (!this.options.socketPath) {
      return new URL(apiPath, this.options.apiBaseUrl).toString();
    }

    if (!this.options.gatewayAdminProxyAuthSecret) {
      throw new Error(
        'Socket Inngest callback bridge requires the Gateway marker secret (XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET); '
        + 'a spawned executor cannot reach the socket-only API without it',
      );
    }

    await this.startCallbackBridge(this.options.socketPath);
    return new URL(apiPath, `${this.callbackBaseUrl}/`).toString();
  }

  private async startCallbackBridge(socketPath: string): Promise<void> {
    const port = await getEphemeralLoopbackPort();
    const endpoint = this.runtimeHost.createListenEndpoint({ port, host: '127.0.0.1' });
    const server = http.createServer((req, res) => {
      void this.forwardCallback(socketPath, req, res);
    });

    // Move to a new bridge generation before listening. A failed start must be
    // cleaned by reference (listen never completed, so ownership was never
    // recorded); a successful start records ownership below.
    this.callbackGeneration += 1;
    this.callbackServer = undefined;
    this.callbackEndpoint = undefined;
    this.callbackBaseUrl = undefined;

    try {
      await this.runtimeHost.listen(server, endpoint);
    } catch (error) {
      // The listener may have bound before failing; close it by reference so no
      // partial listener is ever left unowned.
      server.closeAllConnections?.();
      await this.runtimeHost.close(server, endpoint).catch(() => undefined);
      throw error;
    }

    this.callbackServer = server;
    this.callbackEndpoint = endpoint;
    this.callbackBaseUrl = `http://127.0.0.1:${port}`;
    this.logger.info(`Inngest callback bridge on ${this.callbackBaseUrl} -> unix://${socketPath}`);
  }

  /**
   * Closes the owned bridge unless a newer child has already replaced it.
   *
   * `expectedGeneration` is the value captured when a child was spawned. A
   * mismatch means a later `start()` owns the current bridge, so this close must
   * not touch it.
   */
  private async stopCallbackBridge(expectedGeneration?: number): Promise<void> {
    if (expectedGeneration !== undefined && expectedGeneration !== this.callbackGeneration) {
      return;
    }
    const server = this.callbackServer;
    const endpoint = this.callbackEndpoint;
    this.callbackServer = undefined;
    this.callbackEndpoint = undefined;
    this.callbackBaseUrl = undefined;
    this.callbackGeneration += 1;
    if (!server) {
      return;
    }

    try {
      // HTTP clients keep the bridge connection alive; drop them so the close
      // callback (which waits for idle connections) does not stall shutdown.
      server.closeAllConnections?.();
      await this.runtimeHost.close(server, endpoint);
    } catch (error) {
      this.logger.warn(`Failed to stop Inngest callback bridge: ${error}`);
    }
  }

  /**
   * Forward an executor callback to the API over its Unix socket.
   *
   * Only the Inngest callback path is proxied: this listener is a transport for
   * one executor, not a second API surface. The Gateway marker is re-created
   * (after stripping any inbound marker) so the API sees the canonical signed
   * local-client evidence even though a Unix socket carries no peer address.
   */
  private async forwardCallback(
    socketPath: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawUrl = req.url ?? '/';
    if (!isInngestCallbackPath(rawUrl)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    let chunks: Buffer[];
    try {
      chunks = await readBoundedRequestBody(req, CALLBACK_BODY_LIMIT_BYTES, CALLBACK_BODY_LIMIT_MESSAGE);
    } catch (error) {
      const status = error instanceof MatrixError ? error.status : 400;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Bad Request' }));
      return;
    }

    try {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const headers = this.forwardCallbackHeaders(req, body);
      const response = await requestViaSocket({
        protocol: 'http:',
        socketPath,
        path: rawUrl,
        method: req.method ?? 'GET',
        headers,
        body,
      });

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      res.end(response.body);
    } catch (error) {
      this.logger.warn(`Inngest callback bridge failed to reach the API socket: ${error}`);
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Inngest callback bridge unavailable' }));
      } else {
        res.end();
      }
    }
  }

  private forwardCallbackHeaders(req: http.IncomingMessage, body: Buffer | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || isGatewayMarkerHeader(lower)) {
        continue;
      }
      headers[lower] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    Object.assign(headers, createGatewayAdminProxyHeaders({
      secret: this.options.gatewayAdminProxyAuthSecret!,
      method: req.method,
      url: req.url,
      originalClientLoopback: true,
    }));

    if (body && body.byteLength > 0) {
      headers['content-length'] = String(body.byteLength);
    } else {
      delete headers['content-length'];
    }
    return headers;
  }

  private resolveUsableBinaryPath(): string | undefined {
    const configured = this.options.binaryPath;
    if (configured) {
      return this.isUsableBinary(configured) ? configured : undefined;
    }

    const candidates = [
      path.join(PACKAGE_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'inngest.cmd' : 'inngest'),
      path.join(PACKAGE_ROOT, 'node_modules', 'inngest-cli', 'bin', process.platform === 'win32' ? 'inngest.exe' : 'inngest'),
      'inngest',
    ];

    return candidates.find((candidate) => this.isUsableBinary(candidate));
  }

  private isUsableBinary(candidate: string): boolean {
    const isPathLike = candidate.includes('/') || candidate.includes('\\');
    if (isPathLike && !fs.existsSync(candidate)) {
      return false;
    }

    const result = spawnSync(candidate, ['--help'], {
      cwd: PACKAGE_ROOT,
      env: process.env,
      stdio: 'ignore',
      timeout: 5_000,
    });
    return !result.error && result.status === 0;
  }

  private buildArguments(host: string, port: number, functionEndpoint: string): string[] {
    return [
      'dev',
      '--no-discovery',
      '--host',
      host,
      '--port',
      String(port),
      '-u',
      functionEndpoint,
    ];
  }

  private buildEnvironment(config: {
    baseUrl: string;
    eventKey: string;
    signingKey: string;
    functionEndpoint: string;
  }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      INNGEST_DEV: config.baseUrl,
      INNGEST_BASE_URL: config.baseUrl,
      INNGEST_EVENT_API_BASE_URL: config.baseUrl,
      INNGEST_API_BASE_URL: config.baseUrl,
      INNGEST_EVENT_KEY: config.eventKey,
      INNGEST_SIGNING_KEY: config.signingKey,
    };

    if (this.options.edition === 'cloud') {
      if (this.isPostgresUrl(this.options.databaseUrl)) {
        env.INNGEST_POSTGRES_URI = this.options.databaseUrl;
      }
      if (this.options.redisUrl) {
        env.INNGEST_REDIS_URI = this.options.redisUrl;
      }
      return env;
    }

    const sqliteDir = this.options.sqliteDir ?? path.join(process.env.CSS_ROOT_FILE_PATH || './data', '.inngest');
    fs.mkdirSync(sqliteDir, { recursive: true });
    env.INNGEST_SQLITE_DIR = sqliteDir;
    return env;
  }

  private isConfigured(): boolean {
    return Boolean(
      this.options.mode
      || this.options.baseUrl
      || this.options.eventKey
      || this.options.signingKey
      || this.options.binaryPath
      || this.options.sqliteDir
    );
  }

  private isPostgresUrl(value: string): boolean {
    return value.startsWith('postgres://') || value.startsWith('postgresql://');
  }
}

function isInngestCallbackPath(rawUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    pathname = rawUrl.split('?', 1)[0] ?? '/';
  }
  return pathname === '/api/inngest' || pathname.startsWith('/api/inngest/');
}

function isGatewayMarkerHeader(lowercaseHeader: string): boolean {
  return (GATEWAY_ADMIN_PROXY_HEADERS as readonly string[]).includes(lowercaseHeader);
}
