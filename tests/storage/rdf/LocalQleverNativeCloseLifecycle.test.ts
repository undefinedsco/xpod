import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawning = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawning.spawn }));
import { LocalQleverNativeSparqlClient } from '../../../src/storage/rdf/LocalQleverNativeSparqlClient';

/** Controlled process events test the parent lifecycle, not native RDF capability. */
function createStartedClient() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => true),
  });
  spawning.spawn.mockReturnValue(child);
  const client = new LocalQleverNativeSparqlClient({ command: 'controlled-child',
    expectedNativeSparqlAbiVersion: 1, expectedPhysicalBackendAbiVersion: 7 });
  const started = client.start();
  child.stdout.write(`${JSON.stringify({ type: 'ready', abiVersion: 1,
    physicalBackendAbiVersion: 7, backend: 'sqlite' })}\n`);
  return { client, child, started };
}

afterEach(() => { vi.useRealTimers(); spawning.spawn.mockReset(); });

describe('LocalQleverNativeSparqlClient original close lifecycle', () => {
  it('joins concurrent closes until the original child close and sends one shutdown', async () => {
    const { client, child, started } = createStartedClient();
    await started;
    let commands = '';
    child.stdin.on('data', (data) => { commands += String(data); });
    const first = client.close();
    const second = client.close();
    expect(second).toBe(first);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(commands.match(/shutdown/g)).toHaveLength(1);
    await expect(client.start()).rejects.toMatchObject({ code: 'qlever_runtime_closed' });
    child.exitCode = 0;
    child.emit('close', 0, null);
    await Promise.all([ first, second ]);
    expect(spawning.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not treat exitCode as stdio close, even when close is requested after exit', async () => {
    const { client, child, started } = createStartedClient();
    await started;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    const closing = client.close();
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    child.exitCode = 0;
    child.emit('close', 0, null);
    await closing;
  });

  it('shares forced-shutdown failure and permits only an observed-close recovery without respawning', async () => {
    vi.useFakeTimers();
    const { client, child, started } = createStartedClient();
    await started;
    const first = client.close();
    const second = client.close();
    const failures = Promise.all([
      expect(first).rejects.toMatchObject({ code: 'qlever_runtime_close_timeout' }),
      expect(second).rejects.toMatchObject({ code: 'qlever_runtime_close_timeout' }),
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    await failures;
    expect(child.kill.mock.calls).toEqual([ [ 'SIGTERM' ], [ 'SIGKILL' ] ]);
    expect(child.stdin.destroyed).toBe(false);
    expect(child.stdout.destroyed).toBe(false);
    expect(child.stderr.destroyed).toBe(false);
    // I preserves its explicit cleanup retry contract; the original flight remains rejected.
    await expect(first).rejects.toMatchObject({ code: 'qlever_runtime_close_timeout' });
    expect(spawning.spawn).toHaveBeenCalledTimes(1);
    // Only a real close event permits I's existing recovery to complete.
    child.exitCode = 0;
    child.emit('close', 0, null);
    await expect(first).rejects.toMatchObject({ code: 'qlever_runtime_close_timeout' });
    await client.close();
  });

  it('recognizes a previously observed child close without waiting for a second event', async () => {
    const { client, child, started } = createStartedClient();
    await started;
    child.exitCode = 0;
    child.exitCode = 0;
    child.emit('close', 0, null);
    await client.close();
    await client.close();
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawning.spawn).toHaveBeenCalledTimes(1);
  });
});
