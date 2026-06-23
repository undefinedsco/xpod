import { http, socket } from '@kit.NetworkKit';

export interface SmokeConfig {
  apiBaseUrl: string;
  nodeId: string;
  clientId: string;
  resourceUrl: string;
  idpUrl: string;
  storageUrl: string;
  resourcePath: string;
}

interface P2PCandidate {
  role?: string;
  sourceId?: string;
  protocol?: string;
  transport?: string;
  host?: string;
  address?: string;
  port?: number;
  url?: string;
}

interface SessionResponse {
  sessionId: string;
  candidates?: P2PCandidate[];
}

interface CreateSessionRequest {
  kind: string;
  clientId: string;
  candidates: P2PCandidate[];
}

interface P2PRoute {
  kind: string;
}

interface ConnectorEvent {
  type: string;
  remotePort: number;
  remoteAddress: string;
}

export interface SmokeResult {
  ok: boolean;
  smokeOk: boolean;
  route: P2PRoute;
  sessionId: string;
  clientAddress: string;
  connectorEvents: ConnectorEvent[];
  putStatus: number;
  status: number;
  bytes: number;
}

interface SmokeHttpResponse {
  status: number;
  body: string;
}

interface ParsedUrlPath {
  path: string;
}

export class P2PSmokeRunner {
  private readonly config: SmokeConfig;

  constructor(config: SmokeConfig) {
    this.config = config;
  }

  async run(): Promise<SmokeResult> {
    this.validate();
    const session = await this.createSession();
    const candidate = await this.waitForNodeCandidate(session.sessionId);
    const body = `harmony-p2p-smoke-${Date.now()}`;
    const put = await this.sendP2PRequest(candidate, 'PUT', body);
    const get = await this.sendP2PRequest(candidate, 'GET', '');
    const success = put.status >= 200 && put.status < 300 && get.status >= 200 && get.status < 300;
    const route: P2PRoute = { kind: 'p2p' };
    const event: ConnectorEvent = {
      type: 'success',
      remotePort: candidate.port ?? 0,
      remoteAddress: 'signal-observed',
    };
    const events: ConnectorEvent[] = [event];
    const result: SmokeResult = {
      ok: success,
      smokeOk: success,
      route,
      sessionId: session.sessionId,
      clientAddress: 'signal-observed',
      connectorEvents: events,
      putStatus: put.status,
      status: get.status,
      bytes: get.body.length,
    };
    return result;
  }

  private validate(): void {
    this.requirePresent('apiBaseUrl', this.config.apiBaseUrl);
    this.requirePresent('nodeId', this.config.nodeId);
    this.requirePresent('clientId', this.config.clientId);
    this.requirePresent('resourceUrl', this.config.resourceUrl);
  }

  private requirePresent(key: string, value: string): void {
    if (!value || value.trim().length === 0) {
      throw new Error(`${key} is required`);
    }
  }

  private async createSession(): Promise<SessionResponse> {
    const url = `${trimSlash(this.config.apiBaseUrl)}/v1/signal/nodes/${encodeURIComponent(this.config.nodeId)}/sessions`;
    const candidate: P2PCandidate = {
      role: 'client',
      sourceId: this.config.clientId,
      protocol: 'xpod-p2p-http/1',
      transport: 'tcp',
    };
    const candidates: P2PCandidate[] = [candidate];
    const request: CreateSessionRequest = {
      kind: 'p2p',
      clientId: this.config.clientId,
      candidates,
    };
    const response = await this.requestJson(url, 'POST', JSON.stringify(request));
    return parseSessionResponse(response);
  }

  private async waitForNodeCandidate(sessionId: string): Promise<P2PCandidate> {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const url = `${trimSlash(this.config.apiBaseUrl)}/v1/signal/nodes/${encodeURIComponent(this.config.nodeId)}/sessions/${encodeURIComponent(sessionId)}`;
      const response = await this.requestJson(url, 'GET', '');
      const session = parseSessionResponse(response);
      const candidate = findNodeCandidate(session.candidates ?? []);
      if (candidate !== undefined) return candidate;
      await sleep(1000);
    }
    throw new Error('Timed out waiting for node TCP candidate');
  }

  private async requestJson(url: string, method: string, body: string): Promise<string> {
    const request = http.createHttp();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const options: http.HttpRequestOptions = {
      method: method === 'POST' ? http.RequestMethod.POST : http.RequestMethod.GET,
      header: headers,
      expectDataType: http.HttpDataType.STRING,
      connectTimeout: 30000,
      readTimeout: 30000,
    };
    if (body.length > 0) {
      options.extraData = body;
    }
    const response = await request.request(url, options);
    request.destroy();
    return `${response.result}`;
  }

  private async sendP2PRequest(candidate: P2PCandidate, method: string, body: string): Promise<SmokeHttpResponse> {
    const client = socket.constructTCPSocketInstance();
    const host = candidate.address ?? candidate.host ?? candidate.url ?? '';
    const port = candidate.port ?? 0;
    if (!host || port <= 0) throw new Error('Invalid node TCP candidate');
    const address: socket.NetAddress = { address: host, port, family: 1 };
    const connectOptions: socket.TCPConnectOptions = { address, timeout: 30000 };
    await client.connect(connectOptions);
    const request = constructP2PHttpRequest(method, this.config.resourceUrl, body);
    const sendOptions: socket.TCPSendOptions = { data: request };
    await client.send(sendOptions);
    const chunks: string[] = [];
    const response = await new Promise<SmokeHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for P2P response')), 30000);
      client.on('message', (value: socket.SocketMessageInfo) => {
        chunks.push(bufferToString(value.message));
        const text = chunks.join('');
        if (text.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve(parseHttpResponse(text));
        }
      });
      client.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await client.close();
    return response;
  }
}

export function constructP2PHttpRequest(method: string, resourceUrl: string, body: string): string {
  const parsed: ParsedUrlPath = parseUrlPath(resourceUrl);
  const payload = body ?? '';
  return `${method} ${parsed.path} HTTP/1.1\r\nHost: xpod-p2p\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n${payload}`;
}

function parseUrlPath(resourceUrl: string): ParsedUrlPath {
  let rest = resourceUrl;
  const schemeIndex = rest.indexOf('://');
  if (schemeIndex >= 0) {
    rest = rest.substring(schemeIndex + 3);
    const slashIndex = rest.indexOf('/');
    if (slashIndex >= 0) {
      rest = rest.substring(slashIndex);
    } else {
      rest = '/';
    }
  }
  const queryIndex = rest.indexOf('?');
  const hashIndex = rest.indexOf('#');
  let endIndex = rest.length;
  if (queryIndex >= 0 && queryIndex < endIndex) endIndex = queryIndex;
  if (hashIndex >= 0 && hashIndex < endIndex) endIndex = hashIndex;
  const path = rest.substring(0, endIndex);
  return { path: path.length > 0 ? path : '/' };
}

function parseSessionResponse(text: string): SessionResponse {
  const data = JSON.parse(text) as SessionResponse;
  return data;
}

function findNodeCandidate(candidates: P2PCandidate[]): P2PCandidate | undefined {
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    if (item.role === 'node' && item.transport === 'tcp' && typeof item.port === 'number') {
      return item;
    }
  }
  return undefined;
}

function parseHttpResponse(text: string): SmokeHttpResponse {
  const firstLine = text.split('\r\n')[0];
  const parts = firstLine.split(' ');
  const status = Number(parts[1] ?? 0);
  const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return { status, body };
}

function bufferToString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let output = '';
  for (let index = 0; index < bytes.length; index += 1) {
    output += String.fromCharCode(bytes[index]);
  }
  return output;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
