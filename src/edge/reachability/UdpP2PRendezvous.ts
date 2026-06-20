import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import type { P2PCandidateRole, P2PTransportCandidate } from './types';

const HELLO_ENVELOPE = 'xpod-p2p-udp-rendezvous-hello' as const;
const ACK_ENVELOPE = 'xpod-p2p-udp-rendezvous-ack' as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 50;

type UdpP2PRendezvousEnvelope =
  | {
      type: typeof HELLO_ENVELOPE;
      sessionId: string;
      role: P2PCandidateRole;
      sourceId: string;
      candidate: P2PTransportCandidate;
    }
  | {
      type: typeof ACK_ENVELOPE;
      sessionId: string;
      role: P2PCandidateRole;
      sourceId: string;
      candidate: P2PTransportCandidate;
    };

interface CandidateEndpoint {
  host: string;
  port: number;
  candidate: P2PTransportCandidate;
}

interface PendingConnect {
  endpoints: CandidateEndpoint[];
  resolve: (connection: UdpP2PRendezvousConnection) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  interval: NodeJS.Timeout;
}

export interface UdpP2PRendezvousPeerOptions {
  sessionId: string;
  role: P2PCandidateRole;
  sourceId: string;
  host?: string;
  port?: number;
  publicHost?: string;
  publicPort?: number;
  randomId?: () => string;
  now?: () => Date;
}

export interface UdpP2PRendezvousConnectOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface UdpP2PRendezvousConnection {
  sessionId: string;
  remoteHost: string;
  remotePort: number;
  remoteCandidate: P2PTransportCandidate;
}

export interface UdpP2PRendezvousPeer {
  listen(port?: number): Promise<void>;
  candidate(): P2PTransportCandidate;
  connect(candidates: P2PTransportCandidate[], options?: UdpP2PRendezvousConnectOptions): Promise<UdpP2PRendezvousConnection>;
  socket(): Socket;
  close(): Promise<void>;
}

export function createUdpP2PRendezvousPeer(options: UdpP2PRendezvousPeerOptions): UdpP2PRendezvousPeer {
  return new UdpP2PRendezvousPeerImpl(options);
}

class UdpP2PRendezvousPeerImpl implements UdpP2PRendezvousPeer {
  private readonly socketInstance: Socket;
  private readonly randomId: () => string;
  private readonly now: () => Date;
  private readonly messageHandler = (message: Buffer, remote: RemoteInfo): void => {
    void this.handleMessage(message, remote);
  };
  private isListening = false;
  private localCandidate?: P2PTransportCandidate;
  private pending?: PendingConnect;

  public constructor(private readonly options: UdpP2PRendezvousPeerOptions) {
    this.socketInstance = createSocket('udp4');
    this.socketInstance.on('message', this.messageHandler);
    this.randomId = options.randomId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.now = options.now ?? (() => new Date());
  }

