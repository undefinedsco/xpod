import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { isPortConflict, startTestRuntime, withRuntimeStartLock } from './testRuntime';
import * as runtimeModule from '../../src/runtime/XpodRuntime';
import { XpodTestStack } from './XpodTestStack';
import type { XpodRuntimeHandle, XpodRuntimeOptions } from '../../src/runtime/XpodRuntime';

const handle = { id: 'runtime', ports: {} } as unknown as XpodRuntimeHandle;

/** A lock nobody else uses, so these tests never wait on a runtime another file is starting. */
function privateLockDir(): string {
  return path.join(process.cwd(), '.test-data', `runtime-start-test-${randomUUID()}`);
}

function portConflict(): Error {
  return Object.assign(new Error('listen EADDRINUSE: address already in use :::5601'), {
    cause: { code: 'EADDRINUSE' },
  });
}

describe('startTestRuntime', () => {
  it('probes again when another test file took the port first', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(portConflict())
      .mockResolvedValueOnce(handle);

    await expect(startTestRuntime(start, { transport: 'port' }, { lockDir: privateLockDir() })).resolves.toBe(handle);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('gives up when the ports were pinned, because the conflict would repeat', async () => {
    const start = vi.fn().mockRejectedValue(portConflict());

    await expect(startTestRuntime(start, { transport: 'port', gatewayPort: 5737 }, { lockDir: privateLockDir() }))
      .rejects.toThrow(/EADDRINUSE/u);
    await expect(startTestRuntime(start, { transport: 'socket' }, { lockDir: privateLockDir() }))
      .rejects.toThrow(/EADDRINUSE/u);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure that is not a port conflict', async () => {
    const start = vi.fn().mockRejectedValue(new Error('configuration is invalid'));

    await expect(startTestRuntime(start, { transport: 'port' }, { lockDir: privateLockDir() }))
      .rejects.toThrow('configuration is invalid');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('stops after the last attempt instead of looping forever', async () => {
    const start = vi.fn().mockRejectedValue(portConflict());

    await expect(startTestRuntime(start, { transport: 'port' }, { attempts: 2, lockDir: privateLockDir() }))
      .rejects.toThrow(/EADDRINUSE/u);
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
  it('lets one starter in at a time', async () => {
    const lockDir = privateLockDir();
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];
    const starter = (name: string) => withRuntimeStartLock(async() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`${name}:enter`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push(`${name}:exit`);
      active -= 1;
    }, lockDir);

    try {
      await Promise.all([ starter('first'), starter('second') ]);
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }

    expect(maxActive).toBe(1);
    expect(events).toHaveLength(4);
  });

  it('waits for the holder instead of starting alongside it', async () => {
    const lockDir = privateLockDir();
    const events: string[] = [];
    let releaseHolder = (): void => undefined;
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    try {
      const holder = withRuntimeStartLock(async() => {
        events.push('holder:enter');
        await holderMayFinish;
        events.push('holder:exit');
      }, lockDir);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const waiter = withRuntimeStartLock(async() => {
        events.push('waiter:enter');
      }, lockDir);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The waiter is still blocked, so nothing about it has run yet.
      expect(events).toEqual([ 'holder:enter' ]);

      releaseHolder();
      await Promise.all([ holder, waiter ]);
      expect(events).toEqual([ 'holder:enter', 'holder:exit', 'waiter:enter' ]);
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('releases the lock when the starter throws', async () => {
    const lockDir = privateLockDir();

    try {
      await expect(withRuntimeStartLock(async() => {
        throw new Error('start failed');
      }, lockDir)).rejects.toThrow('start failed');

      await expect(withRuntimeStartLock(async() => 'ok', lockDir)).resolves.toBe('ok');
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});


describe('XpodTestStack retry evidence', () => {
  it('records only the attempted listen fields before replanning a recoverable conflict', async () => {
    const stack = new XpodTestStack();
    const conflict = Object.assign(new Error('listen EADDRINUSE: credential-must-not-be-logged'), {
      code: 'EADDRINUSE', syscall: 'listen', address: '127.0.0.1', port: 38504,
      privateContext: 'credential-must-not-be-logged',
    });
    const plans = vi.spyOn(stack, 'resolvePortOptions').mockImplementation(async () => ({
      gatewayPort: 18501, cssPort: 18502, apiPort: 18503, baseUrl: 'http://localhost:18501/',
    }));
    const previous = process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
    const stop = vi.fn(async () => undefined);
    const start = vi.spyOn(runtimeModule, 'startXpodRuntime').mockRejectedValueOnce(conflict).mockImplementationOnce(async () => {
      process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET = 'disposable-unit-secret';
      return { baseUrl: 'http://localhost:18501/', ports: { gateway: 18501, api: 18503 }, sockets: {},
        fetch: async () => new Response('{}'), stop } as unknown as XpodRuntimeHandle;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await stack.start('cloud', { transport: 'port' });
      expect(start).toHaveBeenCalledTimes(2); expect(plans).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('[XpodTestStack] port-conflict retry', JSON.stringify({
        attempt: 1, maxAttempts: 3, code: 'EADDRINUSE', syscall: 'listen', address: '127.0.0.1', port: 38504,
      }));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('credential-must-not-be-logged');
      await stack.stop(); expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore(); plans.mockRestore(); warn.mockRestore();
      if (previous === undefined) delete process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET;
      else process.env.XPOD_GATEWAY_ADMIN_PROXY_AUTH_SECRET = previous;
    }
  });

  it('does not replan or advertise a retry when startup cleanup is unknown', async () => {
    const stack = new XpodTestStack();
    const failure = new AggregateError([ portConflict(), new Error('close completion unknown') ], 'Gateway startup cleanup did not complete');
    const start = vi.spyOn(runtimeModule, 'startXpodRuntime').mockRejectedValue(failure);
    const plans = vi.spyOn(stack, 'resolvePortOptions').mockResolvedValue({ gatewayPort: 18501, cssPort: 18502, apiPort: 18503 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(stack.start('cloud', { transport: 'port' })).rejects.toBe(failure);
      expect(start).toHaveBeenCalledTimes(1); expect(plans).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally { start.mockRestore(); plans.mockRestore(); warn.mockRestore(); }
  });
});
