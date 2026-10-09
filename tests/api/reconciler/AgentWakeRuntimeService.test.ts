import { describe, expect, it, vi } from 'vitest';
import { AgentWakeRuntimeService, type AgentWakeRuntimeBackend } from '../../../src/api/reconciler/AgentWakeRuntimeService';
import { InMemoryWakeAgentQueue } from '../../../src/api/reconciler/WakeAgentQueue';
import { MatrixError } from '../../../src/api/matrix/MatrixError';

function fixture() {
  let now = 1_000;
  const queue = new InMemoryWakeAgentQueue({ now: () => now });
  const backend: AgentWakeRuntimeBackend = {
    authorize: vi.fn(async () => ({ thread: 'https://pod/thread' })),
    recover: vi.fn(async () => undefined),
    loadInput: vi.fn(async () => ({ content: 'task' })),
    commitResult: vi.fn(async () => ({ eventId: '$result', run: 'https://pod/run' })),
    recordFailure: vi.fn(async () => undefined),
  };
  const service = new AgentWakeRuntimeService(queue, backend);
  const request = { roomId: '!room', agent: 'https://pod/agent', runtimeId: 'worker', leaseMs: 1000 };
  const context = { webId: 'https://alice/#me' };
  const enqueue = async (id = 'wake') => queue.enqueue({ id, thread: 'https://pod/thread', agent: request.agent, triggerMessage: `https://pod/${id}`, reason: 'manual', status: 'queued', createdAt: new Date(now).toISOString() });
  return { queue, backend, service, request, context, enqueue, advance: () => { now += 1001; } };
}

describe('AgentWakeRuntimeService', () => {
  it('claims input, serializes a lane, renews and commits before acknowledgement', async () => {
    const f = fixture();
    await f.enqueue();
    await f.enqueue('next');
    const claimed = await f.service.claim(f.request, f.context);
    expect(claimed.input).toEqual({ content: 'task' });
    expect(await f.service.claim({ ...f.request, runtimeId: 'other' }, f.context)).toEqual({ job: null });
    const lease = { ...f.request, id: claimed.job!.id, fencingToken: claimed.job!.fencingToken! };
    await expect(f.service.renew(lease, f.context)).resolves.toEqual({ ok: true });
    await expect(f.service.complete({ ...lease, body: 'done' }, f.context)).resolves.toEqual({ eventId: '$result', run: 'https://pod/run' });
    expect((await f.service.claim(f.request, f.context)).job?.id).toBe('next');
  });
  it('authorizes before recovery or input access on every operation', async () => {
    const f = fixture();
    vi.mocked(f.backend.authorize).mockRejectedValue(new MatrixError(403, 'M_FORBIDDEN', 'denied'));
    await expect(f.service.claim(f.request, f.context)).rejects.toMatchObject({ status: 403 });
    expect(f.backend.recover).not.toHaveBeenCalled();
    expect(f.backend.loadInput).not.toHaveBeenCalled();
    await expect(f.service.complete({ ...f.request, id: 'wake', fencingToken: '1', body: 'done' }, f.context)).rejects.toMatchObject({ status: 403 });
    expect(f.backend.commitResult).not.toHaveBeenCalled();
  });
  it('rejects expired fences and another principal or runtime before writing output', async () => {
    const f = fixture();
    await f.enqueue();
    const { job } = await f.service.claim(f.request, f.context);
    const lease = { ...f.request, id: job!.id, fencingToken: job!.fencingToken!, body: 'done' };
    await expect(f.service.complete({ ...lease, runtimeId: 'other' }, f.context)).rejects.toMatchObject({ status: 409 });
    await expect(f.service.complete(lease, { webId: 'https://bob/#me' })).rejects.toMatchObject({ status: 409 });
    f.advance();
    await expect(f.service.complete(lease, f.context)).rejects.toMatchObject({ status: 409 });
    const replacement = await f.service.claim(f.request, f.context);
    expect(replacement.job?.fencingToken).not.toBe(job!.fencingToken);
    expect(f.backend.commitResult).not.toHaveBeenCalled();
  });
  it('returns input failures to the retry queue and supports terminal failure', async () => {
    const f = fixture();
    await f.enqueue();
    vi.mocked(f.backend.loadInput).mockRejectedValueOnce(new Error('offline'));
    await expect(f.service.claim(f.request, f.context)).rejects.toThrow('offline');
    const { job } = await f.service.claim(f.request, f.context);
    expect(job?.attempts).toBe(2);
    await f.service.fail({ ...f.request, id: job!.id, fencingToken: job!.fencingToken!, retry: false, error: 'unsupported' }, f.context);
    expect(await f.service.claim(f.request, f.context)).toEqual({ job: null });
  });
  it('does not acknowledge a failed Pod result write', async () => {
    const f = fixture();
    await f.enqueue();
    const { job } = await f.service.claim(f.request, f.context);
    vi.mocked(f.backend.commitResult).mockRejectedValue(new Error('offline'));
    await expect(f.service.complete({ ...f.request, id: job!.id, fencingToken: job!.fencingToken!, body: 'done' }, f.context)).rejects.toThrow('offline');
    expect((await f.queue.listQueued('https://pod/thread'))[0].status).toBe('leased');
  });
  it('persists failure before queue acknowledgement and leaves work leased when persistence fails', async () => {
    const f = fixture();
    await f.enqueue();
    const { job } = await f.service.claim(f.request, f.context);
    const request = { ...f.request, id: job!.id, fencingToken: job!.fencingToken!, retry: false, error: 'terminal' };
    const fail = vi.spyOn(f.queue, 'fail');
    vi.mocked(f.backend.recordFailure).mockRejectedValueOnce(new Error('Pod offline'));
    await expect(f.service.fail(request, f.context)).rejects.toThrow('Pod offline');
    expect(fail).not.toHaveBeenCalled();
    expect((await f.queue.listQueued('https://pod/thread'))[0].status).toBe('leased');
    await f.service.fail(request, f.context);
    expect(f.backend.recordFailure).toHaveBeenLastCalledWith('!room', expect.objectContaining({ id: 'wake' }), { error: 'terminal', retry: false }, f.context);
    expect(await f.queue.listQueued('https://pod/thread')).toEqual([]);
  });
  it('rejects stale failures before persisting or mutating the queue', async () => {
    const f = fixture();
    await f.enqueue();
    const { job } = await f.service.claim(f.request, f.context);
    f.advance();
    await expect(f.service.fail({ ...f.request, id: job!.id, fencingToken: job!.fencingToken! }, f.context)).rejects.toMatchObject({ status: 409 });
    expect(f.backend.recordFailure).not.toHaveBeenCalled();
  });
  it('persists terminal failure when the third execution or input-load attempt fails', async () => {
    const f = fixture();
    await f.enqueue();
    vi.mocked(f.backend.loadInput).mockRejectedValue(new Error('input unavailable'));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(f.service.claim(f.request, f.context)).rejects.toThrow('input unavailable');
      expect(f.backend.recordFailure).toHaveBeenLastCalledWith('!room', expect.objectContaining({ attempts: attempt }),
        { error: 'Input loading failed', retry: attempt < 3 }, f.context);
    }
    expect(await f.service.claim(f.request, f.context)).toEqual({ job: null });
  });
});
