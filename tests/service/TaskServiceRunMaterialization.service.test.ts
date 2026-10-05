import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { TaskAuthBindingService } from '../../src/api/tasks/TaskAuthBinding';
import { TaskStatus, TaskTriggerKind } from '../../src/api/tasks/schema';
import { RunStepType, RunStatus } from '../../src/api/runs/schema';
import { extractResourceLocalId } from '../../src/api/runs/store';
import type { RunContextRetrievalInput, RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import type { AgentRuntimeEvent } from '../../src/api/runs/AgentRuntimeTypes';

const workspaceRef = `file://localhost${process.cwd()}`;

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

describe('Task service Run materialization', () => {
  it('materializes a one-shot Task into a first-class Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRunBackend();
    const invocationKeyIssuer = {
      issue: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:3000/v1',
        apiKey: 'task-invocation-secret',
        model: 'linx',
      })),
    };
    const service = new TaskService({
      store,
      executionBackend: backend,
      aiConnectionInvocationKeyIssuer: invocationKeyIssuer,
      requireAiConnectionsInvocationKeyIssuer: true,
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

    const authBinding = await createTaskAuthBinding(store, context, {
      id: 'task-auth-one-shot',
      displayName: 'One shot task key',
    });

    const result = await service.createTask({
      title: 'One shot',
      prompt: 'ship this once',
      workspace: workspaceRef,
      runner: 'pi:codex',
      triggerKind: TaskTriggerKind.ONCE,
      authBinding,
    }, context);

    const taskParentKey = extractResourceLocalId(result.task.id);
    expect(result.run?.id).toMatch(new RegExp(`^task/${taskParentKey}/\\d{4}/\\d{2}/\\d{2}/runs\\.ttl#run_`));
    expect(result.task).toMatchObject({
      status: TaskStatus.COMPLETED,
      triggerKind: TaskTriggerKind.ONCE,
      workspace: workspaceRef,
      runner: 'pi:codex',
    });
    expect('surfaceId' in result.task).toBe(false);
    expect(result.run).toMatchObject({
      task: result.task.id,
      thread: result.task.thread,
      workspace: workspaceRef,
      status: RunStatus.COMPLETED,
      prompt: 'ship this once',
    });
    expect(backend.inputs).toHaveLength(1);
    expect(invocationKeyIssuer.issue).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({
        webId: 'http://localhost/alice/profile/card#me',
      }),
    }));
    expect(backend.inputs[0].config.aiConnection?.apiKey).toBe('task-invocation-secret');
    expect(backend.inputs[0]).toMatchObject({
      runId: result.run?.id,
      prompt: 'ship this once',
      authBindingId: 'task-auth-one-shot',
      config: {
        workspace: workspaceRef,
        runner: { protocol: 'pi', type: 'codex' },
      },
    });

    const run = await store.loadRun(result.run!.id, context);
    const events = await store.loadRunSteps(result.run!.id, context);
    const serializedTask = JSON.stringify(result.task);
    const serializedRun = JSON.stringify(run);
    expect(result.task.authBinding).toMatchObject({
      id: 'task-auth-one-shot',
      clientId: 'task-client-id',
      displayName: 'One shot task key',
      status: 'active',
    });
    expect(run.metadata?.authBindingId).toBe('task-auth-one-shot');
    expect(serializedTask).not.toContain('task-client-secret');
    expect(serializedRun).not.toContain('task-client-secret');
    expect(serializedRun).not.toContain('task-invocation-secret');
    expect(serializedTask).not.toContain('task-invocation-secret');
    expect(run.status).toBe(RunStatus.COMPLETED);
    expect('commandKind' in run).toBe(false);
    expect('surfaceId' in run).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      RunStepType.CREATED,
      RunStepType.STARTED,
      RunStepType.TEXT_DELTA,
      RunStepType.COMPLETED,
    ]);
    expect(events.every((event) => !('commandKind' in event) && !('surfaceId' in event))).toBe(true);
    expect(events.every((event) => event.runId === result.run!.id)).toBe(true);
    expect(events.every((event) => extractResourceLocalId(event.id).startsWith('run-step_'))).toBe(true);
  });

  it('passes retrieved context into task Run execution', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRunBackend();
    const contextRetriever = {
      retrieve: async (input: RunContextRetrievalInput) => ({
        query: input.prompt,
        items: [
          {
            kind: 'vector_chunk' as const,
            source: `${workspaceRef}/plan.md`,
            text: `retrieved for ${input.threadId}`,
            score: 0.77,
          },
        ],
      }),
    };
    const service = new TaskService({
      store,
      executionBackend: backend,
      contextRetriever,
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

    const result = await service.createTask({
      title: 'Context task',
      prompt: 'summarize plan',
      workspace: workspaceRef,
      runner: 'pi:codex',
      triggerKind: TaskTriggerKind.ONCE,
      authBinding,
    }, context);

    expect(backend.inputs).toHaveLength(1);
    expect(backend.inputs[0].retrievedContext).toEqual({
      query: 'summarize plan',
      items: [
        {
          kind: 'vector_chunk',
          source: `${workspaceRef}/plan.md`,
          text: `retrieved for ${backend.inputs[0].threadId}`,
          score: 0.77,
        },
      ],
    });
  });

  it('does not expose a Task surface label while runtime storage derives from parent Task', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRunBackend();
    const service = new TaskService({
      store,
      executionBackend: backend,
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

    const result = await service.createTask({
      title: 'Secretary task',
      prompt: 'review the workspace',
      workspace: workspaceRef,
      runner: 'pi:codex',
      triggerKind: TaskTriggerKind.ONCE,
      authBinding,
    }, context);

    const taskParentKey = extractResourceLocalId(result.task.id);
    expect('surfaceId' in result.task).toBe(false);
    expect(result.run?.id).toMatch(new RegExp(`^task/${taskParentKey}/\\d{4}/\\d{2}/\\d{2}/runs\\.ttl#run_`));
    expect(result.run).toMatchObject({
      runner: 'pi:codex',
    });
    expect('commandKind' in result.run!).toBe(false);
    expect('surfaceId' in result.run!).toBe(false);
  });

  it('materializes due interval Tasks and advances nextRunAt', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRunBackend();
    const service = new TaskService({
      store,
      executionBackend: backend,
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

    const created = await service.createTask({
      title: 'Every minute',
      prompt: 'check status',
      workspace: workspaceRef,
      runner: 'pi:pi',
      triggerKind: TaskTriggerKind.INTERVAL,
      intervalSeconds: 60,
      startAt: 100,
      authBinding,
    }, context);

    const before = await store.loadTask(created.task.id, context);
    expect(before.nextRunAt).toBe(100);

    const materialized = await service.materializeDueTasks(context, { now: 100 });

    expect(materialized).toHaveLength(1);
    expect(materialized[0].run).toMatchObject({
      task: created.task.id,
      status: RunStatus.COMPLETED,
    });
    expect('commandKind' in materialized[0].run).toBe(false);
    expect('surfaceId' in materialized[0].run).toBe(false);
    const after = await store.loadTask(created.task.id, context);
    expect(after.status).toBe(TaskStatus.ACTIVE);
    expect(after.lastRunAt).toBe(100);
    expect(after.nextRunAt).toBe(160);
    expect(backend.inputs).toHaveLength(1);
  });

  it('materializes event Tasks when their event is triggered', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend = new RecordingRunBackend();
    const service = new TaskService({
      store,
      executionBackend: backend,
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

    const created = await service.createTask({
      title: 'On deploy',
      prompt: 'summarize deploy',
      workspace: workspaceRef,
      runner: 'pi:pi',
      triggerKind: TaskTriggerKind.EVENT,
      eventName: 'deploy.completed',
      authBinding,
    }, context);

    const materialized = await service.materializeEventTasks({
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
    expect(backend.inputs).toHaveLength(1);
    expect(backend.inputs[0].prompt).toBe('summarize deploy\n\nEvent payload:\n{"version":"1.2.3"}');
  });
});


describe('Task first-checkpoint failure diagnostics', () => {
  const context = { userId: 'u1', auth: { type: 'solid' as const, webId: 'https://pod.test/alice/profile/card#me', clientId: 'client', clientSecret: 'secret' } };
  async function prepare(store: InMemoryStore<StoreContext>, backend: RunExecutionBackend,
    contextRetriever?: { retrieve: () => Promise<undefined> }) {
    const service = new TaskService({ store, executionBackend: backend, contextRetriever });
    const authBinding = await createTaskAuthBinding(store, context);
    const { task } = await service.createTask({ prompt: 'private prompt', workspace: workspaceRef,
      runner: 'pi:codex', triggerKind: TaskTriggerKind.INTERVAL, intervalSeconds: 3600, authBinding }, context);
    return { service, task };
  }
  it('records a deferred retrieval failure without changing queued acknowledgment or local metadata', async () => {
    const store = new InMemoryStore<StoreContext>();
    let reject!: (error: Error) => void;
    const pending = new Promise<undefined>((_resolve, fail) => { reject = fail; });
    let retrievalStarted = false;
    const { service, task } = await prepare(store, new RecordingRunBackend(), { retrieve: () => { retrievalStarted = true; return pending; } });
    const accepted = await service.runNow(task.id, context);
    expect(accepted.run.status).toBe('queued');
    await vi.waitFor(() => expect(retrievalStarted).toBe(true));
    reject(new Error('Bearer private-token https://private.example/prompt'));
    await vi.waitFor(async () => expect((await store.loadRun(accepted.run.id, context)).status).toBe('failed'));
    const final = await store.loadRun(accepted.run.id, context);
    expect(final.metadata?.failureDiagnostic).toEqual({ code: 'TASK_EXECUTION_ERROR', stage: 'retrieve_context', status: 'failed' });
    expect(final.metadata?.taskId).toBe(task.id);
    expect(JSON.stringify(final.metadata?.failureDiagnostic)).not.toContain('private');
  });
  it('captures failures before the inner execution try at the actual assistant save', async () => {
    const store = new InMemoryStore<StoreContext>();
    const original = store.addThreadItem.bind(store);
    vi.spyOn(store, 'addThreadItem').mockImplementation(async (thread, item, ctx) => {
      if (item.type === 'assistant_message') throw new Error('private storage body');
      return original(thread, item, ctx);
    });
    const { service, task } = await prepare(store, new RecordingRunBackend());
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(async () => expect((await store.loadRun(accepted.run.id, context)).status).toBe('failed'));
    expect((await store.loadRun(accepted.run.id, context)).metadata?.failureDiagnostic).toEqual({ code: 'TASK_BACKGROUND_ERROR', stage: 'save_assistant_initial', status: 'failed' });
  });
  it('preserves the primary runtime diagnostic when terminal assistant persistence also fails', async () => {
    const store = new InMemoryStore<StoreContext>();
    const backend: RunExecutionBackend = { async *start() { yield { type: 'error', message: 'private provider response' }; } };
    vi.spyOn(store, 'saveItem').mockRejectedValue(new Error('secondary persistence secret'));
    const { service, task } = await prepare(store, backend);
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(async () => expect((await store.loadRun(accepted.run.id, context)).status).toBe('failed'));
    expect((await store.loadRun(accepted.run.id, context)).metadata?.failureDiagnostic).toEqual({ code: 'TASK_RUNTIME_ERROR', stage: 'start_backend', status: 'failed' });
  });
  it('classifies cancellation monitor read errors without exposing the error text', async () => {
    const store = new InMemoryStore<StoreContext>();
    const { service, task } = await prepare(store, new RecordingRunBackend());
    const load = store.loadRun.bind(store);
    vi.spyOn(store, 'loadRun').mockImplementation(load).mockRejectedValueOnce(new Error('Bearer monitor-secret'));
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(async () => expect((await load(accepted.run.id, context)).status).toBe('failed'));
    expect((await load(accepted.run.id, context)).metadata?.failureDiagnostic).toEqual({ code: 'TASK_STATE_READ_ERROR', stage: 'read_current_run', status: 'failed' });
  });
  it('records a deferred ONCE terminal Task save at its actual boundary', async () => {
    const store = new InMemoryStore<StoreContext>();
    const { service, task } = await prepare(store, new RecordingRunBackend());
    task.triggerKind = TaskTriggerKind.ONCE;
    await store.saveTask(task, context);
    let reject!: (error: Error) => void;
    let entered = false;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const saveTask = store.saveTask.bind(store);
    vi.spyOn(store, 'saveTask').mockImplementation(async (value, ctx) => {
      if (value.status === TaskStatus.COMPLETED) { entered = true; await pending; }
      else await saveTask(value, ctx);
    });
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(() => expect(entered).toBe(true));
    reject(new Error('private terminal Task persistence'));
    await vi.waitFor(async () => expect((await store.loadRun(accepted.run.id, context)).status).toBe('failed'));
    expect((await store.loadRun(accepted.run.id, context)).metadata?.failureDiagnostic).toEqual({ code: 'TASK_BACKGROUND_ERROR', stage: 'save_task_terminal', status: 'failed' });
  });
  it('records a deferred cancelled assistant save without changing cancellation', async () => {
    const store = new InMemoryStore<StoreContext>();
    const { service, task } = await prepare(store, new RecordingRunBackend());
    const saveRun = store.saveRun.bind(store);
    let finalSaved = false;
    vi.spyOn(store, 'saveRun').mockImplementation(async (value, ctx) => {
      if (value.status === 'running') { value.status = 'cancelled'; value.cancelRequestedAt = Date.now() / 1000; }
      await saveRun(value, ctx);
      if (value.metadata?.failureDiagnostic) finalSaved = true;
    });
    let reject!: (error: Error) => void;
    let entered = false;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    vi.spyOn(store, 'saveItem').mockImplementation(async () => { entered = true; await pending; });
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(() => expect(entered).toBe(true));
    reject(new Error('private cancelled assistant persistence'));
    await vi.waitFor(() => expect(finalSaved).toBe(true));
    const final = await store.loadRun(accepted.run.id, context);
    expect(final.status).toBe('cancelled');
    expect(final.metadata?.failureDiagnostic).toEqual({ code: 'TASK_BACKGROUND_ERROR', stage: 'save_terminal_assistant', status: 'failed' });
  });
  it('allows concurrent cancellation to win over a deferred failure', async () => {
    const store = new InMemoryStore<StoreContext>();
    let reject!: (error: Error) => void;
    const pending = new Promise<undefined>((_resolve, fail) => { reject = fail; });
    let retrievalStarted = false;
    const { service, task } = await prepare(store, new RecordingRunBackend(), { retrieve: () => { retrievalStarted = true; return pending; } });
    const accepted = await service.runNow(task.id, context);
    await vi.waitFor(() => expect(retrievalStarted).toBe(true));
    const save = vi.spyOn(store, 'saveRun');
    const current = await store.loadRun(accepted.run.id, context);
    current.cancelRequestedAt = Date.now() / 1000; current.status = 'cancelled';
    await store.saveRun(current, context);
    reject(new Error('private failure after cancel'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ failureDiagnostic: expect.objectContaining({ stage: 'retrieve_context' }) }),
    }), context));
    expect((await store.loadRun(accepted.run.id, context)).status).toBe('cancelled');
  });
});
