import { updateRunApprovalSession } from '../runs/RunApproval';
import { runResource, taskResource } from '@undefineds.co/models';
import { cancelRun } from '../runs/RunCancellation';
import { nextCronOccurrence } from './cron';
import { DEFAULT_TASK_AGENT } from './TaskAgentBinding';
import type { ChatKitStore, StoreContext } from '../chatkit/store';
import type { ThreadMetadata } from '../chatkit/types';
import {
  generateId,
  nowTimestamp,
  toThreadRef,
} from '../chatkit/types';
import type { RunContextRetriever, RunExecutionBackend } from '../runs/RunExecutionBackend';
import { extractResourceLocalId, resolveDataResource, type RunStore } from '../runs/store';
import { isWorkspaceRef, type WorkspaceRef } from '../workspace/types';
import { TaskMaterializer, type MaterializedTaskRun } from './TaskMaterializer';
import { TaskStatus, TaskTriggerKind, type TaskTriggerKindType } from './schema';
import type { TaskAuthBindingSnapshot } from './TaskAuthBinding';
import { generateTaskResourceId, type TaskRecordData, type TaskStore } from './store';
import type { AiConnectionsInvocationKeyIssuer } from '../ai-gateway/auth/AiConnectionsInvocationKeyIssuer';

export interface CreateTaskInput {
  title?: string;
  assignedTo?: string;
  source?: string;
  prompt: string;
  workspace: WorkspaceRef;
  runner?: string;
  triggerKind?: TaskTriggerKindType;
  cron?: string;
  intervalSeconds?: number;
  eventName?: string;
  startAt?: number;
  authBinding: TaskAuthBindingSnapshot;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskResult {
  task: TaskRecordData;
  run?: MaterializedTaskRun['run'];
}

export interface TaskServiceOptions<TContext = StoreContext> {
  store: ChatKitStore<TContext> & RunStore<TContext> & TaskStore<TContext>;
  executionBackend?: RunExecutionBackend;
  executeRuns?: boolean;
  contextRetriever?: RunContextRetriever<TContext>;
  aiConnectionInvocationKeyIssuer?: Pick<AiConnectionsInvocationKeyIssuer, 'issue'>;
  requireAiConnectionsInvocationKeyIssuer?: boolean;
}

export class TaskService<TContext = StoreContext> {
  private readonly store: ChatKitStore<TContext> & RunStore<TContext> & TaskStore<TContext>;
  private readonly materializer: TaskMaterializer<TContext>;

  public constructor(options: TaskServiceOptions<TContext>) {
    this.store = options.store;
    this.materializer = new TaskMaterializer({
      store: options.store,
      executionBackend: options.executionBackend,
      executeRuns: options.executeRuns,
      contextRetriever: options.contextRetriever,
      aiConnectionInvocationKeyIssuer: options.aiConnectionInvocationKeyIssuer,
      requireAiConnectionsInvocationKeyIssuer: options.requireAiConnectionsInvocationKeyIssuer,
    });
  }

