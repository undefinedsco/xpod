import type { EventPayload } from 'inngest/types';
import type { InngestRunExecutionBackend } from '../runs/InngestRunExecutionBackend';
import type { StoreContext } from '../chatkit/store';
import { generateId } from '../chatkit/types';
import type { TaskService } from './TaskService';
import type { MaterializedTaskRun } from './TaskMaterializer';

export const XPOD_TASK_MATERIALIZE_DUE_EVENT = 'xpod/task.materialize_due';
export const XPOD_TASK_EVENT = 'xpod/task.event';
export const XPOD_TASK_MATERIALIZE_DUE_FUNCTION_ID = 'xpod-task-materialize-due-runs';
export const XPOD_TASK_EVENT_FUNCTION_ID = 'xpod-task-event';

export interface XpodTaskMaterializeDueEventData {
  requestId?: string;
  now?: number;
  limit?: number;
  authBindingId?: string;
  webId?: string;
}

export type XpodTaskMaterializeDueEvent = EventPayload<XpodTaskMaterializeDueEventData> & {
  name: typeof XPOD_TASK_MATERIALIZE_DUE_EVENT;
};

export interface XpodTaskEventData {
  requestId?: string;
  authBindingId?: string;
  webId?: string;
  eventName: string;
  payload?: Record<string, unknown>;
}

export type XpodTaskEvent = EventPayload<XpodTaskEventData> & {
  name: typeof XPOD_TASK_EVENT;
};

export interface InngestTaskSchedulerOptions<TContext = StoreContext> {
  backend: InngestRunExecutionBackend;
  taskService: TaskService<TContext>;
  getContext?: () => TContext | undefined;
  getContexts?: () => Iterable<TContext> | Promise<Iterable<TContext>>;
  resolveContext?: (
    data: Partial<XpodTaskMaterializeDueEventData & XpodTaskEventData>,
  ) => TContext | Promise<TContext | undefined> | undefined;
  recordContext?: (context: TContext | undefined) => void;
  durableDelivery?: boolean;
  executeInline?: boolean;
}

type InngestTaskEventContext = {
  event: XpodTaskEvent;
  step: {
    run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  };
};

type InngestCronContext = {
  event?: XpodTaskMaterializeDueEvent;
  step: {
    run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  };
};

export class InngestTaskScheduler<TContext = StoreContext> {
  public readonly materializeDueRunsFunction;
  public readonly eventTaskFunction;

  private readonly taskService: TaskService<TContext>;
  private readonly getContext: () => TContext | undefined;
  private readonly getContexts?: () => Iterable<TContext> | Promise<Iterable<TContext>>;
  private readonly resolveContext?: InngestTaskSchedulerOptions<TContext>['resolveContext'];
  private readonly recordContext?: InngestTaskSchedulerOptions<TContext>['recordContext'];
  private readonly durableDelivery: boolean;
  private readonly executeInline: boolean;
  private readonly pendingDueTasks = new Map<string, { context: TContext; now?: number; limit?: number }>();
  private readonly pendingTaskEvents = new Map<string, { context: TContext; eventName: string; payload?: Record<string, unknown> }>();
  private readonly client: ReturnType<InngestRunExecutionBackend['getClient']>;

  public constructor(options: InngestTaskSchedulerOptions<TContext>) {
    this.taskService = options.taskService;
    this.getContext = options.getContext ?? (() => undefined);
    this.getContexts = options.getContexts;
    this.resolveContext = options.resolveContext;
    this.recordContext = options.recordContext;
    this.durableDelivery = options.durableDelivery ?? true;
    this.executeInline = options.executeInline ?? true;
    this.client = options.backend.getClient();

    this.materializeDueRunsFunction = this.client.createFunction(
      {
        id: XPOD_TASK_MATERIALIZE_DUE_FUNCTION_ID,
        name: 'Xpod Task Materialize Due Runs',
        triggers: [
          { cron: '*/1 * * * *' },
          { event: XPOD_TASK_MATERIALIZE_DUE_EVENT },
        ],
      },
      (ctx: any) => this.handleDueTasks(ctx as InngestCronContext),
    );

    this.eventTaskFunction = this.client.createFunction(
      {
        id: XPOD_TASK_EVENT_FUNCTION_ID,
        name: 'Xpod Task Event',
        triggers: [{ event: XPOD_TASK_EVENT }],
      },
      (ctx: any) => this.handleTaskEvent(ctx as InngestTaskEventContext),
    );
  }

  public getFunctions(): unknown[] {
    return [this.materializeDueRunsFunction, this.eventTaskFunction];
  }

  public async materializeDueTasks(
    context: TContext,
    options: { now?: number; limit?: number } = {},
  ): Promise<MaterializedTaskRun[]> {
    const requestId = generateId('task-due');
    this.recordContext?.(context);
    this.pendingDueTasks.set(requestId, { context, ...options });
    try {
      if (this.durableDelivery) {
        await this.client.send({
          id: requestId,
          name: XPOD_TASK_MATERIALIZE_DUE_EVENT,
          data: {
            requestId,
            now: options.now,
            limit: options.limit,
            ...this.contextEventData(context),
          },
        });
      }
      if (!this.executeInline) {
        return [];
      }
      return this.handleDueTasks(this.createInlineDueContext(requestId, options));
    } catch (error) {
      this.pendingDueTasks.delete(requestId);
      throw error;
    }
  }

