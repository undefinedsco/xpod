/**
 * FileSystemTaskQueue - 基于文件系统的任务队列
 *
 * 任务存储在 Pod 的 tasks/ 目录下：
 * tasks/
 *   ├─ pending/    待处理任务
 *   ├─ running/    执行中任务
 *   ├─ completed/  已完成任务
 *   └─ failed/     失败任务
 *
 * 每个任务是一个 JSON 文件，文件名为 {taskId}.json
 *
 * 注意：这是一个 per-pod 的任务队列，每个 Pod 有自己的实例。
 */

import { getLoggerFor } from 'global-logger-factory';
import { randomBytes } from 'crypto';
import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  TaskQueue,
  TaskQueueStats,
  ListTasksOptions,
} from './types';

/**
 * 任务目录名称
 */
const STATUS_DIRS: Record<TaskStatus, string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};

export interface FileSystemTaskQueueOptions {
  /**
   * Pod base URL（每个 Pod 一个队列实例）
   */
  podBaseUrl: string;
  /**
   * 认证 fetch 函数
   */
  authFetch: typeof fetch;
}

/**
 * 基于文件系统的任务队列实现（per-pod）
 */
export class FileSystemTaskQueue implements TaskQueue {
  protected readonly logger = getLoggerFor(this);
  private readonly podBaseUrl: string;
  private readonly authFetch: typeof fetch;

  public constructor(options: FileSystemTaskQueueOptions) {
    this.podBaseUrl = options.podBaseUrl.endsWith('/') ? options.podBaseUrl : `${options.podBaseUrl}/`;
    this.authFetch = options.authFetch;
  }

  /**
   * 创建任务
   */
  public async createTask<T>(input: CreateTaskInput<T>): Promise<Task<T>> {
    const id = this.generateTaskId();
    const now = new Date().toISOString();

    const task: Task<T> = {
      id,
      type: input.type,
      status: 'pending',
      priority: input.priority ?? 'normal',
      target: input.target,
      podBaseUrl: this.podBaseUrl,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
    };

    // 写入文件
    await this.writeTask(task);

    this.logger.info(`Created task ${id} of type ${input.type} for ${input.target}`);
    return task;
  }

  /**
   * 获取任务
   */
  public async getTask(taskId: string): Promise<Task | null> {
    // 在所有状态目录中查找
    for (const status of Object.keys(STATUS_DIRS) as TaskStatus[]) {
      const task = await this.readTaskFromStatus(taskId, status);
      if (task) {
        return task;
      }
    }
    return null;
  }

  /**
   * 获取指定状态的任务列表
   */
  public async listTasks(status: TaskStatus, options?: ListTasksOptions): Promise<Task[]> {
    const containerPath = `${this.podBaseUrl}tasks/${STATUS_DIRS[status]}/`;

    try {
      // 获取容器内容（Solid 容器返回 Turtle 格式）
      const response = await this.authFetch(containerPath, {
        headers: {
          Accept: 'application/ld+json, text/turtle',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return []; // 目录不存在
        }
        throw new Error(`Failed to list tasks: ${response.status}`);
      }

      // 解析容器内容，提取任务文件 URL
      const contentType = response.headers.get('Content-Type') ?? '';
      const body = await response.text();
      const taskUrls = this.parseContainerContents(body, contentType, containerPath);

      // 读取每个任务文件
      const tasks: Task[] = [];
      for (const url of taskUrls) {
        if (!url.endsWith('.json')) continue;

        try {
          const taskResponse = await this.authFetch(url);
          if (taskResponse.ok) {
            const task = await taskResponse.json() as Task;

            // 应用过滤条件
            if (options?.type && task.type !== options.type) continue;

            tasks.push(task);
          }
        } catch {
          this.logger.warn(`Failed to read task from ${url}`);
        }
      }

      // 排序
      if (options?.orderBy) {
        const order = options.order === 'asc' ? 1 : -1;
        tasks.sort((a, b) => {
          const aVal = a[options.orderBy!] as string;
          const bVal = b[options.orderBy!] as string;
          return aVal < bVal ? -order : aVal > bVal ? order : 0;
        });
      }

      // 分页
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? tasks.length;
      return tasks.slice(offset, offset + limit);
    } catch (error) {
      this.logger.error(`Failed to list tasks: ${error}`);
      return [];
    }
  }

  /**
   * 更新任务状态
   */
  public async updateTaskStatus(taskId: string, newStatus: TaskStatus, updates?: Partial<Task>): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const oldStatus = task.status;

    // 更新任务数据
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    if (updates) {
      Object.assign(task, updates);
    }

    // 如果状态变化，需要移动文件（先写新位置，再删旧位置）
    if (oldStatus !== newStatus) {
      await this.writeTask(task);
      await this.deleteTaskFile(taskId, oldStatus);
    } else {
      await this.writeTask(task);
    }

    this.logger.info(`Task ${taskId} status changed: ${oldStatus} -> ${newStatus}`);
  }

