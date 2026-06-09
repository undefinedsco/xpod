import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface AutoDetectIdentityProviderHandlerOptions {
  /** External account authority used by Cloud+Local provisioning metadata. */
  oidcIssuer?: string;
  /** Message used when no source handler is available. */
  message?: string;
  /** CSS IdentityProviderHandler that owns account, consent and WebID selection routes. */
  source?: HttpHandler;
}

/**
 * Auto-detect Identity Provider Handler
 *
 * This handler only keeps CSS identity/account pages wired when they are
 * intentionally opened on this server. It does not make Local SP the token
 * issuer for Cloud+Local. LinX Cloud+Local login uses Cloud as OIDC issuer and
 * carries provision scope so storage selection stays bound to the selected SP.
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
      this.logger.info(`Cloud+Local storage mode enabled: external token issuer ${this.oidcIssuer}`);
    } else {
      this.logger.info('Standard mode enabled: delegating identity routes to source IdentityProviderHandler');
    }
  }

  /**
   * 判断是否处理请求
   * - Cloud+Local/standard/standalone: delegate account routes to source Handler
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
   * - Cloud+Local/standard/standalone: delegate to source Handler
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
