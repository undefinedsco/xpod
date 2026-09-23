import { describe, expect, it, vi } from 'vitest';

import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach } from 'vitest';

import { isPortConflict, startTestRuntime, withRuntimeStartLock } from './testRuntime';
import type { XpodRuntimeHandle, XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';

const handle = { id: 'runtime', ports: {} } as unknown as XpodRuntimeHandle;

function portConflict(): Error {
  return Object.assign(new Error('listen EADDRINUSE: address already in use :::5601'), {
    cause: { code: 'EADDRINUSE' },
  });
}

const LOCK_DIR = path.join(process.cwd(), '.test-data', 'runtime-start.lock');

describe('startTestRuntime', () => {
  afterEach(async() => {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  it('probes again when another test file took the port first', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(portConflict())
      .mockResolvedValueOnce(handle);

    await expect(startTestRuntime(start, { transport: 'port' })).resolves.toBe(handle);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives up when the ports were pinned, because the conflict would repeat', async () => {
    const start = vi.fn().mockRejectedValue(portConflict());

    await expect(startTestRuntime(start, { transport: 'port', gatewayPort: 5737 })).rejects.toThrow(/EADDRINUSE/u);
    await expect(startTestRuntime(start, { transport: 'socket' })).rejects.toThrow(/EADDRINUSE/u);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure that is not a port conflict', async () => {
    const start = vi.fn().mockRejectedValue(new Error('configuration is invalid'));

    await expect(startTestRuntime(start, { transport: 'port' })).rejects.toThrow('configuration is invalid');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stops after the last attempt instead of looping forever', async () => {
    const start = vi.fn().mockRejectedValue(portConflict());

    await expect(startTestRuntime(start, { transport: 'port' }, 2)).rejects.toThrow(/EADDRINUSE/u);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('recognises a port conflict reported through the error message or its cause', () => {
    expect(isPortConflict(new Error('listen EADDRINUSE: address already in use :::5601'))).toBe(true);
    expect(isPortConflict(new Error('start failed', { cause: new Error('Address already in use') }))).toBe(true);
    expect(isPortConflict(new Error('address already in use'))).toBe(true);
    // Bun's HTTP server reports the same condition without the errno.
    expect(isPortConflict(new Error('Failed to start server. Is port 45934 in use?'))).toBe(true);
    expect(isPortConflict('EADDRINUSE')).toBe(true);
    expect(isPortConflict(new Error('invalid_client'))).toBe(false);
    expect(isPortConflict(undefined)).toBe(false);
  });
});

describe('withRuntimeStartLock', () => {
  afterEach(async() => {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  it('lets one starter in at a time', async () => {
    const events: string[] = [];
    const first = withRuntimeStartLock(async() => {
      events.push('first:enter');
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push('first:exit');
    });
    const second = withRuntimeStartLock(async() => {
      events.push('second:enter');
    });

    await Promise.all([ first, second ]);

    expect(events).toEqual([ 'first:enter', 'first:exit', 'second:enter' ]);
  });

  it('releases the lock when the starter throws', async () => {
    await expect(withRuntimeStartLock(async() => {
      throw new Error('start failed');
    })).rejects.toThrow('start failed');

    await expect(withRuntimeStartLock(async() => 'ok')).resolves.toBe('ok');
  });
});
