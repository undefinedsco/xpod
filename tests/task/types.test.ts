/**
 * Task System 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  CreateTaskInput,
  TaskHandler,
  TaskResult,
  TaskExecutionContext,
  TaskQueue,
  TaskQueueStats,
} from '../../src/task/types';

// ============================================
// Mock 实现用于测试
// ============================================

/**
 * 内存任务队列实现（用于测试）
 */
class InMemoryTaskQueue implements TaskQueue {
  private tasks = new Map<string, Task>();
  private idCounter = 0;

  async createTask<T>(input: CreateTaskInput<T>): Promise<Task<T>> {
    const id = `task-${++this.idCounter}`;
    const now = new Date().toISOString();

    const task: Task<T> = {
      id,
      type: input.type,
      status: 'pending',
      priority: input.priority ?? 'normal',
      target: input.target,
      podBaseUrl: input.podBaseUrl,
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
    };

    this.tasks.set(id, task as Task);
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async listTasks(status: TaskStatus): Promise<Task[]> {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, updates?: Partial<Task>): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
      task.updatedAt = new Date().toISOString();
      if (updates) {
        Object.assign(task, updates);
      }
    }
  }

  async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.progress = progress;
      task.updatedAt = new Date().toISOString();
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  async getStats(): Promise<TaskQueueStats> {
    const tasks = Array.from(this.tasks.values());
    const byType: Record<string, number> = {};

    for (const task of tasks) {
      byType[task.type] = (byType[task.type] ?? 0) + 1;
    }

    return {
      pending: tasks.filter(t => t.status === 'pending').length,
      running: tasks.filter(t => t.status === 'running').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      total: tasks.length,
      byType,
    };
  }

  async findPendingTask(target: string, type: string): Promise<Task | null> {
    for (const task of this.tasks.values()) {
      if (task.target === target && task.type === type && task.status === 'pending') {
        return task;
      }
    }
    return null;
  }

  // 测试辅助方法
  clear(): void {
    this.tasks.clear();
    this.idCounter = 0;
  }
}

/**
 * 创建 mock 执行上下文
 */
