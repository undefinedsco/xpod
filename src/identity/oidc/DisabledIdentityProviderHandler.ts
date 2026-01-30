import { getLoggerFor } from 'global-logger-factory';
import {
  HttpHandler,
  type HttpHandlerInput,
  NotImplementedHttpError,
} from '@solid/community-server';

export interface DisabledIdentityProviderHandlerOptions {
  /** 禁用原因说明 */
  message?: string;
  /** 是否保留某些只读端点 */
  allowReadOnly?: boolean;
}

/**
 * Disabled Identity Provider Handler
 *
 * 用于 SP (Storage Provider) 模式，禁用本地账户管理功能。
 *
 * 行为:
 * - 拒绝所有账户注册请求
 * - 拒绝所有登录请求
 * - 拒绝所有密码重置请求
 * - 可选：保留某些只读端点（如账户信息查询）
 *
 * 这样用户必须通过外部 IdP 进行身份验证，SP 只负责存储。
 */
export class DisabledIdentityProviderHandler extends HttpHandler {
  private readonly logger = getLoggerFor(this);
  private readonly message: string;
  private readonly allowReadOnly: boolean;

  // 账户管理相关路径
  private readonly identityPaths = [
    '/idp/',
    '/account/',
    '/login',
    '/logout',
    '/register',
    '/reset-password',
    '/forgot-password',
    '/.account/',
  ];

  // 只读路径（如果 allowReadOnly 为 true）
  private readonly readOnlyPaths = [
    '/account/info',
    '/account/profile',
  ];

  constructor(options: DisabledIdentityProviderHandlerOptions = {}) {
    super();
    this.message = options.message ?? 'Account management handled by external IdP';
    this.allowReadOnly = options.allowReadOnly ?? false;
    this.logger.info(`Initialized: ${this.message}`);
  }

  /**
   * 处理账户管理请求
   *
   * 默认拒绝所有请求，返回 501 Not Implemented
   */
  public override async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const url = request.url ?? '';
    const method = request.method ?? 'GET';

    // 检查是否是账户管理路径
    if (!this.isIdentityPath(url)) {
      throw new NotImplementedHttpError('Not an identity management request');
    }

    // 如果是只读路径且允许只读
    if (this.allowReadOnly && this.isReadOnlyPath(url) && method === 'GET') {
      // 继续处理（抛出 NotImplemented，因为 SP 模式下不支持查询账户信息）
      throw new NotImplementedHttpError(
        `${this.message}. Account queries not supported in SP mode.`
      );
    }

    // 拒绝所有账户管理请求
    throw new NotImplementedHttpError(
      `${this.message}. Please use the external IdP for authentication.`
    );
  }

  /**
   * handle 方法理论上不会被执行，因为 canHandle 总是抛出异常
   * 但为了完整性，保留此方法
   */
  public override async handle({ response }: HttpHandlerInput): Promise<void> {
    this.logger.warn('DisabledIdentityProviderHandler.handle() should not be called');

    response.statusCode = 501;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      error: 'not_implemented',
      message: this.message,
      hint: 'This is a Storage Provider (SP). Please authenticate with the external IdP.'
    }));
  }

  /**
   * 检查是否是账户管理路径
   */
  private isIdentityPath(url: string): boolean {
    const pathname = this.getPathname(url);
    return this.identityPaths.some(path => pathname.startsWith(path));
  }

  /**
   * 检查是否是只读路径
   */
  private isReadOnlyPath(url: string): boolean {
    const pathname = this.getPathname(url);
    return this.readOnlyPaths.some(path => pathname.startsWith(path));
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