  public async materializeEventTasks(input: {
    eventName: string;
    payload?: Record<string, unknown>;
    context: TContext;
  }): Promise<MaterializedTaskRun[]> {
    const requestId = generateId('task-event');
    this.recordContext?.(input.context);
    this.pendingTaskEvents.set(requestId, input);
    try {
      if (this.durableDelivery) {
        await this.client.send({
          id: requestId,
          name: XPOD_TASK_EVENT,
          data: {
            requestId,
            ...this.contextEventData(input.context),
            eventName: input.eventName,
            payload: input.payload,
          },
        });
      }
      if (!this.executeInline) {
        return [];
      }
      return this.handleTaskEvent(this.createInlineEventContext(requestId, input));
    } catch (error) {
      this.pendingTaskEvents.delete(requestId);
      throw error;
    }
  }

  private async handleDueTasks(ctx: InngestCronContext): Promise<MaterializedTaskRun[]> {
    const requestId = ctx.event?.data?.requestId;
    const pending = requestId ? this.pendingDueTasks.get(requestId) : undefined;
    const contexts = await this.resolveDueContexts(pending?.context, ctx.event?.data);
    if (contexts.length === 0) {
      return [];
    }
    try {
      return await ctx.step.run('materialize-due-tasks', async () => {
        const runs: MaterializedTaskRun[] = [];
        for (const context of contexts) {
          runs.push(...await this.taskService.materializeDueTasks(context, {
            now: pending?.now ?? ctx.event?.data?.now,
            limit: pending?.limit ?? ctx.event?.data?.limit,
          }));
        }
        return runs;
      });
    } finally {
      if (requestId) {
        this.pendingDueTasks.delete(requestId);
      }
    }
  }

  private async handleTaskEvent(ctx: InngestTaskEventContext): Promise<MaterializedTaskRun[]> {
    const requestId = ctx.event.data?.requestId;
    const pending = requestId ? this.pendingTaskEvents.get(requestId) : undefined;
    const eventName = pending?.eventName ?? ctx.event.data?.eventName;
    if (!eventName) {
      return [];
    }
    const context = pending?.context ?? await this.resolveSingleContext(ctx.event.data);
    if (!context) {
      return [];
    }
    try {
      return await ctx.step.run('materialize-event-tasks', async () => this.taskService.materializeEventTasks({
        eventName,
        payload: pending?.payload ?? ctx.event.data?.payload,
        context,
      }));
    } finally {
      if (requestId) {
        this.pendingTaskEvents.delete(requestId);
      }
    }
  }

  private createInlineDueContext(requestId: string, options: { now?: number; limit?: number }): InngestCronContext {
    const pending = this.pendingDueTasks.get(requestId);
    return {
      event: {
        id: requestId,
        name: XPOD_TASK_MATERIALIZE_DUE_EVENT,
        data: {
          requestId,
          now: options.now,
          limit: options.limit,
          ...(pending ? this.contextEventData(pending.context) : {}),
        },
      },
      step: {
        run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => fn(),
      },
    };
  }

  private createInlineEventContext(
    requestId: string,
    input: {
      eventName: string;
      payload?: Record<string, unknown>;
    },
  ): InngestTaskEventContext {
    const pending = this.pendingTaskEvents.get(requestId);
    return {
      event: {
        id: requestId,
        name: XPOD_TASK_EVENT,
        data: {
          requestId,
          ...(pending ? this.contextEventData(pending.context) : {}),
          eventName: input.eventName,
          payload: input.payload,
        },
      },
      step: {
        run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => fn(),
      },
    };
  }

  private async resolveDueContexts(
    pendingContext: TContext | undefined,
    eventData: XpodTaskMaterializeDueEventData | undefined,
  ): Promise<TContext[]> {
    if (pendingContext) {
      return [pendingContext];
    }
    const eventContext = await this.resolveSingleContext(eventData);
    if (eventContext) {
      return [eventContext];
    }
    if (this.getContexts) {
      return Array.from(await this.getContexts());
    }
    const fallback = this.getContext();
    return fallback ? [fallback] : [];
  }

  private async resolveSingleContext(
    eventData: Partial<XpodTaskMaterializeDueEventData & XpodTaskEventData> | undefined,
  ): Promise<TContext | undefined> {
    const resolved = eventData ? await this.resolveContext?.(eventData) : undefined;
    return resolved ?? this.getContext();
  }

  private contextEventData(context: TContext): Partial<XpodTaskMaterializeDueEventData & XpodTaskEventData> {
    const auth = (context as Record<string, unknown>).auth as { type?: unknown; webId?: unknown } | undefined;
    const data: Partial<XpodTaskMaterializeDueEventData & XpodTaskEventData> = {};
    const authBindingId = (context as Record<string, unknown>).authBindingId;
    if (typeof authBindingId === 'string' && authBindingId.length > 0) {
      data.authBindingId = authBindingId;
    }
    if (auth?.type === 'solid' && typeof auth.webId === 'string') {
      data.webId = auth.webId;
    }
    return data;
  }
}
