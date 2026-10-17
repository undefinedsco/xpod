import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { cancelRun } from '../../src/api/runs/RunCancellation';
import { ManagedRunWorker } from '../../src/api/runs/ManagedRunWorker';
import { RunStateCenter } from '../../src/api/runs/RunStateCenter';
import { TaskMaterializer } from '../../src/api/tasks/TaskMaterializer';
import type { RunRecordData } from '../../src/api/runs/store';

const context: StoreContext = { userId: 'https://pod.test/alice/profile/card#me',
  auth: { type: 'solid', webId: 'https://pod.test/alice/profile/card#me' } };
const seed = (status: RunRecordData['status']): RunRecordData => ({
  id: 'task/work/2026/10/01/runs.ttl#run_one', thread: 'https://pod.test/alice/.data/task/work/index.ttl#thread',
  workspace: 'https://pod.test/alice/work/', runner: 'pi:pi', status, createdAt: 1, updatedAt: 1,
  metadata: { approvalSessionKey: 'session_one' },
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Run cancellation versus stale Task transitions', () => {
  it.each(['start', 'finish'] as const)('keeps cancellation when %s was already prepared before Stop', async phase => {
    const store = new InMemoryStore<StoreContext>();
    const run = seed(phase === 'start' ? 'queued' : 'running');
    await store.saveRun(run, context);
    const stale = { ...run };
    const reached = deferred(); const release = deferred();
    const save = store.saveRun.bind(store);
    vi.spyOn(store, 'saveRun').mockImplementation(async (value, ctx) => {
      if (value === stale && value.status === (phase === 'start' ? 'running' : 'failed')) {
        reached.resolve(); await release.promise;
      }
      await save(value, ctx);
    });
    const sessions: string[] = [];
    Object.assign(store, { saveRunApprovalSession: async (session: { status: string }) => {
      sessions.push(session.status); return 'https://pod.test/alice/.data/sessions/one.ttl#session';
    } });
    const materializer = new TaskMaterializer({ store, executeRuns: false }) as unknown as {
      markRunStarted(run: RunRecordData, context: StoreContext, diagnostic: { stage: 'mark_run_started' }): Promise<boolean>;
      finishRun(run: RunRecordData, status: RunRecordData['status'], context: StoreContext, error?: string): Promise<void>;
    };
    const transition = phase === 'start'
      ? materializer.markRunStarted(stale, context, { stage: 'mark_run_started' })
      : materializer.finishRun(stale, 'failed', context, 'obsolete failure');
    await reached.promise;
    const stopped = await cancelRun({ store, runId: run.id, context, resourceIri: () => `https://pod.test/alice/.data/${run.id}` });
    release.resolve();
    const result = await transition;
    if (phase === 'start') expect(result).toBe(false);
    expect(await store.loadRun(run.id, context)).toMatchObject({ status: 'cancelled', cancelRequestedAt: stopped.cancelRequestedAt });
    expect(stale).toMatchObject({ status: 'cancelled', cancelRequestedAt: stopped.cancelRequestedAt });
    expect(stale.error).toBeUndefined();
    expect(sessions.every(status => status === 'completed')).toBe(true);
    const steps = await store.loadRunSteps(run.id, context);
    expect(steps.some(step => step.type === 'run.started' || step.type === 'run.failed')).toBe(false);
    expect(steps.some(step => step.type === 'run.cancelled')).toBe(true);
  });
});


describe('Run start audit after concurrent Stop', () => {
  it.each(['managed', 'state-center'] as const)('does not publish a started event from %s after cancellation wins', async owner => {
    const store = new InMemoryStore<StoreContext>();
    const run = { ...seed('queued'), metadata: undefined };
    await store.saveRun(run, context);
    const reached = deferred(); const release = deferred();
    const save = store.saveRun.bind(store);
    vi.spyOn(store, 'saveRun').mockImplementation(async (value, ctx) => {
      if (value.status === 'running') { reached.resolve(); await release.promise; }
      await save(value, ctx);
    });
    const subject = (owner === 'managed'
      ? new ManagedRunWorker({ store, runtimeDriver: { async *start() {} } })
      : new RunStateCenter({ store })) as unknown as {
        markRunStarted(run: RunRecordData, context: StoreContext): Promise<void>;
      };
    const starting = subject.markRunStarted({ ...run }, context);
    await reached.promise;
    await cancelRun({ store, runId: run.id, context, resourceIri: () => `https://pod.test/alice/.data/${run.id}` });
    release.resolve();
    await starting;
    expect((await store.loadRun(run.id, context)).status).toBe('cancelled');
    expect((await store.loadRunSteps(run.id, context)).some(step => step.type === 'run.started')).toBe(false);
  });
});
