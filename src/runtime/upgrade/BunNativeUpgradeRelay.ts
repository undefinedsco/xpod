import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  WS_CLOSE_PROTOCOL_ERROR,
  WS_OPCODE,
  WebSocketFrameParser,
  encodeWebSocketClosePayload,
  encodeWebSocketFrame,
} from './WebSocketFrames';
import {
  buildUpstreamUpgradeRequest,
  endUpgradeSocket,
  forwardedHeaderValues,
  isWebSocketUpgrade,
  parseRequestedProtocols,
  parseUpgradeHandshakeResponse,
  selectedProtocol,
  writeUpgradeErrorResponse,
  writeUpgradeSocketBytes,
  type UpgradeHandshakeResponse,
} from './UpgradeHandshake';

/**
 * WebSocket upgrade relay for runtimes whose HTTP server cannot hand the raw
 * upgraded socket back to JavaScript.
 *
 * Bun's `node:http` server is one of them: the socket passed to the `'upgrade'`
 * event never delivers client bytes (`'data'` does not fire) and its
 * `socket.write()` never reaches the peer, so `http-proxy`'s WebSocket pass
 * drops the `101` response and then the whole frame stream
 * (oven-sh/bun#9882, oven-sh/bun#18945, oven-sh/bun#28396). The internal
 * services keep working because they use `ws`, which Bun implements natively.
 *
 * The relay therefore terminates the client side with that same native
 * WebSocket support and speaks the upstream hop itself over a raw TCP/Unix
 * socket. The upstream side stays byte-accurate — including non-101 rejections
 * and Unix socket targets — while `WebSocketFrames` bridges messages to frames.
 */

export interface NativeUpgradeTarget {
  url?: string;
  socketPath?: string;
}

/** Logging surface of the relay (satisfied by `getLoggerFor`). */
export interface RelayLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Subset of the `ws` module surface used by the relay. */
export interface RelayWebSocket {
  send(data: Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[] | string, isBinary: boolean) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface RelayWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (client: RelayWebSocket) => void,
  ): void;
}

export interface RelayWebSocketModule {
  WebSocketServer: new (options: Record<string, unknown>) => RelayWebSocketServer;
}

/** Loads the runtime's `ws` implementation; `undefined` when it is unavailable. */
export type WebSocketModuleLoader = () => Promise<RelayWebSocketModule | undefined>;

export interface BunNativeUpgradeRelayOptions {
  logger: RelayLogger;
  /** Relays the upgrade the classic way when native WebSocket support is unavailable. */
  fallback(req: IncomingMessage, socket: Duplex, head: Buffer, target: NativeUpgradeTarget): void;
  /** Test seam: replaces the runtime `ws` import. */
  loadWebSocketModule?: WebSocketModuleLoader;
  handshakeTimeoutMs?: number;
  closeGraceMs?: number;
  maxHandshakeBytes?: number;
}

export interface RelayConnectionDependencies {
  logger: RelayLogger;
  onClosed(connection: NativeUpgradeConnection): void;
  handshakeTimeoutMs: number;
  closeGraceMs: number;
  maxHandshakeBytes: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_MAX_HANDSHAKE_BYTES = 64 * 1024;
const ERROR_SOCKET_LINGER_MS = 1_000;
const SHUTDOWN_FLUSH_MS = 50;

/**
 * Loads `ws` from the runtime. Bun resolves this to its built-in, native
 * implementation — the only one that can complete an upgrade on Bun's
 * `node:http` server.
 */
async function loadRuntimeWebSocketModule(): Promise<RelayWebSocketModule | undefined> {
  try {
    return await import('ws') as unknown as RelayWebSocketModule;
  } catch {
    return undefined;
  }
}

function describeImplementation(module: RelayWebSocketModule): string {
  const source = module.WebSocketServer?.prototype?.handleUpgrade?.toString?.() ?? '';
  return source.includes('kBunInternals') || source.includes('server.upgrade')
    ? 'runtime-native'
    : 'javascript';
}

/** Close codes that must never be sent on the wire (RFC 6455 §7.4.1). */
function wireCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000;
}

type UpstreamAddress =
  | { kind: 'socket'; path: string }
  | { kind: 'tcp'; host: string; port: number; secure: boolean };

