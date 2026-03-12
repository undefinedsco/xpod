import { describe, it, expect, beforeEach, vi } from 'vitest';

const commandMocks = {
  defineCommand: vi.fn(),
  ping: vi.fn(),
  exists: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  scan: vi.fn(),
  mget: vi.fn(),
  quit: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: class Redis {
    public static lastArgs: unknown[] | undefined;

    public constructor(...args: unknown[]) {
      Redis.lastArgs = args;
      Object.assign(this, commandMocks);
    }
  },
}));

import { RedisKeyValueStorage } from '../../src/storage/keyvalue/RedisKeyValueStorage';

describe('RedisKeyValueStorage', () => {
  beforeEach(() => {
    Object.values(commandMocks).forEach((mock) => mock.mockReset());
    commandMocks.ping.mockResolvedValue('PONG');
    commandMocks.quit.mockResolvedValue(undefined);
  });

  it('initializes and pings Redis', async () => {
    const storage = new RedisKeyValueStorage({ client: '6379' });
    await storage.initialize();
    expect(commandMocks.ping).toHaveBeenCalled();
    await storage.finalize();
    expect(commandMocks.quit).toHaveBeenCalled();
    expect(commandMocks.disconnect).toHaveBeenCalledWith(false);
  });

  it('registers a Redis error listener on construction', () => {
    new RedisKeyValueStorage({ client: '6379' });
    expect(commandMocks.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('sets values with TTL when expires is provided', async () => {
    const storage = new RedisKeyValueStorage({ client: '6379' });
    await storage.initialize();

    commandMocks.set.mockResolvedValue('OK');
    const expires = new Date(Date.now() + 5000).toISOString();
    await storage.set('token', { expires, payload: 1 });

    expect(commandMocks.set).toHaveBeenCalledWith(
      'css:kv:token',
      JSON.stringify({ expires, payload: 1 }),
      'PX',
      expect.any(Number),
    );
  });

  it('sets values without TTL when expires is missing', async () => {
    const storage = new RedisKeyValueStorage({ client: '6379', namespace: '/.internal/' });
    await storage.initialize();

    commandMocks.set.mockResolvedValue('OK');
    await storage.set('token', { payload: 1 });

    expect(commandMocks.set).toHaveBeenCalledWith(
      '/.internal/token',
      JSON.stringify({ payload: 1 }),
    );
  });

  it('iterates entries with namespace trimming', async () => {
    const storage = new RedisKeyValueStorage({ client: '6379', namespace: '/.internal/' });
    await storage.initialize();

    commandMocks.scan
      .mockResolvedValueOnce([ '1', [ '/.internal/a', '/.internal/b' ] ])
      .mockResolvedValueOnce([ '0', [] ]);
    commandMocks.mget.mockResolvedValue([
      JSON.stringify({ foo: 'bar' }),
      JSON.stringify({ baz: 1 }),
    ]);

    const entries = [];
    for await (const entry of storage.entries()) {
      entries.push(entry);
    }

    expect(entries).toEqual([
      [ 'a', { foo: 'bar' } ],
      [ 'b', { baz: 1 } ],
    ]);
  });
});
