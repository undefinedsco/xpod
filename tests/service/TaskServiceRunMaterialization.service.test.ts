import { describe, expect, it } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { TaskAuthBindingService } from '../../src/api/tasks/TaskAuthBinding';
import { TaskStatus, TaskTriggerKind } from '../../src/api/tasks/schema';
import { RunStepType, RunStatus } from '../../src/api/runs/schema';
import { extractResourceLocalId } from '../../src/api/runs/store';
import { resolveTaskResource } from '../../src/api/tasks/store';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
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

    expect(result.run?.id).toMatch(/^task\/default\/\d{4}\/\d{2}\/\d{2}\/runs\.ttl#run_/);
    expect(result.task).toMatchObject({
      surfaceId: 'default',
      status: TaskStatus.COMPLETED,
      triggerKind: TaskTriggerKind.ONCE,
      workspace: workspaceRef,
      runner: 'pi:codex',
    });
    expect(result.run).toMatchObject({
      commandKind: 'task',
      surfaceId: 'default',
      task: resolveTaskResource('http://localhost/alice', result.task.id),
      thread: result.task.thread,
      workspace: workspaceRef,
      status: RunStatus.COMPLETED,
      prompt: 'ship this once',
    });
    expect(backend.inputs).toHaveLength(1);
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
    expect(run.status).toBe(RunStatus.COMPLETED);
    expect(events.map((event) => event.type)).toEqual([
      RunStepType.CREATED,
      RunStepType.STARTED,
      RunStepType.TEXT_DELTA,
      RunStepType.COMPLETED,
    ]);
    expect(events.every((event) => event.commandKind === 'task' && event.surfaceId === result.task.surfaceId)).toBe(true);
    expect(events.every((event) => event.runId === result.run!.id)).toBe(true);
    expect(events.every((event) => extractResourceLocalId(event.id).startsWith('run-step_'))).toBe(true);
  });

  it('uses explicit surfaceId as the task command surface', async () => {
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
      surfaceId: 'secretary',
      title: 'Secretary task',
      prompt: 'review the workspace',
      workspace: workspaceRef,
      runner: 'pi:codex',
      triggerKind: TaskTriggerKind.ONCE,
      authBinding,
    }, context);

    expect(result.task.surfaceId).toBe('secretary');
    expect(result.run?.id).toMatch(/^task\/secretary\/\d{4}\/\d{2}\/\d{2}\/runs\.ttl#run_/);
    expect(result.run).toMatchObject({
      commandKind: 'task',
      surfaceId: 'secretary',
      runner: 'pi:codex',
    });
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
      commandKind: 'task',
      task: resolveTaskResource('http://localhost/alice', created.task.id),
      status: RunStatus.COMPLETED,
    });
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
