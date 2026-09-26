import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import {
  createDataPlaneNonce,
  decodeDataPlaneSecret,
  deriveDataPlaneKeys,
  keyForDirection,
  openDataPlaneFrame,
  P2PDataPlaneSecurityError,
  sealDataPlaneFrame,
  type P2PDataPlaneDirection,
  type P2PDataPlaneKeys,
  type SealedDataPlaneFrame,
} from './P2PDataPlaneCrypto';
import {
  P2P_DATA_PLANE_LIMITS,
  base64ByteLength,
  P2PDataPlaneAbortError,
  P2PDataPlaneLimitError,
  type P2PDataPlaneHandler,
  type P2PDataPlaneLimitsOptions,
  type P2PDataPlaneRequestOptions,
  type P2PDataPlaneTransport,
  type P2PHttpRequestFrame,
  type P2PHttpResponseFrame,
} from './P2PDataPlane';

const REQUEST_ENVELOPE = 'xpod-p2p-http-request' as const;
const RESPONSE_ENVELOPE = 'xpod-p2p-http-response' as const;
const ERROR_ENVELOPE = 'xpod-p2p-http-error' as const;
const CHUNK_ENVELOPE = 'xpod-p2p-http-response-chunk' as const;
const END_ENVELOPE = 'xpod-p2p-http-response-end' as const;
const CANCEL_ENVELOPE = 'xpod-p2p-http-cancel' as const;
const SEALED_ENVELOPE = 'xpod-p2p-sealed' as const;
const HELLO_ENVELOPE = 'xpod-p2p-secure-hello' as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOW_SECONDS = 42;
const DEFAULT_MAX_CLOCK_ERROR_SECONDS = 20;
const DEFAULT_MIN_RUN_WINDOW_SECONDS = 10;
const DEFAULT_NUM_PORTS = 16;
const DEFAULT_BASE_PORT = 30_000;
const DEFAULT_PORT_RANGE = 20_000;
const LARGE_PRIME = 2_654_435_761n;
const UINT32_MODULUS = 0xffff_ffffn;

type TcpP2PEnvelope =
  | { type: typeof REQUEST_ENVELOPE; requestId: string; frame: P2PHttpRequestFrame }
  | { type: typeof RESPONSE_ENVELOPE; requestId: string; frame: P2PHttpResponseFrame }
  | { type: typeof ERROR_ENVELOPE; requestId: string; error: string }
  | { type: typeof CHUNK_ENVELOPE; requestId: string; chunkBase64: string }
  | { type: typeof END_ENVELOPE; requestId: string }
  | { type: typeof CANCEL_ENVELOPE; requestId: string; reason?: string }
  /** Everything after the handshake travels as one sealed envelope wrapping the real one. */
  | { type: typeof SEALED_ENVELOPE; sealed: SealedDataPlaneFrame }
  | { type: typeof HELLO_ENVELOPE; sessionId: string; nonce: string; role: 'client' | 'server' };

/**
 * Data plane authentication (audit N03).
 *
 * Both endpoints must configure the same per-session secret; it is only ever transported over
 * the authenticated signaling API. Each side announces itself with a nonce, derives
 * direction-separated keys, and then seals every frame. A peer without the secret cannot make
 * the other side accept a frame, and a frame cannot be replayed into another session or
 * direction.
 */
export interface P2PDataPlaneSecurityOptions {
  role: 'client' | 'server';
  /** Known session id. Required with `secret`; discovered from the hello otherwise. */
  sessionId?: string;
  /** Base64 per-session secret. */
  secret?: string;
  /** Server side that serves many sessions on one socket: look the secret up on hello. */
  resolveSessionSecret?: (sessionId: string) => Uint8Array | string | undefined | Promise<Uint8Array | string | undefined>;
  /** How long to wait for the peer's hello before failing closed. */
  handshakeTimeoutMs?: number;
}