  public async createTask(input: CreateTaskInput, context: TContext): Promise<CreateTaskResult> {
    if (!input.prompt.trim()) {
      throw new Error('Task prompt is required');
    }
    if (!isWorkspaceRef(input.workspace)) {
      throw new Error('Task workspace reference is required');
    }

    const triggerKind = input.triggerKind ?? TaskTriggerKind.ONCE;
    this.validateTrigger(input, triggerKind);
    const authBinding = this.normalizeAuthBinding(input.authBinding);

    const now = nowTimestamp();
    const taskId = generateTaskResourceId({
      key: generateId('task'),
      createdAt: now,
    });
    const thread = await this.createTaskThread({
      taskId,
      title: input.title,
      workspace: input.workspace,
      runner: input.runner ?? DEFAULT_TASK_AGENT.runner,
      metadata: input.metadata,
      context,
    });

    const task: TaskRecordData = {
      id: taskId,
      title: input.title,
      assignedTo: input.assignedTo ?? DEFAULT_TASK_AGENT.iri,
      source: input.source,
      prompt: input.prompt,
      thread: this.resolveThreadResource(thread, context),
      workspace: input.workspace,
      runner: input.runner ?? DEFAULT_TASK_AGENT.runner,
      status: TaskStatus.ACTIVE,
      triggerKind,
      cron: input.cron,
      intervalSeconds: input.intervalSeconds,
      eventName: input.eventName,
      nextRunAt: this.initialNextRunAt(input, triggerKind, now),
      authBinding,
      metadata: {
        ...(input.metadata ?? {}),
        authBinding,
      },
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveTask(task, context);

    if (triggerKind === TaskTriggerKind.ONCE) {
      const materialized = await this.materializer.materialize({
        task,
        context,
        trigger: {
          kind: 'once',
          scheduledFor: now,
        },
      });
      return { task: materialized.task, run: materialized.run };
    }

    return { task };
  }

  public async loadTask(taskId: string, context: TContext): Promise<TaskRecordData> {
    return this.store.loadTask(taskId, context);
  }

  public async listTasks(context: TContext): Promise<TaskRecordData[]> {
    return this.store.listTasks({}, context);
  }

  public async createTodo(input: {
    prompt: string; workspace: WorkspaceRef; assignedTo: string; dueAt?: number;
    notes?: string; priority?: string; source?: string;
  }, context: TContext): Promise<TaskRecordData> {
    if (!input.prompt.trim() || !isWorkspaceRef(input.workspace)) {
      throw new Error('Task instruction and workspace are required');
    }
    const now = nowTimestamp();
    const task: TaskRecordData = {
      id: generateTaskResourceId(generateId('task')), title: input.prompt.trim(),
      ...input, prompt: input.prompt.trim(), thread: '', runner: '',
      triggerKind: TaskTriggerKind.ONCE, status: TaskStatus.OPEN,
      createdAt: now, updatedAt: now,
    };
    await this.store.saveTask(task, context);
    return task;
  }

  public async updateTodo(id: string, owner: string, input: {
    completed?: boolean; dueAt?: number | null; notes?: string; priority?: string;
  }, context: TContext): Promise<TaskRecordData> {
    const task = await this.store.loadTask(id, context);
    if (task.assignedTo !== owner) throw new Error('Only your own todo can be edited here');
    if (input.completed !== undefined) {
      task.status = input.completed ? TaskStatus.COMPLETED : TaskStatus.OPEN;
      task.completedAt = input.completed ? nowTimestamp() : undefined;
    }
    if (input.dueAt !== undefined) task.dueAt = input.dueAt ?? undefined;
    if (input.notes !== undefined) task.notes = input.notes;
    if (input.priority !== undefined) task.priority = input.priority;
    task.updatedAt = nowTimestamp();
    await this.store.saveTask(task, context);
    return task;
  }

  public async setSchedulePaused(id: string, paused: boolean, context: TContext): Promise<TaskRecordData> {
    const task = await this.store.loadTask(id, context);
    if (!task.authBinding || task.triggerKind === TaskTriggerKind.ONCE) throw new Error('Task has no recurring schedule');
    if (task.status !== TaskStatus.ACTIVE && task.status !== TaskStatus.BLOCKED) throw new Error('Task has ended');
    task.status = paused ? TaskStatus.BLOCKED : TaskStatus.ACTIVE;
    const now = nowTimestamp();
    if (!paused) {
      if (task.triggerKind === TaskTriggerKind.CRON) task.nextRunAt = nextCronOccurrence(task.cron ?? '', now);
      if (task.triggerKind === TaskTriggerKind.INTERVAL) task.nextRunAt = now + (task.intervalSeconds ?? 0);
    }
    task.updatedAt = now;
    await this.store.saveTask(task, context);
    return task;
  }

  public async runNow(id: string, context: TContext): Promise<MaterializedTaskRun> {
    const task = await this.store.loadTask(id, context);
    if (!task.authBinding || ![TaskStatus.ACTIVE, TaskStatus.BLOCKED].includes(task.status as 'active' | 'blocked')) throw new Error('Only scheduled AI tasks can run');
    return this.materializer.materialize({ task, context, trigger: { kind: 'manual' }, background: true });
  }

  public async resumeApprovedRun(input: { runId: string; approval: string; owner: string }, context: TContext,
    resolveExecutionContext?: (task: TaskRecordData, caller: TContext) => Promise<TContext | undefined>) {
    const run = await this.store.loadRun(input.runId, context);
    const approval = await this.store.readTaskApproval?.(input.approval, context);
    if (!approval || !['approved', 'rejected'].includes(approval.status)
      || approval.decisionBy !== input.owner || (approval.assignedTo && approval.assignedTo !== input.owner) || !approval.resolvedAt
      || approval.thread !== run.thread) throw new Error('Approval does not authorize this run');
    const threadRef = toThreadRef({ thread_id: run.thread });
    const output = JSON.stringify({ kind: 'approval_decision', approval: input.approval, decision: approval.status, actionExecuted: false });
    const items = await this.store.loadThreadItems(threadRef, undefined, 1000, 'asc', context);
    const item = items.data.find(item => item.type === 'client_tool_call' && item.call_id === approval.toolCallId && item.metadata?.runId === run.id);
    if (!item || item.type !== 'client_tool_call' || item.name !== approval.toolName) throw new Error('Approval does not match the pending tool checkpoint');
    const waiting = run.metadata?.waitingTool as { itemId?: string; requestId?: string } | undefined;
    const atCheckpoint = waiting?.itemId === item.id && waiting.requestId === approval.toolCallId;
    if (item.status === 'completed' && item.output === output) {
      if (approval.status === 'rejected' && atCheckpoint && run.status === 'waiting_input') {
        const cancelled = await cancelRun({ store: this.store, runId: run.id, context, resourceIri: () => runResource.buildIri(input.owner, { id: run.id }) });
        return { run: cancelled, resumed: false, duplicate: true };
      }
      if (run.status === 'cancelled') await updateRunApprovalSession(this.store, run, 'completed', context);
      return { run, resumed: false, duplicate: true };
    }
    if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= Date.now()) throw new Error('Approval has expired');
    if (run.status !== 'waiting_input' || waiting?.itemId !== item.id || waiting.requestId !== approval.toolCallId) throw new Error('Run is not waiting at this approval checkpoint');
    if (approval.status === 'rejected') {
      await this.store.saveItem(threadRef, { ...item, status: 'completed', output, metadata: { ...item.metadata, approval: input.approval } }, context);
      const cancelled = await cancelRun({ store: this.store, runId: run.id, context, resourceIri: () => runResource.buildIri(input.owner, { id: run.id }) });
      return { run: cancelled, resumed: false };
    }
    // Foreground Chat resumes with the authenticated caller. Scheduled Task runs
    // must still restore their separately granted execution credential.
    let execution = context;
    if (run.task) {
      const tasks = await this.store.listTasks({}, context);
      const task = tasks.find(task => taskResource.buildIri(input.owner, { id: task.id }) === run.task);
      if (!task) throw new Error('Task not found for this run');
      const granted = await resolveExecutionContext?.(task, context);
      if (!granted) throw new Error('Agent execution credential is unavailable');
      execution = granted;
    }
    const resumed = await this.materializer.resumeClientToolOutput(run, item.id, output, input.approval, execution);
    return { run: await this.store.loadRun(run.id, context), resumed, ...(!resumed ? { duplicate: true } : {}) };
  }

