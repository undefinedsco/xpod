import { Inngest } from 'inngest';
import type { EventPayload } from 'inngest/types';
import type { StoreContext } from '../chatkit/store';
import type { AgentRuntimeEvent } from './AgentRuntimeTypes';
import { ManagedRunWorker, type ManagedRunStore } from './ManagedRunWorker';
import { PiAgentRuntimeDriver } from './PiAgentRuntimeDriver';
import type { RunExecutionBackend, RunExecutionInput } from './RunExecutionBackend';

export const XPOD_RUN_REQUESTED_EVENT = 'xpod/run.requested';
export const XPOD_RUN_CONTINUE_REQUESTED_EVENT = 'xpod/run.continue_requested';
export const XPOD_AGENT_RUN_FUNCTION_ID = 'xpod-agent-run';

export interface XpodRunRequestedEventData {
  runId: string;
  threadId: string;
  executionKey?: string;
  authBindingId?: string;
  webId?: string;
  continuation?: RunExecutionInput['continuation'];
}

export type XpodRunRequestedEvent = EventPayload<XpodRunRequestedEventData> & {
  name: typeof XPOD_RUN_REQUESTED_EVENT | typeof XPOD_RUN_CONTINUE_REQUESTED_EVENT;
};

export interface InngestRunExecutionBackendOptions {
  client?: Inngest;
  baseUrl?: string;
  eventKey?: string;
  signingKey?: string;
  isDev?: boolean;
  runtimeDriver?: RunExecutionBackend;
  store?: ManagedRunStore<StoreContext>;
  managedRunWorker?: ManagedRunWorker<StoreContext>;
  contextResolver?: (data: XpodRunRequestedEventData) => StoreContext | Promise<StoreContext | undefined> | undefined;
  contextRecorder?: (context: StoreContext | undefined) => void;
  durableDelivery?: boolean;
  /**
   * When true, execute the registered Inngest handler in-process after sending
   * the event. This keeps Chat streaming low-latency while preserving the
   * Inngest event/function boundary for the managed-agents backend.
   */
  executeInline?: boolean;
}

type PendingRun = {
  input: RunExecutionInput;
  queue: AsyncPushQueue<AgentRuntimeEvent>;
  started: boolean;
};

type InngestHandlerContext = {
  event: XpodRunRequestedEvent;
  runId: string;
  step: {
    run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  };
};

/**
 * Inngest-backed managed-agent execution backend.
 *
 * Xpod owns the Run facts; Inngest owns durable function delivery. In this
 * first API-facing implementation the function can execute inline so ChatKit
 * still receives a normal SSE stream without waiting for external polling.
 *
 * The in-memory pending map is only the streaming bridge for an active HTTP
 * request. When no pending stream exists, the registered Inngest function can
 * restore the Run from store through ManagedRunWorker.
 */
export class InngestRunExecutionBackend implements RunExecutionBackend {
  private readonly client: Inngest;
  private readonly runtimeDriver: RunExecutionBackend;
  private readonly managedRunWorker?: ManagedRunWorker<StoreContext>;
  private readonly contextResolver?: InngestRunExecutionBackendOptions['contextResolver'];
  private readonly contextRecorder?: InngestRunExecutionBackendOptions['contextRecorder'];
  private readonly executeInline: boolean;
  private readonly durableDelivery: boolean;
  private readonly pendingRuns = new Map<string, PendingRun>();

  public readonly agentRunFunction;

  public constructor(options: InngestRunExecutionBackendOptions = {}) {
    this.client = options.client ?? new Inngest({
      id: 'xpod-managed-agents',
      baseUrl: options.baseUrl,
      eventKey: options.eventKey,
      signingKey: options.signingKey,
      isDev: options.isDev ?? !options.durableDelivery,
    });
    this.runtimeDriver = options.runtimeDriver ?? new PiAgentRuntimeDriver();
    this.managedRunWorker = options.managedRunWorker
      ?? (options.store ? new ManagedRunWorker({ store: options.store, runtimeDriver: this.runtimeDriver }) : undefined);
    this.contextResolver = options.contextResolver;
    this.contextRecorder = options.contextRecorder;
    this.durableDelivery = options.durableDelivery ?? true;
    this.executeInline = options.executeInline ?? true;
    this.agentRunFunction = this.client.createFunction(
      {
        id: XPOD_AGENT_RUN_FUNCTION_ID,
        name: 'Xpod Agent Run',
        triggers: [
          { event: XPOD_RUN_REQUESTED_EVENT },
          { event: XPOD_RUN_CONTINUE_REQUESTED_EVENT },
        ],
        idempotency: 'event.data.executionKey',
      },
      (ctx: any) => this.handleAgentRun(ctx as InngestHandlerContext),
    );
  }

