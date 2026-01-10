/**
 * TaskExecutor - 任务执行器
 *
 * 职责：
 * - 从队列获取待执行任务
 * - 路由到对应的 Agent
 * - 调用 Agent 执行
 * - 更新任务状态
 */

import { getLoggerFor } from 'global-logger-factory';
import type { Agent, AgentContext, Task, TaskQueue, TaskExecutor as ITaskExecutor } from './types';
import { CodeBuddyExecutor, CodeBuddyAuthError } from '../agents';

export interface TaskExecutorOptions {
  /** 任务队列 */
  taskQueue: TaskQueue;

  /** Pod base URL */
  podBaseUrl: string;

  /** 获取认证 fetch */
  getAuthenticatedFetch: () => Promise<typeof fetch>;

  /** 轮询间隔（毫秒） */
  pollInterval?: number;
}

/**
 * 任务执行器实现
 */
export class TaskExecutor implements ITaskExecutor {
  private readonly logger = getLoggerFor(this);
  private readonly taskQueue: TaskQueue;
  private readonly podBaseUrl: string;
  private readonly getAuthenticatedFetch: () => Promise<typeof fetch>;
  private readonly pollInterval: number;

  private readonly agents: Map<string, Agent> = new Map();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(options: TaskExecutorOptions) {
    this.taskQueue = options.taskQueue;
    this.podBaseUrl = options.podBaseUrl;
    this.getAuthenticatedFetch = options.getAuthenticatedFetch;
    this.pollInterval = options.pollInterval ?? 5000;
  }

  /**
   * 注册 Agent
   */
  public registerAgent(agent: Agent): void {
    this.agents.set(agent.name, agent);
    this.logger.info(`Registered agent: ${agent.name}`);
  }

  /**
   * 启动执行器
   * 
   * 会先检查 Agent SDK 鉴权状态，如果未鉴权则抛出错误。
   * 这避免了在服务端环境中 SDK 尝试弹出浏览器进行交互式登录。
   */
  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    // 检查 Agent SDK 鉴权状态
    await this.checkAgentAuthentication();

    this.running = true;
    this.logger.info('TaskExecutor started');
    this.schedulePoll();
  }

  /**
   * 检查 Agent SDK 鉴权状态
   * 
   * 在服务端环境中，如果 SDK 未鉴权，会尝试弹出浏览器进行交互式登录，
   * 这在无界面环境中会失败。因此需要在启动时检查鉴权状态。
   * 
   * @throws CodeBuddyAuthError 如果未鉴权
   */
  private async checkAgentAuthentication(): Promise<void> {
    const executor = new CodeBuddyExecutor();
    
    try {
      const authInfo = await executor.checkAuthentication();
      this.logger.info(`Agent SDK authenticated via: ${authInfo.authType}`);
      
      if (authInfo.account?.email) {
        this.logger.info(`Agent SDK account: ${authInfo.account.email}`);
      }
    } catch (error) {
      if (error instanceof CodeBuddyAuthError) {
        this.logger.error(`Agent SDK authentication failed: ${error.message}`);
        this.logger.error('Please run `codebuddy` command to login before starting the server.');
        throw error;
      }
      throw error;
    }
  }

  /**
   * 停止执行器
   */
  public async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info('TaskExecutor stopped');
  }

  /**
   * 手动触发执行特定任务
   */
  public async trigger(taskId: string): Promise<void> {
    const task = await this.taskQueue.getTask(taskId);
    if (!task) {
      this.logger.warn(`Task not found: ${taskId}`);
      return;
    }

    await this.executeTask(task);
  }

  /**
   * 获取执行器状态
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * 调度下一次轮询
   */
  private schedulePoll(): void {
    if (!this.running) {
      return;
    }

    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll();
    }, this.pollInterval);
  }

  /**
   * 轮询待执行任务
   */
  private async poll(): Promise<void> {
    try {
      const tasks = await this.taskQueue.listTasks({
        status: 'pending',
        limit: 10,
        orderBy: 'createdAt',
        order: 'asc',
      });

      for (const task of tasks) {
        await this.executeTask(task);
      }
    } catch (error) {
      this.logger.error(`Poll error: ${error}`);
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(task: Task): Promise<void> {
    const agent = this.agents.get(task.agent);

    if (!agent) {
      this.logger.error(`No agent registered for: ${task.agent}`);
      await this.taskQueue.updateTaskStatus(task.id, 'failed', {
        error: `No agent registered for: ${task.agent}`,
      });
      return;
    }

    // 更新状态为执行中
    await this.taskQueue.updateTaskStatus(task.id, 'running');

    // 创建执行上下文
    const context = this.createContext(task);

    try {
      this.logger.info(`Executing task ${task.id} with agent ${task.agent}`);

      const result = await agent.execute(task.message, context);

      if (result.success) {
        await this.taskQueue.updateTaskStatus(task.id, 'completed', {
          result: result.data,
        });
        this.logger.info(`Task ${task.id} completed`);
      } else {
        await this.taskQueue.updateTaskStatus(task.id, 'failed', {
          error: result.error,
        });
        this.logger.warn(`Task ${task.id} failed: ${result.error}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.taskQueue.updateTaskStatus(task.id, 'failed', {
        error: errorMsg,
      });
      this.logger.error(`Task ${task.id} error: ${errorMsg}`);
    }
  }

  /**
   * 创建 Agent 执行上下文
   */
  private createContext(task: Task): AgentContext {
    return {
      taskId: task.id,
      podBaseUrl: this.podBaseUrl,
      getAuthenticatedFetch: this.getAuthenticatedFetch,
      updateStatus: async (status) => {
        await this.taskQueue.updateTaskStatus(task.id, status);
      },
      log: {
        debug: (msg) => this.logger.debug(`[${task.id}] ${msg}`),
        info: (msg) => this.logger.info(`[${task.id}] ${msg}`),
        warn: (msg) => this.logger.warn(`[${task.id}] ${msg}`),
        error: (msg) => this.logger.error(`[${task.id}] ${msg}`),
      },
    };
  }
}
