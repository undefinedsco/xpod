import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer, RouteHandler } from '../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { registerTaskRoutes, type TaskHandlerOptions } from '../../src/api/handlers/TaskHandler';
import { TaskStatus, TaskTriggerKind } from '../../src/api/tasks/schema';

const owner = 'https://pod.test/alice/profile/card#me';
const workspace = 'https://pod.test/work/';

function setup(extra: Partial<TaskHandlerOptions> = {}) {
  const store = new InMemoryStore<StoreContext>();
  const service = new TaskService({ store, executeRuns: false });
  const routes = new Map<string, RouteHandler>();
  const server = Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path: string, handler: RouteHandler) => routes.set(`${method} ${path}`, handler)])) as unknown as ApiServer;
  registerTaskRoutes(server, { taskService: service, runStore: store, ...extra });
  return {
    store, service,
    async request(method: string, path: string, input?: unknown, authenticated = true) {
      const request = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]) as AuthenticatedRequest;
      request.url = path; if (authenticated) request.auth = { type: 'solid', webId: owner };
      let status = 0; let body: any;
      const response = { set statusCode(code: number) { status = code; }, setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (data: string) => { body = JSON.parse(data); } } as unknown as ServerResponse;
      await routes.get(`${method} ${path.split('?')[0]}`)!(request, response, {});
      return { status, body };
    },
  };
}

describe('POST /api/tasks/run authority and freshness', () => {
  it('preserves a schedule pause made while resolving the execution identity', async () => {
    const app = setup({
      resolveExecutionContext: async (task, context) => {
        await app.service.setSchedulePaused(task.id, true, context);
        return context;
      },
    });
    // Pod reads return snapshots, not a shared mutable in-memory reference.
    const readTask = app.store.loadTask.bind(app.store);
    vi.spyOn(app.store, 'loadTask').mockImplementation(async (id, context) => ({ ...await readTask(id, context) }));
    const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner } };
    const created = await app.service.createTask({
      prompt: 'Run once', workspace, triggerKind: TaskTriggerKind.INTERVAL, intervalSeconds: 3600,
      authBinding: { id: 'task-auth-1', kind: 'solid-client-credentials', webId: owner, clientId: 'c', status: 'active', createdAt: 1 },
    }, context);

    const response = await app.request('post', `/api/tasks/run?id=${encodeURIComponent(created.task.id)}`, {});
    expect(response.status).toBe(200);
    expect((await app.store.loadTask(created.task.id, context)).status).toBe(TaskStatus.BLOCKED);
  });

  it('materializes the Run through the granted execution credential, never the caller snapshot', async () => {
    const savedContexts: StoreContext[] = [];
    const app = setup({
      resolveExecutionContext: async (task, context) => {
        savedContexts.push(context);
        return {
          ...context,
          auth: { type: 'solid', webId: owner, clientId: 'agent-client', clientSecret: 'agent-secret', viaApiKey: true },
        };
      },
    });
    const created = await app.service.createTask({
      prompt: 'Run once', workspace, triggerKind: TaskTriggerKind.INTERVAL, intervalSeconds: 3600,
      authBinding: { id: 'task-auth-1', kind: 'solid-client-credentials', webId: owner, clientId: 'c', status: 'active', createdAt: 1 },
    }, { userId: owner, auth: { type: 'solid', webId: owner } });

    const runContexts: StoreContext[] = [];
    vi.spyOn(app.store, 'saveRun').mockImplementation(async (run, context) => { runContexts.push(context); });

    const response = await app.request('post', `/api/tasks/run?id=${encodeURIComponent(created.task.id)}`, {});
    expect(response.status).toBe(200);
    // The Run and its Task side effects are persisted under the agent's own grant, so a distinct
    // execution identity is exercised rather than the human caller's request credential.
    expect(runContexts).not.toHaveLength(0);
    for (const context of runContexts) {
      expect((context.auth as { clientId?: string }).clientId).toBe('agent-client');
    }
  });
});
