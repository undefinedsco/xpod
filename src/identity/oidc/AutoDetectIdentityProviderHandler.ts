import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface AutoDetectIdentityProviderHandlerOptions {
  /** 外部 IdP 的基础 URL，如果提供则启用 SP 模式 */
  idpUrl?: string;
  /** 禁用时的消息 */
  message?: string;
  /** CSS 默认的 IdentityProviderHandler，标准模式下委托给它 */
  source?: HttpHandler;
}

/**
 * Auto-detect Identity Provider Handler
 *
 * 自动检测运行模式：
 * - 如果配置了 idpUrl -> SP 模式：禁用本地账户管理
 * - 如果没有配置 idpUrl -> 标准模式：委托给 CSS 默认 Handler
 */
export class AutoDetectIdentityProviderHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly idpUrl?: string;
  private readonly message: string;
  private readonly source?: HttpHandler;

  constructor(options: AutoDetectIdentityProviderHandlerOptions = {}) {
    super();
    this.idpUrl = options.idpUrl;
    this.message = options.message ?? 'Account management handled by external IdP';
    this.source = options.source;

    if (this.idpUrl) {
      this.logger.info(`SP mode enabled: ${this.message}, external IdP: ${this.idpUrl}`);
    } else {
      this.logger.info('Standard mode enabled, delegating to source IdentityProviderHandler');
    }
  }

  /**
   * 判断是否处理请求
   * - SP 模式：拒绝所有 IdP 请求
   * - 标准模式：委托给 source Handler
   */
  public override async canHandle(input: HttpHandlerInput): Promise<void> {
    const url = input.request.url ?? '';

    // 检查是否是 IdP 路径
    if (!this.isIdpPath(url)) {
      throw new NotImplementedHttpError('Not an IdP request');
    }

    // SP 模式：拒绝所有 IdP 请求
    if (this.idpUrl) {
      throw new NotImplementedHttpError(
        `External IdP mode: ${this.message}. Please use the external identity provider.`
      );
    }

    // 标准模式：委托给 source Handler
    if (this.source) {
      await this.source.canHandle(input);
    } else {
      throw new NotImplementedHttpError('No source IdentityProviderHandler configured');
    }
  }

  /**
   * 处理请求
   * - SP 模式：不应该到达这里
   * - 标准模式：委托给 source Handler
   */
  public override async handle(input: HttpHandlerInput): Promise<void> {
    if (this.idpUrl) {
      // SP 模式下不应该到达这里
      throw new NotImplementedHttpError(
        `External IdP mode: ${this.message}. Please use the external identity provider.`
      );
    }

    // 标准模式：委托给 source Handler
    if (this.source) {
      await this.source.handle(input);
    } else {
      throw new NotImplementedHttpError('No source IdentityProviderHandler configured');
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
