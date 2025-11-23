import { URL } from 'node:url';
import { getLoggerFor, BaseIdentifierStrategy } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import { ensureTrailingSlash } from '@solid/community-server/dist/util/PathUtil';

export interface ClusterIdentifierStrategyOptions {
  baseUrl: string;
}

/**
 * Identifier strategy that accepts both the primary cluster host and any
 * node subdomain under the same base domain.
 */
export class ClusterIdentifierStrategy extends BaseIdentifierStrategy {
  private readonly logger = getLoggerFor(this);
  private readonly baseUrl: string;
  private readonly baseHost: string;

  public constructor(options: ClusterIdentifierStrategyOptions) {
    super();
    if (!options.baseUrl) {
      throw new Error('ClusterIdentifierStrategy requires a baseUrl.');
    }
    const parsed = new URL(options.baseUrl);
    this.baseHost = parsed.hostname.toLowerCase();
    this.baseUrl = ensureTrailingSlash(parsed.href);
  }

  public override supportsIdentifier(identifier: ResourceIdentifier): boolean {
    try {
      const target = new URL(identifier.path);
      const host = target.hostname.toLowerCase();
      const hostMatches = host === this.baseHost || host.endsWith(`.${this.baseHost}`);

      if (!hostMatches) {
        this.logger.debug(`Identifier ${identifier.path} rejected: host ${host} not within ${this.baseHost}`);
        return false;
      }

      if (host === this.baseHost) {
        const supported = identifier.path.startsWith(this.baseUrl);
        this.logger.debug(supported ?
          `Identifier ${identifier.path} accepted under base URL ${this.baseUrl}` :
          `Identifier ${identifier.path} rejected: outside base URL ${this.baseUrl}`);
        return supported;
      }

      this.logger.debug(`Identifier ${identifier.path} accepted as subdomain of ${this.baseHost}`);
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
