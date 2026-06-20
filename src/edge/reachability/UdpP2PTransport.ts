import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type {
  P2PDataPlaneHandler,
  P2PDataPlaneTransport,
  P2PHttpRequestFrame,
  P2PHttpResponseFrame,
} from './P2PDataPlane';

const REQUEST_ENVELOPE = 'xpod-p2p-http-request' as const;
const RESPONSE_ENVELOPE = 'xpod-p2p-http-response' as const;
const ERROR_ENVELOPE = 'xpod-p2p-http-error' as const;
const DEFAULT_MAX_DATAGRAM_BYTES = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;

type UdpP2PEnvelope =
  | { type: typeof REQUEST_ENVELOPE; requestId: string; frame: P2PHttpRequestFrame }
  | { type: typeof RESPONSE_ENVELOPE; requestId: string; frame: P2PHttpResponseFrame }
  | { type: typeof ERROR_ENVELOPE; requestId: string; error: string };

export interface UdpP2PDataPlaneTransportOptions {
  remoteHost: string;
  remotePort: number;
  localHost?: string;
  localPort?: number;
  timeoutMs?: number;
  maxDatagramBytes?: number;
  randomId?: () => string;
}

export interface UdpP2PDataPlaneTransport extends P2PDataPlaneTransport {
  close(): void;
}

export interface UdpP2PDataPlaneServerOptions {
  handler: P2PDataPlaneHandler;
  host?: string;
  maxDatagramBytes?: number;
}

export interface UdpP2PDataPlaneServer {
  listen(port?: number): Promise<void>;
  address(): AddressInfo;
  close(): Promise<void>;
}

export function createUdpP2PDataPlaneTransport(options: UdpP2PDataPlaneTransportOptions): UdpP2PDataPlaneTransport {
  return new UdpP2PTransport(options);
}

export function createUdpP2PDataPlaneServer(options: UdpP2PDataPlaneServerOptions): UdpP2PDataPlaneServer {
  return new UdpP2PServer(options);
}

class UdpP2PTransport implements UdpP2PDataPlaneTransport {
  private readonly timeoutMs: number;
  private readonly maxDatagramBytes: number;
  private readonly randomId: () => string;
  private socket?: Socket;
  private bindPromise?: Promise<void>;
  private readonly pending = new Map<string, {
    resolve: (frame: P2PHttpResponseFrame) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  public constructor(private readonly options: UdpP2PDataPlaneTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxDatagramBytes = options.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES;
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  }

  public async request(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame> {
    const requestId = frame.requestId ?? `udp_${this.randomId()}`;
    const requestFrame: P2PHttpRequestFrame = { ...frame, requestId };
    const envelope: UdpP2PEnvelope = {
      type: REQUEST_ENVELOPE,
      requestId,
      frame: requestFrame,
    };
    const socket = await this.ensureSocket();

    const response = new Promise<P2PHttpResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`UDP P2P request ${requestId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
    });

    try {
      await sendEnvelope(socket, envelope, this.options.remotePort, this.options.remoteHost, this.maxDatagramBytes);
    } catch (error) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return response;
  }

  public close(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`UDP P2P transport closed before response for ${requestId}`));
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = undefined;
    this.bindPromise = undefined;
  }

  private async ensureSocket(): Promise<Socket> {
    if (this.socket) {
      return this.socket;
    }
    const socket = createSocket('udp4');
    socket.on('message', (message) => this.handleMessage(message));
    socket.on('error', (error) => {
      for (const [requestId, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        this.pending.delete(requestId);
      }
    });
    this.socket = socket;
    this.bindPromise = new Promise((resolve, reject) => {
      socket.once('listening', resolve);
      socket.once('error', reject);
      socket.bind(this.options.localPort ?? 0, this.options.localHost ?? '0.0.0.0');
    });
    await this.bindPromise;
    return socket;
  }

  private handleMessage(message: Buffer): void {
    const envelope = parseEnvelope(message);
    if (!envelope || (envelope.type !== RESPONSE_ENVELOPE && envelope.type !== ERROR_ENVELOPE)) {
      return;
    }
    const pending = this.pending.get(envelope.requestId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(envelope.requestId);
    if (envelope.type === ERROR_ENVELOPE) {
      pending.reject(new Error(envelope.error));
      return;
    }
    pending.resolve(envelope.frame);
  }
}

class UdpP2PServer implements UdpP2PDataPlaneServer {
  private readonly socket: Socket;
  private readonly host: string;
  private readonly maxDatagramBytes: number;
  private isListening = false;

  public constructor(private readonly options: UdpP2PDataPlaneServerOptions) {
    this.host = options.host ?? '0.0.0.0';
    this.maxDatagramBytes = options.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES;
    this.socket = createSocket('udp4');
    this.socket.on('message', (message, remote) => {
      void this.handleMessage(message, remote);
    });
  }

  public async listen(port = 0): Promise<void> {
    if (this.isListening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.once('listening', () => {
        this.isListening = true;
        resolve();
      });
      this.socket.once('error', reject);
      this.socket.bind(port, this.host);
    });
  }

  public address(): AddressInfo {
    const address = this.socket.address();
    if (typeof address === 'string') {
      throw new Error(`Expected UDP socket address info, got ${address}`);
    }
    return address;
  }

  public async close(): Promise<void> {
    if (!this.isListening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.close(() => {
        this.isListening = false;
        resolve();
      });
    });
  }

  private async handleMessage(message: Buffer, remote: RemoteInfo): Promise<void> {
    const envelope = parseEnvelope(message);
    if (!envelope || envelope.type !== REQUEST_ENVELOPE) {
      return;
    }

    try {
      const response = await this.options.handler.handleRequest(envelope.frame);
      await sendEnvelope(this.socket, {
        type: RESPONSE_ENVELOPE,
        requestId: envelope.requestId,
        frame: response,
      }, remote.port, remote.address, this.maxDatagramBytes);
    } catch (error) {
      await sendEnvelope(this.socket, {
        type: ERROR_ENVELOPE,
        requestId: envelope.requestId,
        error: error instanceof Error ? error.message : String(error),
      }, remote.port, remote.address, this.maxDatagramBytes);
    }
  }
}

async function sendEnvelope(
  socket: Socket,
  envelope: UdpP2PEnvelope,
  port: number,
  host: string,
  maxDatagramBytes: number,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (payload.byteLength > maxDatagramBytes) {
    throw new Error(`UDP P2P datagram is ${payload.byteLength} bytes; max is ${maxDatagramBytes}`);
  }
  await new Promise<void>((resolve, reject) => {
    socket.send(payload, port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseEnvelope(message: Buffer): UdpP2PEnvelope | undefined {
  try {
    const parsed = JSON.parse(message.toString('utf8')) as Partial<UdpP2PEnvelope>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.requestId !== 'string') {
      return undefined;
    }
    if (parsed.type === REQUEST_ENVELOPE && isRecord(parsed.frame)) {
      return parsed as UdpP2PEnvelope;
    }
    if (parsed.type === RESPONSE_ENVELOPE && isRecord(parsed.frame)) {
      return parsed as UdpP2PEnvelope;
    }
    if (parsed.type === ERROR_ENVELOPE && typeof parsed.error === 'string') {
      return parsed as UdpP2PEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
