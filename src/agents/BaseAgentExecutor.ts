/**
 * Agent Executor 抽象基类
 *
 * 所有 AI Agent 执行器的基类，提供公共逻辑。
 */

import { getLoggerFor } from 'global-logger-factory';
import type {
  IAgentExecutor,
  ExecutorType,
  AuthType,
  AuthInfo,
  ExecutorConfig,
  ExecuteResult,
  ExecuteMessage,
  ChatMessage,
  BaseExecutorOptions,
  AiCredential,
} from './types';

/**
 * 默认空凭证（用于 CLI 模式）
 */
const EMPTY_CREDENTIAL: AiCredential = {
  providerId: '',
  apiKey: '',
};

/**
 * Agent 执行器抽象基类
 *
 * 提供公共实现：
 * - executeAndWait: 基于 execute 的便捷方法
 * - 日志记录
 * - 错误处理包装
 *
 * 子类需要实现：
 * - executorType: 执行器类型
 * - getAuthType(): 认证类型
 * - checkAuthentication(): 认证检查
 * - execute(): 流式执行
 * - chat(): 多轮对话
 */
export abstract class BaseAgentExecutor implements IAgentExecutor {
  public abstract readonly executorType: ExecutorType;
  public readonly providerId: string;

  protected readonly logger = getLoggerFor(this);
  protected readonly credential: AiCredential;
  protected readonly baseUrl?: string;

  /**
   * 构造函数
   * @param options 可选，如果不传则使用默认值（CLI 模式）
   */
  public constructor(options?: BaseExecutorOptions) {
    this.providerId = options?.providerId ?? 'default';
    this.credential = options?.credential ?? EMPTY_CREDENTIAL;
    this.baseUrl = options?.credential?.baseUrl ?? options?.providerConfig?.baseUrl;
  }

  /**
   * 获取认证类型
   */
  public abstract getAuthType(): AuthType;

  /**
   * 检查认证状态
   */
  public abstract checkAuthentication(): Promise<AuthInfo>;

  /**
   * 执行任务（流式）
   */
  public abstract execute(config: ExecutorConfig, message: string): AsyncGenerator<ExecuteMessage>;

  /**
   * 多轮对话
   */
  public abstract chat(config: ExecutorConfig, messages: ChatMessage[]): Promise<ExecuteResult>;

  /**
   * 执行任务并等待完成
   *
   * 基于 execute() 的便捷方法，消费整个流并返回最终结果。
   */
  public async executeAndWait(config: ExecutorConfig, message: string): Promise<ExecuteResult> {
    let result: ExecuteResult = {
      success: false,
      error: 'No result received',
    };

    for await (const msg of this.execute(config, message)) {
      if (msg.type === 'done') {
        result = msg.result;
      }
    }

    return result;
  }

  /**
   * 包装执行错误
   */
  protected wrapError(error: unknown, startTime: number): ExecuteResult {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMsg,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * 创建成功结果
   */
  protected createSuccessResult(
    result: string,
    promptTokens: number,
    completionTokens: number,
    startTime: number,
  ): ExecuteResult {
    return {
      success: true,
      result,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * 创建错误消息
   */
  protected *yieldError(error: unknown, startTime: number): Generator<ExecuteMessage> {
    const errorMsg = error instanceof Error ? error.message : String(error);
    yield { type: 'error', error: errorMsg };
    yield { type: 'done', result: this.wrapError(error, startTime) };
  }
}
