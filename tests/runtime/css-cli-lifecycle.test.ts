import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runCssCliLifecycle } from '../../src/runtime/css-cli-lifecycle';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async(): Promise<void> => { await new Promise<void>(done => setImmediate(done)); };

describe('CSS CLI owns the canonical App lifecycle', () => {
  it('closes an actual listener once after concurrent signals and removes its handlers', async() => {
    const signals = new EventEmitter();
    const server = createServer((_request, response) => { response.end('ready'); });
    const stop = vi.fn(async() => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const failures = vi.fn();
    try {
      await runCssCliLifecycle(async() => ({ start: async() => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }, stop }), failures, signals);
      expect(server.listening).toBe(true);
      signals.emit('SIGTERM'); signals.emit('SIGINT'); signals.emit('SIGTERM');
      await tick();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(server.listening).toBe(false);
      expect(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM')).toBe(0);
      expect(failures).not.toHaveBeenCalled();
    } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('waits for in-progress initialization before stopping the same App', async() => {
    const signals = new EventEmitter(), initializing = deferred(), started = deferred();
    const order: string[] = [];
    const running = runCssCliLifecycle(async() => ({ start: async() => { order.push('start'); started.resolve(); await initializing.promise; order.push('started'); }, stop: async() => { order.push('stop'); } }), vi.fn(), signals);
    await started.promise;
    signals.emit('SIGTERM'); signals.emit('SIGINT');
    expect(order).toEqual(['start']);
    initializing.resolve(); await running;
    expect(order).toEqual(['start', 'started', 'stop']);
  });
  it('retains a signal during creation and finalizes without starting another App', async() => {
    const signals = new EventEmitter(), creating = deferred(), begun = deferred();
    const start = vi.fn(async() => {}), stop = vi.fn(async() => {}), create = vi.fn(async() => { begun.resolve(); await creating.promise; return { start, stop }; });
    const running = runCssCliLifecycle(create, vi.fn(), signals);
    await begun.promise; signals.emit('SIGTERM'); creating.resolve(); await running;
    expect(create).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('finalizes partial startup and preserves the original startup failure', async() => {
    const signals = new EventEmitter(), failure = new Error('partial start failed');
    const stop = vi.fn(async() => {});
    await expect(runCssCliLifecycle(async() => ({ start: async() => { throw failure; }, stop }), vi.fn(), signals)).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledTimes(1); expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('reports failed finalization once without pretending the App closed', async() => {
    const signals = new EventEmitter(), failure = new Error('listener remains owned');
    const report = vi.fn(), stop = vi.fn(async() => { throw failure; });
    await runCssCliLifecycle(async() => ({ start: async() => {}, stop }), report, signals);
    signals.emit('SIGTERM'); signals.emit('SIGINT'); await tick();
    expect(stop).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledWith(failure);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
  });
  it('retains both startup and finalization failures', async() => {
    const signals = new EventEmitter(), startup = new Error('partial initializer'), cleanup = new Error('failed finalizer');
    let failure: unknown;
    try { await runCssCliLifecycle(async() => ({ start: async() => { throw startup; }, stop: async() => { throw cleanup; } }), vi.fn(), signals); }
    catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([startup, cleanup]);
  });
  it('waits for an App-owned child to actually exit before declaring finalization done', async() => {
    const signals = new EventEmitter();
    let child: ChildProcessWithoutNullStreams | undefined;
    const stopped = deferred();
    let exit: [number | null, NodeJS.Signals | null] | undefined;
    try {
      await runCssCliLifecycle(async() => ({
        start: async() => {
          child = spawn(process.execPath, ['-e', "const timer=setInterval(()=>{},1000);process.stdin.resume();process.stdin.on('data',()=>{clearInterval(timer);process.stdin.destroy();});process.stdout.write('ready\\n');"], { stdio: 'pipe' });
          await once(child.stdout, 'data');
        },
        stop: async() => {
          const closed = once(child!, 'close'); child!.stdin.end('stop\n');
          exit = await closed as [number | null, NodeJS.Signals | null]; stopped.resolve();
        },
      }), vi.fn(), signals);
      signals.emit('SIGTERM'); signals.emit('SIGINT'); await stopped.promise; await tick();
      expect(exit).toEqual([0, null]);
      expect(() => process.kill(child!.pid!, 0)).toThrow();
      expect(signals.listenerCount('SIGTERM')).toBe(0);
    } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); } }
  });
});