interface SecureState {
  role: 'client' | 'server';
  sessionId: string;
  keys: P2PDataPlaneKeys;
  outboundSequence: number;
  inboundSequence: number;
  /** Resolves once the peer's hello arrived and the keys are derived. */
  ready: Promise<void>;
  markReady: () => void;
  failHandshake: (error: Error) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_REMEMBERED_CLIENT_NONCES = 1_024;

/**
 * Client nonces already consumed, keyed by session.
 *
 * A replayed handshake re-derives exactly the same keys, so frame sequence numbers alone would
 * happily accept a replayed connection. Remembering the nonce per process closes that hole; it
 * is process-local by design (a peer would have to replay into the same process that saw the
 * original connection).
 */
const consumedClientNonces = new Map<string, true>();

function rememberClientNonce(sessionId: string, nonce: Buffer): void {
  const key = `${sessionId}|${nonce.toString('base64')}`;
  if (consumedClientNonces.has(key)) {
    throw new P2PDataPlaneSecurityError('Data plane handshake replayed with a consumed nonce');
  }
  consumedClientNonces.set(key, true);
  if (consumedClientNonces.size > MAX_REMEMBERED_CLIENT_NONCES) {
    const oldest = consumedClientNonces.keys().next();
    if (!oldest.done) {
      consumedClientNonces.delete(oldest.value);
    }
  }
}

/** Decodes either form of secret a caller may hand over. */
function normalizeSecret(secret: Uint8Array | string): Buffer {
  return typeof secret === 'string' ? decodeDataPlaneSecret(secret) : Buffer.from(secret);
}

function resolveDirection(role: 'client' | 'server'): P2PDataPlaneDirection {
  return role === 'client' ? 'client-to-server' : 'server-to-client';
}

function peerDirection(role: 'client' | 'server'): P2PDataPlaneDirection {
  return role === 'client' ? 'server-to-client' : 'client-to-server';
}

export interface TcpP2PDataPlaneTransportOptions extends P2PDataPlaneLimitsOptions {
  remoteHost: string;
  remotePort: number;
  socket?: Socket;
  timeoutMs?: number;
  randomId?: () => string;
  /** Configure to seal the data plane; omitted means plaintext (only for tests/legacy). */
  secure?: P2PDataPlaneSecurityOptions;
}

export interface TcpP2PDataPlaneTransport extends P2PDataPlaneTransport {
  close(): void;
}

export interface TcpP2PDataPlaneServerOptions extends P2PDataPlaneLimitsOptions {
  handler: P2PDataPlaneHandler;
  host?: string;
  secure?: P2PDataPlaneSecurityOptions;
}

export interface TcpP2PDataPlaneServer {
  listen(port?: number): Promise<void>;
  address(): AddressInfo;
  close(): Promise<void>;
}

export interface TcpP2PDataPlaneSocketOptions extends P2PDataPlaneLimitsOptions {
  socket: Socket;
  handler: P2PDataPlaneHandler;
  secure?: P2PDataPlaneSecurityOptions;
}

export interface TcpP2PDataPlaneSocketHandle {
  close(): void;
}

export interface TcpHolePunchPlanOptions {
  nowSeconds?: number;
  windowSeconds?: number;
  maxClockErrorSeconds?: number;
  minRunWindowSeconds?: number;
  numPorts?: number;
  basePort?: number;
  portRange?: number;
}

export interface TcpHolePunchPlan {
  bucket: number;
  boundary: number;
  rendezvousTimeSeconds: number;
  ports: number[];
}

export function createTcpP2PDataPlaneTransport(options: TcpP2PDataPlaneTransportOptions): TcpP2PDataPlaneTransport {
  return new TcpP2PTransport(options);
}

export function createTcpP2PDataPlaneServer(options: TcpP2PDataPlaneServerOptions): TcpP2PDataPlaneServer {
  return new TcpP2PServer(options);
}

export function attachTcpP2PDataPlaneSocket(options: TcpP2PDataPlaneSocketOptions): TcpP2PDataPlaneSocketHandle {
  return attachTcpP2PDataPlaneSocketInternal(options.socket, options.handler, undefined, options, options.secure);
}

export function computeTcpHolePunchPlan(options: TcpHolePunchPlanOptions = {}): TcpHolePunchPlan {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const windowSeconds = positiveInteger(options.windowSeconds, DEFAULT_WINDOW_SECONDS, 'windowSeconds');
  const maxClockErrorSeconds = positiveInteger(options.maxClockErrorSeconds, DEFAULT_MAX_CLOCK_ERROR_SECONDS, 'maxClockErrorSeconds');
  const minRunWindowSeconds = positiveInteger(options.minRunWindowSeconds, DEFAULT_MIN_RUN_WINDOW_SECONDS, 'minRunWindowSeconds');
  const numPorts = positiveInteger(options.numPorts, DEFAULT_NUM_PORTS, 'numPorts');
  const basePort = positiveInteger(options.basePort, DEFAULT_BASE_PORT, 'basePort');
  const portRange = positiveInteger(options.portRange, DEFAULT_PORT_RANGE, 'portRange');

  let bucket = Math.floor((nowSeconds - maxClockErrorSeconds) / windowSeconds);
  let rendezvousTimeSeconds = (bucket + 1) * windowSeconds + maxClockErrorSeconds;
  if (rendezvousTimeSeconds - nowSeconds < minRunWindowSeconds) {
    bucket += 1;
    rendezvousTimeSeconds = (bucket + 1) * windowSeconds + maxClockErrorSeconds;
  }
  const boundary = stableBoundary(bucket);
  return {
    bucket,
    boundary,
    rendezvousTimeSeconds,
    ports: stablePorts(boundary, numPorts, basePort, portRange),
  };
}

interface SecureSessionHooks {
  /** Writes one envelope to the socket, bypassing sealing (used for the hello). */
  sendPlaintext: (envelope: TcpP2PEnvelope) => void;
  /** Fails the connection: the data plane must not continue in the clear. */
  fail: (error: Error) => void;
}

/**
 * The handshake and per-frame sealing for one data-plane connection.
 *
 * Each side announces a nonce; keys are derived from the session secret plus both nonces, so
 * they are unique per connection and separated by direction. Everything after the handshake is
 * sealed and strictly ordered: a frame that arrives out of order, cannot be authenticated, or
 * is not sealed at all tears the connection down instead of being processed.
 */
class SecureSession {
  private readonly localNonce = createDataPlaneNonce();
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  private failHandshake!: (error: Error) => void;
  private keys?: P2PDataPlaneKeys;
  private sessionId: string;
  private outboundSequence = 0;
  private inboundSequence = 0;
  private timer?: NodeJS.Timeout;

