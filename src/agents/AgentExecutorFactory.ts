/**
 * Agent Executor Factory
 *
 * 从 Pod 读取凭证和供应商配置，创建对应的 Agent 执行器。
 *
 * 支持的执行器类型：
 * - codebuddy: CodeBuddy Agent SDK
 * - claude: Claude Agent SDK
 *
 * 使用流程：
 * 1. 从 Pod 读取 AgentProvider 配置
 * 2. 从 Pod 读取对应的 Credential
 * 3. 根据 executorType 创建对应的执行器实例
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq, and } from 'drizzle-solid';
import type { IAgentExecutor, ExecutorType, AiCredential, ProviderConfig, BaseExecutorOptions } from './types';
import { AgentProvider } from './schema/tables';
import { Credential } from '../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../credential/schema/types';

// 执行器实现（仅支持有完整 Agent SDK 的供应商）
import { ClaudeExecutor } from './ClaudeExecutor';
import { CodeBuddyExecutor } from './CodeBuddyExecutor';

const schema = {
  agentProvider: AgentProvider,
  credential: Credential,
};

/**
 * 支持的执行器类型
 */
export const SUPPORTED_EXECUTOR_TYPES: ExecutorType[] = ['codebuddy', 'claude'];

/**
 * Agent Executor Factory
 *
 * 负责从 Pod 读取配置并创建执行器实例。
 */
export class AgentExecutorFactory {
  private readonly logger = getLoggerFor(this);

  /**
   * 检查执行器类型是否支持
   */
  public isSupported(executorType: string): executorType is ExecutorType {
    return SUPPORTED_EXECUTOR_TYPES.includes(executorType as ExecutorType);
  }

  /**
   * 从 Pod 创建执行器
   *
   * @param podBaseUrl Pod 根 URL
   * @param providerId 供应商 ID
   * @param authenticatedFetch 带认证的 fetch 函数
   * @param webId 用户 WebID（可选）
   * @returns 执行器实例，如果未找到配置则返回 null
   */
  public async create(
    podBaseUrl: string,
    providerId: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<IAgentExecutor | null> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db = drizzle(session, { schema });

      // 1. 读取供应商配置
      const provider = await db.query.agentProvider.findFirst({
        where: eq(AgentProvider.id, providerId),
      });

      if (!provider) {
        this.logger.debug(`Agent provider not found: ${providerId}`);
        return null;
      }

      if (provider.enabled !== 'true') {
        this.logger.debug(`Agent provider is disabled: ${providerId}`);
        return null;
      }

      // 检查执行器类型是否支持
      if (!this.isSupported(provider.executorType)) {
        this.logger.warn(`Unsupported executor type: ${provider.executorType}. Only 'codebuddy' and 'claude' are supported.`);
        return null;
      }

      // 2. 读取凭证
      const providerUri = `${podBaseUrl}settings/ai/agent-providers.ttl#${providerId}`;
      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
          eq(Credential.provider, providerUri),
        ),
      });

      if (credentials.length === 0) {
        this.logger.debug(`No active credential found for agent provider: ${providerId}`);
        return null;
      }

      // 随机选择一个凭证（负载均衡）
      const credential = credentials[Math.floor(Math.random() * credentials.length)] as any;

      // 3. 构建凭证对象
      const aiCredential: AiCredential = {
        providerId,
        apiKey: credential.apiKey ?? '',
        baseUrl: credential.baseUrl ?? provider.baseUrl ?? undefined,
        proxyUrl: credential.proxyUrl ?? undefined,
        projectId: credential.projectId ?? undefined,
        organizationId: credential.organizationId ?? undefined,
      };

      // 4. 构建供应商配置
      const providerConfig: ProviderConfig = {
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        executorType: provider.executorType as ExecutorType,
        baseUrl: provider.baseUrl ?? undefined,
        defaultModel: provider.defaultModel ?? undefined,
        enabled: provider.enabled === 'true',
      };

      // 5. 创建执行器
      return this.createExecutor(provider.executorType as ExecutorType, {
        providerId,
        credential: aiCredential,
        providerConfig,
      });
    } catch (error) {
      this.logger.error(`Failed to create executor for provider ${providerId}:`, error);
      return null;
    }
  }

  /**
   * 列出所有可用的供应商
   */
  public async listProviders(
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<ProviderConfig[]> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db = drizzle(session, { schema });

      const providers = await db.query.agentProvider.findMany();

      return providers.map((p: typeof providers[number]) => ({
        id: p.id,
        displayName: p.displayName ?? p.id,
        executorType: p.executorType as ExecutorType,
        baseUrl: p.baseUrl ?? undefined,
        defaultModel: p.defaultModel ?? undefined,
        enabled: p.enabled === 'true',
      }));
    } catch (error) {
      this.logger.error('Failed to list agent providers:', error);
      return [];
    }
  }

  /**
   * 列出所有启用的供应商
   */
  public async listEnabledProviders(
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<ProviderConfig[]> {
    const providers = await this.listProviders(podBaseUrl, authenticatedFetch, webId);
    return providers.filter((p) => p.enabled);
  }

  /**
   * 列出所有支持的供应商（executorType 受支持且已启用）
   */
  public async listSupportedProviders(
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<ProviderConfig[]> {
    const providers = await this.listEnabledProviders(podBaseUrl, authenticatedFetch, webId);
    return providers.filter((p) => this.isSupported(p.executorType));
  }

  /**
   * 根据 executorType 创建执行器
   */
  public createExecutor(executorType: ExecutorType, options: BaseExecutorOptions): IAgentExecutor {
    switch (executorType) {
      case 'claude':
        return new ClaudeExecutor(options);

      case 'codebuddy':
        return new CodeBuddyExecutor(options);

      default:
        throw new Error(
          `Unsupported executor type: ${executorType}. ` +
          `Only 'codebuddy' and 'claude' are supported because they have complete Agent SDKs.`
        );
    }
  }

  /**
   * 创建指定类型的执行器（直接使用凭证，不从 Pod 读取）
   *
   * 用于测试或已知凭证的场景。
   */
  public createDirect(
    executorType: ExecutorType,
    providerId: string,
    credential: AiCredential,
  ): IAgentExecutor {
    return this.createExecutor(executorType, {
      providerId,
      credential,
    });
  }
}

/**
 * 默认工厂实例
 */
export const agentExecutorFactory = new AgentExecutorFactory();
