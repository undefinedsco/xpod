import type {
  P2PCandidateUpdateRequest,
  P2PSession,
  P2PSessionRequest,
  P2PTransportCandidate,
} from './types';

export interface P2PSignalingClientOptions {
  apiBaseUrl: string;
  nodeId: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateP2PSessionInput {
  clientId: string;
  capabilities?: string[];
  candidates?: P2PTransportCandidate[];
}

export interface P2PSignalingClient {
  createP2PSession(request: CreateP2PSessionInput): Promise<P2PSession>;
  getP2PSession(sessionIdOrUrl: string): Promise<P2PSession>;
  addP2PCandidates(sessionIdOrUrl: string, request: P2PCandidateUpdateRequest): Promise<P2PSession>;
}

export class P2PSignalingRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly responseText: string,
  ) {
    super(message);
  }
}

export function createP2PSignalingClient(options: P2PSignalingClientOptions): P2PSignalingClient {
  return new HttpP2PSignalingClient(options);
}

class HttpP2PSignalingClient implements P2PSignalingClient {
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: P2PSignalingClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async createP2PSession(request: CreateP2PSessionInput): Promise<P2PSession> {
    return this.requestSession(this.sessionsUrl(), {
      method: 'POST',
      body: {
        kind: 'p2p',
        clientId: request.clientId,
        capabilities: request.capabilities ?? [],
        candidates: request.candidates ?? [],
      } satisfies P2PSessionRequest,
    });
  }

  public async getP2PSession(sessionIdOrUrl: string): Promise<P2PSession> {
    return this.requestSession(this.sessionUrl(sessionIdOrUrl), { method: 'GET' });
  }

  public async addP2PCandidates(
    sessionIdOrUrl: string,
    request: P2PCandidateUpdateRequest,
  ): Promise<P2PSession> {
    return this.requestSession(new URL('candidates', ensureTrailingSlash(this.sessionUrl(sessionIdOrUrl))).toString(), {
      method: 'POST',
      body: request,
    });
  }

  private sessionsUrl(): string {
    return new URL(`/v1/signal/nodes/${encodeURIComponent(this.options.nodeId)}/sessions`, this.options.apiBaseUrl).toString();
  }

  private sessionUrl(sessionIdOrUrl: string): string {
    if (/^https?:\/\//u.test(sessionIdOrUrl)) {
      return sessionIdOrUrl;
    }
    return new URL(`${ensureTrailingSlash(this.sessionsUrl())}${encodeURIComponent(sessionIdOrUrl)}`).toString();
  }

  private async requestSession(url: string, request: {
    method: 'GET' | 'POST';
    body?: unknown;
  }): Promise<P2PSession> {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    if (this.options.token) {
      headers.set('authorization', `Bearer ${this.options.token}`);
    }
    const response = await this.fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    if (!response.ok) {
      const responseText = await safeReadText(response);
      throw new P2PSignalingRequestError(
        `P2P signaling request ${request.method} ${url} failed with ${response.status}`,
        response.status,
        responseText,
      );
    }
    const body = await response.json() as unknown;
    return assertP2PSession(body);
  }
}

function assertP2PSession(value: unknown): P2PSession {
  if (!isP2PSession(value)) {
    throw new Error('P2P signaling response is not a p2p session');
  }
  return value;
}

function isP2PSession(value: unknown): value is P2PSession {
  return isRecord(value)
    && value.kind === 'p2p'
    && typeof value.sessionId === 'string'
    && typeof value.nodeId === 'string'
    && typeof value.clientId === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.expiresAt === 'string'
    && Array.isArray(value.nodeCandidates)
    && typeof value.signalingUrl === 'string'
    && Array.isArray(value.capabilities)
    && Array.isArray(value.candidates);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
