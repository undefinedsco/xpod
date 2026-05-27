import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface AutoDetectIdentityProviderHandlerOptions {
  /** 外部 IdP 的基础 URL，如果提供则启用 Local SP mode. */
  oidcIssuer?: string;
  /** Message used when no source handler is available. */
  message?: string;
  /** CSS IdentityProviderHandler that owns account, consent and WebID selection routes. */
  source?: HttpHandler;
}

/**
 * Auto-detect Identity Provider Handler
 *
 * Local SP mode still needs the local `/.account/*` surface: CSS keeps the
 * OIDC interaction and the scoped WebID picker here, while token validation can
 * trust the configured external issuer. Disabling this surface makes LinX fall
 * back to the Cloud issuer and lets Cloud Pods leak into a Local login flow.
 */
export class AutoDetectIdentityProviderHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly oidcIssuer?: string;
  private readonly message: string;
  private readonly source?: HttpHandler;

  constructor(options: AutoDetectIdentityProviderHandlerOptions = {}) {
    super();
    this.oidcIssuer = options.oidcIssuer;
    this.message = options.message ?? 'No source IdentityProviderHandler configured';
    this.source = options.source;

    if (this.oidcIssuer) {
      this.logger.info(`Local SP mode enabled: account and consent routes stay local, external issuer: ${this.oidcIssuer}`);
    } else {
      this.logger.info('Standard mode enabled: delegating identity routes to source IdentityProviderHandler');
    }
  }

  /**
   * 判断是否处理请求
   * - Local SP mode: delegate local account/consent routes to source Handler
   * - Standard mode: delegate to source Handler
   */
  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    const url = input.request.url ?? '';

    // 检查是否是 IdP 路径
    if (!this.isIdpPath(url)) {
      throw new NotImplementedHttpError('Not an IdP request');
    }

    if (this.source) {
      await this.source.canHandle(input);
    } else {
      throw new NotImplementedHttpError(this.message);
    }
  }

  /**
   * 处理请求
   * - Local SP mode: delegate to source Handler so consent remains scoped by SP
   * - Standard mode: delegate to source Handler
   */
  public override async handle(input: HttpHandlerInput): Promise<void> {
    if (this.source) {
      await this.source.handle(input);
    } else {
      throw new NotImplementedHttpError(this.message);
    }
  }

  /**
   * 检查是否是 IdP 路径
   */
  private isIdpPath(url: string): boolean {
    const pathname = this.getPathname(url);
    return (
      pathname.startsWith('/idp/') ||
      pathname.startsWith('/.account/') ||
      pathname === '/register' ||
      pathname === '/login' ||
      pathname === '/logout'
    );
  }

  /**
   * 从 URL 提取 pathname
   */
  private getPathname(url: string): string {
    try {
      return new URL(url, 'http://localhost').pathname;
    } catch {
      return url.split('?')[0];
    }
  }
}
