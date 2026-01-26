/**
 * Agent Manager - Agent 生命周期管理
 *
 * 职责：
 * 1. 从 Pod 读取 Agent 配置
 * 2. 根据配置创建 Executor
 * 3. 管理 Agent 实例的生命周期
 * 4. 路由消息到对应的 Agent
 */

import { getLoggerFor } from 'global-logger-factory';
import { drizzle, eq } from '@undefineds.co/drizzle-solid';
import type { IAgentExecutor, ExecutorType, ExecutorConfig, AiCredential } from './types';
import { AgentConfig as AgentConfigTable, AgentStatus } from './schema/agent-config';
import { AgentProvider } from './schema/tables';
import { Credential } from '../credential/schema/tables';
import { ServiceType, CredentialStatus } from '../credential/schema/types';
import { AgentExecutorFactory } from './AgentExecutorFactory';

/**
 * Agent 实例 - 包含配置和执行器
 */
export interface AgentInstance {
  /** Agent ID */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description: string;
  /** 执行器实例 */
  executor: IAgentExecutor;
  /** 执行器配置 */
  config: ExecutorConfig;
  /** 状态 */
  status: 'idle' | 'running' | 'error';
  /** 启动时间 */
  startedAt?: Date;
  /** 最后活动时间 */
  lastActivityAt?: Date;
}

/**
 * Agent 配置（从 Pod 读取）
 */
export interface AgentConfig {
  id: string;
  displayName?: string;
  description?: string;
  providerId: string;
  modelUri?: string;
  systemPrompt: string;
  maxTurns?: number;
  timeout?: number;
  enabled: boolean;
}

const schema = {
  agentConfig: AgentConfigTable,
  agentStatus: AgentStatus,
  agentProvider: AgentProvider,
  credential: Credential,
};

/**
 * Agent Manager
 *
 * 管理 Agent 实例的完整生命周期
 */
export class AgentManager {
  private readonly logger = getLoggerFor(this);
  private readonly factory = new AgentExecutorFactory();
  private readonly instances = new Map<string, AgentInstance>();