  public constructor(
    private readonly options: P2PDataPlaneSecurityOptions,
    private readonly hooks: SecureSessionHooks,
  ) {
    this.sessionId = options.sessionId ?? '';
    this.ready = new Promise<void>((resolve, reject) => {
      this.markReady = resolve;
      this.failHandshake = reject;
    });
    // Nobody may await `ready` (for example when the socket dies first): keep the rejection
    // from surfacing as an unhandled rejection.
    this.ready.catch(() => undefined);
    const timeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.timer = setTimeout(() => {
      if (!this.keys) {
        const error = new P2PDataPlaneSecurityError(
          `Data plane secure handshake did not complete within ${timeoutMs}ms`,
        );
        // Settle the waiters as well as the connection: otherwise a request that is waiting for
        // the handshake hangs forever instead of failing closed.
        this.failHandshake(error);
        this.hooks.fail(error);
      }
    }, timeoutMs);
  }

  public hello(): TcpP2PEnvelope {
    return {
      type: HELLO_ENVELOPE,
      sessionId: this.options.sessionId ?? '',
      nonce: this.localNonce.toString('base64'),
      role: this.options.role,
    };
  }

  public waitReady(): Promise<void> {
    return this.ready;
  }

  public isEstablished(): boolean {
    return this.keys !== undefined;
  }

  /** Settles waiters when the connection dies before the handshake completed. */
  public abort(error: Error): void {
    if (this.keys) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.failHandshake(error);
  }

  /** Wraps an envelope for the wire: sealed once the handshake completed. */
  public seal(envelope: TcpP2PEnvelope): TcpP2PEnvelope {
    if (!this.keys) {
      throw new P2PDataPlaneSecurityError('Data plane secure handshake has not completed');
    }
    const direction = resolveDirection(this.options.role);
    const sealed = sealDataPlaneFrame(
      keyForDirection(this.keys, direction),
      this.sessionId,
      direction,
      this.outboundSequence,
      Buffer.from(JSON.stringify(envelope), 'utf8'),
    );
    this.outboundSequence += 1;
    return { type: SEALED_ENVELOPE, sealed };
  }

  /** Unwraps an inbound envelope, advancing the replay window. Returns undefined for handshakes. */
  public async open(envelope: TcpP2PEnvelope): Promise<TcpP2PEnvelope | undefined> {
    if (envelope.type === HELLO_ENVELOPE) {
      await this.acceptHello(envelope);
      return undefined;
    }
    if (!this.keys) {
      throw new P2PDataPlaneSecurityError('Data plane frame arrived before the secure handshake completed');
    }
    if (envelope.type !== SEALED_ENVELOPE) {
      throw new P2PDataPlaneSecurityError('Data plane frame is not sealed');
    }
    const direction = peerDirection(this.options.role);
    const plaintext = openDataPlaneFrame(
      keyForDirection(this.keys, direction),
      this.sessionId,
      direction,
      envelope.sealed,
      this.inboundSequence,
    );
    this.inboundSequence += 1;
    return JSON.parse(plaintext.toString('utf8')) as TcpP2PEnvelope;
  }

