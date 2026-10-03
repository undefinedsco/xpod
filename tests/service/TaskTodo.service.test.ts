import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { TaskService } from '../../src/api/tasks/TaskService';
import { projectTask } from '../../src/api/handlers/TaskHandler';
const owner = 'https://pod.test/alice/profile/card#me';
const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner } };
const setup = () => { const store = new InMemoryStore<StoreContext>(); return { store, service: new TaskService({ store, executeRuns: false }) }; };
describe('task todo lifecycle', () => {
  it('creates human intent without scheduling or materializing a run', async () => {
    const { service, store } = setup();
    const task = await service.createTodo({ prompt: 'Read the report', workspace: 'https://pod.test/work/', assignedTo: owner, dueAt: 1234 }, context);
    expect(task.status).toBe('open'); expect(task.assignedTo).toBe(owner);
    expect(task.authBinding).toBeUndefined();
    expect(await store.listRuns({}, context)).toEqual([]);
    expect((await service.listTasks(context))[0].dueAt).toBe(1234);
  });
  it('stores completion time, removes it when reopened, and clears a deadline explicitly', async () => {
    const { service } = setup();
    const task = await service.createTodo({ prompt: 'Read', workspace: 'https://pod.test/work/', assignedTo: owner, dueAt: 100 }, context);
    const completed = await service.updateTodo(task.id, owner, { completed: true, notes: 'saved', priority: 'high' }, context);
    expect(completed.completedAt).toBeTypeOf('number'); expect(completed.status).toBe('completed');
    const reopened = await service.updateTodo(task.id, owner, { completed: false, dueAt: null }, context);
    expect(reopened.completedAt).toBeUndefined(); expect(reopened.dueAt).toBeUndefined(); expect(reopened.notes).toBe('saved');
  });
  it('does not edit another assignee or run a personal todo', async () => {
    const { service } = setup();
    const task = await service.createTodo({ prompt: 'Read', workspace: 'https://pod.test/work/', assignedTo: owner }, context);
    await expect(service.updateTodo(task.id, 'https://other.test/me', { completed: true }, context)).rejects.toThrow('own todo');
    await expect(service.runNow(task.id, context)).rejects.toThrow('AI tasks');
  });
  it('keeps manual execution separate from a paused recurring schedule', async () => {
    const { service } = setup();
    const { task } = await service.createTask({ prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600, startAt: 10000000,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    await service.setSchedulePaused(task.id, true, context);
    const { task: after, run } = await service.runNow(task.id, context);
    expect(run.status).toBe('queued'); expect(after.status).toBe('blocked'); expect(after.nextRunAt).toBe(10000000);
    expect((await service.loadTask(task.id, context)).status).toBe('blocked');
    const resumed = await service.setSchedulePaused(task.id, false, context);
    expect(resumed.nextRunAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
  it('never returns agent credentials or runtime metadata in the applet projection', async () => {
    const { service } = setup();
    const task = await service.createTodo({ prompt: 'Read', workspace: 'https://pod.test/work/', assignedTo: owner }, context);
    const projected = projectTask({ ...task, runner: 'private-runner', metadata: { secret: 'not-for-ui' } });
    expect(projected).not.toHaveProperty('runner'); expect(projected).not.toHaveProperty('metadata'); expect(projected).not.toHaveProperty('authBinding');
  });
});

describe('background manual task execution', () => {
  it('validates the invocation credential before persisting a Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const issuer = { issue: vi.fn().mockRejectedValue(new Error('Invocation credential unavailable')) };
    const service = new TaskService({ store, aiConnectionInvocationKeyIssuer: issuer });
    const { task } = await service.createTask({ prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    await expect(service.runNow(task.id, context)).rejects.toThrow('Invocation credential unavailable');
    expect(await store.listRuns({}, context)).toEqual([]);
    expect((await store.loadTask(task.id, context)).lastRunAt).toBeUndefined();
  });

  it('records context preparation failure without leaving an unclaimed running Run', async () => {
    const store = new InMemoryStore<StoreContext>();
    const start = vi.fn(async function* () { yield { type: 'text' as const, text: 'should not start' }; });
    const service = new TaskService({ store, executionBackend: { start }, contextRetriever: {
      retrieve: async () => { throw new Error('Context unavailable'); },
    } });
    const { task } = await service.createTask({ prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    const { run } = await service.runNow(task.id, context);
    expect(run.status).toBe('queued');
    await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('failed'));
    const finished = await store.loadRun(run.id, context);
    expect(start).not.toHaveBeenCalled();
    expect(finished).toMatchObject({ status: 'failed', error: 'Error: Context unavailable' });
    expect(finished.completedAt).toBeTypeOf('number');
    expect((await store.loadRun(run.id, context)).status).toBe('failed');
    expect((await store.loadRunSteps(run.id, context)).some(step => step.type === 'run.failed')).toBe(true);
  });

  it('persists a failure if background startup fails before the runtime starts', async () => {
    const store = new InMemoryStore<StoreContext>();
    const service = new TaskService({ store });
    const { task } = await service.createTask({ prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    const addItem = store.addThreadItem.bind(store);
    vi.spyOn(store, 'addThreadItem').mockImplementation(async (thread, item, ctx) => {
      if (item.type === 'assistant_message') throw new Error('Assistant storage unavailable');
      return addItem(thread, item, ctx);
    });
    const { run } = await service.runNow(task.id, context);
    expect(run.status).toBe('queued');
    await vi.waitFor(async () => expect(await store.loadRun(run.id, context))
      .toMatchObject({ status: 'failed', error: 'Error: Assistant storage unavailable' }));
  });

  it('aborts a silent runtime, keeps the cancellation request and stops the same run', async () => {
    const { cancelRun } = await import('../../src/api/runs/RunCancellation');
    const store = new InMemoryStore<StoreContext>();
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let aborted = false; let finalized = false;
    const backend = { async *start(input: import('../../src/api/runs/RunExecutionBackend').RunExecutionInput) {
      try {
        start();
        await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      } finally { finalized = true; }
    } };
    const service = new TaskService({ store, executionBackend: backend });
    const { task } = await service.createTask({ prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
      authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
    }, context);
    const running = service.runNow(task.id, context);
    const accepted = await running;
    expect(accepted.run.status).toBe('queued');
    await started;
    const [run] = await store.listRuns({}, context);
    await cancelRun({ store, runId: run.id, context, resourceIri: () => 'https://pod.test/run' });
    await vi.waitFor(async () => expect((await store.loadRun(run.id, context)).status).toBe('cancelled'));
    expect(aborted).toBe(true); expect(finalized).toBe(true);
    expect(accepted.run.id).toBe(run.id);
    expect((await store.loadRun(run.id, context)).cancelRequestedAt).toBeTypeOf('number');
    expect((await store.loadRunSteps(run.id, context)).some(step => step.type === 'run.cancelled')).toBe(true);
  });
});
