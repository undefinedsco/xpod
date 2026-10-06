import { withTaskResumeStage, getTaskResumeStage } from '../../src/api/tasks/TaskResumeDiagnostics';
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
  return { store, service, async request(method: string, path: string, input?: unknown, authenticated = true, raw = false) {
    const request = Readable.from(input === undefined ? [] : [Buffer.from(raw ? String(input) : JSON.stringify(input))]) as AuthenticatedRequest;
    request.url = path; if (authenticated) request.auth = { type: 'solid', webId: owner };
    let status = 0; let body: any;
    const response = { set statusCode(code: number) { status = code; }, setHeader: vi.fn(), writeHead: (code: number) => { status = code; }, end: (data: string) => { body = JSON.parse(data); } } as unknown as ServerResponse;
    await routes.get(`${method} ${path.split('?')[0]}`)!(request, response, {});
    return { status, body };
  } };
}
describe('public Pod task routes', () => {
  it('adds fixed stages only to resume400 without changing messages or mapped Pod failures', async () => {
    const app = setup();
    expect(await app.request('post', '/api/tasks/resume', {})).toEqual({ status: 400, body: { error: 'Approval is required', taskResumeStage: 'route_validation', taskResumeErrorType: 'error', taskResumeFailure: { name: 'Error' } } });
    expect(await app.request('post', '/api/tasks/resume', '{bad', true, true)).toMatchObject({ status: 400, body: { taskResumeStage: 'route_validation', taskResumeErrorType: 'syntax_error' } });
    expect(await app.request('post', '/api/tasks/resume', { approval: 'approval' })).toEqual({ status: 400, body: { error: 'Resource id is required', taskResumeStage: 'route_validation', taskResumeErrorType: 'error', taskResumeFailure: { name: 'Error' } } });
    const error = new Error('generic');
    vi.spyOn(app.store, 'loadRun').mockRejectedValueOnce(error);
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' })).toEqual({ status: 400, body: { error: 'generic', taskResumeStage: 'route_run_read', taskResumeErrorType: 'error', taskResumeFailure: { name: 'Error' } } });
    vi.spyOn(app.store, 'loadRun').mockRejectedValueOnce('primitive');
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' })).toEqual({ status: 400, body: { error: 'Task request failed', taskResumeStage: 'route_request', taskResumeErrorType: 'non_error' } });
    vi.spyOn(app.store, 'loadRun').mockRejectedValueOnce(new Error('caller_dpop_replay_unsupported'));
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' })).toEqual({ status: 403, body: { error: 'service_access_missing' } });
    vi.spyOn(app.store, 'loadRun').mockRejectedValueOnce(new Error('caller_pod_access_unavailable'));
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' })).toEqual({ status: 401, body: { error: 'authentication_required' } });
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' }, false)).toEqual({ status: 401, body: { error: 'Authentication required' } });
    vi.spyOn(app.service, 'listTasks').mockRejectedValueOnce(error);
    expect(await app.request('get', '/api/tasks')).toEqual({ status: 400, body: { error: 'generic' } });
  });
  it('projects only trusted inner service stages and preserves built-in error identity', async () => {
    const app = setup();
    const error = Object.freeze(Object.assign(new TypeError('original service failure'), { taskResumeStage: 'forged', name: 'secret-name' }));
    await withTaskResumeStage('task_auth_restore', async () => { throw error; }).catch(() => undefined);
    vi.spyOn(app.store, 'loadRun').mockResolvedValueOnce({ id: 'run' } as never);
    vi.spyOn(app.service, 'resumeApprovedRun').mockRejectedValueOnce(error);
    expect(await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' })).toEqual({ status: 400, body: { error: 'original service failure', taskResumeStage: 'task_auth_restore', taskResumeErrorType: 'type_error', taskResumeFailure: { name: 'TypeError' } } });
  });
  it('adds bounded attribution without changing the original400 error response', async () => {
    const app = setup();
    const error = new Error('original private message');
    Object.defineProperty(error, 'stack', { value: 'Error: original private message\n    at async resume (/app/dist/api/runs/RunStateCenter.js:461:15)' });
    Object.assign(error, { code: 'ECONNRESET', cause: Object.assign(new Error('private cause'), { code: 'ECONNREFUSED' }) });
    Object.freeze(error);
    await withTaskResumeStage('continuation_complete', async () => { throw error; }).catch(() => undefined);
    vi.spyOn(app.store, 'loadRun').mockResolvedValueOnce({ id: 'run' } as never);
    vi.spyOn(app.service, 'resumeApprovedRun').mockRejectedValueOnce(error);
    const response = await app.request('post', '/api/tasks/resume?id=run', { approval: 'approval' });
    expect(response).toEqual({ status: 400, body: { error: 'original private message', taskResumeStage: 'continuation_complete', taskResumeErrorType: 'error',
      taskResumeFailure: { name: 'Error', code: 'ECONNRESET', causeCode: 'ECONNREFUSED',
        site: { module: 'api/runs/RunStateCenter', line: 461, column: 15, coordinate: 'compiled_js', kind: 'first_project_frame' } } } });
    expect(JSON.stringify(response.body.taskResumeFailure)).not.toContain('private');
    expect(JSON.stringify(response.body.taskResumeFailure)).not.toContain('/app');
    expect(getTaskResumeStage(error)).toBe('continuation_complete');
  });
  it('keeps create, run, selection, list and Stop on opaque Pod resource ids with an independent card identity', async () => {
    const source = { activeFor: async () => ({ credentialRef: 'taskcred_test', version: 1, clientId: 'agent-key', clientSecret: 'secret' }) };
    const app = setup({ resolveAgentBinding: createGrantedTaskAgentResolver(source),
      resolveExecutionContext: async (_task, caller) => ({ ...caller }),
    });
    const created = await app.request('post', '/api/tasks', { kind: 'interval', prompt: 'Summarize', workspace: 'https://pod.test/work/', intervalSeconds: 3600 });
    expect(created.status).toBe(200);
    const taskId = created.body.task.id as string;
    // The task and its thread are opaque base-relative Pod ids, not the caller's Cloud card IRI.
    const taskParent = taskId.replace(/^index\.ttl#/, '');
    expect(taskId).toMatch(/^index\.ttl#task_/);
    const storedTask = await app.store.loadTask(taskId, { userId: owner });
    expect(storedTask.thread).toMatch(new RegExp(`^task/${taskParent}/index\\.ttl#thread_`));
    expect(storedTask.thread).not.toContain('pod.test');
    expect(storedTask.thread).not.toContain('storage.example');
    const started = await app.request('post', `/api/tasks/run?id=${encodeURIComponent(taskId)}`, {});
    expect(started.status).toBe(200);
    const runId = started.body.run.id as string;
    expect(await app.store.loadRun(runId, { userId: owner })).toMatchObject({ task: taskId, thread: storedTask.thread });
    expect((await app.request('get', `/api/tasks/runs?id=${encodeURIComponent(taskId)}`)).body.runs).toHaveLength(1);
    expect(await app.request('get', `/api/tasks/selection?id=${encodeURIComponent(runId)}`)).toMatchObject({ status: 200, body: { taskId } });
    expect((await app.request('get', '/api/tasks')).body.tasks[0].iri).toBe(taskId);
    expect(await app.request('post', `/api/tasks/stop?id=${encodeURIComponent(runId)}`, {})).toMatchObject({ status: 200, body: { run: { status: 'cancelled' } } });
    const steps = await app.store.loadRunSteps(runId, { userId: owner });
    expect(steps.map(step => step.type)).toEqual(['run.created', 'run.cancel_requested', 'run.cancelled']);
    expect(steps.every(step => step.run === runId)).toBe(true);
    const run = await app.store.loadRun(runId, { userId: owner });
    const storageRelations = [storedTask.thread, run.task, run.thread, ...steps.map(step => step.run)]
      .filter((relation): relation is string => typeof relation === 'string');
    expect(storageRelations.every(relation => !relation.includes('pod.test'))).toBe(true);
  });

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
