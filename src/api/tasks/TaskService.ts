import type { ChatKitStore, StoreContext } from '../chatkit/store';
import type { ThreadMetadata } from '../chatkit/types';
import {
  generateId,
  nowTimestamp,
} from '../chatkit/types';
import type { RunExecutionBackend } from '../runs/RunExecutionBackend';
import { extractResourceLocalId, resolveDataResource, type RunStore } from '../runs/store';
import { isWorkspaceRef, type WorkspaceRef } from '../workspace/types';
import { TaskMaterializer, type MaterializedTaskRun } from './TaskMaterializer';
import { TaskStatus, TaskTriggerKind, type TaskTriggerKindType } from './schema';
import type { TaskAuthBindingSnapshot } from './TaskAuthBinding';
import { generateTaskResourceId, type TaskRecordData, type TaskStore } from './store';

export interface CreateTaskInput {
  title?: string;
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
      runner: input.runner ?? 'pi:pi',
      metadata: input.metadata,
      context,
    });

    const task: TaskRecordData = {
      id: taskId,
      title: input.title,
      prompt: input.prompt,
      thread: this.resolveThreadResource(thread, context),
      workspace: input.workspace,
      runner: input.runner ?? 'pi:pi',
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
    if (triggerKind === TaskTriggerKind.INTERVAL && (!input.intervalSeconds || input.intervalSeconds <= 0)) {
      throw new Error('intervalSeconds must be a positive number for interval tasks');
    }
    if (triggerKind === TaskTriggerKind.CRON && !input.cron?.trim()) {
      throw new Error('cron is required for cron tasks');
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
      return input.startAt ?? now;
    }
    if (triggerKind === TaskTriggerKind.CRON) {
      return input.startAt ?? now;
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