  /**
   * 获取或创建 Agent 实例
   *
   * 如果 Agent 已存在且健在，直接返回
   * 否则根据配置创建新实例
   *
   * @param agentId Agent ID
   * @param podBaseUrl Pod 根 URL
   * @param authenticatedFetch 带认证的 fetch
   * @param webId 用户 WebID
   */
  public async getOrCreate(
    agentId: string,
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<AgentInstance | null> {
    // 1. 检查是否有健在的实例
    const existing = this.instances.get(agentId);
    if (existing && this.isAlive(existing)) {
      this.logger.debug(`Agent ${agentId} is alive, reusing instance`);
      return existing;
    }

    // 2. 从 Pod 读取配置并创建
    this.logger.info(`Creating agent instance: ${agentId}`);
    const instance = await this.createFromConfig(agentId, podBaseUrl, authenticatedFetch, webId);

    if (instance) {
      this.instances.set(agentId, instance);
      await this.updateStatus(agentId, 'idle', podBaseUrl, authenticatedFetch, webId);
    }

    return instance;
  }

  /**
   * 检查 Agent 是否健在
   */
  private isAlive(instance: AgentInstance): boolean {
    // 简单判断：非 error 状态就是健在
    // 未来可以加入心跳检测
    return instance.status !== 'error';
  }

  /**
   * 从 Pod 配置创建 Agent 实例
   */
  private async createFromConfig(
    agentId: string,
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<AgentInstance | null> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db = drizzle(session, { schema });

      // 1. 读取 Agent 配置
      const agentConfig = await db.query.agentConfig.findFirst({
        where: eq(AgentConfigTable.id, agentId),
      });

      if (!agentConfig) {
        this.logger.warn(`Agent config not found: ${agentId}`);
        return null;
      }

      if (agentConfig.enabled !== 'true') {
        this.logger.debug(`Agent is disabled: ${agentId}`);
        return null;
      }

      // 2. 解析 provider URI，获取 provider ID
      const providerUri = agentConfig.provider;
      if (!providerUri) {
        this.logger.error(`Agent ${agentId} has no provider configured`);
        return null;
      }

      // provider URI 格式: /settings/ai/agent-providers.ttl#codebuddy
      const providerId = providerUri.split('#').pop();
      if (!providerId) {
        this.logger.error(`Invalid provider URI: ${providerUri}`);
        return null;
      }

      // 3. 读取 Provider 配置
      const provider = await db.query.agentProvider.findFirst({
        where: eq(AgentProvider.id, providerId),
      });

      if (!provider) {
        this.logger.error(`Provider not found: ${providerId}`);
        return null;
      }

      // 4. 读取 Credential
      const credentials = await db.query.credential.findMany({
        where: eq(Credential.provider, providerUri),
      });

      const activeCredential = credentials.find(
        (c: any) => c.status === CredentialStatus.ACTIVE && c.service === ServiceType.AI,
      );

      // 构建凭证（可能为空，Executor 会处理）
      const credential: AiCredential = {
        providerId,
        apiKey: (activeCredential as any)?.apiKey ?? '',
        baseUrl: (activeCredential as any)?.baseUrl ?? provider.baseUrl ?? undefined,
        projectId: (activeCredential as any)?.projectId ?? undefined,
        organizationId: (activeCredential as any)?.organizationId ?? undefined,
      };

      // 5. 创建 Executor
      const executorType = provider.executorType as ExecutorType;
      const executor = this.factory.createExecutor(executorType, {
        providerId,
        credential,
        providerConfig: {
          id: providerId,
          displayName: provider.displayName ?? providerId,
          executorType,
          baseUrl: provider.baseUrl ?? undefined,
          defaultModel: provider.defaultModel ?? undefined,
          enabled: provider.enabled === 'true',
        },
      });

      // 6. 构建执行器配置
      const config: ExecutorConfig = {
        name: agentId,
        description: agentConfig.description ?? undefined,
        systemPrompt: agentConfig.systemPrompt ?? '',
        model: agentConfig.model ?? provider.defaultModel ?? undefined,
        maxTokens: 8192,
      };

      // 7. 返回实例
      return {
        id: agentId,
        displayName: agentConfig.displayName ?? agentId,
        description: agentConfig.description ?? '',
        executor,
        config,
        status: 'idle',
        startedAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to create agent ${agentId}:`, error);
      return null;
    }
  }

  /**
   * 发送消息给 Agent
   *
   * @param agentId Agent ID
   * @param message 消息内容
   * @param podBaseUrl Pod 根 URL
   * @param authenticatedFetch 带认证的 fetch
   * @param webId 用户 WebID
   * @param accessToken OAuth token（用于 MCP）
   */
  public async sendMessage(
    agentId: string,
    message: string,
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
    accessToken?: string,
  ): Promise<{ success: boolean; result?: string; error?: string }> {
    // 1. 获取或创建实例
    const instance = await this.getOrCreate(agentId, podBaseUrl, authenticatedFetch, webId);
    if (!instance) {
      return { success: false, error: `Agent not found or disabled: ${agentId}` };
    }

    // 2. 更新状态为 running
    instance.status = 'running';
    instance.lastActivityAt = new Date();
    await this.updateStatus(agentId, 'running', podBaseUrl, authenticatedFetch, webId);

    try {
      // 3. 执行
      const result = await instance.executor.executeAndWait(instance.config, message);

      // 4. 更新状态
      instance.status = 'idle';
      instance.lastActivityAt = new Date();
      await this.updateStatus(agentId, 'idle', podBaseUrl, authenticatedFetch, webId);

      if (result.success) {
        return { success: true, result: result.result };
      } else {
        return { success: false, error: result.error };
      }
    } catch (error) {
      // 5. 错误处理
      instance.status = 'error';
      await this.updateStatus(
        agentId,
        'error',
        podBaseUrl,
        authenticatedFetch,
        webId,
        error instanceof Error ? error.message : String(error),
      );

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 更新 Agent 状态到 Pod
   */
  private async updateStatus(
    agentId: string,
    status: 'idle' | 'running' | 'error',
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      const session = {
        info: { isLoggedIn: true, webId },
        fetch: authenticatedFetch,
      };
      const db = drizzle(session, { schema });

      const now = new Date().toISOString();

      // 先查询是否存在，再决定插入或更新
      const existing = await db.query.agentStatus.findFirst({
        where: eq(AgentStatus.id, agentId),
      });

      if (existing) {
        await db
          .update(AgentStatus)
          .set({
            status,
            lastActivityAt: now,
            errorMessage: errorMessage ?? undefined,
          })
          .where(eq(AgentStatus.id, agentId));
      } else {
        await db.insert(AgentStatus).values({
          id: agentId,
          agentId,
          status,
          startedAt: status === 'running' ? now : undefined,
          lastActivityAt: now,
          errorMessage: errorMessage ?? undefined,
        });
      }
    } catch (error) {
      // 状态更新失败不影响主流程
      this.logger.warn(`Failed to update agent status: ${error}`);
    }
  }

  /**
   * 获取 Agent 状态
   */
  public getStatus(agentId: string): AgentInstance | undefined {
    return this.instances.get(agentId);
  }

  /**
   * 列出所有活跃的 Agent
   */
  public listActiveAgents(): AgentInstance[] {
    return Array.from(this.instances.values()).filter((i) => this.isAlive(i));
  }

  /**
   * 停止 Agent
   */
  public async stop(
    agentId: string,
    podBaseUrl: string,
    authenticatedFetch: typeof fetch,
    webId?: string,
  ): Promise<void> {
    const instance = this.instances.get(agentId);
    if (instance) {
      instance.status = 'idle';
      await this.updateStatus(agentId, 'idle', podBaseUrl, authenticatedFetch, webId);
      this.instances.delete(agentId);
      this.logger.info(`Agent stopped: ${agentId}`);
    }
  }

  /**
   * 停止所有 Agent
   */
  public async stopAll(): Promise<void> {
    for (const [agentId] of this.instances) {
      this.instances.delete(agentId);
      this.logger.info(`Agent stopped: ${agentId}`);
    }
  }
}

/**
 * 默认 AgentManager 实例
 */
export const agentManager = new AgentManager();
