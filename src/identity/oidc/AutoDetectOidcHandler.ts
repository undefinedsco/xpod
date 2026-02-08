import { URL } from 'node:url';
import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
  InternalServerError,
} from '@solid/community-server';

export interface AutoDetectOidcHandlerOptions {
  /** 外部 IdP 的基础 URL，如果提供则启用 SP 模式 */
  idpUrl?: string;
  /** 禁用原因说明 */
  message?: string;
  /** JWKS 缓存时间 (ms) */
  cacheMs?: number;
}

interface JwksCache {
  keys: unknown[];
  expiresAt: number;
}

/**
 * Auto-detect OIDC Handler
 *
 * 自动检测运行模式：
 * - 如果配置了 idpUrl -> SP 模式：禁用本地 OIDC，代理外部 IdP 的 JWKS
 * - 如果没有配置 idpUrl -> 标准模式：所有 OIDC 请求透传（由 CSS 默认 Handler 处理）
 *
 * 使用方式：在 HTTP pipeline 中替换默认的 OidcHandler
 */
export class AutoDetectOidcHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly idpUrl?: string;
  private readonly jwksUrl?: string;
  private readonly message: string;
  private readonly cacheMs: number;
  private jwksCache?: JwksCache;

  constructor(options: AutoDetectOidcHandlerOptions = {}) {
    super();
    this.idpUrl = options.idpUrl;
    this.jwksUrl = this.idpUrl ? `${this.idpUrl.replace(/\/$/, '')}/.oidc/jwks` : undefined;
    this.message = options.message ?? 'OIDC disabled in storage provider mode';
    this.cacheMs = options.cacheMs ?? 300000; // 默认 5 分钟

    if (this.idpUrl) {
      this.logger.info(`SP mode enabled, external IdP: ${this.idpUrl}, JWKS: ${this.jwksUrl}`);
    } else {
      this.logger.info('Standard mode enabled, OIDC requests will pass through');
    }
  }

  /**
   * 判断是否处理请求
   * - SP 模式：只处理 JWKS 请求，其他 OIDC 请求返回 501
   * - 标准模式：不处理任何请求（透传给 CSS 默认 Handler）
   */
  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const url = request.url ?? '';

    // 检查是否是 OIDC 路径
    if (!this.isOidcPath(url)) {
      throw new NotImplementedHttpError('Not an OIDC request');
    }

    // 标准模式：不处理，透传给 CSS 默认 Handler
    if (!this.jwksUrl) {
      throw new NotImplementedHttpError('Pass through to default OIDC handler');
    }

    // SP 模式：只有 JWKS 请求可以处理
    if (!this.isJwksPath(url)) {
      throw new NotImplementedHttpError(
        `External IdP mode: ${this.message}. Authentication handled by external IdP.`
      );
    }
  }

  /**
   * 处理请求
   * - SP 模式：代理 JWKS
   * - 标准模式：不应该到达这里
   */
  public override async handle({ response }: HttpHandlerInput): Promise<void> {
    // 标准模式：不应该到达这里
    if (!this.jwksUrl) {
      throw new InternalServerError('AutoDetectOidcHandler should not handle requests in standard mode');
    }

    try {
      const jwks = await this.fetchJwks();

      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', `public, max-age=${Math.floor(this.cacheMs / 1000)}`);
      response.end(JSON.stringify(jwks));

      this.logger.debug('JWKS proxy successful');
    } catch (error) {
      this.logger.error(`JWKS proxy failed: ${(error as Error).message}`);
      throw new InternalServerError('Failed to proxy JWKS request', { cause: error });
    }
  }

  /**
   * 获取并缓存 JWKS
   */
  private async fetchJwks(): Promise<{ keys: unknown[] }> {
    // 检查缓存
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) {
      this.logger.debug('Returning cached JWKS');
      return { keys: this.jwksCache.keys };
    }

    if (!this.jwksUrl) {
      throw new Error('External JWKS URL not configured');
    }

    this.logger.debug(`Fetching JWKS from ${this.jwksUrl}`);

    const res = await fetch(this.jwksUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch JWKS: ${res.status} ${res.statusText}`);
    }

    const jwks = await res.json() as { keys: unknown[] };

    // 验证 JWKS 格式
    if (!Array.isArray(jwks.keys)) {
      throw new Error('Invalid JWKS format: missing keys array');
    }

    // 更新缓存
    this.jwksCache = {
      keys: jwks.keys,
      expiresAt: Date.now() + this.cacheMs,
    };

    this.logger.debug(`JWKS cached with ${jwks.keys.length} keys`);
    return jwks;
  }

  /**
   * 检查是否是 OIDC 路径
   */
  private isOidcPath(url: string): boolean {
    const pathname = this.getPathname(url);
    return (
      pathname.startsWith('/.oidc/') ||
      pathname === '/.well-known/openid-configuration' ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname.startsWith('/idp/')
    );
  }

  /**
   * 检查是否是 JWKS 路径
   */
  private isJwksPath(url: string): boolean {
    const pathname = this.getPathname(url);
    return pathname === '/.oidc/jwks' || pathname === '/.oidc/jwks.json';
  }

  /**
   * 从 URL 提取 pathname
   */
  private getPathname(url: string): string {
    try {
      return new URL(url, 'http://localhost').pathname;
    } catch {
      // 如果解析失败，直接返回 url（可能是相对路径）
      return url.split('?')[0];
    }
  }
}
