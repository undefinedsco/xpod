/**
 * DrizzleTaskQueue - 基于 drizzle-solid 的任务队列
 *
 * 简化模型：消息 + Agent
 *
 * 任务存储在 Pod 的 /tasks/{YYYY-MM-DD}.ttl 中，按天分片
 */

import { getLoggerFor } from 'global-logger-factory';
import { randomBytes } from 'crypto';
import { eq } from '@undefineds.co/drizzle-solid';
import type { SolidDatabase } from '@undefineds.co/drizzle-solid';

import { Task as taskTable, TaskStatus as TaskStatusConst } from './schema';
import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  TaskQueue,
  TaskQueueStats,
  ListTasksOptions,
} from './types';

export interface DrizzleTaskQueueOptions {
  /**
   * Pod base URL
   */
  podBaseUrl: string;
  /**
   * drizzle-solid 数据库实例
   */
  db: SolidDatabase<{ task: typeof taskTable }>;
}

/**
 * 基于 drizzle-solid 的任务队列实现
 */
export class DrizzleTaskQueue implements TaskQueue {
  protected readonly logger = getLoggerFor(this);
  private readonly podBaseUrl: string;
  private readonly db: SolidDatabase<{ task: typeof taskTable }>;

  public constructor(options: DrizzleTaskQueueOptions) {
    this.podBaseUrl = options.podBaseUrl.endsWith('/') ? options.podBaseUrl : `${options.podBaseUrl}/`;
    this.db = options.db;
  }

  /**
   * 创建任务
   */
  public async createTask(input: CreateTaskInput): Promise<Task> {
    const id = this.generateTaskId();
    const now = new Date();

    const taskData = {
      id,
      agent: input.agent,
      message: input.message,
      status: TaskStatusConst.PENDING,
      createdAt: now,
    };

    await this.db.insert(taskTable).values(taskData);

    this.logger.info(`Created task ${id} for agent "${input.agent}"`);

    return {
      id,
      agent: input.agent,
      message: input.message,
      status: 'pending',
      createdAt: now,
    };
  }

  /**
   * 获取任务
   */
  public async getTask(taskId: string): Promise<Task | null> {
    const tasks = await this.db.select().from(taskTable).where(eq(taskTable.id, taskId));

    if (tasks.length === 0) {
      return null;
    }

    return this.dbTaskToTask(tasks[0]);
  }

  /**
   * 获取任务列表
   */
  public async listTasks(options?: ListTasksOptions): Promise<Task[]> {
    let query = this.db.select().from(taskTable);

    // 状态过滤
    if (options?.status) {
      query = query.where(eq(taskTable.status, options.status));
    }

    const tasks = await query;

    // 转换为 Task 接口
    let result = tasks.map((t: Record<string, unknown>) => this.dbTaskToTask(t));

    // Agent 过滤
    if (options?.agent) {
      result = result.filter((t: Task) => t.agent === options.agent);
    }

    // 排序
    if (options?.orderBy) {
      const order = options.order === 'asc' ? 1 : -1;
      result.sort((a: Task, b: Task) => {
        const aVal = a[options.orderBy!];
        const bVal = b[options.orderBy!];
        if (aVal instanceof Date && bVal instanceof Date) {
          return (aVal.getTime() - bVal.getTime()) * order;
        }
        return 0;
      });
    }

    // 分页
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? result.length;
    return result.slice(offset, offset + limit);
  }

  /**
   * 更新任务状态
   */
  public async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    updates?: Partial<Task>,
  ): Promise<void> {
    const now = new Date();

    const updateData: Record<string, unknown> = {
      status,
    };

    // 根据状态设置时间字段
    if (status === 'running') {
      updateData.startedAt = now;
    } else if (status === 'completed' || status === 'failed') {
      updateData.completedAt = now;
    }

    // 合并其他更新
    if (updates) {
      if (updates.result !== undefined) updateData.result = updates.result;
      if (updates.error !== undefined) updateData.error = updates.error;
    }

    await this.db.update(taskTable).set(updateData).where(eq(taskTable.id, taskId));

    this.logger.info(`Task ${taskId} status changed to ${status}`);
  }

  /**
   * 删除任务
   */
  public async deleteTask(taskId: string): Promise<void> {
    await this.db.delete(taskTable).where(eq(taskTable.id, taskId));
    this.logger.info(`Deleted task ${taskId}`);
  }

  /**
   * 获取队列统计
   */
  public async getStats(): Promise<TaskQueueStats> {
    const tasks = await this.db.select().from(taskTable);

    const stats: TaskQueueStats = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: tasks.length,
      byAgent: {},
    };

    for (const task of tasks) {
      const taskRecord = task as Record<string, unknown>;
      const status = (taskRecord.status as TaskStatus) ?? 'pending';
      stats[status]++;

      // 按 Agent 统计
      const agent = taskRecord.agent as string ?? 'unknown';
      stats.byAgent[agent] = (stats.byAgent[agent] ?? 0) + 1;
    }

    return stats;
  }

  // ============================================
  // Private Methods
  // ============================================

  private generateTaskId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return `task-${timestamp}-${random}`;
  }

  /**
   * 将数据库记录转换为 Task 接口
   */
  private dbTaskToTask(dbTask: Record<string, unknown>): Task {
    return {
      id: dbTask.id as string,
      agent: dbTask.agent as string,
      message: dbTask.message as string,
      status: (dbTask.status as TaskStatus) ?? 'pending',
      createdAt: dbTask.createdAt as Date,
      startedAt: dbTask.startedAt as Date | undefined,
      completedAt: dbTask.completedAt as Date | undefined,
      result: dbTask.result as unknown,
      error: dbTask.error as string | undefined,
    };
  }
}
