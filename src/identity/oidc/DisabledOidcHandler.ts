import { URL } from 'node:url';
import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
  InternalServerError,
} from '@solid/community-server';

export interface DisabledOidcHandlerOptions {
  /** 外部 IdP 的 JWKS URL */
  externalJwksUrl?: string;
  /** 禁用原因说明 */
  message?: string;
  /** JWKS 缓存时间 (ms) */
  cacheMs?: number;
  /** 是否完全禁用 (不代理 JWKS) */
  fullyDisabled?: boolean;
}

interface JwksCache {
  keys: unknown[];
  expiresAt: number;
}

/**
 * Disabled OIDC Handler
 *
 * 用于 SP (Storage Provider) 模式，禁用本地 OIDC 服务端功能。
 *
 * 行为:
 * 1. 对 /.oidc/jwks 请求：代理到外部 IdP 的 JWKS (支持缓存)
 * 2. 对其他 OIDC 请求：返回 501 Not Implemented
 *
 * 这样 SP 可以验证来自外部 IdP 的 token，但不颁发 token。
 */
export class DisabledOidcHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly externalJwksUrl?: string;
  private readonly message: string;
  private readonly cacheMs: number;
  private readonly fullyDisabled: boolean;
  private jwksCache?: JwksCache;

  constructor(options: DisabledOidcHandlerOptions = {}) {
    super();
    this.externalJwksUrl = options.externalJwksUrl;
    this.message = options.message ?? 'OIDC disabled in storage provider mode';
    this.cacheMs = options.cacheMs ?? 300000; // 默认 5 分钟
    this.fullyDisabled = options.fullyDisabled ?? false;

    if (!this.fullyDisabled && !this.externalJwksUrl) {
      this.logger.warn('DisabledOidcHandler: no externalJwksUrl provided, JWKS proxy will fail');
    }
  }

  /**
   * 只处理 OIDC 相关的请求路径
   */
  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const url = request.url ?? '';

    // 检查是否是 OIDC 路径
    if (!this.isOidcPath(url)) {
      throw new NotImplementedHttpError('Not an OIDC request');
    }

    // 完全禁用模式下，所有 OIDC 请求都不处理
    if (this.fullyDisabled) {
      throw new NotImplementedHttpError(this.message);
    }

    // 只有 JWKS 请求可以处理
    if (!this.isJwksPath(url)) {
      throw new NotImplementedHttpError(
        `External IdP mode: ${this.message}. Authentication handled by external IdP.`
      );
    }

    // JWKS 请求但没有配置外部 URL
    if (!this.externalJwksUrl) {
      throw new InternalServerError('JWKS proxy not configured');
    }
  }

  /**
   * 处理 JWKS 代理请求
   */
  public override async handle({ response }: HttpHandlerInput): Promise<void> {
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

    if (!this.externalJwksUrl) {
      throw new Error('External JWKS URL not configured');
    }

    this.logger.debug(`Fetching JWKS from ${this.externalJwksUrl}`);

    const res = await fetch(this.externalJwksUrl, {
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