function resolveUpstreamAddress(target: NativeUpgradeTarget): UpstreamAddress | undefined {
  if (target.socketPath) {
    return { kind: 'socket', path: target.socketPath };
  }
  if (!target.url) {
    return undefined;
  }
  try {
    const url = new URL(target.url);
    if (![ 'http:', 'https:', 'ws:', 'wss:' ].includes(url.protocol)) {
      return undefined;
    }
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    return {
      kind: 'tcp',
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      secure,
    };
  } catch {
    return undefined;
  }
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[] | string): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  return Buffer.from(data);
}

export class BunNativeUpgradeRelay {
  private readonly connections = new Set<NativeUpgradeConnection>();
  private readonly loadWebSocketModule: WebSocketModuleLoader;
  private readonly handshakeTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly maxHandshakeBytes: number;
  private modulePromise?: Promise<RelayWebSocketModule | undefined>;
  private moduleReported = false;

  public constructor(private readonly options: BunNativeUpgradeRelayOptions) {
    this.loadWebSocketModule = options.loadWebSocketModule ?? loadRuntimeWebSocketModule;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.maxHandshakeBytes = options.maxHandshakeBytes ?? DEFAULT_MAX_HANDSHAKE_BYTES;
    // Warm the module up so the first upgrade does not wait on the import.
    void this.webSocketModule();
  }

  public handle(req: IncomingMessage, socket: Duplex, head: Buffer, target: NativeUpgradeTarget): void {
    const upgradeHeader = req.headers.upgrade;
    if (req.method !== 'GET' || typeof upgradeHeader !== 'string' || upgradeHeader.toLowerCase() !== 'websocket') {
      this.options.logger.debug(`Rejecting unsupported upgrade request: ${req.method} ${req.url}`);
      socket.destroy();
      return;
    }
    void this.start(req, socket, head, target);
  }

  /** Terminates every relayed connection (gateway shutdown/restart). */
  public close(): void {
    for (const connection of [ ...this.connections ]) {
      connection.shutdown();
    }
  }

  private async start(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    target: NativeUpgradeTarget,
  ): Promise<void> {
    const module = await this.webSocketModule();
    if (!module) {
      this.options.logger.warn('Native WebSocket support is unavailable; falling back to the http-proxy upgrade relay');
      this.options.fallback(req, socket, head, target);
      return;
    }

    const connection = new NativeUpgradeConnection(module, {
      logger: this.options.logger,
      onClosed: (closed) => this.connections.delete(closed),
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      closeGraceMs: this.closeGraceMs,
      maxHandshakeBytes: this.maxHandshakeBytes,
    });
    this.connections.add(connection);
    connection.start(req, socket, head, target);
  }

  private async webSocketModule(): Promise<RelayWebSocketModule | undefined> {
    this.modulePromise ??= this.loadWebSocketModule();
    const module = await this.modulePromise;
    if (module && !this.moduleReported) {
      this.moduleReported = true;
      this.options.logger.debug(`Upgrade relay using a ${describeImplementation(module)} WebSocket implementation`);
    }
    return module;
  }
}

export class NativeUpgradeConnection {
  private upstream?: net.Socket;
  private clientSocket?: Duplex;
  private client?: RelayWebSocket;
  private parser?: WebSocketFrameParser;
  private protocol = '';
  private handshakeBuffer = Buffer.alloc(0);
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private handshakeListener?: (chunk: Buffer) => void;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private state: 'connecting' | 'handshaking' | 'rejected' | 'open' | 'closed' = 'connecting';

  public constructor(
    private readonly module: RelayWebSocketModule,
    private readonly deps: RelayConnectionDependencies,
  ) {}

  public start(req: IncomingMessage, socket: Duplex, head: Buffer, target: NativeUpgradeTarget): void {
    this.clientSocket = socket;
    socket.once('error', () => this.destroy());
    socket.once('close', () => this.destroy());
    // The client may disconnect while the module or upstream handshake is
    // pending. Its native Request is no longer valid for handleUpgrade then.
    if (socket.destroyed || req.aborted) {
      this.destroy();
      return;
    }

    const address = resolveUpstreamAddress(target);
    if (!address) {
      this.fail(503, 'Service Unavailable', 'No WebSocket upstream is configured for this path.');
      this.finish();
      return;
    }

    // Upgraded connections are long lived and may stay idle for a long time
    // (a Solid notification channel can live for days), so no idle timeout may
    // tear them down.
    (socket as Duplex & { setTimeout?: (timeout: number) => unknown }).setTimeout?.(0);

    const upstream = this.connectUpstream(address);
    this.upstream = upstream;
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 0);
    upstream.setTimeout(0);

