import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface AutoDetectOidcHandlerOptions {
  /** External account authority used by Local SP mode. It must not provide local OIDC JWKS. */
  oidcIssuer?: string;
  /** Explanation used when this handler declines OIDC routes. */
  message?: string;
  /** @deprecated Local OIDC routes must pass through to CSS; this value is ignored. */
  cacheMs?: number;
}

/**
 * Auto-detect OIDC Handler
 *
 * 自动检测运行模式：
 * - 如果配置了 oidcIssuer -> Local SP 模式：OIDC discovery/token/JWKS 仍全部由本地 CSS 处理
 * - 如果没有配置 oidcIssuer -> 标准模式：所有 OIDC 请求透传（由 CSS 默认 Handler 处理）
 *
 * 注意：Local SP 模式不能禁用本地 account/consent。OIDC 交互页面和
 * scoped WebID picker 必须继续由本地 CSS 提供。Cloud 只作为账号密码校验和
 * Cloud WebID/profile 权威；本地 CSS 颁发的 token 必须由本地 JWKS 验证。
 *
 * 使用方式：在 HTTP pipeline 中替换默认的 OidcHandler
 */
export class AutoDetectOidcHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly oidcIssuer?: string;
  private readonly message: string;

  constructor(options: AutoDetectOidcHandlerOptions = {}) {
    super();
    this.oidcIssuer = options.oidcIssuer;
    this.message = options.message ?? 'OIDC route handled by local CSS OIDC handler';

    if (this.oidcIssuer) {
      this.logger.info(`Local SP mode enabled, account issuer: ${this.oidcIssuer}; OIDC routes pass through to local CSS`);
    } else {
      this.logger.info('Standard mode enabled, OIDC requests will pass through');
    }
  }

  /**
   * 判断是否处理请求
   * - Local SP 模式：所有 OIDC 请求透传给 CSS 本地 OIDC handler
   * - 标准模式：不处理任何请求（透传给 CSS 默认 Handler）
   */
  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const url = request.url ?? '';

    // 检查是否是 OIDC 路径
    if (!this.isOidcPath(url)) {
      throw new NotImplementedHttpError('Not an OIDC request');
    }

    throw new NotImplementedHttpError(this.message);
  }

  /**
   * 处理请求：该 handler 只用于显式透传，不应实际处理 OIDC 请求。
   */
  public override async handle(): Promise<void> {
    throw new NotImplementedHttpError(this.message);
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
