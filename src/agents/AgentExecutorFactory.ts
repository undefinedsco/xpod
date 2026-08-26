/**
 * Agent Executor Factory
 *
 * 创建对应的 Agent 执行器。
 *
 * 支持的执行器类型：
 * - codebuddy: CodeBuddy Agent SDK
 * - claude: Claude Agent SDK, always backed by server-only platform AI config
 *
 * 使用流程：
 * 1. claude 直接使用 Xpod 服务端平台配置，不读取 Pod provider/credential
 * 2. codebuddy 从 Pod 读取 Provider 配置
 * 3. codebuddy 从 Pod 读取对应的 Credential
 * 4. 根据 runtimeKind 创建对应的执行器实例
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq, and } from '@undefineds.co/drizzle-solid';
import { selectAIConfigCredential } from '@undefineds.co/models';
import type {
  IAgentExecutor,
  ExecutorType,
  AiCredential,
  ProviderConfig,
  BaseExecutorOptions,
} from './types';
import {
  getAiGatewayBaseUrl,
  getPlatformDefaultModel,
} from '../api/service/platform-ai-config';
import { resolveServerProviderTransport } from '../api/service/provider-registry';
import { Provider } from '../ai/schema/provider';
import { Model } from '../ai/schema/model';
import { Credential } from '../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../credential/schema/types';

// 执行器实现（仅支持有完整 Agent SDK 的供应商）
import { ClaudeExecutor } from './ClaudeExecutor';
import { CodeBuddyExecutor } from './CodeBuddyExecutor';

const schema = {
  provider: Provider,
  credential: Credential,
  model: Model,
};

/**
 * 支持的执行器类型
 */
export const SUPPORTED_EXECUTOR_TYPES: ExecutorType[] = ['codebuddy', 'claude'];

/**
 * Agent Executor Factory
 *
 * 负责创建执行器实例。
 */
export class AgentExecutorFactory {
  private readonly logger = getLoggerFor(this);

  private async resolveModelId(db: any, modelRef: string | null | undefined): Promise<string | undefined> {
    if (!modelRef) {
      return undefined;
    }

    const model = await db.findByIri(Model, modelRef);
    return model?.id ?? undefined;
  }

  /**
   * 检查执行器类型是否支持
   */
  public isSupported(executorType: string): executorType is ExecutorType {
    return SUPPORTED_EXECUTOR_TYPES.includes(executorType as ExecutorType);
  }

  private createPlatformClaudeExecutor(): IAgentExecutor {
    const providerConfig: ProviderConfig = {
      id: 'xpod',
      displayName: 'Xpod Platform AI',
      executorType: 'claude',
      baseUrl: getAiGatewayBaseUrl(),
      defaultModel: getPlatformDefaultModel(),
      enabled: true,
    };

    return this.createExecutor('claude', {
      providerId: 'xpod',
      credential: {
        providerId: 'xpod',
        apiKey: '',
        baseUrl: providerConfig.baseUrl,
      },
      providerConfig,
    });
  }

  /**
   * 创建执行器
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
    runtimeKind: ExecutorType,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<IAgentExecutor | null> {
    try {
      if (!this.isSupported(runtimeKind)) {
        this.logger.warn(`Unsupported runtime kind: ${runtimeKind}. Only 'codebuddy' and 'claude' are supported.`);
        return null;
      }

      if (runtimeKind === 'claude') {
        return this.createPlatformClaudeExecutor();
      }

      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db: any = drizzle(session, { schema });

      // 1. 读取供应商配置
      const provider = await db.findById(Provider, providerId);

      if (!provider) {
        this.logger.debug(`Provider not found: ${providerId}`);
        return null;
      }

      if (provider.enabled !== 'true') {
        this.logger.debug(`Provider is disabled: ${providerId}`);
        return null;
      }

      const credentials = await db.query.credential.findMany({
        where: and(
          eq(Credential.service, ServiceType.AI),
          eq(Credential.status, CredentialStatus.ACTIVE),
        ),
      });
      const providers = await db.query.provider.findMany();
      const selection = selectAIConfigCredential(providerId, credentials, providers);

      if (!selection) {
        this.logger.debug(`No active credential found for provider: ${providerId}`);
        return null;
      }

      const transport = resolveServerProviderTransport({
        providerId: selection.providerId,
        baseUrl: selection.baseUrl,
        proxyUrl: selection.proxyUrl,
      });

      // 3. 构建凭证对象
      const aiCredential: AiCredential = {
        providerId: selection.providerId,
        apiKey: selection.apiKey,
        baseUrl: transport.baseUrl,
        proxyUrl: transport.proxyUrl,
        projectId: (selection.credential as any).projectId ?? undefined,
        organizationId: (selection.credential as any).organizationId ?? undefined,
      };

      // 4. 构建供应商配置
      const defaultModel = await this.resolveModelId(db, provider.defaultModel ?? provider.hasModel);
      const providerConfig: ProviderConfig = {
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        executorType: runtimeKind,
        baseUrl: transport.baseUrl,
        defaultModel,
        enabled: provider.enabled === 'true',
      };

      // 5. 创建执行器
      return this.createExecutor(runtimeKind, {
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
