/**
 * Claude Executor
 *
 * 使用 Claude Agent SDK 执行任务。
 *
 * 支持功能：
 * - 完整的 Agent 能力（代码理解、文件编辑、命令执行等）
 * - 工具调用（MCP）
 * - 权限管理
 * - 流式输出
 *
 * 注意：
 * - Claude Agent SDK 需要在环境变量中设置 ANTHROPIC_API_KEY
 * - SDK 会自动处理复杂的交互逻辑
 */

import { query, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { BaseAgentExecutor } from './BaseAgentExecutor';
import type {
  ExecutorType,
  AuthType,
  AuthInfo,
  ExecutorConfig,
  ExecuteMessage,
  ChatMessage,
  ExecuteResult,
  BaseExecutorOptions,
} from './types';

/**
 * Claude 鉴权错误
 */
export class ClaudeAuthenticationError extends Error {
  public constructor(message: string = 'Claude 未配置认证，请在环境变量中设置 ANTHROPIC_API_KEY') {
    super(message);
    this.name = 'ClaudeAuthenticationError';
  }
}

/**
 * Claude Executor
 *
 * 封装 Claude Agent SDK 调用。
 */
export class ClaudeExecutor extends BaseAgentExecutor {
  public readonly executorType: ExecutorType = 'claude';

  /**
   * 获取认证类型
   */
  public getAuthType(): AuthType {
    return 'api-key';
  }

  /**
   * 获取环境变量配置
   */
  private getEnvConfig(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // 如果提供了 API Key，设置到环境变量
    if (this.credential.apiKey) {
      env['ANTHROPIC_API_KEY'] = this.credential.apiKey;
    }

    return env;
  }

  /**
   * 检查认证状态
   */
  public async checkAuthentication(): Promise<AuthInfo> {
    try {
      const env = this.getEnvConfig();

      if (!env['ANTHROPIC_API_KEY']) {
        throw new ClaudeAuthenticationError('API Key 未配置');
      }

      // 发送一个简单查询来验证认证
      const q = query({
        prompt: 'hi',
        options: {
          env,
          maxTurns: 1,
          permissionMode: 'dontAsk',
          tools: [], // 禁用所有工具
          persistSession: false,
        },
      });

      // 收集消息检查是否有认证错误
      for await (const message of q) {
        if (message.type === 'result') {
          const result = message as SDKResultMessage;
          if (result.subtype !== 'success') {
            // 检查是否是认证错误
            if (result.errors?.some((e) => e.includes('authentication') || e.includes('api_key') || e.includes('401'))) {
              throw new ClaudeAuthenticationError(`Claude API Key 无效: ${result.errors.join(', ')}`);
            }
          }
        }
      }

      return {
        authenticated: true,
        authType: 'api-key',
        providerId: this.providerId,
        executorType: this.executorType,
      };
    } catch (error) {
      if (error instanceof ClaudeAuthenticationError) {
        throw error;
      }

      const errorMsg = error instanceof Error ? error.message : String(error);

      if (
        errorMsg.includes('authentication') ||
        errorMsg.includes('api_key') ||
        errorMsg.includes('invalid') ||
        errorMsg.includes('401') ||
        errorMsg.includes('unauthorized')
      ) {
        throw new ClaudeAuthenticationError(`Claude API Key 无效: ${errorMsg}`);
      }

      throw error;
    }
  }

  /**
   * 构建 SDK Options
   */
  private buildOptions(config: ExecutorConfig, additionalOptions?: Partial<Options>): Options {
    const options: Options = {
      env: this.getEnvConfig(),
      model: config.model ?? 'claude-sonnet-4-20250514',
      cwd: config.workingDirectory ?? process.cwd(),
      includePartialMessages: true, // 启用流式输出
      persistSession: false, // 不持久化 session
      ...additionalOptions,
    };

    // 设置 system prompt
    if (config.systemPrompt) {
      options.systemPrompt = config.systemPrompt;
    }

    // 设置工具
    if (config.tools && config.tools.length > 0) {
      options.tools = config.tools;
    }

    // 设置允许的工具
    if (config.allowedTools && config.allowedTools.length > 0) {
      options.allowedTools = config.allowedTools;
    }

    // 设置权限模式
    if (config.permissionMode) {
      options.permissionMode = config.permissionMode as Options['permissionMode'];
    }

    // 设置 MCP 服务器
    if (config.mcpServers) {
      options.mcpServers = config.mcpServers as Options['mcpServers'];
    }

    // 设置 max tokens (通过 maxThinkingTokens)
    if (config.maxTokens) {
      options.maxThinkingTokens = config.maxTokens;
    }

    return options;
  }

  /**
   * 执行任务（流式）
   */
  public async *execute(config: ExecutorConfig, message: string): AsyncGenerator<ExecuteMessage> {
    this.logger.info(`[${config.name}] Executing with Claude Agent SDK: ${message.slice(0, 100)}...`);

    const startTime = Date.now();
    const modelName = config.model ?? 'claude-sonnet-4-20250514';

    try {
      yield { type: 'system', executorType: this.executorType, model: modelName };

      const options = this.buildOptions(config);
      const q = query({ prompt: message, options });

      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const sdkMessage of q) {
        // 处理不同类型的消息
        switch (sdkMessage.type) {
          case 'assistant':
            // 完整的 assistant 消息
            for (const block of sdkMessage.message.content) {
              if (block.type === 'text') {
                fullText = block.text;
              }
            }
            // 更新 usage
            if (sdkMessage.message.usage) {
              promptTokens = sdkMessage.message.usage.input_tokens ?? 0;
              completionTokens = sdkMessage.message.usage.output_tokens ?? 0;
            }
            break;

          case 'stream_event':
            // 流式事件
            if (sdkMessage.event.type === 'content_block_delta') {
              const delta = sdkMessage.event.delta;
              if (delta.type === 'text_delta') {
                yield { type: 'text', content: delta.text };
                fullText += delta.text;
              }
            } else if (sdkMessage.event.type === 'message_delta') {
              // 更新 usage
              if (sdkMessage.event.usage) {
                completionTokens = sdkMessage.event.usage.output_tokens ?? 0;
              }
            } else if (sdkMessage.event.type === 'message_start') {
              // 初始 usage
              if (sdkMessage.event.message?.usage) {
                promptTokens = sdkMessage.event.message.usage.input_tokens ?? 0;
              }
            }
            break;

          case 'system':
            // 系统消息
            if ('subtype' in sdkMessage) {
              this.logger.debug(`[${config.name}] System message: ${sdkMessage.subtype}`);
            }
            break;

          case 'result':
            // 最终结果
            const result = sdkMessage as SDKResultMessage;
            if (result.subtype === 'success') {
              // 使用 result 中的信息更新
              if (result.usage) {
                promptTokens = result.usage.input_tokens ?? promptTokens;
                completionTokens = result.usage.output_tokens ?? completionTokens;
              }
              if (result.result && !fullText) {
                fullText = result.result;
              }
            } else {
              // 错误
              throw new Error(result.errors?.join(', ') ?? `执行失败: ${result.subtype}`);
            }
            break;
        }
      }

      const durationMs = Date.now() - startTime;

      yield {
        type: 'done',
        result: {
          success: true,
          result: fullText,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            durationMs,
          },
        },
      };
    } catch (error) {
      yield* this.yieldError(error, startTime);
    }
  }

  /**
   * 多轮对话
   *
   * 注意：Claude Agent SDK 主要设计用于单次查询模式，
   * 多轮对话需要通过 session API（V2，目前不稳定）或
   * 在 prompt 中包含历史消息。
   */
  public async chat(config: ExecutorConfig, messages: ChatMessage[]): Promise<ExecuteResult> {
    const startTime = Date.now();

    try {
      // 分离 system 消息和对话消息
      const systemMessages = messages.filter((m) => m.role === 'system');
      const chatMessages = messages.filter((m) => m.role !== 'system');

      // 构建完整的 prompt，包含历史消息
      const formattedMessages = chatMessages
        .map((m) => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          return `${role}: ${m.content}`;
        })
        .join('\n\n');

      // 构建 options
      const options = this.buildOptions(config, {
        // 如果有 system 消息，使用第一个作为 system prompt
        systemPrompt:
          systemMessages.length > 0
            ? systemMessages.map((m) => m.content).join('\n\n')
            : config.systemPrompt,
      });

      // 使用最后一条用户消息作为 prompt（如果有历史则在 system prompt 中添加上下文）
      const lastUserMessage = chatMessages.filter((m) => m.role === 'user').pop();
      const prompt = lastUserMessage?.content ?? formattedMessages;

      // 如果有多条消息，在 system prompt 中添加对话历史
      if (chatMessages.length > 1 && options.systemPrompt) {
        options.systemPrompt = `${options.systemPrompt}\n\n## Conversation History\n${formattedMessages}`;
      }

      const q = query({ prompt, options });

      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const sdkMessage of q) {
        if (sdkMessage.type === 'assistant') {
          for (const block of sdkMessage.message.content) {
            if (block.type === 'text') {
              fullText = block.text;
            }
          }
          if (sdkMessage.message.usage) {
            promptTokens = sdkMessage.message.usage.input_tokens ?? 0;
            completionTokens = sdkMessage.message.usage.output_tokens ?? 0;
          }
        } else if (sdkMessage.type === 'result') {
          const result = sdkMessage as SDKResultMessage;
          if (result.subtype !== 'success') {
            throw new Error(result.errors?.join(', ') ?? `执行失败: ${result.subtype}`);
          }
          if (result.usage) {
            promptTokens = result.usage.input_tokens ?? promptTokens;
            completionTokens = result.usage.output_tokens ?? completionTokens;
          }
          if (result.result && !fullText) {
            fullText = result.result;
          }
        }
      }

      return {
        success: true,
        result: fullText,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          durationMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      return this.wrapError(error, startTime);
    }
  }
}

/**
 * 创建 Claude executor 实例
 */
export function createClaudeExecutor(options?: BaseExecutorOptions): ClaudeExecutor {
  return new ClaudeExecutor(options);
}
