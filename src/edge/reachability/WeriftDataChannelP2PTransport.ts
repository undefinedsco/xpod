import {
  RTCPeerConnection,
  type PeerConfig,
  type RTCDataChannel,
} from 'werift';
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
const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_CHANNEL_LABEL = 'xpod-p2p-http';

type WeriftDataChannelEnvelope =
  | { type: typeof REQUEST_ENVELOPE; requestId: string; frame: P2PHttpRequestFrame }
  | { type: typeof RESPONSE_ENVELOPE; requestId: string; frame: P2PHttpResponseFrame }
  | { type: typeof ERROR_ENVELOPE; requestId: string; error: string };

export interface WeriftDataChannelP2PTransportOptions {
  channel: RTCDataChannel;
  timeoutMs?: number;
  randomId?: () => string;
}

export interface WeriftDataChannelP2PTransport extends P2PDataPlaneTransport {
  close(): void;
}

export interface WeriftDataChannelP2PServerOptions {
  channel: RTCDataChannel;
  handler: P2PDataPlaneHandler;
}

export interface WeriftDataChannelP2PServer {
  close(): void;
}

export interface WeriftDataChannelPairOptions {
  label?: string;
  openTimeoutMs?: number;
  peerConfig?: Partial<PeerConfig>;
}

export interface WeriftDataChannelPair {
  clientPeer: RTCPeerConnection;
  nodePeer: RTCPeerConnection;
  clientChannel: RTCDataChannel;
  nodeChannel: RTCDataChannel;
  close(): Promise<void>;
}

export function createWeriftDataChannelP2PTransport(
  options: WeriftDataChannelP2PTransportOptions,
): WeriftDataChannelP2PTransport {
  return new WeriftDataChannelTransport(options);
}

export function createWeriftDataChannelP2PServer(
  options: WeriftDataChannelP2PServerOptions,
): WeriftDataChannelP2PServer {
  return new WeriftDataChannelServer(options);
}

export async function createWeriftDataChannelPair(
  options: WeriftDataChannelPairOptions = {},
): Promise<WeriftDataChannelPair> {
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const clientPeer = new RTCPeerConnection(options.peerConfig);
  const nodePeer = new RTCPeerConnection(options.peerConfig);
  const nodeChannelPromise = waitForNodeDataChannel(nodePeer, openTimeoutMs);
  const clientChannel = clientPeer.createDataChannel(options.label ?? DEFAULT_CHANNEL_LABEL, {
    ordered: true,
  });

  try {
    const offer = await clientPeer.createOffer();
    await clientPeer.setLocalDescription(offer);
    await nodePeer.setRemoteDescription(clientPeer.localDescription!);
    const answer = await nodePeer.createAnswer();
    await nodePeer.setLocalDescription(answer);
    await clientPeer.setRemoteDescription(nodePeer.localDescription!);

    const nodeChannel = await nodeChannelPromise;
    await Promise.all([
      waitForChannelOpen(clientChannel, openTimeoutMs),
      waitForChannelOpen(nodeChannel, openTimeoutMs),
    ]);

    return {
      clientPeer,
      nodePeer,
      clientChannel,
      nodeChannel,
      close: async () => {
        clientChannel.close();
        nodeChannel.close();
        await Promise.allSettled([clientPeer.close(), nodePeer.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([clientPeer.close(), nodePeer.close()]);
    throw error;
  }
}

class WeriftDataChannelTransport implements WeriftDataChannelP2PTransport {
  private readonly timeoutMs: number;
  private readonly randomId: () => string;
  private readonly messageSubscription: { unSubscribe: () => void };
  private readonly stateSubscription: { unSubscribe: () => void };
  private readonly errorSubscription: { unSubscribe: () => void };
  private readonly pending = new Map<string, {
    resolve: (frame: P2PHttpResponseFrame) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

  public constructor(private readonly options: WeriftDataChannelP2PTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.messageSubscription = options.channel.onMessage.subscribe((message) => this.handleMessage(message));
    this.stateSubscription = options.channel.stateChange.subscribe((state) => {
      if (state === 'closed') {
        this.rejectPending(new Error('werift DataChannel closed'));
      }
    });
    this.errorSubscription = options.channel.error.subscribe((error) => {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
    });
  }

  public async request(frame: P2PHttpRequestFrame): Promise<P2PHttpResponseFrame> {
    await waitForChannelOpen(this.options.channel, this.timeoutMs);
    const requestId = frame.requestId ?? `werift_${this.randomId()}`;
    const requestFrame: P2PHttpRequestFrame = { ...frame, requestId };
    const envelope: WeriftDataChannelEnvelope = {
      type: REQUEST_ENVELOPE,
      requestId,
      frame: requestFrame,
    };
    const response = new Promise<P2PHttpResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`werift DataChannel P2P request ${requestId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
    });

    try {
      this.options.channel.send(JSON.stringify(envelope));
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
    this.messageSubscription.unSubscribe();
    this.stateSubscription.unSubscribe();
    this.errorSubscription.unSubscribe();
    this.rejectPending(new Error('werift DataChannel P2P transport closed'));
  }

  private handleMessage(message: string | Buffer): void {
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

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

class WeriftDataChannelServer implements WeriftDataChannelP2PServer {
  private readonly messageSubscription: { unSubscribe: () => void };

  public constructor(private readonly options: WeriftDataChannelP2PServerOptions) {
    this.messageSubscription = options.channel.onMessage.subscribe((message) => {
      void this.handleMessage(message);
    });
  }

  public close(): void {
    this.messageSubscription.unSubscribe();
  }

  private async handleMessage(message: string | Buffer): Promise<void> {
    const envelope = parseEnvelope(message);
    if (!envelope || envelope.type !== REQUEST_ENVELOPE) {
      return;
    }

    try {
      const response = await this.options.handler.handleRequest(envelope.frame);
      await waitForChannelOpen(this.options.channel, DEFAULT_TIMEOUT_MS);
      this.options.channel.send(JSON.stringify({
        type: RESPONSE_ENVELOPE,
        requestId: envelope.requestId,
        frame: response,
      } satisfies WeriftDataChannelEnvelope));
    } catch (error) {
      await waitForChannelOpen(this.options.channel, DEFAULT_TIMEOUT_MS);
      this.options.channel.send(JSON.stringify({
        type: ERROR_ENVELOPE,
        requestId: envelope.requestId,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WeriftDataChannelEnvelope));
    }
  }
}

async function waitForNodeDataChannel(peer: RTCPeerConnection, timeoutMs: number): Promise<RTCDataChannel> {
  const [channel] = await peer.onDataChannel.asPromise(timeoutMs);
  if (!channel) {
    throw new Error('Timed out waiting for werift DataChannel');
  }
  return channel;
}

async function waitForChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === 'open') {
    return;
  }
  await channel.stateChange.watch((state) => state === 'open', timeoutMs);
}

function parseEnvelope(message: string | Buffer): WeriftDataChannelEnvelope | undefined {
  try {
    const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
    const parsed = JSON.parse(text) as Partial<WeriftDataChannelEnvelope>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.requestId !== 'string') {
      return undefined;
    }
    if (parsed.type === REQUEST_ENVELOPE && isRecord(parsed.frame)) {
      return parsed as WeriftDataChannelEnvelope;
    }
    if (parsed.type === RESPONSE_ENVELOPE && isRecord(parsed.frame)) {
      return parsed as WeriftDataChannelEnvelope;
    }
    if (parsed.type === ERROR_ENVELOPE && typeof parsed.error === 'string') {
      return parsed as WeriftDataChannelEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
