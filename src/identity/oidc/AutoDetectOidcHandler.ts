import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface AutoDetectOidcHandlerOptions {
  /** External account authority used by Cloud+Local provisioning metadata. */
  oidcIssuer?: string;
  /** Explanation used when this handler declines OIDC routes. */
  message?: string;
  /** @deprecated This handler does not cache or proxy OIDC metadata. */
  cacheMs?: number;
}

/**
 * Auto-detect OIDC Handler
 *
 * This component does not make Local SP the Cloud+Local OIDC issuer.
 * Cloud+Local clients obtain tokens from the configured Cloud issuer; Local is
 * only the storage/provision target. OIDC routes that still exist on this CSS
 * instance are passed through to the normal CSS handler for same-origin or
 * Standalone compatibility.
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
    this.message = options.message ?? 'OIDC route passed through to CSS OIDC handler';

    if (this.oidcIssuer) {
      this.logger.info(`Cloud+Local storage mode enabled, token issuer: ${this.oidcIssuer}; OIDC routes pass through to CSS`);
    } else {
      this.logger.info('Standard mode enabled, OIDC requests will pass through');
    }
  }

  /**
   * 判断是否处理请求
   * - Cloud+Local: do not handle OIDC here; clients use the Cloud issuer
   * - Standard/Standalone: pass through to the configured CSS OIDC handler
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
