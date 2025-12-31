import type { IncomingMessage } from 'node:http';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput } from '@solid/community-server';
import {
  BadRequestHttpError,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  UnauthorizedHttpError,
  InternalServerError,
  
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { EdgeNodeRepository } from '../../identity/drizzle/EdgeNodeRepository';
import { EdgeNodeCertificateService } from '../../service/EdgeNodeCertificateService';

interface EdgeNodeCertificateHttpHandlerOptions {
  identityDbUrl: string;
  edgeNodesEnabled?: string | boolean;
  repository?: EdgeNodeRepository;
  certificateService: EdgeNodeCertificateService;
  basePath?: string;
}

interface CertificateRequestPayload {
  nodeId: string;
  token: string;
  csr: string;
}

export class EdgeNodeCertificateHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly repo: EdgeNodeRepository;
  private readonly basePath: string;
  private readonly basePathWithSlash: string;
  private readonly enabled: boolean;
  private readonly service: EdgeNodeCertificateService;

  public constructor(options: EdgeNodeCertificateHttpHandlerOptions) {
    super();
    this.repo = options.repository ?? new EdgeNodeRepository(getIdentityDatabase(options.identityDbUrl));
    this.service = options.certificateService;
    this.basePath = this.normalizeBasePath(options.basePath ?? '/api/signal/certificate');
    this.basePathWithSlash = `${this.basePath}/`;
    this.enabled = this.normalizeBoolean(options.edgeNodesEnabled);
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    if (!this.enabled) {
      throw new NotImplementedHttpError('Edge node certificates are disabled.');
    }
    const pathname = this.parseUrl(request).pathname;
    if (!this.matchesBase(pathname)) {
      throw new NotImplementedHttpError('Not an edge node certificate request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }
    if (method !== 'POST') {
      throw new MethodNotAllowedHttpError([ 'POST', 'OPTIONS' ]);
    }

    const url = this.parseUrl(request);
    const relative = this.toRelative(url.pathname);
    if (relative !== '') {
      throw new NotImplementedHttpError('Unknown certificate endpoint.');
    }

    const payload = await this.readPayload(request);
    const secret = await this.repo.getNodeSecret(payload.nodeId);
    if (!secret || !secret.tokenHash || !this.repo.matchesToken(secret.tokenHash, payload.token)) {
      throw new UnauthorizedHttpError('Edge node authentication failed.');
    }

    const connectivity = await this.repo.getNodeConnectivityInfo(payload.nodeId);
    const subdomain = this.extractSubdomain(connectivity?.subdomain, secret.metadata);
    if (!subdomain) {
      throw new BadRequestHttpError('Node has no assigned subdomain; cannot issue certificate.');
    }

    try {
      const issued = await this.service.issueCertificate({
        nodeId: payload.nodeId,
        csr: payload.csr,
        subdomain,
      });

      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({
        status: 'issued',
        certificate: {
          pem: issued.certificate,
          fullChain: issued.fullChain,
          expiresAt: issued.expiresAt,
          domains: issued.domains,
        },
      }));
    } catch (error: unknown) {
      this.logger.error(`Failed to issue certificate for node ${payload.nodeId}: ${(error as Error).message}`);
      throw new InternalServerError('Failed to issue certificate.', { cause: error });
    }
  }

  private async readPayload(request: IncomingMessage): Promise<CertificateRequestPayload> {
    const body = await this.readBody(request);
    if (!body) {
      throw new BadRequestHttpError('请求体不能为空。');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error: unknown) {
      throw new BadRequestHttpError('请求体必须是有效 JSON。', { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new BadRequestHttpError('请求体必须是 JSON 对象。');
    }
    const record = parsed as Record<string, unknown>;
    const nodeId = this.requireString(record.nodeId, 'nodeId');
    const token = this.requireString(record.token, 'token');
    const csr = this.requireString(record.csr, 'csr');
    return { nodeId, token, csr };
  }

  private extractSubdomain(connectivitySubdomain?: string, metadata?: Record<string, unknown> | null): string | undefined {
    if (typeof connectivitySubdomain === 'string' && connectivitySubdomain.trim().length > 0) {
      return connectivitySubdomain.trim();
    }
    const meta = metadata ?? undefined;
    if (meta && typeof meta === 'object' && typeof meta.subdomain === 'string') {
      const trimmed = meta.subdomain.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        data += chunk;
      });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
  }

  private writeOptions(response: any): void {
    response.statusCode = 204;
    response.setHeader('Allow', 'POST,OPTIONS');
    response.end();
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
      throw new BadRequestHttpError(`${field} 必须是字符串。`);
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestHttpError(`${field} 不能为空。`);
    }
    return trimmed;
  }

  private matchesBase(pathname: string): boolean {
    return pathname === this.basePath || pathname.startsWith(this.basePathWithSlash);
  }

  private toRelative(pathname: string): string | null {
    if (pathname === this.basePath) {
      return '';
    }
    if (!pathname.startsWith(this.basePathWithSlash)) {
      return null;
    }
    return pathname.slice(this.basePathWithSlash.length);
  }

  private parseUrl(request: IncomingMessage): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  private normalizeBasePath(input: string): string {
    if (!input.startsWith('/')) {
      throw new BadRequestHttpError('Certificate base path must start with /.');
    }
    return input.endsWith('/') ? input.slice(0, -1) : input;
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
