import type { IncomingMessage } from 'node:http';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpResponse } from '@solid/community-server';
import {
  NotImplementedHttpError,
  InternalServerError,
  getLoggerFor,
} from '@solid/community-server';
import { getIdentityDatabase } from '../identity/drizzle/db';
import { EdgeNodeRepository } from '../identity/drizzle/EdgeNodeRepository';

interface EdgeNodeDirectDebugHttpHandlerOptions {
  identityDbUrl: string;
  edgeNodesEnabled?: string | boolean;
  skipPrefixes?: string[];
  nodeRepository?: EdgeNodeRepository;
}

export class EdgeNodeDirectDebugHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly nodeRepo: EdgeNodeRepository;
  private readonly enabled: boolean;
  private readonly skipPrefixes: string[];

  public constructor(options: EdgeNodeDirectDebugHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.nodeRepo = options.nodeRepository ?? new EdgeNodeRepository(db as any);
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
    this.skipPrefixes = options.skipPrefixes ?? [ '/admin', '/api', '/.internal' ];
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Edge node redirection disabled.');
    }
    const url = this.parseUrl(request);
    if (this.shouldSkip(url.pathname)) {
      throw new NotImplementedHttpError('Path excluded from edge routing.');
    }
    const target = await this.resolve(url.pathname, url);
    if (!target) {
      throw new NotImplementedHttpError('Edge node endpoint not configured.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const url = this.parseUrl(request);
    if (this.shouldSkip(url.pathname)) {
      throw new NotImplementedHttpError('Path excluded from edge routing.');
    }
    const resolved = await this.resolve(url.pathname, url);
    if (!resolved) {
      throw new NotImplementedHttpError('No edge node registered for this resource.');
    }

    this.logger.debug(`Redirecting ${url.pathname} to edge node ${resolved.nodeId}`);
    try {
      response.statusCode = 307;
      response.setHeader('Location', resolved.target.toString());
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Xpod-Edge-Node', resolved.nodeId);
      response.end();
    } catch (error: unknown) {
      throw new InternalServerError('Failed to write edge node redirect.', { cause: error });
    }
  }

  private async resolve(pathname: string, original: URL): Promise<{ nodeId: string; target: URL } | undefined> {
    const record = await this.nodeRepo.findNodeByResourcePath(pathname);
    if (!record) {
      return undefined;
    }
    
    // Only handle direct mode nodes - proxy mode traffic should go through L4 SNI proxy
    if (record.accessMode === 'proxy') {
      this.logger.warn(`Request reached cluster for proxy-mode node ${record.nodeId}, should be handled by L4 SNI proxy`);
      return undefined;
    }
    
    const target = this.resolveTarget(record.metadata ?? {}, original, record.baseUrl);
    if (!target) {
      return undefined;
    }
    return { nodeId: record.nodeId, target };
  }

  private shouldSkip(pathname: string): boolean {
    return this.skipPrefixes.some((prefix) => pathname.startsWith(prefix));
  }

  private resolveTarget(metadata: Record<string, unknown>, original: URL, podBaseUrl: string): URL | undefined {
    const baseUrl = this.extractUrl(metadata.publicAddress) ?? this.extractUrl(metadata.baseUrl);
    if (!baseUrl) {
      return undefined;
    }
    const podBase = this.extractUrl(podBaseUrl);
    if (!podBase) {
      return undefined;
    }
    const podPath = podBase.pathname.endsWith('/') ? podBase.pathname : `${podBase.pathname}/`;
    if (!original.pathname.startsWith(podPath)) {
      return undefined;
    }
    const relativePath = original.pathname.slice(podPath.length);
    const targetBase = baseUrl.href.endsWith('/') ? baseUrl.href : `${baseUrl.href}/`;
    const target = new URL(relativePath, targetBase);
    target.search = original.search;
    target.hash = original.hash;
    return target;
  }

  private extractUrl(value: unknown): URL | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    try {
      return new URL(trimmed);
    } catch {
      return undefined;
    }
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
}
