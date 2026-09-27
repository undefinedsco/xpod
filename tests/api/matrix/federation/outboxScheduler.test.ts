import { describe, expect, it, vi } from 'vitest';
import { InMemoryMatrixOutboundStore, MatrixOutbox } from '../../../../src/api/matrix/federation/outboundQueue';
import { MatrixOutboxScheduler, type SchedulerTimer } from '../../../../src/api/matrix/federation/outboxScheduler';
import type { MatrixDeliveryOutcome } from '../../../../src/api/matrix/federation/outboundTransaction';

const SCOPE_A = 'https://pod-a.example/alice/';
const SCOPE_B = 'https://pod-b.example/bob/';

function outcome(status: 'delivered' | 'retry' | 'rejected'): MatrixDeliveryOutcome {
  return { status, origin: 'alice.example', destination: 'remote.example', txnId: '-', reason: status };
}

/** An outbox whose flush is scripted per scope. */
function outbox(options: {
  results?: Record<string, ('delivered' | 'retry' | 'rejected')[]>;
  fail?: (scope: string) => boolean;
  /** The scopes with work; one by default so a pass is one flush call. */
  scopes?: readonly string[];
} = {}) {
  const store = new InMemoryMatrixOutboundStore();
  const attempts = new Map<string, number>();
  const flush = vi.fn(async ({ scope }: { scope: string }) => {
    if (options.fail?.(scope)) throw new Error(`flush failed for ${scope}`);
    const sequence = options.results?.[scope] ?? [ 'delivered' ];
    const index = attempts.get(scope) ?? 0;
    attempts.set(scope, index + 1);
    const status = sequence[Math.min(index, sequence.length - 1)];
    return status === 'delivered'
      ? { delivered: [ `txn-${scope}` ], rejected: [], deferred: [], blocked: [], waiting: [], abandoned: [] }
      : status === 'rejected'
        ? { delivered: [], rejected: [ { txnId: `txn-${scope}`, destination: 'remote.example', reason: 'no' } ], deferred: [], blocked: [], waiting: [], abandoned: [] }
        : { delivered: [], rejected: [], deferred: [ { txnId: `txn-${scope}`, destination: 'remote.example', reason: 'later' } ], blocked: [ { txnId: 'x', destination: 'remote.example' } ], waiting: [], abandoned: [] };
  });
  return {
    outbox: { scopes: async () => [ ...(options.scopes ?? [ SCOPE_A ]) ], flush } as unknown as MatrixOutbox,
    flush,
    store,
  };
}

function scheduler(options: Parameters<typeof outbox>[0] = {}, schedulerOptions: { intervalMs?: number } = {}) {
  const created = outbox(options);
  const timers: { fn: () => void; ms: number }[] = [];
  const cleared: SchedulerTimer[] = [];
  const passes: unknown[] = [];
  const errors: Error[] = [];
  const instance = new MatrixOutboxScheduler({
    outbox: created.outbox,
    intervalMs: schedulerOptions.intervalMs ?? 0,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length as unknown as SchedulerTimer; },
    clearInterval: handle => { cleared.push(handle); },
    onPass: pass => { passes.push(pass); },
    onError: error => { errors.push(error); },
  });
  return { scheduler: instance, ...created, timers, cleared, passes, errors };
}

describe('driving the outbound queue', () => {
  it('flushes every scope with work and reports what happened', async () => {
    const { scheduler: instance, flush, passes } = scheduler({ scopes: [ SCOPE_A, SCOPE_B ], results: { [SCOPE_A]: [ 'delivered' ], [SCOPE_B]: [ 'retry' ] } });
    const pass = await instance.flushOnce();

    expect(flush.mock.calls.map(call => call[0].scope)).toEqual([ SCOPE_A, SCOPE_B ]);
    expect(pass).toMatchObject({ scopes: 2, delivered: 1, deferred: 1, blocked: 1, failed: 0 });
    expect(passes).toEqual([ pass ]);
  });

  it('can be driven by a signal alone, without the periodic timer', async () => {
    const { scheduler: instance, flush } = scheduler();
    instance.schedule();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(instance.isRunning()).toBe(true);
    instance.stop();
  });

  it('never runs two passes at once, and coalesces a signal that arrives during one', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const created = outbox();
    const flush = vi.fn(async (input: { scope: string }) => {
      await gate;
      return await created.flush(input);
    });
    const instance = new MatrixOutboxScheduler({
      outbox: { scopes: async () => [ SCOPE_A ], flush } as unknown as MatrixOutbox,
      intervalMs: 0,
    });

    instance.schedule();
    instance.schedule();
    instance.schedule();
    // Only one pass has started, however many signals arrived.
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    release?.();
    // The signals collapse into exactly one follow-up pass.
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('keeps going when one scope fails, and reports the failure', async () => {
    const { scheduler: instance, errors, passes } = scheduler({ scopes: [ SCOPE_A, SCOPE_B ], fail: scope => scope === SCOPE_A });
    const pass = await instance.flushOnce();

    expect(pass).toMatchObject({ scopes: 1, delivered: 1, failed: 1 });
    expect(errors[0]?.message).toMatch(/flush failed/u);
    expect(passes).toEqual([ pass ]);
  });

  it('registers the periodic pass and clears it on stop', async () => {
    const { scheduler: instance, timers, cleared, flush } = scheduler({}, { intervalMs: 1_000 });
    // Armed from construction, so signals work; the timer is added by start().
    expect(instance.isRunning()).toBe(true);
    expect(timers).toEqual([]);
    instance.start();
    expect(timers).toEqual([ { fn: expect.any(Function), ms: 1_000 } ]);

    // The timer is only a signal into the same pass.
    const before = flush.mock.calls.length;
    timers[0].fn();
    await vi.waitFor(() => expect(flush.mock.calls.length).toBeGreaterThan(before));

    instance.stop();
    expect(instance.isRunning()).toBe(false);
    expect(cleared).toHaveLength(1);
    // Starting again is idempotent while running, and stopping twice is harmless.
    instance.start();
    instance.start();
    instance.stop();
    instance.stop();
    expect(timers).toHaveLength(2);
  });

  it('does not schedule anything once stopped', async () => {
    const { scheduler: instance, flush } = scheduler();
    instance.start();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    instance.stop();
    instance.schedule();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable scope list instead of throwing at the caller', async () => {
    const errors: Error[] = [];
    const instance = new MatrixOutboxScheduler({
      outbox: { scopes: async () => { throw new Error('store unavailable'); }, flush: vi.fn() } as unknown as MatrixOutbox,
      intervalMs: 0,
      onError: error => { errors.push(error); },
    });
    await expect(instance.flushOnce()).resolves.toMatchObject({ scopes: 0, failed: 0 });
    expect(errors[0]?.message).toMatch(/store unavailable/u);
  });

  it('flushes nothing when no scope has work', async () => {
    const flush = vi.fn();
    const instance = new MatrixOutboxScheduler({
      outbox: { scopes: async () => [], flush } as unknown as MatrixOutbox,
      intervalMs: 0,
    });
    await expect(instance.flushOnce()).resolves.toMatchObject({ scopes: 0 });
    expect(flush).not.toHaveBeenCalled();
  });
});