  public async listen(port = this.options.port ?? 0): Promise<void> {
    if (this.isListening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.socketInstance.once('listening', () => {
        this.isListening = true;
        resolve();
      });
      this.socketInstance.once('error', reject);
      this.socketInstance.bind(port, this.options.host ?? '0.0.0.0');
    });
  }

  public candidate(): P2PTransportCandidate {
    if (this.localCandidate) {
      return this.localCandidate;
    }
    const address = this.address();
    this.localCandidate = {
      id: `udp_${this.options.role}_${this.options.sourceId}_${this.randomId()}`,
      role: this.options.role,
      sourceId: this.options.sourceId,
      createdAt: this.now().toISOString(),
      protocol: 'udp',
      transport: 'udp',
      host: this.options.publicHost ?? normalizeAdvertisedHost(address.address),
      port: this.options.publicPort ?? address.port,
      metadata: {
        provider: 'udp-direct',
        sessionId: this.options.sessionId,
      },
    };
    return this.localCandidate;
  }

  public async connect(
    candidates: P2PTransportCandidate[],
    options: UdpP2PRendezvousConnectOptions = {},
  ): Promise<UdpP2PRendezvousConnection> {
    await this.listen();
    if (this.pending) {
      throw new Error(`UDP P2P rendezvous for ${this.options.sessionId} is already in progress`);
    }
    const endpoints = candidates
      .map(toEndpoint)
      .filter((endpoint): endpoint is CandidateEndpoint => Boolean(endpoint))
      .filter((endpoint) => endpoint.candidate.sourceId !== this.options.sourceId);
    if (endpoints.length === 0) {
      throw new Error('No usable UDP P2P candidate endpoints');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    return new Promise((resolve, reject) => {
      const clear = () => {
        if (this.pending) {
          clearTimeout(this.pending.timeout);
          clearInterval(this.pending.interval);
          this.pending = undefined;
        }
      };
      const sendHello = () => {
        for (const endpoint of endpoints) {
          void this.sendEnvelope({
            type: HELLO_ENVELOPE,
            sessionId: this.options.sessionId,
            role: this.options.role,
            sourceId: this.options.sourceId,
            candidate: this.candidate(),
          }, endpoint.port, endpoint.host).catch((error) => {
            this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      };
      const timeout = setTimeout(() => {
        clear();
        reject(new Error(`UDP P2P rendezvous ${this.options.sessionId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const interval = setInterval(sendHello, intervalMs);
      this.pending = {
        endpoints,
        resolve: (connection) => {
          clear();
          resolve(connection);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
        timeout,
        interval,
      };
      sendHello();
    });
  }

  public socket(): Socket {
    return this.socketInstance;
  }

  public async close(): Promise<void> {
    this.socketInstance.off('message', this.messageHandler);
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      clearInterval(this.pending.interval);
      this.pending.reject(new Error(`UDP P2P rendezvous ${this.options.sessionId} peer closed`));
      this.pending = undefined;
    }
    if (!this.isListening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socketInstance.close(() => {
        this.isListening = false;
        resolve();
      });
    });
  }

  private address(): AddressInfo {
    const address = this.socketInstance.address();
    if (typeof address === 'string') {
      throw new Error(`Expected UDP socket address info, got ${address}`);
    }
    return address;
  }

  private async handleMessage(message: Buffer, remote: RemoteInfo): Promise<void> {
    const envelope = parseEnvelope(message);
    if (!envelope || envelope.sessionId !== this.options.sessionId) {
      return;
    }
    if (envelope.role === this.options.role && envelope.sourceId === this.options.sourceId) {
      return;
    }

    if (envelope.type === HELLO_ENVELOPE) {
      await this.sendEnvelope({
        type: ACK_ENVELOPE,
        sessionId: this.options.sessionId,
        role: this.options.role,
        sourceId: this.options.sourceId,
        candidate: this.candidate(),
      }, remote.port, remote.address).catch((error) => {
        this.pending?.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
    this.resolvePending(remote, envelope.candidate);
  }

  private resolvePending(remote: RemoteInfo, candidate: P2PTransportCandidate): void {
    if (!this.pending) {
      return;
    }
    const remoteCandidate = {
      ...candidate,
      host: candidate.host ?? remote.address,
      port: candidate.port ?? remote.port,
    };
    this.pending.resolve({
      sessionId: this.options.sessionId,
      remoteHost: remote.address,
      remotePort: remote.port,
      remoteCandidate,
    });
  }

  private async sendEnvelope(envelope: UdpP2PRendezvousEnvelope, port: number, host: string): Promise<void> {
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
    await new Promise<void>((resolve, reject) => {
      this.socketInstance.send(payload, port, host, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function toEndpoint(candidate: P2PTransportCandidate): CandidateEndpoint | undefined {
  if (candidate.protocol !== 'udp' && candidate.transport !== 'udp' && !candidate.url?.startsWith('udp:')) {
    return undefined;
  }
  const urlEndpoint = endpointFromUrl(candidate.url);
  if (urlEndpoint) {
    return { ...urlEndpoint, candidate };
  }
  const host = candidate.host ?? candidate.address;
  const port = candidate.port;
  if (!host || !port) {
    return undefined;
  }
  return { host, port, candidate };
}

function endpointFromUrl(value?: string): { host: string; port: number } | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (url.protocol !== 'udp:' || !url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return { host: url.hostname, port };
  } catch {
    return undefined;
  }
}

function parseEnvelope(message: Buffer): UdpP2PRendezvousEnvelope | undefined {
  try {
    const parsed = JSON.parse(message.toString('utf8')) as Partial<UdpP2PRendezvousEnvelope>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (
      (parsed.type === HELLO_ENVELOPE || parsed.type === ACK_ENVELOPE)
      && typeof parsed.sessionId === 'string'
      && (parsed.role === 'client' || parsed.role === 'node')
      && typeof parsed.sourceId === 'string'
      && isRecord(parsed.candidate)
    ) {
      return parsed as UdpP2PRendezvousEnvelope;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeAdvertisedHost(address: string): string {
  return address === '0.0.0.0' ? '127.0.0.1' : address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
