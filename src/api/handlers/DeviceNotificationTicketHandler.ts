import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthContext } from '../auth/AuthContext';

export interface DeviceNotificationIdentity {
  webId: string;
  localPart: string;
}

export interface DeviceNotificationTicketRecord {
  digest: string;
  identity: DeviceNotificationIdentity;
  deviceSessionId: string;
  origin: string;
  expiresAt: number;
}

export class DeviceNotificationTicketStore {
  private readonly records = new Map<string, DeviceNotificationTicketRecord>();

  public mint(input: {
    identity: DeviceNotificationIdentity;
    deviceSessionId: string;
    origin: string;
    ttlMs: number;
  }): string {
    const ticket = randomBytes(32).toString('base64url');
    this.records.set(this.digest(ticket), {
      digest: this.digest(ticket),
      identity: input.identity,
      deviceSessionId: input.deviceSessionId,
      origin: new URL(input.origin).origin,
      expiresAt: Date.now() + input.ttlMs,
    });
    return ticket;
  }

  public consume(ticket: string): DeviceNotificationTicketRecord | undefined {
    const digest = this.digest(ticket);
    const record = this.records.get(digest);
    this.records.delete(digest);
    if (!record || record.expiresAt < Date.now()) {
      return undefined;
    }
    return record;
  }

  public size(): number {
    return this.records.size;
  }

  public clear(): void {
    this.records.clear();
  }

  private digest(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }
}

export interface DeviceNotificationTicketHandlerOptions {
  webSocketEndpoint: string;
  origin: string;
  ticketTtlMs?: number;
  ticketStore?: DeviceNotificationTicketStore;
}

type TicketRequest = IncomingMessage & {
  auth?: AuthContext | { webId?: string; localPart?: string };
};

export class DeviceNotificationTicketHandler {
  public readonly ticketStore: DeviceNotificationTicketStore;
  private readonly webSocketEndpoint: string;
  private readonly origin: string;
  private readonly ticketTtlMs: number;

  public constructor(options: DeviceNotificationTicketHandlerOptions) {
    this.webSocketEndpoint = options.webSocketEndpoint;
    this.origin = new URL(options.origin).origin;
    this.ticketTtlMs = options.ticketTtlMs ?? 60_000;
    this.ticketStore = options.ticketStore ?? new DeviceNotificationTicketStore();
  }

  public async handle(request: TicketRequest, response: ServerResponse): Promise<void> {
    const identity = this.extractIdentity(request);
    if (!identity) {
      this.sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    const body = await this.readJson(request);
    const deviceSessionId = typeof body.deviceSessionId === 'string'
      ? body.deviceSessionId
      : typeof body.sessionId === 'string'
        ? body.sessionId
        : undefined;
    const origin = typeof body.origin === 'string' ? body.origin : undefined;
    if (!deviceSessionId || !origin) {
      this.sendJson(response, 400, { error: 'deviceSessionId and origin are required' });
      return;
    }
    try {
      if (new URL(origin).origin !== this.origin) {
        this.sendJson(response, 400, { error: 'origin must match the notification service origin' });
        return;
      }
    } catch {
      this.sendJson(response, 400, { error: 'origin must be a valid URL' });
      return;
    }
    const ticket = this.ticketStore.mint({
      identity,
      deviceSessionId,
      origin: this.origin,
      ttlMs: this.ticketTtlMs,
    });
    this.sendJson(response, 201, {
      protocol: 'xpod.notifications.v1',
      ticket,
      webSocketEndpoint: this.webSocketEndpoint,
      expiresInMs: this.ticketTtlMs,
    });
  }

  private extractIdentity(request: TicketRequest): DeviceNotificationIdentity | undefined {
    const auth = request.auth;
    const webId = auth && 'webId' in auth && typeof auth.webId === 'string' ? auth.webId : undefined;
    if (!webId) {
      return undefined;
    }
    return {
      webId,
      localPart: auth && 'localPart' in auth && typeof auth.localPart === 'string'
        ? auth.localPart
        : deriveLocalPart(webId),
    };
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve());
      request.on('error', reject);
    });
    const body = Buffer.concat(chunks).toString('utf8');
    return body.length > 0 ? JSON.parse(body) : {};
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(encoded),
    });
    response.end(encoded);
  }
}

function deriveLocalPart(webId: string): string {
  try {
    const url = new URL(webId);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
