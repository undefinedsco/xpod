import { createSolidTokenVerifier } from '@solid/access-token-verifier';
import { getLoggerFor } from 'global-logger-factory';
import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, HttpRequest, HttpResponse } from '@solid/community-server';
import {
  BadRequestHttpError,
  ForbiddenHttpError,
  MethodNotAllowedHttpError,
  NotImplementedHttpError,
  UnauthorizedHttpError,
} from '@solid/community-server';
import { getIdentityDatabase } from '../../identity/drizzle/db';
import { AccountRepository } from '../../identity/drizzle/AccountRepository';
import { AccountRoleRepository } from '../../identity/drizzle/AccountRoleRepository';
import type { AccountQuota, QuotaService } from '../../quota/QuotaService';

interface QuotaAdminHttpHandlerOptions {
  identityDbUrl: string;
  basePath?: string;
  roleRepository?: AccountRoleRepository;
  quotaService: QuotaService;
}

type QuotaTarget =
  | { type: 'account'; id: string }
  | { type: 'pod'; id: string };

export class QuotaAdminHttpHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly verify = createSolidTokenVerifier();
  private readonly accountRepo: AccountRepository;
  private readonly roleRepo: AccountRoleRepository;
  private readonly quotaService: QuotaService;
  private readonly basePath: string;

  public constructor(options: QuotaAdminHttpHandlerOptions) {
    super();
    const db = getIdentityDatabase(options.identityDbUrl);
    this.accountRepo = new AccountRepository(db);
    this.roleRepo = options.roleRepository ?? new AccountRoleRepository(db);
    this.basePath = options.basePath ?? '/api/quota/';
    this.quotaService = options.quotaService;
  }

  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const path = this.getUrl(request).pathname;
    if (!path.startsWith(this.basePath)) {
      throw new NotImplementedHttpError('Not a quota admin request.');
    }
  }

  public override async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      this.writeOptions(response);
      return;
    }

    if (![ 'GET', 'PUT', 'DELETE' ].includes(method)) {
      throw new MethodNotAllowedHttpError([ 'GET', 'PUT', 'DELETE', 'OPTIONS' ]);
    }

    await this.authenticateAdmin(request);

    const target = this.parseTarget(this.getUrl(request).pathname);

    switch (method) {
      case 'GET':
        await this.handleGet(target, response);
        break;
      case 'PUT':
        await this.handlePut(target, request, response);
        break;
      case 'DELETE':
        await this.handleDelete(target, response);
        break;
    }
  }

  private async handleGet(target: QuotaTarget, response: HttpResponse): Promise<void> {
    if (target.type === 'account') {
      const quota = await this.quotaService.getAccountQuota(target.id);
      this.writeJson(response, 200, {
        type: 'account',
        accountId: target.id,
        quota,
      });
      return;
    }

    const podInfo = await this.accountRepo.getPodInfo(target.id);
    if (!podInfo) {
      throw new BadRequestHttpError('Unknown pod identifier.');
    }
    const quota = await this.quotaService.getPodQuota(target.id);
    this.writeJson(response, 200, {
      type: 'pod',
      podId: target.id,
      accountId: podInfo.accountId,
      baseUrl: podInfo.baseUrl ?? null,
      quota,
    });
  }

  private async handlePut(target: QuotaTarget, request: HttpRequest, response: HttpResponse): Promise<void> {
    const body = await this.readJson(request);
    if (body == null || typeof body !== 'object') {
      throw new BadRequestHttpError('Request body must be an object.');
    }
    const payload = body as Record<string, unknown>;
    const quota = this.extractQuota(payload);

    if (target.type === 'pod') {
      const podInfo = await this.accountRepo.getPodInfo(target.id);
      if (!podInfo) {
        throw new BadRequestHttpError('Unknown pod identifier.');
      }
    }

    if (target.type === 'account') {
      await this.quotaService.setAccountQuota(target.id, quota);
      const latest = await this.quotaService.getAccountQuota(target.id);
      this.writeJson(response, 200, {
        status: 'updated',
        targetType: target.type,
        targetId: target.id,
        quota: latest,
      });
      return;
    }

    await this.quotaService.setPodQuota(target.id, quota);
    const latest = await this.quotaService.getPodQuota(target.id);

    this.writeJson(response, 200, {
      status: 'updated',
      targetType: target.type,
      targetId: target.id,
      quota: latest,
    });
  }

  private async handleDelete(target: QuotaTarget, response: HttpResponse): Promise<void> {
    if (target.type === 'pod') {
      const podInfo = await this.accountRepo.getPodInfo(target.id);
      if (!podInfo) {
        throw new BadRequestHttpError('Unknown pod identifier.');
      }
    }

    if (target.type === 'account') {
      await this.quotaService.clearAccountQuota(target.id);
    } else {
      await this.quotaService.clearPodQuota(target.id);
    }
    this.writeJson(response, 200, {
      status: 'cleared',
      targetType: target.type,
      targetId: target.id,
    });
  }

  private async authenticateAdmin(request: HttpRequest): Promise<void> {
    const authorization = request.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new UnauthorizedHttpError('Quota管理接口需要携带 Bearer Token。');
    }
    let payload: Record<string, unknown>;
    try {
      payload = await this.verify(authorization) as unknown as Record<string, unknown>;
    } catch (error: unknown) {
      throw new UnauthorizedHttpError('无法验证访问令牌。', { cause: error });
    }
    const webId = this.extractWebId(payload);
    if (!webId) {
      throw new UnauthorizedHttpError('访问令牌缺少 webid。');
    }
    const context = await this.roleRepo.findByWebId(webId);
    if (!context || !context.roles.includes('admin')) {
      throw new ForbiddenHttpError('仅限管理员修改配额。');
    }
  }

  private parseTarget(pathname: string): QuotaTarget {
    const relative = pathname.slice(this.basePath.length);
    const segments = relative.split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new BadRequestHttpError('Quota path must match /accounts/{id} or /pods/{id}.');
    }
    const [ scope, identifier ] = segments;
    if (!identifier) {
      throw new BadRequestHttpError('Missing identifier.');
    }
    if (scope === 'accounts') {
      return { type: 'account', id: decodeURIComponent(identifier) };
    }
    if (scope === 'pods') {
      return { type: 'pod', id: decodeURIComponent(identifier) };
    }
    throw new BadRequestHttpError('Unknown quota scope.');
  }

  private async readJson(request: HttpRequest): Promise<unknown> {
    const body = await this.readBody(request);
    if (!body) {
      return undefined;
    }
    try {
      return JSON.parse(body);
    } catch (error: unknown) {
      throw new BadRequestHttpError('Body must contain valid JSON.', { cause: error });
    }
  }

  private extractQuota(body: Record<string, unknown>): Partial<AccountQuota> {
    const quota: Partial<AccountQuota> = {};
    let hasQuotaField = false;
    for (const field of [ 'storageLimitBytes', 'bandwidthLimitBps', 'computeLimitSeconds', 'tokenLimitMonthly' ] as const) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) {
        continue;
      }
      const value = body[field];
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new BadRequestHttpError(`${field} must be a non-negative number or null.`);
      }
      quota[field] = value;
      hasQuotaField = true;
    }
    if (!hasQuotaField) {
      throw new BadRequestHttpError('Body must include at least one quota field.');
    }
    return quota;
  }

  private writeOptions(response: HttpResponse): void {
    response.statusCode = 204;
    response.setHeader('Allow', 'GET,PUT,DELETE,OPTIONS');
    response.end();
  }

  private writeJson(response: HttpResponse, status: number, payload: unknown): void {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(payload));
  }

  private async readBody(request: HttpRequest): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let data = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        data += chunk;
      });
      request.on('end', () => resolve(data));
      request.on('error', reject);
    });
  }

  private getUrl(request: HttpRequest): URL {
    const hostHeader = request.headers.host ?? request.headers.Host ?? 'localhost';
    const protoHeader = request.headers['x-forwarded-proto'] ?? request.headers['X-Forwarded-Proto'];
    const protocol = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    const scheme = typeof protocol === 'string' ? protocol.split(',')[0]?.trim() ?? 'http' : 'http';
    const rawUrl = request.url ?? '/';
    return new URL(rawUrl, `${scheme}://${hostHeader}`);
  }

  private extractWebId(payload: Record<string, unknown>): string | undefined {
    const getString = (key: string): string | undefined => {
      const value = payload[key];
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };
    const direct = getString('webid') ?? getString('webId') ?? getString('sub');
    if (direct) {
      return direct;
    }
    const clientId = getString('client_id');
    if (clientId && clientId.startsWith('https://')) {
      return clientId;
    }
    return undefined;
  }
}
