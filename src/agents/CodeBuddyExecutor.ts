/**
 * CodeBuddy Executor
 *
 * 通过 CodeBuddy Agent SDK 执行任务。
 * 支持 MCP 工具、structuredOutput 等高级功能。
 */

import { query, type Options, type McpServerConfig as SdkMcpServerConfig, type SystemMessage } from '@tencent-ai/agent-sdk';
import { BaseAgentExecutor } from './BaseAgentExecutor';
import type {
  ExecutorType,
  AuthType,
  AuthInfo,
  ExecutorConfig,
  ExecuteResult,
  ExecuteMessage,
  ChatMessage,
  CodeBuddyConfig,
  CodeBuddyOptions,
  BaseExecutorOptions,
} from './types';

/**
 * CodeBuddy 鉴权错误
 */
export class CodeBuddyAuthError extends Error {
  public constructor(message: string = 'CodeBuddy 未鉴权，请在 Pod 中设置 API Key') {
    super(message);
    this.name = 'CodeBuddyAuthError';
  }
}

/**
 * CodeBuddy Executor
 *
 * 封装 CodeBuddy Agent SDK 调用。
 */
export class CodeBuddyExecutor extends BaseAgentExecutor {
  public readonly executorType: ExecutorType = 'codebuddy';

  /**
   * 获取认证类型
   */
  public getAuthType(): AuthType {
    return this.credential.apiKey ? 'api-key' : 'oidc';
  }

