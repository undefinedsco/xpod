/**
 * ProvisionCodeCodec
 *
 * 自包含的 provisionCode 编解码器。
 * provisionCode 编码了 SP 的信息（publicUrl、serviceToken），
 * CSS 侧解码后直接回调 SP，不需要查数据库。
 *
 * 格式: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * 密钥: 从 baseUrl 派生，无需单独配置。
 */

import { createHmac } from 'node:crypto';

export interface ProvisionCodePayload {
  /** SP 的公网地址 */
  spUrl: string;
  /** Cloud → SP 回调认证 token */
  serviceToken: string;
  /** SP 节点 ID（可选，用于记录） */
  nodeId?: string;
  /** Cloud 分配的子域名，如 "abc123.undefineds.site" */
  spDomain?: string;
  /** 过期时间 (Unix timestamp, seconds) */
  exp: number;
}

export class ProvisionCodeCodec {
  private readonly secret: Buffer;

  /**
   * @param baseUrl — Cloud 的 baseUrl，用于派生签名密钥
   */
  public constructor(baseUrl: string) {
    this.secret = Buffer.from(
      createHmac('sha256', 'xpod-provision').update(baseUrl).digest(),
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

      if (!payload.spUrl || !payload.serviceToken || !payload.exp) {
        return undefined;
      }

      // 检查过期
      if (payload.exp < Math.floor(Date.now() / 1000)) {
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
