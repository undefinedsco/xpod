import { projectTaskRunFailureDiagnostic } from '../tasks/TaskRunFailureDiagnostic';
import type { ServerResponse } from 'node:http';
import { runResource, taskResource } from '@undefineds.co/models';
import type { ApiServer, RouteHandler } from '../ApiServer';
import type { AuthenticatedRequest } from '../middleware/AuthMiddleware';
import type { StoreContext } from '../chatkit/store';
import type { TaskService } from '../tasks/TaskService';
import type { TaskAuthBindingSnapshot } from '../tasks/TaskAuthBinding';
import type { TaskRecordData } from '../tasks/store';
import type { RunRecordData, RunStore } from '../runs/store';
import { cancelRun } from '../runs/RunCancellation';
import { sendPodAccessFailure } from './PodAccessFailureResponse';

export interface TaskHandlerOptions {
  taskService: TaskService<StoreContext>;
  runStore: RunStore<StoreContext>;
  resolveExecutionContext?: (task: TaskRecordData, caller: StoreContext) => Promise<StoreContext | undefined>;
  /** Agent identity and its own granted credential; never inferred from the human's key. */
  resolveAgentBinding?: (request: AuthenticatedRequest) => Promise<{
    assignedTo: string; authBinding: TaskAuthBindingSnapshot;
  } | undefined>;
}

/** UI reads durable Pod projections; the scheduler is never a query backend. */
export function registerTaskRoutes(server: ApiServer, options: TaskHandlerOptions): void {
  const guarded = (handler: (request: AuthenticatedRequest, context: StoreContext, owner: string) => Promise<unknown>): RouteHandler =>
    async (request, response) => {
      if (request.auth?.type !== 'solid') { send(response, 401, { error: 'Authentication required' }); return; }
      try {
        send(response, 200, await handler(request, { userId: request.auth.webId, auth: request.auth }, request.auth.webId));
      } catch (error) {
        if (sendPodAccessFailure(response, error)) return;
        send(response, 400, { error: error instanceof Error ? error.message : 'Task request failed' });
      }
    };
  const idOf = (request: AuthenticatedRequest): string => {
    const id = new URL(request.url ?? '', 'http://localhost').searchParams.get('id');
    if (!id) throw new Error('Resource id is required');
    return id;
  };
  server.get('/api/tasks', guarded(async (_request, context, owner) => {
    const [tasks, waiting] = await Promise.all([
      options.taskService.listTasks(context), options.runStore.listRuns({ status: 'waiting_input' }, context),
    ]);
    const waitingTasks = new Set(waiting.map(run => run.task));
    return {
      tasks: tasks.map(task => ({ ...projectTask(task), iri: taskResource.buildIri(owner, { id: task.id }), waiting: waitingTasks.has(taskResource.buildIri(owner, { id: task.id })) })),
      capabilities: { createAi: Boolean(await options.resolveAgentBinding?.(_request).catch(() => undefined)), resumeStep: false, handoff: false, approve: true },
    };
  }));
  server.post('/api/tasks', guarded(async (request, context, owner) => {
    const input = await body(request);
    const prompt = requiredString(input.prompt, 'Instruction');
    const workspace = requiredString(input.workspace, 'Workspace');
    if (input.kind === 'todo') {
      return { task: projectTask(await options.taskService.createTodo({
        prompt, workspace, assignedTo: owner,
        dueAt: optionalTimestamp(input.dueAt),
        notes: optionalString(input.notes), priority: optionalString(input.priority), source: optionalUri(input.source),
      }, context)) };
    }
    if (!options.resolveAgentBinding) throw new Error('代理执行身份待接入');
    if (input.kind !== 'cron' && input.kind !== 'interval' && input.kind !== 'event') throw new Error('Choose cron, interval or event');
    const binding = await options.resolveAgentBinding(request);
    if (!binding) throw new Error('代理执行凭据尚未授权');
    if (binding.assignedTo === owner) throw new Error('AI tasks must be assigned to the agent');
    if (binding.authBinding.webId !== owner) throw new Error('Task credential belongs to another Pod owner');
    const result = await options.taskService.createTask({
      prompt, title: prompt, workspace, ...binding, triggerKind: input.kind, source: optionalUri(input.source),
      cron: optionalString(input.cron), intervalSeconds: optionalTimestamp(input.intervalSeconds),
      eventName: optionalString(input.eventName),
    }, context);
    return { task: projectTask(result.task) };
  }));
  server.patch('/api/tasks', guarded(async (request, context, owner) => {
    const input = await body(request);
    if (input.completed !== undefined && typeof input.completed !== 'boolean') throw new Error('completed must be boolean');
    return { task: projectTask(await options.taskService.updateTodo(idOf(request), owner, {
      completed: input.completed as boolean | undefined,
      dueAt: input.dueAt === null ? null : optionalTimestamp(input.dueAt),
      notes: optionalString(input.notes), priority: optionalString(input.priority),
    }, context)) };
  }));
  server.post('/api/tasks/pause', guarded(async (request, context) => {
    const input = await body(request);
    if (typeof input.paused !== 'boolean') throw new Error('paused must be boolean');
    return { task: projectTask(await options.taskService.setSchedulePaused(idOf(request), input.paused, context)) };
  }));
  server.post('/api/tasks/run', guarded(async (request, context) => {
    const task = await options.taskService.loadTask(idOf(request), context);
    const execution = await options.resolveExecutionContext?.(task, context);
    if (!execution) throw new Error('代理执行凭据待接入或已失效');
    // Re-read under the execution context: resolving the identity above may have changed the Task
    // (for example a pause), and the run must materialize from the freshest persisted state.
    const result = await options.taskService.runNow(task.id, execution);
    return { task: projectTask(result.task), run: projectRun(result.run) };
  }));
  server.get('/api/tasks/runs', guarded(async (request, context, owner) => {
    const task = await options.taskService.loadTask(idOf(request), context);
    const iri = taskResource.buildIri(owner, { id: task.id });
    return { runs: (await options.runStore.listRuns({ task: iri }, context)).map(projectRun) };
  }));
  server.post('/api/tasks/resume', guarded(async (request, context, owner) => {
    const input = await body(request);
    const approval = requiredString(input.approval, 'Approval');
    const target = idOf(request);
    const run = /^https?:\/\//.test(target)
      ? (await options.runStore.listRuns({}, context)).find(item => runResource.buildIri(owner, { id: item.id }) === target)
      : await options.runStore.loadRun(target, context);
    if (!run) throw new Error('Run not found');
    const result = await options.taskService.resumeApprovedRun({ runId: run.id, approval, owner }, context, options.resolveExecutionContext);
    return { ...result, run: projectRun(result.run) };
  }));
  server.get('/api/tasks/selection', guarded(async (request, context, owner) => {
    const target = idOf(request);
    const runs = await options.runStore.listRuns({}, context);
    const run = runs.find(item => item.id === target || runResource.buildIri(owner, { id: item.id }) === target);
    if (!run) throw new Error('Run not found');
    const tasks = await options.taskService.listTasks(context);
    const task = tasks.find(item => taskResource.buildIri(owner, { id: item.id }) === run.task);
    if (!task) throw new Error('Task not found for this run');
    return { taskId: task.id, run: projectRun(run) };
  }));
  server.get('/api/tasks/steps', guarded(async (request, context) => ({
    steps: (await options.runStore.loadRunSteps(idOf(request), context)).map(step => ({
      id: step.id, type: step.type, message: step.message, createdAt: step.createdAt,
    })),
  })));
  server.post('/api/tasks/stop', guarded(async (request, context, owner) => {
    const run = await cancelRun({
      store: options.runStore, runId: idOf(request), context,
      resourceIri: run => runResource.buildIri(owner, { id: run.id }),
    });
    return { run: projectRun(run) };
  }));
}

