import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalInsert, SessionInsert } from '@undefineds.co/models';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { ManagedRunWorker } from '../../src/api/runs/ManagedRunWorker';
import { cancelRun } from '../../src/api/runs/RunCancellation';
import type { RunExecutionBackend, RunExecutionInput } from '../../src/api/runs/RunExecutionBackend';
import { TaskService } from '../../src/api/tasks/TaskService';

const owner = 'https://pod.test/alice/profile/card#me';
const context: StoreContext = { userId: owner, auth: { type: 'solid', webId: owner } };

async function setup(backend: RunExecutionBackend, store = new InMemoryStore<StoreContext>()) {
  const service = new TaskService({ store, executeRuns: false });
  const { task } = await service.createTask({
    prompt: 'Summarize', workspace: 'https://pod.test/work/', triggerKind: 'interval', intervalSeconds: 3600,
    authBinding: { id: 'credential', kind: 'solid-client-credentials', webId: owner, clientId: 'agent-key', status: 'active', createdAt: 1 },
  }, context);
  const { run } = await service.runNow(task.id, context);
  const worker = new ManagedRunWorker({ store, runtimeDriver: backend });
  return { store, run, worker, cancel: () => cancelRun({ store, runId: run.id, context, resourceIri: () => 'https://pod.test/run' }) };
}

describe('durable managed run cancellation', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(['return', 'throw'])('aborts a silent backend (%s), preserves the request and clears the cancellation timer', async termination => {
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    let finalized = false;
    let release!: () => void;
    const backend = { async *start(input: RunExecutionInput) {
      signal = input.signal;
      try {
        started();
        await new Promise<void>(resolve => {
          release = resolve;
          input.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (termination === 'throw') throw new Error('provider aborted');
      } finally { finalized = true; }
    } };
    const { store, run, worker, cancel } = await setup(backend);
    const running = worker.executeRun(run.id, context);
    await ready;
    await cancel();
    await vi.advanceTimersByTimeAsync(500);
    const aborted = signal?.aborted;
    release(); // Also lets the pre-fix implementation finish instead of hanging the test.
    const result = await running;
    expect(aborted).toBe(true);
    expect(finalized).toBe(true);
    expect(result.status).toBe('cancelled');
    expect((await store.loadRun(run.id, context)).cancelRequestedAt).toBeTypeOf('number');
    expect((await store.loadRunSteps(run.id, context)).filter(step => step.type === 'run.cancelled')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['completed', 'waiting_input', 'waiting_runner'] as const)('returns committed cancellation when Stop wins %s persistence', async proposed => {
    const { store, run, worker, cancel } = await setup({ async *start() {
      yield { type: 'text' as const, text: 'Finished text' };
      if (proposed === 'waiting_input') yield { type: 'tool_call' as const, requestId: 'tool-race', name: 'publish', arguments: '{}' };
      if (proposed === 'waiting_runner') yield { type: 'waiting_runner' as const, workspace: 'https://pod.test/work/', message: 'Runner unavailable' };
    } });
    let reached!: () => void; let release!: () => void;
    const atFinish = new Promise<void>(resolve => { reached = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const save = store.saveRun.bind(store);
    vi.spyOn(store, 'saveRun').mockImplementation(async (value, ctx) => {
      if (value.status === proposed) { reached(); await barrier; }
      await save(value, ctx);
    });
    const execution = worker.executeRun(run.id, context);
    await atFinish;
    await cancel();
    release();
    expect((await execution).status).toBe('cancelled');
    expect((await store.loadRun(run.id, context)).status).toBe('cancelled');
    const items = await store.loadThreadItems({ thread_id: run.thread }, undefined, 100, 'asc', context);
    expect(items.data.find(item => item.type === 'assistant_message')).toMatchObject({ status: 'incomplete' });
    expect((await store.loadRunSteps(run.id, context)).some(step => step.type === 'run.completed')).toBe(false);
  });

  it('does not claim a run stopped before execution', async () => {
    vi.useFakeTimers();
    const start = vi.fn(async function* () {});
    const { run, worker, cancel } = await setup({ start });
    await cancel();
    expect((await worker.executeRun(run.id, context)).status).toBe('skipped');
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not invoke the backend if cancelled during context retrieval', async () => {
    vi.useFakeTimers();
    const start = vi.fn(async function* () {});
    const { store, run, cancel } = await setup({ start });
    const worker = new ManagedRunWorker({ store, runtimeDriver: { start }, contextRetriever: {
      async retrieve() { await cancel(); return undefined; },
    } });
    expect((await worker.executeRun(run.id, context)).status).toBe('cancelled');
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the monitor when the backend fails', async () => {
    vi.useFakeTimers();
    const { run, worker } = await setup({ async *start() { throw new Error('provider failed'); } });
    await expect(worker.executeRun(run.id, context)).rejects.toThrow('provider failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('durable managed run approval checkpoint', () => {
  class ApprovalStore extends InMemoryStore<StoreContext> {
    approvals: ApprovalInsert[] = [];
    sessions: SessionInsert[] = [];
    async writeTaskApproval(approval: ApprovalInsert) {
      this.approvals.push(approval);
      return `https://pod.test/alice/.data/${approval.id}`;
    }
    async saveRunApprovalSession(session: SessionInsert) {
      this.sessions.push(session);
      return `https://pod.test/alice/.data/${session.id}`;
    }
  }

  it.each([true, false])('persists a resumable client tool checkpoint (approval=%s)', async needsApproval => {
    const store = new ApprovalStore();
    const event = {
      type: 'tool_call' as const, requestId: 'tool-1', name: needsApproval ? 'request_approval' : 'publish', arguments: '{}',
      ...(needsApproval ? { approval: { target: 'https://pod.test/draft', action: 'publish', risk: 'medium' as const, description: 'Publish the draft' } } : {}),
    };
    const { run, worker } = await setup({ async *start() { yield event; } }, store);
    expect((await worker.executeRun(run.id, context)).status).toBe('waiting_input');
    const paused = await store.loadRun(run.id, context);
    const checkpoint = paused.metadata?.waitingTool as { itemId: string; requestId: string };
    expect(checkpoint.requestId).toBe('tool-1');
    const item = await store.loadItem({ thread_id: run.thread }, checkpoint.itemId, context);
    expect(item).toMatchObject({ type: 'client_tool_call', status: 'pending', call_id: 'tool-1', metadata: { runId: run.id } });
    expect(paused.completedAt).toBeUndefined();
    if (needsApproval) {
      expect(store.approvals).toHaveLength(1);
      expect(store.approvals[0]).toMatchObject({ thread: run.thread, toolCallId: 'tool-1', assignedTo: owner, status: 'pending' });
      expect(store.sessions[store.sessions.length - 1]).toMatchObject({ status: 'paused', owner, thread: run.thread });
    } else {
      expect(store.approvals).toHaveLength(0);
      expect(store.sessions).toHaveLength(0);
    }
  });
});
