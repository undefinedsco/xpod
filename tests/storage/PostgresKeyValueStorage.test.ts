import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
const endMock = vi.fn();

vi.mock('pg', () => {
  class Pool {
    public static lastOptions: unknown;

    public constructor(options: unknown) {
      Pool.lastOptions = options;
    }

    public query(text: string, params?: unknown[]): Promise<unknown> {
      return queryMock(text, params);
    }

    public end(): Promise<void> {
      return endMock();
    }
  }

  return { Pool };
});

import { PostgresKeyValueStorage } from '../../src/storage/keyvalue/PostgresKeyValueStorage';

describe('PostgresKeyValueStorage', () => {
beforeEach(() => {
  queryMock.mockReset();
  endMock.mockReset();
  endMock.mockResolvedValue(undefined);
});

  it('creates the internal_kv table on initialize', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const storage = new PostgresKeyValueStorage({ connectionString: 'postgres://example' });

    await storage.initialize();

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [ sql ] = queryMock.mock.calls[0];
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "internal_kv"');
  });

  it('stores and retrieves namespaced keys', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ensureTable
    const storage = new PostgresKeyValueStorage({
      connectionString: 'postgres://example',
      namespace: '/.internal/',
    });
    await storage.initialize();

    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // set
    await storage.set('token', { value: 1 });
    const [ insertSql, insertParams ] = queryMock.mock.calls.at(-1)!;
    expect(insertSql).toContain('"internal_kv"');
    expect(insertParams?.[0]).toBe('/.internal/token');

    queryMock.mockResolvedValueOnce({ rows: [ { exists: true } ], rowCount: 1 });
    const exists = await storage.has('token');
    const [ hasSql, hasParams ] = queryMock.mock.calls.at(-1)!;
    expect(hasSql).toContain('"internal_kv"');
    expect(hasParams?.[0]).toBe('/.internal/token');
    expect(exists).toBe(true);

    queryMock.mockResolvedValueOnce({
      rows: [ { value: JSON.stringify({ value: 1 }) } ],
      rowCount: 1,
    });
    const value = await storage.get('token');
    expect(value).toEqual({ value: 1 });
  });

  it('iterates entries and trims namespace', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ensureTable
    const storage = new PostgresKeyValueStorage({
      connectionString: 'postgres://example',
      namespace: '/.internal/',
    });
    await storage.initialize();

    queryMock.mockResolvedValueOnce({
      rows: [
        { key: '/.internal/a', value: JSON.stringify({ foo: 'bar' }) },
        { key: '/.internal/b', value: JSON.stringify({ baz: 1 }) },
      ],
      rowCount: 2,
    });

    const entries = [];
    for await (const entry of storage.entries()) {
      entries.push(entry);
    }

    expect(entries).toEqual([
      [ 'a', { foo: 'bar' } ],
      [ 'b', { baz: 1 } ],
    ]);
  });

  it('finalizes the pool', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const storage = new PostgresKeyValueStorage({ connectionString: 'postgres://example' });
    await storage.finalize();
    expect(endMock).toHaveBeenCalled();
  });
});