export function projectTask(task: TaskRecordData) {
  return {
    id: task.id, title: task.title, instruction: task.prompt, assignedTo: task.assignedTo,
    source: task.source, status: task.status, dueAt: task.dueAt, completedAt: task.completedAt,
    notes: task.notes, priority: task.priority, createdAt: task.createdAt, updatedAt: task.updatedAt,
    schedule: task.authBinding ? {
      kind: task.triggerKind, cron: task.cron, intervalSeconds: task.intervalSeconds,
      eventName: task.eventName, nextRunAt: task.nextRunAt, paused: task.status === 'blocked',
    } : undefined,
  };
}
function projectRun(run: RunRecordData) {
  const waitingTool = run.metadata?.waitingTool as { requestId?: string } | undefined;
  return { id: run.id, thread: run.thread, status: run.status, error: run.error, createdAt: run.createdAt,
    failureDiagnostic: projectTaskRunFailureDiagnostic(run.metadata?.failureDiagnostic, run.status),
    waitingToolCallId: waitingTool?.requestId,
    completedAt: run.completedAt, cancelRequestedAt: run.cancelRequestedAt };
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Expected text');
  return value;
}
function optionalUri(value: unknown): string | undefined {
  const text = optionalString(value);
  if (text !== undefined && !/^https?:\/\//.test(text)) throw new Error('Source must be an HTTP resource IRI');
  return text;
}
function optionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Expected a positive number');
  return value;
}
async function body(request: AuthenticatedRequest): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error('Request is too large');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
