import { URL } from 'node:url';
import { getLoggerFor } from 'global-logger-factory';
import { BaseIdentifierStrategy } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import { ensureTrailingSlash } from '@solid/community-server/dist/util/PathUtil';

export interface ClusterIdentifierStrategyOptions {
  baseUrl: string;
  /**
   * 允许的额外 host 列表（用于 Docker/容器环境）
   * 可以是数组或逗号分隔的字符串，例如: ['cloud', 'idp'] 或 "cloud,idp,localhost"
   */
  allowedHosts?: string[] | string;
}

/**
 * Identifier strategy that accepts both the primary cluster host and any
 * node subdomain under the same base domain.
 */
export class ClusterIdentifierStrategy extends BaseIdentifierStrategy {
  private readonly logger = getLoggerFor(this);
  private readonly baseUrl: string;
  private readonly baseHost: string;
  private readonly allowedHosts: string[];

  public constructor(options: ClusterIdentifierStrategyOptions) {
    super();
    if (!options.baseUrl) {
      throw new Error('ClusterIdentifierStrategy requires a baseUrl.');
    }
    const parsed = new URL(options.baseUrl);
    this.baseHost = parsed.hostname.toLowerCase();
    this.baseUrl = ensureTrailingSlash(parsed.href);
    // 处理 allowedHosts：可以是数组或逗号分隔的字符串
    const hostsInput = options.allowedHosts ?? [];
    const hostsArray = Array.isArray(hostsInput)
      ? hostsInput
      : typeof hostsInput === 'string' && hostsInput.length > 0
        ? hostsInput.split(',').map(h => h.trim())
        : [];
    this.allowedHosts = hostsArray.map(h => h.toLowerCase());
    this.logger.info(`ClusterIdentifierStrategy initialized: baseUrl=${this.baseUrl}, baseHost=${this.baseHost}, allowedHosts=[${this.allowedHosts.join(', ')}]`);
  }

  public override supportsIdentifier(identifier: ResourceIdentifier): boolean {
    try {
      const target = new URL(identifier.path);
      const host = target.hostname.toLowerCase();

      // 检查是否在允许的 hosts 列表中
      if (this.allowedHosts.includes(host)) {
        this.logger.debug(`supportsIdentifier: ${identifier.path} -> true (allowedHosts match: ${host})`);
        return true;
      }

      const hostMatches = host === this.baseHost || host.endsWith(`.${this.baseHost}`);

      if (!hostMatches) {
        this.logger.debug(`supportsIdentifier: ${identifier.path} -> false (host mismatch: ${host} vs ${this.baseHost})`);
        return false;
      }

      if (host === this.baseHost) {
        const supported = identifier.path.startsWith(this.baseUrl);
        this.logger.debug(`supportsIdentifier: ${identifier.path} -> ${supported} (baseUrl check)`);
        return supported;
      }

      this.logger.debug(`supportsIdentifier: ${identifier.path} -> true (subdomain match)`);
      return true;
    } catch (error: unknown) {
      this.logger.warn(`Failed to parse identifier ${identifier.path}: ${(error as Error).message}`);
      return false;
    }
  }

  public override isRootContainer(identifier: ResourceIdentifier): boolean {
    try {
      const target = new URL(identifier.path);
      if (target.hostname.toLowerCase() === this.baseHost) {
        return ensureTrailingSlash(target.href) === this.baseUrl;
      }
      return target.pathname === '/' || target.pathname === '';
    } catch {
      return false;
    }
  }
}
