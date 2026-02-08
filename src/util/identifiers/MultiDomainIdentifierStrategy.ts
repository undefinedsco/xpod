import { getLoggerFor } from 'global-logger-factory';
import type { ResourceIdentifier } from '@solid/community-server';
import { SingleRootIdentifierStrategy } from '@solid/community-server';

/**
 * MultiDomainIdentifierStrategy - 支持多个域名的 IdentifierStrategy
 *
 * 特性：
 * 1. 支持多个 baseUrl（如 id.undefineds.co 和 pods.undefineds.co）
 * 2. 存储使用完整 URI（各域名数据独立存储）
 * 3. 适用于 Cloud 模式同时处理 WebID 和 Pod 数据
 */
export class MultiDomainIdentifierStrategy extends SingleRootIdentifierStrategy {
  protected override readonly logger = getLoggerFor(this);
  private readonly primaryBaseUrl: string;
  private readonly additionalBaseUrls: string[];

  /**
   * @param primaryBaseUrl - 主要 baseUrl（用于生成新资源路径）
   * @param additionalBaseUrls - 额外支持的 baseUrl 列表
   */
  constructor(primaryBaseUrl: string, additionalBaseUrls: string[] = []) {
    super(primaryBaseUrl);
    this.primaryBaseUrl = primaryBaseUrl;
    this.additionalBaseUrls = additionalBaseUrls;
    this.logger.info(`MultiDomainIdentifierStrategy initialized with primary: ${primaryBaseUrl}, additional: ${additionalBaseUrls.join(', ')}`);
  }

  /**
   * 检查 identifier 是否被支持（属于任一 baseUrl）
   */
  public override supportsIdentifier(identifier: ResourceIdentifier): boolean {
    const allBaseUrls = [this.primaryBaseUrl, ...this.additionalBaseUrls];
    const supported = allBaseUrls.some(baseUrl => identifier.path.startsWith(baseUrl));

    this.logger.debug(supported
      ? `Identifier ${identifier.path} is supported`
      : `Identifier ${identifier.path} is not supported by any domain`);

    return supported;
  }

  /**
   * 获取资源在存储中的相对路径（去掉域名前缀）
   */
  public getStoragePath(identifier: ResourceIdentifier): string {
    const allBaseUrls = [this.primaryBaseUrl, ...this.additionalBaseUrls];

    for (const baseUrl of allBaseUrls) {
      if (identifier.path.startsWith(baseUrl)) {
        const relativePath = identifier.path.slice(baseUrl.length);
        // 确保以 / 开头
        return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
      }
    }

    // 不匹配任何 baseUrl，返回原路径
    return identifier.path;
  }

  /**
   * 将相对路径转换为完整 URL（使用 primary baseUrl）
   */
  public getCanonicalUrl(relativePath: string): string {
    const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return `${this.primaryBaseUrl}${cleanPath}`;
  }

  /**
   * 获取主要 baseUrl
   */
  public getPrimaryBaseUrl(): string {
    return this.primaryBaseUrl;
  }

  /**
   * 获取所有支持的 baseUrls
   */
  public getAllBaseUrls(): string[] {
    return [this.primaryBaseUrl, ...this.additionalBaseUrls];
  }
}