function createMockContext(): TaskExecutionContext {
  return {
    updateProgress: vi.fn().mockResolvedValue(undefined),
    getAuthenticatedFetch: vi.fn().mockResolvedValue(fetch),
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

// ============================================
// 测试
// ============================================

describe('Task System Types', () => {
  let queue: InMemoryTaskQueue;

  beforeEach(() => {
    queue = new InMemoryTaskQueue();
  });

  afterEach(() => {
    queue.clear();
  });

  describe('TaskQueue', () => {
    it('should create a task with default values', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: { model: 'text-embedding-004' },
      });

      expect(task.id).toBe('task-1');
      expect(task.type).toBe('index');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('normal');
      expect(task.retryCount).toBe(0);
      expect(task.maxRetries).toBe(3);
    });

    it('should create a task with custom priority', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/urgent.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
        priority: 'urgent',
        maxRetries: 5,
      });

      expect(task.priority).toBe('urgent');
      expect(task.maxRetries).toBe(5);
    });

    it('should get task by id', async () => {
      const created = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      const retrieved = await queue.getTask(created.id);
      expect(retrieved).toEqual(created);
    });

    it('should return null for non-existent task', async () => {
      const task = await queue.getTask('non-existent');
      expect(task).toBeNull();
    });

    it('should list tasks by status', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file1.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file2.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      const pendingTasks = await queue.listTasks('pending');
      expect(pendingTasks).toHaveLength(2);

      const runningTasks = await queue.listTasks('running');
      expect(runningTasks).toHaveLength(0);
    });

    it('should update task status', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      await queue.updateTaskStatus(task.id, 'running', { startedAt: new Date().toISOString() });

      const updated = await queue.getTask(task.id);
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should update task progress', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      await queue.updateTaskProgress(task.id, 50);

      const updated = await queue.getTask(task.id);
      expect(updated?.progress).toBe(50);
    });

    it('should delete task', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      await queue.deleteTask(task.id);

      const deleted = await queue.getTask(task.id);
      expect(deleted).toBeNull();
    });

    it('should get queue stats', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file1.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      const task2 = await queue.createTask({
        type: 'todo',
        target: '/alice/todos/item1',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      await queue.updateTaskStatus(task2.id, 'completed');

      const stats = await queue.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.total).toBe(2);
      expect(stats.byType['index']).toBe(1);
      expect(stats.byType['todo']).toBe(1);
    });

    it('should find pending task for deduplication', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      const existing = await queue.findPendingTask('/alice/docs/file.pdf', 'index');
      expect(existing).not.toBeNull();

      const notFound = await queue.findPendingTask('/alice/docs/other.pdf', 'index');
      expect(notFound).toBeNull();
    });
  });

  describe('TaskHandler', () => {
    it('should execute task and return result', async () => {
      // 定义一个简单的索引任务处理器
      const indexHandler: TaskHandler<{ model: string }, { vectorId: number }> = {
        type: 'index',
        async execute(task, context) {
          context.log.info(`Indexing ${task.target}`);
          await context.updateProgress(50);

          // 模拟索引操作
          const vectorId = Math.abs(task.target.split('').reduce((a, b) => a + b.charCodeAt(0), 0));

          await context.updateProgress(100);
          return {
            success: true,
            data: { vectorId },
          };
        },
      };

      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: { model: 'text-embedding-004' },
      });

      const context = createMockContext();
      const result = await indexHandler.execute(task as Task<{ model: string }>, context);

      expect(result.success).toBe(true);
      expect(result.data?.vectorId).toBeGreaterThan(0);
      expect(context.updateProgress).toHaveBeenCalledWith(50);
      expect(context.updateProgress).toHaveBeenCalledWith(100);
      expect(context.log.info).toHaveBeenCalled();
    });

    it('should handle task failure with retry', async () => {
      let attempts = 0;

      const failingHandler: TaskHandler<{}, {}> = {
        type: 'flaky',
        async execute(task, context) {
          attempts++;
          if (attempts < 3) {
            return {
              success: false,
              error: `Attempt ${attempts} failed`,
              shouldRetry: true,
            };
          }
          return { success: true };
        },
      };

      const task = await queue.createTask({
        type: 'flaky',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
        maxRetries: 5,
      });

      const context = createMockContext();

      // 模拟重试逻辑
      let result: TaskResult;
      let retryCount = 0;

      do {
        result = await failingHandler.execute(task as Task<{}>, context);
        if (!result.success && result.shouldRetry && retryCount < task.maxRetries) {
          retryCount++;
          task.retryCount = retryCount;
        } else {
          break;
        }
      } while (true);

      expect(result.success).toBe(true);
      expect(attempts).toBe(3);
      expect(retryCount).toBe(2);
    });

    it('should support lifecycle hooks', async () => {
      const onStart = vi.fn();
      const onComplete = vi.fn();
      const onFailed = vi.fn();

      const handlerWithHooks: TaskHandler<{}, { done: boolean }> = {
        type: 'hooked',
        async execute() {
          return { success: true, data: { done: true } };
        },
        onStart,
        onComplete,
        onFailed,
      };

      const task = await queue.createTask({
        type: 'hooked',
        target: '/alice/docs/file.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
      });

      // 模拟执行流程
      await handlerWithHooks.onStart?.(task as Task<{}>);
      const result = await handlerWithHooks.execute(task as Task<{}>, createMockContext());

      if (result.success) {
        await handlerWithHooks.onComplete?.(task as Task<{}>, result);
      } else {
        await handlerWithHooks.onFailed?.(task as Task<{}>, result.error ?? 'Unknown error');
      }

      expect(onStart).toHaveBeenCalledWith(task);
      expect(onComplete).toHaveBeenCalledWith(task, result);
      expect(onFailed).not.toHaveBeenCalled();
    });
  });

  describe('Task Priority', () => {
    it('should sort tasks by priority', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/low.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
        priority: 'low',
      });

      await queue.createTask({
        type: 'index',
        target: '/alice/docs/urgent.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
        priority: 'urgent',
      });

      await queue.createTask({
        type: 'index',
        target: '/alice/docs/normal.pdf',
        podBaseUrl: 'http://localhost:3000/alice/',
        payload: {},
        priority: 'normal',
      });

      const tasks = await queue.listTasks('pending');

      // 按优先级排序
      const priorityOrder: Record<TaskPriority, number> = {
        urgent: 0,
        high: 1,
        normal: 2,
        low: 3,
      };

      const sorted = [...tasks].sort((a, b) =>
        priorityOrder[a.priority] - priorityOrder[b.priority]
      );

      expect(sorted[0].priority).toBe('urgent');
      expect(sorted[1].priority).toBe('normal');
      expect(sorted[2].priority).toBe('low');
    });
  });
});