  /**
   * 更新任务进度
   */
  public async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.progress = Math.min(100, Math.max(0, progress));
    task.updatedAt = new Date().toISOString();

    await this.writeTask(task);
  }

  /**
   * 删除任务
   */
  public async deleteTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      return; // 任务不存在，静默返回
    }

    await this.deleteTaskFile(taskId, task.status);
    this.logger.info(`Deleted task ${taskId}`);
  }

  /**
   * 获取队列统计
   */
  public async getStats(): Promise<TaskQueueStats> {
    const stats: TaskQueueStats = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      total: 0,
      byType: {},
    };

    for (const status of Object.keys(STATUS_DIRS) as TaskStatus[]) {
      const tasks = await this.listTasks(status);
      stats[status] = tasks.length;
      stats.total += tasks.length;

      for (const task of tasks) {
        stats.byType[task.type] = (stats.byType[task.type] ?? 0) + 1;
      }
    }

    return stats;
  }

  /**
   * 查找目标的待处理任务（用于去重）
   */
  public async findPendingTask(target: string, type: string): Promise<Task | null> {
    const pendingTasks = await this.listTasks('pending', { type });
    return pendingTasks.find(t => t.target === target) ?? null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private generateTaskId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return `task-${timestamp}-${random}`;
  }

  private getTaskPath(taskId: string, status: TaskStatus): string {
    return `${this.podBaseUrl}tasks/${STATUS_DIRS[status]}/${taskId}.json`;
  }

  private async writeTask(task: Task): Promise<void> {
    const path = this.getTaskPath(task.id, task.status);

    const response = await this.authFetch(path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(task, null, 2),
    });

    if (!response.ok) {
      throw new Error(`Failed to write task ${task.id}: ${response.status} ${response.statusText}`);
    }
  }

  private async readTaskFromStatus(taskId: string, status: TaskStatus): Promise<Task | null> {
    const path = this.getTaskPath(taskId, status);

    try {
      const response = await this.authFetch(path, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      return await response.json() as Task;
    } catch {
      return null;
    }
  }

  private async deleteTaskFile(taskId: string, status: TaskStatus): Promise<void> {
    const path = this.getTaskPath(taskId, status);

    const response = await this.authFetch(path, {
      method: 'DELETE',
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete task file ${path}: ${response.status}`);
    }
  }

  /**
   * 解析容器内容，提取包含的资源 URL
   */
  private parseContainerContents(body: string, contentType: string, containerUrl: string): string[] {
    const urls: string[] = [];

    if (contentType.includes('application/ld+json')) {
      try {
        const json = JSON.parse(body);
        const contains = json['ldp:contains'] ?? json['contains'] ?? [];
        const items = Array.isArray(contains) ? contains : [contains];
        for (const item of items) {
          const url = typeof item === 'string' ? item : item['@id'];
          if (url) urls.push(url);
        }
      } catch {
        // 解析失败
      }
    } else if (contentType.includes('text/turtle')) {
      // 简单解析 Turtle 中的 ldp:contains
      const regex = /ldp:contains\s+<([^>]+)>/g;
      let match;
      while ((match = regex.exec(body)) !== null) {
        urls.push(match[1]);
      }
    }

    // 如果没有解析到，尝试从 Link header 或其他方式获取
    // 这里简化处理，实际可能需要更复杂的解析

    return urls;
  }
}