  public getClient(): Inngest {
    return this.client;
  }

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    const queue = new AsyncPushQueue<AgentRuntimeEvent>();
    this.pendingRuns.set(input.runId, { input, queue, started: false });
    const context = (input as RunExecutionInput & { context?: StoreContext }).context;
    this.contextRecorder?.(context);
    const eventName = input.continuation
      ? XPOD_RUN_CONTINUE_REQUESTED_EVENT
      : XPOD_RUN_REQUESTED_EVENT;
    const executionKey = this.executionKeyForInput(input);

    try {
      if (!this.durableDelivery && !this.executeInline) {
        yield {
          type: 'error',
          message: 'Run execution backend has neither durable delivery nor inline execution enabled',
        };
        return;
      }

      if (this.durableDelivery) {
        await this.client.send({
          id: executionKey,
          name: eventName,
          data: {
            runId: input.runId,
            threadId: input.threadId,
            executionKey,
            continuation: input.continuation,
            ...this.contextEventData(input, context),
          },
        });
      }

      if (!this.executeInline) {
        queue.close();
        return;
      }

      if (this.executeInline) {
        void this.handleAgentRun(this.createInlineContext(input)).catch((error) => {
          queue.push({ type: 'error', message: this.formatError(error) });
          queue.close();
        });
      }

      for await (const event of queue.iterate()) {
        yield event;
      }
    } catch (error) {
      yield { type: 'error', message: this.formatError(error) };
    } finally {
      this.pendingRuns.delete(input.runId);
      queue.close();
    }
  }

  private async handleAgentRun(ctx: InngestHandlerContext): Promise<{ runId: string; status: string }> {
    const runId = ctx.event.data?.runId;
    if (!runId) {
      return { runId: 'unknown', status: 'missing_run_id' };
    }
    const pending = this.pendingRuns.get(runId);
    if (pending) {
      if (pending.started) {
        return { runId, status: 'skipped' };
      }
      pending.started = true;
      await ctx.step.run('run-agent', async () => {
        try {
          for await (const event of this.runtimeDriver.start(pending.input)) {
            pending.queue.push(event);
          }
        } finally {
          pending.queue.close();
        }
      });

      return { runId, status: 'completed' };
    }

    if (!this.managedRunWorker || !this.contextResolver) {
      return { runId, status: 'not_found' };
    }

    const context = await this.contextResolver(ctx.event.data!);
    if (!context) {
      return { runId, status: 'not_found' };
    }

    const result = await ctx.step.run('run-agent-from-store', async () => {
      return this.managedRunWorker!.executeRun(runId, context);
    });

    return { runId, status: result.status };
  }

  public async restoreExecutionInput(runId: string, context: StoreContext): Promise<RunExecutionInput> {
    if (!this.managedRunWorker) {
      throw new Error('Managed Run worker is not configured');
    }
    return this.managedRunWorker.loadExecutionInput(runId, context);
  }

  private createInlineContext(input: RunExecutionInput): InngestHandlerContext {
    const executionKey = this.executionKeyForInput(input);
    return {
      event: {
        id: executionKey,
        name: input.continuation ? XPOD_RUN_CONTINUE_REQUESTED_EVENT : XPOD_RUN_REQUESTED_EVENT,
        data: {
          runId: input.runId,
          threadId: input.threadId,
          executionKey,
          continuation: input.continuation,
          ...this.contextEventData(input, (input as RunExecutionInput & { context?: StoreContext }).context),
        },
      },
      runId: `inline:${executionKey}`,
      step: {
        run: async <T>(_id: string, fn: () => Promise<T> | T): Promise<T> => fn(),
      },
    };
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private executionKeyForInput(input: RunExecutionInput): string {
    if (!input.continuation) {
      return `run:${input.runId}`;
    }
    return `run:${input.runId}:continue:${input.continuation.kind}:${input.continuation.itemId ?? 'none'}`;
  }

  private contextEventData(input: RunExecutionInput, context: StoreContext | undefined): Partial<XpodRunRequestedEventData> {
    const auth = context?.auth as { type?: unknown; webId?: unknown } | undefined;
    if (input.authBindingId) {
      return {
        authBindingId: input.authBindingId,
        ...(auth?.type === 'solid' && typeof auth.webId === 'string' ? { webId: auth.webId } : {}),
      };
    }
    if (auth?.type !== 'solid' || typeof auth.webId !== 'string') {
      return {};
    }
    return { webId: auth.webId };
  }
}

class AsyncPushQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  public push(item: T): void {
    if (this.closed) {
      return;
    }
    this.items.push(item);
    const resolver = this.resolvers.shift();
    resolver?.();
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolver of this.resolvers) {
      resolver();
    }
    this.resolvers = [];
  }

  public async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => this.resolvers.push(resolve));
    }
  }
}