  /**
   * 检查认证状态
   */
  public async checkAuthentication(): Promise<AuthInfo> {
    try {
      const q = query({
        prompt: '请回复 OK',
        options: {
          maxTurns: 1,
          permissionMode: 'acceptEdits',
          disallowedTools: ['Task', 'Bash', 'Write', 'Edit', 'MultiEdit', 'Read', 'Glob', 'Grep'],
        },
      });

      const accountInfo = await q.accountInfo();

      let apiKeySource: string | undefined;
      for await (const msg of q) {
        if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
          const initMsg = msg as SystemMessage;
          apiKeySource = initMsg.apiKeySource;
        }
        if (msg.type === 'result') break;
      }

      const effectiveApiKeySource = apiKeySource ?? accountInfo.apiKeySource;
      if (!effectiveApiKeySource) {
        throw new CodeBuddyAuthError('CodeBuddy 未鉴权');
      }

      return {
        authenticated: true,
        authType: effectiveApiKeySource.includes('key') ? 'api-key' : 'oidc',
        providerId: this.providerId,
        executorType: this.executorType,
        account: {
          email: accountInfo.email,
          name: accountInfo.organization,
        },
      };
    } catch (error) {
      if (error instanceof CodeBuddyAuthError) {
        throw error;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);

      if (
        errorMsg.includes('not authenticated') ||
        errorMsg.includes('unauthorized') ||
        errorMsg.includes('auth') ||
        errorMsg.includes('login')
      ) {
        throw new CodeBuddyAuthError(`CodeBuddy 鉴权失败: ${errorMsg}`);
      }

      throw error;
    }
  }

  /**
   * 执行任务（流式）
   */
  public async *execute(config: ExecutorConfig, message: string): AsyncGenerator<ExecuteMessage> {
    const cbConfig: CodeBuddyConfig = {
      ...config,
      maxTurns: 10,
      permissionMode: 'acceptEdits',
    };

    yield* this.executeWithConfig(cbConfig, message, {});
  }

  /**
   * 执行任务（带完整配置）
   */
  public async *executeWithConfig(
    config: CodeBuddyConfig,
    message: string,
    options: CodeBuddyOptions = {},
  ): AsyncGenerator<ExecuteMessage> {
    this.logger.info(`[${config.name}] Executing: ${message.slice(0, 100)}...`);

    const startTime = Date.now();
    const abortController = new AbortController();

    const timeout = options.timeout ?? 300000;
    const timeoutId = setTimeout(() => {
      this.logger.warn(`[${config.name}] Execution timeout after ${timeout}ms`);
      abortController.abort();
    }, timeout);

    try {
      const mcpServers = this.buildMcpServers(config, options);

      const sdkOptions: Options = {
        abortController,
        cwd: config.cwd,
        allowedTools: config.allowedTools,
        disallowedTools: config.disallowedTools,
        mcpServers,
        model: config.model,
        maxTurns: config.maxTurns ?? 10,
        permissionMode: config.permissionMode ?? 'acceptEdits',
        systemPrompt: config.systemPrompt,
      };

      const q = query({
        prompt: message,
        options: sdkOptions,
      });

      let finalResult: ExecuteResult | undefined;

      for await (const msg of q) {
        if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
          const initMsg = msg as SystemMessage;

          if (!initMsg.apiKeySource) {
            this.logger.warn(`[${config.name}] CodeBuddy not authenticated`);
          } else {
            this.logger.debug(`[${config.name}] Authenticated via: ${initMsg.apiKeySource}`);
          }

          yield {
            type: 'system',
            executorType: this.executorType,
            model: config.model ?? 'claude-sonnet-4',
            tools: msg.tools ?? [],
          };
        } else if (msg.type === 'assistant') {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text') {
                yield { type: 'text', content: block.text };
              } else if (block.type === 'tool_use') {
                yield {
                  type: 'tool_call',
                  toolName: block.name,
                  toolInput: block.input,
                };
              }
            }
          }
        } else if (msg.type === 'result') {
          const durationMs = msg.duration_ms ?? Date.now() - startTime;
          const inputTokens = msg.usage?.input_tokens ?? 0;
          const outputTokens = msg.usage?.output_tokens ?? 0;

          if (msg.subtype === 'success') {
            finalResult = {
              success: true,
              result: msg.result,
              structuredOutput: msg.structured_output,
              usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
                durationMs,
              },
            };
          } else {
            finalResult = {
              success: false,
              error: `Execution ended with: ${msg.subtype}`,
              usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
                durationMs,
              },
            };
          }
        }
      }

      if (finalResult) {
        yield { type: 'done', result: finalResult };
      } else {
        yield {
          type: 'done',
          result: { success: false, error: 'No result received' },
        };
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${config.name}] Execution error: ${errorMsg}`);
      yield { type: 'error', error: errorMsg };
      yield { type: 'done', result: this.wrapError(error, startTime) };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 执行任务并等待完成（带完整配置）
   */
  public async executeAndWaitWithConfig(
    config: CodeBuddyConfig,
    message: string,
    options: CodeBuddyOptions = {},
  ): Promise<ExecuteResult> {
    let result: ExecuteResult = {
      success: false,
      error: 'No result received',
    };

    for await (const msg of this.executeWithConfig(config, message, options)) {
      if (msg.type === 'done') {
        result = msg.result;
      }
    }

    return result;
  }

  /**
   * 多轮对话
   */
  public async chat(config: ExecutorConfig, messages: ChatMessage[]): Promise<ExecuteResult> {
    const historyPrompt = messages
      .map((m) => {
        const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
        return `${role}: ${m.content}`;
      })
      .join('\n\n');

    return this.executeAndWait(config, historyPrompt);
  }

  /**
   * 构建 MCP 服务器配置
   */
  private buildMcpServers(
    config: CodeBuddyConfig,
    options: CodeBuddyOptions,
  ): Record<string, SdkMcpServerConfig> | undefined {
    const servers: Record<string, SdkMcpServerConfig> = {};

    // 转换配置中的 mcpServers
    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        servers[name] = serverConfig as SdkMcpServerConfig;
      }
    }

    if (options.podBaseUrl && options.accessToken) {
      servers.pod = {
        type: 'http',
        url: `${options.podBaseUrl}/.mcp`,
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
        },
      };
    }

    return Object.keys(servers).length > 0 ? servers : undefined;
  }
}

/**
 * 创建 CodeBuddy executor 实例
 */
export function createCodeBuddyExecutor(options?: BaseExecutorOptions): CodeBuddyExecutor {
  return new CodeBuddyExecutor(options);
}