  private async acceptHello(envelope: Extract<TcpP2PEnvelope, { type: typeof HELLO_ENVELOPE }>): Promise<void> {
    if (this.keys) {
      // A second hello would restart the key schedule mid-connection; refuse it.
      throw new P2PDataPlaneSecurityError('Data plane secure handshake was repeated');
    }
    if (this.options.sessionId && envelope.sessionId && envelope.sessionId !== this.options.sessionId) {
      throw new P2PDataPlaneSecurityError(
        `Data plane peer announced session ${envelope.sessionId}, expected ${this.options.sessionId}`,
      );
    }
    const secret = await this.resolveSecret(envelope.sessionId);
    if (!secret) {
      throw new P2PDataPlaneSecurityError(
        `No data plane secret is available for session ${envelope.sessionId || '(none)'}`,
      );
    }
    const peerNonce = Buffer.from(envelope.nonce, 'base64');
    if (peerNonce.byteLength === 0) {
      throw new P2PDataPlaneSecurityError('Data plane hello carried no nonce');
    }
    this.sessionId = this.options.sessionId ?? envelope.sessionId;
    if (this.options.role === 'server') {
      rememberClientNonce(this.sessionId, peerNonce);
    }
    const clientNonce = this.options.role === 'client' ? this.localNonce : peerNonce;
    const serverNonce = this.options.role === 'server' ? this.localNonce : peerNonce;
    this.keys = deriveDataPlaneKeys(secret, this.sessionId, clientNonce, serverNonce);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.markReady();
  }

  private async resolveSecret(sessionId: string): Promise<Buffer | undefined> {
    if (this.options.secret !== undefined) {
      return normalizeSecret(this.options.secret);
    }
    if (!this.options.resolveSessionSecret) {
      return undefined;
    }
    const resolved = await this.options.resolveSessionSecret(sessionId);
    return resolved === undefined ? undefined : normalizeSecret(resolved);
  }
}

interface PendingRequest {
  resolve: (frame: P2PHttpResponseFrame) => void;
  reject: (error: Error) => void;
  /** Overall timeout, then idle timeout once the response head has arrived. */
  timeout?: NodeJS.Timeout;
  options: P2PDataPlaneRequestOptions;
  /** True once the head was delivered and chunks are still arriving. */
  streaming: boolean;
  detachAbort?: () => void;
}

class TcpP2PTransport implements TcpP2PDataPlaneTransport {
  /** This transport carries chunk/end envelopes, so it may ask for streamed bodies. */
  public readonly supportsStreaming = true;
  private readonly timeoutMs: number;
  private readonly randomId: () => string;
  private readonly maxFrameBytes: number;
  private readonly maxBodyBytes: number;
  private readonly maxConcurrentRequests: number;
  private socket?: Socket;
  private connectPromise?: Promise<Socket>;
  private readBuffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly secureSession?: SecureSession;
  /** Serialises inbound processing so sealed sequence numbers stay in order. */
  private readChain: Promise<void> = Promise.resolve();

  public constructor(private readonly options: TcpP2PDataPlaneTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.maxFrameBytes = options.maxFrameBytes ?? P2P_DATA_PLANE_LIMITS.maxFrameBytes;
    this.maxBodyBytes = options.maxBodyBytes ?? P2P_DATA_PLANE_LIMITS.maxBodyBytes;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? P2P_DATA_PLANE_LIMITS.maxConcurrentRequests;
    if (options.secure) {
      this.secureSession = new SecureSession(options.secure, {
        sendPlaintext: (envelope) => {
          if (this.socket) {
            writeEnvelope(this.socket, envelope);
          }
        },
        fail: (error) => {
          this.socket?.destroy();
          this.rejectPending(error);
        },
      });
    }
    if (options.socket) {
      this.attachSocket(options.socket);
    }
  }