  public async materializeDueTasks(
    context: TContext,
    options: { now?: number; limit?: number } = {},
  ): Promise<MaterializedTaskRun[]> {
    const now = options.now ?? nowTimestamp();
    const dueTasks = await this.store.listTasks({
      status: TaskStatus.ACTIVE,
      dueAt: now,
      limit: options.limit,
    }, context);

    const materialized: MaterializedTaskRun[] = [];
    for (const task of dueTasks) {
      if (task.triggerKind !== TaskTriggerKind.INTERVAL && task.triggerKind !== TaskTriggerKind.CRON) {
        continue;
      }
      materialized.push(await this.materializer.materialize({
        task,
        context,
        trigger: {
          kind: task.triggerKind,
          scheduledFor: task.nextRunAt ?? now,
        },
      }));
    }
    return materialized;
  }

  public async materializeEventTasks(input: {
    eventName: string;
    payload?: Record<string, unknown>;
    context: TContext;
  }): Promise<MaterializedTaskRun[]> {
    const tasks = await this.store.listTasks({
      status: TaskStatus.ACTIVE,
      triggerKind: TaskTriggerKind.EVENT,
      eventName: input.eventName,
    }, input.context);

    const materialized: MaterializedTaskRun[] = [];
    for (const task of tasks) {
      materialized.push(await this.materializer.materialize({
        task,
        context: input.context,
        trigger: {
          kind: 'event',
          eventName: input.eventName,
          payload: input.payload,
        },
      }));
    }
    return materialized;
  }

