import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  InternalServerError,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  getLoggerFor,
} from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface EdgeNodeProxyHttpHandlerOptions {
  identityDbUrl: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  fetchImpl?: any;
}

interface ProxyNode {
  nodeId: string;
  metadata?: Record<string, unknown> | null;
}

export class EdgeNodeProxyHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repo: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly fetchImpl: any;

  public constructor(options: EdgeNodeProxyHttpHandlerOptions) {
    super();
    this.repo = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Edge proxy disabled.');
    }
    const hostname = this.extractHostname(request);
    if (!hostname) {
      throw new NotImplementedHttpError('Missing Host header.');
    }
    const node = await this.repo.findNodeBySubdomain(hostname);
    const mode = this.normalizeMode(node?.accessMode);
    if (!node || mode !== 'proxy') {
      throw new NotImplementedHttpError('Not a proxy edge node request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    if ((request.method ?? 'GET').toUpperCase() === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }
    if ((request.method ?? 'GET').toUpperCase() === 'CONNECT') {
      throw new MethodNotAllowedHttpError([ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS' ]);
    }
    const hostname = this.extractHostname(request);
    if (!hostname) {
      throw new BadRequestHttpError('Host header required.');
    }
    const node = await this.repo.findNodeBySubdomain(hostname);
    const mode = this.normalizeMode(node?.accessMode);
    if (!node || mode !== 'proxy') {
      throw new NotImplementedHttpError('Not a proxy edge node request.');
    }
    await this.forwardRequest(node, request, response);
  }

  private async forwardRequest(node: ProxyNode, request: IncomingMessage, response: HttpResponse): Promise<void> {
    const metadata = node.metadata ?? undefined;
    const upstream = this.resolveUpstream(metadata);
    if (!upstream) {
      throw new InternalServerError('Edge node tunnel is not ready.');
    }

    const upstreamBase = new URL(upstream);
    const originalUrl = this.parseUrl(request);
    const target = new URL(originalUrl.pathname + originalUrl.search, upstreamBase);
    target.hash = originalUrl.hash;

    const body = await this.readBody(request);
    const headers = this.buildHeaders(request, originalUrl, upstreamBase);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.fetchImpl(target.toString(), {
        method: (request.method ?? 'GET').toUpperCase(),
        headers,
        body: body?.length ? body : undefined,
      });
    } catch (error: unknown) {
      this.logger.error(`Proxy request to ${target.toString()} failed: ${(error as Error).message}`);
      throw new InternalServerError('Failed to proxy edge node request.', { cause: error });
    }

    response.statusCode = upstreamResponse.status;
    response.setHeader('X-Xpod-Edge-Node', node.nodeId);
    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding' && value === 'chunked') {
        return;
      }
      response.setHeader(key, value);
    });

    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    const readable = Readable.from(upstreamResponse.body as any);
    readable.on('error', (error) => {
      this.logger.error(`Edge proxy stream error: ${(error as Error).message}`);
      response.destroy(error as Error);
    });
    readable.pipe(response);
  }

  private resolveUpstream(metadata?: Record<string, unknown> | null): string | undefined {
    const tunnel = metadata?.tunnel;
    if (tunnel && typeof tunnel === 'object') {
      const entrypoint = (tunnel as Record<string, unknown>).entrypoint;
      if (typeof entrypoint === 'string' && entrypoint.trim().length > 0) {
        return entrypoint;
      }
    }
    if (typeof metadata?.publicAddress === 'string') {
      return metadata.publicAddress;
    }
    return undefined;
  }

  private buildHeaders(request: IncomingMessage, original: URL, upstream: URL): Headers {
    const headers = new Headers();
    for (const [ name, value ] of Object.entries(request.headers)) {
      if (value === undefined) {
        continue;
      }
      if (name.toLowerCase() === 'host') {
        continue;
      }
      if (Array.isArray(value)) {
        headers.set(name, value.join(','));
      } else {
        headers.set(name, value);
      }
    }
    headers.set('host', upstream.host);
    headers.set('x-forwarded-host', original.host);
    headers.set('x-forwarded-proto', original.protocol.replace(/:$/u, ''));
    const port = original.port || (original.protocol === 'https:' ? '443' : '80');
    headers.set('x-forwarded-port', port);
    const remoteAddress = (request.socket as any)?.remoteAddress;
    if (remoteAddress) {
      const existing = headers.get('x-forwarded-for');
      headers.set('x-forwarded-for', existing ? `${existing}, ${remoteAddress}` : remoteAddress);
    }
    return headers;
  }

  private readBody(request: IncomingMessage): Promise<Buffer | undefined> {
    const method = (request.method ?? 'GET').toUpperCase();
    if ([ 'GET', 'HEAD' ].includes(method)) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  private extractHostname(request: IncomingMessage): string | undefined {
    const hostHeader = request.headers.host ?? request.headers.Host;
    if (typeof hostHeader !== 'string') {
      return undefined;
    }
    const hostname = hostHeader.split(':')[0];
    return hostname.trim().toLowerCase();
  }

  private writeOptions(response: HttpResponse): void {
    response.statusCode = 204;
    response.setHeader('Allow', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    response.end();
  }

  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  private normalizeBoolean(value?: string | boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
    }
    return false;
  }

  private normalizeMode(mode: string | undefined): 'proxy' | undefined {
    if (!mode) {
      return undefined;
    }
    const normalized = mode.trim().toLowerCase();
    if (normalized === 'proxy') {
      return 'proxy';
    }
    return undefined;
  }
}