  public async request(
    frame: P2PHttpRequestFrame,
    options: P2PDataPlaneRequestOptions = {},
  ): Promise<P2PHttpResponseFrame> {
    if (options.signal?.aborted) {
      throw new P2PDataPlaneAbortError();
    }
    // Reject rather than queue: a peer that cannot keep up must see backpressure instead of
    // silently growing an in-memory backlog (audit N17).
    if (this.pending.size >= this.maxConcurrentRequests) {
      throw new P2PDataPlaneLimitError(
        `TCP P2P transport already has ${this.pending.size} requests in flight (max ${this.maxConcurrentRequests})`,
        'maxConcurrentRequests',
      );
    }

    const requestId = frame.requestId ?? `tcp_${this.randomId()}`;
    const requestFrame: P2PHttpRequestFrame = { ...frame, requestId };
    if (requestFrame.bodyBase64 !== undefined && base64ByteLength(requestFrame.bodyBase64) > this.maxBodyBytes) {
      throw new P2PDataPlaneLimitError(
        `TCP P2P request body exceeds ${this.maxBodyBytes} bytes`,
        'maxBodyBytes',
      );
    }

    // Connect first (that is what announces our nonce), then wait for the peer's hello: waiting
    // before the socket exists would deadlock, because the handshake needs the connection.
    const socket = await this.ensureSocket();
    if (this.secureSession) {
      await this.secureSession.waitReady();
    }
    const response = new Promise<P2PHttpResponseFrame>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        options,
        streaming: false,
      };
      const armTimeout = (): void => {
        clearTimeout(pending.timeout);
        pending.timeout = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`TCP P2P request ${requestId} timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      };
      this.pending.set(requestId, pending);
      armTimeout();

      if (options.signal) {
        const onAbort = (): void => {
          if (!this.pending.delete(requestId)) {
            return;
          }
          clearTimeout(pending.timeout);
          // Tell the peer to stop working on a request nobody is waiting for any more.
          this.write(socket, { type: CANCEL_ENVELOPE, requestId, reason: 'client aborted' });
          reject(new P2PDataPlaneAbortError());
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.detachAbort = () => options.signal?.removeEventListener('abort', onAbort);
      }
    });

    const line = JSON.stringify({ type: REQUEST_ENVELOPE, requestId, frame: requestFrame });
    if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      this.pending.delete(requestId);
      throw new P2PDataPlaneLimitError(
        `TCP P2P request frame exceeds ${this.maxFrameBytes} bytes`,
        'maxFrameBytes',
      );
    }
    this.write(socket, JSON.parse(line) as TcpP2PEnvelope);
    return response;
  }

  public close(): void {
    this.rejectPending(new Error('TCP P2P transport closed'));
    this.socket?.destroy();
    this.socket = undefined;
    this.connectPromise = undefined;
    this.readBuffer = '';
  }

  private async ensureSocket(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) {
      return this.socket;
    }
    if (!this.connectPromise) {
      this.connectPromise = new Promise((resolve, reject) => {
        const socket = createConnection({ host: this.options.remoteHost, port: this.options.remotePort });
        const onError = (error: Error): void => {
          socket.off('connect', onConnect);
          reject(error);
        };
        const onConnect = (): void => {
          socket.off('error', onError);
          this.attachSocket(socket);
          resolve(socket);
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
      });
    }
    return this.connectPromise;
  }

  /**
   * A connection that dies before the handshake completed failed to authenticate at all, so the
   * caller is told that instead of a bare socket error it cannot act on.
   */
  private abortSecure(error: Error): void {
    if (!this.secureSession) {
      this.rejectPending(error);
      return;
    }
    if (!this.secureSession.isEstablished()) {
      const handshakeError = new P2PDataPlaneSecurityError(
        `Data plane connection ended before the secure handshake completed (${error.message})`,
      );
      this.secureSession.abort(handshakeError);
      this.rejectPending(handshakeError);
      return;
    }
    // The session was sealed, so a drop while requests are in flight is reported as such: a
    // peer that cannot authenticate looks exactly like this from here.
    this.rejectPending(new P2PDataPlaneSecurityError(
      `Data plane sealed connection ended while requests were pending (${error.message})`,
    ));
  }

  /** Seals when the session is secure; the hello itself is the only plaintext envelope. */
  private write(socket: Socket, envelope: TcpP2PEnvelope): void {
    try {
      writeEnvelope(socket, this.secureSession ? this.secureSession.seal(envelope) : envelope);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
    }
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.abortSecure(error));
    socket.on('close', () => this.abortSecure(new Error('TCP P2P socket closed')));
    if (this.secureSession) {
      writeEnvelope(socket, this.secureSession.hello());
    }
  }

  private handleData(chunk: Buffer): void {
    this.readBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.readBuffer, 'utf8') > this.maxFrameBytes) {
      // A line that never ends cannot be resynchronised: dropping the connection is the only
      // bounded answer, and it must happen before the buffer grows without limit.
      const error = new P2PDataPlaneLimitError(
        `TCP P2P frame exceeds ${this.maxFrameBytes} bytes without a delimiter`,
        'maxFrameBytes',
      );
      this.readBuffer = '';
      this.socket?.destroy();
      this.rejectPending(error);
      return;
    }

    const { lines, remainder } = splitLines(this.readBuffer);
    this.readBuffer = remainder;
    // Sealing is strictly ordered per direction, so inbound lines are processed one at a time.
    this.readChain = this.readChain.then(async () => {
      for (const line of lines) {
        await this.processLine(line);
      }
    }).catch((error) => this.failSecure(error));
  }

  private failSecure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.socket?.destroy();
    this.rejectPending(failure);
  }

  private async processLine(line: string): Promise<void> {
    {
      const parsed = parseEnvelope(line);
      if (!parsed) {
        return;
      }
      // `open` returns undefined for handshake envelopes and throws on anything that is not a
      // valid sealed frame, which tears the connection down instead of processing it.
      const envelope = this.secureSession ? await this.secureSession.open(parsed) : parsed;
      if (!envelope) {
        return;
      }
      if (envelope.type === CHUNK_ENVELOPE) {
        const pending = this.pending.get(envelope.requestId);
        if (!pending) {
          return;
        }
        this.rearmTimeout(envelope.requestId, pending);
        pending.options.onChunk?.(Buffer.from(envelope.chunkBase64, 'base64'));
        return;
      }
      if (envelope.type === END_ENVELOPE) {
        const pending = this.pending.get(envelope.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        pending.detachAbort?.();
        this.pending.delete(envelope.requestId);
        pending.options.onEnd?.();
        return;
      }
      if (envelope.type !== RESPONSE_ENVELOPE && envelope.type !== ERROR_ENVELOPE) {
        return;
      }
      const pending = this.pending.get(envelope.requestId);
      if (!pending) {
        return;
      }
      if (envelope.type === ERROR_ENVELOPE) {
        clearTimeout(pending.timeout);
        pending.detachAbort?.();
        this.pending.delete(envelope.requestId);
        const error = new Error(envelope.error);
        if (pending.streaming) {
          // The head already reached the caller: the body can only fail, not reject again.
          pending.options.onError?.(error);
        } else {
          pending.reject(error);
        }
        return;
      }
      if (envelope.frame.streamed) {
        // Head first: keep the entry so chunks and the end envelope find their callbacks.
        pending.streaming = true;
        this.rearmTimeout(envelope.requestId, pending);
        pending.resolve(envelope.frame);
        return;
      }
      clearTimeout(pending.timeout);
      pending.detachAbort?.();
      this.pending.delete(envelope.requestId);
      pending.resolve(envelope.frame);
    }
  }

  /** An in-flight stream is bounded by idle time, not by total duration (SSE never ends). */
  private rearmTimeout(requestId: string, pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    pending.timeout = setTimeout(() => {
      this.pending.delete(requestId);
      const error = new Error(`TCP P2P request ${requestId} stalled for ${this.timeoutMs}ms`);
      if (pending.streaming) {
        pending.options.onError?.(error);
      } else {
        pending.reject(error);
      }
    }, this.timeoutMs);
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.detachAbort?.();
      if (pending.streaming) {
        pending.options.onError?.(error);
      } else {
        pending.reject(error);
      }
      this.pending.delete(requestId);
    }
  }
}

class TcpP2PServer implements TcpP2PDataPlaneServer {
  private readonly host: string;
  private server?: Server;
  private sockets = new Set<TcpP2PDataPlaneSocketHandle>();

  public constructor(private readonly options: TcpP2PDataPlaneServerOptions) {
    this.host = options.host ?? '0.0.0.0';
  }

  public async listen(port = 0): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((socket) => this.handleSocket(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(port, this.host);
    });
  }

  public address(): AddressInfo {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new Error(`Expected TCP server address info, got ${String(address)}`);
    }
    return address;
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private handleSocket(socket: Socket): void {
    const handle = attachTcpP2PDataPlaneSocketInternal(socket, this.options.handler, () => {
      this.sockets.delete(handle);
    }, this.options, this.options.secure);
    this.sockets.add(handle);
  }
}

interface SocketLimits {
  maxFrameBytes: number;
  maxBodyBytes: number;
  maxConcurrentRequests: number;
}

interface SocketRequestContext {
  limits: SocketLimits;
  /** In-flight requests, so a cancel envelope and a socket close can abort the real work. */
  inFlight: Map<string, AbortController>;
}

function attachTcpP2PDataPlaneSocketInternal(
  socket: Socket,
  handler: P2PDataPlaneHandler,
  onClose?: () => void,
  limits: P2PDataPlaneLimitsOptions = {},
  secure?: P2PDataPlaneSecurityOptions,
): TcpP2PDataPlaneSocketHandle {
  const context: SocketRequestContext = {
    limits: {
      maxFrameBytes: limits.maxFrameBytes ?? P2P_DATA_PLANE_LIMITS.maxFrameBytes,
      maxBodyBytes: limits.maxBodyBytes ?? P2P_DATA_PLANE_LIMITS.maxBodyBytes,
      maxConcurrentRequests: limits.maxConcurrentRequests ?? P2P_DATA_PLANE_LIMITS.maxConcurrentRequests,
    },
    inFlight: new Map<string, AbortController>(),
  };
  const secureSession = secure
    ? new SecureSession(secure, {
      sendPlaintext: (envelope) => writeEnvelope(socket, envelope),
      fail: (error) => {
        abortInFlight(context, error);
        socket.destroy();
      },
    })
    : undefined;
  let readBuffer = '';
  const onData = (chunk: Buffer): void => {
    readBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(readBuffer, 'utf8') > context.limits.maxFrameBytes) {
      // A line that never ends cannot be resynchronised, and buffering it is exactly the
      // resource exhaustion this limit exists to stop.
      readBuffer = '';
      abortInFlight(context, new P2PDataPlaneLimitError(
        `TCP P2P frame exceeds ${context.limits.maxFrameBytes} bytes without a delimiter`,
        'maxFrameBytes',
      ));
      socket.destroy();
      return;
    }
    const split = splitLines(readBuffer);
    readBuffer = split.remainder;
    // Decoding is sequential (sealed frames must be opened in order) but handling is not:
    // awaiting a long request here would serialise the whole socket and make the concurrency
    // ceiling meaningless.
    readChain = readChain.then(async () => {
      for (const line of split.lines) {
        const envelope = await decodeLine(line, secureSession);
        if (envelope) {
          void dispatchEnvelope(socket, handler, envelope, context, secureSession).catch(() => undefined);
        }
      }
    }).catch((error) => {
      abortInFlight(context, error instanceof Error ? error : new Error(String(error)));
      socket.destroy();
    });
  };
  const onSocketClose = (): void => {
    abortInFlight(context, new P2PDataPlaneAbortError('TCP P2P socket closed'));
    onClose?.();
  };
  let readChain: Promise<void> = Promise.resolve();
  socket.on('data', onData);
  socket.on('close', onSocketClose);
  if (secureSession) {
    // Announce our nonce immediately; the peer's hello is what unlocks sealed frames.
    writeEnvelope(socket, secureSession.hello());
  }
  return {
    close(): void {
      socket.off('data', onData);
      socket.off('close', onSocketClose);
      abortInFlight(context, new P2PDataPlaneAbortError('TCP P2P socket closed'));
      socket.destroy();
      onClose?.();
    },
  };
}

function abortInFlight(context: SocketRequestContext, error: Error): void {
  for (const controller of context.inFlight.values()) {
    controller.abort(error);
  }
  context.inFlight.clear();
}

/** Decodes one wire line, opening it when the connection is secure. */
async function decodeLine(
  line: string,
  secureSession?: SecureSession,
): Promise<TcpP2PEnvelope | undefined> {
  const parsed = parseEnvelope(line);
  if (!parsed) {
    return undefined;
  }
  // A secure endpoint processes nothing that is not sealed, and `open` throws on tampering,
  // reordering or a repeated handshake: the connection is dropped instead.
  return secureSession ? await secureSession.open(parsed) : parsed;
}

async function dispatchEnvelope(
  socket: Socket,
  handler: P2PDataPlaneHandler,
  envelope: TcpP2PEnvelope,
  context: SocketRequestContext,
  secureSession?: SecureSession,
): Promise<void> {
  if (envelope.type === CANCEL_ENVELOPE) {
    // The peer stopped waiting: abort the upstream work instead of finishing a response
    // nobody will read.
    context.inFlight.get(envelope.requestId)?.abort(
      new P2PDataPlaneAbortError(envelope.reason ?? 'peer cancelled the request'),
    );
    return;
  }
  if (envelope.type !== REQUEST_ENVELOPE) {
    return;
  }
  const requestId = envelope.requestId;
  if (!requestId) {
    return;
  }
  if (context.inFlight.has(requestId)) {
    writeSealed(secureSession, socket, { type: ERROR_ENVELOPE, requestId, error: `Duplicate P2P request id ${requestId}` });
    return;
  }
  if (context.inFlight.size >= context.limits.maxConcurrentRequests) {
    writeSealed(secureSession, socket, {
      type: ERROR_ENVELOPE,
      requestId,
      error: new P2PDataPlaneLimitError(
        `TCP P2P socket already has ${context.inFlight.size} requests in flight (max ${context.limits.maxConcurrentRequests})`,
        'maxConcurrentRequests',
      ).message,
    });
    return;
  }

  const controller = new AbortController();
  context.inFlight.set(requestId, controller);
  try {
    const response = await handler.handleRequest(envelope.frame, { signal: controller.signal });
    if (controller.signal.aborted) {
      return;
    }
    if (response.bodyStream) {
      await writeStreamedResponse(socket, requestId, response, context.limits.maxFrameBytes, secureSession);
      return;
    }
    writeSealed(secureSession, socket, { type: RESPONSE_ENVELOPE, requestId, frame: response });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    writeSealed(secureSession, socket, {
      type: ERROR_ENVELOPE,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    context.inFlight.delete(requestId);
  }
}

/**
 * Writes a body that is not fully buffered: head envelope first, then bounded chunks, then an
 * end envelope. Chunk size is capped so a single frame stays well inside the frame limit.
 */
async function writeStreamedResponse(
  socket: Socket,
  requestId: string,
  frame: P2PHttpResponseFrame,
  maxFrameBytes: number,
  secureSession?: SecureSession,
): Promise<void> {
  const { bodyStream, ...head } = frame;
  writeSealed(secureSession, socket, {
    type: RESPONSE_ENVELOPE,
    requestId,
    frame: { ...head, bodyBase64: undefined, streamed: true },
  });
  if (!bodyStream) {
    writeSealed(secureSession, socket, { type: END_ENVELOPE, requestId });
    return;
  }

  const reader = bodyStream.getReader();
  const chunkBytes = Math.min(P2P_DATA_PLANE_LIMITS.chunkBytes, Math.max(1, Math.floor(maxFrameBytes / 2)));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Flush every read immediately: buffering until a full chunk accumulates would hold an
      // SSE event until the next one arrives, which is exactly the streaming failure N17 names.
      // `chunkBytes` only bounds how large a single frame may get, it does not delay a chunk.
      let pending = Buffer.from(value);
      while (pending.byteLength > 0) {
        const slice = pending.subarray(0, chunkBytes);
        writeChunkEnvelope(socket, requestId, slice, secureSession);
        pending = pending.subarray(slice.byteLength);
      }
    }
    writeSealed(secureSession, socket, { type: END_ENVELOPE, requestId });
  } finally {
    reader.releaseLock?.();
  }
}

function writeChunkEnvelope(socket: Socket, requestId: string, chunk: Buffer, secureSession?: SecureSession): void {
  writeSealed(secureSession, socket, { type: CHUNK_ENVELOPE, requestId, chunkBase64: chunk.toString('base64') });
}

/** Seals when the connection is secure, writes directly otherwise. */
function writeSealed(secureSession: SecureSession | undefined, socket: Socket, envelope: TcpP2PEnvelope): void {
  writeEnvelope(socket, secureSession ? secureSession.seal(envelope) : envelope);
}

function writeEnvelope(socket: Socket, envelope: TcpP2PEnvelope): void {
  socket.write(`${JSON.stringify(envelope)}\n`);
}

function splitLines(value: string): { lines: string[]; remainder: string } {
  const parts = value.split('\n');
  return { lines: parts.slice(0, -1).filter((line) => line.length > 0), remainder: parts.at(-1) ?? '' };
}

function parseEnvelope(line: string): TcpP2PEnvelope | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<TcpP2PEnvelope> & Record<string, unknown>;
    if (parsed.type === REQUEST_ENVELOPE && typeof parsed.requestId === 'string' && parsed.frame) {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === RESPONSE_ENVELOPE && typeof parsed.requestId === 'string' && parsed.frame) {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === ERROR_ENVELOPE && typeof parsed.requestId === 'string' && typeof parsed.error === 'string') {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === CHUNK_ENVELOPE && typeof parsed.requestId === 'string' && typeof parsed.chunkBase64 === 'string') {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === END_ENVELOPE && typeof parsed.requestId === 'string') {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === CANCEL_ENVELOPE && typeof parsed.requestId === 'string') {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === SEALED_ENVELOPE && parsed.sealed && typeof (parsed.sealed as SealedDataPlaneFrame).ciphertext === 'string') {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === HELLO_ENVELOPE && typeof parsed.nonce === 'string' && typeof parsed.sessionId === 'string') {
      return parsed as TcpP2PEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stableBoundary(bucket: number): number {
  const value = (BigInt(bucket) * LARGE_PRIME) % UINT32_MODULUS;
  return Number(value < 0 ? value + UINT32_MODULUS : value);
}

function stablePorts(boundary: number, numPorts: number, basePort: number, portRange: number): number[] {
  const rng = mulberry32(boundary >>> 0);
  const ports = new Set<number>();
  while (ports.size < numPorts) {
    ports.add(basePort + Math.floor(rng() * portRange));
  }
  return [...ports].sort((a, b) => b - a);
}

function mulberry32(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}