  private async createTaskThread(input: {
    taskId: string;
    title?: string;
    workspace: WorkspaceRef;
    runner: string;
    metadata?: Record<string, unknown>;
    context: TContext;
  }): Promise<ThreadMetadata> {
    const now = nowTimestamp();
    const taskParentKey = extractResourceLocalId(input.taskId);
    const thread: ThreadMetadata = {
      id: `task/${taskParentKey}/index.ttl#${generateId('thread')}`,
      parent: `task/index.ttl#${taskParentKey}`,
      title: input.title,
      status: { type: 'active' },
      workspace: input.workspace,
      created_at: now,
      updated_at: now,
      metadata: {
        ...(input.metadata ?? {}),
        taskId: input.taskId,
        runtime: {
          workspace: input.workspace,
          runner: this.parseRunnerMetadata(input.runner),
        },
      },
    };
    await this.store.saveThread(thread, input.context);
    return thread;
  }

  private validateTrigger(input: CreateTaskInput, triggerKind: TaskTriggerKindType): void {
    if (!input.authBinding) {
      throw new Error('Task auth binding is required');
    }
    if (triggerKind === TaskTriggerKind.INTERVAL && (!input.intervalSeconds || !Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0)) {
      throw new Error('intervalSeconds must be a positive number for interval tasks');
    }
    if (triggerKind === TaskTriggerKind.CRON) {
      if (!input.cron?.trim()) throw new Error('cron is required for cron tasks');
      nextCronOccurrence(input.cron, nowTimestamp());
    }
    if (triggerKind === TaskTriggerKind.EVENT && !input.eventName?.trim()) {
      throw new Error('eventName is required for event tasks');
    }
  }

  private normalizeAuthBinding(input: TaskAuthBindingSnapshot): TaskAuthBindingSnapshot {
    if (!input.id.trim()) {
      throw new Error('Task auth binding id is required');
    }
    if (!input.webId.trim()) {
      throw new Error('Task auth binding webId is required');
    }
    if (!input.clientId.trim()) {
      throw new Error('Task auth binding clientId is required');
    }
    return { ...input };
  }

  private initialNextRunAt(input: CreateTaskInput, triggerKind: TaskTriggerKindType, now: number): number | undefined {
    if (triggerKind === TaskTriggerKind.INTERVAL) {
      return input.startAt ?? now + input.intervalSeconds!;
    }
    if (triggerKind === TaskTriggerKind.CRON) {
      return input.startAt ?? nextCronOccurrence(input.cron!, now);
    }
    return undefined;
  }

  private parseRunnerMetadata(runner: string): { protocol: string; type: string } {
    const [protocol, type] = runner.split(':');
    return {
      protocol: protocol === 'acp' ? 'acp' : 'pi',
      type: type || 'pi',
    };
  }

  private resolveThreadResource(thread: ThreadMetadata, context: TContext): string {
    const podBaseUrl = this.resolvePodBaseUrl(context);
    if (podBaseUrl) {
      if (thread.id.includes('#') && !thread.id.startsWith('#')) {
        return resolveDataResource(podBaseUrl, thread.id);
      }
      return resolveDataResource(podBaseUrl, `task/${extractResourceLocalId(thread.parent ?? thread.id)}/index.ttl#${thread.id}`);
    }
    const parentKey = extractResourceLocalId(thread.parent ?? thread.id);
    return `urn:xpod:thread:task:${encodeURIComponent(parentKey)}:${encodeURIComponent(thread.id)}`;
  }

  private resolvePodBaseUrl(context: TContext): string | undefined {
    const webId = this.resolveWebId(context);
    if (!webId) {
      return undefined;
    }
    try {
      const url = new URL(webId);
      url.hash = '';
      url.search = '';
      const normalizedPath = url.pathname.replace(/\/+$/, '');
      if (!normalizedPath.endsWith('/profile/card')) {
        return undefined;
      }
      const podPath = normalizedPath.slice(0, -'/profile/card'.length) || '/';
      url.pathname = podPath;
      return url.toString().replace(/\/$/, '');
    } catch {
      return undefined;
    }
  }

  private resolveWebId(context: TContext): string | undefined {
    const auth = (context as Record<string, unknown>).auth as { webId?: unknown } | undefined;
    return typeof auth?.webId === 'string' ? auth.webId : undefined;
  }
}
