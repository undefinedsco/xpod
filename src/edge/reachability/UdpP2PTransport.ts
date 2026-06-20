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
const FRAGMENT_ENVELOPE = 'xpod-p2p-http-fragment' as const;
const DEFAULT_MAX_DATAGRAM_BYTES = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const FRAGMENT_TTL_MS = 30_000;

type UdpP2PEnvelope =
  | { type: typeof REQUEST_ENVELOPE; requestId: string; frame: P2PHttpRequestFrame }
  | { type: typeof RESPONSE_ENVELOPE; requestId: string; frame: P2PHttpResponseFrame }
  | { type: typeof ERROR_ENVELOPE; requestId: string; error: string };

type UdpP2PFragmentEnvelope = {
  type: typeof FRAGMENT_ENVELOPE;
  messageId: string;
  sequence: number;
  total: number;
  payloadBase64: string;
};

export interface UdpP2PDataPlaneTransportOptions {
  remoteHost: string;
  remotePort: number;
  socket?: Socket;
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
  socket?: Socket;
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
  private readonly ownsSocket: boolean;
  private socket?: Socket;
  private bindPromise?: Promise<void>;
  private readonly messageHandler = (message: Buffer): void => this.handleMessage(message);
  private readonly errorHandler = (error: Error): void => this.handleError(error);
  private readonly reassembler = new UdpP2PEnvelopeReassembler();
  private readonly pending = new Map<string, {
    resolve: (frame: P2PHttpResponseFrame) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  public constructor(private readonly options: UdpP2PDataPlaneTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxDatagramBytes = options.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES;
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.ownsSocket = !options.socket;
    if (options.socket) {
      this.socket = options.socket;
      options.socket.on('message', this.messageHandler);
      options.socket.on('error', this.errorHandler);
    }
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
    this.socket?.off('message', this.messageHandler);
    this.socket?.off('error', this.errorHandler);
    if (this.ownsSocket) {
      this.socket?.close();
    }
    this.socket = undefined;
    this.bindPromise = undefined;
  }

  private async ensureSocket(): Promise<Socket> {
    if (this.socket) {
      return this.socket;
    }
    const socket = createSocket('udp4');
    socket.on('message', this.messageHandler);
    socket.on('error', this.errorHandler);
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
    const envelope = this.reassembler.accept(message);
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

  private handleError(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

class UdpP2PServer implements UdpP2PDataPlaneServer {
  private readonly socket: Socket;
  private readonly host: string;
  private readonly maxDatagramBytes: number;
  private readonly ownsSocket: boolean;
  private readonly messageHandler = (message: Buffer, remote: RemoteInfo): void => {
    void this.handleMessage(message, remote);
  };
  private readonly reassembler = new UdpP2PEnvelopeReassembler();
  private isListening = false;

  public constructor(private readonly options: UdpP2PDataPlaneServerOptions) {
    this.host = options.host ?? '0.0.0.0';
    this.maxDatagramBytes = options.maxDatagramBytes ?? DEFAULT_MAX_DATAGRAM_BYTES;
    this.socket = options.socket ?? createSocket('udp4');
    this.ownsSocket = !options.socket;
    this.socket.on('message', this.messageHandler);
  }

  public async listen(port = 0): Promise<void> {
    if (this.isListening) {
      return;
    }
    if (!this.ownsSocket) {
      this.isListening = true;
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
    this.socket.off('message', this.messageHandler);
    if (!this.ownsSocket) {
      this.isListening = false;
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
    const envelope = this.reassembler.accept(message);
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
  if (payload.byteLength <= maxDatagramBytes) {
    await sendDatagram(socket, payload, port, host);
    return;
  }

  const messageId = `${envelope.type}:${envelope.requestId}`;
  const fragmentPayloadBytes = getMaxFragmentPayloadBytes(maxDatagramBytes, messageId);
  const total = Math.ceil(payload.byteLength / fragmentPayloadBytes);
  for (let sequence = 0; sequence < total; sequence += 1) {
    const offset = sequence * fragmentPayloadBytes;
    const chunk = payload.subarray(offset, offset + fragmentPayloadBytes);
    const fragment = encodeFragment({
      type: FRAGMENT_ENVELOPE,
      messageId,
      sequence,
      total,
      payloadBase64: chunk.toString('base64'),
    });
    if (fragment.byteLength > maxDatagramBytes) {
      throw new Error(`UDP P2P fragment is ${fragment.byteLength} bytes; max is ${maxDatagramBytes}`);
    }
    await sendDatagram(socket, fragment, port, host);
  }
}

async function sendDatagram(
  socket: Socket,
  payload: Buffer,
  port: number,
  host: string,
): Promise<void> {
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

function getMaxFragmentPayloadBytes(maxDatagramBytes: number, messageId: string): number {
  const overheadBytes = encodeFragment({
    type: FRAGMENT_ENVELOPE,
    messageId,
    sequence: 999_999,
    total: 999_999,
    payloadBase64: '',
  }).byteLength;
  const availableBase64Bytes = maxDatagramBytes - overheadBytes;
  const payloadBytes = Math.floor(availableBase64Bytes / 4) * 3;
  if (payloadBytes <= 0) {
    throw new Error(`UDP P2P maxDatagramBytes ${maxDatagramBytes} is too small for fragment envelopes`);
  }
  return payloadBytes;
}

function encodeFragment(fragment: UdpP2PFragmentEnvelope): Buffer {
  return Buffer.from(JSON.stringify(fragment), 'utf8');
}

class UdpP2PEnvelopeReassembler {
  private readonly pending = new Map<string, {
    createdAt: number;
    total: number;
    chunks: Map<number, Buffer>;
  }>();

  public accept(message: Buffer): UdpP2PEnvelope | undefined {
    const envelope = parseEnvelope(message);
    if (envelope) {
      return envelope;
    }

    const fragment = parseFragment(message);
    if (!fragment) {
      return undefined;
    }
    this.dropExpired();
    if (fragment.sequence < 0 || fragment.sequence >= fragment.total || fragment.total <= 0) {
      return undefined;
    }

    let pending = this.pending.get(fragment.messageId);
    if (pending && pending.total !== fragment.total) {
      this.pending.delete(fragment.messageId);
      pending = undefined;
    }
    if (!pending) {
      pending = {
        createdAt: Date.now(),
        total: fragment.total,
        chunks: new Map(),
      };
      this.pending.set(fragment.messageId, pending);
    }
    pending.chunks.set(fragment.sequence, Buffer.from(fragment.payloadBase64, 'base64'));
    if (pending.chunks.size < pending.total) {
      return undefined;
    }

    const payload = Buffer.concat(Array.from({ length: pending.total }, (_unused, sequence) => pending.chunks.get(sequence) ?? Buffer.alloc(0)));
    this.pending.delete(fragment.messageId);
    return parseEnvelope(payload);
  }

  private dropExpired(): void {
    const now = Date.now();
    for (const [messageId, pending] of this.pending) {
      if (now - pending.createdAt > FRAGMENT_TTL_MS) {
        this.pending.delete(messageId);
      }
    }
  }
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

function parseFragment(message: Buffer): UdpP2PFragmentEnvelope | undefined {
  try {
    const parsed = JSON.parse(message.toString('utf8')) as Partial<UdpP2PFragmentEnvelope>;
    if (
      parsed.type === FRAGMENT_ENVELOPE &&
      typeof parsed.messageId === 'string' &&
      Number.isInteger(parsed.sequence) &&
      Number.isInteger(parsed.total) &&
      typeof parsed.payloadBase64 === 'string'
    ) {
      return parsed as UdpP2PFragmentEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
