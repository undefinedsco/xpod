import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { createServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  default: {
    createServer: createServerMock,
  },
  createServer: createServerMock,
}));

import { getFreePort } from '../../src/runtime/port-finder';

type ServerBehavior = 'error' | 'listening' | 'hang';
const globalWithBun = globalThis as typeof globalThis & { Bun?: unknown };
const originalBun = globalWithBun.Bun;

function createMockServer(behavior: ServerBehavior, errorCode = 'EADDRINUSE') {
  const handlers: Record<string, Function | undefined> = {};

  return {
    once: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    close: vi.fn((callback?: Function) => {
      callback?.();
    }),
    listen: vi.fn(() => {
      if (behavior === 'error') {
        queueMicrotask(() => handlers.error?.({ code: errorCode }));
        return;
      }
      if (behavior === 'listening') {
        queueMicrotask(() => handlers.listening?.());
      }
    }),
  };
}

describe('getFreePort', () => {
  beforeEach(() => {
    createServerMock.mockReset();
    globalWithBun.Bun = undefined;
  });

  afterAll(() => {
    globalWithBun.Bun = originalBun;
  });

  it('should skip retryable port errors and return the next available port', async() => {
    createServerMock
      .mockReturnValueOnce(createMockServer('error'))
      .mockReturnValueOnce(createMockServer('listening'));

    await expect(getFreePort(5600)).resolves.toBe(5601);
  });

  it('should fail fast when port probing times out', async() => {
    createServerMock.mockReturnValue(createMockServer('hang'));

    await expect(getFreePort(5600, '127.0.0.1', 5)).rejects.toThrow(
      'Timed out probing port 127.0.0.1:5600; local TCP listen may be unavailable in this runtime.',
    );
  });

  it('should fail immediately when Bun cannot listen in the runtime', async() => {
    globalWithBun.Bun = {
      listen: vi.fn(() => {
        const error = new Error('Failed to listen at 127.0.0.1') as Error & { code?: string };
        error.code = 'EPERM';
        throw error;
      }),
    };

    await expect(getFreePort(5600)).rejects.toThrow(
      'Unable to probe port 127.0.0.1:5600; local TCP listen is not permitted in this runtime.',
    );
    expect(createServerMock).not.toHaveBeenCalled();
  });
});
