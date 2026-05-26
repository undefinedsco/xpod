import { describe, expect, it } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { InngestRunExecutionBackend } from '../../src/api/runs/InngestRunExecutionBackend';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import { RunStatus } from '../../src/api/runs/schema';
import {
  InngestTaskScheduler,
  XPOD_TASK_EVENT,
  XPOD_TASK_MATERIALIZE_DUE_EVENT,
} from '../../src/api/tasks/InngestTaskScheduler';
import { TaskAuthBindingService } from '../../src/api/tasks/TaskAuthBinding';
import { TaskService } from '../../src/api/tasks/TaskService';
import { TaskTriggerKind } from '../../src/api/tasks/schema';

const workspaceRef = `file://localhost${process.cwd()}`;

class RecordingInngestClient {
  public sent: unknown[] = [];

  public async send(payload: unknown): Promise<{ ids: string[] }> {
    this.sent.push(payload);
    return { ids: ['evt-test'] };
  }

  public createFunction(options: unknown, handler: unknown): { options: unknown; handler: unknown } {
    return { options, handler };
  }
}

class RecordingRunBackend implements RunExecutionBackend {
  public inputs: RunExecutionInput[] = [];

  public async *start(input: RunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    this.inputs.push(input);
    yield { type: 'text', text: `ran:${input.prompt}` };
  }
}

async function createTaskAuthBinding(
  store: InMemoryStore<StoreContext>,
  context: StoreContext,
  input: { id?: string; displayName?: string } = {},
) {
  return new TaskAuthBindingService({ repository: store }).createBinding(input, context);
}

describe('Inngest Task scheduler', () => {
  it('sends an Inngest due event before materializing due Tasks into Runs', async () => {
    const store = new InMemoryStore<StoreContext>();
    const runtimeDriver = new RecordingRunBackend();
    const inngestClient = new RecordingInngestClient();
    const runBackend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver,
      durableDelivery: false,
      executeInline: true,
    });
    const taskService = new TaskService({
      store,
      executionBackend: runBackend,
    });
    const scheduler = new InngestTaskScheduler({
      backend: runBackend,
      taskService,
      durableDelivery: true,
      executeInline: true,
    });
    const context = {
      userId: 'u1',
      authBindingId: 'task-auth-scheduler',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
        clientId: 'task-client-id',
        clientSecret: 'task-client-secret',
      },
    };

    const authBinding = await createTaskAuthBinding(store, context, {
      id: 'task-auth-scheduler',
    });

    const created = await taskService.createTask({
      title: 'Every minute',
      prompt: 'check status',
      workspace: workspaceRef,
      runner: 'pi:pi',
      triggerKind: TaskTriggerKind.INTERVAL,
      intervalSeconds: 60,
      startAt: 100,
      authBinding,
    }, context);

    const materialized = await scheduler.materializeDueTasks(context, { now: 100, limit: 10 });

    expect(materialized).toHaveLength(1);
    expect(materialized[0].task.id).toBe(created.task.id);
    expect(materialized[0].run).toMatchObject({
      commandKind: 'task',
      status: RunStatus.COMPLETED,
    });
    expect(inngestClient.sent).toHaveLength(1);
    expect(inngestClient.sent[0]).toMatchObject({
      name: XPOD_TASK_MATERIALIZE_DUE_EVENT,
      data: {
        now: 100,
        limit: 10,
        authBindingId: 'task-auth-scheduler',
        webId: 'http://localhost/alice/profile/card#me',
      },
    });
    expect(JSON.stringify(inngestClient.sent[0])).not.toContain('task-client-secret');
    expect(runtimeDriver.inputs).toHaveLength(1);
  });

  it('sends an Inngest task event before materializing event Tasks into Runs', async () => {
    const store = new InMemoryStore<StoreContext>();
    const runtimeDriver = new RecordingRunBackend();
    const inngestClient = new RecordingInngestClient();
    const runBackend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver,
      durableDelivery: false,
      executeInline: true,
    });
    const taskService = new TaskService({
      store,
      executionBackend: runBackend,
    });
    const scheduler = new InngestTaskScheduler({
      backend: runBackend,
      taskService,
      durableDelivery: true,
      executeInline: true,
    });
    const context = {
      userId: 'u1',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
        clientId: 'task-client-id',
        clientSecret: 'task-client-secret',
      },
    };

    const authBinding = await createTaskAuthBinding(store, context);

    const created = await taskService.createTask({
      title: 'On deploy',
      prompt: 'summarize deploy',
      workspace: workspaceRef,
      runner: 'pi:pi',
      triggerKind: TaskTriggerKind.EVENT,
      eventName: 'deploy.completed',
      authBinding,
    }, context);

    const materialized = await scheduler.materializeEventTasks({
      eventName: 'deploy.completed',
      payload: { version: '1.2.3' },
      context,
    });

    expect(materialized).toHaveLength(1);
    expect(materialized[0].task.id).toBe(created.task.id);
    expect(materialized[0].run.metadata?.trigger).toEqual({
      kind: 'event',
      eventName: 'deploy.completed',
      payload: { version: '1.2.3' },
    });
    expect(inngestClient.sent).toHaveLength(1);
    expect(inngestClient.sent[0]).toMatchObject({
      name: XPOD_TASK_EVENT,
      data: {
        eventName: 'deploy.completed',
        payload: { version: '1.2.3' },
      },
    });
    expect(runtimeDriver.inputs).toHaveLength(1);
  });

  it('materializes cron-triggered Tasks from registered server contexts without a pending request', async () => {
    const store = new InMemoryStore<StoreContext>();
    const runtimeDriver = new RecordingRunBackend();
    const inngestClient = new RecordingInngestClient();
    const runBackend = new InngestRunExecutionBackend({
      client: inngestClient as any,
      runtimeDriver,
      durableDelivery: false,
      executeInline: true,
    });
    const taskService = new TaskService({
      store,
      executionBackend: runBackend,
    });
    const context = {
      userId: 'alice',
      auth: {
        type: 'solid',
        webId: 'http://localhost/alice/profile/card#me',
        clientId: 'task-client-id',
        clientSecret: 'task-client-secret',
      },
    };
    const scheduler = new InngestTaskScheduler({
      backend: runBackend,
      taskService,
      durableDelivery: false,
      executeInline: true,
      getContexts: () => [context],
      resolveContext: (data) => data.webId === context.auth.webId ? context : undefined,
    });

    const authBinding = await createTaskAuthBinding(store, context);

    await taskService.createTask({
      title: 'Cron task',
      prompt: 'cron check',
      workspace: workspaceRef,
      runner: 'pi:pi',
      triggerKind: TaskTriggerKind.CRON,
      cron: '* * * * *',
      startAt: 100,
      authBinding,
    }, context);

    const result = await (scheduler.materializeDueRunsFunction as any).handler({
      event: {
        name: XPOD_TASK_MATERIALIZE_DUE_EVENT,
        data: {
          now: 100,
          limit: 10,
        },
      },
      step: {
        run: async (_id: string, fn: Function) => fn(),
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0].run.status).toBe(RunStatus.COMPLETED);
    expect(runtimeDriver.inputs).toHaveLength(1);
  });
});
