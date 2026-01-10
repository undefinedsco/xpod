/**
 * FileSystemTaskQueue 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileSystemTaskQueue } from '../../src/task/FileSystemTaskQueue';
import type { Task } from '../../src/task/types';

// Mock fetch responses
function createMockFetch(responses: Map<string, { status: number; body?: any; headers?: Record<string, string> }>) {
  return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method}:${url}`;

    // 查找精确匹配
    let response = responses.get(key);

    // 如果没有精确匹配，尝试前缀匹配（用于容器列表）
    if (!response) {
      for (const [pattern, resp] of responses.entries()) {
        if (key.startsWith(pattern.replace('*', ''))) {
          response = resp;
          break;
        }
      }
    }

    if (!response) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '',
      };
    }

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.status === 200 ? 'OK' : 'Error',
      headers: new Headers(response.headers ?? {}),
      json: async () => response!.body,
      text: async () => typeof response!.body === 'string' ? response!.body : JSON.stringify(response!.body),
    };
  });
}

describe('FileSystemTaskQueue', () => {
  const podBaseUrl = 'http://localhost:3000/alice/';
  let mockFetch: ReturnType<typeof vi.fn>;
  let queue: FileSystemTaskQueue;
  let storedTasks: Map<string, Task>;

  beforeEach(() => {
    storedTasks = new Map();

    // 创建一个更智能的 mock fetch，模拟文件系统行为
    mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (method === 'PUT') {
        // 存储任务
        const body = init?.body as string;
        const task = JSON.parse(body) as Task;
        storedTasks.set(url, task);
        return {
          ok: true,
          status: 201,
          statusText: 'Created',
          headers: new Headers(),
        };
      }

      if (method === 'DELETE') {
        storedTasks.delete(url);
        return {
          ok: true,
          status: 204,
          statusText: 'No Content',
          headers: new Headers(),
        };
      }

      if (method === 'GET') {
        // 检查是否是容器请求
        if (url.endsWith('/')) {
          // 列出容器内容
          const containedUrls: string[] = [];
          for (const taskUrl of storedTasks.keys()) {
            if (taskUrl.startsWith(url)) {
              containedUrls.push(taskUrl);
            }
          }

          const turtleBody = containedUrls
            .map(u => `<${url}> <http://www.w3.org/ns/ldp#contains> <${u}> .`)
            .join('\n');

          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': 'text/turtle' }),
            text: async () => turtleBody,
          };
        }

        // 读取单个任务
        const task = storedTasks.get(url);
        if (task) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            json: async () => task,
          };
        }

        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers(),
        };
      }

      return {
        ok: false,
        status: 405,
        statusText: 'Method Not Allowed',
        headers: new Headers(),
      };
    });

    queue = new FileSystemTaskQueue({
      podBaseUrl,
      authFetch: mockFetch as unknown as typeof fetch,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    storedTasks.clear();
  });

  describe('createTask', () => {
    it('should create a task and write to pending directory', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: { model: 'text-embedding-004' },
      });

      expect(task.id).toMatch(/^task-/);
      expect(task.type).toBe('index');
      expect(task.status).toBe('pending');
      expect(task.target).toBe('/alice/docs/file.pdf');
      expect(task.retryCount).toBe(0);

      // 验证 fetch 被调用写入文件
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('tasks/pending/'),
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should use custom priority and maxRetries', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/urgent.pdf',
        podBaseUrl,
        payload: {},
        priority: 'urgent',
        maxRetries: 5,
      });

      expect(task.priority).toBe('urgent');
      expect(task.maxRetries).toBe(5);
    });
  });

  describe('getTask', () => {
    it('should find task in pending directory', async () => {
      const created = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      const found = await queue.getTask(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent task', async () => {
      const found = await queue.getTask('non-existent-task');
      expect(found).toBeNull();
    });
  });

  describe('updateTaskStatus', () => {
    it('should move task from pending to running', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.updateTaskStatus(task.id, 'running', {
        startedAt: new Date().toISOString(),
      });

      const updated = await queue.getTask(task.id);
      expect(updated?.status).toBe('running');
      expect(updated?.startedAt).toBeDefined();
    });

    it('should throw error for non-existent task', async () => {
      await expect(
        queue.updateTaskStatus('non-existent', 'running'),
      ).rejects.toThrow('Task non-existent not found');
    });
  });

  describe('updateTaskProgress', () => {
    it('should update task progress', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.updateTaskProgress(task.id, 50);

      const updated = await queue.getTask(task.id);
      expect(updated?.progress).toBe(50);
    });

    it('should clamp progress to 0-100', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.updateTaskProgress(task.id, 150);
      let updated = await queue.getTask(task.id);
      expect(updated?.progress).toBe(100);

      await queue.updateTaskProgress(task.id, -10);
      updated = await queue.getTask(task.id);
      expect(updated?.progress).toBe(0);
    });
  });

  describe('deleteTask', () => {
    it('should delete existing task', async () => {
      const task = await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.deleteTask(task.id);

      const found = await queue.getTask(task.id);
      expect(found).toBeNull();
    });

    it('should not throw for non-existent task', async () => {
      await expect(queue.deleteTask('non-existent')).resolves.not.toThrow();
    });
  });

  describe('findPendingTask', () => {
    it('should find pending task by target and type', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      const found = await queue.findPendingTask('/alice/docs/file.pdf', 'index');
      expect(found).not.toBeNull();
      expect(found?.target).toBe('/alice/docs/file.pdf');
    });

    it('should return null if no matching task', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      // 不同的 target
      const found1 = await queue.findPendingTask('/alice/docs/other.pdf', 'index');
      expect(found1).toBeNull();

      // 不同的 type
      const found2 = await queue.findPendingTask('/alice/docs/file.pdf', 'todo');
      expect(found2).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('should list tasks by status', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file1.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file2.pdf',
        podBaseUrl,
        payload: {},
      });

      const pendingTasks = await queue.listTasks('pending');
      expect(pendingTasks).toHaveLength(2);
    });

    it('should filter by type', async () => {
      await queue.createTask({
        type: 'index',
        target: '/alice/docs/file.pdf',
        podBaseUrl,
        payload: {},
      });

      await queue.createTask({
        type: 'todo',
        target: '/alice/todos/item1',
        podBaseUrl,
        payload: {},
      });

      const indexTasks = await queue.listTasks('pending', { type: 'index' });
      expect(indexTasks).toHaveLength(1);
      expect(indexTasks[0].type).toBe('index');
    });
  });
});
