import { URL } from 'node:url';
import { getLoggerFor } from 'global-logger-factory';
import { BaseIdentifierStrategy } from '@solid/community-server';
import type { ResourceIdentifier } from '@solid/community-server';
import { ensureTrailingSlash } from '@solid/community-server/dist/util/PathUtil';

export interface SubdomainPodIdentifierStrategyOptions {
  /** 基础域名，如 pods.undefineds.site */
  baseDomain: string;
}

/**
 * Subdomain Pod Identifier Strategy
 *
 * 支持格式: {node-id}.baseDomain/{pod-name}/resource
 *
 * 示例:
 * - https://node1.pods.undefineds.site/alice/data.ttl
 * - https://node1.pods.undefineds.site/bob/profile/card
 *
 * 路径结构:
 * - /{pod-name}/ 表示一个 Pod 的根容器
 * - /{pod-name}/resource 表示 Pod 内的资源
 */
export class SubdomainPodIdentifierStrategy extends BaseIdentifierStrategy {
  private readonly logger = getLoggerFor(this);
  private readonly baseDomain: string;

  public constructor(options: SubdomainPodIdentifierStrategyOptions) {
    super();
    if (!options.baseDomain) {
      throw new Error('SubdomainPodIdentifierStrategy requires a baseDomain.');
    }
    this.baseDomain = options.baseDomain.toLowerCase();
    this.logger.info(`Initialized with baseDomain: ${this.baseDomain}`);
  }

  /**
   * 检查 identifier 是否被支持
   *
   * 条件:
   * 1. hostname 必须匹配 *.baseDomain
   * 2. 路径必须以 /{pod-name}/ 开头
   */
  public override supportsIdentifier(identifier: ResourceIdentifier): boolean {
    try {
      const target = new URL(identifier.path);
      const hostname = target.hostname.toLowerCase();

      // 必须匹配 *.baseDomain
      if (!hostname.endsWith(`.${this.baseDomain}`)) {
        return false;
      }

      // 提取 node-id
      const nodeId = this.extractNodeId(hostname);
      if (!nodeId || !this.isValidNodeId(nodeId)) {
        this.logger.debug(`Invalid nodeId in hostname: ${hostname}`);
        return false;
      }

      // 路径必须包含 pod 名称 (至少 /{pod}/)
      const podName = this.extractPodNameFromPath(target.pathname);
      if (!podName || !this.isValidPodName(podName)) {
        this.logger.debug(`Invalid podName in path: ${target.pathname}`);
        return false;
      }

      return true;
    } catch (error: unknown) {
      this.logger.warn(`Failed to parse identifier ${identifier.path}: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * 检查是否是根容器
   *
   * 根容器是 /{pod-name}/
   */
  public override isRootContainer(identifier: ResourceIdentifier): boolean {
    try {
      const target = new URL(identifier.path);
      const pathname = ensureTrailingSlash(target.pathname);

      // 根容器路径应该是 /{pod}/
      const segments = pathname.split('/').filter(Boolean);
      return segments.length === 1;
    } catch {
      return false;
    }
  }

  /**
   * 从 hostname 提取 node-id
   * node1.pods.undefineds.site -> node1
   */
  public extractNodeId(hostname: string): string | undefined {
    const suffix = `.${this.baseDomain}`;
    const lowerHostname = hostname.toLowerCase();

    if (!lowerHostname.endsWith(suffix)) {
      return undefined;
    }

    const nodeId = lowerHostname.slice(0, -suffix.length);
    return nodeId || undefined;
  }

  /**
   * 从 identifier 提取 Pod 名称
   */
  public extractPodName(identifier: ResourceIdentifier): string | undefined {
    try {
      const target = new URL(identifier.path);
      return this.extractPodNameFromPath(target.pathname);
    } catch {
      return undefined;
    }
  }

  /**
   * 从路径提取 Pod 名称
   * /alice/data.ttl -> alice
   * / -> undefined
   */
  private extractPodNameFromPath(pathname: string): string | undefined {
    const segments = pathname.split('/').filter(Boolean);
    return segments[0];
  }

  /**
   * 获取 Pod 的根容器 identifier
   */
  public getPodRootIdentifier(podName: string, nodeId: string): ResourceIdentifier {
    return {
      path: `https://${nodeId}.${this.baseDomain}/${podName}/`
    };
  }

  /**
   * 验证 node-id 格式
   * 允许: 字母、数字、连字符
   * 不允许: 空、点、特殊字符
   */
  private isValidNodeId(nodeId: string): boolean {
    if (!nodeId || nodeId.length === 0 || nodeId.length > 63) {
      return false;
    }
    // DNS 标签规则: 字母数字连字符，不能以连字符开头或结尾
    return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(nodeId);
  }

  /**
   * 验证 pod 名称格式
   * 允许: 字母、数字、连字符、下划线
   */
  private isValidPodName(podName: string): boolean {
    if (!podName || podName.length === 0 || podName.length > 64) {
      return false;
    }
    // 不允许以点开头或包含斜杠
    return /^[a-zA-Z0-9_-]+$/.test(podName);
  }
}
