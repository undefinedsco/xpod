import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type {
  P2PDataPlaneHandler,
  P2PDataPlaneTransport,
  P2PHttpRequestFrame,
  P2PHttpResponseFrame,
} from './P2PDataPlane';

const REQUEST_ENVELOPE = 'xpod-p2p-http-request' as const;
const RESPONSE_ENVELOPE = 'xpod-p2p-http-response' as const;
const ERROR_ENVELOPE = 'xpod-p2p-http-error' as const;
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
  | { type: typeof ERROR_ENVELOPE; requestId: string; error: string };

export interface TcpP2PDataPlaneTransportOptions {
  remoteHost: string;
  remotePort: number;
  socket?: Socket;
  timeoutMs?: number;
  randomId?: () => string;
}

export interface TcpP2PDataPlaneTransport extends P2PDataPlaneTransport {
  close(): void;
}

export interface TcpP2PDataPlaneServerOptions {
  handler: P2PDataPlaneHandler;
  host?: string;
}

export interface TcpP2PDataPlaneServer {
  listen(port?: number): Promise<void>;
  address(): AddressInfo;
  close(): Promise<void>;
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

class TcpP2PTransport implements TcpP2PDataPlaneTransport {
  private readonly timeoutMs: number;
  private readonly randomId: () => string;
  private socket?: Socket;
  private connectPromise?: Promise<Socket>;
  private readBuffer = '';
  private readonly pending = new Map<string, {
    resolve: (frame: P2PHttpResponseFrame) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  public constructor(private readonly options: TcpP2PDataPlaneTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    if (options.socket) {
      this.attachSocket(options.socket);
    }
  }

  public async request(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame> {
    const requestId = frame.requestId ?? `tcp_${this.randomId()}`;
    const requestFrame: P2PHttpRequestFrame = { ...frame, requestId };
    const socket = await this.ensureSocket();
    const response = new Promise<P2PHttpResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`TCP P2P request ${requestId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
    });
    writeEnvelope(socket, { type: REQUEST_ENVELOPE, requestId, frame: requestFrame });
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

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.rejectPending(error));
    socket.on('close', () => this.rejectPending(new Error('TCP P2P socket closed')));
  }

  private handleData(chunk: Buffer): void {
    this.readBuffer += chunk.toString('utf8');
    const { lines, remainder } = splitLines(this.readBuffer);
    this.readBuffer = remainder;
    for (const line of lines) {
      const envelope = parseEnvelope(line);
      if (!envelope || (envelope.type !== RESPONSE_ENVELOPE && envelope.type !== ERROR_ENVELOPE)) {
        continue;
      }
      const pending = this.pending.get(envelope.requestId);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(envelope.requestId);
      if (envelope.type === ERROR_ENVELOPE) {
        pending.reject(new Error(envelope.error));
        continue;
      }
      pending.resolve(envelope.frame);
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

class TcpP2PServer implements TcpP2PDataPlaneServer {
  private readonly host: string;
  private server?: Server;
  private sockets = new Set<Socket>();

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
      socket.destroy();
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
    this.sockets.add(socket);
    let readBuffer = '';
    socket.on('data', (chunk) => {
      readBuffer += chunk.toString('utf8');
      const split = splitLines(readBuffer);
      readBuffer = split.remainder;
      for (const line of split.lines) {
        void this.handleLine(socket, line);
      }
    });
    socket.on('close', () => this.sockets.delete(socket));
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const envelope = parseEnvelope(line);
    if (!envelope || envelope.type !== REQUEST_ENVELOPE) {
      return;
    }
    try {
      const response = await this.options.handler.handleRequest(envelope.frame);
      writeEnvelope(socket, { type: RESPONSE_ENVELOPE, requestId: envelope.requestId, frame: response });
    } catch (error) {
      writeEnvelope(socket, {
        type: ERROR_ENVELOPE,
        requestId: envelope.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
    const parsed = JSON.parse(line) as Partial<TcpP2PEnvelope>;
    if (parsed.type === REQUEST_ENVELOPE && typeof parsed.requestId === 'string' && parsed.frame) {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === RESPONSE_ENVELOPE && typeof parsed.requestId === 'string' && parsed.frame) {
      return parsed as TcpP2PEnvelope;
    }
    if (parsed.type === ERROR_ENVELOPE && typeof parsed.requestId === 'string' && typeof parsed.error === 'string') {
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