    const onHandshakeData = (chunk: Buffer): void => this.onUpstreamHandshakeData(req, socket, head, chunk);
    this.handshakeListener = onHandshakeData;
    upstream.on(address.kind === 'tcp' && address.secure ? 'secureConnect' : 'connect', () => {
      this.state = 'handshaking';
      upstream.write(buildUpstreamUpgradeRequest({
        path: req.url ?? '/',
        headers: req.headers,
        protocols: parseRequestedProtocols(req.headers['sec-websocket-protocol']),
        ...forwardedHeaderValues(req),
      }));
      this.handshakeTimer = setTimeout(() => {
        this.deps.logger.warn(`WebSocket upstream handshake timed out for ${req.url}`);
        this.fail(504, 'Gateway Timeout', 'The internal service did not answer the WebSocket handshake.');
        upstream.destroy();
        this.finish();
      }, this.deps.handshakeTimeoutMs);
    });
    upstream.on('data', onHandshakeData);
    upstream.on('error', (error) => {
      this.deps.logger.warn(`WebSocket upstream error for ${req.url}: ${String(error)}`);
      if (this.state === 'connecting' || this.state === 'handshaking') {
        this.fail(502, 'Bad Gateway', 'The internal service is unavailable.');
      }
      this.finish();
    });
    upstream.on('close', () => {
      if (this.state === 'closed') {
        return;
      }
      if (this.state === 'rejected') {
        // The rejection response may end without a graceful `end` (reset).
        this.closeRejectedClient();
        return;
      }
      this.clientSocket?.destroy();
      this.finish();
    });
  }

  /** Closes the relayed connection as part of gateway shutdown. */
  public shutdown(): void {
    try {
      this.client?.close(1001, 'gateway shutting down');
    } catch {
      // The client WebSocket may already be closed.
    }
    // Shutdown must not wait for the peer's close handshake — a notification
    // channel can stay idle for days. The short delay lets the close frame
    // reach the client before the sockets go away.
    const timer = setTimeout(() => this.destroy(), SHUTDOWN_FLUSH_MS);
    timer.unref?.();
  }

  private connectUpstream(address: UpstreamAddress): net.Socket {
    if (address.kind === 'socket') {
      return net.connect({ path: address.path });
    }
    return address.secure
      ? tls.connect({ host: address.host, port: address.port, servername: address.host })
      : net.connect({ host: address.host, port: address.port });
  }

  private onUpstreamHandshakeData(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    chunk: Buffer,
  ): void {
    if (this.state !== 'handshaking') {
      return;
    }

    this.handshakeBuffer = Buffer.concat([ this.handshakeBuffer, chunk ]);
    if (this.handshakeBuffer.length > this.deps.maxHandshakeBytes) {
      this.deps.logger.warn(`WebSocket upstream sent an oversized handshake for ${req.url}`);
      this.fail(502, 'Bad Gateway', 'The internal service sent an invalid WebSocket handshake.');
      this.upstream?.destroy();
      this.finish();
      return;
    }

    const response = parseUpgradeHandshakeResponse(this.handshakeBuffer);
    if (!response) {
      return;
    }

    this.clearHandshakeTimer();
    const upstream = this.upstream;
    if (!upstream) {
      return;
    }
    if (this.handshakeListener) {
      upstream.removeListener('data', this.handshakeListener);
      this.handshakeListener = undefined;
    }

    if (!isWebSocketUpgrade(response)) {
      this.relayRejection(response);
      return;
    }

    this.protocol = selectedProtocol(response);
    this.parser = this.createFrameParser(req.url ?? '/');
    upstream.on('data', (frameChunk: Buffer) => this.parser?.push(frameChunk));
    this.upgradeClient(req, socket, head, response.rest);
  }

  /**
   * Relays a non-101 upstream answer verbatim so clients observe the real
   * status (401 for an expired ticket, 404 for an unknown channel, ...).
   */
  private relayRejection(response: UpgradeHandshakeResponse): void {
    const upstream = this.upstream;
    const socket = this.clientSocket;
    if (!upstream || !socket) {
      return;
    }
    this.state = 'rejected';
    writeUpgradeSocketBytes(socket, response.head);
    if (response.rest.length > 0) {
      writeUpgradeSocketBytes(socket, response.rest);
    }
    upstream.on('data', (rest: Buffer) => writeUpgradeSocketBytes(socket, rest));
    upstream.on('end', () => this.closeRejectedClient());
  }

  private closeRejectedClient(): void {
    if (this.state === 'closed') {
      return;
    }
    if (this.clientSocket) {
      endUpgradeSocket(this.clientSocket);
    }
    this.finish();
  }

  private createFrameParser(url: string): WebSocketFrameParser {
    return new WebSocketFrameParser({
      onMessage: (payload, isBinary) => this.client?.send(payload, { binary: isBinary }),
      onPing: (payload) => {
        this.upstream?.write(encodeWebSocketFrame(payload, { opcode: WS_OPCODE.pong, mask: true }));
      },
      onPong: () => undefined,
      onClose: (code, reason) => {
        try {
          this.client?.close(wireCloseCode(code), reason);
        } catch {
          // The client WebSocket may already be closed.
        }
        this.scheduleUpstreamClose();
      },
      onProtocolError: (reason) => {
        this.deps.logger.warn(`WebSocket upstream protocol error for ${url}: ${reason}`);
        try {
          this.client?.close(WS_CLOSE_PROTOCOL_ERROR, 'protocol error');
        } catch {
          // The client WebSocket may already be closed.
        }
        this.destroy();
      },
    });
  }

  private upgradeClient(req: IncomingMessage, socket: Duplex, head: Buffer, bufferedFrames: Buffer): void {
    const protocol = this.protocol;
    try {
      const server = new this.module.WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        // The upstream handshake already picked a subprotocol; echo exactly that
        // one so the client observes the same negotiation as a direct connection.
        handleProtocols: () => protocol || false,
      });
      server.handleUpgrade(req, socket, head, (client) => {
        this.client = client;
        this.state = 'open';
        client.on('message', (data, isBinary) => this.forwardClientMessage(data, isBinary));
        client.on('close', (code, reason) => this.onClientClose(code, reason));
        client.on('error', () => this.destroy());
        if (bufferedFrames.length > 0) {
          this.parser?.push(bufferedFrames);
        }
      });
    } catch (error) {
      this.deps.logger.warn(`Failed to complete the client WebSocket handshake for ${req.url}: ${String(error)}`);
      this.fail(400, 'Bad Request', 'Invalid WebSocket handshake.');
      this.destroy();
    }
  }

  private forwardClientMessage(data: Buffer | ArrayBuffer | Buffer[] | string, isBinary: boolean): void {
    if (!this.upstream || this.upstream.destroyed) {
      return;
    }
    this.upstream.write(encodeWebSocketFrame(toBuffer(data), {
      opcode: isBinary ? WS_OPCODE.binary : WS_OPCODE.text,
      mask: true,
    }));
  }

  private onClientClose(code: number, reason: Buffer): void {
    if (this.state === 'open' && this.upstream && !this.upstream.destroyed) {
      this.upstream.write(encodeWebSocketFrame(
        encodeWebSocketClosePayload(wireCloseCode(code), reason.toString('utf8')),
        { opcode: WS_OPCODE.close, mask: true },
      ));
    }
    this.scheduleUpstreamClose();
  }

  /** Waits briefly for the upstream close handshake before dropping the socket. */
  private scheduleUpstreamClose(): void {
    this.closeTimer ??= setTimeout(() => this.destroy(), this.deps.closeGraceMs);
  }

  private fail(statusCode: number, statusMessage: string, message: string): void {
    const socket = this.clientSocket;
    if (!socket || socket.destroyed) {
      return;
    }
    writeUpgradeErrorResponse(socket, statusCode, statusMessage, {
      'Content-Type': 'application/json',
    }, JSON.stringify({ error: statusMessage, message }));
    this.errorTimer ??= setTimeout(() => socket.destroy(), ERROR_SOCKET_LINGER_MS);
  }

  private destroy(): void {
    if (this.state === 'closed') {
      return;
    }
    this.upstream?.destroy();
    this.clientSocket?.destroy();
    this.finish();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private finish(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.clearHandshakeTimer();
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    if (this.errorTimer) {
      clearTimeout(this.errorTimer);
      this.errorTimer = undefined;
    }
    this.deps.onClosed(this);
  }
}
