import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, type StoreContext } from '../../src/api/chatkit/store';
import { cancelRun, monitorRunCancellation } from '../../src/api/runs/RunCancellation';
import type { RunRecordData } from '../../src/api/runs/store';
const context = { userId: 'owner' };
describe('shared run cancellation', () => {
  it('completes the approval Session and retries its failed write after the Run is already terminal', async () => {
    const store = Object.assign(new InMemoryStore<StoreContext>(), {
      saveRunApprovalSession: vi.fn().mockRejectedValueOnce(new Error('session write failed')).mockResolvedValue('https://pod.test/session'),
    });
    const authContext = { userId: 'owner', auth: { type: 'solid', webId: 'https://pod.test/profile/card#me' } };
    const run: RunRecordData = { id: 'task/default/2026/10/02/runs.ttl#run', thread: 'https://pod.test/thread', workspace: 'https://pod.test/work/', runner: 'pi:pi', status: 'waiting_input', createdAt: 1, updatedAt: 1, metadata: { approvalSessionKey: 'session' } };
    await store.saveRun(run, authContext);
    const input = { store, runId: run.id, context: authContext, resourceIri: () => 'https://pod.test/run' };
    await expect(cancelRun(input)).rejects.toThrow('session write failed');
    expect((await store.loadRun(run.id, authContext)).status).toBe('cancelled');
    expect(await cancelRun(input)).toMatchObject({ status: 'cancelled' });
    expect(store.saveRunApprovalSession).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }), authContext);
    expect(await store.loadRunSteps(run.id, authContext)).toHaveLength(2);
  });
  it.each(['queued', 'waiting_input', 'waiting_runner'] as const)('terminates %s without requiring an active worker', async status => {
    const store = new InMemoryStore<StoreContext>();
    const run: RunRecordData = { id: 'task/default/2026/10/02/runs.ttl#run', thread: 'task/default/index.ttl#thread', workspace: 'https://pod.test/work/', runner: 'pi:pi', status, createdAt: 1, updatedAt: 1, leaseOwner: 'worker', leaseExpiresAt: 9999999999 };
    await store.saveRun(run, context);
    const input = { store, runId: run.id, context, resourceIri: () => 'https://pod.test/.data/task/default/2026/10/02/runs.ttl#run' };
    const result = await cancelRun(input);
    expect(result.status).toBe('cancelled'); expect(result.completedAt).toBeTypeOf('number'); expect(result.leaseOwner).toBeUndefined();
    expect((await store.loadRunSteps(run.id, context)).map(step => step.type)).toEqual(['run.cancel_requested', 'run.cancelled']);
    await cancelRun(input);
    expect(await store.loadRunSteps(run.id, context)).toHaveLength(2);
  });
  it('only requests cancellation of a running operation', async () => {
    const store = new InMemoryStore<StoreContext>();
    const run: RunRecordData = { id: 'task/default/2026/10/02/runs.ttl#run', thread: 'task/default/index.ttl#thread', workspace: 'https://pod.test/work/', runner: 'pi:pi', status: 'running', createdAt: 1, updatedAt: 1 };
    await store.saveRun(run, context);
    const result = await cancelRun({ store, runId: run.id, context, resourceIri: () => 'https://pod.test/run' });
    expect(result.status).toBe('running'); expect(result.cancelRequestedAt).toBeTypeOf('number'); expect(result.completedAt).toBeUndefined();
  });
});

describe('durable cancellation monitor', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fails closed on read failure and stops polling after disposal', async () => {
    vi.useFakeTimers();
    const failure = new Error('state unavailable');
    const loadRun = vi.fn().mockResolvedValueOnce({}).mockRejectedValue(failure);
    const monitor = await monitorRunCancellation({ store: { loadRun }, runId: 'run', context });
    await vi.advanceTimersByTimeAsync(500);
    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.error).toBe(failure);
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadRun).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes reads and ignores a late read after disposal', async () => {
    vi.useFakeTimers();
    let resolveRead!: (value: { cancelRequestedAt: number }) => void;
    const loadRun = vi.fn().mockResolvedValueOnce({}).mockImplementation(() =>
      new Promise(resolve => { resolveRead = resolve; }));
    const monitor = await monitorRunCancellation({ store: { loadRun }, runId: 'run', context });
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadRun).toHaveBeenCalledTimes(2);
    monitor.dispose();
    resolveRead({ cancelRequestedAt: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.signal.aborted).toBe(true);
    expect(monitor.cancelRequestedAt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
