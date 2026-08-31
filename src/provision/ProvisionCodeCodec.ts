/**
 * ProvisionCodeCodec
 *
 * 自包含的 provisionCode 编解码器。
 * provisionCode 编码了 SP 的信息（publicUrl、短期 serviceAccessToken）。
 * CSS Account 创建只在资源锁外使用它准备 Local Pod；锁内只消费
 * provision receipt，不再做远程 SP 回调。
 *
 * 格式: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * 密钥: 从 baseUrl 派生，无需单独配置。
 */

import { createHmac } from 'node:crypto';

export interface ProvisionCodePayload {
  /** SP provisioning API 的回调地址；canonical storage identity 由 spDomain 决定。 */
  spUrl: string;
  /** Cloud → SP 回调认证 token，旧格式兼容字段；新代码不应写入长期 serviceToken。 */
  serviceToken?: string;
  /** Cloud → SP 回调认证的短期 access token。 */
  serviceAccessToken?: string;
  /** serviceAccessToken 过期时间 (Unix timestamp, seconds)。 */
  serviceAccessTokenExp?: number;
  /** Cloud 信令 API；Cloud 通过它发现并建立到 Local SP 的托管路由。 */
  signalApiUrl?: string;
  /** 仅用于本次 provisioning 的 Cloud 信令短期 token。 */
  routeAccessToken?: string;
  /** routeAccessToken 过期时间 (Unix timestamp, seconds)。 */
  routeAccessTokenExp?: number;
  /** SP 节点 ID（可选，用于记录） */
  nodeId?: string;
  /** Cloud 分配的子域名，如 "abc123.undefineds.site" */
  spDomain?: string;
  /** 过期时间 (Unix timestamp, seconds) */
  exp: number;
}

function normalizeProvisionBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).toString().replace(/\/+$/, '') + '/';
  } catch {
    return baseUrl.trim().replace(/\/+$/, '') + '/';
  }
}

export class ProvisionCodeCodec {
  private readonly secret: Buffer;

  /**
   * @param baseUrl — Cloud 的 baseUrl，用于派生签名密钥
   */
  public constructor(baseUrl: string) {
    const normalizedBaseUrl = normalizeProvisionBaseUrl(baseUrl);
    this.secret = Buffer.from(
      createHmac('sha256', 'xpod-provision').update(normalizedBaseUrl).digest(),
    );
  }

  /**
   * 编码 provisionCode
   */
  public encode(payload: ProvisionCodePayload): string {
    const json = JSON.stringify(payload);
    const data = Buffer.from(json, 'utf8').toString('base64url');
    const sig = this.sign(data);
    return `${data}.${sig}`;
  }

  /**
   * 解码并验证 provisionCode
   * 返回 payload，过期或签名无效则返回 undefined
   */
  public decode(code: string | undefined | null): ProvisionCodePayload | undefined {
    if (typeof code !== 'string' || code.length === 0) {
      return undefined;
    }

    const dotIndex = code.indexOf('.');
    if (dotIndex <= 0) {
      return undefined;
    }

    const data = code.slice(0, dotIndex);
    const sig = code.slice(dotIndex + 1);

    if (this.sign(data) !== sig) {
      return undefined;
    }

    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as ProvisionCodePayload;

      if (!payload.spUrl || !payload.exp || (!payload.serviceAccessToken && !payload.serviceToken)) {
        return undefined;
      }

      // 检查过期
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) {
        return undefined;
      }

      if (payload.serviceAccessToken && typeof payload.serviceAccessTokenExp !== 'number') {
        return undefined;
      }

      if (typeof payload.serviceAccessTokenExp === 'number' && payload.serviceAccessTokenExp < now) {
        return undefined;
      }

      const hasManagedRouteField = Boolean(
        payload.signalApiUrl
        || payload.routeAccessToken
        || payload.routeAccessTokenExp,
      );
      if (hasManagedRouteField && (
        !payload.nodeId
        || !payload.signalApiUrl
        || !payload.routeAccessToken
        || typeof payload.routeAccessTokenExp !== 'number'
      )) {
        return undefined;
      }

      if (typeof payload.routeAccessTokenExp === 'number' && payload.routeAccessTokenExp < now) {
        return undefined;
      }

      return payload;
    } catch {
      return undefined;
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}
