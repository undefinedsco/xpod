import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ApiServer, RouteHandler } from '../../src/api/ApiServer';
import type { AuthenticatedRequest } from '../../src/api/middleware/AuthMiddleware';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { registerTaskRoutes, type TaskHandlerOptions } from '../../src/api/handlers/TaskHandler';
import { createGrantedTaskAgentResolver } from '../../src/api/tasks/TaskAgentBinding';
const owner = 'https://pod.test/alice/profile/card#me';
function setup(extra: Partial<TaskHandlerOptions> = {}) {
  const store = new InMemoryStore<StoreContext>();
  const service = new TaskService({ store, executeRuns: false });
  const routes = new Map<string, RouteHandler>();
  const server = Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path: string, handler: RouteHandler) => routes.set(`${method} ${path}`, handler)])) as unknown as ApiServer;
  registerTaskRoutes(server, { taskService: service, runStore: store, ...extra });
  return { store, service, async request(method: string, path: string, input?: unknown, authenticated = true) {
    const request = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))]) as AuthenticatedRequest;
    request.url = path; if (authenticated) request.auth = { type: 'solid', webId: owner };
    let status = 0; let body: any;
    const response = { set statusCode(code: number) { status = code; }, setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (data: string) => { body = JSON.parse(data); } } as unknown as ServerResponse;
    await routes.get(`${method} ${path.split('?')[0]}`)!(request, response, {});
    return { status, body };
  } };
}
describe('public Pod task routes', () => {
  it('returns the Pod authorization retry code for a caller DPoP replay failure', async () => {
    const app = setup();
    vi.spyOn(app.service, 'listTasks').mockRejectedValueOnce(new Error('caller_dpop_replay_unsupported'));
    expect(await app.request('get', '/api/tasks')).toEqual({ status: 403, body: { error: 'service_access_missing' } });
  });
  it('requires a Solid identity and persists todos under that owner', async () => {
    const app = setup();
    expect((await app.request('get', '/api/tasks', undefined, false)).status).toBe(401);
    const created = await app.request('post', '/api/tasks', { kind: 'todo', prompt: 'Read', workspace: 'https://pod.test/work/', dueAt: 1234 });
    expect(created.status).toBe(200); expect(created.body.task.assignedTo).toBe(owner);
    const list = await app.request('get', '/api/tasks'); expect(list.body.tasks).toHaveLength(1);
    expect(list.body.capabilities.createAi).toBe(false);
    const edited = await app.request('patch', `/api/tasks?id=${encodeURIComponent(created.body.task.id)}`, { completed: true });
    expect(edited.body.task.completedAt).toBeTypeOf('number');
    expect((await app.request('patch', `/api/tasks?id=${encodeURIComponent(created.body.task.id)}`, { completed: 'yes' })).status).toBe(400);
  });
  it('uses the prior explicit agent grant with the same Pod owner, never the caller bearer', async () => {
    const source = { activeFor: vi.fn(async () => ({ credentialRef: 'taskcred_test', version: 1, clientId: 'agent-key', clientSecret: 'secret' })) };
    const app = setup({ resolveAgentBinding: createGrantedTaskAgentResolver(source) });
    const created = await app.request('post', '/api/tasks', { kind: 'interval', prompt: 'Summarize', workspace: 'https://pod.test/work/', intervalSeconds: 3600 });
    expect(created.status).toBe(200); expect(created.body.task.assignedTo).toBe('urn:xpod:agent:pi');
    expect(JSON.stringify(created.body)).not.toContain('secret'); expect(JSON.stringify(created.body)).not.toContain('agent-key');
    expect((await app.request('post', `/api/tasks/run?id=${encodeURIComponent(created.body.task.id)}`, {})).status).toBe(400);
  });
  it('does not offer immediate one-shot creation or silently execute without a grant', async () => {
    const app = setup({ resolveAgentBinding: async () => undefined });
    expect((await app.request('get', '/api/tasks')).body.capabilities.createAi).toBe(false);
    expect((await app.request('post', '/api/tasks', { kind: 'once', prompt: 'Execute', workspace: 'https://pod.test/work/' })).status).toBe(400);
    expect((await app.request('post', '/api/tasks', { kind: 'cron', prompt: 'Execute', workspace: 'https://pod.test/work/', cron: '0 9 * * *' })).status).toBe(400);
  });
});
